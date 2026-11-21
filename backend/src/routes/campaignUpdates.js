const router = require("express").Router();
const sanitizeHtml = require("sanitize-html");
const db = require("../config/database");
const { NOT_DELETED, findVisibleCampaign } = require("../utils/campaignVisibility");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const {
  campaignUpdateCreateValidation,
  campaignUpdateEditValidation,
  campaignUpdateDeleteValidation,
  validateRequestUnprocessable,
} = require("../middleware/requestSchemas");
const { sendErrorResponse } = require('../middleware/errorHandler');

const MAX_BODY_LENGTH = 20000;
const MAX_TITLE_LENGTH = 200;
const DEFAULT_UPDATE_LIMIT = 20;
const MAX_UPDATE_LIMIT = 100;

// Per-route JSON limit: a 20,000-character body can be up to ~80 KB as UTF-8.
// (Was referenced but never defined, so this module failed to load.)
const updateBodyParser = require("express").json({ limit: "100kb" });

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "blockquote",
    "code",
    "pre",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    }),
  },
};

function sanitizeText(value = "") {
  return sanitizeHtml(String(value), SANITIZE_OPTIONS).trim();
}

function sanitizeTitle(value = "") {
  // Titles are plain text: strip all tags and collapse whitespace.
  return sanitizeHtml(String(value), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

function withVariants(row) {
  if (!row) return row;
  return {
    ...row,
    title_raw: row.title,
    title_sanitized: row.title,
    body_raw: row.body,
    body_sanitized: row.body,
  };
}

function parsePagination(req, res) {
  const parse = (value, fallback, minimum, maximum, name) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      sendErrorResponse(res, 400, `${name} must be a valid integer`, { [name]: `${name} must be a valid integer` }, "VALIDATION_ERROR");
      return null;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
      const message = maximum === undefined
        ? `${name} must be at least ${minimum}`
        : `${name} must be between ${minimum} and ${maximum}`;
      sendErrorResponse(res, 400, message, { [name]: message }, "VALIDATION_ERROR");
      return null;
    }
    return parsed;
  };

  const limit = parse(req.query.limit, DEFAULT_UPDATE_LIMIT, 1, MAX_UPDATE_LIMIT, "limit");
  if (limit === null) return null;
  const offset = parse(req.query.offset, 0, 0, undefined, "offset");
  if (offset === null) return null;
  return { limit, offset };
}

async function requireCampaignCreator(req, res, next) {
  const campaignId = req.params.id;

  const { rows } = await db.query(
    `SELECT id, creator_id FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [campaignId],
  );

  if (!rows.length) {
    return sendErrorResponse(res, 404, "Campaign not found");
  }

  if (rows[0].creator_id !== req.user.userId && req.user.role !== "admin") {
    return sendErrorResponse(res, 403, "Only the campaign creator can manage updates");
  }

  req.campaign = rows[0];
  next();
}

// Public: list updates newest first
router.get(
  "/:id/updates",
  asyncHandler(async (req, res) => {
    if (!(await findVisibleCampaign(db, req.params.id))) {
      return sendErrorResponse(res, 404, "Campaign not found");
    }
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const { rows } = await db.query(
      `SELECT cu.id,
            cu.campaign_id,
            cu.author_id,
            cu.title,
            cu.body,
            cu.created_at,
            cu.updated_at,
            u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC, cu.id DESC
     LIMIT $2 OFFSET $3`,
      [req.params.id, pagination.limit, pagination.offset],
    );

    res.json({ updates: rows.map(withVariants), ...pagination });
  }),
);

// Creator only: create update
router.post(
  "/:id/updates",
  requireAuth,
  updateBodyParser,
  campaignUpdateCreateValidation,
  validateRequestUnprocessable,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const rawTitle = String(req.body.title ?? "");
    const rawBody = String(req.body.body ?? "");

    if (rawBody.length > MAX_BODY_LENGTH) {
      return sendErrorResponse(res, 422, `Body must be at most ${MAX_BODY_LENGTH} characters`);
    }
    if (rawTitle.length > MAX_TITLE_LENGTH) {
      return sendErrorResponse(res, 422, `Title must be at most ${MAX_TITLE_LENGTH} characters`);
    }

    const title = sanitizeTitle(rawTitle);
    const body = sanitizeText(rawBody);

    if (!title) return sendErrorResponse(res, 422, "Title is required");
    if (!body) return sendErrorResponse(res, 422, "Body is required");

    const { rows } = await db.query(
      `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, campaign_id, author_id, title, body, created_at, updated_at`,
      [req.params.id, req.user.userId, title, body],
    );

    res.status(201).json(withVariants(rows[0]));
  }),
);

// Creator or admin: edit update within 24 hours
router.patch(
  "/:id/updates/:updateId",
  requireAuth,
  updateBodyParser,
  campaignUpdateEditValidation,
  validateRequestUnprocessable,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const rawTitle = String(req.body.title ?? "");
    const rawBody = String(req.body.body ?? "");

    if (rawBody.length > MAX_BODY_LENGTH) {
      return sendErrorResponse(res, 422, `Body must be at most ${MAX_BODY_LENGTH} characters`);
    }
    if (rawTitle.length > MAX_TITLE_LENGTH) {
      return sendErrorResponse(res, 422, `Title must be at most ${MAX_TITLE_LENGTH} characters`);
    }

    const title = sanitizeTitle(rawTitle);
    const body = sanitizeText(rawBody);

    if (!title) return sendErrorResponse(res, 422, "Title is required");
    if (!body) return sendErrorResponse(res, 422, "Body is required");

    const isAdmin = req.user.role === "admin";

    const { rows } = await db.query(
      `UPDATE campaign_updates
       SET title = $1,
           body = $2,
           updated_at = NOW()
       WHERE id = $3
         AND campaign_id = $4
         AND ($5::boolean OR author_id = $6)
         AND created_at >= NOW() - INTERVAL '24 hours'
       RETURNING id, campaign_id, author_id, title, body, created_at, updated_at`,
      [title, body, req.params.updateId, req.params.id, isAdmin, req.user.userId],
    );

    if (!rows.length) {
      return sendErrorResponse(res, 403, "Update not found or edit window has expired");
    }

    res.json(withVariants(rows[0]));
  }),
);

// Creator or admin: delete update
router.delete(
  "/:id/updates/:updateId",
  requireAuth,
  campaignUpdateDeleteValidation,
  validateRequestUnprocessable,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === "admin";

    const { rowCount } = await db.query(
      `DELETE FROM campaign_updates
       WHERE id = $1
         AND campaign_id = $2
         AND ($3::boolean OR author_id = $4)`,
      [req.params.updateId, req.params.id, isAdmin, req.user.userId],
    );

    if (!rowCount) {
      return sendErrorResponse(res, 404, "Update not found");
    }

    res.status(204).send();
  }),
);

module.exports = router;
