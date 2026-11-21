-- Incremental balance reconciliation: each run only re-checks campaigns that
-- changed since they were last reconciled (or are due a periodic full sweep),
-- instead of every active/funded campaign.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_campaigns_reconcile_queue
  ON campaigns (last_reconciled_at ASC NULLS FIRST)
  WHERE status IN ('active', 'funded') AND deleted_at IS NULL;
