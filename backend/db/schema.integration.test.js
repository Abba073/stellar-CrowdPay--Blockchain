// Runs against a real, fully migrated Postgres (see the db-migrate CI job):
//   psql $DATABASE_URL -f db/schema.sql && node db/migrate.js && npm run test:db
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { countLegacyPlaintextUserWalletSecrets } = require('../src/services/walletSecrets');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

test.after(() => pool.end());

async function inRolledBackTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('every migration file is recorded as applied', async () => {
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql'));
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  assert.deepEqual(files.filter((f) => !applied.has(f)), []);
});

test('tables and columns the runtime depends on exist', async () => {
  const expected = {
    users: ['wallet_type', 'token_version', 'email_verified', 'is_super_admin'],
    campaigns: ['deleted_at', 'featured', 'search_vector'],
    contributions: ['tx_hash', 'display_name'],
    withdrawal_requests: ['milestone_id'],
    milestones: ['release_claimed_at', 'release_tx_hash'],
    refresh_tokens: ['family_id'],
    password_reset_tokens: ['token_hash'],
    anchor_deposits: ['contribution_submitting_at'],
    notifications: ['user_id'],
    admin_actions: ['created_at'],
  };
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = Object.entries(expected)
    .flatMap(([table, cols]) => cols.map((c) => `${table}.${c}`))
    .filter((key) => !present.has(key));
  assert.deepEqual(missing, []);
});

test('no invalid indexes or unvalidated constraints', async () => {
  const { rows: indexes } = await pool.query(
    `SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid`
  );
  const { rows: constraints } = await pool.query(
    `SELECT conname FROM pg_constraint WHERE NOT convalidated`
  );
  assert.deepEqual(indexes, []);
  assert.deepEqual(constraints, []);
});

test('contribution tx_hash uniqueness and campaign status check are enforced', async () => {
  await inRolledBackTransaction(async (client) => {
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_type)
       VALUES ('integration@example.com', 'x', 'Integration', 'GINTEGRATIONUSER', 'freighter')
       RETURNING id`
    );
    const { rows: [campaign] } = await client.query(
      `INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key)
       VALUES ($1, 'Integration', 100, 'XLM', 'GINTEGRATIONCAMPAIGN')
       RETURNING id`,
      [user.id]
    );
    const insertContribution = () => client.query(
      `INSERT INTO contributions (campaign_id, sender_public_key, amount, asset, tx_hash)
       VALUES ($1, 'GSENDER', 10, 'XLM', 'integration-tx-1')`,
      [campaign.id]
    );
    await insertContribution();

    await client.query('SAVEPOINT dup');
    await assert.rejects(insertContribution(), { code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT dup');

    await assert.rejects(
      client.query(`UPDATE campaigns SET status = 'bogus' WHERE id = $1`, [campaign.id]),
      { code: '23514' }
    );
  });
});

test('database contains no plaintext wallet secrets (seed included)', async () => {
  assert.equal(await countLegacyPlaintextUserWalletSecrets({ runner: pool }), 0);
  const { rows } = await pool.query(
    `SELECT email FROM users WHERE wallet_secret_encrypted LIKE 'seed-placeholder-%'`
  );
  assert.deepEqual(rows, []);
});
