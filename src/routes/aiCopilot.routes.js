'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
// Same scope contract as the analytics dashboard and /reports endpoints this copilot reads from:
// req.companyIds (always an array) — Platform Admin: every Company; Admin / Entity Admin: their own
// Entities' BUs; a BU-scoped actor: their mapped BU(s) + Sub-BUs; X-Company-Id / company_id narrows it.
// (The plain authenticate() leaves req.companyId undefined for Admin / Entity Admin, which made every
// data question fail with "Named replacement :companyId has no entry in the replacement map".)
const authenticate = [authenticateBase.authenticateIdentity, resolveReportCompanyScope];
const requireFormAccess = require('../middlewares/requireFormAccess');
const { validate } = require('../middlewares/validateRequest');
const { aiLimiter } = require('../middlewares/rateLimiters');
const { aiQuerySchema } = require('../validations/aiCopilotValidation');
const aiCopilotController = require('../controllers/aiCopilot.controller');

/**
 * @swagger
 * tags:
 *   name: AI Copilot
 *   description: Natural-language Q&A over existing analytics data (Phase 1 — AI Chat API). The AI never queries the database directly; it only reasons over structured JSON already computed by dashboardService/reportService.
 */

/**
 * @swagger
 * /ai/query:
 *   post:
 *     summary: Ask the AI Copilot a question about resources, utilization, bench, timesheets, cost, revenue, profit, clients, projects, or an executive summary
 *     tags: [AI Copilot]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question]
 *             properties:
 *               question:
 *                 type: string
 *                 example: "Who is underutilized this month?"
 *               roleId:
 *                 type: integer
 *                 description: Optional, same convention as every other analytics endpoint (frontend-supplied role identifier for publish-visibility gating).
 *               hoursSource:
 *                 type: string
 *                 enum: [O, M]
 *     responses:
 *       200:
 *         description: >
 *           Structured answer: { question, intents_detected, period, data
 *           (the exact backend JSON the AI reasoned over), answer: {
 *           summary, findings, actions, priority } }. Forecasting,
 *           resource-recommendation, project-health-scoring, and
 *           what-if-simulation questions return an explicit
 *           "not available yet" answer instead of a fabricated one.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: The caller's active role has no "AI Copilot" form mapped (Role Form Mapping). Platform Admin is exempt.
 *       422:
 *         description: Validation error
 *       429:
 *         description: Too many AI requests
 */
router.post(
  '/query',
  authenticate,
  requireFormAccess('AI Copilot'),
  aiLimiter,
  validate(aiQuerySchema, 'body'),
  aiCopilotController.query
);

module.exports = router;
