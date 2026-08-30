DELETE FROM messages
WHERE queue_class = 'background'
  AND EXISTS (
    SELECT 1 FROM group_text_backups b
    WHERE b.connector_id = messages.connector_id
      AND b.external_id = messages.external_id
      AND b.received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  )
  AND NOT EXISTS (SELECT 1 FROM agent_queue q WHERE q.message_id = messages.id);

-- Keep the source backup rows until legacy UUID-shaped backup-only conversations
-- have been identified and removed.
DELETE FROM conversations
WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)
  AND NOT EXISTS (
    SELECT 1 FROM conversation_profiles p
    WHERE p.connector_id = conversations.connector_id
      AND p.conversation_external_id = conversations.external_id
  )
  AND EXISTS (
    SELECT 1 FROM group_text_backups expired
    WHERE expired.connector_id = conversations.connector_id
      AND expired.conversation_external_id = conversations.external_id
      AND expired.received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  )
  AND NOT EXISTS (
    SELECT 1 FROM group_text_backups retained
    WHERE retained.connector_id = conversations.connector_id
      AND retained.conversation_external_id = conversations.external_id
      AND retained.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  );

DELETE FROM group_text_backups
WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days');

-- Native client summaries win when they are at least as recent as the latest
-- normalized message. This keeps media/card previews and native unread state intact.
UPDATE conversations AS c SET
  last_message_preview = CASE
    WHEN (SELECT p.native_last_message_at FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id) IS NOT NULL
      AND COALESCE((SELECT p.native_last_message_at FROM conversation_profiles p
        WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id), '')
        >= COALESCE((SELECT m.occurred_at FROM messages m WHERE m.conversation_id = c.id
          ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 1), '')
    THEN COALESCE((SELECT p.native_last_message_preview FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id), '')
    ELSE COALESCE(substr((SELECT m.body FROM messages m WHERE m.conversation_id = c.id
      ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 1), 1, 500), '')
  END,
  last_message_at = CASE
    WHEN (SELECT p.native_last_message_at FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id) IS NOT NULL
      AND COALESCE((SELECT p.native_last_message_at FROM conversation_profiles p
        WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id), '')
        >= COALESCE((SELECT m.occurred_at FROM messages m WHERE m.conversation_id = c.id
          ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 1), '')
    THEN (SELECT p.native_last_message_at FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id)
    ELSE (SELECT m.occurred_at FROM messages m WHERE m.conversation_id = c.id
      ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 1)
  END,
  unread_count = CASE
    WHEN (SELECT p.native_unread_count FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id) IS NOT NULL
      AND (SELECT p.native_unread_observed_at FROM conversation_profiles p
        WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id) IS NOT NULL
    THEN (SELECT p.native_unread_count FROM conversation_profiles p
        WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id)
      + (SELECT count(*) FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.queue_class = 'immediate'
          AND (CASE WHEN json_valid(m.metadata_json)
              AND json_type(m.metadata_json, '$.observedAt') = 'text'
              AND datetime(json_extract(m.metadata_json, '$.observedAt')) IS NOT NULL
            THEN json_extract(m.metadata_json, '$.observedAt')
            ELSE m.occurred_at END) > (SELECT p.native_unread_observed_at FROM conversation_profiles p
            WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id))
    WHEN (SELECT p.native_unread_count FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id) IS NOT NULL
    THEN max(c.unread_count, (SELECT p.native_unread_count FROM conversation_profiles p
      WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id))
    ELSE (SELECT count(*) FROM messages m
      WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.queue_class = 'immediate')
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
  OR EXISTS (SELECT 1 FROM conversation_profiles p
    WHERE p.connector_id = c.connector_id AND p.conversation_external_id = c.external_id);

DELETE FROM conversations
WHERE (id LIKE 'backup-conv-%' OR id LIKE 'backup-conv:%')
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)
  AND NOT EXISTS (
    SELECT 1 FROM conversation_profiles p
    WHERE p.connector_id = conversations.connector_id
      AND p.conversation_external_id = conversations.external_id
  );
