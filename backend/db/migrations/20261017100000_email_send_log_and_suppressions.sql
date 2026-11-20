-- Per-recipient send log (for cooldowns) and provider bounce/complaint suppressions.
CREATE TABLE IF NOT EXISTS email_send_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  email_type  TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_send_log_recipient_type_idx
  ON email_send_log (LOWER(email), email_type, sent_at DESC);

CREATE TABLE IF NOT EXISTS email_suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
