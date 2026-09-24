const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const USDC_ISSUER = 'GCNHZWKLBXF3VEDEF35O4OFHHSHOTZ6DJJERDEJETZ2ROHZTDP6MCP77';

function buildLedgerMonitor(mockQuery, { configuredAssets } = {}) {
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
    '../config/stellar': {
      server: {},
      configuredAssets: configuredAssets || {
        XLM:  { type: 'native' },
        USDC: { type: 'credit_alphanum4', issuer: USDC_ISSUER },
      },
    },
    './stellarService': { getCampaignBalance: async () => ({}) },
    './webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: { CAMPAIGN_FUNDED: 'campaign.funded', CONTRIBUTION_RECEIVED: 'contribution.received', CONTRIBUTION_INDEXED: 'contribution.indexed' },
    },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async () => {},
    },
    './emailService': { sendContributionReceipt: async () => {} },
    './stellarTransactionService': { markContributionIndexed: async () => {} },
    '../utils/cache': { invalidate: () => {}, invalidatePrefix: () => {} },
  });

  return { ledgerMonitor, updates };
}

/**
 * Build a standard mockQuery suitable for tests that expect the payment to
 * pass all validations and be credited.  Override individual branches as
 * needed by providing a wrapping function.
 */
function happyPathQuery({ status = 'active', assetType = 'XLM', txHash = 'txhash-abc' } = {}) {
  return async (text, params) => {
    // New broader campaign SELECT (status + validation fields)
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status,
          asset_type: assetType,
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    // Intent check
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    // Per-user cap query
    if (text.includes('COALESCE(SUM(amount)') && text.includes('FROM contributions')) {
      return { rows: [{ total: '0' }] };
    }
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: 'user-creator' }] };
    }
    if (text.includes('SELECT metadata FROM stellar_transactions')) {
      return { rows: [{ metadata: { platform_fee_amount: 0.15 } }] };
    }
    if (text === 'BEGIN') return { rows: [] };
    if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contrib-id' }] };
    if (text.includes('SELECT raised_amount FROM campaigns') || text.includes('SELECT raised_amount, status FROM campaigns')) {
      return { rows: [{ raised_amount: '100', status }] };
    }
    if (text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  };
}

// ---------------------------------------------------------------------------
// Original tests (updated to supply new campaign fields and intent record)
// ---------------------------------------------------------------------------

test('handlePayment updates stellar_transactions when a contribution row is created', async () => {
  const markedCalls = [];
  const stellarUpdates = [];
  const mockQuery = async (text, params) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    if (text.includes('COALESCE(SUM(amount)')) return { rows: [{ total: '0' }] };
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
    if (text.includes('SELECT raised_amount')) {
      return { rows: [{ raised_amount: '100', status: 'active' }] };
    }
    if (text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  };

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
    connect: async () => ({ query: wrappedQuery, release: () => {} }),
  };

  const ledgerMonitor = proxyquire('./ledgerMonitor', {
    '../config/database': mockDb,
    '../config/stellar': {
      server: {},
      configuredAssets: {
        XLM:  { type: 'native' },
        USDC: { type: 'credit_alphanum4', issuer: USDC_ISSUER },
      },
    },
    './stellarService': { getCampaignBalance: async () => ({}) },
    './stellarTransactionService': {
      markContributionIndexed: async (client, txHash, contribId) => {
        markedCalls.push({ txHash, contribId });
      },
    },
    './webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: { CAMPAIGN_FUNDED: 'campaign.funded', CONTRIBUTION_RECEIVED: 'contribution.received', CONTRIBUTION_INDEXED: 'contribution.indexed' },
    },
    './campaignStatusActions': { triggerCampaignStatusActions: async () => {} },
    './emailService': { sendContributionReceipt: async () => {} },
    '../utils/cache': { invalidate: () => {}, invalidatePrefix: () => {} },
  });

  const payment = {
    to: 'GWALLET',
    from: 'GFROM',
    type: 'payment',
    asset_type: 'native',
    amount: '1',
    transaction_hash: 'txhash-abc',
  };

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', payment);

  assert.equal(markedCalls.length, 1, 'markContributionIndexed should be called once');
  assert.deepEqual(markedCalls[0], { txHash: 'txhash-abc', contribId: 'contrib-id' });
  assert.equal(updates.length, 1);
  assert.match(updates[0].text, /raised_amount = raised_amount \+ \$1/);
  assert.match(updates[0].text, /WHEN raised_amount \+ \$1 >= target_amount THEN 'funded'/);
  assert.deepEqual(updates[0].params, [1, 'camp-1']);
});

test('handlePayment accepts contributions on funded campaigns', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'funded',
          asset_type: 'XLM',
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    if (text.includes('COALESCE(SUM(amount)')) return { rows: [{ total: '0' }] };
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
    if (text.includes('SELECT raised_amount')) {
      return { rows: [{ raised_amount: '110', status: 'funded' }] };
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

// ---------------------------------------------------------------------------
// New tests: spoofed payment scenarios (#45)
// ---------------------------------------------------------------------------

test('handlePayment rejects payment with wrong asset code', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'USDC',           // campaign wants USDC
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GATTACKER',
    type: 'payment',
    asset_type: 'native',              // attacker sends XLM
    amount: '1000',
    transaction_hash: 'tx-spoof-asset',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment rejects USDC payment with wrong issuer', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'USDC',
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GATTACKER',
    type: 'payment',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GEVIL_ISSUER_NOT_REAL',  // wrong issuer
    amount: '100',
    transaction_hash: 'tx-spoof-issuer',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment rejects payment not in stellar_transactions (no intent)', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: null,
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    // Intent check returns empty — no matching stellar_transaction record
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GATTACKER',
    type: 'payment',
    asset_type: 'native',
    amount: '50',
    transaction_hash: 'tx-no-intent',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment rejects dust payment below min_contribution', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: '1',       // campaign minimum is 1 XLM
          max_contribution: null,
          max_per_user: null,
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GATTACKER',
    type: 'payment',
    asset_type: 'native',
    amount: '0.0000001',              // 1 stroop — below the 1 XLM minimum
    transaction_hash: 'tx-dust',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment rejects payment exceeding max_contribution', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: null,
          max_contribution: '100',    // campaign maximum is 100 XLM
          max_per_user: null,
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GCONTRIB',
    type: 'payment',
    asset_type: 'native',
    amount: '200',                   // exceeds max
    transaction_hash: 'tx-over-max',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment rejects payment that would exceed per-user cap', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: null,
          max_contribution: null,
          max_per_user: '50',         // user cap is 50 XLM
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    // User has already contributed 40 XLM
    if (text.includes('COALESCE(SUM(amount)') && text.includes('FROM contributions')) {
      return { rows: [{ total: '40' }] };
    }
    if (text.includes('INSERT INTO contributions')) { insertCalled = true; return { rows: [{ id: 'contrib-id' }] }; }
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GCONTRIB',
    type: 'payment',
    asset_type: 'native',
    amount: '20',                    // 40 + 20 = 60 > 50 cap
    transaction_hash: 'tx-per-user-cap',
  });

  assert.equal(updates.length, 0, 'raised_amount must not be updated');
  assert.equal(insertCalled, false, 'contribution must not be inserted');
});

test('handlePayment credits a valid USDC payment with correct issuer', async () => {
  let insertCalled = false;
  const mockQuery = happyPathQuery({ assetType: 'USDC' });
  const wrappedQuery = async (text, params) => {
    if (text.includes('INSERT INTO contributions')) {
      insertCalled = true;
      return { rows: [{ id: 'contrib-id' }] };
    }
    return mockQuery(text, params);
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(wrappedQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GCONTRIB',
    type: 'payment',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,       // correct issuer
    amount: '10',
    transaction_hash: 'tx-valid-usdc',
  });

  assert.equal(insertCalled, true, 'contribution should be inserted');
  assert.equal(updates.length, 1, 'raised_amount should be updated');
});

test('handlePayment credits a valid XLM payment within caps', async () => {
  let insertCalled = false;
  const mockQuery = async (text) => {
    if (text.includes('SELECT status') && text.includes('FROM campaigns')) {
      return {
        rows: [{
          status: 'active',
          asset_type: 'XLM',
          min_contribution: '1',
          max_contribution: '100',
          max_per_user: '200',
        }],
      };
    }
    if (text.includes('SELECT id FROM stellar_transactions') && text.includes("kind = 'contribution'")) {
      return { rows: [{ id: 'st-1' }] };
    }
    if (text.includes('COALESCE(SUM(amount)')) return { rows: [{ total: '50' }] };
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) return { rows: [{ creator_id: 'user-creator' }] };
    if (text.includes('SELECT metadata FROM stellar_transactions')) return { rows: [{ metadata: {} }] };
    if (text === 'BEGIN') return { rows: [] };
    if (text.includes('INSERT INTO contributions')) {
      insertCalled = true;
      return { rows: [{ id: 'contrib-id' }] };
    }
    if (text.includes('SELECT raised_amount')) return { rows: [{ raised_amount: '60', status: 'active' }] };
    if (text === 'COMMIT') return { rows: [] };
    return { rows: [] };
  };

  const { ledgerMonitor, updates } = buildLedgerMonitor(mockQuery);

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', {
    to: 'GWALLET',
    from: 'GCONTRIB',
    type: 'payment',
    asset_type: 'native',
    amount: '10',                    // min=1, max=100, user has 50, cap=200 → OK
    transaction_hash: 'tx-valid-xlm',
  });

  assert.equal(insertCalled, true, 'contribution should be inserted');
  assert.equal(updates.length, 1, 'raised_amount should be updated');
});
