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

// Published in backend/.env.example (and CI) so local dev boots out of the box.
// They must never reach production or mainnet.
const DEV_ONLY_VALUES = {
  JWT_SECRET: 'dev-only-jwt-secret-change-me',
  API_KEY_PEPPER: 'dev-only-api-key-pepper-change-me',
  PLATFORM_SECRET_KEY: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
  WALLET_SECRET_LOCAL_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
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
  resolveLogConfig,
};
