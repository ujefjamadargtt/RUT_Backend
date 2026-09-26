'use strict';

const Joi = require('joi');

// Comma-separated id list, e.g. "12,15" — parsed by utils/idListParser.
const idList = Joi.string().trim().pattern(/^\d+(\s*,\s*\d+)*$/).optional().allow('')
  .messages({ 'string.pattern.base': '{{#label}} must be a comma-separated list of ids.' });

function requireOnePeriod(value, helpers) {
  const hasMonth = value.month != null || value.year != null;
  const hasRange = !!value.start_date || !!value.end_date;
  if (hasMonth === hasRange) {
    return helpers.message('Provide exactly one period: month and year, or start_date and end_date.');
  }
  if (hasMonth && (value.month == null || value.year == null)) {
    return helpers.message('month and year must be provided together.');
  }
  if (hasRange && (!value.start_date || !value.end_date)) {
    return helpers.message('start_date and end_date must be provided together.');
  }
  return value;
}

const projectTimesheetReportQuerySchema = Joi.object({
  // Period — month + year, or an inclusive date range (max 366 days).
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).max(2100).optional(),
  // .raw() keeps YYYY-MM-DD strings for the SQL DATE predicates.
  start_date: Joi.date().iso().raw().optional(),
  end_date: Joi.date().iso().raw().optional(),

  // Project-wise / employee-wise narrowing (all optional, all combine).
  project_ids: idList,
  service_po_ids: idList,
  client_ids: idList,
  employee_ids: idList,
  search: Joi.string().trim().max(100).allow('').optional(),
  approval_status: Joi.string().valid('all', 'pending', 'approved', 'rejected').default('all'),
  // With a Project / Service PO / Client filter: also show those employees'
  // leave entries in the period. Without one: include/exclude leave rows.
  include_leave: Joi.boolean().default(true),

  // Business Unit narrowing within the caller's own reach (never widens).
  entity_ids: idList,
  company_ids: idList,
  business_unit_ids: idList,

  sort_by: Joi.string().valid('project', 'employee', 'date').default('project'),
  include_summary: Joi.boolean().default(false),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(50),
  // json (default) | excel (Details + Project Summary + Employee Summary sheets) | csv (details)
  format: Joi.string().valid('json', 'excel', 'csv').default('json'),
}).custom(requireOnePeriod, 'one-period');

module.exports = { projectTimesheetReportQuerySchema };
