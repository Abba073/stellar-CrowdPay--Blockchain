CREATE TABLE IF NOT EXISTS contribution_backfill_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash     TEXT NOT NULL UNIQUE,
  action      TEXT NOT NULL CHECK (action IN ('restored', 'existing', 'skipped')),
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contribution_backfill_audit_action_idx
  ON contribution_backfill_audit (action);