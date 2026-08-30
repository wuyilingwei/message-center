ALTER TABLE conversation_profiles
  ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1));

ALTER TABLE conversation_profiles
  ADD COLUMN native_last_message_preview TEXT;

ALTER TABLE conversation_profiles
  ADD COLUMN native_last_message_at TEXT;

ALTER TABLE conversation_profiles
  ADD COLUMN native_unread_count INTEGER CHECK(native_unread_count IS NULL OR native_unread_count >= 0);

ALTER TABLE conversation_profiles
  ADD COLUMN native_unread_observed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_conversation_profiles_native_order
  ON conversation_profiles(connector_id, is_pinned, placement);
