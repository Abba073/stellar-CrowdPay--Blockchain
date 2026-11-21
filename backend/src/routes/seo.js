const express = require('express');
const router = express.Router();
const db = require('../config/database');
const TtlCache = require('../utils/cache').constructor;

const cache = new TtlCache();
const CACHE_TTL_MS = 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function configuredOrigin() {
  const configured = process.env.CANONICAL_FRONTEND_URL || process.env.FRONTEND_URL;
  if (!configured) return '';
  return String(configured).replace(/\/+$/, '');
}

function requestOrigin(req) {
  const configured = configuredOrigin();
  if (configured) return configured;
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'http';
  const host = req.get('Host');
  return host ? `${proto}://${host}` : '';
}

function absolutise(url, origin) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!origin) return url;
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractCampaignId(path) {
  if (typeof path !== 'string') return null;
  const match = path.match(/^\/campaigns\/([^/?#]+)/);
  if (!match) return null;
  const id = match[1];
  return UUID_RE.test(id) ? id : null;
}

function renderHead(campaign, origin) {
  const title = collapseWhitespace(campaign.title || 'Campaign');
  const description = collapseWhitespace(campaign.description || '');
  const image = absolutise(campaign.cover_image_url, origin);
  const url = `${origin}/campaigns/${campaign.id}`;

  const tags = [
    `<title>${escapeHtml(title)} | CrowdPay</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:type" content="website" />`,
  ];

  if (image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}" />`);
    tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}" />`);
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`);
  }

  return tags.join('\n');
}

router.get('/head', async (req, res) => {
  const campaignId = extractCampaignId(req.query.path);
  if (!campaignId) {
    return res.type('text/html').send('');
  }

  const origin = requestOrigin(req);
  const cacheKey = `seo:head:${origin}:${campaignId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return res.type('text/html').set('Cache-Control', 'public, max-age=60').send(cached);
  }

  try {
    const result = await db.query(
      `SELECT id, title, description, cover_image_url
         FROM campaigns
        WHERE id = $1
          AND deleted_at IS NULL
          AND status <> 'draft'`,
      [campaignId]
    );

    const campaign = result.rows[0];
    if (!campaign) {
      cache.set(cacheKey, '', CACHE_TTL_MS);
      return res.type('text/html').send('');
    }

    const fragment = renderHead(campaign, origin);
    cache.set(cacheKey, fragment, CACHE_TTL_MS);
    return res.type('text/html').set('Cache-Control', 'public, max-age=60').send(fragment);
  } catch (err) {
    return res.status(500).type('text/html').send('');
  }
});

module.exports = router;
