/**
 * Per-account login protection (complements the IP-based loginLimiter).
 *
 * - After LOGIN_MAX_FAILURES consecutive failures (within an hour) the email
 *   is locked for LOGIN_LOCK_BASE_MINUTES; each further lockout doubles the
 *   duration, up to LOGIN_LOCK_MAX_MINUTES. A successful login resets it.
 * - Independently, at most LOGIN_MAX_ATTEMPTS_PER_HOUR password attempts are
 *   accepted per email per rolling hour.
 * - Every attempt, lockout and blocked attempt is written to auth_events,
 *   and lockouts / failure bursts are logged as security alerts.
 *
 * Emails are tracked whether or not an account exists, so lockout responses
 * do not reveal which emails are registered. Functions take the db handle
 * from the caller so routes (and their tests) control the connection.
 */
const logger = require('../config/logger');

function positiveInt(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Each variable is read by its literal name so env tooling (and the
// .env.example parity test) can see which ones the backend uses.
function getConfig() {
  return {
    maxFailures: positiveInt(process.env.LOGIN_MAX_FAILURES, 5),
    lockBaseMinutes: positiveInt(process.env.LOGIN_LOCK_BASE_MINUTES, 15),
    lockMaxMinutes: positiveInt(process.env.LOGIN_LOCK_MAX_MINUTES, 24 * 60),
    maxAttemptsPerHour: positiveInt(process.env.LOGIN_MAX_ATTEMPTS_PER_HOUR, 20),
    burstAlertThreshold: positiveInt(process.env.LOGIN_BURST_ALERT_THRESHOLD, 10),
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Lock duration for the given (0-based) lock level, in minutes. */
function lockMinutesForLevel(level, config = getConfig()) {
  return Math.min(config.lockBaseMinutes * 2 ** level, config.lockMaxMinutes);
}

async function recordEvent(db, { userId = null, email, eventType, ip = null, details = null }) {
  try {
    await db.query(
      `INSERT INTO auth_events (user_id, email, event_type, ip, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, email, eventType, ip, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    // Auditing must never break login.
    logger.error('Failed to record auth event', { error: err.message, eventType });
  }
}

/**
 * Whether a login attempt for `email` may proceed.
 * @returns {Promise<{ allowed: true } | { allowed: false, reason: 'locked' | 'hourly_cap', retryAfterSeconds: number }>}
 */
async function checkLoginAllowed(db, rawEmail, { ip = null, now = new Date() } = {}) {
  const email = normalizeEmail(rawEmail);
  const config = getConfig();

  const { rows } = await db.query(
    'SELECT locked_until FROM login_failures WHERE email = $1',
    [email]
  );
  const lockedUntil = rows[0]?.locked_until ? new Date(rows[0].locked_until) : null;
  if (lockedUntil && lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((lockedUntil - now) / 1000);
    await recordEvent(db, { email, eventType: 'login_blocked', ip, details: { reason: 'locked', retryAfterSeconds } });
    return { allowed: false, reason: 'locked', retryAfterSeconds };
  }

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS attempts, MIN(created_at) AS oldest
       FROM auth_events
      WHERE email = $1
        AND event_type IN ('login_failed', 'login_succeeded')
        AND created_at > $2::timestamptz - INTERVAL '1 hour'`,
    [email, now.toISOString()]
  );
  const attempts = countRows[0]?.attempts ?? 0;
  if (attempts >= config.maxAttemptsPerHour) {
    const oldest = countRows[0]?.oldest ? new Date(countRows[0].oldest) : now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest.getTime() + 3600_000 - now.getTime()) / 1000));
    await recordEvent(db, { email, eventType: 'login_blocked', ip, details: { reason: 'hourly_cap', attempts } });
    return { allowed: false, reason: 'hourly_cap', retryAfterSeconds };
  }

  return { allowed: true };
}

/**
 * Records a failed password attempt and locks the email once it reaches
 * LOGIN_MAX_FAILURES within an hour.
 * @returns {Promise<{ locked: boolean, failedCount: number, lockedUntil?: Date }>}
 */
async function recordLoginFailure(db, rawEmail, { userId = null, ip = null, now = new Date() } = {}) {
  const email = normalizeEmail(rawEmail);
  const config = getConfig();
  await recordEvent(db, { userId, email, eventType: 'login_failed', ip });

  // Failures older than an hour start a fresh count.
  const { rows } = await db.query(
    `INSERT INTO login_failures (email, failed_count, first_failed_at, last_failed_at)
     VALUES ($1, 1, $2::timestamptz, $2::timestamptz)
     ON CONFLICT (email) DO UPDATE SET
       failed_count = CASE
         WHEN login_failures.last_failed_at < $2::timestamptz - INTERVAL '1 hour' THEN 1
         ELSE login_failures.failed_count + 1
       END,
       first_failed_at = CASE
         WHEN login_failures.last_failed_at < $2::timestamptz - INTERVAL '1 hour' THEN $2::timestamptz
         ELSE login_failures.first_failed_at
       END,
       last_failed_at = $2::timestamptz
     RETURNING failed_count, lock_level`,
    [email, now.toISOString()]
  );
  const failedCount = rows[0]?.failed_count ?? 0;
  const lockLevel = rows[0]?.lock_level ?? 0;

  if (failedCount >= config.burstAlertThreshold) {
    logger.warn('security_alert: login failure burst', { email, failedCount, ip });
  }
  if (failedCount < config.maxFailures) return { locked: false, failedCount };

  const minutes = lockMinutesForLevel(lockLevel, config);
  const lockedUntil = new Date(now.getTime() + minutes * 60_000);
  await db.query(
    `UPDATE login_failures
        SET locked_until = $2::timestamptz, lock_level = lock_level + 1, failed_count = 0
      WHERE email = $1`,
    [email, lockedUntil.toISOString()]
  );
  await recordEvent(db, {
    userId,
    email,
    eventType: 'login_locked',
    ip,
    details: { failedCount, lockMinutes: minutes, lockLevel: lockLevel + 1 },
  });
  logger.warn('security_alert: account login locked', {
    email,
    userId,
    ip,
    failedCount,
    lockMinutes: minutes,
    lockLevel: lockLevel + 1,
  });
  return { locked: true, failedCount, lockedUntil };
}

/** Clears the failure state after a successful login. */
async function recordLoginSuccess(db, rawEmail, { userId = null, ip = null } = {}) {
  const email = normalizeEmail(rawEmail);
  await db.query('DELETE FROM login_failures WHERE email = $1', [email]);
  await recordEvent(db, { userId, email, eventType: 'login_succeeded', ip });
}

module.exports = {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  lockMinutesForLevel,
  normalizeEmail,
  getConfig,
};
