const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function load({ balances = {}, failFor = new Set(), slowMs = 0 } = {}) {
  const queries = [];
  const db = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM campaigns c') && text.includes('ORDER BY c.last_reconciled_at')) {
        return {
          rows: [
            { id: 'c1', wallet_public_key: 'G1', asset_type: 'USDC', raised_amount: '10' },
            { id: 'c2', wallet_public_key: 'G2', asset_type: 'USDC', raised_amount: '5' },
          ].slice(0, params[0]),
        };
      }
      if (text.includes('FROM withdrawal_requests')) return { rows: [] };
      return { rows: [] };
    },
  };
  const warnings = [];
  const mod = proxyquire('./reconciliation', {
    '../config/database': db,
    '../config/logger': { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    './stellarService': {
      getCampaignBalance: async (wallet) => {
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        if (failFor.has(wallet)) throw new Error('horizon down');
        return balances[wallet] || { USDC: '0' };
      },
    },
  });
  return { mod, queries, warnings };
}

const CONFIG = { intervalMs: 1000, batchSize: 50, fullSweepHours: 24, retryMinutes: 15 };

test('only selects changed / never-reconciled / overdue campaigns, bounded by the batch size', async () => {
  const { mod, queries } = load();
  await mod.reconcileCampaignBalances({ ...CONFIG, batchSize: 1 });
  const select = queries.find((q) => q.text.includes('ORDER BY c.last_reconciled_at'));
  assert.match(select.text, /last_reconciled_at IS NULL/);
  assert.match(select.text, /contributions ct[\s\S]*ct\.created_at > c\.last_reconciled_at/);
  assert.match(select.text, /ledger_stream_cursors lsc[\s\S]*lsc\.updated_at > c\.last_reconciled_at/);
  assert.match(select.text, /make_interval\(hours => \$2\)/);
  assert.match(select.text, /deleted_at IS NULL/);
  assert.deepEqual(select.params, [1, 24]);
  // Only one campaign checked and marked.
  const marks = queries.filter((q) => q.text.startsWith('UPDATE campaigns SET last_reconciled_at = NOW()'));
  assert.deepEqual(marks.map((q) => q.params[0]), ['c1']);
});

test('advances raised_amount when the chain shows more, and marks each campaign reconciled', async () => {
  const { mod, queries } = load({ balances: { G1: { USDC: '12' }, G2: { USDC: '5' } } });
  const summary = await mod.reconcileCampaignBalances(CONFIG);
  assert.deepEqual(
    { checked: summary.checked, updated: summary.updated, failed: summary.failed },
    { checked: 2, updated: 1, failed: 0 }
  );
  assert.ok(queries.some((q) => q.text.startsWith('UPDATE campaigns SET raised_amount') && q.params[1] === 'c1'));
  const marks = queries.filter((q) => q.text.startsWith('UPDATE campaigns SET last_reconciled_at = NOW()'));
  assert.deepEqual(marks.map((q) => q.params[0]), ['c1', 'c2']);
});

test('a failed check is back-dated for a retry instead of blocking the queue', async () => {
  const { mod, queries } = load({ failFor: new Set(['G1']) });
  const summary = await mod.reconcileCampaignBalances(CONFIG);
  assert.equal(summary.failed, 1);
  assert.equal(summary.checked, 1);
  const retry = queries.find((q) => /make_interval\(mins => \$3\)/.test(q.text));
  assert.deepEqual(retry.params, ['c1', 24, 15]);
});

test('runReconciliation skips a tick while the previous run is still going', async () => {
  const { mod, warnings } = load({ slowMs: 50 });
  const first = mod.runReconciliation(CONFIG);
  const second = await mod.runReconciliation(CONFIG);
  assert.deepEqual(second, { skipped: true, reason: 'overlap' });
  assert.ok(warnings.some((w) => /still in progress/.test(w)));
  const done = await first;
  assert.equal(done.checked, 2);
  // The guard is released afterwards.
  const third = await mod.runReconciliation(CONFIG);
  assert.equal(third.checked, 2);
});

test('interval, batch size and sweep period are env-tunable', () => {
  const { mod } = load();
  const saved = { ...process.env };
  try {
    process.env.RECONCILE_INTERVAL_MS = '60000';
    process.env.RECONCILE_BATCH_SIZE = '7';
    process.env.RECONCILE_FULL_SWEEP_HOURS = '6';
    process.env.RECONCILE_RETRY_MINUTES = '5';
    assert.deepEqual(mod.getReconcileConfig(), { intervalMs: 60000, batchSize: 7, fullSweepHours: 6, retryMinutes: 5 });
    process.env.RECONCILE_BATCH_SIZE = 'nope';
    assert.equal(mod.getReconcileConfig().batchSize, 50);
  } finally {
    process.env = saved;
  }
});
