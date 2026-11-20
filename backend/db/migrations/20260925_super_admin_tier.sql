-- Issue #19: Introduce super-admin tier to prevent platform lockout.
-- A super_admin is the only role that can promote/demote regular admins.
-- The first admin seeded into the platform should be upgraded to super_admin manually.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS users_super_admin_idx ON users (is_super_admin) WHERE is_super_admin = TRUE;
