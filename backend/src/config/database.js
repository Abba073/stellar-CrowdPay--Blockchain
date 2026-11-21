const { Pool } = require('pg');
const logger = require('./logger');

/**
 * Parse a positive integer environment value.
 * Falls back to the provided default when the value is missing/empty.
 * Throws a descriptive error when the value is present but not a positive integer.
 */
function parsePositiveIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid value for ${name}: "${raw}". Expected a positive integer.`
    );
  }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid value for ${name}: "${raw}". Expected a positive integer.`
    );
  }
  return parsed;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parsePositiveIntEnv('DB_POOL_MAX', 10),
  idleTimeoutMillis: parsePositiveIntEnv('DB_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMillis: parsePositiveIntEnv('DB_CONNECTION_TIMEOUT_MS', 5000),
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

pool.on('connect', () => {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug('New client connected to database pool', {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });
  }
});

module.exports = pool;
module.exports.parsePositiveIntEnv = parsePositiveIntEnv;