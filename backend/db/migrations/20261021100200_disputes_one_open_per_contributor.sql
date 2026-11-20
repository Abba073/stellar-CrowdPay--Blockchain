-- disputes_one_active_per_contributor was declared as a plain
-- UNIQUE (campaign_id, raised_by), so a contributor could never raise a
-- second dispute on a campaign, even after the first was resolved, while
-- its comment intended "one open/under_review dispute per contributor per
-- campaign". Replace it with the partial unique index that says exactly that.
-- (Existing data satisfies the stricter constraint, so it satisfies this one.)
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_one_active_per_contributor;

CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open_per_contributor
  ON disputes (campaign_id, raised_by)
  WHERE status IN ('open', 'under_review');

-- Supports the per-user lookups used when raising a dispute.
CREATE INDEX IF NOT EXISTS disputes_raised_by_created_idx
  ON disputes (raised_by, created_at DESC);
