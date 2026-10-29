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

// `business_unit_id` narrows the My Team list to Employees that have an
// active membership in that BU. Omitting it intentionally means every BU
// the Manager can access (the same as selecting "All Business Units").
const listMyEmployeesQuerySchema = Joi.object({
  business_unit_id: Joi.number().integer().positive().optional(),
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

// Filters shared by GET /my-team/timesheets/approval-summary/all and its
// .../export — kept in one place so the export always accepts exactly what
// the landing table itself does.
const approvalSummaryAllFilterKeys = {
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  log_type: Joi.string().valid('daily', 'monthly').default('daily'),
  business_unit_id: Joi.number().integer().positive().optional(),
  employee_ids: Joi.string().trim().pattern(/^\d+(,\d+)*$/).optional().messages({
    'string.pattern.base': 'employee_ids must be a comma-separated list of ids.',
  }),
  status: Joi.string().valid('all', 'pending', 'approved', 'rejected').default('all'),
  service_po_id: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
};

/**
 * GET /my-team/timesheets/approval-summary/all — the combined, server-
 * paginated "all my Employees" variant. Same date/log_type filters as the
 * single-employee schema above, plus the filters/sort the landing table
 * used to apply client-side. `employee_ids` optionally narrows (never
 * widens) the caller's own team.
 */
const approvalSummaryAllQuerySchema = Joi.object({
  ...approvalSummaryAllFilterKeys,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  sortBy: Joi.string().valid('employee', 'period', 'hours', 'entries', 'status').optional(),
  sortOrder: Joi.string().lowercase().valid('asc', 'desc').default('desc'),
});

/**
 * GET /my-team/timesheets/approval-summary/all/export — same filters as
 * the landing table, every matching row (no page/limit/sort; unknown keys
 * are stripped by the validate() middleware).
 */
const approvalSummaryAllExportQuerySchema = Joi.object({
  ...approvalSummaryAllFilterKeys,
  format: Joi.string().lowercase().valid('excel').default('excel'),
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

/**
 * Approver Revert / Delete of an approved work log — a non-empty reason is mandatory.
 */
const approvedWorkLogActionSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(1000).required().messages({
    'any.required': 'reason is required.',
    'string.base': 'reason is required.',
    'string.empty': 'reason is required.',
    'string.min': 'reason is required.',
    'string.max': 'reason cannot exceed 1000 characters.',
  }),
});

/**
 * Day-wise (bulk) Revert / Delete of approved work logs: one or more employees, each with one or more dates,
 * and ONE reason for all of them. Delete also needs confirm:true (it cannot be undone).
 */
const approvedWorkLogDateSelectionSchema = Joi.array().items(
  Joi.object({
    employee_id: Joi.number().integer().positive().required(),
    dates: Joi.array()
      .items(Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).messages({
        'string.pattern.base': 'dates must be YYYY-MM-DD.',
      }))
      .min(1)
      .max(62)
      .unique()
      .required()
      .messages({ 'array.min': 'Select at least one date.', 'array.unique': 'dates must not repeat.' }),
  })
).min(1).max(100).required().messages({ 'array.min': 'Select at least one employee and date.' });

const approvedWorkLogReasonSchema = Joi.string().trim().min(1).max(1000).required().messages({
  'any.required': 'reason is required.',
  'string.base': 'reason is required.',
  'string.empty': 'reason is required.',
  'string.min': 'reason is required.',
  'string.max': 'reason cannot exceed 1000 characters.',
});

const revertApprovedWorkLogsByDateSchema = Joi.object({
  selections: approvedWorkLogDateSelectionSchema,
  reason: approvedWorkLogReasonSchema,
});

const deleteApprovedWorkLogsByDateSchema = Joi.object({
  selections: approvedWorkLogDateSelectionSchema,
  reason: approvedWorkLogReasonSchema,
  confirm: Joi.boolean().valid(true).required().messages({
    'any.required': 'confirm must be true — deleting approved logs cannot be undone.',
    'any.only': 'confirm must be true — deleting approved logs cannot be undone.',
  }),
});

module.exports = {
  assignServicePOSchema,
  mapEmployeeSchema,
  listMyEmployeesQuerySchema,
  listMyTeamTimesheetsQuerySchema,
  approvalSummaryQuerySchema,
  approvalSummaryAllQuerySchema,
  approvalSummaryAllExportQuerySchema,
  bulkApproveTimesheetsSchema,
  rejectWorkLogSchema,
  approvedWorkLogActionSchema,
  revertApprovedWorkLogsByDateSchema,
  deleteApprovedWorkLogsByDateSchema,
};
