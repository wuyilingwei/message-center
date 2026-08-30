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
