'use strict';

const aiCopilotService = require('../services/aiCopilotService');
const { sendSuccess } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * AI Copilot Controller
 * Thin layer: parse request, delegate to aiCopilotService.js, format response.
 */

/**
 * POST /api/v1/ai/query
 * Body: { question: string, roleId?: number, hoursSource?: 'O'|'M' }
 */
async function query(req, res, next) {
  try {
    const { question, roleId, hoursSource } = req.body;
    const result = await aiCopilotService.answerQuestion({
      question,
      roleId,
      hoursSource,
      audienceRoles: req.userRoles,
      companyId: req.companyId,
    });
    return sendSuccess(res, result, 'AI Copilot answered the question.');
  } catch (err) {
    logger.error('AI Copilot query error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

module.exports = { query };
