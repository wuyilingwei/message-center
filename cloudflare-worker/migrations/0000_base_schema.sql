-- Historical pre-migration schema. Keeping this baseline as migration 0000 makes
-- a brand-new D1 database reproducible while remaining a no-op for databases
-- that were originally bootstrapped from worker/schema.sql.
CREATE TABLE IF NOT EXISTS connector_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON messages(connector_id, external_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, occurred_at);

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
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_object_key
  ON attachments(object_key) WHERE object_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_external
  ON attachments(connector_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(occurred_at);
