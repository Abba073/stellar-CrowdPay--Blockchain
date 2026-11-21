-- Migration: Add token_version to users for access token invalidation on password reset
-- When a user resets their password, token_version is incremented.
-- Access tokens embed the version at issuance; the auth middleware rejects
-- tokens whose version does not match the current value in the database.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
