const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const TtlCache = require('../utils/cache').constructor;

function buildApp(queryImpl) {
  const router = proxyquire('./seo', {
    '../config/database': { query: queryImpl },
    '../utils/cache': new TtlCache(),
  });

  const app = express();
  app.use('/api', router);
  return app;
}

const activeCampaign = {
  id: 42,
  title: 'Community Garden Project',
  description: 'Building a sustainable urban garden',
  cover_image_url: 'https://cdn.example.com/covers/garden.jpg',
};

test('returns an empty fragment without touching the database for non-campaign paths', async () => {
  let queries = 0;
  const app = buildApp(async () => {
    queries += 1;
    return { rows: [] };
  });

  for (const path of ['/', '/campaigns/new', '/dashboard', undefined]) {
    const res = await request(app).get('/api/seo/head').query(
      path === undefined ? {} : { path }
    );
    assert.equal(res.status, 200);
    assert.equal(res.text, '');
  }
  assert.equal(queries, 0);
});

test('serves campaign title, description and og/twitter tags as an HTML fragment', async () => {
  const app = buildApp(async () => ({ rows: [activeCampaign] }));

  const res = await request(app)
    .get('/api/seo/head')
    .set('Host', 'crowdpay.example')
    .set('X-Forwarded-Proto', 'https')
    .query({ path: '/campaigns/42' });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['cache-control'], /max-age=60/);
  assert.match(res.text, /<title>Community Garden Project \| CrowdPay<\/title>/);
  assert.match(res.text, /<meta name="description" content="Building a sustainable urban garden" \/>/);
  assert.match(res.text, /<meta property="og:title" content="Community Garden Project" \/>/);
  assert.match(res.text, /<meta property="og:url" content="https:\/\/crowdpay\.example\/campaigns\/42" \/>/);
  assert.match(res.text, /<meta property="og:image" content="https:\/\/cdn\.example\.com\/covers\/garden\.jpg" \/>/);
  assert.match(res.text, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(res.text, /<meta name="twitter:image" content="https:\/\/cdn\.example\.com\/covers\/garden\.jpg" \/>/);
});

test('relative cover images are absolutised against the request origin', async () => {
  const app = buildApp(async () => ({
    rows: [{ ...activeCampaign, cover_image_url: '/uploads/garden.jpg' }],
  }));

  const res = await request(app)
    .get('/api/seo/head')
    .set('Host', 'crowdpay.example')
    .set('X-Forwarded-Proto', 'https')
    .query({ path: '/campaigns/42' });

  assert.match(res.text, /<meta property="og:image" content="https:\/\/crowdpay\.example\/uploads\/garden\.jpg" \/>/);
});

test('falls back to summary card and omits image tags without a cover', async () => {
  const app = buildApp(async () => ({
    rows: [{ ...activeCampaign, cover_image_url: null }],
  }));

  const res = await request(app).get('/api/seo/head').query({ path: '/campaigns/42' });

  assert.match(res.text, /<meta name="twitter:card" content="summary" \/>/);
  assert.doesNotMatch(res.text, /og:image|twitter:image/);
});

test('escapes HTML in campaign fields', async () => {
  const app = buildApp(async () => ({
    rows: [{
      ...activeCampaign,
      title: 'Gardens <script>alert(1)</script> & "More"',
      description: 'Line one\nLine two <b>bold</b>',
    }],
  }));

  const res = await request(app).get('/api/seo/head').query({ path: '/campaigns/42' });

  assert.doesNotMatch(res.text, /<script>|<b>/);
  assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;More&quot;/);
  assert.match(res.text, /Line one Line two &lt;b&gt;bold&lt;\/b&gt;/);
});

test('excludes deleted and draft campaigns from the lookup', async () => {
  const seen = [];
  const app = buildApp(async (text) => {
    seen.push(text);
    return { rows: [] };
  });

  const res = await request(app).get('/api/seo/head').query({ path: '/campaigns/7' });

  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /deleted_at IS NULL/);
  assert.match(seen[0], /status <> 'draft'/);
});

test('non-numeric campaign ids are ignored without a database lookup', async () => {
  let queries = 0;
  const app = buildApp(async () => {
    queries += 1;
    return { rows: [] };
  });

  const res = await request(app).get('/api/seo/head').query({ path: '/campaigns/abc' });

  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(queries, 0);
});

test('repeated requests for the same campaign are served from cache', async () => {
  let queries = 0;
  const app = buildApp(async () => {
    queries += 1;
    return { rows: [activeCampaign] };
  });

  await request(app).get('/api/seo/head').query({ path: '/campaigns/42' });
  await request(app).get('/api/seo/head').query({ path: '/campaigns/42' });

  assert.equal(queries, 1);
});
