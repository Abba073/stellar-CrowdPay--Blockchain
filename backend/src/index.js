require('dotenv').config();
require('./config/env').validateEnv();

const Sentry = require('@sentry/node');

function resolveTracesSampleRate() {
  const fallback = process.env.NODE_ENV === 'production' ? 0.2 : 1.0;
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function stripQueryString(url) {
  if (typeof url !== 'string') return url;
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

const PII_HEADER_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
];

function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const scrubbed = {};
  for (const [key, value] of Object.entries(headers)) {
    if (PII_HEADER_KEYS.includes(String(key).toLowerCase())) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function scrubTransactionEvent(event) {
  if (!event || typeof event !== 'object') return event;

  if (event.request) {
    if (event.request.url) event.request.url = stripQueryString(event.request.url);
    if (event.request.query_string) delete event.request.query_string;
    if (event.request.headers) event.request.headers = scrubHeaders(event.request.headers);
    if (event.request.cookies) delete event.request.cookies;
    if (event.request.data) delete event.request.data;
  }

  if (event.transaction) event.transaction = stripQueryString(event.transaction);
  if (event.transaction_info && event.transaction_info.source) {
    // keep source metadata but ensure no query params leak through
    event.transaction_info.source = stripQueryString(event.transaction_info.source);
  }

  if (event.user) {
    event.user = {
      id: event.user.id,
    };
  }

  if (Array.isArray(event.spans)) {
    event.spans = event.spans.map((span) => {
      if (!span || typeof span !== 'object') return span;
      const cleaned = { ...span };
      if (cleaned.description) cleaned.description = stripQueryString(cleaned.description);
      if (cleaned.op && typeof cleaned.op === 'string') {
        cleaned.op = stripQueryString(cleaned.op);
      }
      if (cleaned.data && typeof cleaned.data === 'object') {
        const data = { ...cleaned.data };
        delete data['http.query'];
        delete data['http.fragment'];
        delete data['http.request.query'];
        delete data['http.request.cookies'];
        delete data['http.request.headers'];
        delete data['http.response.headers'];
        delete data['user.id'];
        delete data['campaign.id'];
        delete data['campaignId'];
        delete data['userId'];
        if (typeof data.url === 'string') data.url = stripQueryString(data.url);
        if (typeof data['http.url'] === 'string') data['http.url'] = stripQueryString(data['http.url']);
        if (typeof data['http.target'] === 'string') data['http.target'] = stripQueryString(data['http.target']);
        cleaned.data = data;
      }
      return cleaned;
    });
  }

  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: resolveTracesSampleRate(),
  enabled: !!process.env.SENTRY_DSN,
  integrations: [Sentry.expressIntegration()],
  beforeSendTransaction: scrubTransactionEvent,
});

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const logger = require('./config/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const { originCheck } = require('./middleware/originCheck');
const { normalizeErrorResponse, errorHandler, sendErrorResponse } = require('./middleware/errorHandler');
const { startLedgerMonitor, getLedgerStreamHealth } = require('./services/ledgerMonitor');
const { refreshActiveCampaignStatuses } = require('./services/campaignStatusService');
const { sendAlert } = require('./services/alerting');
const { assertNoLegacyPlaintextUserWalletSecrets } = require('./services/walletSecrets');
const db = require('./config/database');
const { getPlatformFeeBps } = require('./utils/amounts');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const rateLimit = require('express-rate-limit');
const { jsonBody } = require('./middleware/bodyLimits');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(
  express.json({
    limit: '50kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());
app.use(Sentry.sentryRequestMiddleware ? Sentry.sentryRequestMiddleware() : (req, res, next) => next());
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(normalizeErrorResponse);

const isTest = process.env.NODE_ENV === 'test';
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => {
    if (isTest) return true;
    const isPost = req.method === 'POST';
    const p = req.path || '';
    if (!isPost) return false;
    return (
      p === '/auth/register' ||
      p === '/auth/login'
    );
  },
});
app.use('/api', globalApiLimiter);
app.use('/api', originCheck);

// Swagger is the single source of truth for the API surface. The spec is
// assembled from the JSDoc annotations in the route files so that the docs
// served at /api/docs cannot drift from the implemented routes.
const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CrowdPay API',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
});

// Docs are gated: enabled only when ENABLE_API_DOCS is explicitly truthy, or
// (when the flag is unset) only outside production. This keeps the public
// /api/docs surface closed by default in production deployments.
function isApiDocsEnabled() {
  const flag = process.env.ENABLE_API_DOCS;
  if (flag !== undefined && flag !== '') {
    return flag === 'true' || flag === '1';
  }
  return process.env.NODE_ENV !== 'production';
}

if (isApiDocsEnabled()) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
} else {
  app.use('/api/docs', (req, res) => {
    sendErrorResponse(res, 404, 'Not found');
  });
}

// Text-heavy routes get a tighter JSON body limit (10kb). These parsers are
// mounted before the route handlers so oversized payloads consistently 413.
const textBody = jsonBody({ limit: '10kb' });

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/campaigns', textBody, require('./routes/campaignUpdates'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/anchor', require('./routes/anchor'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/admin', textBody, require('./routes/admin'));
app.use('/api/api-keys', require('./routes/apiKeys'));
app.use('/api/webhooks', textBody, require('./routes/webhooks'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api', require('./routes/disputes'));
app.use('/api/notifications', require('./routes/notifications'));

app.get('/health', async (_, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    sendErrorResponse(res, 503, err.message, undefined, undefined, { status: 'error' });
  }
});
app.get('/api/config', (_, res) =>
  res.json({ platform_fee_bps: getPlatformFeeBps() })
);

// Public platform stats — used on the hero / landing section.
// Cached for 60 s; invalidated by ledgerMonitor after each indexed contribution.
const cache = require('./utils/cache');
const STATS_CACHE_KEY = 'stats:public';
app.get('/api/stats', async (_req, res) => {
  const cached = cache.get(STATS_CACHE_KEY);
  if (cached) return res.json(cached);

  try {
const db = require('./config/database');
    const [campaigns, raised, contributions] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total
                FROM campaigns
                WHERE deleted_at IS NULL AND status NOT IN ('draft', 'failed')`),
      db.query(`SELECT COALESCE(SUM(raised_amount), 0)::numeric AS total
                FROM campaigns
                WHERE deleted_at IS NULL`),
      db.query(`SELECT COUNT(*)::int AS total FROM contributions`),
    ]);

    const payload = {
      total_campaigns: campaigns.rows[0].total,
      total_raised: parseFloat(raised.rows[0].total),
      total_contributions: contributions.rows[0].total,
    };

    cache.set(STATS_CACHE_KEY, payload, 60_000); // 60 s TTL
    res.json(payload);
  } catch (err) {
    logger.error('Failed to fetch public stats', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch stats');
  }
});

app.get('/health/ledger', async (_req, res) => {
  try {
    const body = await getLedgerStreamHealth();
    res.json(body);
  } catch (err) {
    sendAlert('Ledger health check failed', {
      alert_key: 'ledger_health',
      fingerprint: 'health/ledger',
      severity: 'critical',
      error: err.message,
    });
    sendErrorResponse(res, 500, err.message || 'ledger health failed');
  }
});

if (process.env.SERVE_FRONTEND === 'true') {
  const dist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use(Sentry.expressErrorHandler());
app.use(errorHandler);

const { startWebhookRetryPoller } = require('./services/webhookDispatcher');

const PORT = process.env.PORT || 3001;

function startCampaignStatusCron() {
  if (process.env.ENABLE_CAMPAIGN_STATUS_CRON === 'false') return;
  const cron = require('node-cron');
  cron.schedule('0 * * * *', () => {
    refreshActiveCampaignStatuses().catch((err) => {
      logger.error('Campaign status cron failed', { error: err.message });
    });
  });
  logger.info('Campaign status cron scheduled (hourly)');
}

function startReconciliationCron() {
  if (process.env.ENABLE_RECONCILIATION_CRON === 'false') return;
  const cron = require('node-cron');
  const { reconcileCampaignBalances } = require('./services/reconciliation');
  cron.schedule('*/15 * * * *', () => {
    reconcileCampaignBalances().catch((err) => {
      logger.error('Reconciliation cron failed', { error: err.message });
    });
  });
  logger.info('Reconciliation cron scheduled (every 15 minutes)');
}

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    await assertNoLegacyPlaintextUserWalletSecrets();
  }

  app.listen(PORT, () => {
    logger.info('CrowdPay backend running', { port: PORT, stellar_network: process.env.STELLAR_NETWORK });
    startLedgerMonitor();
    startWebhookRetryPoller();
    startCampaignStatusCron();
    startReconciliationCron();
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error('Backend bootstrap failed', { error: err.message });
    sendAlert('Backend bootstrap failed', {
      alert_key: 'backend_bootstrap',
      fingerprint: 'startup/bootstrap',
      severity: 'warning',
      error: err.message,
    });
    process.exit(1);
  });
}

module.exports = app;
module.exports.openApiSpec = openApiSpec;
require('dotenv').config();
require('./config/env').validateEnv();

const Sentry = require('@sentry/node');

function resolveTracesSampleRate() {
  const fallback = process.env.NODE_ENV === 'production' ? 0.2 : 1.0;
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function stripQueryString(url) {
  if (typeof url !== 'string') return url;
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

const PII_HEADER_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
];

function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const scrubbed = {};
  for (const [key, value] of Object.entries(headers)) {
    if (PII_HEADER_KEYS.includes(String(key).toLowerCase())) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function scrubTransactionEvent(event) {
  if (!event || typeof event !== 'object') return event;

  if (event.request) {
    if (event.request.url) event.request.url = stripQueryString(event.request.url);
    if (event.request.query_string) delete event.request.query_string;
    if (event.request.headers) event.request.headers = scrubHeaders(event.request.headers);
    if (event.request.cookies) delete event.request.cookies;
    if (event.request.data) delete event.request.data;
  }

  if (event.transaction) event.transaction = stripQueryString(event.transaction);
  if (event.transaction_info && event.transaction_info.source) {
    // keep source metadata but ensure no query params leak through
    event.transaction_info.source = stripQueryString(event.transaction_info.source);
  }

  if (event.user) {
    event.user = {
      id: event.user.id,
    };
  }

  if (Array.isArray(event.spans)) {
    event.spans = event.spans.map((span) => {
      if (!span || typeof span !== 'object') return span;
      const cleaned = { ...span };
      if (cleaned.description) cleaned.description = stripQueryString(cleaned.description);
      if (cleaned.op && typeof cleaned.op === 'string') {
        cleaned.op = stripQueryString(cleaned.op);
      }
      if (cleaned.data && typeof cleaned.data === 'object') {
        const data = { ...cleaned.data };
        delete data['http.query'];
        delete data['http.fragment'];
        delete data['http.request.query'];
        delete data['http.request.cookies'];
        delete data['http.request.headers'];
        delete data['http.response.headers'];
        delete data['user.id'];
        delete data['campaign.id'];
        delete data['campaignId'];
        delete data['userId'];
        if (typeof data.url === 'string') data.url = stripQueryString(data.url);
        if (typeof data['http.url'] === 'string') data['http.url'] = stripQueryString(data['http.url']);
        if (typeof data['http.target'] === 'string') data['http.target'] = stripQueryString(data['http.target']);
        cleaned.data = data;
      }
      return cleaned;
    });
  }

  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: resolveTracesSampleRate(),
  enabled: !!process.env.SENTRY_DSN,
  integrations: [Sentry.expressIntegration()],
  beforeSendTransaction: scrubTransactionEvent,
});

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const logger = require('./config/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const { originCheck } = require('./middleware/originCheck');
const { normalizeErrorResponse, errorHandler } = require('./middleware/errorHandler');
const { startLedgerMonitor, getLedgerStreamHealth } = require('./services/ledgerMonitor');
const { refreshActiveCampaignStatuses } = require('./services/campaignStatusService');
const { sendAlert } = require('./services/alerting');
const { assertNoLegacyPlaintextUserWalletSecrets } = require('./services/walletSecrets');
const db = require('./config/database');
const { getPlatformFeeBps } = require('./utils/amounts');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const rateLimit = require('express-rate-limit');
const { jsonBody } = require('./middleware/bodyLimits');

const app = express();

// Trust the number of reverse-proxy hops specified by TRUST_PROXY (default 1
// for the single nginx hop in docker-compose). This makes express-rate-limit
// and req.ip key on the real client IP instead of the proxy address.
// Set to 0 (or 'false') to disable when running without a proxy.
(function configureTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === null || raw === '') {
    app.set('trust proxy', 1);
    return;
  }
  const asStr = String(raw).trim();
  if (asStr === 'false' || asStr === '0') {
    // Explicitly disabled — do not trust any proxy
    return;
  }
  const asInt = parseInt(asStr, 10);
  if (!Number.isNaN(asInt)) {
    app.set('trust proxy', asInt);
    return;
  }
  // Accept comma-separated IP list or single IP/CIDR string
  app.set('trust proxy', asStr);
})();

/**
 * Build the CORS origin function from the FRONTEND_URLS env var.
 *
 * FRONTEND_URLS is a comma-separated list of allowed origins, e.g.:
 *   FRONTEND_URLS=http://localhost:5173,https://app.crowdpay.io,https://staging.crowdpay.io
 *
 * For backward-compatibility, if FRONTEND_URLS is not set we fall back to the
 * single FRONTEND_URL value (or the hard-coded localhost default). The origin
 * function reflects the requesting origin when it is in the allowlist and
 * rejects it otherwise — never responding with a wildcard when credentials are
 * enabled.
 */
function buildAllowedOrigins() {
  const raw = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173';
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const allowedOrigins = buildAllowedOrigins();

function corsOriginHandler(origin, callback) {
  // Non-browser clients (API consumers, server-to-server) omit the Origin
  // header; allow them through.
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, origin);
  callback(new Error(`Origin ${origin} is not allowed by CORS`));
}

app.use(helmet());
app.use(
  cors({
    origin: corsOriginHandler,
    credentials: true,
  })
);
app.use(
  express.json({
    limit: '50kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());
app.use(Sentry.sentryRequestMiddleware ? Sentry.sentryRequestMiddleware() : (req, res, next) => next());
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(normalizeErrorResponse);

const isTest = process.env.NODE_ENV === 'test';
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => {
    if (isTest) return true;
    const isPost = req.method === 'POST';
    const p = req.path || '';
    if (!isPost) return false;
    return (
      p === '/auth/register' ||
      p === '/auth/login'
    );
  },
});
app.use('/api', globalApiLimiter);
app.use('/api', originCheck);

// Swagger is the single source of truth for the API surface. The spec is
// assembled from the JSDoc annotations in the route files so that the docs
// served at /api/docs cannot drift from the implemented routes.
const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CrowdPay API',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
});

// Docs are gated: enabled only when ENABLE_API_DOCS is explicitly truthy, or
// (when the flag is unset) only outside production. This keeps the public
// /api/docs surface closed by default in production deployments.
function isApiDocsEnabled() {
  const flag = process.env.ENABLE_API_DOCS;
  if (flag !== undefined && flag !== '') {
    return flag === 'true' || flag === '1';
  }
  return process.env.NODE_ENV !== 'production';
}

if (isApiDocsEnabled()) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
} else {
  app.use('/api/docs', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

// Text-heavy routes get a tighter JSON body limit (10kb). These parsers are
// mounted before the route handlers so oversized payloads consistently 413.
const textBody = jsonBody({ limit: '10kb' });

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/campaigns', textBody, require('./routes/campaignUpdates'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/anchor', require('./routes/anchor'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/admin', textBody, require('./routes/admin'));
app.use('/api/api-keys', require('./routes/apiKeys'));
app.use('/api/webhooks', textBody, require('./routes/webhooks'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api', require('./routes/disputes'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api', require('./routes/seo'));

app.get('/health', async (_, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});
app.get('/api/config', (_, res) =>
  res.json({ platform_fee_bps: getPlatformFeeBps() })
);

// Public platform stats — used on the hero / landing section.
// Cached for 60 s; invalidated by ledgerMonitor after each indexed contribution.
const cache = require('./utils/cache');
const STATS_CACHE_KEY = 'stats:public';
app.get('/api/stats', async (_req, res) => {
  const cached = cache.get(STATS_CACHE_KEY);
  if (cached) return res.json(cached);

  try {
const db = require('./config/database');
    const [campaigns, raised, contributions] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total
                FROM campaigns
                WHERE deleted_at IS NULL AND status NOT IN ('draft', 'failed')`),
      db.query(`SELECT COALESCE(SUM(raised_amount), 0)::numeric AS total
                FROM campaigns
                WHERE deleted_at IS NULL`),
      db.query(`SELECT COUNT(*)::int AS total FROM contributions`),
    ]);

    const payload = {
      total_campaigns: campaigns.rows[0].total,
      total_raised: parseFloat(raised.rows[0].total),
      total_contributions: contributions.rows[0].total,
    };

    cache.set(STATS_CACHE_KEY, payload, 60_000); // 60 s TTL
    res.json(payload);
  } catch (err) {
    logger.error('Failed to fetch public stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/health/ledger', async (_req, res) => {
  try {
    const body = await getLedgerStreamHealth();
    res.json(body);
  } catch (err) {
    sendAlert('Ledger health check failed', {
      alert_key: 'ledger_health',
      fingerprint: 'health/ledger',
      severity: 'critical',
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'ledger health failed' });
  }
});

if (process.env.SERVE_FRONTEND === 'true') {
  const dist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use(Sentry.expressErrorHandler());
app.use(errorHandler);

const { startWebhookRetryPoller } = require('./services/webhookDispatcher');

const PORT = process.env.PORT || 3001;

function startCampaignStatusCron() {
  if (process.env.ENABLE_CAMPAIGN_STATUS_CRON === 'false') return;
  const cron = require('node-cron');
  cron.schedule('0 * * * *', () => {
    refreshActiveCampaignStatuses().catch((err) => {
      logger.error('Campaign status cron failed', { error: err.message });
    });
  });
  logger.info('Campaign status cron scheduled (hourly)');
}

function startReconciliationCron() {
  if (process.env.ENABLE_RECONCILIATION_CRON === 'false') return;
  const { runReconciliation, getReconcileConfig } = require('./services/reconciliation');
  const { intervalMs, batchSize } = getReconcileConfig();
  // Incremental (only changed campaigns, RECONCILE_BATCH_SIZE per run) and
  // guarded against overlapping runs inside runReconciliation.
  const timer = setInterval(() => {
    runReconciliation().catch((err) => {
      logger.error('Reconciliation run failed', { error: err.message });
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('Reconciliation scheduled', { interval_ms: intervalMs, batch_size: batchSize });
}

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    await assertNoLegacyPlaintextUserWalletSecrets();
  }

  app.listen(PORT, () => {
    logger.info('CrowdPay backend running', { port: PORT, stellar_network: process.env.STELLAR_NETWORK });
    startLedgerMonitor();
    startWebhookRetryPoller();
    startCampaignStatusCron();
    startReconciliationCron();
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error('Backend bootstrap failed', { error: err.message });
    sendAlert('Backend bootstrap failed', {
      alert_key: 'backend_bootstrap',
      fingerprint: 'startup/bootstrap',
      severity: 'warning',
      error: err.message,
    });
    process.exit(1);
  });
}

module.exports = app;
module.exports.openApiSpec = openApiSpec;
