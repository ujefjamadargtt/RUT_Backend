'use strict';

const Joi = require('joi');
const { validateApprovalStatus } = require('../utils/approvalStatusFilter');
const { SORTS } = require('../repositories/workLogSyncComparisonReportRepository');

const MAX_RANGE_DAYS = 366;

// Comma-separated id list, e.g. "12,15" — parsed by utils/idListParser.
const idList = Joi.string().trim().pattern(/^\d+(\s*,\s*\d+)*$/).optional().allow('')
  .messages({ 'string.pattern.base': '{{#label}} must be a comma-separated list of ids.' });

// .raw() keeps the YYYY-MM-DD string for the SQL DATE predicates.
const isoDate = () => Joi.date().iso().raw();

const periodKeys = {
  date: isoDate().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).max(2100).optional(),
  start_date: isoDate().optional(),
  end_date: isoDate().optional(),
};

/**
 * Exactly ONE period mode: a single `date`, a `start_date` + `end_date` range (inclusive, max 366 days) or
 * `month` + `year`. With none of them the report defaults to the current month.
 */
function onePeriod(value, helpers) {
  const hasDate = value.date != null;
  const hasRange = value.start_date != null || value.end_date != null;
  const hasMonth = value.month != null || value.year != null;
  if ([hasDate, hasRange, hasMonth].filter(Boolean).length > 1) {
    return helpers.message('Send only one period: date, or start_date + end_date, or month + year.');
  }
  if (hasRange) {
    if (value.start_date == null || value.end_date == null) return helpers.message('start_date and end_date must be sent together.');
    if (value.start_date > value.end_date) return helpers.message('start_date must be on or before end_date.');
    const days = Math.round((new Date(value.end_date) - new Date(value.start_date)) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) return helpers.message(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  if (hasMonth && (value.month == null || value.year == null)) return helpers.message('month and year must be sent together.');
  return value;
}

/** GET /reports/work-log-sync-comparison (json | excel | csv) */
const workLogSyncComparisonQuerySchema = Joi.object({
  ...periodKeys,

  employee_ids: idList,
  employee_bu_ids: idList,
  employee_sub_bu_ids: idList,
  client_ids: idList,
  project_ids: idList,
  service_po_ids: idList,
  po_bu_ids: idList,

  work_type: Joi.string().valid('all', 'own', 'cross', 'na').default('all'),
  // One value or a comma-separated list ("pending,approved"); "approved" also covers synced rows; "all" = no filter.
  approval_status: Joi.string().trim().custom(validateApprovalStatus).default('all'),
  search: Joi.string().trim().max(100).allow('').optional(),

  sort_by: Joi.string().valid(...Object.keys(SORTS)).default('date'),
  sort_order: Joi.string().lowercase().valid('asc', 'desc').default('desc'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(50),
  format: Joi.string().lowercase().valid('json', 'excel', 'csv').default('json'),
}).custom(onePeriod, 'one-period');

/** GET /reports/work-log-sync-comparison/filter-options — the period only. */
const workLogSyncComparisonFilterOptionsQuerySchema = Joi.object({ ...periodKeys }).custom(onePeriod, 'one-period');

module.exports = { workLogSyncComparisonQuerySchema, workLogSyncComparisonFilterOptionsQuerySchema };
