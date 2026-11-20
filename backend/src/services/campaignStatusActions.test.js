const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildActions(overrides = {}) {
  const calls = {
    emails: [],
    userWebhooks: [],
    campaignWebhooks: [],
    notifications: [],
    refunds: [],
    statusEvents: [],
    alerts: [],
  };

  const actions = proxyquire('./campaignStatusActions', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('INSERT INTO campaign_status_events')) {
          const key = `${params[0]}:${params[2]}`;
          if (calls.statusEvents.includes(key)) {
            return { rows: [] };
          }
          calls.statusEvents.push(key);
          return { rows: [{ id: 'event-1' }] };
        }
        if (text.includes('DELETE FROM campaign_status_events')) {
          calls.statusEvents = [];
          return { rows: [] };
        }
        if (text.includes('FROM campaigns c') && text.includes('creator_email')) {
          return {
            rows: [{
              id: params[0],
              title: 'Test Campaign',
              status: 'funded',
              target_amount: '100',
              raised_amount: '100',
              deadline: '2026-06-01',
              wallet_public_key: 'GPK',
              escrow_contract_id: null,
              creator_id: 'creator-1',
              creator_email: 'creator@test.com',
              creator_name: 'Creator',
            }],
          };
        }
        if (text.includes('FROM contributions c') && text.includes('JOIN users u')) {
          return {
            rows: [{ id: 'contrib-user-1', email: 'backer@test.com', name: 'Backer' }],
          };
        }
        if (text.includes('SELECT id, wallet_public_key, status, creator_id FROM campaigns')) {
          return { rows: [{ id: params[0], wallet_public_key: 'GPK', status: 'failed', creator_id: 'creator-1' }] };
        }
        if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      ...(overrides.db || {}),
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './emailService': {
      sendEmail: async (payload) => {
        calls.emails.push(payload);
      },
      sendEmailSafe: async (payload) => {
        calls.emails.push(payload);
      },
    },
    './notifications': {
      createNotification: async (userId, payload) => {
        calls.notifications.push({ userId, ...payload });
      },
    },
    './webhookDispatcher': {
      WEBHOOK_EVENTS: {
        CAMPAIGN_FUNDED: 'campaign.funded',
        CAMPAIGN_FAILED: 'campaign.failed',
      },
      emitWebhookEventForUser: async (userId, event, payload) => {
        calls.userWebhooks.push({ userId, event, payload });
      },
      emitWebhookEventForCampaign: async (campaignId, event, payload) => {
        calls.campaignWebhooks.push({ campaignId, event, payload });
      },
    },
    './stellarService': {
      buildWithdrawalTransaction: async () => 'unsigned-xdr',
    },
    './stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
    './sorobanService': {
      invokeContract: async () => 0,
    },
    './alerting': {
      sendAlert: async (msg, ctx) => {
        calls.alerts.push({ msg, ctx });
      },
    },
    ...overrides.modules,
  });

  return { actions, calls };
}

test('triggerCampaignStatusActions sends funded lifecycle notifications once', async () => {
  const { actions, calls } = buildActions();

  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');
  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');

  assert.equal(calls.statusEvents.length, 1);
  assert.equal(calls.emails.length, 2);
  assert.ok(calls.emails.some((e) => e.to === 'creator@test.com'));
  assert.ok(calls.emails.some((e) => e.to === 'backer@test.com'));
  assert.equal(calls.userWebhooks.length, 1);
  assert.equal(calls.campaignWebhooks.length, 1);
  assert.equal(calls.notifications.length, 2);
});

test('triggerCampaignStatusActions sends failed emails with refund instructions', async () => {
  const { actions, calls } = buildActions({
    db: {
      query: async (text, params) => {
        if (text.includes('INSERT INTO campaign_status_events')) {
          return { rows: [{ id: 'event-failed' }] };
        }
        if (text.includes('FROM campaigns c') && text.includes('creator_email')) {
          return {
            rows: [{
              id: params[0],
              title: 'Missed Goal',
              status: 'failed',
              target_amount: '100',
              raised_amount: '40',
              deadline: '2026-06-01',
              wallet_public_key: 'GPK',
              escrow_contract_id: null,
              creator_id: 'creator-1',
              creator_email: 'creator@test.com',
              creator_name: 'Creator',
            }],
          };
        }
        if (text.includes('JOIN users u')) {
          return { rows: [{ id: 'contrib-user-1', email: 'backer@test.com', name: 'Backer' }] };
        }
        if (text.includes('SELECT id, wallet_public_key, status, creator_id FROM campaigns')) {
          return { rows: [{ id: params[0], wallet_public_key: 'GPK', status: 'failed', creator_id: 'creator-1' }] };
        }
        if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
          return {
            rows: [{
              id: 'contrib-1',
              sender_public_key: 'GSENDER',
              amount: '10',
              asset: 'USDC',
            }],
          };
        }
        if (text.includes('INSERT INTO withdrawal_requests')) {
          return { rows: [{ id: 'wr-1' }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (text) => {
          if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
          if (text.includes('INSERT INTO withdrawal_requests')) return { rows: [{ id: 'wr-1' }] };
          if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
          return { rows: [] };
        },
        release: () => {},
      }),
    },
  });

  await actions.triggerCampaignStatusActions({ id: 'camp-2', status: 'failed' }, 'active');

  const backerEmail = calls.emails.find((e) => e.to === 'backer@test.com');
  assert.ok(backerEmail);
  assert.match(backerEmail.text, /refund/i);
  assert.match(backerEmail.text, /refund=1/);
  assert.equal(calls.userWebhooks[0].event, 'campaign.failed');
  assert.equal(calls.campaignWebhooks[0].event, 'campaign.failed');
});

test('recordStatusTransition is idempotent via unique constraint', async () => {
  const { actions, calls } = buildActions();

  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');
  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');

  assert.equal(calls.emails.length, 2);
});

test('downstream failure triggers alert and does not suppress subsequent replay', async () => {
  let failFirstTime = true;
  const { actions, calls } = buildActions({
    modules: {
      './emailService': {
        sendEmail: async (payload) => {
          if (failFirstTime) {
            throw new Error('Simulated email service failure');
          }
          calls.emails.push(payload);
        },
        sendEmailSafe: async (payload) => {
          if (failFirstTime) {
            throw new Error('Simulated email service failure');
          }
          calls.emails.push(payload);
        },
      },
    },
  });

  // First attempt should fail downstream and throw
  await assert.rejects(
    async () => {
      await actions.triggerCampaignStatusActions({ id: 'camp-fail-1', status: 'funded' }, 'active');
    },
    /Simulated email service failure/
  );

  // Alert must have been sent
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0].msg, /failed/i);

  // Status event must have been cleared from calls.statusEvents so replay is not suppressed
  assert.equal(calls.statusEvents.length, 0);

  // Replay should now succeed
  failFirstTime = false;
  await actions.triggerCampaignStatusActions({ id: 'camp-fail-1', status: 'funded' }, 'active');

  assert.equal(calls.statusEvents.length, 1);
  assert.equal(calls.emails.length, 2);
});

