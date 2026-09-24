const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildLedgerMonitor(mockQuery) {
  const updates = [];
  const wrappedQuery = async (text, params) => {
    if (text.includes('UPDATE campaigns') && text.includes('raised_amount = raised_amount +')) {
      updates.push({ text, params });
      return {
        rows: [{
          id: 'camp-1',
          creator_id: 'user-creator',
          title: 'Test Campaign',
          raised_amount: '100',
          target_amount: '100',
          asset_type: 'XLM',
          newly_funded: true,
        }],
      };
    }
    return mockQuery(text, params);
  };

  const mockDb = {
    query: wrappedQuery,
    connect: async () => ({
      query: wrappedQuery,
      release: () => {},
    }),
  };

  const ledgerMonitor = proxyquire('./ledgerMonitor', {
    '../config/database': mockDb,
    '../config/stellar': { server: {} },
    './stellarService': { getCampaignBalance: async () => ({}) },
    './webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: { CAMPAIGN_FUNDED: 'campaign.funded', CONTRIBUTION_RECEIVED: 'contribution.received' },
    },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async () => {},
    },
  });

  return { ledgerMonitor, updates };
}

test('handlePayment updates stellar_transactions when a contribution row is created', async () => {
  const stellarUpdates = [];
  const mockQuery = async (text, params) => {
    if (text.includes('SELECT status FROM campaigns')) return { rows: [{ status: 'active' }] };
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: 'user-creator' }] };
    }
    if (text.includes('SELECT metadata FROM stellar_transactions')) {
      return { rows: [{ metadata: { platform_fee_amount: 0.15 } }] };
    }
    if (text === 'BEGIN') return { rows: [] };
    if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contrib-id' }] };
    if (text.includes('UPDATE stellar_transactions') && text.includes("kind = 'contribution'")) {
      stellarUpdates.push({ text, params });
      return { rows: [] };
    }
    if (text.includes('SELECT raised_amount FROM campaigns')) {
      return { rows: [{ raised_amount: '100' }] };
    }
    if (text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  const payment = {
    to: 'GWALLET',
    from: 'GFROM',
    type: 'payment',
    asset_type: 'native',
    amount: '1',
    transaction_hash: 'txhash-abc',
  };

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', payment);

  assert.equal(stellarUpdates.length, 1);
  assert.deepEqual(stellarUpdates[0].params, ['contrib-id', 'txhash-abc']);
  assert.equal(updates.length, 1);
  assert.match(updates[0].text, /raised_amount = raised_amount \+ \$1/);
  assert.match(updates[0].text, /WHEN raised_amount \+ \$1 >= target_amount THEN 'funded'/);
  assert.deepEqual(updates[0].params, [1, 'camp-1']);
});

test('handlePayment accepts contributions on funded campaigns', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status FROM campaigns')) return { rows: [{ status: 'funded' }] };
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: 'user-creator' }] };
    }
    if (text.includes('SELECT metadata FROM stellar_transactions')) {
      return { rows: [{ metadata: {} }] };
    }
    if (text === 'BEGIN') return { rows: [] };
    if (text.includes('INSERT INTO contributions')) {
      insertCalled = true;
      return { rows: [{ id: 'contrib-id' }] };
    }
    if (text.includes('SELECT raised_amount FROM campaigns')) {
      return { rows: [{ raised_amount: '110' }] };
    }
    if (text === 'COMMIT') return { rows: [] };
    return { rows: [] };
  };

  const { ledgerMonitor } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GFROM',
    type: 'payment',
    asset_type: 'native',
    amount: '10',
    transaction_hash: 'txhash-overfund',
  });

  assert.equal(insertCalled, true);
});

test('handlePayment binds exactly as many params as INSERT placeholders and persists fee + display name', async () => {
  let insert;
  const mockQuery = async (text, params) => {
    if (text.includes('SELECT status FROM campaigns')) return { rows: [{ status: 'active' }] };
    if (text.includes('SELECT creator_id FROM campaigns')) return { rows: [{ creator_id: 'user-creator' }] };
    if (text.includes('SELECT id FROM contributions WHERE tx_hash')) return { rows: [] };
    if (text.includes("FROM stellar_transactions") && text.includes("kind = 'contribution'")) {
      return { rows: [{ metadata: { platform_fee_amount: 0.15, display_name: 'Ada' } }] };
    }
    if (text.includes('INSERT INTO contributions')) {
      insert = { text, params };
      return { rows: [{ id: 'contrib-id' }] };
    }
    if (text.includes('SELECT raised_amount FROM campaigns')) return { rows: [{ raised_amount: '1' }] };
    return { rows: [] };
  };

  const { ledgerMonitor } = buildLedgerMonitor(mockQuery);
  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GFROM',
    type: 'payment',
    asset_type: 'native',
    amount: '1',
    transaction_hash: 'txhash-params',
  });

  const placeholders = new Set(insert.text.match(/\$\d+/g)).size;
  const columns = insert.text.match(/\(([^)]*)\)\s*VALUES/)[1].split(',').length;
  assert.equal(insert.params.length, placeholders);
  assert.equal(columns, placeholders);
  assert.equal(insert.params[14], 0.15);
  assert.equal(insert.params[15], 'Ada');
});

test('onPaymentRecord keeps the cursor put when indexing fails, and advances on success', async () => {
  const cursorSaves = [];
  let failInsert = true;
  const mockQuery = async (text, params) => {
    if (text.includes('SELECT status FROM campaigns')) return { rows: [{ status: 'active' }] };
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) return { rows: [{ creator_id: 'u' }] };
    if (text.includes('SELECT metadata FROM stellar_transactions')) return { rows: [{ metadata: {} }] };
    if (text.includes('INSERT INTO contributions')) {
      if (failInsert) throw new Error('boom');
      return { rows: [{ id: 'contrib-id' }] };
    }
    if (text.includes('INSERT INTO ledger_stream_cursors')) {
      cursorSaves.push(params[2]);
      return { rows: [] };
    }
    if (text.includes('SELECT raised_amount FROM campaigns')) return { rows: [{ raised_amount: '1' }] };
    return { rows: [] };
  };
  const { ledgerMonitor } = buildLedgerMonitor(mockQuery);
  const record = {
    to: 'GWALLET', from: 'GFROM', type: 'payment', asset_type: 'native', amount: '10',
    transaction_hash: 'tx-fail', paging_token: 'cursor-1',
  };
  const opts = { retryDelaysMs: [1, 1], replayDelayMs: 3600_000 };

  assert.equal(await ledgerMonitor.onPaymentRecord('camp-1', 'GWALLET', record, opts), false);
  assert.deepEqual(cursorSaves, []);

  // Wallet is stalled: a later successful stream record must not advance the cursor either.
  failInsert = false;
  const later = { ...record, transaction_hash: 'tx-ok', paging_token: 'cursor-2' };
  assert.equal(await ledgerMonitor.onPaymentRecord('camp-1', 'GWALLET', later, opts), true);
  assert.deepEqual(cursorSaves, []);

  // Replay path advances the cursor once the payment is indexed.
  assert.equal(await ledgerMonitor.onPaymentRecord('camp-1', 'GWALLET', record, { ...opts, replay: true }), true);
  assert.deepEqual(cursorSaves, ['cursor-1']);
});
