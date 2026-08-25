'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveCompanyContextForCompanyLessActors = require('../middlewares/resolveCompanyContextForCompanyLessActors');
// Admin/Entity Admin (ranks 2-3) have no single req.companyId from
// authenticateBase alone — every AI Insight endpoint reads req.companyId
// directly, so every route resolves ONE Business Unit context for them too
// (see resolveCompanyContextForCompanyLessActors.js for the contract).
const authenticate = [authenticateBase, resolveCompanyContextForCompanyLessActors];
const { validate } = require('../middlewares/validateRequest');
const aiInsightController = require('../controllers/aiInsight.controller');
const { listInsightsQuerySchema, runJobBodySchema } = require('../validations/aiInsightValidation');
const { aiLimiter } = require('../middlewares/rateLimiters');

/**
 * @swagger
 * tags:
 *   name: AI Insights
 *   description: AI-generated resource/project insights (multi-provider AI Gateway), scheduled and on-demand
 */

/**
 * @swagger
 * /ai-insights:
 *   get:
 *     summary: Get all AI insights (unscoped by role)
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: job_key
 *         schema: { type: string }
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [critical, warning, info] }
 *       - in: query
 *         name: is_read
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: include_dismissed
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated AI insight list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/',
  authenticate,
  validate(listInsightsQuerySchema, 'query'),
  aiInsightController.getAllInsights
);

/**
 * @swagger
 * /ai-insights/my-role:
 *   get:
 *     summary: Get AI insights whose audience matches the logged-in user's role(s)
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated AI insight list scoped to the caller's roles
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/my-role',
  authenticate,
  validate(listInsightsQuerySchema, 'query'),
  aiInsightController.getInsightsByRole
);

/**
 * @swagger
 * /ai-insights/unread:
 *   get:
 *     summary: Get unread AI insights whose audience matches the logged-in user's role(s)
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated list of unread AI insights
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/unread',
  authenticate,
  validate(listInsightsQuerySchema, 'query'),
  aiInsightController.getUnreadInsights
);

/**
 * @swagger
 * /ai-insights/run-all:
 *   post:
 *     summary: Run every non-event-driven AI insight job immediately, regardless of its cron schedule
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Per-job run results
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post(
  '/run-all',
  authenticate,
  aiLimiter,
  aiInsightController.runAllJobs
);

/**
 * @swagger
 * /ai-insights/run/{jobKey}:
 *   post:
 *     summary: Run a single AI insight job immediately, regardless of its cron schedule
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobKey
 *         required: true
 *         schema: { type: string }
 *         description: e.g. weekly_resource_digest, po_ending_alerts, new_po_staffing_suggestion
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference_id:
 *                 type: integer
 *                 description: Required for new_po_staffing_suggestion when triggered manually (a service_pos.id)
 *     responses:
 *       201:
 *         description: The generated AI insight
 *       404:
 *         description: Unknown job_key
 *       422:
 *         description: Missing required reference_id for an event-driven job
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post(
  '/run/:jobKey',
  authenticate,
  aiLimiter,
  validate(runJobBodySchema, 'body'),
  aiInsightController.runSingleJob
);

/**
 * @swagger
 * /ai-insights/{id}:
 *   get:
 *     summary: Get a single AI insight by ID
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The AI insight
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 */
router.get('/:id', authenticate, aiInsightController.getInsightById);

/**
 * @swagger
 * /ai-insights/{id}/read:
 *   put:
 *     summary: Mark an AI insight as read
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated AI insight
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 */
router.put('/:id/read', authenticate, aiInsightController.markAsRead);

/**
 * @swagger
 * /ai-insights/{id}/dismiss:
 *   put:
 *     summary: Dismiss an AI insight
 *     tags: [AI Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated AI insight
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 */
router.put('/:id/dismiss', authenticate, aiInsightController.dismissInsight);

module.exports = router;
