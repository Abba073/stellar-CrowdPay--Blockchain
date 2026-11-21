-- Per-account login failure tracking with exponential lockout, plus an
-- auth_events audit trail. The IP-based loginLimiter alone lets an attacker
-- spread password guesses for one account across many IPs.

CREATE TABLE IF NOT EXISTS login_failures (
  -- Normalized (trimmed, lower-cased) email. Tracked whether or not an
  -- account exists, so lockout responses do not reveal registered emails.
  email            TEXT PRIMARY KEY,
  -- Failures since the last lockout or success, within the failure window.
  failed_count     INTEGER NOT NULL DEFAULT 0,
  -- Consecutive lockouts; each one doubles the lock duration.
  lock_level       INTEGER NOT NULL DEFAULT 0,
  first_failed_at  TIMESTAMPTZ,
  last_failed_at   TIMESTAMPTZ,
  locked_until     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  email       TEXT,
  -- login_failed | login_succeeded | login_locked | login_blocked
  event_type  TEXT NOT NULL,
  ip          TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_email_created
  ON auth_events (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_type_created
  ON auth_events (event_type, created_at DESC);
