-- Migration: 20260628_notification_dedup_and_preferences.sql
-- Adds read-state dedup support to notifications and a server-side
-- notification_preferences table governing per-type email/push delivery.

BEGIN;

-- (a) Dedup support on notifications -----------------------------------------
-- Nullable dedup key so legacy rows (and notifications that are not
-- deduplicated) do not collide. Uniqueness is enforced per user only when a
-- key is present, via a partial unique index.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_id_dedup_key_key
  ON notifications (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- (b) Server-side notification preferences -----------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Email channel flags (per notification type)
  email_contributions BOOLEAN NOT NULL DEFAULT TRUE,
  email_disputes BOOLEAN NOT NULL DEFAULT TRUE,
  email_milestones BOOLEAN NOT NULL DEFAULT TRUE,
  email_campaign_updates BOOLEAN NOT NULL DEFAULT TRUE,

  -- Push channel flags (per notification type)
  push_contributions BOOLEAN NOT NULL DEFAULT TRUE,
  push_disputes BOOLEAN NOT NULL DEFAULT TRUE,
  push_milestones BOOLEAN NOT NULL DEFAULT TRUE,
  push_campaign_updates BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep updated_at fresh on row updates.
CREATE OR REPLACE FUNCTION set_notification_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notification_preferences_updated_at
  ON notification_preferences;

CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION set_notification_preferences_updated_at();

COMMIT;