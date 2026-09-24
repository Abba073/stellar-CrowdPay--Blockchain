const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

// Minimal stateful fake covering only the statements these services issue.
function makeFakeDb() {
  const state = {
    users: { 'user-1': { wallet_public_key: 'GOLD' } },
    keys: [], // { public_key, user_id, retired_at }
    contributions: [
      { id: 'c-old', sender_public_key: 'GOLD', amount: '5', asset: 'USDC', campaign_id: 'camp-1' },
      { id: 'c-new', sender_public_key: 'GNEW', amount: '7', asset: 'USDC', campaign_id: 'camp-1' },
      { id: 'c-other', sender_public_key: 'GSTRANGER', amount: '9', asset: 'USDC', campaign_id: 'camp-1' },
    ],
  };
  const keysOf = (userId) => state.keys.filter((k) => k.user_id === userId).map((k) => k.public_key);

  async function query(text, params = []) {
    if (text.includes('SELECT wallet_public_key FROM users')) {
      const u = state.users[params[0]];
      return { rows: u ? [{ wallet_public_key: u.wallet_public_key }] : [] };
    }
    if (text.includes('INSERT INTO user_wallet_keys')) {
      const existing = state.keys.find((k) => k.public_key === params[0]);
      const retired = text.includes('NOW()') && text.includes('VALUES ($1, $2, NOW())') ? 'now' : null;
      if (existing) existing.retired_at = retired;
      else state.keys.push({ public_key: params[0], user_id: params[1], retired_at: retired });
      return { rows: [] };
    }
    if (text.startsWith('UPDATE users SET wallet_public_key')) {
      state.users[params[2]].wallet_public_key = params[0];
      return { rows: [] };
    }
    if (text.includes('FROM contributions ctr')) {
      const [userId, currentKey] = params;
      const allowed = new Set([currentKey, ...keysOf(userId)]);
      return { rows: state.contributions.filter((c) => allowed.has(c.sender_public_key)) };
    }
    if (text.includes('FROM contributions c') && text.includes('refund_destination_key')) {
      const rows = state.contributions.map((c) => {
        const k = state.keys.find((x) => x.public_key === c.sender_public_key);
        const dest = k ? state.users[k.user_id].wallet_public_key : c.sender_public_key;
        return { ...c, refund_destination_key: dest };
      });
      return { rows };
    }
    throw new Error(`unexpected query: ${text.slice(0, 60)}`);
  }
  return { state, db: { query } };
}

test('rotating a wallet key preserves contribution history', async () => {
  const { db } = makeFakeDb();
  const { rotateUserWalletKey } = proxyquire('./walletKeyHistory', { '../config/database': db });
  const { listUserContributions } = proxyquire('./userDashboardService', { '../config/database': db });

  const before = await listUserContributions('user-1');
  assert.deepEqual(before.map((r) => r.id), ['c-old']);

  const result = await rotateUserWalletKey({ userId: 'user-1', newPublicKey: 'GNEW' });
  assert.deepEqual(result, { oldPublicKey: 'GOLD', newPublicKey: 'GNEW' });

  const after = await listUserContributions('user-1');
  assert.deepEqual(after.map((r) => r.id).sort(), ['c-new', 'c-old']);
});

test('rotation is a no-op for the same key and returns null for unknown users', async () => {
  const { db, state } = makeFakeDb();
  const { rotateUserWalletKey } = proxyquire('./walletKeyHistory', { '../config/database': db });
  await rotateUserWalletKey({ userId: 'user-1', newPublicKey: 'GOLD' });
  assert.equal(state.keys.length, 0);
  assert.equal(await rotateUserWalletKey({ userId: 'nobody', newPublicKey: 'GX' }), null);
});

test('refunds for contributions made with a retired key address the current key', async () => {
  const { db } = makeFakeDb();
  const { rotateUserWalletKey } = proxyquire('./walletKeyHistory', { '../config/database': db });
  await rotateUserWalletKey({ userId: 'user-1', newPublicKey: 'GNEW' });

  const built = [];
  const inserted = [];
  const actions = proxyquire('./campaignStatusActions', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('SELECT id, wallet_public_key, status, creator_id FROM campaigns')) {
          return { rows: [{ id: params[0], wallet_public_key: 'GCAMP', status: 'failed', creator_id: 'creator-1' }] };
        }
        return db.query(text, params);
      },
      connect: async () => ({
        query: async (text, params) => {
          if (text.includes('INSERT INTO withdrawal_requests')) {
            inserted.push(params[3]);
            return { rows: [{ id: `wr-${inserted.length}` }] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './emailService': { sendEmail: async () => {} },
    './notifications': { createNotification: async () => {} },
    './webhookDispatcher': { WEBHOOK_EVENTS: {}, emitWebhookEventForUser: async () => {}, emitWebhookEventForCampaign: async () => {} },
    './stellarService': {
      buildWithdrawalTransaction: async ({ destinationPublicKey }) => {
        built.push(destinationPublicKey);
        return 'xdr';
      },
    },
    './stellarTransactionService': { insertWithdrawalPendingSignatures: async () => 'tx-row' },
    './sorobanService': { invokeContract: async () => 0 },
  });

  const out = await actions.queueFailedCampaignRefunds('camp-1', 'admin-1');
  assert.equal(out.refundsCreated, 3);
  // old-key contribution -> current key; current-key contribution unchanged; unknown sender untouched
  assert.deepEqual(built, ['GNEW', 'GNEW', 'GSTRANGER']);
  assert.deepEqual(inserted, ['GNEW', 'GNEW', 'GSTRANGER']);
});
