-- Campaign team membership (owner / manager / viewer) with token-based invites.
CREATE TABLE IF NOT EXISTS campaign_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  invite_token  TEXT UNIQUE,
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_members_campaign_user_uidx
  ON campaign_members (campaign_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_members_campaign_email_uidx
  ON campaign_members (campaign_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_members_user_idx ON campaign_members (user_id);

-- Backfill an accepted owner row for every existing campaign creator.
INSERT INTO campaign_members (campaign_id, user_id, email, role, accepted_at)
SELECT c.id, c.creator_id, u.email, 'owner', NOW()
FROM campaigns c
JOIN users u ON u.id = c.creator_id
ON CONFLICT DO NOTHING;
