const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('refreshActiveCampaignStatuses marks funded and failed campaigns and triggers actions', async () => {
  const queries = [];
  const triggered = [];
  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        queries.push(text);
        if (text.includes("SET status = 'funded'")) {
          return { rows: [{ id: 'funded-1', status: 'funded' }] };
        }
        if (text.includes("SET status = 'failed'")) {
          return { rows: [{ id: 'failed-1', status: 'failed' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const result = await refreshActiveCampaignStatuses();
  assert.equal(result.funded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(triggered.length, 2);
  assert.ok(queries.some((q) => q.includes("SET status = 'funded'")));
  assert.ok(queries.some((q) => q.includes("SET status = 'failed'")));
});

test('refreshActiveCampaignStatuses skips a concurrent run while one is in flight', async () => {
  let releaseFirstRun;
  const firstRunGate = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });
  let fundedQueryCount = 0;
  const triggered = [];

  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes("SET status = 'funded'")) {
          fundedQueryCount += 1;
          await firstRunGate;
          return { rows: [{ id: 'funded-1', status: 'funded' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const firstRun = refreshActiveCampaignStatuses();
  const secondRun = await refreshActiveCampaignStatuses();

  assert.equal(secondRun.skipped, true);
  assert.deepEqual(secondRun.funded, []);
  assert.deepEqual(secondRun.failed, []);
  assert.equal(fundedQueryCount, 1);
  assert.equal(triggered.length, 0);

  releaseFirstRun();
  const firstResult = await firstRun;

  assert.equal(firstResult.funded.length, 1);
  assert.equal(triggered.length, 1);
});

test('refreshActiveCampaignStatuses releases the guard after completion', async () => {
  let fundedQueryCount = 0;
  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes("SET status = 'funded'")) {
          fundedQueryCount += 1;
          return { rows: [{ id: `funded-${fundedQueryCount}`, status: 'funded' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async () => {},
    },
  });

  const firstResult = await refreshActiveCampaignStatuses();
  assert.equal(firstResult.skipped, undefined);
  assert.equal(firstResult.funded.length, 1);

  const secondResult = await refreshActiveCampaignStatuses();
  assert.equal(secondResult.skipped, undefined);
  assert.equal(secondResult.funded.length, 1);
  assert.equal(fundedQueryCount, 2);
});

test('refreshActiveCampaignStatuses releases the guard after an error', async () => {
  let shouldThrow = true;
  let fundedQueryCount = 0;
  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes("SET status = 'funded'")) {
          fundedQueryCount += 1;
          if (shouldThrow) throw new Error('db down');
          return { rows: [{ id: 'funded-1', status: 'funded' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async () => {},
    },
  });

  await assert.rejects(() => refreshActiveCampaignStatuses(), /db down/);

  shouldThrow = false;
  const result = await refreshActiveCampaignStatuses();
  assert.equal(result.skipped, undefined);
  assert.equal(result.funded.length, 1);
  assert.equal(fundedQueryCount, 2);
});

test('refreshCampaignStatus updates a single campaign and triggers actions', async () => {
  const triggered = [];
  const { refreshCampaignStatus } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text, params) => {
        assert.equal(params[0], 'camp-uuid');
        if (text.includes("SET status = 'failed'")) return { rows: [] };
        if (text.includes("SET status = 'funded'")) {
          return { rows: [{ id: 'camp-uuid', status: 'funded' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const result = await refreshCampaignStatus('camp-uuid');
  assert.equal(result.funded?.status, 'funded');
  assert.equal(result.failed, null);
  assert.equal(triggered.length, 1);
});
