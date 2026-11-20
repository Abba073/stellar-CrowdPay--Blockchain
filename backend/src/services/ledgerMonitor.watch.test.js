const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

/**
 * Stub Horizon `server.payments()` builder: streams are recorded (and can be
 * closed); REST calls return `restRecords` (newest-first for order('desc')).
 */
function fakeServer({ restRecords = [] } = {}) {
  const streams = [];
  const restCalls = [];
  const server = {
    payments() {
      const q = { account: null, cursorValue: null, orderValue: 'asc' };
      const builder = {
        forAccount(a) {
          q.account = a;
          return builder;
        },
        cursor(c) {
          q.cursorValue = c;
          return builder;
        },
        order(o) {
          q.orderValue = o;
          return builder;
        },
        limit() {
          return builder;
        },
        async call() {
          restCalls.push({ ...q });
          return { records: q.orderValue === 'desc' ? restRecords : [] };
        },
        stream() {
          streams.push({ ...q });
          return () => {};
        },
      };
      return builder;
    },
  };
  return { server, streams, restCalls };
}

function load({ campaigns, cursors = {}, cursorDelayMs = 0, restRecords } = {}) {
  const saved = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const db = {
    query: async (text, params) => {
      if (text.includes('FROM campaigns WHERE status IN')) return { rows: campaigns };
      if (text.startsWith('SELECT last_cursor FROM ledger_stream_cursors')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (cursorDelayMs) await new Promise((r) => setTimeout(r, cursorDelayMs));
        inFlight -= 1;
        const c = cursors[params[0]];
        return { rows: c ? [{ last_cursor: c }] : [] };
      }
      if (text.includes('INSERT INTO ledger_stream_cursors')) {
        saved.push(params);
        cursors[params[0]] = params[2];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const horizon = fakeServer({ restRecords });
  const monitor = proxyquire('./ledgerMonitor', {
    '../config/database': db,
    '../config/stellar': { server: horizon.server },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    './stellarTransactionService': { markContributionIndexed: async () => {} },
    './emailService': { sendContributionReceipt: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, emitWebhookEventForCampaign: async () => {}, WEBHOOK_EVENTS: {} },
    './alerting': { sendAlert: async () => {} },
    '@sentry/node': { captureException: () => {} },
  });
  return { monitor, horizon, saved, stats: () => ({ maxInFlight }) };
}

function campaignsN(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, wallet_public_key: `G${i}` }));
}

function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    process.env = saved;
  });
}

test('startup opens wallet watches with bounded concurrency', () =>
  withEnv({ LEDGER_WATCH_CONCURRENCY: '3', LEDGER_WATCH_STAGGER_MS: '1', LEDGER_MAX_STREAMS: '100' }, async () => {
    const { monitor, horizon, stats } = load({ campaigns: campaignsN(12), cursorDelayMs: 15 });
    await monitor.startLedgerMonitor();
    assert.equal(horizon.streams.length, 12);
    assert.ok(stats().maxInFlight <= 3, `max in flight ${stats().maxInFlight}`);
    assert.ok(stats().maxInFlight >= 2, 'actually runs in parallel');
  }));

test('beyond LEDGER_MAX_STREAMS wallets are polled, with a cursor seeded at the newest payment', () =>
  withEnv({ LEDGER_WATCH_CONCURRENCY: '1', LEDGER_WATCH_STAGGER_MS: '1', LEDGER_MAX_STREAMS: '2' }, async () => {
    const { monitor, horizon, saved } = load({
      campaigns: campaignsN(5),
      restRecords: [{ paging_token: 'pt-newest' }],
    });
    await monitor.startLedgerMonitor();
    assert.equal(horizon.streams.length, 2, 'only two SSE streams');
    // c2..c4 had no cursor: seeded from the newest payment, like a stream at "now".
    assert.deepEqual(
      saved.map((p) => [p[0], p[2]]),
      [['c2', 'pt-newest'], ['c3', 'pt-newest'], ['c4', 'pt-newest']]
    );
    const health = await monitor.getLedgerStreamHealth();
    assert.equal(health.streams_open, 2);
    assert.equal(health.wallets_polled, 3);
  }));

test('pollWalletsOnce catches polled wallets up from their cursor, round-robin in batches', () =>
  withEnv({ LEDGER_WATCH_CONCURRENCY: '1', LEDGER_WATCH_STAGGER_MS: '1', LEDGER_MAX_STREAMS: '1' }, async () => {
    const { monitor, horizon } = load({
      campaigns: campaignsN(4),
      cursors: { c1: 'cur-1', c2: 'cur-2', c3: 'cur-3' },
    });
    await monitor.startLedgerMonitor();
    horizon.restCalls.length = 0;

    assert.equal(await monitor.pollWalletsOnce({ pollBatchSize: 2 }), 2);
    assert.deepEqual(horizon.restCalls.map((c) => [c.account, c.cursorValue]), [['G1', 'cur-1'], ['G2', 'cur-2']]);

    horizon.restCalls.length = 0;
    await monitor.pollWalletsOnce({ pollBatchSize: 2 });
    assert.deepEqual(horizon.restCalls.map((c) => c.account), ['G3', 'G1']);
  }));

test('watch limits are env-tunable with safe fallbacks', () =>
  withEnv({ LEDGER_WATCH_CONCURRENCY: '7', LEDGER_MAX_STREAMS: 'lots' }, () => {
    const { monitor } = load({ campaigns: [] });
    const config = monitor.getWatchConfig();
    assert.equal(config.concurrency, 7);
    assert.equal(config.maxStreams, 200);
  }));
