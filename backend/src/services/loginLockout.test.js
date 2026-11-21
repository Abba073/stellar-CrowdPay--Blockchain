const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const warnings = [];
const lockout = proxyquire('./loginLockout', {
  '../config/logger': {
    warn: (msg, meta) => warnings.push({ msg, meta }),
    error: () => {},
    info: () => {},
  },
});

/** In-memory stand-in for the login_failures / auth_events SQL used by the service. */
function fakeDb() {
  const failures = new Map();
  const events = [];
  return {
    failures,
    events,
    async query(text, params) {
      if (text.includes('INSERT INTO auth_events')) {
        const [userId, email, eventType, ip] = params;
        events.push({ userId, email, eventType, ip, createdAt: fakeDb.now });
        return { rows: [] };
      }
      if (text.startsWith('SELECT locked_until FROM login_failures')) {
        const row = failures.get(params[0]);
        return { rows: row ? [{ locked_until: row.locked_until }] : [] };
      }
      if (text.includes('FROM auth_events')) {
        const [email, nowIso] = params;
        const since = new Date(nowIso).getTime() - 3600_000;
        const hits = events.filter(
          (e) =>
            e.email === email &&
            ['login_failed', 'login_succeeded'].includes(e.eventType) &&
            e.createdAt.getTime() > since
        );
        const oldest = hits.length ? new Date(Math.min(...hits.map((h) => h.createdAt.getTime()))) : null;
        return { rows: [{ attempts: hits.length, oldest }] };
      }
      if (text.includes('INSERT INTO login_failures')) {
        const [email, nowIso] = params;
        const now = new Date(nowIso);
        const row = failures.get(email);
        if (!row) {
          failures.set(email, { failed_count: 1, lock_level: 0, last_failed_at: now, locked_until: null });
        } else {
          row.failed_count = row.last_failed_at < new Date(now - 3600_000) ? 1 : row.failed_count + 1;
          row.last_failed_at = now;
        }
        const r = failures.get(email);
        return { rows: [{ failed_count: r.failed_count, lock_level: r.lock_level }] };
      }
      if (text.includes('UPDATE login_failures')) {
        const row = failures.get(params[0]);
        row.locked_until = new Date(params[1]);
        row.lock_level += 1;
        row.failed_count = 0;
        return { rows: [] };
      }
      if (text.startsWith('DELETE FROM login_failures')) {
        failures.delete(params[0]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}
fakeDb.now = new Date('2026-10-21T10:00:00Z');

function at(minutes) {
  fakeDb.now = new Date(Date.parse('2026-10-21T10:00:00Z') + minutes * 60_000);
  return fakeDb.now;
}

test('locks an email for 15 minutes after 5 consecutive failures', async () => {
  const db = fakeDb();
  for (let i = 1; i <= 4; i++) {
    const r = await lockout.recordLoginFailure(db, 'Victim@Example.com', { now: at(i) });
    assert.equal(r.locked, false);
    assert.deepEqual(await lockout.checkLoginAllowed(db, 'victim@example.com', { now: at(i) }), { allowed: true });
  }
  const fifth = await lockout.recordLoginFailure(db, 'victim@example.com', { now: at(5) });
  assert.equal(fifth.locked, true);
  assert.equal(fifth.lockedUntil.getTime(), at(5 + 15).getTime());

  const blocked = await lockout.checkLoginAllowed(db, 'victim@example.com', { now: at(10) });
  assert.deepEqual(blocked, { allowed: false, reason: 'locked', retryAfterSeconds: 10 * 60 });
  assert.ok(db.events.some((e) => e.eventType === 'login_locked'));
  assert.ok(db.events.some((e) => e.eventType === 'login_blocked'));
  assert.ok(warnings.some((w) => /account login locked/.test(w.msg)));

  // Lock expires.
  assert.deepEqual(await lockout.checkLoginAllowed(db, 'victim@example.com', { now: at(21) }), { allowed: true });
});

test('repeat lockouts back off exponentially', async () => {
  const db = fakeDb();
  let minute = 0;
  const lockFor = async () => {
    let result;
    for (let i = 0; i < 5; i++) {
      result = await lockout.recordLoginFailure(db, 'a@b.c', { now: at(++minute) });
    }
    const minutes = (result.lockedUntil - fakeDb.now) / 60_000;
    minute += minutes + 1; // wait out the lock
    return minutes;
  };
  assert.equal(await lockFor(), 15);
  assert.equal(await lockFor(), 30);
  assert.equal(await lockFor(), 60);
  assert.equal(lockout.lockMinutesForLevel(20), 24 * 60, 'capped at LOGIN_LOCK_MAX_MINUTES');
});

test('a successful login clears the failure state', async () => {
  const db = fakeDb();
  for (let i = 0; i < 4; i++) await lockout.recordLoginFailure(db, 'a@b.c', { now: at(i) });
  await lockout.recordLoginSuccess(db, 'a@b.c', { userId: 'u1' });
  assert.equal(db.failures.has('a@b.c'), false);
  const r = await lockout.recordLoginFailure(db, 'a@b.c', { now: at(5) });
  assert.equal(r.failedCount, 1);
});

test('failures more than an hour apart start a new count', async () => {
  const db = fakeDb();
  for (let i = 0; i < 4; i++) await lockout.recordLoginFailure(db, 'a@b.c', { now: at(i) });
  const r = await lockout.recordLoginFailure(db, 'a@b.c', { now: at(4 + 61) });
  assert.equal(r.locked, false);
  assert.equal(r.failedCount, 1);
});

test('caps password attempts per account per hour, across IPs', async () => {
  const db = fakeDb();
  // Alternate success and failure so the consecutive-failure lock never trips.
  for (let i = 0; i < 20; i++) {
    if (i % 2) await lockout.recordLoginSuccess(db, 'a@b.c', { ip: `10.0.0.${i}` });
    else await lockout.recordLoginFailure(db, 'a@b.c', { ip: `10.0.0.${i}`, now: at(1) });
    db.events[db.events.length - 1].createdAt = at(1);
  }
  const r = await lockout.checkLoginAllowed(db, 'a@b.c', { now: at(30) });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'hourly_cap');
  assert.equal(r.retryAfterSeconds, 31 * 60);
});

test('tracks unknown emails the same way (no account enumeration)', async () => {
  const db = fakeDb();
  let r;
  for (let i = 0; i < 5; i++) r = await lockout.recordLoginFailure(db, 'nobody@example.com', { now: at(i) });
  assert.equal(r.locked, true);
});
