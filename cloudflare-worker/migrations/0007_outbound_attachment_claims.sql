ALTER TABLE attachments
  ADD COLUMN outbound_claim_token TEXT;

ALTER TABLE attachments
  ADD COLUMN outbound_request_fingerprint TEXT;

ALTER TABLE attachments
  ADD COLUMN outbound_claimed_at TEXT;

ALTER TABLE attachments
  ADD COLUMN inbound_cleanup_marked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_attachments_outbound_claim
  ON attachments(state, outbound_claimed_at)
  WHERE message_id IS NULL;
