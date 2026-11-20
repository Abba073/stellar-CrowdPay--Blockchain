const router = require('express').Router();
const db = require('../config/database');
const cache = require('../utils/cache');
const asyncHandler = require('../utils/asyncHandler');

const SITE_NAME = 'CrowdPay';
const HEAD_CACHE_TTL_MS = 60_000;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function excerpt(text, max = 200) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

// The include is evaluated by nginx SSI, which forwards the original request
// URI, so the public origin must be reconstructed from proxy headers.
function resolvePublicOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host');
  if (host) return `${proto}://${host}`;
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function campaignIdFromPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const match = rawPath.match(/^\/campaigns\/(\d+)/);
  return match ? match[1] : null;
}

function absoluteUrl(value, origin) {
  try {
    return new URL(value, origin).toString();
  } catch {
    return null;
  }
}

function buildHeadFragment(campaign, origin) {
  const title = `${campaign.title} | ${SITE_NAME}`;
  const description = excerpt(campaign.description);
  const url = `${origin}/campaigns/${campaign.id}`;
  const image = campaign.cover_image_url
    ? absoluteUrl(campaign.cover_image_url, origin)
    : null;

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    description && `<meta name="description" content="${escapeHtml(description)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:title" content="${escapeHtml(campaign.title)}" />`,
    description && `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    image && `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeHtml(campaign.title)}" />`,
    description && `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    image && `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ];

  return tags.filter(Boolean).join('\n');
}

/**
 * @openapi
 * tags:
 *   - name: SEO
 *     description: Server-rendered head metadata for crawlers and social scrapers
 */
router.get('/seo/head', asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/seo/head:
   *   get:
   *     tags: [SEO]
   *     summary: HTML head fragment for a public page path
   *     description: >
   *       Injected into the SPA shell by nginx SSI so crawlers and social
   *       scrapers see per-campaign title/description/og/twitter tags without
   *       executing JavaScript. Returns an empty body for non-campaign paths.
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema: { type: string }
   *         example: /campaigns/42
   *     responses:
   *       200:
   *         description: HTML fragment (may be empty)
   */
  const campaignId = campaignIdFromPath(req.query.path);
  if (!campaignId) return res.status(200).type('html').send('');

  const cacheKey = `seo:head:${campaignId}`;
  let fragment = cache.get(cacheKey);

  if (fragment === undefined) {
    const { rows } = await db.query(
      `SELECT id, title, description, cover_image_url
       FROM campaigns
       WHERE id = $1 AND deleted_at IS NULL AND status <> 'draft'`,
      [campaignId]
    );
    fragment = rows.length ? buildHeadFragment(rows[0], resolvePublicOrigin(req)) : '';
    cache.set(cacheKey, fragment, HEAD_CACHE_TTL_MS);
  }

  res.set('Cache-Control', 'public, max-age=60');
  res.status(200).type('html').send(fragment);
}));

module.exports = router;
