const db = require('../config/database');
const logger = require('../config/logger');

// Per-type preference columns. Each maps to a boolean flag on
// notification_preferences. Defaults to enabled when no row exists.
const PREFERENCE_TYPES = ['system', 'message', 'listing', 'order', 'review', 'marketing'];

function normalizeType(type) {
  if (!type) return 'system';
  const t = String(type).toLowerCase();
  return PREFERENCE_TYPES.includes(t) ? t : 'system';
}

function defaultPreferences() {
  const prefs = {};
  for (const t of PREFERENCE_TYPES) {
    prefs[t] = true;
  }
  return prefs;
}

async function getNotificationPreferences(userId) {
  const defaults = defaultPreferences();
  try {
    const result = await db.query(
      `SELECT ${PREFERENCE_TYPES.map((t) => `${t}_enabled`).join(', ')}
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId]
    );
    if (!result.rows.length) {
      return defaults;
    }
    const row = result.rows[0];
    const prefs = {};
    for (const t of PREFERENCE_TYPES) {
      const value = row[`${t}_enabled`];
      prefs[t] = value === null || value === undefined ? true : Boolean(value);
    }
    return prefs;
  } catch (err) {
    logger.error('Failed to load notification preferences', {
      user_id: userId,
      error: err.message,
    });
    return defaults;
  }
}

async function upsertNotificationPreferences(userId, patch = {}) {
  const current = await getNotificationPreferences(userId);
  const merged = { ...current };
  for (const t of PREFERENCE_TYPES) {
    if (Object.prototype.hasOwnProperty.call(patch, t)) {
      merged[t] = Boolean(patch[t]);
    }
  }

  const columns = PREFERENCE_TYPES.map((t) => `${t}_enabled`);
  const values = PREFERENCE_TYPES.map((t) => merged[t]);
  const placeholders = values.map((_, i) => `$${i + 2}`);
  const updates = columns.map((col, i) => `${col} = $${i + 2}`);

  try {
    await db.query(
      `INSERT INTO notification_preferences (user_id, ${columns.join(', ')})
       VALUES ($1, ${placeholders.join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}, updated_at = NOW()`,
      [userId, ...values]
    );
  } catch (err) {
    logger.error('Failed to upsert notification preferences', {
      user_id: userId,
      error: err.message,
    });
    throw err;
  }

  return merged;
}

function deriveDedupKey(type, dedupKey, eventId) {
  if (dedupKey) return String(dedupKey);
  if (eventId !== undefined && eventId !== null) {
    return `${normalizeType(type)}:${eventId}`;
  }
  return null;
}

async function createNotification(userId, { type, title, body, link, dedupKey, eventId } = {}) {
  const normalizedType = normalizeType(type);

  // Honor per-type preferences before inserting.
  const prefs = await getNotificationPreferences(userId);
  if (prefs[normalizedType] === false) {
    return false;
  }

  const resolvedDedupKey = deriveDedupKey(normalizedType, dedupKey, eventId);

  try {
    let result;
    if (resolvedDedupKey) {
      result = await db.query(
        `INSERT INTO notifications (user_id, type, title, body, link, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, dedup_key) DO NOTHING
         RETURNING id`,
        [userId, normalizedType, title, body || null, link || null, resolvedDedupKey]
      );
    } else {
      result = await db.query(
        `INSERT INTO notifications (user_id, type, title, body, link)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [userId, normalizedType, title, body || null, link || null]
      );
    }
    return result.rowCount > 0;
  } catch (err) {
    logger.error('Failed to create notification', {
      user_id: userId,
      type: normalizedType,
      error: err.message,
    });
    return false;
  }
}

module.exports = {
  createNotification,
  getNotificationPreferences,
  upsertNotificationPreferences,
  PREFERENCE_TYPES,
};