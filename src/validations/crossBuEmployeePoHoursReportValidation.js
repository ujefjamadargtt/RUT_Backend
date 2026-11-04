'use strict';

const Joi = require('joi');
const { validateApprovalStatus } = require('../utils/approvalStatusFilter');

// Comma-separated id list, e.g. "12,15" — parsed by utils/idListParser.
const idList = Joi.string().trim().pattern(/^\d+(\s*,\s*\d+)*$/).optional().allow('')
  .messages({ 'string.pattern.base': '{{#label}} must be a comma-separated list of ids.' });

// Hours basis switch: 'O' = Original (as-logged, pre-cap) hours; anything else (omitted, 'M', unknown) = Adjusted.
// Invalid values are normalised to 'M' rather than rejected.
const hoursSourceField = Joi.string().allow('').custom((value) => (value === 'O' ? 'O' : 'M')).optional();

/**
 * Cross-BU Employee & Service PO Hours Report. Employee BU and PO BU are separate, independent
 * filters (never one shared "business unit"). Period: month + year, or start_date + end_date
 * (max 366 days); with neither, the current month.
 */
const crossBuEmployeePoHoursReportQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).max(2100).optional(),
  // .raw() keeps YYYY-MM-DD strings for the SQL DATE predicates.
  start_date: Joi.date().iso().raw().optional(),
  end_date: Joi.date().iso().raw().optional(),

  // Employee side
  employee_ids: idList,
  employee_bu_ids: idList,
  employee_sub_bu_ids: idList,

  // PO side
  client_ids: idList,
  project_ids: idList,
  service_po_ids: idList,
  po_bu_ids: idList,

  work_type: Joi.string().valid('all', 'own', 'cross', 'na').default('all'),
  // One value or a comma-separated list ("pending,approved"); "all" = no filter.
  approval_status: Joi.string().trim().custom(validateApprovalStatus).default('all'),
  search: Joi.string().trim().max(100).allow('').optional(),

  hoursSource: hoursSourceField,
  sort_by: Joi.string().valid('employee', 'po', 'hours', 'work_type').default('employee'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(50),
  // json (default) | excel (Details + BU Flow sheets) | csv (details)
  format: Joi.string().valid('json', 'excel', 'csv').default('json'),
}).custom((value, helpers) => {
  if ((value.month != null || value.year != null) && (value.start_date || value.end_date)) {
    return helpers.message('Provide either month/year or start_date/end_date, not both.');
  }
  return value;
}, 'one-period');

module.exports = { crossBuEmployeePoHoursReportQuerySchema };
