ALTER TABLE conversation_profiles ADD COLUMN channel_label TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_profiles ADD COLUMN conversation_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE conversation_profiles ADD COLUMN placement TEXT NOT NULL DEFAULT 'unknown';

UPDATE conversation_profiles
SET channel_label = COALESCE((
  SELECT NULLIF(k.channel_label, '') FROM connector_instances k
  WHERE k.id = conversation_profiles.connector_id
), (
  SELECT k.kind FROM connector_instances k
  WHERE k.id = conversation_profiles.connector_id
), '');

UPDATE conversation_profiles
SET conversation_type = COALESCE((
  SELECT CASE WHEN json_valid(m.metadata_json)
    THEN json_extract(m.metadata_json, '$.conversationType') END
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.connector_id = conversation_profiles.connector_id
    AND c.external_id = conversation_profiles.conversation_external_id
    AND CASE WHEN json_valid(m.metadata_json)
      THEN json_extract(m.metadata_json, '$.conversationType') END IN ('direct', 'group')
  ORDER BY m.occurred_at DESC, m.created_at DESC
  LIMIT 1
), CASE WHEN EXISTS (
  SELECT 1 FROM group_text_backups b
  WHERE b.connector_id = conversation_profiles.connector_id
    AND b.conversation_external_id = conversation_profiles.conversation_external_id
) THEN 'group' ELSE 'unknown' END);

UPDATE conversation_profiles
SET placement = COALESCE((
  SELECT CASE WHEN json_valid(m.metadata_json)
    THEN json_extract(m.metadata_json, '$.placement') END
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.connector_id = conversation_profiles.connector_id
    AND c.external_id = conversation_profiles.conversation_external_id
    AND CASE WHEN json_valid(m.metadata_json)
      THEN json_extract(m.metadata_json, '$.placement') END IN ('normal', 'folded', 'message_box')
  ORDER BY m.occurred_at DESC, m.created_at DESC
  LIMIT 1
), (
  SELECT b.placement FROM group_text_backups b
  WHERE b.connector_id = conversation_profiles.connector_id
    AND b.conversation_external_id = conversation_profiles.conversation_external_id
    AND b.placement IN ('normal', 'folded', 'message_box')
  ORDER BY b.occurred_at DESC
  LIMIT 1
), 'unknown');

INSERT OR IGNORE INTO conversations (
  id, connector_id, external_id, title, avatar_label, trust_tier, agent_policy_json,
  unread_count, last_message_preview, last_message_at, created_at, updated_at
)
SELECT
  'profile-conv-' || lower(hex(randomblob(16))),
  p.connector_id,
  p.conversation_external_id,
  p.display_name,
  substr(p.display_name, 1, 2),
  'untrusted',
  '{}',
  0,
  '',
  NULL,
  p.updated_at,
  p.updated_at
FROM conversation_profiles p;
