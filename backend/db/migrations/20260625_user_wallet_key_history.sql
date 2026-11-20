-- Wallet key history: lets contribution history and refunds survive wallet rotation.
CREATE TABLE IF NOT EXISTS user_wallet_keys (
  public_key TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_wallet_keys_user_idx ON user_wallet_keys (user_id);

INSERT INTO user_wallet_keys (public_key, user_id)
SELECT wallet_public_key, id FROM users
ON CONFLICT (public_key) DO NOTHING;
