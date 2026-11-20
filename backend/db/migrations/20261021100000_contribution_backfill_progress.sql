-- Resumable cursor for the contribution backfill: the (created_at, tx_hash)
-- of the last stellar_transactions row in the last committed chunk.
CREATE TABLE IF NOT EXISTS contribution_backfill_progress (
  job             TEXT PRIMARY KEY,
  last_created_at TIMESTAMPTZ NOT NULL,
  last_tx_hash    TEXT NOT NULL,
  processed       BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keyset scan used by the backfill.
CREATE INDEX IF NOT EXISTS idx_stellar_transactions_contribution_backfill
  ON stellar_transactions (created_at, tx_hash)
  WHERE kind = 'contribution' AND tx_hash IS NOT NULL;
