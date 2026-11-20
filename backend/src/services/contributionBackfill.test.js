const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContributionRow } = require('./contributionBackfill');

test('buildContributionRow reconstructs a path-payment contribution from audit metadata', () => {
  const row = buildContributionRow({
    campaign_id: 'campaign-1',
    tx_hash: 'tx-1',
    asset_type: 'USDC',
    created_at: '2026-09-24T00:00:00.000Z',
    metadata: {
      flow: 'path_payment_strict_receive',
      contributor_public_key: 'GCONTRIBUTOR',
      send_asset: 'XLM',
      dest_asset: 'USDC',
      dest_amount: '12.5',
      quoted_source_amount: '13.1',
      path: ['AQUA'],
      display_name: 'Ada',
    },
  });

  assert.deepEqual(row, {
    campaignId: 'campaign-1',
    senderPublicKey: 'GCONTRIBUTOR',
    amount: 12.5,
    asset: 'USDC',
    anchorId: null,
    anchorTransactionId: null,
    anchorAsset: null,
    anchorAmount: null,
    paymentType: 'path_payment_strict_receive',
    sourceAmount: 13.1,
    sourceAsset: 'XLM',
    conversionRate: 12.5 / 13.1,
    path: ['AQUA'],
    txHash: 'tx-1',
    displayName: 'Ada',
    createdAt: '2026-09-24T00:00:00.000Z',
  });
});

test('buildContributionRow rejects transactions without reconstructable metadata', () => {
  assert.equal(
    buildContributionRow({
      campaign_id: 'campaign-1',
      tx_hash: 'tx-2',
      asset_type: 'XLM',
      metadata: {},
    }),
    null
  );
});
// ---- chunked, resumable backfill ---------------------------------------------

const { backfillContributions } = require('./contributionBackfill');

function stTx(i, { campaign = 'camp-1', existing = null, metadata } = {}) {
  return {
    tx_hash: `tx-${i}`,
    campaign_id: campaign,
    asset_type: 'XLM',
    created_at: `2026-09-24T00:00:0${i}.000Z`,
    cursor_created_at: `2026-09-24 00:00:0${i}.000123+00`,
    existing_contribution_id: existing,
    metadata: metadata || { sender_public_key: `GS${i}`, amount: '2' },
  };
}

/** Fake pg pool: keyset-pages `rows`, records statements per client. */
function fakeRunner(rows, { progress = null, failOnTx = null } = {}) {
  const log = [];
  const listCalls = [];
  let stored = progress;
  const exec = (who) => async (text, params) => {
    log.push({ who, text, params });
    if (text.includes('FROM stellar_transactions st')) {
      listCalls.push(params);
      const limit = params[params.length - 1];
      let start = 0;
      if (params.length === 3) start = rows.findIndex((r) => r.tx_hash === params[1]) + 1;
      return { rows: rows.slice(start, start + limit) };
    }
    if (text.includes('FROM contribution_backfill_progress')) {
      return { rows: stored ? [{ created_at: stored.createdAt, last_tx_hash: stored.txHash }] : [] };
    }
    if (text.includes('INSERT INTO contribution_backfill_progress')) {
      stored = { createdAt: params[1], txHash: params[2] };
      return { rows: [] };
    }
    if (text.includes('INSERT INTO contributions')) {
      if (params[13] === failOnTx) throw new Error('boom');
      return { rows: [{ id: `contrib-${params[13]}` }] };
    }
    return { rows: [] };
  };
  return {
    log,
    listCalls,
    stored: () => stored,
    query: exec('pool'),
    connect: async () => ({ query: exec('client'), release() {} }),
  };
}

const statements = (runner, re) => runner.log.filter((l) => re.test(l.text));

test('backfill processes fixed-size chunks, one transaction each, paging by keyset', async () => {
  const runner = fakeRunner([1, 2, 3, 4, 5].map((i) => stTx(i)));
  const result = await backfillContributions({ runner, dryRun: false, batchSize: 2 });

  assert.equal(result.batches, 3);
  assert.equal(result.restored, 5);
  assert.equal(statements(runner, /^BEGIN$/).length, 3);
  assert.equal(statements(runner, /^COMMIT$/).length, 3);
  assert.deepEqual(runner.listCalls[0], [2]);
  assert.deepEqual(runner.listCalls[1], ['2026-09-24 00:00:02.000123+00', 'tx-2', 2]);
  assert.deepEqual(runner.stored(), { createdAt: '2026-09-24 00:00:05.000123+00', txHash: 'tx-5' });
  // Writes go through the chunk's client, never the pool.
  assert.equal(runner.log.filter((l) => l.who === 'pool' && /INSERT|UPDATE/.test(l.text)).length, 0);
});

test('raised_amount is updated once per campaign per chunk', async () => {
  const runner = fakeRunner([stTx(1), stTx(2), stTx(3, { campaign: 'camp-2' })]);
  await backfillContributions({ runner, dryRun: false, batchSize: 10 });
  const updates = statements(runner, /UPDATE campaigns/);
  assert.deepEqual(updates.map((u) => u.params), [[4, 'camp-1'], [2, 'camp-2']]);
});

test('dry run reports counts without connecting or writing', async () => {
  const runner = fakeRunner([stTx(1), stTx(2, { existing: 'c-9' }), stTx(3, { metadata: {} })]);
  let connected = false;
  runner.connect = async () => {
    connected = true;
    throw new Error('should not connect');
  };
  const result = await backfillContributions({ runner, dryRun: true, batchSize: 2 });
  assert.deepEqual(
    { restored: result.restored, existing: result.existing, skipped: result.skipped, scanned: result.scanned },
    { restored: 1, existing: 1, skipped: 1, scanned: 3 }
  );
  assert.equal(connected, false);
  assert.equal(runner.stored(), null, 'dry run does not move the cursor');
});

test('--resume continues after the stored cursor', async () => {
  const runner = fakeRunner([1, 2, 3].map((i) => stTx(i)), {
    progress: { createdAt: '2026-09-24 00:00:02.000123+00', txHash: 'tx-2' },
  });
  const result = await backfillContributions({ runner, dryRun: false, batchSize: 10, resume: true });
  assert.equal(result.restored, 1);
  assert.deepEqual(runner.listCalls[0], ['2026-09-24 00:00:02.000123+00', 'tx-2', 10]);
});

test('a failing chunk rolls back and leaves the cursor at the last committed chunk', async () => {
  const runner = fakeRunner([1, 2, 3, 4].map((i) => stTx(i)), { failOnTx: 'tx-3' });
  await assert.rejects(backfillContributions({ runner, dryRun: false, batchSize: 2 }), /boom/);
  assert.equal(statements(runner, /^ROLLBACK$/).length, 1);
  assert.deepEqual(runner.stored(), { createdAt: '2026-09-24 00:00:02.000123+00', txHash: 'tx-2' });
});

test('CLI flags: dry run by default, --apply, --batch-size, --resume', () => {
  const { parseArgs } = require('../scripts/backfillContributions');
  assert.equal(parseArgs([], {}).dryRun, true);
  assert.equal(parseArgs(['--apply'], {}).dryRun, false);
  assert.equal(parseArgs([], { DRY_RUN: '0' }).dryRun, false);
  assert.equal(parseArgs(['--apply', '--dry-run'], {}).dryRun, true);
  assert.equal(parseArgs(['--batch-size=250', '--resume'], {}).batchSize, 250);
  assert.throws(() => parseArgs(['--batch-size=0'], {}), /positive integer/);
  assert.throws(() => parseArgs(['--nope'], {}), /Unknown option/);
});
