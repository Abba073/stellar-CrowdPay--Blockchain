const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { originCheck, getAllowedOrigins } = require('./originCheck');

function buildApp() {
  const app = express();
  app.use(originCheck);
  app.all('/thing', (req, res) => res.json({ ok: true }));
  return app;
}

// ─── existing single-origin tests ─────────────────────────────────────────

test('allows safe methods regardless of origin', async () => {
  const res = await request(buildApp())
    .get('/thing')
    .set('Sec-Fetch-Site', 'cross-site')
    .set('Origin', 'https://evil.example');
  assert.equal(res.status, 200);
});

test('blocks cross-site POST via Sec-Fetch-Site', async () => {
  const res = await request(buildApp()).post('/thing').set('Sec-Fetch-Site', 'cross-site');
  assert.equal(res.status, 403);
});

test('allows same-site POST via Sec-Fetch-Site', async () => {
  const res = await request(buildApp()).post('/thing').set('Sec-Fetch-Site', 'same-site');
  assert.equal(res.status, 200);
});

test('blocks POST from a foreign Origin when Sec-Fetch-Site is absent', async () => {
  const res = await request(buildApp()).post('/thing').set('Origin', 'https://evil.example');
  assert.equal(res.status, 403);
});

test('allows POST from the configured frontend origin', async () => {
  const res = await request(buildApp())
    .post('/thing')
    .set('Origin', process.env.FRONTEND_URL || 'http://localhost:5173');
  assert.equal(res.status, 200);
});

test('allows POST with no Origin or Sec-Fetch-Site (non-browser clients)', async () => {
  const res = await request(buildApp()).post('/thing');
  assert.equal(res.status, 200);
});

// ─── multi-origin (FRONTEND_URLS) tests ───────────────────────────────────

test('getAllowedOrigins returns a Set with localhost when no env vars set', () => {
  const saved = { FRONTEND_URLS: process.env.FRONTEND_URLS, FRONTEND_URL: process.env.FRONTEND_URL };
  delete process.env.FRONTEND_URLS;
  delete process.env.FRONTEND_URL;
  try {
    const origins = getAllowedOrigins();
    assert.ok(origins instanceof Set);
    assert.ok(origins.has('http://localhost:5173'));
  } finally {
    if (saved.FRONTEND_URLS !== undefined) process.env.FRONTEND_URLS = saved.FRONTEND_URLS;
    if (saved.FRONTEND_URL !== undefined) process.env.FRONTEND_URL = saved.FRONTEND_URL;
  }
});

test('getAllowedOrigins parses FRONTEND_URLS comma-separated list', () => {
  const saved = process.env.FRONTEND_URLS;
  process.env.FRONTEND_URLS = 'http://localhost:5173,https://app.crowdpay.io,https://staging.crowdpay.io';
  try {
    const origins = getAllowedOrigins();
    assert.ok(origins.has('http://localhost:5173'));
    assert.ok(origins.has('https://app.crowdpay.io'));
    assert.ok(origins.has('https://staging.crowdpay.io'));
    assert.equal(origins.size, 3);
  } finally {
    if (saved !== undefined) process.env.FRONTEND_URLS = saved;
    else delete process.env.FRONTEND_URLS;
  }
});

test('getAllowedOrigins strips trailing slashes from origins', () => {
  const saved = process.env.FRONTEND_URLS;
  process.env.FRONTEND_URLS = 'https://app.crowdpay.io/,https://staging.crowdpay.io/';
  try {
    const origins = getAllowedOrigins();
    assert.ok(origins.has('https://app.crowdpay.io'));
    assert.ok(origins.has('https://staging.crowdpay.io'));
    assert.ok(!origins.has('https://app.crowdpay.io/'));
  } finally {
    if (saved !== undefined) process.env.FRONTEND_URLS = saved;
    else delete process.env.FRONTEND_URLS;
  }
});

test('allows POST from second origin in FRONTEND_URLS list', async (t) => {
  const saved = process.env.FRONTEND_URLS;
  process.env.FRONTEND_URLS = 'http://localhost:5173,https://embed.partner.example';
  t.after(() => {
    if (saved !== undefined) process.env.FRONTEND_URLS = saved;
    else delete process.env.FRONTEND_URLS;
  });
  const res = await request(buildApp())
    .post('/thing')
    .set('Origin', 'https://embed.partner.example');
  assert.equal(res.status, 200);
});

test('blocks POST from an origin not in FRONTEND_URLS list', async (t) => {
  const saved = process.env.FRONTEND_URLS;
  process.env.FRONTEND_URLS = 'http://localhost:5173,https://app.crowdpay.io';
  t.after(() => {
    if (saved !== undefined) process.env.FRONTEND_URLS = saved;
    else delete process.env.FRONTEND_URLS;
  });
  const res = await request(buildApp())
    .post('/thing')
    .set('Origin', 'https://evil.example');
  assert.equal(res.status, 403);
});

test('allows POST from all origins in a multi-entry FRONTEND_URLS', async (t) => {
  const saved = process.env.FRONTEND_URLS;
  const origins = ['https://a.example', 'https://b.example', 'https://c.example'];
  process.env.FRONTEND_URLS = origins.join(',');
  t.after(() => {
    if (saved !== undefined) process.env.FRONTEND_URLS = saved;
    else delete process.env.FRONTEND_URLS;
  });

  for (const origin of origins) {
    const res = await request(buildApp()).post('/thing').set('Origin', origin);
    assert.equal(res.status, 200, `Expected 200 for origin ${origin}`);
  }
});

test('falls back to FRONTEND_URL when FRONTEND_URLS is absent', async (t) => {
  const savedUrls = process.env.FRONTEND_URLS;
  const savedUrl = process.env.FRONTEND_URL;
  delete process.env.FRONTEND_URLS;
  process.env.FRONTEND_URL = 'https://legacy.crowdpay.io';
  t.after(() => {
    if (savedUrls !== undefined) process.env.FRONTEND_URLS = savedUrls;
    else delete process.env.FRONTEND_URLS;
    if (savedUrl !== undefined) process.env.FRONTEND_URL = savedUrl;
    else delete process.env.FRONTEND_URL;
  });
  const res = await request(buildApp())
    .post('/thing')
    .set('Origin', 'https://legacy.crowdpay.io');
  assert.equal(res.status, 200);
});

test('FRONTEND_URL single value is rejected when it is not in the allowed set', async (t) => {
  const savedUrls = process.env.FRONTEND_URLS;
  const savedUrl = process.env.FRONTEND_URL;
  delete process.env.FRONTEND_URLS;
  process.env.FRONTEND_URL = 'https://legacy.crowdpay.io';
  t.after(() => {
    if (savedUrls !== undefined) process.env.FRONTEND_URLS = savedUrls;
    else delete process.env.FRONTEND_URLS;
    if (savedUrl !== undefined) process.env.FRONTEND_URL = savedUrl;
    else delete process.env.FRONTEND_URL;
  });
  const res = await request(buildApp())
    .post('/thing')
    .set('Origin', 'https://evil.example');
  assert.equal(res.status, 403);
});
