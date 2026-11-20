require('dotenv').config();

const db = require('../config/database');
const {
  backfillContributions,
  resetBackfillProgress,
  DEFAULT_BATCH_SIZE,
} = require('../services/contributionBackfill');

const USAGE = `Usage: npm run backfill-contributions -- [options]

Restores contributions from stellar_transactions in fixed-size chunks, one
short transaction per chunk, with a resumable cursor.

  --dry-run          Report what would change; write nothing (default)
  --apply            Write changes (same as DRY_RUN=0)
  --batch-size=N     Rows per chunk/transaction (default ${DEFAULT_BATCH_SIZE}, max 5000)
  --resume           Continue after the last committed chunk
  --reset            Forget the stored cursor before running
  --max-batches=N    Stop after N chunks
  --help             Show this help
`;

function parseArgs(argv, env = process.env) {
  const opts = {
    dryRun: env.DRY_RUN !== '0',
    batchSize: DEFAULT_BATCH_SIZE,
    resume: false,
    reset: false,
    maxBatches: Infinity,
  };
  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    switch (flag) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--apply':
        opts.dryRun = false;
        break;
      case '--batch-size':
        opts.batchSize = parseInt(value, 10);
        break;
      case '--resume':
        opts.resume = true;
        break;
      case '--reset':
        opts.reset = true;
        break;
      case '--max-batches':
        opts.maxBatches = parseInt(value, 10);
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
  if (opts.maxBatches !== Infinity && (!Number.isInteger(opts.maxBatches) || opts.maxBatches < 1)) {
    throw new Error('--max-batches must be a positive integer');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  if (opts.reset && !opts.dryRun) await resetBackfillProgress(db);
  const result = await backfillContributions({
    runner: db,
    dryRun: opts.dryRun,
    batchSize: opts.batchSize,
    resume: opts.resume && !opts.reset,
    maxBatches: opts.maxBatches,
    onBatch: (p) =>
      process.stderr.write(
        `[backfill-contributions] batch ${p.batch}: ${p.rows} rows ` +
          `(restored ${p.restored}, existing ${p.existing}, skipped ${p.skipped}) ` +
          `cursor=${p.cursor.createdAt}|${p.cursor.txHash}\n`
      ),
  });
  process.stdout.write(JSON.stringify({ ...result, dry_run: opts.dryRun }, null, 2) + '\n');
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`[backfill-contributions] ${err.message}\n`);
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
