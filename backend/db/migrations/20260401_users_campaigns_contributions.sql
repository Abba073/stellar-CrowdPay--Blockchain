CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  name                    TEXT NOT NULL,
  wallet_public_key       TEXT UNIQUE NOT NULL,
  wallet_secret_encrypted TEXT NOT NULL,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          UUID NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT,
  target_amount       NUMERIC(20, 7) NOT NULL,
  raised_amount       NUMERIC(20, 7) NOT NULL DEFAULT 0,
  asset_type          TEXT NOT NULL CHECK (asset_type IN ('XLM', 'USDC')),
  wallet_public_key   TEXT UNIQUE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'funded', 'closed', 'withdrawn')),
  deadline            DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id),
  sender_public_key   TEXT NOT NULL,
  amount              NUMERIC(20, 7) NOT NULL,
  asset               TEXT NOT NULL,
  payment_type        TEXT NOT NULL DEFAULT 'payment'
                        CHECK (payment_type IN ('payment', 'path_payment_strict_receive')),
  source_amount       NUMERIC(20, 7),
  source_asset        TEXT,
  conversion_rate     NUMERIC(30, 15),
  path                JSONB,
  tx_hash             TEXT UNIQUE NOT NULL,  -- deduplicate by Stellar transaction hash
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS contributions_campaign_id_idx ON contributions (campaign_id);
CREATE INDEX IF NOT EXISTS contributions_tx_hash_idx ON contributions (tx_hash);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);
CREATE INDEX IF NOT EXISTS campaigns_creator_id_idx ON campaigns (creator_id);
