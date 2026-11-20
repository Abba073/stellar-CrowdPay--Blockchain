const { validateWalletSecretConfig } = require('../services/walletSecrets');

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PLATFORM_SECRET_KEY',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
];
const STORAGE_VARS = ['STORAGE_BUCKET', 'STORAGE_ENDPOINT'];

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
}

module.exports = { validateEnv };
