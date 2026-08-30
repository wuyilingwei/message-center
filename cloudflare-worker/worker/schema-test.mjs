import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

const stamp = new Date().toISOString();
const freshMigrationDatabase = new DatabaseSync(':memory:');
const migrationDirectory = new URL('../migrations/', import.meta.url);
for (const fileName of readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
  freshMigrationDatabase.exec(readFileSync(new URL(fileName, migrationDirectory), 'utf8'));
}
assert.equal(freshMigrationDatabase.prepare(`
  SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state'
`).get().total, 1);
assert.equal(freshMigrationDatabase.prepare(`
  SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'connector_layout_control'
`).get().total, 1);
assert.deepEqual(freshMigrationDatabase.prepare('PRAGMA table_info(connector_layout_control)').all()
  .map((row) => row.name).filter((name) => [
    'device_generation', 'device_action_id', 'device_action_revision', 'device_action_enabled',
  ].includes(name)), [
    'device_generation', 'device_action_id', 'device_action_revision', 'device_action_enabled',
  ]);
assert.deepEqual(freshMigrationDatabase.prepare('PRAGMA table_info(connector_instances)').all()
  .map((row) => row.name).filter((name) => name === 'channel_label'), ['channel_label']);
assert.deepEqual(freshMigrationDatabase.prepare('PRAGMA table_info(messages)').all()
  .map((row) => row.name).filter((name) => name === 'queue_class'), ['queue_class']);
assert.deepEqual(freshMigrationDatabase.prepare('PRAGMA table_info(conversation_profiles)').all()
  .map((row) => row.name).filter((name) => name === 'native_unread_observed_at'), ['native_unread_observed_at']);
assert.deepEqual(freshMigrationDatabase.prepare('PRAGMA table_info(attachments)').all()
  .map((row) => row.name).filter((name) => name === 'inbound_cleanup_marked_at'), ['inbound_cleanup_marked_at']);
freshMigrationDatabase.close();

const migrationDatabase = new DatabaseSync(':memory:');
migrationDatabase.exec(`
  CREATE TABLE connector_instances (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel_label TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
    avatar_label TEXT NOT NULL DEFAULT '?', trust_tier TEXT NOT NULL DEFAULT 'untrusted',
    agent_policy_json TEXT NOT NULL DEFAULT '{}', unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_preview TEXT NOT NULL DEFAULT '', last_message_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_conversations_external ON conversations(connector_id, external_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, connector_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE group_text_backups (
    connector_id TEXT NOT NULL, conversation_external_id TEXT NOT NULL,
    placement TEXT NOT NULL DEFAULT 'unknown', occurred_at TEXT NOT NULL
  );
  CREATE TABLE conversation_profiles (
    connector_id TEXT NOT NULL, conversation_external_id TEXT NOT NULL, display_name TEXT NOT NULL,
    avatar_object_key TEXT, avatar_mime_type TEXT, avatar_size_bytes INTEGER, avatar_sha256 TEXT,
    updated_at TEXT NOT NULL, PRIMARY KEY (connector_id, conversation_external_id)
  );
`);
migrationDatabase.prepare(`
  INSERT INTO connector_instances (id, kind, channel_label) VALUES (?, 'im', 'Channel A')
`).run('instance-migration');
migrationDatabase.prepare(`
  INSERT INTO conversation_profiles (connector_id, conversation_external_id, display_name, updated_at)
  VALUES (?, ?, ?, ?)
`).run('instance-migration', 'profile-only-migration', 'Migrated profile', stamp);
migrationDatabase.prepare(`
  INSERT INTO group_text_backups (connector_id, conversation_external_id, placement, occurred_at)
  VALUES (?, ?, 'folded', ?)
`).run('instance-migration', 'profile-only-migration', stamp);
migrationDatabase.exec(readFileSync(new URL('../migrations/0003_conversation_profile_metadata.sql', import.meta.url), 'utf8'));
migrationDatabase.exec(readFileSync(new URL('../migrations/0005_conversation_native_state.sql', import.meta.url), 'utf8'));
const migratedProfile = migrationDatabase.prepare(`
  SELECT channel_label, conversation_type, placement, is_pinned FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = ?
`).get('instance-migration', 'profile-only-migration');
assert.deepEqual({ ...migratedProfile }, {
  channel_label: 'Channel A', conversation_type: 'group', placement: 'folded', is_pinned: 0,
});
assert.equal(migrationDatabase.prepare(`
  SELECT COUNT(*) AS total FROM conversations
  WHERE connector_id = ? AND external_id = ? AND title = ?
`).get('instance-migration', 'profile-only-migration', 'Migrated profile').total, 1);
migrationDatabase.close();

const conflictMigrationDatabase = new DatabaseSync(':memory:');
conflictMigrationDatabase.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
conflictMigrationDatabase.prepare(`
  INSERT INTO connector_instances (id, kind, account_label, display_name, mode, created_at, updated_at)
  VALUES ('instance-conflict', 'im', 'fixture', 'Fixture', 'device_relay', ?, ?)
`).run(stamp, stamp);
const insertConflictConversation = conflictMigrationDatabase.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, last_message_preview, created_at, updated_at
  ) VALUES (?, 'instance-conflict', ?, ?, ?, ?, ?)
`);
insertConflictConversation.run('conversation-conflict-a', 'native-a', 'Conversation A', 'A preview', stamp, stamp);
insertConflictConversation.run('conversation-conflict-b', 'native-b', 'Conversation B', 'B preview', stamp, stamp);
conflictMigrationDatabase.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body, occurred_at, created_at
  ) VALUES ('message-conflict-existing', 'conversation-conflict-a', 'instance-conflict',
    'external-conflict', 'inbound', 'Member', 'A body', ?, ?)
`).run(stamp, stamp);
conflictMigrationDatabase.prepare(`
  INSERT INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_name, body, placement, occurred_at, received_at
  ) VALUES ('instance-conflict', 'native-b', 'Wrong B title', 'external-conflict',
    'Member', 'Wrong B body', 'normal', ?, ?)
`).run(stamp, stamp);
conflictMigrationDatabase.exec(readFileSync(
  new URL('../migrations/0004_normalize_existing_backups.sql', import.meta.url), 'utf8',
));
assert.deepEqual({ ...conflictMigrationDatabase.prepare(`
  SELECT title, last_message_preview FROM conversations WHERE id = 'conversation-conflict-b'
`).get() }, { title: 'Conversation B', last_message_preview: 'B preview' });
assert.equal(conflictMigrationDatabase.prepare(`
  SELECT COUNT(*) AS total FROM messages WHERE conversation_id = 'conversation-conflict-b'
`).get().total, 0);
conflictMigrationDatabase.close();

const database = new DatabaseSync(':memory:');
database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const profileColumns = database.prepare('PRAGMA table_info(conversation_profiles)').all().map((row) => row.name);
assert.ok(profileColumns.includes('channel_label'));
assert.ok(profileColumns.includes('conversation_type'));
assert.ok(profileColumns.includes('placement'));
assert.ok(profileColumns.includes('is_pinned'));
assert.ok(profileColumns.includes('native_last_message_preview'));
assert.ok(profileColumns.includes('native_last_message_at'));
assert.ok(profileColumns.includes('native_unread_count'));
assert.ok(profileColumns.includes('native_unread_observed_at'));
const attachmentColumns = database.prepare('PRAGMA table_info(attachments)').all().map((row) => row.name);
assert.ok(attachmentColumns.includes('outbound_request_fingerprint'));
assert.ok(attachmentColumns.includes('inbound_cleanup_marked_at'));
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state'
`).get().total, 1);
assert.deepEqual(database.prepare('PRAGMA table_info(connector_layout_control)').all()
  .map((row) => row.name).filter((name) => [
    'desired_enabled', 'revision', 'reported_enabled', 'reported_revision',
    'device_generation', 'device_action_id', 'device_action_revision', 'device_action_enabled',
  ].includes(name)), [
    'desired_enabled', 'revision', 'reported_enabled', 'reported_revision',
    'device_generation', 'device_action_id', 'device_action_revision', 'device_action_enabled',
  ]);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM sqlite_master
  WHERE type = 'index' AND name = 'idx_attachments_outbound_claim'
`).get().total, 1);
const statement = database.prepare(`
  INSERT INTO connector_instances (
    id, kind, account_label, display_name, mode, capabilities_json, created_at, updated_at
  ) VALUES (?, 'email', ?, ?, 'cloud_relay', ?, ?, ?)
`);
statement.run('instance-email-personal', 'personal@example.test', '个人邮箱', '["receive_text","send_text"]', stamp, stamp);
statement.run('instance-email-alerts', 'alerts@example.test', '告警邮箱', '["receive_text"]', stamp, stamp);
assert.equal(database.prepare("SELECT COUNT(*) AS total FROM connector_instances WHERE kind = 'email'").get().total, 2);
assert.equal(database.prepare("SELECT capabilities_json FROM connector_instances WHERE id = ?").get('instance-email-alerts').capabilities_json, '["receive_text"]');
const backup = database.prepare(`
  INSERT OR IGNORE INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_id, sender_name, body, placement, occurred_at, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
backup.run('instance-email-personal', 'conversation-test', 'Test', 'message-background-1',
  'member-test', 'Member', 'text only', 'folded', stamp, stamp);
backup.run('instance-email-personal', 'conversation-test', 'Test', 'message-background-1',
  'member-test', 'Member', 'duplicate', 'folded', stamp, stamp);
assert.equal(database.prepare('SELECT COUNT(*) AS total FROM group_text_backups').get().total, 1);
database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`).run('conversation-row', 'instance-email-personal', 'conversation-external', 'Conversation', stamp, stamp);
const message = database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, occurred_at, created_at
  ) VALUES (?, 'conversation-row', 'instance-email-personal', ?, 'inbound', 'Member', ?, ?, ?, ?)
`);
message.run('message-immediate', 'external-immediate', 'immediate', 'immediate', stamp, stamp);
message.run('message-background', 'external-background', 'background', 'background', stamp, stamp);
database.prepare("INSERT INTO agent_queue (message_id, created_at) VALUES ('message-immediate', ?)").run(stamp);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM agent_queue q JOIN messages m ON m.id = q.message_id
  WHERE m.queue_class = 'immediate'
`).get().total, 1);
assert.equal(database.prepare("SELECT queue_class FROM messages WHERE id = 'message-background'").get().queue_class, 'background');

function d1Statement(sql, args = []) {
  const statement = database.prepare(sql);
  return {
    bind(...values) { return d1Statement(sql, values); },
    async run() {
      const result = statement.run(...args);
      return { meta: { changes: Number(result.changes) } };
    },
    async first() { return statement.get(...args) ?? null; },
    async all() { return { results: statement.all(...args) }; },
  };
}

const d1 = {
  prepare(sql) { return d1Statement(sql); },
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
};
const connectorToken = 'c'.repeat(40);
const nonOwnerConnectorToken = 'n'.repeat(40);
const wrongModeConnectorToken = 'w'.repeat(40);
const adminToken = 'a'.repeat(40);
const agentToken = 'g'.repeat(40);
const connectorId = 'instance-device-test';
const nonOwnerConnectorId = 'instance-device-secondary';
const wrongModeConnectorId = 'instance-cloud-layout-test';
database.prepare(`
  INSERT INTO connector_instances (
    id, kind, channel_label, account_label, display_name, mode, capabilities_json, created_at, updated_at
  ) VALUES (?, 'im', 'Test IM', 'device', 'Device', 'device_relay',
    '["receive_text","receive_files","send_text","send_files","layout_control"]', ?, ?)
`).run(connectorId, stamp, stamp);
database.prepare(`
  INSERT INTO connector_instances (
    id, kind, channel_label, account_label, display_name, mode, capabilities_json, created_at, updated_at
  ) VALUES (?, 'im', 'Test IM', 'secondary', 'Secondary', 'device_relay',
    '["receive_text"]', ?, ?)
`).run(nonOwnerConnectorId, stamp, stamp);
database.prepare(`
  INSERT INTO connector_instances (
    id, kind, channel_label, account_label, display_name, mode, capabilities_json, created_at, updated_at
  ) VALUES (?, 'im', 'Test IM', 'cloud', 'Cloud', 'cloud_relay',
    '["receive_text","layout_control"]', ?, ?)
`).run(wrongModeConnectorId, stamp, stamp);
database.prepare(`
  INSERT INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_id, sender_name, body, placement, occurred_at, received_at
  ) VALUES (?, 'conversation-legacy-backup', 'Legacy group', 'message-legacy-backup',
    'member-legacy', 'Legacy member', 'legacy background text', 'normal', ?, ?)
`).run(connectorId, stamp, stamp);
const normalizeBackupsMigration = readFileSync(
  new URL('../migrations/0004_normalize_existing_backups.sql', import.meta.url), 'utf8',
);
database.exec(normalizeBackupsMigration);
database.exec(normalizeBackupsMigration);
database.exec(readFileSync(
  new URL('../migrations/0006_reconcile_backup_retention.sql', import.meta.url), 'utf8',
));
const migratedBackup = database.prepare(`
  SELECT m.body, m.queue_class, c.title, c.last_message_preview
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.connector_id = ? AND m.external_id = 'message-legacy-backup'
`).get(connectorId);
assert.deepEqual({ ...migratedBackup }, {
  body: 'legacy background text', queue_class: 'background',
  title: 'Legacy group', last_message_preview: 'legacy background text',
});
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM messages
  WHERE connector_id = ? AND external_id = 'message-legacy-backup'
`).get(connectorId).total, 1);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM agent_queue q
  JOIN messages m ON m.id = q.message_id
  WHERE m.connector_id = ? AND m.external_id = 'message-legacy-backup'
`).get(connectorId).total, 0);
const authoritativeLastSeen = '2026-08-28T10:00:00.000Z';
const authoritativeUpdatedAt = '2026-08-28T10:00:01.000Z';
database.prepare(`
  UPDATE connector_instances SET state = 'offline', last_seen_at = ?, updated_at = ? WHERE id = ?
`).run(authoritativeLastSeen, authoritativeUpdatedAt, connectorId);

const r2Objects = new Map();
const deletedR2Keys = [];
let paginatedInboundSweep = false;
const r2 = {
  async put(key, body, options = {}) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    r2Objects.set(key, { bytes, options, uploaded: new Date() });
  },
  async delete(key) { deletedR2Keys.push(key); r2Objects.delete(key); },
  async head(key) {
    const value = r2Objects.get(key);
    if (!value) return null;
    return { size: value.bytes.byteLength, customMetadata: value.options.customMetadata,
      httpMetadata: value.options.httpMetadata, uploaded: value.uploaded };
  },
  async get(key) {
    const value = r2Objects.get(key);
    if (!value) return null;
    return { body: value.bytes, size: value.bytes.byteLength, httpMetadata: value.options.httpMetadata,
      httpEtag: `etag-${key}` };
  },
  async list({ prefix = '', cursor } = {}) {
    if (paginatedInboundSweep && prefix === 'inbound/') {
      const page = cursor === undefined ? 0 : Number(cursor);
      return {
        objects: [{ key: `inbound/virtual-page-${page}`,
          uploaded: page === 20 ? new Date('2000-01-01T00:00:00.000Z') : new Date() }],
        truncated: page < 20,
        ...(page < 20 ? { cursor: String(page + 1) } : {}),
      };
    }
    if (cursor) return { objects: [], truncated: false };
    return { objects: [...r2Objects.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, uploaded: value.uploaded })), truncated: false };
  },
};
const workerEnv = {
  DB: d1,
  FILES: r2,
  CONNECTOR_TOKENS: JSON.stringify({
    [connectorId]: connectorToken,
    [nonOwnerConnectorId]: nonOwnerConnectorToken,
    [wrongModeConnectorId]: wrongModeConnectorToken,
  }),
  ADMIN_TOKEN: adminToken,
  AGENT_TOKEN: agentToken,
};

const connectorLayoutHeaders = {
  authorization: `Bearer ${connectorToken}`,
  'x-connector-id': connectorId,
};
const crossConnectorLayoutResponse = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/layout-control?connectorId=instance-other-device',
  { headers: connectorLayoutHeaders },
), workerEnv, {});
assert.equal(crossConnectorLayoutResponse.status, 403);
assert.equal((await crossConnectorLayoutResponse.json()).error, 'connector_id_mismatch');
const layoutBodyMismatchResponse = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/layout-control/ack', {
    method: 'POST',
    headers: { ...connectorLayoutHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ connectorId: 'instance-other-device', revision: 0, enabled: false }),
  },
), workerEnv, {});
assert.equal(layoutBodyMismatchResponse.status, 403);
assert.equal((await layoutBodyMismatchResponse.json()).error, 'connector_id_mismatch');
for (const [unsupportedConnectorId, unsupportedConnectorToken] of [
  [nonOwnerConnectorId, nonOwnerConnectorToken],
  [wrongModeConnectorId, wrongModeConnectorToken],
]) {
  const unsupportedLayoutResponse = await worker.fetch(new Request(
    `https://message.example.com/api/connectors/layout-control?connectorId=${unsupportedConnectorId}`,
    { headers: {
      authorization: `Bearer ${unsupportedConnectorToken}`,
      'x-connector-id': unsupportedConnectorId,
    } },
  ), workerEnv, {});
  assert.equal(unsupportedLayoutResponse.status, 403);
  assert.equal((await unsupportedLayoutResponse.json()).error, 'layout_control_not_supported');
}
const invalidLayoutOwnerRegistration = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/register', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${wrongModeConnectorToken}`,
      'content-type': 'application/json',
      'x-connector-id': wrongModeConnectorId,
    },
    body: JSON.stringify({
      id: wrongModeConnectorId,
      kind: 'im',
      accountLabel: 'cloud',
      displayName: 'Cloud',
      mode: 'cloud_relay',
      capabilities: ['receive_text', 'layout_control'],
    }),
  },
), workerEnv, {});
assert.equal(invalidLayoutOwnerRegistration.status, 400);
assert.equal((await invalidLayoutOwnerRegistration.json()).error, 'invalid_connector_capabilities');
const unsupportedAdminLayoutUpdate = await worker.fetch(new Request(
  `https://message.example.com/api/connectors/${nonOwnerConnectorId}/layout-control`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, expectedRevision: 0 }),
  },
), workerEnv, {});
assert.equal(unsupportedAdminLayoutUpdate.status, 403);
assert.equal((await unsupportedAdminLayoutUpdate.json()).error, 'layout_control_not_supported');
const unauthenticatedLayoutUpdate = await worker.fetch(new Request(
  `https://message.example.com/api/connectors/${connectorId}/layout-control`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, expectedRevision: 0 }),
  },
), workerEnv, {});
assert.equal(unauthenticatedLayoutUpdate.status, 401);
const initialLayoutResponse = await worker.fetch(new Request(
  `https://message.example.com/api/connectors/layout-control?connectorId=${connectorId}`,
  { headers: connectorLayoutHeaders },
), workerEnv, {});
assert.equal(initialLayoutResponse.status, 200);
assert.deepEqual((await initialLayoutResponse.json()).layoutControl, {
  enabled: false, revision: 0, updatedAt: null, reason: 'not_configured',
  deviceGeneration: null, deviceActionId: null,
  deviceActionRevision: null, deviceActionEnabled: null,
  acknowledgement: null, synchronized: false,
});

async function updateLayout(enabled, expectedRevision) {
  return worker.fetch(new Request(
    `https://message.example.com/api/connectors/${connectorId}/layout-control`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, expectedRevision }),
    },
  ), workerEnv, {});
}

async function acknowledgeLayout(body) {
  return worker.fetch(new Request(
    'https://message.example.com/api/connectors/layout-control/ack', {
      method: 'POST',
      headers: { ...connectorLayoutHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId, ...body }),
    },
  ), workerEnv, {});
}

const enabledLayoutResponse = await updateLayout(true, 0);
assert.equal(enabledLayoutResponse.status, 200);
const enabledLayout = (await enabledLayoutResponse.json()).layoutControl;
assert.deepEqual({ enabled: enabledLayout.enabled, revision: enabledLayout.revision,
  reason: enabledLayout.reason, acknowledgement: enabledLayout.acknowledgement,
  synchronized: enabledLayout.synchronized }, {
  enabled: true, revision: 1, reason: 'administrator', acknowledgement: null, synchronized: false,
});
assert.ok(Number.isFinite(Date.parse(enabledLayout.updatedAt)));
const staleAdminLayoutResponse = await updateLayout(false, 0);
assert.equal(staleAdminLayoutResponse.status, 409);
assert.equal((await staleAdminLayoutResponse.json()).layoutControl.revision, 1);

const appliedLayoutResponse = await acknowledgeLayout({ revision: 1, enabled: true, reason: 'applied' });
assert.equal(appliedLayoutResponse.status, 200);
const appliedLayoutPayload = await appliedLayoutResponse.json();
assert.deepEqual({ accepted: appliedLayoutPayload.accepted, idempotent: appliedLayoutPayload.idempotent },
  { accepted: true, idempotent: false });
const appliedLayout = appliedLayoutPayload.layoutControl;
assert.equal(appliedLayout.synchronized, true);
assert.deepEqual({ enabled: appliedLayout.acknowledgement.enabled, revision: appliedLayout.acknowledgement.revision },
  { enabled: true, revision: 1 });

const duplicateAppliedLayoutResponse = await acknowledgeLayout({
  revision: 1, enabled: true, reason: 'must_not_replace_first_ack',
});
assert.equal(duplicateAppliedLayoutResponse.status, 200);
const duplicateAppliedLayout = await duplicateAppliedLayoutResponse.json();
assert.deepEqual({ accepted: duplicateAppliedLayout.accepted, idempotent: duplicateAppliedLayout.idempotent,
  reason: duplicateAppliedLayout.layoutControl.acknowledgement.reason }, {
  accepted: false, idempotent: true, reason: 'applied',
});
const reversedAppliedLayoutResponse = await acknowledgeLayout({ revision: 1, enabled: false, reason: 'reversed' });
assert.equal(reversedAppliedLayoutResponse.status, 409);
assert.equal((await reversedAppliedLayoutResponse.json()).error, 'layout_state_mismatch');

const localStopActionId = 'layout-stop-action-0001';
const localStopLayoutResponse = await acknowledgeLayout({
  enabled: false, localStop: true, deviceGeneration: 1, actionId: localStopActionId,
  reason: 'local_home_stop',
});
assert.equal(localStopLayoutResponse.status, 200);
const stoppedLayoutPayload = await localStopLayoutResponse.json();
assert.deepEqual({ accepted: stoppedLayoutPayload.accepted, idempotent: stoppedLayoutPayload.idempotent },
  { accepted: true, idempotent: false });
const stoppedLayout = stoppedLayoutPayload.layoutControl;
assert.deepEqual({ enabled: stoppedLayout.enabled, revision: stoppedLayout.revision,
  deviceGeneration: stoppedLayout.deviceGeneration, deviceActionId: stoppedLayout.deviceActionId,
  deviceActionRevision: stoppedLayout.deviceActionRevision,
  deviceActionEnabled: stoppedLayout.deviceActionEnabled,
  acknowledgedEnabled: stoppedLayout.acknowledgement.enabled,
  acknowledgedRevision: stoppedLayout.acknowledgement.revision, synchronized: stoppedLayout.synchronized }, {
  enabled: false, revision: 2, deviceGeneration: 1, deviceActionId: localStopActionId,
  deviceActionRevision: 2, deviceActionEnabled: false,
  acknowledgedEnabled: false, acknowledgedRevision: 2, synchronized: true,
});

const duplicateLocalStopResponse = await acknowledgeLayout({
  enabled: false, localStop: true, deviceGeneration: 1, actionId: localStopActionId,
  reason: 'duplicate_after_lost_response',
});
assert.equal(duplicateLocalStopResponse.status, 200);
const duplicateLocalStop = await duplicateLocalStopResponse.json();
assert.deepEqual({ accepted: duplicateLocalStop.accepted, idempotent: duplicateLocalStop.idempotent,
  revision: duplicateLocalStop.layoutControl.revision }, { accepted: false, idempotent: true, revision: 2 });
const changedPayloadForSameActionResponse = await acknowledgeLayout({
  enabled: true, localStart: true, deviceGeneration: 1, actionId: localStopActionId,
});
assert.equal(changedPayloadForSameActionResponse.status, 409);
assert.equal((await changedPayloadForSameActionResponse.json()).error, 'layout_device_action_conflict');
const reusedGenerationResponse = await acknowledgeLayout({
  enabled: true, localStart: true, deviceGeneration: 1, actionId: 'layout-start-action-collision',
});
assert.equal(reusedGenerationResponse.status, 409);
assert.equal((await reusedGenerationResponse.json()).error, 'layout_device_generation_conflict');
const staleGenerationResponse = await acknowledgeLayout({
  enabled: false, localStop: true, deviceGeneration: 0, actionId: 'layout-stop-action-0000',
});
assert.equal(staleGenerationResponse.status, 409);
assert.equal((await staleGenerationResponse.json()).error, 'layout_device_generation_stale');

const delayedEnabledAckResponse = await acknowledgeLayout({ revision: 1, enabled: true, reason: 'delayed' });
assert.equal(delayedEnabledAckResponse.status, 409);
const delayedEnabledAck = await delayedEnabledAckResponse.json();
assert.equal(delayedEnabledAck.error, 'layout_revision_conflict');
assert.deepEqual({ enabled: delayedEnabledAck.layoutControl.enabled,
  revision: delayedEnabledAck.layoutControl.revision,
  acknowledgedEnabled: delayedEnabledAck.layoutControl.acknowledgement.enabled,
  acknowledgedRevision: delayedEnabledAck.layoutControl.acknowledgement.revision }, {
  enabled: false, revision: 2, acknowledgedEnabled: false, acknowledgedRevision: 2,
});

const enabledAfterLostStopResponse = await updateLayout(true, 2);
assert.equal(enabledAfterLostStopResponse.status, 200);
assert.equal((await enabledAfterLostStopResponse.json()).layoutControl.revision, 3);
const lostStopRetryAfterAdminResponse = await acknowledgeLayout({
  enabled: false, localStop: true, deviceGeneration: 1, actionId: localStopActionId,
});
assert.equal(lostStopRetryAfterAdminResponse.status, 200);
const lostStopRetryAfterAdmin = await lostStopRetryAfterAdminResponse.json();
assert.deepEqual({
  accepted: lostStopRetryAfterAdmin.accepted,
  idempotent: lostStopRetryAfterAdmin.idempotent,
  currentEnabled: lostStopRetryAfterAdmin.layoutControl.enabled,
  currentRevision: lostStopRetryAfterAdmin.layoutControl.revision,
  actionEnabled: lostStopRetryAfterAdmin.layoutControl.deviceActionEnabled,
  actionRevision: lostStopRetryAfterAdmin.layoutControl.deviceActionRevision,
}, {
  accepted: false, idempotent: true,
  currentEnabled: true, currentRevision: 3,
  actionEnabled: false, actionRevision: 2,
});

const localStartActionId = 'layout-start-action-0002';
const reenabledLayoutResponse = await acknowledgeLayout({
  enabled: true, localStart: true, deviceGeneration: 2, actionId: localStartActionId,
  reason: 'local_icon_start',
});
assert.equal(reenabledLayoutResponse.status, 200);
const reenabledLayout = (await reenabledLayoutResponse.json()).layoutControl;
assert.equal(reenabledLayout.enabled, true);
assert.equal(reenabledLayout.revision, 4);
assert.equal(reenabledLayout.deviceGeneration, 2);
assert.equal(reenabledLayout.deviceActionId, localStartActionId);
assert.equal(reenabledLayout.deviceActionRevision, 4);
assert.equal(reenabledLayout.deviceActionEnabled, true);
assert.equal(reenabledLayout.synchronized, true);
const reorderedOldStopResponse = await acknowledgeLayout({
  enabled: false, localStop: true, deviceGeneration: 1, actionId: localStopActionId,
});
assert.equal(reorderedOldStopResponse.status, 409);
const reorderedOldStop = await reorderedOldStopResponse.json();
assert.equal(reorderedOldStop.error, 'layout_device_generation_stale');
assert.deepEqual({ enabled: reorderedOldStop.layoutControl.enabled, revision: reorderedOldStop.layoutControl.revision },
  { enabled: true, revision: 4 });
const disabledByAdminResponse = await updateLayout(false, 4);
assert.equal(disabledByAdminResponse.status, 200);
assert.equal((await disabledByAdminResponse.json()).layoutControl.revision, 5);
const duplicateStartAfterAdminResponse = await acknowledgeLayout({
  enabled: true, localStart: true, deviceGeneration: 2, actionId: localStartActionId,
});
assert.equal(duplicateStartAfterAdminResponse.status, 200);
const duplicateStartAfterAdmin = await duplicateStartAfterAdminResponse.json();
assert.deepEqual({ accepted: duplicateStartAfterAdmin.accepted, idempotent: duplicateStartAfterAdmin.idempotent,
  enabled: duplicateStartAfterAdmin.layoutControl.enabled,
  revision: duplicateStartAfterAdmin.layoutControl.revision,
  actionEnabled: duplicateStartAfterAdmin.layoutControl.deviceActionEnabled,
  actionRevision: duplicateStartAfterAdmin.layoutControl.deviceActionRevision }, {
  accepted: false, idempotent: true, enabled: false, revision: 5,
  actionEnabled: true, actionRevision: 4,
});
const enabledByAdminResponse = await updateLayout(true, 5);
assert.equal(enabledByAdminResponse.status, 200);
assert.equal((await enabledByAdminResponse.json()).layoutControl.revision, 6);
const olderAckResponse = await acknowledgeLayout({ revision: 2, enabled: false, reason: 'older' });
assert.equal(olderAckResponse.status, 409);
assert.equal((await olderAckResponse.json()).error, 'layout_revision_conflict');
const wrongCurrentAckResponse = await acknowledgeLayout({ revision: 6, enabled: false, reason: 'wrong_current' });
assert.equal(wrongCurrentAckResponse.status, 409);
assert.equal((await wrongCurrentAckResponse.json()).error, 'layout_state_mismatch');
const actuallyFutureAckResponse = await acknowledgeLayout({ revision: 7, enabled: true, reason: 'future' });
assert.equal(actuallyFutureAckResponse.status, 409);
assert.equal((await actuallyFutureAckResponse.json()).layoutControl.revision, 6);

async function callAgentToolResult(name, args) {
  const response = await worker.fetch(new Request('https://message.example.com/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), workerEnv, {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  return payload.result;
}

async function callAgentTool(name, args) {
  const result = await callAgentToolResult(name, args);
  assert.notEqual(result?.isError, true, result?.content?.[0]?.text);
  return result.structuredContent;
}

database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES (?, 'conversation-row', 'instance-email-personal', ?, 'inbound', 'Member', ?,
    'immediate', ?, ?, ?)
`).run('message-agent-expired-lease', 'external-agent-expired-lease', 'lease expiry fixture',
  JSON.stringify({ trigger: 'direct', conversationType: 'direct' }), stamp, stamp);
database.prepare("INSERT INTO agent_queue (message_id, created_at) VALUES ('message-agent-expired-lease', ?)").run(stamp);
const expiredLeaseClaim = await callAgentTool('claim_message', {
  consumerId: 'consumer-expired-lease', messageId: 'message-agent-expired-lease',
});
assert.equal(expiredLeaseClaim.acquired, true);
database.prepare(`
  UPDATE agent_queue SET lease_expires_at = '2000-01-01T00:00:00.000Z'
  WHERE message_id = 'message-agent-expired-lease'
`).run();
const expiredLeaseConsume = await callAgentTool('consume_message', {
  consumerId: 'consumer-expired-lease', messageId: 'message-agent-expired-lease',
  leaseToken: expiredLeaseClaim.message.leaseToken, outcome: 'completed',
});
assert.equal(expiredLeaseConsume.consumed, false);
assert.equal(database.prepare(`
  SELECT state FROM agent_queue WHERE message_id = 'message-agent-expired-lease'
`).get().state, 'leased');
database.prepare(`
  UPDATE agent_queue SET state = 'pending', lease_token = NULL, lease_expires_at = NULL,
    leased_by = NULL, completed_at = NULL, outcome = NULL
  WHERE message_id = 'message-agent-expired-lease'
`).run();
const naturallyExpiringClaim = await callAgentTool('claim_message', {
  consumerId: 'consumer-natural-expiry', messageId: 'message-agent-expired-lease',
});
const consumePrepare = d1.prepare;
let delayConsumePastLease = true;
const wrapConsumeExpiry = (statement, sql) => ({
  bind(...values) { return wrapConsumeExpiry(statement.bind(...values), sql); },
  async run() {
    if (delayConsumePastLease && /UPDATE agent_queue SET state = \?, outcome = \?/.test(sql)) {
      delayConsumePastLease = false;
      database.prepare(`
        UPDATE agent_queue SET lease_expires_at = ? WHERE message_id = 'message-agent-expired-lease'
      `).run(new Date(Date.now() + 25).toISOString());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return statement.run();
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapConsumeExpiry(consumePrepare(sql), sql);
const naturallyExpiredConsume = await callAgentTool('consume_message', {
  consumerId: 'consumer-natural-expiry', messageId: 'message-agent-expired-lease',
  leaseToken: naturallyExpiringClaim.message.leaseToken, outcome: 'completed',
});
d1.prepare = consumePrepare;
assert.equal(naturallyExpiredConsume.consumed, false);
assert.equal(database.prepare(`
  SELECT state FROM agent_queue WHERE message_id = 'message-agent-expired-lease'
`).get().state, 'leased');
database.prepare("DELETE FROM agent_queue WHERE message_id = 'message-agent-expired-lease'").run();
database.prepare("DELETE FROM messages WHERE id = 'message-agent-expired-lease'").run();

database.prepare(`
  UPDATE conversations SET trust_tier = 'trusted', agent_policy_json = ? WHERE id = 'conversation-row'
`).run(JSON.stringify({ enabled: true, requiredPrefix: '', allowedSenderIds: [], projectIds: [],
  allowedActions: ['send_text'], replyPolicy: 'informational' }));

database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES ('message-agent-reply-race', 'conversation-row', 'instance-email-personal',
    'external-agent-reply-race', 'inbound', 'Member', 'reply race fixture',
    'immediate', '{"trigger":"direct","conversationType":"direct"}', ?, ?)
`).run(stamp, stamp);
database.prepare("INSERT INTO agent_queue (message_id, created_at) VALUES ('message-agent-reply-race', ?)").run(stamp);
const replyRaceClaim = await callAgentTool('claim_message', {
  consumerId: 'consumer-reply-race', messageId: 'message-agent-reply-race',
});
const replyRaceBatch = d1.batch;
let expireReplyLeaseBeforeBatch = true;
d1.batch = async (statements) => {
  if (expireReplyLeaseBeforeBatch) {
    expireReplyLeaseBeforeBatch = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    database.prepare(`
      UPDATE agent_queue SET lease_expires_at = ?
      WHERE message_id = 'message-agent-reply-race'
    `).run(new Date(Date.now() - 1).toISOString());
  }
  return replyRaceBatch(statements);
};
const lostLeaseReply = await callAgentToolResult('reply_message', {
  consumerId: 'consumer-reply-race', messageId: 'message-agent-reply-race',
  leaseToken: replyRaceClaim.message.leaseToken, clientRequestId: 'agent-reply-race-request-0001',
  text: 'must not be queued after lease loss',
});
d1.batch = replyRaceBatch;
assert.equal(lostLeaseReply.isError, true);
assert.equal(lostLeaseReply.content[0].text, 'invalid_message_lease');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'agent-reply-race-request-0001'
`).get().total, 0);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM messages WHERE created_by = 'agent:consumer-reply-race'
`).get().total, 0);
database.prepare("DELETE FROM agent_queue WHERE message_id = 'message-agent-reply-race'").run();
database.prepare("DELETE FROM messages WHERE id = 'message-agent-reply-race'").run();

database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES ('message-agent-reply-reclaimed', 'conversation-row', 'instance-email-personal',
    'external-agent-reply-reclaimed', 'inbound', 'Member', 'reply reclaimed fixture',
    'immediate', '{"trigger":"direct","conversationType":"direct"}', ?, ?)
`).run(stamp, stamp);
database.prepare("INSERT INTO agent_queue (message_id, created_at) VALUES ('message-agent-reply-reclaimed', ?)").run(stamp);
const reclaimedReplyClaim = await callAgentTool('claim_message', {
  consumerId: 'consumer-reply-old', messageId: 'message-agent-reply-reclaimed',
});
const reclaimedReplyBatch = d1.batch;
let reassignReplyLeaseBeforeBatch = true;
d1.batch = async (statements) => {
  if (reassignReplyLeaseBeforeBatch) {
    reassignReplyLeaseBeforeBatch = false;
    database.prepare(`
      UPDATE agent_queue SET lease_token = 'lease-token-new-consumer',
        leased_by = 'consumer-reply-new', lease_expires_at = '2999-01-01T00:00:00.000Z'
      WHERE message_id = 'message-agent-reply-reclaimed'
    `).run();
  }
  return reclaimedReplyBatch(statements);
};
const reclaimedLeaseReply = await callAgentToolResult('reply_message', {
  consumerId: 'consumer-reply-old', messageId: 'message-agent-reply-reclaimed',
  leaseToken: reclaimedReplyClaim.message.leaseToken, clientRequestId: 'agent-reply-reclaimed-request-0001',
  text: 'must not be queued after another consumer wins',
});
d1.batch = reclaimedReplyBatch;
assert.equal(reclaimedLeaseReply.isError, true);
assert.equal(reclaimedLeaseReply.content[0].text, 'invalid_message_lease');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'agent-reply-reclaimed-request-0001'
`).get().total, 0);
database.prepare("DELETE FROM agent_queue WHERE message_id = 'message-agent-reply-reclaimed'").run();
database.prepare("DELETE FROM messages WHERE id = 'message-agent-reply-reclaimed'").run();
database.prepare(`
  UPDATE conversations SET trust_tier = 'untrusted', agent_policy_json = '{}' WHERE id = 'conversation-row'
`).run();

async function putInboundFile(fileId, externalId, bytes, conversationExternalId = 'conversation-file-test') {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return worker.fetch(new Request(`https://message.example.com/api/connectors/files/${fileId}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${connectorToken}`,
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-connector-id': connectorId,
      'x-conversation-id': conversationExternalId,
      'x-file-external-id': externalId,
      'x-file-name': encodeURIComponent('fixture.bin'),
      'x-content-sha256': sha256,
    },
    body: bytes,
  }), workerEnv, {});
}

const inboundBytes = new Uint8Array([1, 2, 3, 4]);
const firstInboundFile = await putInboundFile('file-upload-one', 'external-file-one', inboundBytes);
assert.equal(firstInboundFile.status, 201);
assert.equal((await firstInboundFile.json()).reused, false);
assert.equal(r2Objects.size, 1);
const repeatedInboundFile = await putInboundFile('file-upload-two', 'external-file-one', inboundBytes);
assert.equal(repeatedInboundFile.status, 200);
assert.deepEqual(await repeatedInboundFile.json(), {
  ok: true, fileId: 'file-upload-one', sizeBytes: 4,
  sha256: createHash('sha256').update(inboundBytes).digest('hex'), reused: true,
});
assert.equal(r2Objects.size, 1);
const conflictingInboundFile = await putInboundFile('file-upload-three', 'external-file-one', new Uint8Array([4, 3, 2, 1]));
assert.equal(conflictingInboundFile.status, 400);
assert.equal((await conflictingInboundFile.json()).error, 'file_external_id_conflict');
assert.equal(r2Objects.size, 1);
const compensatedInboundFile = await putInboundFile('file-upload-one', 'external-file-new', new Uint8Array([5, 6, 7, 8]));
assert.equal(compensatedInboundFile.status, 400);
assert.equal(r2Objects.size, 1);
const crossConversationInbound = await putInboundFile(
  'file-upload-cross-conversation', 'external-file-one', inboundBytes, 'conversation-file-other',
);
assert.equal(crossConversationInbound.status, 400);
assert.equal((await crossConversationInbound.json()).error, 'file_external_id_conflict');

const originalPrepare = d1.prepare;
let failInboundInsertAfterCommit = true;
const wrapAmbiguousInboundStatement = (statement, sql) => ({
  bind(...values) { return wrapAmbiguousInboundStatement(statement.bind(...values), sql); },
  async run() {
    const result = await statement.run();
    if (failInboundInsertAfterCommit && /INSERT OR IGNORE INTO attachments/.test(sql) &&
        /uploaded_inbound/.test(sql)) {
      failInboundInsertAfterCommit = false;
      throw new Error('fixture_inbound_insert_ambiguous');
    }
    return result;
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapAmbiguousInboundStatement(originalPrepare(sql), sql);
const ambiguousInboundBytes = new Uint8Array([21, 22, 23, 24]);
const ambiguousInbound = await putInboundFile(
  'file-upload-ambiguous', 'external-file-ambiguous', ambiguousInboundBytes, 'conversation-file-ambiguous',
);
d1.prepare = originalPrepare;
assert.equal(ambiguousInbound.status, 201);
const ambiguousInboundRow = database.prepare(`
  SELECT object_key FROM attachments WHERE connector_id = ? AND external_id = 'external-file-ambiguous'
`).get(connectorId);
assert.equal(r2Objects.has(ambiguousInboundRow.object_key), true);
r2Objects.delete(ambiguousInboundRow.object_key);
const repairedInbound = await putInboundFile(
  'file-upload-ambiguous-retry', 'external-file-ambiguous', ambiguousInboundBytes, 'conversation-file-ambiguous',
);
assert.equal(repairedInbound.status, 200);
assert.equal(r2Objects.has(ambiguousInboundRow.object_key), true);
const inboundObjectCount = r2Objects.size;

const fakeImage = new File([new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x70, 0x6e, 0x67])], 'fake.png', { type: 'image/png' });
const stagedForm = new FormData();
stagedForm.append('file', fakeImage);
const stagedResponse = await worker.fetch(new Request('https://message.example.com/api/files', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: stagedForm,
}), workerEnv, {});
assert.equal(stagedResponse.status, 201);
const stagedAttachment = (await stagedResponse.json()).attachment;
assert.equal(stagedAttachment.mimeType, 'application/octet-stream');
assert.equal(r2Objects.size, inboundObjectCount + 1);
const discardedResponse = await worker.fetch(new Request(
  `https://message.example.com/api/files/${stagedAttachment.id}`,
  { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } },
), workerEnv, {});
assert.equal(discardedResponse.status, 200);
assert.equal(r2Objects.size, inboundObjectCount);
assert.equal(database.prepare('SELECT COUNT(*) AS total FROM attachments WHERE id = ?').get(stagedAttachment.id).total, 0);

let failStagedInsertAfterCommit = true;
const wrapAmbiguousStagedStatement = (statement, sql) => ({
  bind(...values) { return wrapAmbiguousStagedStatement(statement.bind(...values), sql); },
  async run() {
    const result = await statement.run();
    if (failStagedInsertAfterCommit && /INSERT INTO attachments/.test(sql) && /'staged'/.test(sql)) {
      failStagedInsertAfterCommit = false;
      throw new Error('fixture_staged_insert_ambiguous');
    }
    return result;
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapAmbiguousStagedStatement(originalPrepare(sql), sql);
const ambiguousStagedForm = new FormData();
ambiguousStagedForm.append('file', new File([new Uint8Array([8, 7, 6, 5])], 'ambiguous.bin', {
  type: 'application/octet-stream',
}));
const ambiguousStagedResponse = await worker.fetch(new Request('https://message.example.com/api/files', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: ambiguousStagedForm,
}), workerEnv, {});
d1.prepare = originalPrepare;
assert.equal(ambiguousStagedResponse.status, 201);
const ambiguousStagedAttachment = (await ambiguousStagedResponse.json()).attachment;
const ambiguousStagedRow = database.prepare(`
  SELECT object_key, state FROM attachments WHERE id = ?
`).get(ambiguousStagedAttachment.id);
assert.equal(ambiguousStagedRow.state, 'staged');
assert.equal(r2Objects.has(ambiguousStagedRow.object_key), true);
const ambiguousDiscard = await worker.fetch(new Request(
  `https://message.example.com/api/files/${ambiguousStagedAttachment.id}`,
  { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } },
), workerEnv, {});
assert.equal(ambiguousDiscard.status, 200);
assert.equal(r2Objects.has(ambiguousStagedRow.object_key), false);

async function putProfile(conversationExternalId, headers = {}) {
  const avatarBody = headers.avatarBody;
  const avatarBytes = headers.avatarBytes ? new Uint8Array(headers.avatarBytes) : null;
  const body = avatarBody || avatarBytes || undefined;
  const avatarLength = Number(headers.avatarLength ?? avatarBytes?.byteLength ?? 0);
  const avatarSha256 = headers.avatarSha256 || (avatarBytes
    ? createHash('sha256').update(avatarBytes).digest('hex')
    : '');
  const waitUntilTasks = [];
  const response = await worker.fetch(new Request(`https://message.example.com/api/connectors/conversation-profiles/${conversationExternalId}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${connectorToken}`,
      'x-connector-id': connectorId,
      'x-conversation-display-name': encodeURIComponent(headers.displayName || 'Profile only'),
      ...(headers.channelLabel ? { 'x-conversation-channel-label': encodeURIComponent(headers.channelLabel) } : {}),
      ...(headers.conversationType ? { 'x-conversation-type': headers.conversationType } : {}),
      ...(headers.placement ? { 'x-conversation-placement': headers.placement } : {}),
      ...(headers.pinned !== undefined ? { 'x-conversation-pinned': headers.pinned ? '1' : '0' } : {}),
      ...(headers.unreadCount !== undefined ? { 'x-conversation-unread-count': String(headers.unreadCount) } : {}),
      ...(headers.unreadObservedAt
        ? { 'x-conversation-unread-observed-at': headers.unreadObservedAt }
        : {}),
      ...(headers.lastMessagePreview
        ? { 'x-conversation-last-preview': encodeURIComponent(headers.lastMessagePreview) }
        : {}),
      ...(headers.lastMessageAt ? { 'x-conversation-last-at': headers.lastMessageAt } : {}),
      ...(body ? { 'content-length': String(avatarLength), 'x-content-sha256': avatarSha256 } : {}),
    },
    ...(body ? { body, duplex: 'half' } : {}),
  }), workerEnv, { waitUntil: (task) => waitUntilTasks.push(task) });
  await Promise.all(waitUntilTasks);
  return response;
}

const explicitProfileResponse = await putProfile('profile-only-live', {
  displayName: 'Profile only', channelLabel: 'Channel A', conversationType: 'direct', placement: 'normal',
  pinned: true, unreadCount: 3, unreadObservedAt: '2000-01-01T00:00:00.000Z',
  lastMessagePreview: 'Native preview', lastMessageAt: stamp,
});
assert.equal(explicitProfileResponse.status, 201);
assert.deepEqual(await explicitProfileResponse.json(), {
  ok: true, connectorId, conversationExternalId: 'profile-only-live', avatar: false,
  channelLabel: 'Channel A', conversationType: 'direct', placement: 'normal', pinned: true,
});
const profileOnlyConversation = database.prepare(`
  SELECT id, title, unread_count, last_message_preview, last_message_at FROM conversations WHERE connector_id = ? AND external_id = ?
`).get(connectorId, 'profile-only-live');
assert.equal(profileOnlyConversation.title, 'Profile only');
assert.equal(profileOnlyConversation.last_message_preview, 'Native preview');
assert.equal(profileOnlyConversation.last_message_at, stamp);
assert.equal(profileOnlyConversation.unread_count, 3);
assert.equal(database.prepare('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?')
  .get(profileOnlyConversation.id).total, 0);
const outboundForm = new FormData();
outboundForm.append('file', new File([new Uint8Array([9, 8, 7, 6])], 'outbound.bin', {
  type: 'application/octet-stream',
}));
const outboundStage = await worker.fetch(new Request('https://message.example.com/api/files', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: outboundForm,
}), workerEnv, {});
assert.equal(outboundStage.status, 201);
const outboundAttachment = (await outboundStage.json()).attachment;
const directFileBlocked = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [outboundAttachment.id], clientRequestId: 'web-direct-file-block-0001' }),
}), workerEnv, {});
assert.equal(directFileBlocked.status, 403);
assert.equal((await directFileBlocked.json()).error, 'connector_file_send_not_supported');
assert.equal(database.prepare('SELECT state FROM attachments WHERE id = ?').get(outboundAttachment.id).state, 'staged');
database.prepare(`
  UPDATE conversation_profiles SET conversation_type = 'group'
  WHERE connector_id = ? AND conversation_external_id = 'profile-only-live'
`).run(connectorId);
const oversizedDeviceText = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: 'x'.repeat(501),
    attachmentIds: [], clientRequestId: 'web-device-text-too-long-0001' }),
}), workerEnv, {});
assert.equal(oversizedDeviceText.status, 400);
assert.equal((await oversizedDeviceText.json()).error, 'message_too_large');
database.prepare('UPDATE attachments SET size_bytes = ? WHERE id = ?')
  .run(10 * 1024 * 1024 + 1, outboundAttachment.id);
const oversizedDeviceFile = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [outboundAttachment.id], clientRequestId: 'web-device-file-too-large-0001' }),
}), workerEnv, {});
assert.equal(oversizedDeviceFile.status, 400);
assert.equal((await oversizedDeviceFile.json()).error, 'invalid_device_attachment_constraints');
database.prepare('UPDATE attachments SET size_bytes = 4 WHERE id = ?').run(outboundAttachment.id);
database.prepare('UPDATE attachments SET file_name = ? WHERE id = ?').run('invalid?.bin', outboundAttachment.id);
const invalidDeviceFileName = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [outboundAttachment.id], clientRequestId: 'web-device-file-invalid-name-0001' }),
}), workerEnv, {});
assert.equal(invalidDeviceFileName.status, 400);
assert.equal((await invalidDeviceFileName.json()).error, 'invalid_device_attachment_constraints');
database.prepare('UPDATE attachments SET file_name = ? WHERE id = ?').run('outbound.bin', outboundAttachment.id);
const mixedDevicePayload = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: 'caption',
    attachmentIds: [outboundAttachment.id], clientRequestId: 'web-device-mixed-payload-0001' }),
}), workerEnv, {});
assert.equal(mixedDevicePayload.status, 400);
assert.equal((await mixedDevicePayload.json()).error, 'invalid_device_mixed_payload');
const secondOutboundForm = new FormData();
secondOutboundForm.append('file', new File([new Uint8Array([1, 2])], 'outbound-second.bin', {
  type: 'application/octet-stream',
}));
const secondOutboundStage = await worker.fetch(new Request('https://message.example.com/api/files', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: secondOutboundForm,
}), workerEnv, {});
assert.equal(secondOutboundStage.status, 201);
const secondOutboundAttachment = (await secondOutboundStage.json()).attachment;
const multipleDeviceAttachments = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [outboundAttachment.id, secondOutboundAttachment.id],
    clientRequestId: 'web-device-multiple-files-0001' }),
}), workerEnv, {});
assert.equal(multipleDeviceAttachments.status, 400);
assert.equal((await multipleDeviceAttachments.json()).error, 'invalid_device_attachment_count');
assert.equal(database.prepare('SELECT state FROM attachments WHERE id = ?')
  .get(secondOutboundAttachment.id).state, 'staged');
const outboundSend = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [outboundAttachment.id], clientRequestId: 'web-claim-test-0001' }),
}), workerEnv, {});
assert.equal(outboundSend.status, 202);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id, outbound_claim_token, outbound_claimed_at
  FROM attachments WHERE id = ?
`).get(outboundAttachment.id) }, {
  state: 'queued', message_id: (await outboundSend.clone().json()).messageId,
  outbound_claim_token: null, outbound_claimed_at: null,
});

async function stageOutbound(name, bytes) {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));
  const response = await worker.fetch(new Request('https://message.example.com/api/files', {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: form,
  }), workerEnv, {});
  assert.equal(response.status, 201);
  return (await response.json()).attachment;
}

const concurrentAttachment = await stageOutbound('concurrent.bin', new Uint8Array([10, 11, 12]));
const concurrentBody = JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
  attachmentIds: [concurrentAttachment.id], clientRequestId: 'web-claim-concurrent-0001' });
const concurrentRequest = () => worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: concurrentBody,
}), workerEnv, {});
const concurrentResponses = await Promise.all([concurrentRequest(), concurrentRequest()]);
assert.deepEqual(concurrentResponses.map((response) => response.status), [202, 202]);
const concurrentResults = await Promise.all(concurrentResponses.map((response) => response.json()));
assert.equal(concurrentResults[0].messageId, concurrentResults[1].messageId);
assert.equal(concurrentResults[0].commandId, concurrentResults[1].commandId);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'web-claim-concurrent-0001'
`).get().total, 1);
assert.equal(database.prepare('SELECT state FROM attachments WHERE id = ?')
  .get(concurrentAttachment.id).state, 'queued');
const idempotencyConflict = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: 'different payload',
    attachmentIds: [], clientRequestId: 'web-claim-concurrent-0001' }),
}), workerEnv, {});
assert.equal(idempotencyConflict.status, 409);
assert.equal((await idempotencyConflict.json()).error, 'idempotency_key_conflict');

const retryAttachment = await stageOutbound('retry.bin', new Uint8Array([13, 14, 15]));
const originalBatch = d1.batch;
let failOutboundBatch = true;
d1.batch = async (statements) => {
  if (failOutboundBatch) {
    failOutboundBatch = false;
    throw new Error('fixture_outbound_batch_failure');
  }
  return originalBatch(statements);
};
const retryBody = JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
  attachmentIds: [retryAttachment.id], clientRequestId: 'web-claim-retry-0001' });
const failedOutbound = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: retryBody,
}), workerEnv, {});
assert.equal(failedOutbound.status, 400);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id, outbound_claim_token FROM attachments WHERE id = ?
`).get(retryAttachment.id) }, { state: 'staged', message_id: null, outbound_claim_token: null });
const retriedOutbound = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: retryBody,
}), workerEnv, {});
d1.batch = originalBatch;
assert.equal(retriedOutbound.status, 202);
assert.equal(database.prepare('SELECT state FROM attachments WHERE id = ?').get(retryAttachment.id).state, 'queued');

const fencedAttachment = await stageOutbound('fenced.bin', new Uint8Array([16, 17, 18]));
const fencePrepare = d1.prepare;
let reclaimBeforeClaimRefresh = true;
const wrapClaimFenceStatement = (statement, sql) => ({
  bind(...values) { return wrapClaimFenceStatement(statement.bind(...values), sql); },
  async run() {
    if (reclaimBeforeClaimRefresh && /UPDATE attachments SET outbound_claimed_at = \?/.test(sql)) {
      reclaimBeforeClaimRefresh = false;
      database.prepare(`
        UPDATE attachments SET state = 'staged', outbound_claim_token = NULL,
          outbound_request_fingerprint = NULL, outbound_claimed_at = NULL
        WHERE id = ? AND message_id IS NULL
      `).run(fencedAttachment.id);
    }
    return statement.run();
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapClaimFenceStatement(fencePrepare(sql), sql);
const fencedResponse = await worker.fetch(new Request('https://message.example.com/api/messages/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
    attachmentIds: [fencedAttachment.id], clientRequestId: 'web-claim-fenced-0001' }),
}), workerEnv, {});
d1.prepare = fencePrepare;
assert.equal(fencedResponse.status, 202);
const fencedResult = await fencedResponse.json();
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'web-claim-fenced-0001'
`).get().total, 1);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id FROM attachments WHERE id = ?
`).get(fencedAttachment.id) }, { state: 'queued', message_id: fencedResult.messageId });

const refreshFailureAttachment = await stageOutbound('refresh-failure.bin', new Uint8Array([19, 20, 21]));
const refreshFailurePrepare = d1.prepare;
let failClaimRefreshOnce = true;
const wrapClaimRefreshFailure = (statement, sql) => ({
  bind(...values) { return wrapClaimRefreshFailure(statement.bind(...values), sql); },
  async run() {
    if (failClaimRefreshOnce && /UPDATE attachments SET outbound_claimed_at = \?/.test(sql)) {
      failClaimRefreshOnce = false;
      throw new Error('fixture_claim_refresh_failure');
    }
    return statement.run();
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapClaimRefreshFailure(refreshFailurePrepare(sql), sql);
const refreshFailureResponse = await worker.fetch(new Request(
  'https://message.example.com/api/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
      attachmentIds: [refreshFailureAttachment.id], clientRequestId: 'web-claim-refresh-failure-0001' }),
  },
), workerEnv, {});
d1.prepare = refreshFailurePrepare;
assert.equal(refreshFailureResponse.status, 202);
const refreshFailureResult = await refreshFailureResponse.json();
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'web-claim-refresh-failure-0001'
`).get().total, 1);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id, outbound_claim_token FROM attachments WHERE id = ?
`).get(refreshFailureAttachment.id) }, {
  state: 'queued', message_id: refreshFailureResult.messageId, outbound_claim_token: null,
});

const ambiguousClaimAttachment = await stageOutbound('ambiguous-claim.bin', new Uint8Array([22, 23, 24]));
const ambiguousClaimPrepare = d1.prepare;
let throwAfterClaimCommit = true;
const wrapAmbiguousClaim = (statement, sql) => ({
  bind(...values) { return wrapAmbiguousClaim(statement.bind(...values), sql); },
  async run() {
    if (throwAfterClaimCommit && /UPDATE attachments SET state = 'claiming'/.test(sql)) {
      throwAfterClaimCommit = false;
      await statement.run();
      throw new Error('fixture_claim_committed_then_response_lost');
    }
    return statement.run();
  },
  async first() { return statement.first(); },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapAmbiguousClaim(ambiguousClaimPrepare(sql), sql);
const ambiguousClaimResponse = await worker.fetch(new Request(
  'https://message.example.com/api/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: profileOnlyConversation.id, body: '',
      attachmentIds: [ambiguousClaimAttachment.id], clientRequestId: 'web-claim-ambiguous-0001' }),
  },
), workerEnv, {});
d1.prepare = ambiguousClaimPrepare;
assert.equal(ambiguousClaimResponse.status, 202);
const ambiguousClaimResult = await ambiguousClaimResponse.json();
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM commands WHERE idempotency_key = 'web-claim-ambiguous-0001'
`).get().total, 1);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id, outbound_claim_token FROM attachments WHERE id = ?
`).get(ambiguousClaimAttachment.id) }, {
  state: 'queued', message_id: ambiguousClaimResult.messageId, outbound_claim_token: null,
});
database.prepare(`
  UPDATE conversation_profiles SET conversation_type = 'direct'
  WHERE connector_id = ? AND conversation_external_id = 'profile-only-live'
`).run(connectorId);
const repeatedProfileResponse = await putProfile('profile-only-live', { displayName: 'Profile renamed' });
assert.equal(repeatedProfileResponse.status, 201);
const repeatedProfile = database.prepare(`
  SELECT display_name, channel_label, conversation_type, placement, is_pinned FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = ?
`).get(connectorId, 'profile-only-live');
assert.deepEqual({ ...repeatedProfile }, {
  display_name: 'Profile renamed', channel_label: 'Channel A', conversation_type: 'direct', placement: 'normal',
  is_pinned: 1,
});
const unknownPlacementResponse = await putProfile('profile-only-live', {
  displayName: 'Profile renamed', placement: 'unknown',
});
assert.equal(unknownPlacementResponse.status, 201);
assert.equal(database.prepare(`
  SELECT placement FROM conversation_profiles WHERE connector_id = ? AND conversation_external_id = ?
`).get(connectorId, 'profile-only-live').placement, 'normal');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM conversations WHERE connector_id = ? AND external_id = ?
`).get(connectorId, 'profile-only-live').total, 1);

const oldAvatar = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const newAvatar = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
assert.equal((await putProfile('profile-avatar-race', {
  displayName: 'Avatar race', conversationType: 'direct', avatarBytes: oldAvatar,
})).status, 201);
const oldAvatarKey = database.prepare(`
  SELECT avatar_object_key FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = 'profile-avatar-race'
`).get(connectorId).avatar_object_key;
let releaseOldAvatar;
const oldAvatarReleased = new Promise((resolve) => { releaseOldAvatar = resolve; });
let oldAvatarPullStarted;
const oldAvatarPulled = new Promise((resolve) => { oldAvatarPullStarted = resolve; });
const delayedOldAvatar = new ReadableStream({
  pull(controller) {
    oldAvatarPullStarted();
    return oldAvatarReleased.then(() => {
      controller.enqueue(oldAvatar);
      controller.close();
    });
  },
});
const staleAvatarRequest = putProfile('profile-avatar-race', {
  displayName: 'Avatar race', conversationType: 'direct', avatarBody: delayedOldAvatar,
  avatarLength: oldAvatar.byteLength,
  avatarSha256: createHash('sha256').update(oldAvatar).digest('hex'),
});
await oldAvatarPulled;
assert.equal((await putProfile('profile-avatar-race', {
  displayName: 'Avatar race', conversationType: 'direct', avatarBytes: newAvatar,
})).status, 201);
const newAvatarKey = database.prepare(`
  SELECT avatar_object_key FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = 'profile-avatar-race'
`).get(connectorId).avatar_object_key;
assert.notEqual(newAvatarKey, oldAvatarKey);
releaseOldAvatar();
assert.equal((await staleAvatarRequest).status, 201);
assert.equal(database.prepare(`
  SELECT avatar_object_key FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = 'profile-avatar-race'
`).get(connectorId).avatar_object_key, newAvatarKey);
assert.equal(r2Objects.has(newAvatarKey), true);
assert.equal(r2Objects.has(oldAvatarKey), false);

const avatarBatch = d1.batch;
let failAvatarBatchAfterCommit = true;
d1.batch = async (statements) => {
  const result = await avatarBatch(statements);
  if (failAvatarBatchAfterCommit) {
    failAvatarBatchAfterCommit = false;
    throw new Error('fixture_avatar_batch_ambiguous');
  }
  return result;
};
const ambiguousAvatarResponse = await putProfile('profile-avatar-ambiguous', {
  displayName: 'Avatar ambiguous', conversationType: 'direct', avatarBytes: newAvatar,
});
d1.batch = avatarBatch;
assert.equal(ambiguousAvatarResponse.status, 201);
const ambiguousAvatarKey = database.prepare(`
  SELECT avatar_object_key FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = 'profile-avatar-ambiguous'
`).get(connectorId).avatar_object_key;
assert.equal(r2Objects.has(ambiguousAvatarKey), true);

await putProfile('profile-monotonic', {
  displayName: 'Monotonic profile', conversationType: 'direct', placement: 'normal',
  unreadCount: 7, unreadObservedAt: '2026-08-28T12:00:01.000Z',
  lastMessagePreview: 'new native summary', lastMessageAt: '2026-08-28T12:00:01.000Z',
});
await putProfile('profile-monotonic', {
  displayName: 'Monotonic profile', conversationType: 'direct', placement: 'normal',
  unreadCount: 1, unreadObservedAt: '2026-08-28T12:00:00.000Z',
  lastMessagePreview: 'stale native summary', lastMessageAt: '2026-08-28T12:00:00.000Z',
});
assert.deepEqual({ ...database.prepare(`
  SELECT native_unread_count, native_unread_observed_at,
    native_last_message_preview, native_last_message_at
  FROM conversation_profiles WHERE connector_id = ? AND conversation_external_id = 'profile-monotonic'
`).get(connectorId) }, {
  native_unread_count: 7,
  native_unread_observed_at: '2026-08-28T12:00:01.000Z',
  native_last_message_preview: 'new native summary',
  native_last_message_at: '2026-08-28T12:00:01.000Z',
});
const inboxResponse = await worker.fetch(new Request('https://message.example.com/api/inbox', {
  headers: { authorization: `Bearer ${adminToken}` },
}), workerEnv, {});
assert.equal(inboxResponse.status, 200);
const inboxBody = await inboxResponse.json();
const inboxProfile = inboxBody.conversations.find((item) => item.id === profileOnlyConversation.id);
assert.equal(inboxProfile.title, 'Profile renamed');
assert.equal(inboxProfile.connectorChannelLabel, 'Channel A');
assert.equal(inboxProfile.conversationType, 'direct');
assert.equal(inboxProfile.placement, 'normal');
assert.equal(inboxProfile.pinned, true);
const inboxConnector = inboxBody.connectors.find((item) => item.id === connectorId);
assert.deepEqual({ enabled: inboxConnector.layoutControl.enabled, revision: inboxConnector.layoutControl.revision,
  synchronized: inboxConnector.layoutControl.synchronized,
  deviceActionRevision: inboxConnector.layoutControl.deviceActionRevision,
  deviceActionEnabled: inboxConnector.layoutControl.deviceActionEnabled }, {
  enabled: true, revision: 6, synchronized: false,
  deviceActionRevision: 4, deviceActionEnabled: true,
});
assert.equal(Object.hasOwn(
  inboxBody.connectors.find((item) => item.id === nonOwnerConnectorId), 'layoutControl',
), false);
assert.equal(Object.hasOwn(
  inboxBody.connectors.find((item) => item.id === wrongModeConnectorId), 'layoutControl',
), false);
database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, last_message_preview, last_message_at, created_at, updated_at
  ) VALUES ('conversation-promotion-row', ?, 'conversation-promotion', 'Promotion', 'background', ?, ?, ?)
`).run(connectorId, stamp, stamp, stamp);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES ('message-promotion-row', 'conversation-promotion-row', ?, 'message-promotion',
    'inbound', 'Member', 'background', 'background', '{}', ?, ?)
`).run(connectorId, stamp, stamp);

async function requestEvents(messages) {
  return worker.fetch(new Request('https://message.example.com/api/connectors/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connectorToken}`,
      'content-type': 'application/json',
      'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, messages }),
  }), workerEnv, {});
}

async function postEvents(messages) {
  const response = await requestEvents(messages);
  assert.equal(response.status, 200);
  return response.json();
}

await postEvents([{
  externalId: 'message-no-watermark', conversationExternalId: 'profile-no-watermark',
  conversationTitle: 'No watermark', senderName: 'Member', body: 'must remain unread',
  occurredAt: '2026-08-28T11:59:59.000Z', conversationType: 'direct', trigger: 'direct', attachments: [],
}]);
await putProfile('profile-no-watermark', {
  displayName: 'No watermark', conversationType: 'direct', placement: 'normal', unreadCount: 0,
});
assert.equal(database.prepare(`
  SELECT unread_count FROM conversations WHERE connector_id = ? AND external_id = 'profile-no-watermark'
`).get(connectorId).unread_count, 1);
assert.equal(database.prepare(`
  SELECT native_unread_observed_at FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = 'profile-no-watermark'
`).get(connectorId).native_unread_observed_at, null);
const conflictingImmediate = await requestEvents([{
  externalId: 'message-no-watermark', conversationExternalId: 'conversation-event-conflict',
  conversationTitle: 'Conflicting event conversation', senderName: 'Member', body: 'conflicting event body',
  occurredAt: stamp, conversationType: 'direct', trigger: 'direct', attachments: [],
}]);
assert.equal(conflictingImmediate.status, 400);
assert.equal((await conflictingImmediate.json()).error, 'message_external_id_conflict');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM conversations WHERE connector_id = ? AND external_id = 'conversation-event-conflict'
`).get(connectorId).total, 0);

await putProfile('profile-observed-order', {
  displayName: 'Observed order', conversationType: 'direct', placement: 'normal',
  unreadCount: 0, unreadObservedAt: '2026-08-28T12:00:00.500Z',
  lastMessagePreview: 'snapshot', lastMessageAt: '2026-08-28T12:00:00.000Z',
});
await postEvents([
  { externalId: 'message-observed-before', conversationExternalId: 'profile-observed-order',
    conversationTitle: 'Observed order', senderName: 'Member', body: 'covered by native snapshot',
    occurredAt: '2026-08-28T12:00:00.000Z', observedAt: '2026-08-28T12:00:00.400Z',
    conversationType: 'direct', trigger: 'direct', attachments: [] },
  { externalId: 'message-observed-after', conversationExternalId: 'profile-observed-order',
    conversationTitle: 'Observed order', senderName: 'Member', body: 'after native snapshot',
    occurredAt: '2026-08-28T12:00:00.000Z', observedAt: '2026-08-28T12:00:00.600Z',
    conversationType: 'direct', trigger: 'direct', attachments: [] },
]);
assert.equal(database.prepare(`
  SELECT unread_count FROM conversations WHERE connector_id = ? AND external_id = 'profile-observed-order'
`).get(connectorId).unread_count, 1);

await putProfile('profile-observed-reserved', {
  displayName: 'Observed reserved field', conversationType: 'direct', placement: 'normal',
  unreadCount: 0, unreadObservedAt: '2026-08-28T12:00:00.500Z',
});
await postEvents([
  { externalId: 'message-observed-injected-future', conversationExternalId: 'profile-observed-reserved',
    conversationTitle: 'Observed reserved field', senderName: 'Member', body: 'before snapshot',
    occurredAt: '2026-08-28T12:00:00.400Z', metadata: { observedAt: '9999-01-01T00:00:00.000Z' },
    conversationType: 'direct', trigger: 'direct', attachments: [] },
  { externalId: 'message-observed-injected-past', conversationExternalId: 'profile-observed-reserved',
    conversationTitle: 'Observed reserved field', senderName: 'Member', body: 'after snapshot',
    occurredAt: '2026-08-28T12:00:00.600Z', metadata: { observedAt: '1970-01-01T00:00:00.000Z' },
    conversationType: 'direct', trigger: 'direct', attachments: [] },
]);
assert.equal(database.prepare(`
  SELECT unread_count FROM conversations WHERE connector_id = ? AND external_id = 'profile-observed-reserved'
`).get(connectorId).unread_count, 1);
assert.deepEqual(database.prepare(`
  SELECT json_extract(metadata_json, '$.observedAt') AS observed_at FROM messages
  WHERE connector_id = ? AND external_id IN ('message-observed-injected-future', 'message-observed-injected-past')
  ORDER BY external_id
`).all(connectorId).map((row) => row.observed_at), [null, null]);

const observedEventAt = new Date(Date.parse(stamp) + 500).toISOString();
await postEvents([{
  externalId: 'message-observed-unread', conversationExternalId: 'profile-only-live',
  conversationTitle: 'Profile renamed', senderName: 'Member', body: 'canonical event body',
  occurredAt: observedEventAt, conversationType: 'direct', trigger: 'direct', attachments: [],
}]);
await postEvents([{
  externalId: 'message-observed-unread', conversationExternalId: 'profile-only-live',
  conversationTitle: 'Tampered duplicate title', senderName: 'Member', body: 'tampered duplicate body',
  occurredAt: observedEventAt, conversationType: 'direct', trigger: 'direct', attachments: [],
}]);
assert.deepEqual({ ...database.prepare(`
  SELECT unread_count, last_message_preview FROM conversations WHERE id = ?
`).get(profileOnlyConversation.id) }, { unread_count: 4, last_message_preview: 'canonical event body' });
assert.equal(database.prepare(`
  SELECT body FROM messages WHERE connector_id = ? AND external_id = 'message-observed-unread'
`).get(connectorId).body, 'canonical event body');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM agent_queue q JOIN messages m ON m.id = q.message_id
  WHERE m.connector_id = ? AND m.external_id = 'message-observed-unread'
`).get(connectorId).total, 1);

database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, direction, sender_name, body,
    delivery_state, occurred_at, created_at
  ) VALUES ('message-command-test', ?, ?, 'outbound', 'Administrator', 'queued', 'queued', ?, ?)
`).run(profileOnlyConversation.id, connectorId, stamp, stamp);
database.prepare(`
  INSERT INTO attachments (
    id, message_id, connector_id, file_name, mime_type, size_bytes, sha256, state, created_at
  ) VALUES ('attachment-command-test', 'message-command-test', ?, 'fixture.bin',
    'application/octet-stream', 4, ?, 'queued', ?)
`).run(connectorId, '0'.repeat(64), stamp);
database.prepare(`
  INSERT INTO commands (
    id, connector_id, conversation_id, message_id, kind, payload_json, state,
    idempotency_key, lease_token, lease_expires_at, attempts, created_by, created_at
  ) VALUES ('command-lease-test', ?, ?, 'message-command-test', 'send_text', '{}', 'leased',
    'idempotency-command-lease-test', 'lease-token-test', '2999-01-01T00:00:00.000Z', 1, 'admin:token', ?)
`).run(connectorId, profileOnlyConversation.id, stamp);
database.prepare(`
  UPDATE commands SET lease_expires_at = ? WHERE id = 'command-lease-test'
`).run(new Date(Date.now() + 60_000).toISOString());
const renewalPrepare = d1.prepare;
let delayRenewalPastLease = true;
const wrapRenewalExpiry = (statement, sql) => ({
  bind(...values) { return wrapRenewalExpiry(statement.bind(...values), sql); },
  async run() { return statement.run(); },
  async first() {
    if (delayRenewalPastLease && /UPDATE commands\s+SET lease_expires_at = strftime/.test(sql)) {
      delayRenewalPastLease = false;
      database.prepare(`
        UPDATE commands SET lease_expires_at = ? WHERE id = 'command-lease-test'
      `).run(new Date(Date.now() + 25).toISOString());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return statement.first();
  },
  async all() { return statement.all(); },
});
d1.prepare = (sql) => wrapRenewalExpiry(renewalPrepare(sql), sql);
const naturallyExpiredRenewal = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/commands/command-lease-test/lease', {
    method: 'POST', headers: {
      authorization: `Bearer ${connectorToken}`, 'content-type': 'application/json', 'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, leaseToken: 'lease-token-test' }),
  },
), workerEnv, {});
d1.prepare = renewalPrepare;
assert.equal(naturallyExpiredRenewal.status, 400);
database.prepare(`
  UPDATE commands SET lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = 'command-lease-test'
`).run();
const renewedLease = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/commands/command-lease-test/lease', {
    method: 'POST', headers: {
      authorization: `Bearer ${connectorToken}`, 'content-type': 'application/json', 'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, leaseToken: 'lease-token-test' }),
  },
), workerEnv, {});
assert.equal(renewedLease.status, 200);
assert.ok(Number.isFinite(Date.parse((await renewedLease.json()).leaseExpiresAt)));
const staleCompletion = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/commands/command-lease-test/complete', {
    method: 'POST', headers: {
      authorization: `Bearer ${connectorToken}`, 'content-type': 'application/json', 'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, leaseToken: 'lease-token-stale', ok: true }),
  },
), workerEnv, {});
assert.equal(staleCompletion.status, 400);
assert.equal(database.prepare("SELECT state FROM commands WHERE id = 'command-lease-test'").get().state, 'leased');
const commandCompletionBatch = d1.batch;
let expireCommandLeaseBeforeBatch = true;
d1.batch = async (statements) => {
  if (expireCommandLeaseBeforeBatch) {
    expireCommandLeaseBeforeBatch = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    database.prepare(`
      UPDATE commands SET lease_expires_at = ? WHERE id = 'command-lease-test'
    `).run(new Date(Date.now() - 1).toISOString());
  }
  return commandCompletionBatch(statements);
};
const expiredDuringCompletion = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/commands/command-lease-test/complete', {
    method: 'POST', headers: {
      authorization: `Bearer ${connectorToken}`, 'content-type': 'application/json', 'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, leaseToken: 'lease-token-test', ok: true }),
  },
), workerEnv, {});
d1.batch = commandCompletionBatch;
assert.equal(expiredDuringCompletion.status, 400);
assert.equal(database.prepare("SELECT state FROM commands WHERE id = 'command-lease-test'").get().state, 'leased');
assert.equal(database.prepare("SELECT delivery_state FROM messages WHERE id = 'message-command-test'").get().delivery_state, 'queued');
assert.equal(database.prepare("SELECT state FROM attachments WHERE id = 'attachment-command-test'").get().state, 'queued');
database.prepare(`
  UPDATE commands SET lease_expires_at = ? WHERE id = 'command-lease-test'
`).run(new Date(Date.now() + 250).toISOString());
const completionBatchWithStatementDelay = d1.batch;
d1.batch = async (statements) => {
  const results = [await statements[0].run()];
  await new Promise((resolve) => setTimeout(resolve, 450));
  for (const statement of statements.slice(1)) results.push(await statement.run());
  return results;
};
const uncertainCompletion = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/commands/command-lease-test/complete', {
    method: 'POST', headers: {
      authorization: `Bearer ${connectorToken}`, 'content-type': 'application/json', 'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, leaseToken: 'lease-token-test', uncertain: true, error: 'verification unavailable' }),
  },
), workerEnv, {});
d1.batch = completionBatchWithStatementDelay;
assert.equal(uncertainCompletion.status, 200);
assert.equal((await uncertainCompletion.json()).state, 'manual_review');
assert.equal(database.prepare("SELECT state FROM commands WHERE id = 'command-lease-test'").get().state, 'manual_review');
assert.equal(database.prepare("SELECT delivery_state FROM messages WHERE id = 'message-command-test'").get().delivery_state, 'uncertain');
assert.equal(database.prepare("SELECT state FROM attachments WHERE id = 'attachment-command-test'").get().state, 'uncertain');

const promoted = await postEvents([{
  externalId: 'message-promotion', conversationExternalId: 'conversation-promotion',
  conversationTitle: 'Promotion', senderId: 'member-test', senderName: 'Member',
  body: 'promoted mention', occurredAt: stamp, conversationType: 'group', trigger: 'mention',
  mentioned: true, context: [], attachments: [],
}]);
assert.equal(promoted.promoted, 1);
assert.equal(database.prepare("SELECT queue_class FROM messages WHERE id = 'message-promotion-row'").get().queue_class, 'immediate');
assert.equal(database.prepare("SELECT COUNT(*) AS total FROM agent_queue WHERE message_id = 'message-promotion-row'").get().total, 1);
assert.deepEqual({ ...database.prepare(`
  SELECT state, last_seen_at, updated_at FROM connector_instances WHERE id = ?
`).get(connectorId) }, { state: 'offline', last_seen_at: authoritativeLastSeen, updated_at: authoritativeUpdatedAt });

const later = new Date(Date.parse(stamp) + 2_000).toISOString();
const earlier = new Date(Date.parse(stamp) + 1_000).toISOString();
await postEvents([
  { externalId: 'message-later', conversationExternalId: 'conversation-promotion', conversationTitle: 'Promotion',
    senderName: 'Member', body: 'latest body', occurredAt: later, conversationType: 'direct', trigger: 'direct', attachments: [] },
  { externalId: 'message-earlier', conversationExternalId: 'conversation-promotion', conversationTitle: 'Promotion',
    senderName: 'Member', body: 'older body', occurredAt: earlier, conversationType: 'direct', trigger: 'direct', attachments: [] },
]);
const summary = database.prepare(`
  SELECT last_message_preview, last_message_at FROM conversations WHERE id = 'conversation-promotion-row'
`).get();
assert.equal(summary.last_message_preview, 'latest body');
assert.equal(summary.last_message_at, later);

await postEvents([
  { externalId: 'message-offset-later', conversationExternalId: 'conversation-offset-order',
    conversationTitle: 'Offset order', senderName: 'Member', body: 'actual later',
    occurredAt: '2026-08-28T12:00:00-05:00', conversationType: 'direct', trigger: 'direct', attachments: [] },
  { externalId: 'message-z-earlier', conversationExternalId: 'conversation-offset-order',
    conversationTitle: 'Offset order', senderName: 'Member', body: 'actual earlier',
    occurredAt: '2026-08-28T16:00:00Z', conversationType: 'direct', trigger: 'direct', attachments: [] },
]);
assert.deepEqual({ ...database.prepare(`
  SELECT last_message_preview, last_message_at FROM conversations
  WHERE connector_id = ? AND external_id = 'conversation-offset-order'
`).get(connectorId) }, {
  last_message_preview: 'actual later', last_message_at: '2026-08-28T17:00:00.000Z',
});

async function requestBackups(messages) {
  return worker.fetch(new Request('https://message.example.com/api/connectors/group-text-backups', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connectorToken}`,
      'content-type': 'application/json',
      'x-connector-id': connectorId,
    },
    body: JSON.stringify({ connectorId, messages }),
  }), workerEnv, {});
}

async function postBackups(messages) {
  const response = await requestBackups(messages);
  assert.equal(response.status, 200);
  return response.json();
}

const backupMessage = {
  externalId: 'message-backup-only', conversationExternalId: 'conversation-backup-only',
  conversationTitle: 'Backup group', senderId: 'member-backup', senderName: 'Member', body: 'background text',
  occurredAt: stamp, conversationType: 'group', placement: 'folded', attachments: [],
};
const firstBackup = await postBackups([backupMessage]);
const repeatedBackup = await postBackups([backupMessage]);
assert.equal(firstBackup.inserted, 1);
assert.equal(firstBackup.normalizedInserted, 1);
assert.equal(repeatedBackup.inserted, 0);
assert.equal(repeatedBackup.normalizedInserted, 0);
database.prepare(`
  UPDATE conversations SET title = 'Stale title', avatar_label = 'S'
  WHERE connector_id = ? AND external_id = ?
`).run(connectorId, backupMessage.conversationExternalId);
await postBackups([backupMessage]);
assert.deepEqual({ ...database.prepare(`
  SELECT title, avatar_label FROM conversations WHERE connector_id = ? AND external_id = ?
`).get(connectorId, backupMessage.conversationExternalId) }, {
  title: backupMessage.conversationTitle,
  avatar_label: backupMessage.conversationTitle.slice(0, 2),
});
const conflictingBackup = await requestBackups([{
  ...backupMessage,
  conversationExternalId: 'conversation-backup-conflict',
  conversationTitle: 'Conflicting group',
  body: 'conflicting body',
}]);
assert.equal(conflictingBackup.status, 400);
assert.equal((await conflictingBackup.json()).error, 'message_external_id_conflict');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM group_text_backups WHERE connector_id = ? AND external_id = ?
`).get(connectorId, backupMessage.externalId).total, 1);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM conversations
  WHERE connector_id = ? AND external_id = 'conversation-backup-conflict'
`).get(connectorId).total, 0);
const normalizedBackup = database.prepare(`
  SELECT m.id, m.queue_class, m.body, c.title, c.external_id AS conversation_external_id
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.connector_id = ? AND m.external_id = ?
`).get(connectorId, backupMessage.externalId);
assert.equal(normalizedBackup.queue_class, 'background');
assert.equal(normalizedBackup.body, backupMessage.body);
assert.equal(normalizedBackup.title, backupMessage.conversationTitle);
assert.equal(normalizedBackup.conversation_external_id, backupMessage.conversationExternalId);
assert.equal(database.prepare('SELECT COUNT(*) AS total FROM agent_queue WHERE message_id = ?')
  .get(normalizedBackup.id).total, 0);
assert.deepEqual({ ...database.prepare(`
  SELECT state, last_seen_at, updated_at FROM connector_instances WHERE id = ?
`).get(connectorId) }, { state: 'offline', last_seen_at: authoritativeLastSeen, updated_at: authoritativeUpdatedAt });

const inferredProfileResponse = await putProfile(backupMessage.conversationExternalId, { displayName: 'Backup group profile' });
assert.equal(inferredProfileResponse.status, 201);
assert.deepEqual({ ...database.prepare(`
  SELECT channel_label, conversation_type, placement FROM conversation_profiles
  WHERE connector_id = ? AND conversation_external_id = ?
`).get(connectorId, backupMessage.conversationExternalId) }, {
  channel_label: 'Test IM', conversation_type: 'group', placement: 'folded',
});

const expiredAt = '2000-01-01T00:00:00.000Z';
const canonicalAt = '2026-01-01T00:00:00.000Z';
database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, unread_count, last_message_preview, last_message_at, created_at, updated_at
  ) VALUES ('legacy-runtime-uuid', ?, 'conversation-expired-orphan', 'Expired orphan', 1, 'expired', ?, ?, ?)
`).run(connectorId, expiredAt, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_name, body, placement, occurred_at, received_at
  ) VALUES (?, 'conversation-expired-orphan', 'Expired orphan', 'message-expired-orphan',
    'Member', 'expired', 'normal', ?, ?)
`).run(connectorId, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, occurred_at, created_at
  ) VALUES ('message-expired-orphan-row', 'legacy-runtime-uuid', ?, 'message-expired-orphan',
    'inbound', 'Member', 'expired', 'background', ?, ?)
`).run(connectorId, expiredAt, expiredAt);

database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, unread_count, last_message_preview, last_message_at, created_at, updated_at
  ) VALUES ('conversation-native-retention', ?, 'conversation-native-retention', 'Native retention', 9, 'expired', ?, ?, ?)
`).run(connectorId, expiredAt, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO conversation_profiles (
    connector_id, conversation_external_id, display_name, channel_label, conversation_type, placement,
    native_last_message_preview, native_last_message_at, native_unread_count, updated_at
  ) VALUES (?, 'conversation-native-retention', 'Native retention', 'Channel A', 'direct', 'normal',
    'native latest', ?, 2, ?)
`).run(connectorId, stamp, stamp);
database.prepare(`
  INSERT INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_name, body, placement, occurred_at, received_at
  ) VALUES (?, 'conversation-native-retention', 'Native retention', 'message-native-expired',
    'Member', 'expired', 'normal', ?, ?)
`).run(connectorId, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, occurred_at, created_at
  ) VALUES ('message-native-expired-row', 'conversation-native-retention', ?, 'message-native-expired',
    'inbound', 'Member', 'expired', 'background', ?, ?)
`).run(connectorId, expiredAt, expiredAt);

database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, unread_count, last_message_preview, last_message_at, created_at, updated_at
  ) VALUES ('conversation-canonical-retention', ?, 'conversation-canonical-retention', 'Canonical retention',
    2, 'expired newest', ?, ?, ?)
`).run(connectorId, expiredAt, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, occurred_at, created_at
  ) VALUES ('message-canonical-retained', 'conversation-canonical-retention', ?, 'message-canonical-retained',
    'inbound', 'Member', 'canonical retained', 'immediate', ?, ?)
`).run(connectorId, canonicalAt, canonicalAt);
database.prepare(`
  INSERT INTO group_text_backups (
    connector_id, conversation_external_id, conversation_title, external_id,
    sender_name, body, placement, occurred_at, received_at
  ) VALUES (?, 'conversation-canonical-retention', 'Canonical retention', 'message-canonical-expired',
    'Member', 'expired newest', 'normal', ?, ?)
`).run(connectorId, expiredAt, expiredAt);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, occurred_at, created_at
  ) VALUES ('message-canonical-expired-row', 'conversation-canonical-retention', ?, 'message-canonical-expired',
    'inbound', 'Member', 'expired newest', 'background', ?, ?)
`).run(connectorId, expiredAt, expiredAt);

database.prepare(`
  INSERT INTO conversations (
    id, connector_id, external_id, title, unread_count, created_at, updated_at
  ) VALUES ('conversation-migration-observed', ?, 'conversation-migration-observed',
    'Migration observed', 0, ?, ?)
`).run(connectorId, stamp, stamp);
database.prepare(`
  INSERT INTO conversation_profiles (
    connector_id, conversation_external_id, display_name, channel_label, conversation_type,
    placement, native_unread_count, native_unread_observed_at, updated_at
  ) VALUES (?, 'conversation-migration-observed', 'Migration observed', 'Test IM', 'direct',
    'normal', 0, '2026-08-28T12:00:00.500Z', ?)
`).run(connectorId, stamp);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES ('message-migration-observed-before', 'conversation-migration-observed', ?,
    'message-migration-observed-before', 'inbound', 'Member', 'before', 'immediate',
    '{"observedAt":"bogus"}', '2026-08-28T12:00:00.400Z', ?)
`).run(connectorId, stamp);
database.prepare(`
  INSERT INTO messages (
    id, conversation_id, connector_id, external_id, direction, sender_name, body,
    queue_class, metadata_json, occurred_at, created_at
  ) VALUES ('message-migration-observed-after', 'conversation-migration-observed', ?,
    'message-migration-observed-after', 'inbound', 'Member', 'after', 'immediate',
    '{}', '2026-08-28T12:00:00.600Z', ?)
`).run(connectorId, stamp);

database.exec(readFileSync(new URL('../migrations/0006_reconcile_backup_retention.sql', import.meta.url), 'utf8'));
assert.equal(database.prepare("SELECT count(*) AS total FROM conversations WHERE id = 'legacy-runtime-uuid'").get().total, 0);
assert.deepEqual({ ...database.prepare(`
  SELECT unread_count, last_message_preview, last_message_at FROM conversations
  WHERE id = 'conversation-native-retention'
`).get() }, { unread_count: 9, last_message_preview: 'native latest', last_message_at: stamp });
assert.deepEqual({ ...database.prepare(`
  SELECT unread_count, last_message_preview, last_message_at FROM conversations
  WHERE id = 'conversation-canonical-retention'
`).get() }, { unread_count: 1, last_message_preview: 'canonical retained', last_message_at: canonicalAt });
assert.equal(database.prepare(`
  SELECT unread_count FROM conversations WHERE id = 'conversation-migration-observed'
`).get().unread_count, 1);
assert.equal(database.prepare(`
  SELECT count(*) AS total FROM group_text_backups WHERE received_at = ?
`).get(expiredAt).total, 0);
r2Objects.set('inbound/orphan-fixture', {
  bytes: new Uint8Array([1]), options: {}, uploaded: new Date('2000-01-01T00:00:00.000Z'),
});
r2Objects.set('staging/orphan-fixture', {
  bytes: new Uint8Array([2]), options: {}, uploaded: new Date('2000-01-01T00:00:00.000Z'),
});
database.prepare(`
  INSERT INTO attachments (
    id, message_id, connector_id, external_id, conversation_external_id, object_key,
    file_name, mime_type, size_bytes, sha256, state, created_at
  ) VALUES ('attachment-unbound-expired', NULL, ?, 'external-unbound-expired',
    'conversation-unbound-expired', 'inbound/unbound-expired', 'fixture.bin',
    'application/octet-stream', 1, ?, 'uploaded_inbound', '2000-01-01T00:00:00.000Z')
`).run(connectorId, createHash('sha256').update(new Uint8Array([3])).digest('hex'));
r2Objects.set('inbound/unbound-expired', {
  bytes: new Uint8Array([3]), options: { customMetadata: {
    sha256: createHash('sha256').update(new Uint8Array([3])).digest('hex'),
  } },
  uploaded: new Date('2000-01-01T00:00:00.000Z'),
});
const scheduledWork = [];
await worker.scheduled({}, workerEnv, { waitUntil(promise) { scheduledWork.push(promise); } });
await Promise.all(scheduledWork);
assert.equal(r2Objects.has('inbound/orphan-fixture'), false);
assert.equal(r2Objects.has('staging/orphan-fixture'), false);
assert.equal(r2Objects.has('inbound/unbound-expired'), true);
const markedUnbound = database.prepare(`
  SELECT state, inbound_cleanup_marked_at FROM attachments
  WHERE id = 'attachment-unbound-expired'
`).get();
assert.equal(markedUnbound.state, 'inbound_deleting');
assert.ok(markedUnbound.inbound_cleanup_marked_at);
const cleanupBlockedEventBody = {
  connectorId,
  messages: [{
    externalId: 'message-cleanup-blocked',
    conversationExternalId: 'conversation-unbound-expired',
    conversationTitle: 'Cleanup blocked',
    senderName: 'Member',
    body: '',
    occurredAt: stamp,
    conversationType: 'direct',
    trigger: 'direct',
    attachments: [{
      externalId: 'external-unbound-expired', fileName: 'fixture.bin',
      mimeType: 'application/octet-stream', sizeBytes: 1,
      sha256: createHash('sha256').update(new Uint8Array([3])).digest('hex'),
    }],
  }],
};
const cleanupBlockedEvent = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connectorToken}`,
      'content-type': 'application/json',
      'x-connector-id': connectorId,
    },
    body: JSON.stringify(cleanupBlockedEventBody),
  },
), workerEnv, {});
assert.equal(cleanupBlockedEvent.status, 409);
assert.equal((await cleanupBlockedEvent.json()).error, 'inbound_file_cleanup_in_progress');
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM agent_queue q JOIN messages m ON m.id = q.message_id
  WHERE m.connector_id = ? AND m.external_id = 'message-cleanup-blocked'
`).get(connectorId).total, 0);
assert.deepEqual({ ...database.prepare(`
  SELECT message_id, state FROM attachments WHERE id = 'attachment-unbound-expired'
`).get() }, { message_id: null, state: 'inbound_deleting' });
database.prepare(`
  UPDATE attachments SET inbound_cleanup_marked_at = '2000-01-01T00:00:00.000Z'
  WHERE id = 'attachment-unbound-expired'
`).run();
const unboundPurgeWork = [];
await worker.scheduled({}, workerEnv, { waitUntil(promise) { unboundPurgeWork.push(promise); } });
await Promise.all(unboundPurgeWork);
assert.equal(r2Objects.has('inbound/unbound-expired'), false);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM attachments WHERE id = 'attachment-unbound-expired'
`).get().total, 0);
assert.equal((await putInboundFile(
  'attachment-unbound-expired-retry', 'external-unbound-expired', new Uint8Array([3]),
  'conversation-unbound-expired',
)).status, 201);
await postEvents(cleanupBlockedEventBody.messages);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM agent_queue q JOIN messages m ON m.id = q.message_id
  WHERE m.connector_id = ? AND m.external_id = 'message-cleanup-blocked'
`).get(connectorId).total, 1);
assert.deepEqual({ ...database.prepare(`
  SELECT state, message_id IS NOT NULL AS linked FROM attachments
  WHERE connector_id = ? AND external_id = 'external-unbound-expired'
`).get(connectorId) }, { state: 'received', linked: 1 });

paginatedInboundSweep = true;
const firstCursorSweep = [];
await worker.scheduled({}, workerEnv, { waitUntil(promise) { firstCursorSweep.push(promise); } });
await Promise.all(firstCursorSweep);
assert.equal(database.prepare(`
  SELECT value FROM maintenance_state WHERE key = 'r2-sweep:inbound/'
`).get().value, '20');
assert.equal(deletedR2Keys.includes('inbound/virtual-page-20'), false);
const secondCursorSweep = [];
await worker.scheduled({}, workerEnv, { waitUntil(promise) { secondCursorSweep.push(promise); } });
await Promise.all(secondCursorSweep);
paginatedInboundSweep = false;
assert.equal(deletedR2Keys.includes('inbound/virtual-page-20'), true);
assert.equal(database.prepare(`
  SELECT COUNT(*) AS total FROM maintenance_state WHERE key = 'r2-sweep:inbound/'
`).get().total, 0);
database.close();
console.log('schema multi-instance tests passed');
