-- Issue #20: Bind campaign invites to invited email and add expiry support.
-- Add invite_expires_at column so that tokens can expire after a configurable TTL.
ALTER TABLE campaign_members
  ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;

-- Backfill: expire all existing pending (not yet accepted) invites 7 days from now
-- so that previously issued tokens are not open forever.
UPDATE campaign_members
   SET invite_expires_at = NOW() + INTERVAL '7 days'
 WHERE accepted_at IS NULL
   AND invite_token IS NOT NULL
   AND invite_expires_at IS NULL;
