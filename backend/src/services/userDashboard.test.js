const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('listCreatorCampaigns queries by creator_id', async () => {
  let sql = '';
  let params = null;
  const { listCreatorCampaigns } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text, p) => {
        sql = text;
        params = p;
        return { rows: [{ id: 'camp-1', title: 'Mine', status: 'active' }] };
      },
    },
  });

  const rows = await listCreatorCampaigns('user-1');
  assert.match(sql, /creator_id = \$1/);
  assert.deepEqual(params, ['user-1']);
  assert.equal(rows[0].title, 'Mine');
});

test('listUserContributions includes conversion_rate', async () => {
  let contributionSql = '';
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text) => {
        contributionSql = text;
        return {
          rows: [
            {
              user_exists: 1,
              id: 'ctr-1',
              amount: '10',
              asset: 'USDC',
              conversion_rate: '0.25',
              campaign_title: 'Test',
            },
          ],
        };
      },
    },
  });

  const rows = await listUserContributions('user-1');
  assert.match(contributionSql, /conversion_rate/);
  assert.equal(rows[0].conversion_rate, '0.25');
  assert.ok(!('user_exists' in rows[0]));
});

test('listUserContributions returns [] for an existing user with no contributions', async () => {
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      // LEFT JOIN with no matches: one row, contribution columns NULL.
      query: async () => ({ rows: [{ user_exists: 1, id: null }] }),
    },
  });
  assert.deepEqual(await listUserContributions('user-1'), []);
});

test('listUserContributions matches current and past wallet keys with an index-friendly ANY()', async () => {
  let sql = '';
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text) => {
        sql = text;
        return { rows: [] };
      },
    },
  });
  await listUserContributions('user-1');
  assert.match(sql, /user_wallet_keys WHERE user_id = \$1/);
  assert.match(sql, /sender_public_key = ANY\(keys\.list\)/);
  assert.doesNotMatch(sql, /\bOR\b/);
});

test('dashboard reads use a constant number of queries regardless of data volume', async () => {
  for (const n of [1, 10, 500]) {
    let calls = 0;
    const { listCreatorCampaigns, listUserContributions } = proxyquire('./userDashboardService', {
      '../config/database': {
        query: async (text) => {
          calls += 1;
          if (text.includes('FROM keys')) {
            return { rows: Array.from({ length: n }, (_, i) => ({ user_exists: 1, id: `ctr-${i}` })) };
          }
          return { rows: Array.from({ length: n }, (_, i) => ({ id: `camp-${i}`, contributor_count: i })) };
        },
      },
    });

    const campaigns = await listCreatorCampaigns('user-1');
    assert.equal(campaigns.length, n);
    assert.equal(calls, 1, `listCreatorCampaigns with ${n} campaigns`);

    calls = 0;
    const contributions = await listUserContributions('user-1');
    assert.equal(contributions.length, n);
    assert.equal(calls, 1, `listUserContributions with ${n} contributions`);
  }
});

test('listUserContributions returns null when user missing', async () => {
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async () => ({ rows: [] }),
    },
  });

  const rows = await listUserContributions('missing');
  assert.equal(rows, null);
});
