const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();
const {
  hmacSignature,
  assertSafeWebhookUrl,
  assertNotPrivateIp,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_ATTEMPTS,
} = require('./webhookDispatcher');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

function jsonResponse(ok, status, body) {
  return { ok, status, text: async () => body };
}

function makeDb({ deliverableRows = [], campaignRows = [] } = {}) {
  const seen = { userWebhookIds: [], campaignWebhookIds: [], updates: [], userPollerSql: null, campaignPollerSql: null };
  const userDelivery = {
    id: 'd-user-1',
    attempt_count: 1,
    status: 'delivering',
    payload: { campaign_id: 'c-1', status: 'funded' },
    event_type: 'campaign.funded',
    url: 'https://hooks.example.test/user',
    secret: 'whsec_user',
    revoked_at: null,
  };
  const campaignDelivery = {
    id: 'd-campaign-1',
    attempt_count: 1,
    status: 'delivering',
    payload: { campaign_id: 'c-1', status: 'funded' },
    event: 'campaign.funded',
    url: 'https://hooks.example.test/campaign',
    secret: 'whsec_campaign',
    active: true,
  };

  const query = async (text) => {
    if (text.includes('FROM campaign_webhook_deliveries') && !text.includes('JOIN campaign_webhooks')) {
      seen.campaignPollerSql = seen.campaignPollerSql || text;
      return { rows: campaignRows };
    }
    if (text.includes('FROM campaign_webhook_deliveries d')) {
      return { rows: [{ id: 'd-campaign-1', ...campaignDelivery }] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'delivering'")) {
      seen.campaignWebhookIds.push('d-campaign-1');
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'delivered'")) {
      seen.updates.push({ kind: 'campaign_delivered', sql: text });
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'retrying'")) {
      seen.updates.push({ kind: 'campaign_retrying', sql: text });
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'failed'")) {
      seen.updates.push({ kind: 'campaign_failed', sql: text });
      return { rows: [] };
    }
    if (text.includes('FROM webhook_deliveries') && !text.includes('JOIN webhooks')) {
      seen.userPollerSql = seen.userPollerSql || text;
      return { rows: deliverableRows };
    }
    if (text.includes('FROM webhook_deliveries d')) {
      return { rows: [{ id: 'd-user-1', ...userDelivery }] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'delivering'")) {
      seen.userWebhookIds.push('d-user-1');
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'delivered'")) {
      seen.updates.push({ kind: 'user_delivered', sql: text });
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'retrying'")) {
      seen.updates.push({ kind: 'user_retrying', sql: text });
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'failed'")) {
      seen.updates.push({ kind: 'user_failed', sql: text });
      return { rows: [] };
    }
    return { rows: [] };
  };

  return { query, seen, userDelivery, campaignDelivery };
}

// The dispatcher runs every outbound URL through assertSafeWebhookUrl(), which
// resolves the hostname via DNS and rejects the request when the host does not
// resolve or resolves to a private range. Stub `dns` so the fixture hostnames
// resolve to a public address: the SSRF guard then passes, and the delivery
// path under test is reached without any real network traffic.
const PUBLIC_DNS = {
  promises: {
    resolve: async () => ['93.184.216.34'],
  },
};

function loadDispatcher(db) {
  return proxyquire('./webhookDispatcher', {
    '../config/database': db,
    dns: PUBLIC_DNS,
  });
}

beforeEach(() => {
  globalThis.fetch = undefined;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});



// ---------------------------------------------------------------------------
// HMAC-SHA256 signature
// ---------------------------------------------------------------------------
test('HMAC-SHA256 signature matches Node crypto verify pattern', () => {
  const secret = 'whsec_testsecret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = hmacSignature(secret, body);
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(sig, expected);
});

// ---------------------------------------------------------------------------
// assertNotPrivateIp — synchronous IP range checks
// ---------------------------------------------------------------------------
test('assertNotPrivateIp blocks IPv4 loopback 127.0.0.1', () => {
  assert.throws(() => assertNotPrivateIp('127.0.0.1'), /loopback/i);
});

test('assertNotPrivateIp blocks IPv4 loopback 127.255.255.255', () => {
  assert.throws(() => assertNotPrivateIp('127.255.255.255'), /loopback/i);
});

test('assertNotPrivateIp blocks RFC-1918 10.x.x.x', () => {
  assert.throws(() => assertNotPrivateIp('10.0.0.1'), /private/i);
});

test('assertNotPrivateIp blocks RFC-1918 172.16.0.1', () => {
  assert.throws(() => assertNotPrivateIp('172.16.0.1'), /private/i);
});

test('assertNotPrivateIp blocks RFC-1918 172.31.255.255', () => {
  assert.throws(() => assertNotPrivateIp('172.31.255.255'), /private/i);
});

test('assertNotPrivateIp blocks RFC-1918 192.168.1.1', () => {
  assert.throws(() => assertNotPrivateIp('192.168.1.1'), /private/i);
});

test('assertNotPrivateIp blocks link-local 169.254.169.254 (AWS metadata)', () => {
  assert.throws(() => assertNotPrivateIp('169.254.169.254'), /link-local/i);
});

test('assertNotPrivateIp blocks IPv6 loopback ::1', () => {
  assert.throws(() => assertNotPrivateIp('::1'), /loopback/i);
});

test('assertNotPrivateIp blocks IPv6 ULA fc00::', () => {
  assert.throws(() => assertNotPrivateIp('fc00::1'), /private.*ULA/i);
});

test('assertNotPrivateIp blocks IPv6 ULA fd prefix', () => {
  assert.throws(() => assertNotPrivateIp('fd12:3456:789a:1::1'), /private.*ULA/i);
});

test('assertNotPrivateIp allows a public IPv4 address', () => {
  // Should not throw
  assert.doesNotThrow(() => assertNotPrivateIp('8.8.8.8'));
});

test('assertNotPrivateIp allows another public IPv4 address', () => {
  assert.doesNotThrow(() => assertNotPrivateIp('52.94.5.2'));
});

// ---------------------------------------------------------------------------
// assertSafeWebhookUrl — async URL-level validation
// ---------------------------------------------------------------------------
test('assertSafeWebhookUrl rejects http:// scheme', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('http://example.com/hook'),
    /HTTPS/i
  );
});

test('assertSafeWebhookUrl rejects ftp:// scheme', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('ftp://example.com/hook'),
    /HTTPS/i
  );
});

test('assertSafeWebhookUrl rejects file:// scheme', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('file:///etc/passwd'),
    /HTTPS/i
  );
});

test('assertSafeWebhookUrl rejects invalid URL string', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('not-a-url'),
    /Invalid webhook URL/i
  );
});

test('assertSafeWebhookUrl rejects https://localhost', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://localhost/hook'),
    /forbidden host/i
  );
});

test('assertSafeWebhookUrl rejects https://localhost. subdomain', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://internal.localhost/hook'),
    /forbidden host/i
  );
});

test('assertSafeWebhookUrl rejects https://127.0.0.1/', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://127.0.0.1/hook'),
    /loopback/i
  );
});

test('assertSafeWebhookUrl rejects https://10.0.0.1/', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://10.0.0.1/hook'),
    /private/i
  );
});

test('assertSafeWebhookUrl rejects https://192.168.1.1/', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://192.168.1.1/hook'),
    /private/i
  );
});

test('assertSafeWebhookUrl rejects https://169.254.169.254/ (AWS metadata)', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data/'),
    /link-local/i
  );
});

test('assertSafeWebhookUrl rejects https://[::1]/', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[::1]/hook'),
    /loopback/i
  );
});

test('poller selects expired delivering rows via a lease (make_interval)', () => {
  const db = makeDb();
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(true, 200, 'ok');

  return dispatcher.processDueRetries().then(() => {
    assert.ok(db.seen.userPollerSql, 'poller SQL was not issued');
    assert.match(db.seen.userPollerSql, /status = 'delivering'/);
    assert.match(db.seen.userPollerSql, /make_interval\(secs => \$1\)/);
  });
});

test('delivering row whose lease expired is re-delivered after simulated crash', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://hooks.example.test/user');
  assert.match(fetchCalls[0].opts.headers['X-CrowdPay-Delivery-Id'], /d-user-1/);
  assert.match(fetchCalls[0].opts.headers['X-CrowdPay-Signature'], /^sha256=/);
  assert.ok(db.seen.updates.some((u) => u.kind === 'user_delivered'));
});

// ---------------------------------------------------------------------------
// Replay protection: timestamp + delivery-id headers, timestamp in signature
// ---------------------------------------------------------------------------
test('user delivery sends X-CrowdPay-Timestamp and X-CrowdPay-Delivery-Id headers', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls.length, 1);
  const headers = fetchCalls[0].opts.headers;
  assert.ok(headers['X-CrowdPay-Timestamp'], 'missing X-CrowdPay-Timestamp header');
  assert.ok(headers['X-CrowdPay-Delivery-Id'], 'missing X-CrowdPay-Delivery-Id header');
  assert.match(headers['X-CrowdPay-Delivery-Id'], /d-user-1/);
});

test('user delivery timestamp is a recent epoch value (within 5 minutes)', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  const before = Math.floor(Date.now() / 1000);
  await dispatcher.processDueRetries();
  const after = Math.floor(Date.now() / 1000);

  assert.equal(fetchCalls.length, 1);
  const raw = fetchCalls[0].opts.headers['X-CrowdPay-Timestamp'];
  assert.match(raw, /^\d+$/, 'timestamp header must be an integer epoch value');
  const ts = Number(raw);
  assert.ok(ts >= before - 300 && ts <= after + 300, `timestamp ${ts} outside ±5 min window`);
});

test('user delivery signature covers `${timestamp}.${body}`', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls.length, 1);
  const { headers, body } = fetchCalls[0].opts;
  const ts = headers['X-CrowdPay-Timestamp'];
  const expected = crypto
    .createHmac('sha256', db.userDelivery.secret)
    .update(`${ts}.${body}`, 'utf8')
    .digest('hex');
  assert.equal(headers['X-CrowdPay-Signature'], `sha256=${expected}`);
});

test('campaign delivery sends timestamp and delivery-id headers with timestamp-signed payload', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueCampaignWebhookRetries();

  assert.equal(fetchCalls.length, 1);
  const { headers, body } = fetchCalls[0].opts;
  assert.ok(headers['X-CrowdPay-Timestamp'], 'missing X-CrowdPay-Timestamp header');
  assert.match(headers['X-CrowdPay-Delivery-Id'], /d-campaign-1/);
  assert.match(headers['X-CrowdPay-Timestamp'], /^\d+$/);

  const expected = crypto
    .createHmac('sha256', db.campaignDelivery.secret)
    .update(`${headers['X-CrowdPay-Timestamp']}.${body}`, 'utf8')
    .digest('hex');
  assert.equal(headers['X-CrowdPay-Signature'], `sha256=${expected}`);
});

test('rows still within the delivery lease are not re-picked', async () => {
  const db = makeDb({ deliverableRows: [] });
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls, 0);
});

test('fetch failure after lease re-pick moves the row back to retrying with backoff', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(false, 500, 'internal error');
  globalThis.setTimeout = () => 0;

  await dispatcher.processDueRetries();

  const retryUpdate = db.seen.updates.find((u) => u.kind === 'user_retrying');
  assert.ok(retryUpdate, 'expected a retrying update after a 500');
  assert.match(retryUpdate.sql, /next_retry_at = \$\d/);
  assert.match(retryUpdate.sql, /last_error = \$\d/);
});

test('delivering row already at max attempts fails without refetching', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  db.userDelivery.attempt_count = MAX_DELIVERY_ATTEMPTS;
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls, 0);
  assert.ok(db.seen.updates.some((u) => u.kind === 'user_failed'));
});

test('campaign poller resurrects a stuck delivering delivery after lease expiry', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueCampaignWebhookRetries();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://hooks.example.test/campaign');
  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_delivered'));

  assert.ok(db.seen.campaignPollerSql, 'campaign poller SQL was not issued');
  assert.match(db.seen.campaignPollerSql, /status = 'delivering'/);
  assert.match(db.seen.campaignPollerSql, /make_interval\(secs => \$1\)/);
});

test('campaign delivery fetch failure schedules a campaign retry', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(false, 404, 'not found');
  globalThis.setTimeout = () => 0;

  await dispatcher.processDueCampaignWebhookRetries();

  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_retrying'));
});

test('campaign delivery exceeding max attempts fails', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  db.campaignDelivery.attempt_count = MAX_CAMPAIGN_DELIVERY_ATTEMPTS;
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueCampaignWebhookRetries();

  assert.equal(fetchCalls, 0);
  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_failed'));
});
