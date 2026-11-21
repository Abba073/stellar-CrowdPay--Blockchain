-- 20260628_anchor_deposit_active_claim_unique.sql
--
-- Adds a partial unique index on anchor_deposits to prevent a user from
-- having more than one in-flight (active) deposit claim for the same
-- campaign. This makes double-claims impossible at the storage layer,
-- acting as the last line of defense in addition to application checks.
--
-- Active statuses represent a claim that is still being processed and has
-- not yet reached a terminal state (completed / failed / cancelled / etc.).
-- Terminal rows are excluded from the index so historical claims do not
-- block new ones.

CREATE UNIQUE INDEX IF NOT EXISTS anchor_deposits_active_claim_unique
    ON anchor_deposits (user_id, campaign_id)
    WHERE status IN (
        'pending_anchor',
        'pending_user_transfer_start',
        'processing',
        'submitting'
    );