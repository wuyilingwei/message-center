import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createAdapter } from './adapters/index.js';
import { SingleFlightTask } from './async-coordination.js';
import { loadConfig } from './config.js';
import {
  ConnectorLayoutControlSync,
  connectorLayoutControlStatePath,
  parseLayoutControlDesired,
  type LayoutControlAcknowledgement,
  type LayoutControlCloudResult,
} from './layout-control-sync.js';
import { PresenceService } from './presence.js';
import { selectFairSpoolWindows } from './spool-fairness.js';
import type { IncomingBridgeMessage } from './types.js';
import {
  assignLayoutControlOwner,
  parseConnectorInstances,
  parseConnectorTokens,
  uniqueConnectorInstances,
  type RelayConnectorInstance,
} from './unified-connectors.js';

interface UnifiedCommand {
  id: string;
  conversationId: string;
  messageId: string;
  kind: 'send_text' | 'send_message_with_files';
  payload: {
    externalConversationId?: string;
    body?: string;
    attachments?: Array<{
      id?: string;
      fileName?: string;
      sizeBytes?: number;
      sha256?: string;
      downloadPath?: string;
    }>;
  };
  idempotencyKey: string;
  leaseToken: string;
}

const BACKGROUND_FLUSH_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;
const PROFILE_SYNC_MS = 30 * 60_000;
const MAX_RELAY_JSON_BYTES = 1_500_000;

class RelayHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`relay_http_${status}:${code}`);
  }
}

function requiredEnv(name: string, minimumLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) throw new Error(`${name}_required`);
  return value;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

function connectorMap(): Record<string, RelayConnectorInstance> {
  return parseConnectorInstances(
    process.env.BRIDGE_MESSAGE_CONNECTORS,
    process.env.BRIDGE_MESSAGE_CONNECTOR_MAP,
  );
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; }
  catch (error) {
    if (response.ok) throw error;
  }
  if (!response.ok || body.ok === false) {
    throw new RelayHttpError(response.status, String(body.error ?? 'request_failed'));
  }
  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relayErrorCode(error: unknown): string {
  if (error instanceof RelayHttpError) return error.code;
  const match = errorMessage(error).match(/^relay_http_\d+:([^\s]+)/);
  return match?.[1] ?? errorMessage(error);
}

function jsonPayloadBatches<T>(
  connectorId: string,
  items: T[],
  normalized: (item: T) => unknown,
  maximumItems = 100,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const bytes = Buffer.byteLength(JSON.stringify({
      connectorId,
      messages: candidate.map(normalized),
    }), 'utf8');
    if (current.length && (candidate.length > maximumItems || bytes > MAX_RELAY_JSON_BYTES)) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.adapter !== 'device') throw new Error('unified_relay_requires_device_adapter');
  const serviceUrl = requiredEnv('BRIDGE_MESSAGE_URL').replace(/\/$/, '');
  const profiles = connectorMap();
  const layoutControlConfig = config.device.layoutControl;
  const layoutControlOwnerId = layoutControlConfig.enabled
    ? layoutControlConfig.ownerConnectorId
    : undefined;
  if (layoutControlConfig.enabled && !layoutControlOwnerId) {
    throw new Error('layout_control_owner_required');
  }
  const connectors = assignLayoutControlOwner(uniqueConnectorInstances(profiles), layoutControlOwnerId);
  const connectorTokens = parseConnectorTokens(
    process.env.BRIDGE_MESSAGE_CONNECTOR_TOKENS,
    process.env.BRIDGE_MESSAGE_CONNECTOR_TOKEN,
    connectors.map((connector) => connector.id),
  );
  const configuredProfileIds = config.device.profiles.map((profile) => profile.id).sort();
  const mappedProfileIds = Object.keys(profiles).sort();
  if (JSON.stringify(configuredProfileIds) !== JSON.stringify(mappedProfileIds)) {
    throw new Error('profile_connector_mapping_mismatch');
  }
  for (const profile of config.device.profiles) {
    const connector = profiles[profile.id]!;
    const allowed = new Set(profile.driver === 'element'
      ? ['receive_text', 'send_text', 'send_files']
      : ['receive_text', 'send_text']);
    if (connector.id === layoutControlOwnerId) allowed.add('layout_control');
    if (connector.capabilities.some((capability) => !allowed.has(capability))) {
      throw new Error(`connector_capability_not_supported:${profile.id}`);
    }
  }
  const adapter = createAdapter(config);
  const presence = new PresenceService(config);
  const spoolRoot = join(config.runtimeDir, 'unified-relay');
  const pendingDir = join(spoolRoot, 'pending');
  const backgroundDir = join(spoolRoot, 'background');
  const legacySentDir = join(spoolRoot, 'sent');
  const quarantineDir = join(spoolRoot, 'quarantine');
  const downloadRoot = join(spoolRoot, 'downloads');
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(backgroundDir, { recursive: true });
  mkdirSync(quarantineDir, { recursive: true });
  mkdirSync(downloadRoot, { recursive: true });
  if (existsSync(legacySentDir)) {
    for (const entry of readdirSync(legacySentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try { unlinkSync(join(legacySentDir, entry.name)); } catch { /* Best-effort cleanup of legacy success copies. */ }
    }
    try { rmdirSync(legacySentDir); } catch { /* Preserve unexpected or concurrently written entries. */ }
  }
  const connectorIds = new Set(connectors.map((connector) => connector.id));
  const pendingCursors = new Map<string, string>();
  const backgroundCursors = new Map<string, string>();
  const connectorPendingCursors = new Map<string, string>();
  const connectorBackgroundCursors = new Map<string, string>();
  const connectorDirectoryName = (connectorId: string): string =>
    `${safePart(connectorId).slice(0, 60)}-${createHash('sha256').update(connectorId).digest('hex').slice(0, 16)}`;
  const pendingConnectorDirs = new Map(connectors.map((connector) => [
    connector.id, join(pendingDir, connectorDirectoryName(connector.id)),
  ]));
  const backgroundConnectorDirs = new Map(connectors.map((connector) => [
    connector.id, join(backgroundDir, connectorDirectoryName(connector.id)),
  ]));
  for (const directory of [...pendingConnectorDirs.values(), ...backgroundConnectorDirs.values()]) {
    mkdirSync(directory, { recursive: true });
  }
  const connectorHeaders = (connectorId: string): { authorization: string; 'x-connector-id': string } => {
    const token = connectorTokens[connectorId];
    if (!token) throw new Error(`connector_token_missing:${connectorId}`);
    return { authorization: `Bearer ${token}`, 'x-connector-id': connectorId };
  };

  const readLayoutControl = async (connectorId: string) => {
    const response = await fetch(
      `${serviceUrl}/api/connectors/layout-control?connectorId=${encodeURIComponent(connectorId)}`,
      { headers: connectorHeaders(connectorId), signal: AbortSignal.timeout(15_000) },
    );
    const body = await jsonResponse(response);
    return parseLayoutControlDesired(body.layoutControl);
  };

  const acknowledgeLayoutControl = async (
    connectorId: string,
    value: LayoutControlAcknowledgement,
  ): Promise<LayoutControlCloudResult> => {
    const response = await fetch(`${serviceUrl}/api/connectors/layout-control/ack`, {
      method: 'POST',
      headers: { ...connectorHeaders(connectorId), 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId, ...value }),
      signal: AbortSignal.timeout(15_000),
    });
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new RelayHttpError(response.status, 'invalid_layout_control_response');
    }
    if (!body.layoutControl) {
      throw new RelayHttpError(response.status, String(body.error ?? 'layout_control_request_failed'));
    }
    if (!response.ok && response.status !== 409) {
      throw new RelayHttpError(response.status, String(body.error ?? 'layout_control_request_failed'));
    }
    return {
      ok: response.ok && body.ok !== false,
      retry: body.retry === true,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
      layoutControl: parseLayoutControlDesired(body.layoutControl),
    };
  };

  // Layout control is an optional safety subsystem. A corrupt or future-version
  // state file must fail that subsystem closed without taking message relay down.
  let layoutControlSync: ConnectorLayoutControlSync | undefined;
  if (layoutControlOwnerId) {
    try {
      layoutControlSync = new ConnectorLayoutControlSync({
        connectorId: layoutControlOwnerId,
        statePath: connectorLayoutControlStatePath(config.runtimeDir, layoutControlOwnerId),
        cloud: {
          read: () => readLayoutControl(layoutControlOwnerId),
          acknowledge: (value) => acknowledgeLayoutControl(layoutControlOwnerId, value),
        },
        device: {
          run: async (action, command) => {
            if (!adapter.controlDeviceLayout) throw new Error('device_layout_control_unavailable');
            return adapter.controlDeviceLayout(action, command);
          },
        },
        administratorOverrideLocalLock: layoutControlConfig.administratorOverrideLocalLock,
      });
    } catch (error) {
      process.stderr.write(`layout control disabled: ${errorMessage(error)}\n`);
    }
  }

  const quarantineSpoolFile = (directory: string, name: string, reason: string): void => {
    try {
      renameSync(
        join(directory, name),
        join(quarantineDir, `${Date.now()}-${randomUUID()}-${safePart(reason)}-${safePart(name)}`),
      );
      process.stderr.write(`relay spool item quarantined: ${safePart(reason)}\n`);
    } catch (error) {
      process.stderr.write(`relay spool quarantine failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  const permanentCodes = new Set([
    'attachment_staging_file_missing', 'attachment_size_not_allowed', 'attachment_digest_mismatch',
    'file_external_id_conflict', 'message_external_id_conflict',
    'receive_files_not_supported', 'receive_text_not_supported',
    'invalid_file_metadata', 'invalid_normalized_message', 'invalid_message_trigger',
    'invalid_message_context', 'invalid_message_observed_at', 'invalid_event_batch',
    'invalid_backup_batch', 'invalid_group_text_backup',
  ]);
  const permanentSpoolError = (error: unknown): boolean => permanentCodes.has(relayErrorCode(error));
  const requestTooLarge = (error: unknown): boolean =>
    relayErrorCode(error) === 'request_too_large' || (error instanceof RelayHttpError && error.status === 413);
  const splitBatchError = (error: unknown): boolean =>
    permanentSpoolError(error) || requestTooLarge(error);

  const post = async (
    connectorId: string,
    path: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(`${serviceUrl}${path}`, {
      method: 'POST',
      headers: { ...connectorHeaders(connectorId), 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    return jsonResponse(response);
  };

  const queueMessage = async (message: IncomingBridgeMessage): Promise<void> => {
    const profileId = message.id.split(':', 1)[0] || '';
    const connectorId = profiles[profileId]?.id;
    if (!connectorId) throw new Error(`connector_mapping_missing:${profileId}`);
    const targetDir = message.backupOnly
      ? backgroundConnectorDirs.get(connectorId)
      : pendingConnectorDirs.get(connectorId);
    if (!targetDir) throw new Error(`connector_spool_missing:${connectorId}`);
    const envelope = `${JSON.stringify({ connectorId, message })}\n`;
    // A semantic replay can keep the same external message id while carrying a
    // newer parser interpretation. Content-addressed names retain both versions
    // and prevent a flush from moving away an envelope written during its POST.
    const envelopeDigest = createHash('sha256').update(envelope).digest('hex').slice(0, 24);
    const fileName = `${safePart(connectorId).slice(0, 60)}-${safePart(message.id).slice(0, 120)}-${envelopeDigest}.json`;
    const target = join(targetDir, fileName);
    const temporary = join(targetDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, envelope, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, target);
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Best-effort temporary cleanup. */ }
      if (!existsSync(target)) throw error;
    }
  };

  const heartbeat = async (): Promise<void> => {
    const status = await presence.snapshot();
    const connectorHealth = adapter.connectorHealth?.() ?? {};
    await Promise.all(connectors.map((connector) => {
      const healthEntries = Object.entries(profiles)
        .filter(([, mapped]) => mapped.id === connector.id)
        .map(([profileId]) => [profileId, connectorHealth[profileId] ?? null] as const);
      const states = healthEntries.map(([, health]) => health?.state).filter(Boolean);
      return post(connector.id, '/api/connectors/heartbeat', {
        connectorId: connector.id,
        state: states.length > 0 && states.some((state) => state === 'online') ? 'online' : 'offline',
        status: { ...status, connectorHealth: Object.fromEntries(healthEntries) }
      }, AbortSignal.timeout(HEARTBEAT_MS - 1_000));
    }));
  };

  const registerConnectors = async (): Promise<void> => {
    for (const connector of connectors) await post(connector.id, '/api/connectors/register', connector);
  };

  const syncConversationProfiles = async (): Promise<void> => {
    if (!adapter.listConversationProfiles) return;
    const conversationProfiles = await adapter.listConversationProfiles();
    for (const profile of conversationProfiles) {
      const connector = profiles[profile.profileId];
      if (!connector) continue;
      try {
        const avatar = profile.avatar;
        const bytes = avatar ? readFileSync(avatar.stagedPath) : undefined;
        if (avatar && (avatar.sizeBytes > 2 * 1024 * 1024 || bytes?.byteLength !== avatar.sizeBytes ||
            createHash('sha256').update(bytes).digest('hex') !== avatar.sha256)) {
          throw new Error('conversation_avatar_validation_failed');
        }
        const response = await fetch(
          `${serviceUrl}/api/connectors/conversation-profiles/${encodeURIComponent(profile.conversationId)}`,
          {
            method: 'PUT',
            headers: {
              ...connectorHeaders(connector.id),
              'x-conversation-display-name': encodeURIComponent(profile.displayName),
              ...(profile.channelLabel
                ? { 'x-conversation-channel-label': encodeURIComponent(profile.channelLabel) }
                : {}),
              ...(profile.conversationType ? { 'x-conversation-type': profile.conversationType } : {}),
              ...(profile.placement && profile.placement !== 'unknown'
                ? { 'x-conversation-placement': profile.placement }
                : {}),
              ...(profile.pinned !== undefined ? { 'x-conversation-pinned': profile.pinned ? '1' : '0' } : {}),
              ...(profile.unreadCount !== undefined
                ? { 'x-conversation-unread-count': String(profile.unreadCount) }
                : {}),
              ...(profile.unreadObservedAt
                ? { 'x-conversation-unread-observed-at': profile.unreadObservedAt }
                : {}),
              ...(profile.lastMessagePreview
                ? { 'x-conversation-last-preview': encodeURIComponent(profile.lastMessagePreview) }
                : {}),
              ...(profile.lastMessageAt ? { 'x-conversation-last-at': profile.lastMessageAt } : {}),
              ...(avatar ? {
                'content-type': avatar.mimeType,
                'content-length': String(avatar.sizeBytes),
                'x-content-sha256': avatar.sha256,
              } : {}),
            },
            ...(bytes ? { body: bytes } : {}),
            signal: AbortSignal.timeout(30_000),
          },
        );
        await jsonResponse(response);
      } catch (error) {
        process.stderr.write(`conversation profile sync failed for ${profile.profileId}:${profile.conversationId}: ${
          error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  };

  const uploadInboundAttachment = async (
    connectorId: string,
    message: IncomingBridgeMessage,
    attachment: IncomingBridgeMessage['attachments'][number],
  ): Promise<{ externalId: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string }> => {
    if (!existsSync(attachment.stagedPath)) throw new Error('attachment_staging_file_missing');
    const sizeBytes = statSync(attachment.stagedPath).size;
    if (sizeBytes < 1 || sizeBytes > config.maxAttachmentBytes) throw new Error('attachment_size_not_allowed');
    const bytes = readFileSync(attachment.stagedPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (attachment.sha256 && attachment.sha256 !== sha256) throw new Error('attachment_digest_mismatch');
    const response = await fetch(`${serviceUrl}/api/connectors/files/${encodeURIComponent(attachment.id)}`, {
      method: 'PUT',
      headers: {
        ...connectorHeaders(connectorId),
        'content-type': attachment.mimeType || 'application/octet-stream',
        'content-length': String(sizeBytes),
        'x-conversation-id': message.conversation.id,
        'x-file-external-id': attachment.id,
        'x-file-name': encodeURIComponent(attachment.fileName),
      'x-content-sha256': sha256,
      },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    await jsonResponse(response);
    return {
      externalId: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes,
      sha256,
    };
  };

  const deliverEventGroup = async (
    connectorId: string,
    directory: string,
    values: Array<{ name: string; message: IncomingBridgeMessage }>,
  ): Promise<void> => {
    const prepared: Array<{
      value: { name: string; message: IncomingBridgeMessage };
      normalized: Record<string, unknown>;
    }> = [];
    for (const value of values) {
      try {
        const attachments = [];
        for (const attachment of value.message.attachments) {
          attachments.push(await uploadInboundAttachment(connectorId, value.message, attachment));
        }
        prepared.push({ value, normalized: {
          externalId: value.message.id,
          conversationExternalId: value.message.conversation.id,
          conversationTitle: value.message.conversation.displayName,
          avatarLabel: value.message.conversation.displayName.slice(0, 2),
          senderId: value.message.sender.id,
          senderName: value.message.sender.displayName,
          body: value.message.text,
          contentType: attachments.length ? 'mixed' : 'text',
          occurredAt: value.message.receivedAt,
          ...(value.message.observedAt ? { observedAt: value.message.observedAt } : {}),
          conversationType: value.message.conversationType ?? 'direct',
          trigger: value.message.trigger ?? 'direct',
          mentioned: value.message.mentioned === true,
          placement: value.message.placement ?? 'unknown',
          context: (value.message.context ?? []).slice(-20),
          attachments,
        } });
      } catch (error) {
        const message = errorMessage(error);
        if (permanentSpoolError(error)) {
          quarantineSpoolFile(directory, value.name, 'invalid-attachment');
        } else {
          process.stderr.write(`inbound attachment deferred: ${message}\n`);
        }
      }
    }
    if (!prepared.length) return;
    const deliver = async (batch: typeof prepared): Promise<void> => {
      try {
        await post(connectorId, '/api/connectors/events', {
          connectorId,
          messages: batch.map((item) => item.normalized),
        });
        for (const { value } of batch) {
          // The successful Worker response is already idempotently durable. Remove
          // the plaintext spool instead of building an unbounded second archive.
          unlinkSync(join(directory, value.name));
        }
      } catch (error) {
        if (!splitBatchError(error)) {
          process.stderr.write(`inbound event batch deferred: ${errorMessage(error)}\n`);
          return;
        }
        if (batch.length > 1) {
          const middle = Math.ceil(batch.length / 2);
          await deliver(batch.slice(0, middle));
          await deliver(batch.slice(middle));
          return;
        }
        const item = batch[0]!;
        if (permanentSpoolError(error) || requestTooLarge(error)) {
          quarantineSpoolFile(directory, item.value.name,
            requestTooLarge(error) ? 'oversized-event' : 'invalid-event');
        } else {
          process.stderr.write(`inbound event deferred: ${errorMessage(error)}\n`);
        }
      }
    };
    for (const batch of jsonPayloadBatches(connectorId, prepared, (item) => item.normalized)) {
      await deliver(batch);
    }
  };

  const flushEvents = async (): Promise<void> => {
    const names = readdirSync(pendingDir).filter((name) => name.endsWith('.json')).sort();
    const parsedItems: Array<{ connectorId: string; name: string; message: IncomingBridgeMessage }> = [];
    for (const name of names) {
      let parsed: { connectorId: string; message: IncomingBridgeMessage };
      try {
        parsed = JSON.parse(readFileSync(join(pendingDir, name), 'utf8')) as typeof parsed;
        if (!connectorIds.has(parsed.connectorId) || !parsed.message?.id || !parsed.message?.conversation?.id ||
            !parsed.message.conversation.displayName || !parsed.message.sender?.displayName ||
            !Number.isFinite(Date.parse(parsed.message.receivedAt)) || !Array.isArray(parsed.message.attachments)) {
          throw new Error('invalid_pending_envelope');
        }
      } catch {
        quarantineSpoolFile(pendingDir, name, 'invalid-pending-envelope');
        continue;
      }
      parsedItems.push({ connectorId: parsed.connectorId, name, message: parsed.message });
    }
    const grouped = selectFairSpoolWindows(parsedItems, pendingCursors, 100);
    await Promise.all([...grouped].map(([connectorId, values]) =>
      deliverEventGroup(connectorId, pendingDir, values)));
  };

  const flushConnectorEvents = async (connectorId: string, directory: string): Promise<void> => {
    const candidates = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ connectorId, name: entry.name }));
    const selected = selectFairSpoolWindows(candidates, connectorPendingCursors, 20).get(connectorId) ?? [];
    const values: Array<{ name: string; message: IncomingBridgeMessage }> = [];
    for (const { name } of selected) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          connectorId: string; message: IncomingBridgeMessage;
        };
        if (parsed.connectorId !== connectorId || !parsed.message?.id || !parsed.message?.conversation?.id ||
            !parsed.message.conversation.displayName || !parsed.message.sender?.displayName ||
            !Number.isFinite(Date.parse(parsed.message.receivedAt)) || !Array.isArray(parsed.message.attachments)) {
          throw new Error('invalid_pending_envelope');
        }
        values.push({ name, message: parsed.message });
      } catch {
        quarantineSpoolFile(directory, name, 'invalid-pending-envelope');
      }
    }
    if (values.length) await deliverEventGroup(connectorId, directory, values);
  };

  const deliverBackgroundGroup = async (
    connectorId: string,
    directory: string,
    values: Array<{ name: string; message: IncomingBridgeMessage }>,
  ): Promise<void> => {
    const prepared = values.map((value) => ({
      value,
      normalized: {
        externalId: value.message.id,
        conversationExternalId: value.message.conversation.id,
        conversationTitle: value.message.conversation.displayName,
        senderId: value.message.sender.id,
        senderName: value.message.sender.displayName,
        body: value.message.text,
        occurredAt: value.message.receivedAt,
        conversationType: 'group',
        placement: value.message.placement ?? 'unknown',
      },
    }));
    const deliver = async (batch: typeof prepared): Promise<void> => {
      try {
        await post(connectorId, '/api/connectors/group-text-backups', {
          connectorId,
          messages: batch.map((item) => item.normalized),
        });
        for (const { value } of batch) {
          unlinkSync(join(directory, value.name));
        }
      } catch (error) {
        if (!splitBatchError(error)) {
          process.stderr.write(`background event batch deferred: ${errorMessage(error)}\n`);
          return;
        }
        if (batch.length > 1) {
          const middle = Math.ceil(batch.length / 2);
          await deliver(batch.slice(0, middle));
          await deliver(batch.slice(middle));
          return;
        }
        const item = batch[0]!;
        if (permanentSpoolError(error) || requestTooLarge(error)) {
          quarantineSpoolFile(directory, item.value.name,
            requestTooLarge(error) ? 'oversized-background-event' : 'invalid-background-event');
        } else {
          process.stderr.write(`background event deferred: ${errorMessage(error)}\n`);
        }
      }
    };
    for (const batch of jsonPayloadBatches(connectorId, prepared, (item) => item.normalized)) {
      await deliver(batch);
    }
  };

  const flushBackgroundEvents = async (): Promise<void> => {
    const names = readdirSync(backgroundDir).filter((name) => name.endsWith('.json')).sort();
    const parsedItems: Array<{ connectorId: string; name: string; message: IncomingBridgeMessage }> = [];
    for (const name of names) {
      let parsed: { connectorId: string; message: IncomingBridgeMessage };
      try {
        parsed = JSON.parse(readFileSync(join(backgroundDir, name), 'utf8')) as typeof parsed;
        if (!connectorIds.has(parsed.connectorId) || !parsed.message?.id || !parsed.message?.conversation?.id ||
            !parsed.message.conversation.displayName || !parsed.message.sender?.displayName ||
            !Number.isFinite(Date.parse(parsed.message.receivedAt))) throw new Error('invalid_background_envelope');
      } catch {
        quarantineSpoolFile(backgroundDir, name, 'invalid-background-envelope');
        continue;
      }
      parsedItems.push({ connectorId: parsed.connectorId, name, message: parsed.message });
    }
    const grouped = selectFairSpoolWindows(parsedItems, backgroundCursors, 1000);
    await Promise.all([...grouped].map(([connectorId, values]) =>
      deliverBackgroundGroup(connectorId, backgroundDir, values)));
  };

  const flushConnectorBackgroundEvents = async (connectorId: string, directory: string): Promise<void> => {
    const candidates = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ connectorId, name: entry.name }));
    const selected = selectFairSpoolWindows(candidates, connectorBackgroundCursors, 1000).get(connectorId) ?? [];
    const values: Array<{ name: string; message: IncomingBridgeMessage }> = [];
    for (const { name } of selected) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          connectorId: string; message: IncomingBridgeMessage;
        };
        if (parsed.connectorId !== connectorId || !parsed.message?.id || !parsed.message?.conversation?.id ||
            !parsed.message.conversation.displayName || !parsed.message.sender?.displayName ||
            !Number.isFinite(Date.parse(parsed.message.receivedAt))) {
          throw new Error('invalid_background_envelope');
        }
        values.push({ name, message: parsed.message });
      } catch {
        quarantineSpoolFile(directory, name, 'invalid-background-envelope');
      }
    }
    if (values.length) await deliverBackgroundGroup(connectorId, directory, values);
  };

  const complete = async (connectorId: string, command: UnifiedCommand, value: Record<string, unknown>): Promise<void> => {
    await post(connectorId, `/api/connectors/commands/${encodeURIComponent(command.id)}/complete`, {
      connectorId,
      leaseToken: command.leaseToken,
      ...value,
    });
  };

  const renewLease = async (connectorId: string, command: UnifiedCommand): Promise<void> => {
    await post(connectorId, `/api/connectors/commands/${encodeURIComponent(command.id)}/lease`, {
      connectorId,
      leaseToken: command.leaseToken,
    }, AbortSignal.timeout(15_000));
  };

  const downloadAttachment = async (connectorId: string, command: UnifiedCommand, attachment: NonNullable<UnifiedCommand['payload']['attachments']>[number]) => {
    const downloadPath = String(attachment.downloadPath || '');
    const requestedFileName = String(attachment.fileName || 'attachment').replace(/[\u0000-\u001f]/g, '');
    const fileName = basename(requestedFileName);
    const expectedSize = Number(attachment.sizeBytes || 0);
    const expectedSha256 = String(attachment.sha256 || '');
    if (!downloadPath.startsWith('/api/files/') || !fileName || fileName !== requestedFileName ||
        fileName.length > 120 || expectedSize < 1 || expectedSize > 10 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error('invalid_attachment_command');
    }
    const response = await fetch(`${serviceUrl}${downloadPath}`, {
      headers: connectorHeaders(connectorId),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`attachment_download_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expectedSize) throw new Error('attachment_size_mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('attachment_digest_mismatch');
    const directory = join(downloadRoot, safePart(connectorId), safePart(command.id));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, fileName);
    writeFileSync(path, bytes, { flag: 'wx' });
    return path;
  };

  const cleanupCommandDownloads = (connectorId: string, commandId: string): void => {
    const directory = join(downloadRoot, safePart(connectorId), safePart(commandId));
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) {
        try { unlinkSync(join(directory, entry.name)); } catch { /* Cleanup must not change command completion. */ }
      }
    }
    try { rmdirSync(directory); } catch { /* The directory may be non-empty or concurrently reused. */ }
    try { rmdirSync(join(downloadRoot, safePart(connectorId))); } catch { /* Keep non-empty connector roots. */ }
  };

  const transientCommandError = (message: string): boolean =>
    /(?:device_(?:operation_not_dispatched|conversation_not_found)|fetch failed|network|timed?\s*out|timeout|ECONN|EAI_AGAIN|attachment_download_(?:408|425|429|5\d\d))/i.test(message);
  const permanentCommandError = (message: string): boolean =>
    /(?:driver-file-send-not-supported|device_(?:file_send_not_supported_for_(?:profile|conversation)|mixed_send_not_supported|attachment_count_not_supported)|adapter_file_send_not_supported|connector_(?:text|file)_send_not_supported|group-code-unavailable|invalid-text-length|invalid-file-(?:name|payload|path|size|metadata)|media-size-out-of-range|invalid_attachment_command|attachment_(?:size|digest)_mismatch)/i.test(message);

  const processCommand = async (profileId: string, connectorId: string, command: UnifiedCommand): Promise<void> => {
    let renewalTimer: NodeJS.Timeout | undefined;
    let renewalInFlight = Promise.resolve();
    const stopRenewal = async (): Promise<void> => {
      if (renewalTimer) clearInterval(renewalTimer);
      renewalTimer = undefined;
      await renewalInFlight;
    };
    let completion: Record<string, unknown>;
    try {
      if (config.presence.requireAwayForLiveReply) {
        const status = await presence.snapshot();
        if (['active', 'quiescent', 'unknown'].includes(status.state)) {
          await complete(connectorId, command, { retry: true, error: `presence_${status.state}` });
          return;
        }
      }
      renewalTimer = setInterval(() => {
        renewalInFlight = renewalInFlight.then(() => renewLease(connectorId, command)).catch((error: unknown) => {
          process.stderr.write(`command lease renewal failed for ${command.id}: ${
            error instanceof Error ? error.message : String(error)}\n`);
        });
      }, 2 * 60_000);
      cleanupCommandDownloads(connectorId, command.id);
      const externalConversationId = String(command.payload.externalConversationId || '');
      if (!/^conversation-[0-9a-f]{8}$/.test(externalConversationId)) throw new Error('invalid_external_conversation');
      const message: IncomingBridgeMessage = {
        id: `${profileId}:outbound:${command.messageId}`,
        conversation: { id: externalConversationId, displayName: externalConversationId, assurance: 'verified' },
        sender: { id: 'member-outbound', displayName: 'Message', assurance: 'verified' },
        receivedAt: new Date().toISOString(),
        text: '',
        attachments: [],
        replyHandle: JSON.stringify({ profileId, conversationId: externalConversationId }),
      };
      const receipts: string[] = [];
      const body = String(command.payload.body || '').trim();
      const attachments = command.payload.attachments ?? [];
      const sendConversationFile = adapter.sendConversationFile?.bind(adapter);
      // Validate every operation before dispatching text so an unsupported file
      // cannot turn a mixed command into a hidden partial send.
      if (attachments.length) {
        if (!sendConversationFile) throw new Error('adapter_file_send_not_supported');
        if (body) throw new Error('device_mixed_send_not_supported');
        if (attachments.length > 1) throw new Error('device_attachment_count_not_supported');
        for (const attachment of attachments) {
          const fileName = String(attachment.fileName || '');
          if (!fileName || fileName.length > 120 || /[\\/:*?"<>|\u0000-\u001f]/.test(fileName) ||
              Number(attachment.sizeBytes || 0) < 1 || Number(attachment.sizeBytes || 0) > 10 * 1024 * 1024) {
            throw new Error('invalid_attachment_command');
          }
        }
        await adapter.assertCanSendConversationFile?.(externalConversationId, profileId);
      }
      if (body) receipts.push(await adapter.sendReply(message, body, `${command.idempotencyKey}:text`));
      for (const attachment of attachments) {
        const path = await downloadAttachment(connectorId, command, attachment);
        try {
          const sent = await sendConversationFile!(
            externalConversationId,
            path,
            `${command.idempotencyKey}:file:${attachment.id || basename(path)}`,
            profileId,
          );
          receipts.push(sent.adapterReceipt);
        } finally {
          unlinkSync(path);
        }
      }
      completion = { ok: true, result: { receipts } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      completion = /device_(?:send_outcome_uncertain|idempotency_ledger_corrupt)/.test(message)
        ? { uncertain: true, error: message }
        : permanentCommandError(message)
          ? { ok: false, error: message }
        : transientCommandError(message)
          ? { retry: true, error: message }
        : { ok: false, error: message };
    } finally {
      await stopRenewal();
      cleanupCommandDownloads(connectorId, command.id);
    }
    await complete(connectorId, command, completion);
  };

  const pollCommands = async (): Promise<void> => {
    if (adapter.waitUntilReady) await adapter.waitUntilReady();
    const health = adapter.connectorHealth?.();
    for (const [profileId, connector] of Object.entries(profiles)) {
      // Device adapters publish an explicit offline state before their first
      // successful directory scan. Do not lease cloud commands until that
      // profile can resolve its configured and dynamically discovered targets.
      if (health && health[profileId]?.state !== 'online') continue;
      const connectorId = connector.id;
      const response = await fetch(
        `${serviceUrl}/api/connectors/commands?connectorId=${encodeURIComponent(connectorId)}&limit=1`,
        { headers: connectorHeaders(connectorId), signal: AbortSignal.timeout(15_000) },
      );
      const result = await jsonResponse(response) as unknown as { commands?: UnifiedCommand[] };
      for (const command of result.commands ?? []) await processCommand(profileId, connectorId, command);
    }
  };

  await registerConnectors();
  await adapter.start(queueMessage);
  let stopped = false;
  let lastBackgroundFlush = 0;
  let lastProfileSync = Date.now();
  let lastLayoutControlSync = 0;
  const heartbeatFlight = new SingleFlightTask();
  const profileSyncFlight = new SingleFlightTask();
  const layoutControlFlight = new SingleFlightTask();
  const eventFlushFlight = new SingleFlightTask();
  const backgroundFlushFlight = new SingleFlightTask();
  const connectorEventFlights = new Map(connectors.map((connector) => [connector.id, new SingleFlightTask()]));
  const connectorBackgroundFlights = new Map(connectors.map((connector) => [connector.id, new SingleFlightTask()]));
  const triggerHeartbeat = (): void => {
    void heartbeatFlight.run(heartbeat).catch((error: unknown) => {
      process.stderr.write(`connector heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  const triggerProfileSync = (): void => {
    void profileSyncFlight.run(syncConversationProfiles).catch((error: unknown) => {
      process.stderr.write(`conversation profile sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  const triggerLayoutControlSync = (): void => {
    if (!layoutControlSync) return;
    void layoutControlFlight.run(() => layoutControlSync.synchronize()).catch((error: unknown) => {
      process.stderr.write(`layout control sync failed: ${errorMessage(error)}\n`);
    });
  };
  const triggerBackgroundFlush = (): void => {
    void backgroundFlushFlight.run(flushBackgroundEvents).catch((error: unknown) => {
      process.stderr.write(`background flush failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    for (const connector of connectors) {
      const flight = connectorBackgroundFlights.get(connector.id)!;
      const directory = backgroundConnectorDirs.get(connector.id)!;
      void flight.run(() => flushConnectorBackgroundEvents(connector.id, directory)).catch((error: unknown) => {
        process.stderr.write(`background flush failed for ${safePart(connector.id)}: ${errorMessage(error)}\n`);
      });
    }
  };
  const triggerEventFlush = (): void => {
    void eventFlushFlight.run(flushEvents).catch((error: unknown) => {
      process.stderr.write(`inbound event flush failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    for (const connector of connectors) {
      const flight = connectorEventFlights.get(connector.id)!;
      const directory = pendingConnectorDirs.get(connector.id)!;
      void flight.run(() => flushConnectorEvents(connector.id, directory)).catch((error: unknown) => {
        process.stderr.write(`inbound event flush failed for ${safePart(connector.id)}: ${errorMessage(error)}\n`);
      });
    }
  };
  triggerHeartbeat();
  const heartbeatTimer = setInterval(triggerHeartbeat, HEARTBEAT_MS);
  triggerProfileSync();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    await adapter.stop();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  while (!stopped) {
    triggerEventFlush();
    if (Date.now() - lastBackgroundFlush >= BACKGROUND_FLUSH_MS) {
      lastBackgroundFlush = Date.now();
      triggerBackgroundFlush();
    }
    if (Date.now() - lastProfileSync >= PROFILE_SYNC_MS) {
      lastProfileSync = Date.now();
      triggerProfileSync();
    }
    if (layoutControlSync && Date.now() - lastLayoutControlSync >= layoutControlConfig.pollIntervalMs) {
      lastLayoutControlSync = Date.now();
      triggerLayoutControlSync();
    }
    try { await pollCommands(); } catch (error) {
      process.stderr.write(`command poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[unified-relay] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
