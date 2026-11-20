const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const request = require('supertest');

const mockSentry = {
  init: () => {},
  expressIntegration: () => ({}),
  sentryRequestMiddleware: () => (req, res, next) => next(),
  expressErrorHandler: () => (err, req, res, next) => next(err),
  setUser: () => {},
  Handlers: {
    requestHandler: () => (req, res, next) => next(),
    tracingHandler: () => (req, res, next) => next(),
    errorHandler: () => (err, req, res, next) => next(err),
  },
};

test('GET /health returns only ok status when database is reachable', async () => {
  const mockDb = {
    query: async (text) => {
      assert.equal(text, 'SELECT 1');
      return { rows: [] };
    },
    totalCount: 8,
    idleCount: 5,
    waitingCount: 1,
  };

  const app = proxyquire('../index', {
    './config/database': mockDb,
    '@sentry/node': mockSentry,
    // Stub background services to prevent them from executing or failing
    './services/ledgerMonitor': {
      startLedgerMonitor: () => {},
      getLedgerStreamHealth: async () => ({ status: 'healthy' }),
    },
    './services/webhookDispatcher': {
      startWebhookRetryPoller: () => {},
    },
    './services/campaignStatusService': {
      refreshActiveCampaignStatuses: async () => {},
    },
    './services/alerting': {
      sendAlert: () => {},
    },
    './services/walletSecrets': {
      assertNoLegacyPlaintextUserWalletSecrets: async () => {},
    },
  });

  const response = await request(app).get('/health');
  
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('GET /health returns 503 and error message when database query fails', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('Connection refused');
    },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };

  const app = proxyquire('../index', {
    './config/database': mockDb,
    '@sentry/node': mockSentry,
    './services/ledgerMonitor': {
      startLedgerMonitor: () => {},
    },
    './services/webhookDispatcher': {
      startWebhookRetryPoller: () => {},
    },
    './services/campaignStatusService': {
      refreshActiveCampaignStatuses: async () => {},
    },
    './services/alerting': {
      sendAlert: () => {},
    },
    './services/walletSecrets': {
      assertNoLegacyPlaintextUserWalletSecrets: async () => {},
    },
  });

  const response = await request(app).get('/health');
  
  assert.equal(response.status, 503);
  assert.equal(response.body.error?.message || response.body.error, 'Connection refused');
});
