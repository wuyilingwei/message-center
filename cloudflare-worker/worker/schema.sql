CREATE TABLE IF NOT EXISTS connector_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  channel_label TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'not_configured',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  configuration_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_instances_kind ON connector_instances(kind);
CREATE INDEX IF NOT EXISTS idx_connector_instances_state ON connector_instances(state);

CREATE TABLE IF NOT EXISTS connector_layout_control (
  connector_id TEXT PRIMARY KEY,
  desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK(desired_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  desired_reason TEXT NOT NULL DEFAULT 'not_configured',
  desired_updated_at TEXT NOT NULL,
  reported_enabled INTEGER CHECK(reported_enabled IS NULL OR reported_enabled IN (0, 1)),
  reported_revision INTEGER CHECK(reported_revision IS NULL OR reported_revision >= 0),
  reported_reason TEXT,
  reported_at TEXT,
  device_generation INTEGER CHECK(device_generation IS NULL OR device_generation >= 0),
  device_action_id TEXT,
  device_action_revision INTEGER CHECK(device_action_revision IS NULL OR device_action_revision >= 0),
  device_action_enabled INTEGER CHECK(device_action_enabled IS NULL OR device_action_enabled IN (0, 1)),
  CHECK(
    (device_generation IS NULL AND device_action_id IS NULL AND
      device_action_revision IS NULL AND device_action_enabled IS NULL) OR
    (device_generation IS NOT NULL AND device_action_id IS NOT NULL AND
      device_action_revision IS NOT NULL AND device_action_enabled IS NOT NULL)
  ),
  CHECK(device_action_revision IS NULL OR device_action_revision <= revision),
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  avatar_label TEXT NOT NULL DEFAULT '?',
  trust_tier TEXT NOT NULL DEFAULT 'untrusted',
  agent_policy_json TEXT NOT NULL DEFAULT '{}',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external ON conversations(connector_id, external_id);
CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  external_id TEXT,
  direction TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'text',
  delivery_state TEXT NOT NULL DEFAULT 'received',
  queue_class TEXT NOT NULL DEFAULT 'immediate',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON messages(connector_id, external_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_messages_queue_class ON messages(queue_class, occurred_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  connector_id TEXT,
  external_id TEXT,
  conversation_external_id TEXT,
  owner_user_id TEXT,
  object_key TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staged',
  outbound_claim_token TEXT,
  outbound_request_fingerprint TEXT,
  outbound_claimed_at TEXT,
  inbound_cleanup_marked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_object_key ON attachments(object_key) WHERE object_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_external ON attachments(connector_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_outbound_claim
  ON attachments(state, outbound_claimed_at)
  WHERE message_id IS NULL;

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_idempotency ON commands(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_commands_connector_queue ON commands(connector_id, state, created_at);

CREATE TABLE IF NOT EXISTS agent_queue (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_token TEXT,
  lease_expires_at TEXT,
  leased_by TEXT,
  completed_at TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_queue_state ON agent_queue(state, created_at);

CREATE TABLE IF NOT EXISTS group_text_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  conversation_external_id TEXT NOT NULL,
  conversation_title TEXT NOT NULL,
  external_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  placement TEXT NOT NULL DEFAULT 'unknown',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_text_backups_external
  ON group_text_backups(connector_id, external_id);
CREATE INDEX IF NOT EXISTS idx_group_text_backups_conversation_time
  ON group_text_backups(connector_id, conversation_external_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_group_text_backups_received
  ON group_text_backups(received_at);

CREATE TABLE IF NOT EXISTS conversation_profiles (
  connector_id TEXT NOT NULL,
  conversation_external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  channel_label TEXT NOT NULL DEFAULT '',
  conversation_type TEXT NOT NULL DEFAULT 'unknown',
  placement TEXT NOT NULL DEFAULT 'unknown',
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
  native_last_message_preview TEXT,
  native_last_message_at TEXT,
  native_unread_count INTEGER CHECK(native_unread_count IS NULL OR native_unread_count >= 0),
  native_unread_observed_at TEXT,
  avatar_object_key TEXT,
  avatar_mime_type TEXT,
  avatar_size_bytes INTEGER,
  avatar_sha256 TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, conversation_external_id),
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_profiles_updated
  ON conversation_profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversation_profiles_native_order
  ON conversation_profiles(connector_id, is_pinned, placement);

CREATE TABLE IF NOT EXISTS maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(occurred_at);
PRAGMA optimize;
