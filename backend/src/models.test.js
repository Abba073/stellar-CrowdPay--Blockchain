const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const pool = require('./config/database');
const fs = require('fs');
const path = require('path');

/**
 * Run an expected-to-fail statement inside a savepoint so the aborted
 * transaction state does not leak into the rest of the suite.
 */
async function expectViolation(client, savepoint, run) {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await assert.rejects(
      run(),
      (err) => err.code === '23505' || err.code === '23514', // unique / check
    );
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

describe('Database Models & Constraints', async () => {
  let client;

  before(async () => {
    client = await pool.connect();
    await client.query('BEGIN');

    // Replay the schema as migrate:fresh does: full base schema, then the
    // migrations that evolved the campaigns status CHECK. The suspension/
    // refund chains are what this suite exercises.
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    await client.query('CREATE SCHEMA IF NOT EXISTS test_models_schema');
    await client.query('SET search_path TO test_models_schema');
    await client.query(schemaSql);

    const migrations = [
      '20260430_admin_moderation.sql',
      '20260602_campaign_refund_mechanism.sql',
      '20260925_campaign_status_suspended_check_fix.sql',
    ];
    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf-8');
      await client.query(sql);
    }
  });

  after(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('should allow creating a valid user', async () => {
    const res = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('test@example.com', 'hash', 'Test User', 'G_PUB_1', 'enc_sec')
      RETURNING id;
    `);
    assert.strictEqual(res.rows.length, 1);
  });

  it('should enforce unique email for users', async () => {
    await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('duplicate@example.com', 'hash', 'Test User 1', 'G_PUB_2', 'enc_sec')
    `);

    await expectViolation(client, 'sp_unique_email', () =>
      client.query(`
        INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
        VALUES ('duplicate@example.com', 'hash', 'Test User 2', 'G_PUB_3', 'enc_sec')
      `)
    );
  });

  it('should enforce valid asset_type on campaigns', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator@example.com', 'hash', 'Creator', 'G_PUB_4', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    await expectViolation(client, 'sp_bad_asset', () =>
      client.query(`
        INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
        VALUES ($1, 'Invalid Asset Campaign', 1000, 'BTC', 'G_CAMPAIGN_PUB_1', 'active')
      `, [creatorId])
    );
  });

  it('should allow creating a valid campaign', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator2@example.com', 'hash', 'Creator 2', 'G_PUB_5', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const res = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Valid Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_2', 'active')
      RETURNING id;
    `, [creatorId]);
    assert.strictEqual(res.rows.length, 1);
  });

  it('should allow status = suspended on campaigns (issue #50 regression)', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator-suspended@example.com', 'hash', 'Creator Suspended', 'G_PUB_SUSP', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const res = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Suspendable Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_SUSP', 'suspended')
      RETURNING status;
    `, [creatorId]);
    assert.strictEqual(res.rows[0].status, 'suspended');
  });

  it('should allow status = refunded on campaigns', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator-refunded@example.com', 'hash', 'Creator Refunded', 'G_PUB_REF', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const res = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Refunded Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_REF', 'refunded')
      RETURNING status;
    `, [creatorId]);
    assert.strictEqual(res.rows[0].status, 'refunded');
  });

  it('should enforce valid status on campaigns', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator3@example.com', 'hash', 'Creator 3', 'G_PUB_6', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    await expectViolation(client, 'sp_bad_status', () =>
      client.query(`
        INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
        VALUES ($1, 'Invalid Status Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_3', 'unknown_status')
      `, [creatorId])
    );
  });

  it('should enforce payment_type constraint on contributions', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator4@example.com', 'hash', 'Creator 4', 'G_PUB_7', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const campRes = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Campaign for Contribs', 1000, 'USDC', 'G_CAMPAIGN_PUB_4', 'active')
      RETURNING id;
    `, [creatorId]);
    const campaignId = campRes.rows[0].id;

    await expectViolation(client, 'sp_bad_payment_type', () =>
      client.query(`
        INSERT INTO contributions (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash)
        VALUES ($1, 'G_SENDER_1', 100, 'USDC', 'invalid_payment_type', 'TX_1')
      `, [campaignId])
    );
  });
});