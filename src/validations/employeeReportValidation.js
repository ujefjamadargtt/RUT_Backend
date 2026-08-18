'use strict';

const Joi = require('joi');

/**
 * Employee Reports Validation Schemas (Employee Self Timesheet module)
 */

const formatField = Joi.string().valid('json', 'excel', 'csv', 'pdf').default('json');

const dailyReportQuerySchema = Joi.object({
  date: Joi.date().iso().required().messages({
    'any.required': 'date is required.',
    'date.format': 'date must be in ISO format (YYYY-MM-DD).',
  }),
  format: formatField,
});

const monthlyReportQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required(),
  year: Joi.number().integer().min(2000).required(),
  format: formatField,
});

const rangeReportQuerySchema = Joi.object({
  startDate: Joi.date().iso().required().messages({
    'any.required': 'startDate is required.',
  }),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).required().messages({
    'any.required': 'endDate is required.',
    'date.min': 'endDate must be on or after startDate.',
  }),
  format: formatField,
});

/**
 * GET /employee-reports/project-hours — exactly one of {date} |
 * {month & year} | {startDate & endDate}, same three period shapes as the
 * daily/monthly/range schemas above, combined into one endpoint since this
 * report also takes an optional service_po_id/project_id filter (only one
 * of the two, never both — a Service PO already implies its Project).
 */
const projectHoursReportQuerySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().optional(),
  project_id: Joi.number().integer().positive().optional(),
  date: Joi.date().iso().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).optional().messages({
    'date.min': 'endDate must be on or after startDate.',
  }),
})
  .custom((value, helpers) => {
    if (value.service_po_id && value.project_id) {
      return helpers.message('Provide only one of service_po_id or project_id, not both.');
    }

    const hasDate = !!value.date;
    const hasMonth = !!value.month && !!value.year;
    const hasRange = !!value.startDate && !!value.endDate;
    const modesGiven = [hasDate, hasMonth, hasRange].filter(Boolean).length;

    if (modesGiven === 0) {
      return helpers.message('Provide one of: date, month & year, or startDate & endDate.');
    }
    if (modesGiven > 1) {
      return helpers.message('Provide only one of: date, month & year, or startDate & endDate — not more than one.');
    }
    if ((value.month && !value.year) || (!value.month && value.year)) {
      return helpers.message('month and year must be provided together.');
    }
    if ((value.startDate && !value.endDate) || (!value.startDate && value.endDate)) {
      return helpers.message('startDate and endDate must be provided together.');
    }

    return value;
  }, 'exactly-one-period-and-filter-mode');

/**
 * GET /employee-reports/timesheet-approval-status — same "exactly one
 * period mode" shape as projectHoursReportQuerySchema above, plus an
 * optional employee_id (honored only when the caller is actually a Manager
 * of that employee — enforced in timesheetApprovalReportService.js, not
 * here) and log_type, which only matters for the plain startDate/endDate
 * range mode (daily buckets per date by default, or monthly buckets
 * spanning the range when explicitly set to 'monthly').
 */
const timesheetApprovalStatusQuerySchema = Joi.object({
  employee_id: Joi.number().integer().positive().optional(),
  date: Joi.date().iso().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).optional().messages({
    'date.min': 'endDate must be on or after startDate.',
  }),
  log_type: Joi.string().valid('daily', 'monthly').optional(),
})
  .custom((value, helpers) => {
    const hasDate = !!value.date;
    const hasMonth = !!value.month && !!value.year;
    const hasRange = !!value.startDate && !!value.endDate;
    const modesGiven = [hasDate, hasMonth, hasRange].filter(Boolean).length;

    if (modesGiven === 0) {
      return helpers.message('Provide one of: date, month & year, or startDate & endDate.');
    }
    if (modesGiven > 1) {
      return helpers.message('Provide only one of: date, month & year, or startDate & endDate — not more than one.');
    }
    if ((value.month && !value.year) || (!value.month && value.year)) {
      return helpers.message('month and year must be provided together.');
    }
    if ((value.startDate && !value.endDate) || (!value.startDate && value.endDate)) {
      return helpers.message('startDate and endDate must be provided together.');
    }

    return value;
  }, 'exactly-one-period-mode');

module.exports = {
  dailyReportQuerySchema,
  monthlyReportQuerySchema,
  rangeReportQuerySchema,
  projectHoursReportQuerySchema,
  timesheetApprovalStatusQuerySchema,
};
