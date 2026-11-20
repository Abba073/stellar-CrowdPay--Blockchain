const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const constants = require('./utils/constants');

// Every campaign status the application can persist. The database constraint
// must accept all of them or write paths (admin suspension, refunds, etc.)
// fail at runtime with CHECK violations.
const EXPECTED_CAMPAIGN_STATUSES = [
  'active',
  'funded',
  'in_progress',
  'completed',
  'closed',
  'withdrawn',
  'failed',
  'suspended',
  'refunded',
];

// Maps each status CHECK constraint to the application constants that define
// its domain. The database must accept exactly these values; any drift means a
// valid write will fail at runtime with a CHECK violation.
const STATUS_CONSTRAINTS = {
  campaigns_status_check: {
    table: 'campaigns',
    column: 'status',
    expected: EXPECTED_CAMPAIGN_STATUSES,
  },
  withdrawal_requests_status_check: {
    table: 'withdrawal_requests',
    column: 'status',
    expected: constants.WITHDRAWAL_STATUSES,
  },
  disputes_status_check: {
    table: 'disputes',
    column: 'status',
    expected: constants.DISPUTE_STATUSES,
  },
  milestones_status_check: {
    table: 'milestones',
    column: 'status',
    expected: constants.MILESTONE_STATUSES,
  },
  stellar_transactions_status_check: {
    table: 'stellar_transactions',
    column: 'status',
    expected: constants.STELLAR_TRANSACTION_STATUSES,
  },
  anchor_deposits_status_check: {
    table: 'anchor_deposits',
    column: 'status',
    expected: constants.ANCHOR_DEPOSIT_STATUSES,
  },
  webhook_deliveries_status_check: {
    table: 'webhook_deliveries',
    column: 'status',
    expected: constants.WEBHOOK_DELIVERY_STATUSES,
  },
};

function readAllMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

// Replays a constraint's evolution exactly as migrate.js would apply it, in
// chronological order: DROP resets it, the next ADD wins.
function resolveFinalConstraint(sql, constraintName) {
  const escaped = constraintName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constraintRe = new RegExp(
    `(DROP CONSTRAINT IF EXISTS ${escaped})|(ADD CONSTRAINT ${escaped}\\s+CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\([^)]*\\)\\s*\\))`,
    'g',
  );

  let finalDefinition = null;
  let match;
  while ((match = constraintRe.exec(sql)) !== null) {
    if (match[1]) {
      finalDefinition = null;
    } else {
      finalDefinition = match[2];
    }
  }

  return finalDefinition;
}

function parseConstraintValues(definition, constraintName, column) {
  const escaped = constraintName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = new RegExp(
    `^ADD CONSTRAINT ${escaped}\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(\\s*`,
    'i',
  );

  return definition
    .replace(prefixRe, '')
    .replace(/\s*\)\s*\)\s*$/, '')
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''));
}

test('schema integrity: campaigns_status_check allows every status the app uses', () => {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  assert.ok(
    files.includes('20260602_campaign_refund_mechanism.sql'),
    'refund migration must still exist (regression guard)',
  );

  const sql = readAllMigrations();
  const finalDefinition = resolveFinalConstraint(sql, 'campaigns_status_check');

  assert.ok(
    finalDefinition,
    'campaigns_status_check must be (re)defined after the last migration',
  );

  const statuses = parseConstraintValues(
    finalDefinition,
    'campaigns_status_check',
    'status',
  );

  assert.deepEqual(
    [...statuses].sort(),
    [...EXPECTED_CAMPAIGN_STATUSES].sort(),
    'final campaigns_status_check must allow every status the application writes, including suspended',
  );
});

test('schema integrity: every status CHECK constraint matches the app constants', () => {
  const sql = readAllMigrations();

  for (const [constraintName, { column, expected }] of Object.entries(
    STATUS_CONSTRAINTS,
  )) {
    assert.ok(
      Array.isArray(expected) && expected.length > 0,
      `${constraintName}: expected status list must be defined in utils/constants.js`,
    );

    const finalDefinition = resolveFinalConstraint(sql, constraintName);

    assert.ok(
      finalDefinition,
      `${constraintName} must be (re)defined after the last migration`,
    );

    const statuses = parseConstraintValues(
      finalDefinition,
      constraintName,
      column,
    );

    assert.deepEqual(
      [...statuses].sort(),
      [...expected].sort(),
      `final ${constraintName} must allow exactly the statuses the application writes`,
    );
  }
});