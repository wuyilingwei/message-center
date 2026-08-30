INSERT OR IGNORE INTO conversations (
  id, connector_id, external_id, title, avatar_label, trust_tier, agent_policy_json,
  unread_count, last_message_preview, last_message_at, created_at, updated_at
)
SELECT
  'backup-conv-' || lower(hex(randomblob(16))),
  b.connector_id,
  b.conversation_external_id,
  b.conversation_title,
  substr(b.conversation_title, 1, 2),
  'untrusted',
  '{}',
  0,
  '',
  NULL,
  min(b.received_at),
  max(b.received_at)
FROM group_text_backups b
GROUP BY b.connector_id, b.conversation_external_id;

INSERT OR IGNORE INTO messages (
  id, conversation_id, connector_id, external_id, direction, sender_id, sender_name, body,
  content_type, delivery_state, queue_class, metadata_json, occurred_at, created_by, created_at
)
SELECT
  'backup-msg-' || lower(hex(randomblob(16))),
  c.id,
  b.connector_id,
  b.external_id,
  'inbound',
  b.sender_id,
  b.sender_name,
  b.body,
  'text',
  'received',
  'background',
  json_object(
    'conversationType', 'group',
    'trigger', 'background',
    'mentioned', json('false'),
    'placement', b.placement,
    'context', json('[]')
  ),
  b.occurred_at,
  NULL,
  b.received_at
FROM group_text_backups b
JOIN conversations c
  ON c.connector_id = b.connector_id
 AND c.external_id = b.conversation_external_id;

UPDATE conversations
SET
  title = COALESCE((
    SELECT b.conversation_title
    FROM group_text_backups b
    WHERE b.connector_id = conversations.connector_id
      AND b.conversation_external_id = conversations.external_id
      AND EXISTS (SELECT 1 FROM messages m
        WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
          AND m.conversation_id = conversations.id)
    ORDER BY b.occurred_at DESC, b.id DESC
    LIMIT 1
  ), title),
  avatar_label = COALESCE((
    SELECT substr(b.conversation_title, 1, 2)
    FROM group_text_backups b
    WHERE b.connector_id = conversations.connector_id
      AND b.conversation_external_id = conversations.external_id
      AND EXISTS (SELECT 1 FROM messages m
        WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
          AND m.conversation_id = conversations.id)
    ORDER BY b.occurred_at DESC, b.id DESC
    LIMIT 1
  ), avatar_label),
  last_message_preview = COALESCE((
    SELECT substr(b.body, 1, 500)
    FROM group_text_backups b
    WHERE b.connector_id = conversations.connector_id
      AND b.conversation_external_id = conversations.external_id
      AND EXISTS (SELECT 1 FROM messages m
        WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
          AND m.conversation_id = conversations.id)
    ORDER BY b.occurred_at DESC, b.id DESC
    LIMIT 1
  ), last_message_preview),
  last_message_at = COALESCE((
    SELECT max(b.occurred_at)
    FROM group_text_backups b
    WHERE b.connector_id = conversations.connector_id
      AND b.conversation_external_id = conversations.external_id
      AND EXISTS (SELECT 1 FROM messages m
        WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
          AND m.conversation_id = conversations.id)
  ), last_message_at),
  updated_at = COALESCE((
    SELECT max(b.received_at)
    FROM group_text_backups b
    WHERE b.connector_id = conversations.connector_id
      AND b.conversation_external_id = conversations.external_id
      AND EXISTS (SELECT 1 FROM messages m
        WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
          AND m.conversation_id = conversations.id)
  ), updated_at)
WHERE EXISTS (
  SELECT 1
  FROM group_text_backups b
  WHERE b.connector_id = conversations.connector_id
    AND b.conversation_external_id = conversations.external_id
    AND EXISTS (SELECT 1 FROM messages m
      WHERE m.connector_id = b.connector_id AND m.external_id = b.external_id
        AND m.conversation_id = conversations.id)
    AND (conversations.last_message_at IS NULL OR b.occurred_at > conversations.last_message_at)
);
