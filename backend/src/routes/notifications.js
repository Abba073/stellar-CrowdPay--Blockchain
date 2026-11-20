const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  getNotificationPreferences,
  upsertNotificationPreferences,
} = require('../services/notifications');
const {
  notificationIdValidation,
  notificationPreferencesValidation,
  validateRequestBadRequest,
} = require('../middleware/requestSchemas');
const { sendErrorResponse } = require('../middleware/errorHandler');

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     summary: List the current user's notifications
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of the user's most recent notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     format: uuid
 *                   type:
 *                     type: string
 *                   title:
 *                     type: string
 *                   body:
 *                     type: string
 *                   link:
 *                     type: string
 *                     nullable: true
 *                   read_at:
 *                     type: string
 *                     format: date-time
 *                     nullable: true
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized
 */
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, type, title, body, link, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.user.userId]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/notifications/read-all:
 *   patch:
 *     summary: Mark all of the current user's notifications as read
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 */
router.patch('/read-all', requireAuth, async (req, res) => {
  await db.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.userId]
  );
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/notifications/preferences:
 *   get:
 *     summary: Get the current user's notification preferences
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The user's notification preference flags (defaults applied)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationPreferences'
 *       401:
 *         description: Unauthorized
 *   put:
 *     summary: Update the current user's notification preferences
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NotificationPreferences'
 *     responses:
 *       200:
 *         description: The updated notification preference flags
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationPreferences'
 *       400:
 *         description: Invalid preference payload
 *       401:
 *         description: Unauthorized
 */
router.get('/preferences', requireAuth, async (req, res) => {
  const prefs = await getNotificationPreferences(req.user.userId);
  res.json(prefs);
});

router.put('/preferences', requireAuth, notificationPreferencesValidation, validateRequestBadRequest, async (req, res) => {
  // The service exports upsertNotificationPreferences; the old import name
  // did not exist, so this endpoint always threw.
  const prefs = await upsertNotificationPreferences(req.user.userId, req.body);
  res.json(prefs);
});

/**
 * @openapi
 * /api/notifications/{id}/read:
 *   patch:
 *     summary: Mark a single notification as read
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Notification marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Notification not found
 */
router.patch('/:id/read', requireAuth, notificationIdValidation, validateRequestBadRequest, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Notification not found');
  res.json({ ok: true });
});

module.exports = router;