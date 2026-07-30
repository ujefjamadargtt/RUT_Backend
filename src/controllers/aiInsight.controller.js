'use strict';

const aiInsightService = require('../services/aiInsight.service');
const { sendSuccess, sendPaginated, sendError, sendNotFound } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * AI Insight Controller
 * Thin layer: parse request, delegate to aiInsight.service.js, format response.
 */

/**
 * GET /api/v1/ai-insights
 * All insights (unscoped by role) — for a Management/admin-style overview.
 */
async function getAllInsights(req, res, next) {
  try {
    const { data, meta } = await aiInsightService.getAllInsights(req.query, req.companyId);
    return sendPaginated(res, data, meta, 'AI insights fetched successfully.');
  } catch (err) {
    logger.error('getAllInsights error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/ai-insights/:id
 */
async function getInsightById(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid insight ID.', 400);
    }

    const insight = await aiInsightService.getInsightById(id, req.companyId);
    return sendSuccess(res, insight, 'AI insight fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'AI insight');
    }
    logger.error('getInsightById error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/ai-insights/my-role
 * Insights whose audience_roles overlaps with the logged-in user's roles.
 */
async function getInsightsByRole(req, res, next) {
  try {
    const roles = req.userRoles || [];
    const { data, meta } = await aiInsightService.getInsightsByRoles(roles, req.query, req.companyId);
    return sendPaginated(res, data, meta, 'AI insights for your role fetched successfully.');
  } catch (err) {
    logger.error('getInsightsByRole error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/ai-insights/unread
 * Unread insights whose audience_roles overlaps with the logged-in user's roles.
 */
async function getUnreadInsights(req, res, next) {
  try {
    const roles = req.userRoles || [];
    const { data, meta } = await aiInsightService.getUnreadInsights(roles, req.query, req.companyId);
    return sendPaginated(res, data, meta, 'Unread AI insights fetched successfully.');
  } catch (err) {
    logger.error('getUnreadInsights error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * POST /api/v1/ai-insights/run/:jobKey
 * Run one insight job on demand (does not wait for its cron schedule).
 * Body: { reference_id? } — required for event-driven jobs (e.g.
 * new_po_staffing_suggestion) when triggered manually rather than by the
 * PO-creation event.
 */
async function runSingleJob(req, res, next) {
  try {
    const { jobKey } = req.params;
    const context = req.body?.reference_id ? { referenceId: req.body.reference_id } : {};

    const insight = await aiInsightService.runJob(jobKey, context, req.companyId);

    if (insight === null) {
      return sendSuccess(res, null, `Job "${jobKey}" ran successfully but produced no insight (no matching data).`);
    }

    return sendSuccess(res, insight, `Job "${jobKey}" ran successfully.`, 201);
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('runSingleJob error', { error: err.message, jobKey: req.params.jobKey, userId: req.userId });
    next(err);
  }
}

/**
 * POST /api/v1/ai-insights/run-all
 * Run every non-event-driven job once, regardless of its cron schedule.
 */
async function runAllJobs(req, res, next) {
  try {
    const results = await aiInsightService.runAllJobs(req.companyId);
    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return sendSuccess(
      res,
      { results },
      `Ran ${results.length} job(s): ${succeeded} succeeded, ${failed} failed.`
    );
  } catch (err) {
    logger.error('runAllJobs error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * PUT /api/v1/ai-insights/:id/read
 */
async function markAsRead(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid insight ID.', 400);
    }

    const insight = await aiInsightService.markAsRead(id, req.companyId);
    return sendSuccess(res, insight, 'AI insight marked as read.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'AI insight');
    }
    logger.error('markAsRead error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * PUT /api/v1/ai-insights/:id/dismiss
 */
async function dismissInsight(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid insight ID.', 400);
    }

    const insight = await aiInsightService.dismissInsight(id, req.companyId);
    return sendSuccess(res, insight, 'AI insight dismissed.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'AI insight');
    }
    logger.error('dismissInsight error', { error: err.message, userId: req.userId });
    next(err);
  }
}

module.exports = {
  getAllInsights,
  getInsightById,
  getInsightsByRole,
  getUnreadInsights,
  runSingleJob,
  runAllJobs,
  markAsRead,
  dismissInsight,
};
