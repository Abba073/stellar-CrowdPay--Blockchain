ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS featured        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS featured_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS featured_note   TEXT;

CREATE INDEX IF NOT EXISTS campaigns_featured_idx ON campaigns (featured) WHERE featured = TRUE;
