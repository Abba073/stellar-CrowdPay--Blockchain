-- 20260925: Restore 'suspended' in the campaigns status CHECK constraint.
--
-- 20260602_campaign_refund_mechanism.sql recreated campaigns_status_check
-- (adding 'refunded') but dropped 'suspended', so the admin suspension
-- endpoint (admin.js PATCH /campaigns/:id/suspend) fails on every call
-- with a CHECK constraint violation.
--
-- This migration also audits and backfills every other status CHECK
-- constraint against the status constants in backend/utils/constants.js
-- so that INSERTs with valid domain values never fail at runtime when a
-- feature is first used. Each constraint is dropped and recreated with
-- the full list of allowed values.

-- ---------------------------------------------------------------------------
-- campaigns.status
-- Values (constants.js CAMPAIGN_STATUS): active, funded, in_progress,
-- completed, closed, withdrawn, failed, suspended, refunded
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('active', 'funded', 'in_progress', 'completed', 'closed', 'withdrawn', 'failed', 'suspended', 'refunded'));

-- ---------------------------------------------------------------------------
-- withdrawal_requests.status
-- Values (constants.js WITHDRAWAL_STATUS): pending, processing, completed,
-- failed, cancelled
-- ---------------------------------------------------------------------------
ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

-- ---------------------------------------------------------------------------
-- disputes.status
-- Values (constants.js DISPUTE_STATUS): open, under_review, resolved,
-- rejected, cancelled
-- ---------------------------------------------------------------------------
ALTER TABLE disputes
  DROP CONSTRAINT IF EXISTS disputes_status_check;

ALTER TABLE disputes
  ADD CONSTRAINT disputes_status_check
    CHECK (status IN ('open', 'under_review', 'resolved', 'rejected', 'cancelled'));

-- ---------------------------------------------------------------------------
-- stellar_transactions.status
-- Values (constants.js STELLAR_TX_STATUS): pending, submitted, success,
-- failed, not_found
-- ---------------------------------------------------------------------------
ALTER TABLE stellar_transactions
  DROP CONSTRAINT IF EXISTS stellar_transactions_status_check;

ALTER TABLE stellar_transactions
  ADD CONSTRAINT stellar_transactions_status_check
    CHECK (status IN ('pending', 'submitted', 'success', 'failed', 'not_found'));

-- ---------------------------------------------------------------------------
-- milestones.status
-- Values (constants.js MILESTONE_STATUS): pending, in_progress, submitted,
-- approved, rejected, paid
-- ---------------------------------------------------------------------------
ALTER TABLE milestones
  DROP CONSTRAINT IF EXISTS milestones_status_check;

ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_check
    CHECK (status IN ('pending', 'in_progress', 'submitted', 'approved', 'rejected', 'paid'));

-- ---------------------------------------------------------------------------
-- anchor_deposits.status
-- Values (constants.js ANCHOR_DEPOSIT_STATUS): pending, processing,
-- completed, failed, refunded
-- ---------------------------------------------------------------------------
ALTER TABLE anchor_deposits
  DROP CONSTRAINT IF EXISTS anchor_deposits_status_check;

ALTER TABLE anchor_deposits
  ADD CONSTRAINT anchor_deposits_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded'));

-- ---------------------------------------------------------------------------
-- webhook_deliveries.status
-- Values (constants.js WEBHOOK_DELIVERY_STATUS): pending, delivered,
-- failed, retrying, exhausted
-- ---------------------------------------------------------------------------
ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'retrying', 'exhausted'));