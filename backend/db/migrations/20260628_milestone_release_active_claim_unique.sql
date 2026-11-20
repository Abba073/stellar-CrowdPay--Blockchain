-- Migration: 20260628_milestone_release_active_claim_unique.sql
-- Purpose: Enforce at most one active milestone release claim per milestone
-- at the storage layer, so the database is the last line of defense against
-- duplicate release claims (see issue #284).
--
-- The application-level guards in milestones.js can be bypassed by missed
-- checks or unlocked SELECTs. This partial unique index guarantees that a
-- milestone can only be marked as release-claimed once.

CREATE UNIQUE INDEX IF NOT EXISTS milestones_active_release_claim_unique
    ON milestones (campaign_id, id)
    WHERE release_claimed_at IS NOT NULL;