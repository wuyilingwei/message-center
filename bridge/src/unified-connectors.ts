export const relayCapabilities = [
  'receive_text', 'send_text', 'receive_files', 'send_files',
  'receive_images', 'send_images', 'receive_video', 'send_video',
  'threads', 'reactions', 'layout_control',
] as const;

export type RelayCapability = typeof relayCapabilities[number];

export interface RelayConnectorInstance {
  id: string;
  kind: string;
  channelLabel: string;
  accountLabel: string;
  displayName: string;
  note: string;
  mode: 'device_relay' | 'cloud_relay' | 'webhook';
  capabilities: RelayCapability[];
}

const capabilitySet = new Set<string>(relayCapabilities);

function connectorId(value: unknown): string {
  const result = String(value ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(result)) throw new Error('invalid_connector_id');
  return result;
}

function shortText(value: unknown, name: string, maximum: number): string {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum) throw new Error(`invalid_${name}`);
  return result;
}

function normalizeDescriptor(value: unknown): RelayConnectorInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_connector_descriptor');
  const descriptor = value as Record<string, unknown>;
  const kind = String(descriptor.kind ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(kind)) throw new Error('invalid_connector_kind');
  if (!Array.isArray(descriptor.capabilities)) throw new Error('invalid_connector_capabilities');
  const capabilities = [...new Set(descriptor.capabilities.map(String))];
  if (capabilities.length === 0 || capabilities.some((capability) => !capabilitySet.has(capability))) {
    throw new Error('invalid_connector_capabilities');
  }
  const mode = String(descriptor.mode ?? 'device_relay');
  if (!['device_relay', 'cloud_relay', 'webhook'].includes(mode)) throw new Error('invalid_connector_mode');
  return {
    id: connectorId(descriptor.id),
    kind,
    channelLabel: String(descriptor.channelLabel ?? '').trim().slice(0, 80),
    accountLabel: shortText(descriptor.accountLabel, 'account_label', 200),
    displayName: shortText(descriptor.displayName, 'display_name', 200),
    note: String(descriptor.note ?? '').trim().slice(0, 1000),
    mode: mode as RelayConnectorInstance['mode'],
    capabilities: capabilities as RelayCapability[],
  };
}

export function parseConnectorInstances(
  descriptorJson: string | undefined,
  legacyMapJson: string | undefined,
): Record<string, RelayConnectorInstance> {
  const source = descriptorJson ?? legacyMapJson;
  if (!source) throw new Error('BRIDGE_MESSAGE_CONNECTORS_required');
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_connector_map');
  const result: Record<string, RelayConnectorInstance> = {};
  for (const [profileId, value] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(profileId)) throw new Error('invalid_profile_id');
    result[profileId] = typeof value === 'string'
      ? {
        id: connectorId(value), kind: 'im', channelLabel: '', accountLabel: profileId, displayName: profileId,
        note: 'Legacy connector mapping', mode: 'device_relay',
        capabilities: ['receive_text', 'send_text'],
      }
      : normalizeDescriptor(value);
  }
  if (Object.keys(result).length === 0) throw new Error('empty_connector_map');
  const byId = new Set<string>();
  for (const connector of Object.values(result)) {
    if (byId.has(connector.id)) throw new Error('duplicate_connector_id');
    byId.add(connector.id);
  }
  return result;
}

export function uniqueConnectorInstances(values: Record<string, RelayConnectorInstance>): RelayConnectorInstance[] {
  return [...new Map(Object.values(values).map((connector) => [connector.id, connector])).values()];
}

export function assignLayoutControlOwner(
  connectors: RelayConnectorInstance[],
  ownerConnectorId?: string,
): RelayConnectorInstance[] {
  const declared = connectors.filter((connector) => connector.capabilities.includes('layout_control'));
  if (!ownerConnectorId) {
    if (declared.length) throw new Error('layout_control_owner_required');
    return connectors;
  }
  const owner = connectors.find((connector) => connector.id === ownerConnectorId);
  if (!owner) throw new Error('layout_control_owner_not_found');
  if (owner.mode !== 'device_relay') throw new Error('layout_control_owner_requires_device_relay');
  if (declared.some((connector) => connector.id !== ownerConnectorId)) {
    throw new Error('layout_control_capability_requires_owner');
  }
  return connectors.map((connector) => connector.id === ownerConnectorId
    ? {
      ...connector,
      capabilities: [...new Set<RelayCapability>([...connector.capabilities, 'layout_control'])],
    }
    : connector);
}

export function parseConnectorTokens(
  tokenMapJson: string | undefined,
  legacyToken: string | undefined,
  connectorIds: Iterable<string>,
): Record<string, string> {
  const requiredIds = [...new Set(connectorIds)];
  if (tokenMapJson === undefined) {
    if (!legacyToken || legacyToken.length < 32) throw new Error('BRIDGE_MESSAGE_CONNECTOR_TOKEN_required');
    return Object.fromEntries(requiredIds.map((id) => [id, legacyToken]));
  }
  if (tokenMapJson.length > 256 * 1024) throw new Error('invalid_connector_tokens');
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenMapJson);
  } catch {
    throw new Error('invalid_connector_tokens');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_connector_tokens');
  }
  const values = parsed as Record<string, unknown>;
  const uniqueTokens = new Set<string>();
  for (const [id, token] of Object.entries(values)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(id) || typeof token !== 'string' ||
        token.length < 32 || token.length > 4096 || /\s/.test(token) || uniqueTokens.has(token)) {
      throw new Error('invalid_connector_tokens');
    }
    uniqueTokens.add(token);
  }
  if (uniqueTokens.size === 0) throw new Error('invalid_connector_tokens');
  const result: Record<string, string> = {};
  for (const id of requiredIds) {
    const token = Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined;
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s/.test(token)) {
      throw new Error(`connector_token_missing:${id}`);
    }
    result[id] = token;
  }
  return result;
}
