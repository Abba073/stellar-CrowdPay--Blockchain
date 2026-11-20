-- Mandatory pre-rotation backup for `npm run rotate-wallet-secrets`. Each
-- rotated row's previous wallet_secret_encrypted value is copied here in the
-- same transaction as its update, so a bad rotation can be rolled back with
-- restoreWalletSecretBackup(runId).
--
-- previous_value holds legacy *plaintext* secrets (that is what is being
-- rotated). Treat this table as sensitive as users.wallet_secret_encrypted
-- and purge a run's rows once the rotation has been verified.
CREATE TABLE IF NOT EXISTS wallet_secret_backups (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_value  TEXT NOT NULL,
  rotated_value   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_secret_backups_run
  ON wallet_secret_backups (run_id);
