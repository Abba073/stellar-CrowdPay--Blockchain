require('dotenv').config();

const db = require('../config/database');
const {
  rotateLegacyUserWalletSecrets,
  restoreWalletSecretBackup,
  purgeWalletSecretBackup,
  validateWalletSecretConfig,
} = require('../services/walletSecrets');

const USAGE = `Usage: npm run rotate-wallet-secrets -- [options]

Encrypts legacy plaintext wallet secrets with the configured provider.
Every new ciphertext is decrypted and checked against the original before it
is written, rows are committed in batches, and each row's previous value is
backed up to wallet_secret_backups under the printed run_id.

  --dry-run              Encrypt + verify everything, report counts, write nothing
                         (also DRY_RUN=1)
  --batch-size=N         Users per batch/transaction (default 100, max 1000)
  --restore=RUN_ID       Put back the pre-rotation values of a run
  --purge-backup=RUN_ID  Delete a verified run's backup rows (they may hold plaintext)
  --help                 Show this help
`;

function parseArgs(argv, env = process.env) {
  const opts = { dryRun: env.DRY_RUN === '1', batchSize: 100 };
  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    switch (flag) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--batch-size':
        opts.batchSize = parseInt(value, 10);
        break;
      case '--restore':
        opts.restore = value;
        break;
      case '--purge-backup':
        opts.purge = value;
        break;
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
    throw new Error('--batch-size must be a positive integer');
  }
  for (const key of ['restore', 'purge']) {
    if (key in opts && !/^[0-9a-f-]{36}$/i.test(String(opts[key]))) {
      throw new Error(`--${key === 'purge' ? 'purge-backup' : key} needs a run_id (UUID)`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  if (opts.restore) {
    const result = await restoreWalletSecretBackup(opts.restore, { runner: db });
    process.stdout.write(JSON.stringify({ run_id: opts.restore, ...result }, null, 2) + '\n');
    return;
  }
  if (opts.purge) {
    const result = await purgeWalletSecretBackup(opts.purge, { runner: db });
    process.stdout.write(JSON.stringify({ run_id: opts.purge, ...result }, null, 2) + '\n');
    return;
  }

  validateWalletSecretConfig();
  const result = await rotateLegacyUserWalletSecrets({
    runner: db,
    dryRun: opts.dryRun,
    batchSize: opts.batchSize,
    onBatch: (p) =>
      process.stderr.write(`[rotate-wallet-secrets] batch ${p.batch}: ${p.rows} users, ${p.rotated} rotated\n`),
  });

  process.stdout.write(JSON.stringify({ ...result, dry_run: opts.dryRun }, null, 2) + '\n');
  if (!opts.dryRun && result.rotated > 0) {
    process.stderr.write(
      `[rotate-wallet-secrets] Previous values are backed up under run_id ${result.run_id}.\n` +
        `  Verify the app can still sign, then purge them:  --purge-backup=${result.run_id}\n` +
        `  To undo this run:                                --restore=${result.run_id}\n`
    );
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`[rotate-wallet-secrets] ${err.message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await db.end();
      } catch (_err) {
        // noop
      }
    });
}

module.exports = { parseArgs };
