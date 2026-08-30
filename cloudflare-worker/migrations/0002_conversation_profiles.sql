ALTER TABLE connector_instances ADD COLUMN channel_label TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN queue_class TEXT NOT NULL DEFAULT 'immediate';
CREATE INDEX IF NOT EXISTS idx_messages_queue_class ON messages(queue_class, occurred_at);

CREATE TABLE IF NOT EXISTS conversation_profiles (
  connector_id TEXT NOT NULL,
  conversation_external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
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

INSERT OR IGNORE INTO conversations (
  id, connector_id, external_id, title, avatar_label, trust_tier, agent_policy_json,
  unread_count, last_message_preview, last_message_at, created_at, updated_at
)
SELECT
  'backup-conv:' || b.connector_id || ':' || b.conversation_external_id,
  b.connector_id, b.conversation_external_id, MAX(b.conversation_title),
  SUBSTR(MAX(b.conversation_title), 1, 2), 'untrusted', '{}', COUNT(*),
  SUBSTR(MAX(CASE WHEN b.occurred_at = latest.last_at THEN b.body ELSE '' END), 1, 500),
  latest.last_at, MIN(b.received_at), MAX(b.received_at)
FROM group_text_backups b
JOIN (
  SELECT connector_id, conversation_external_id, MAX(occurred_at) AS last_at
  FROM group_text_backups GROUP BY connector_id, conversation_external_id
) latest ON latest.connector_id = b.connector_id
  AND latest.conversation_external_id = b.conversation_external_id
GROUP BY b.connector_id, b.conversation_external_id;

INSERT OR IGNORE INTO messages (
  id, conversation_id, connector_id, external_id, direction, sender_id, sender_name,
  body, content_type, delivery_state, queue_class, metadata_json, occurred_at, created_by, created_at
)
SELECT
  'backup-msg:' || b.connector_id || ':' || b.external_id,
  c.id, b.connector_id, b.external_id, 'inbound', b.sender_id, b.sender_name,
  b.body, 'text', 'received', 'background',
  json_object('conversationType', 'group', 'trigger', 'background', 'mentioned', 0,
    'placement', b.placement, 'context', json('[]')),
  b.occurred_at, NULL, b.received_at
FROM group_text_backups b
JOIN conversations c ON c.connector_id = b.connector_id
  AND c.external_id = b.conversation_external_id;
