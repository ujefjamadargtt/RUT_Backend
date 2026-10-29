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
  // YYYY-MM (calendar month of generated_at, IST). Format/range is checked in the service so a bad value
  // answers 400 INVALID_MONTH rather than the generic validation error.
  month: Joi.string().trim().allow('').max(20).optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  // Optional BU / Sub-BU selector (alternative to the X-Company-Id header) —
  // only ever narrows the caller's own reach, see resolveReportCompanyScope.js.
  company_id: Joi.number().integer().positive().optional(),
  // Multi-select: comma-separated BU / Sub-BU ids, e.g. "1,2,3" (blank is treated as absent).
  // Each id is validated against the caller's reach by resolveInsightCompanyScope.js.
  company_ids: Joi.string().trim().allow('').pattern(/^[1-9]\d*(\s*,\s*[1-9]\d*)*$/).max(500).optional(),
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
