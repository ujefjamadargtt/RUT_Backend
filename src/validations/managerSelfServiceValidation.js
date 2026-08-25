'use strict';

const Joi = require('joi');

const assignServicePOSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'service_po_id is required.',
  }),
});

const mapEmployeeSchema = Joi.object({
  employee_id: Joi.number().integer().positive().required().messages({
    'any.required': 'employee_id is required.',
  }),
});

/**
 * GET /my-team/timesheets — query params schema. Mirrors the generic
 * GET /timesheets's listTimesheetsQuerySchema (timesheetValidation.js) —
 * same filters the employee's own Timesheet screen already supports — with
 * `employeeId` replaced by `employee_id` (omitted entirely = "my own
 * timesheet") and re-validated server-side against the caller's mapped
 * Employees in managerSelfServiceService.getTimesheets(), never trusted
 * as-is.
 */
const listMyTeamTimesheetsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  employee_id: Joi.number().integer().positive().optional(),
  poId: Joi.number().integer().positive().optional(),
  subProjectId: Joi.number().integer().positive().optional(),
  sortBy: Joi.string().valid('timesheet_date', 'hours_logged', 'created_at').default('timesheet_date'),
  sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
  role: Joi.string().trim().min(1).optional(),
});

/**
 * GET /my-team/timesheets/approval-summary — query params schema.
 * log_type selects the aggregation grain (see
 * timesheetRepository.getDailyApprovalSummary()/getMonthlyApprovalSummary()'s
 * doc comments for why this is a query param, not a stored column filter).
 */
const approvalSummaryQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  employee_id: Joi.number().integer().positive().optional(),
  log_type: Joi.string().valid('daily', 'monthly').default('daily'),
});

const dateItem = Joi.date().iso().messages({
  'date.format': 'Each date must be in ISO format (YYYY-MM-DD).',
});

const monthYearItem = Joi.object({
  month: Joi.number().integer().min(1).max(12).required(),
  year: Joi.number().integer().min(2000).required(),
});

/**
 * POST /my-team/timesheets/approve — bulk approve. Exactly one of
 * dates/months must be supplied — daily bulk approval selects dates,
 * monthly bulk approval selects month/year pairs; never both.
 */
const bulkApproveTimesheetsSchema = Joi.object({
  employee_id: Joi.number().integer().positive().required().messages({
    'any.required': 'employee_id is required.',
  }),
  dates: Joi.array().items(dateItem).min(1).unique(),
  months: Joi.array().items(monthYearItem).min(1),
})
  .xor('dates', 'months')
  .messages({
    'object.xor': 'Provide exactly one of "dates" (daily approval) or "months" (monthly approval).',
  });

/**
 * PUT /my-team/timesheets/:id/reject — the remark is mandatory (a plain
 * "Rejected" with no reason is explicitly disallowed by spec) and must be
 * non-empty after trimming.
 */
const rejectWorkLogSchema = Joi.object({
  remark: Joi.string().trim().min(1).max(1000).required().messages({
    'any.required': 'remark is required.',
    'string.empty': 'remark is required.',
    'string.min': 'remark is required.',
    'string.max': 'remark cannot exceed 1000 characters.',
  }),
});

module.exports = {
  assignServicePOSchema,
  mapEmployeeSchema,
  listMyTeamTimesheetsQuerySchema,
  approvalSummaryQuerySchema,
  bulkApproveTimesheetsSchema,
  rejectWorkLogSchema,
};
