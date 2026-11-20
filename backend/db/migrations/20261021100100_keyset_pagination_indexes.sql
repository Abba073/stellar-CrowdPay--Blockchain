-- Indexes backing keyset (cursor) pagination: each matches the ORDER BY
-- (sort value DESC, id DESC) of a hot list, so a page is an index range
-- scan instead of scanning and discarding OFFSET rows.

-- GET /api/campaigns?sort=newest (public listing: active, not deleted).
CREATE INDEX IF NOT EXISTS idx_campaigns_listing_newest
  ON campaigns (status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- GET /api/campaigns?sort=most_funded
CREATE INDEX IF NOT EXISTS idx_campaigns_listing_most_funded
  ON campaigns (status, raised_amount DESC, id DESC)
  WHERE deleted_at IS NULL;

-- GET /api/contributions/campaign/:campaignId (backer wall).
CREATE INDEX IF NOT EXISTS idx_contributions_campaign_created_id
  ON contributions (campaign_id, created_at DESC, id DESC);
