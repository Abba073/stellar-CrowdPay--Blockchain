-- Add soft delete support for campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS campaigns_deleted_at_idx ON campaigns (deleted_at) WHERE deleted_at IS NULL;
