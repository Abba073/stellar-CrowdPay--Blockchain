const { validateWalletSecretConfig } = require('../services/walletSecrets');

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'API_KEY_PEPPER',
  'PLATFORM_SECRET_KEY',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'USDC_ISSUER',
];
const STORAGE_VARS = ['STORAGE_BUCKET', 'STORAGE_ENDPOINT'];

const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
const DEFAULT_LOG_LEVEL = 'info';

// DB pool tuning variables that must be positive integers when set.
const POSITIVE_INT_VARS = ['DB_POOL_MAX', 'DB_IDLE_TIMEOUT_MS', 'DB_CONNECTION_TIMEOUT_MS'];

function parseModuleOverrides(raw) {
  const overrides = {};
  if (!raw) return overrides;
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const idx = entry.indexOf('=');
      if (idx === -1) {
        process.stderr.write(
          `[crowdpay] Warning: ignoring malformed LOG_LEVEL_MODULES entry "${entry}" (expected module=level)\n`
        );
        return;
      }
      const moduleName = entry.slice(0, idx).trim();
      const level = entry.slice(idx + 1).trim().toLowerCase();
      if (!moduleName || !LOG_LEVELS.includes(level)) {
        process.stderr.write(
          `[crowdpay] Warning: ignoring invalid LOG_LEVEL_MODULES entry "${entry}"\n`
        );
        return;
      }
      overrides[moduleName] = level;
    });
  return overrides;
}

function resolveLogConfig() {
  const rawLevel = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  let level = DEFAULT_LOG_LEVEL;
  if (rawLevel) {
    if (LOG_LEVELS.includes(rawLevel)) {
      level = rawLevel;
    } else {
      process.stderr.write(
        `[crowdpay] Warning: invalid LOG_LEVEL "${process.env.LOG_LEVEL}" — falling back to "${DEFAULT_LOG_LEVEL}"\n`
      );
    }
  }
  return { level, moduleOverrides: parseModuleOverrides(process.env.LOG_LEVEL_MODULES) };
}

/**
 * Parse an environment value as a positive integer.
 *
 * Returns the parsed integer when the value is a valid positive integer,
 * or `undefined` when the value is missing/empty. Throws an Error with a
 * descriptive message when the value is present but not a positive integer
 * (non-numeric, zero, negative, or non-integer).
 */
function parsePositiveIntEnv(name, raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;

  // Reject anything that isn't a plain base-10 integer literal.
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(
      `${name} must be a positive integer (got "${raw}")`
    );
  }

  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer (got "${raw}")`
    );
  }
  return value;
}

// Published in backend/.env.example (and CI) so local dev boots out of the box.
// They must never reach production or mainnet.
const DEV_ONLY_VALUES = {
  JWT_SECRET: 'dev-only-jwt-secret-change-me',
  API_KEY_PEPPER: 'dev-only-api-key-pepper-change-me',
  PLATFORM_SECRET_KEY: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
  WALLET_SECRET_LOCAL_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    const list = missing.map((k) => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: missing required environment variables:\n${list}\n\nSet them in your .env file.\n\n`
    );
    process.exit(1);
  }

  const storageConfigured = STORAGE_VARS.some((key) => !!process.env[key]);
  const storageMissing = STORAGE_VARS.filter((key) => !process.env[key]);
  if (storageConfigured && storageMissing.length) {
    const list = storageMissing.map((k) => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: incomplete storage configuration. Set all of:\n${STORAGE_VARS.join(', ')}\n\nMissing:\n${list}\n\n`
    );
    process.exit(1);
  }

  // Validate DB pool tuning variables: each must be a positive integer when set.
  const invalidDbVars = [];
  for (const key of POSITIVE_INT_VARS) {
    try {
      parsePositiveIntEnv(key, process.env[key]);
    } catch (err) {
      invalidDbVars.push(`  - ${err.message}`);
    }
  }
  if (invalidDbVars.length) {
    process.stderr.write(
      `\n[crowdpay] Cannot start: invalid database pool configuration:\n${invalidDbVars.join('\n')}\n\n`
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' || process.env.STELLAR_NETWORK === 'mainnet') {
    const devOnly = Object.keys(DEV_ONLY_VALUES).filter((key) => process.env[key] === DEV_ONLY_VALUES[key]);
    if (devOnly.length) {
      const list = devOnly.map((k) => `  - ${k}`).join('\n');
      process.stderr.write(
        `\n[crowdpay] Cannot start: these variables still use the published development values from .env.example:\n${list}\n\n`
      );
      process.exit(1);
    }
  }

  try {
    validateWalletSecretConfig();
  } catch (err) {
    process.stderr.write(`\n[crowdpay] Cannot start: ${err.message}\n\n`);
    process.exit(1);
  }

  // Warn about important optional variables
  if (!process.env.PLATFORM_APPROVER_USER_ID) {
    process.stderr.write(
      '[crowdpay] Warning: PLATFORM_APPROVER_USER_ID not set — withdrawal approvals are open to all users (dev mode)\n'
    );
  }
  if (!process.env.JWT_EXPIRES_IN) {
    process.stderr.write(
      '[crowdpay] Warning: JWT_EXPIRES_IN not set — access tokens will use the default expiry (15m)\n'
    );
  }

  // Validate logging configuration (warns and falls back to a safe default on bad input)
  resolveLogConfig();
}

module.exports = {
  validateEnv,
  REQUIRED,
  DEV_ONLY_VALUES,
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  POSITIVE_INT_VARS,
  parsePositiveIntEnv,
  resolveLogConfig,
};
