'use strict';

const Joi = require('joi');

/**
 * AI Insight Validation
 * Joi schemas for the /ai-insights query params and run-job body, following
 * the same fork/optional conventions used across the other validation files.
 */

const listInsightsQuerySchema = Joi.object({
  job_key: Joi.string().trim().max(100).optional(),
  severity: Joi.string().valid('critical', 'warning', 'info').optional(),
  is_read: Joi.string().valid('true', 'false').optional(),
  include_dismissed: Joi.string().valid('true', 'false').optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

const runJobBodySchema = Joi.object({
  // Required only for event-driven jobs (currently: new_po_staffing_suggestion)
  // when triggered manually via the API rather than by the PO-creation event.
  reference_id: Joi.number().integer().positive().optional(),
});

module.exports = {
  listInsightsQuerySchema,
  runJobBodySchema,
};
