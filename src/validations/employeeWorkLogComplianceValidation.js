'use strict';

const Joi = require('joi');

/**
 * Shared period fields — identical to the Employee Work Log Hours Summary
 * validation (see employeeWorkLogHoursSummaryValidation.js): either a single
 * ISO date OR a month + year pair.  Raw mode keeps ISO dates as YYYY-MM-DD
 * strings so the repository can hand them straight to PostgreSQL DATE
 * predicates without an intermediate JS Date conversion.
 */
const periodFields = {
  date: Joi.date().iso().raw().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).optional(),
};

/**
 * Custom cross-field validator — exactly one of (date) or (month + year)
 * must be present; never both, never neither.
 */
function requireDateOrMonth(value, helpers) {
  const hasDate = !!value.date;
  const hasMonth = !!value.month && !!value.year;

  if (hasDate === hasMonth) {
    return helpers.message('Provide exactly one period: date, or month and year.');
  }
  if ((value.month && !value.year) || (!value.month && value.year)) {
    return helpers.message('month and year must be provided together.');
  }
  return value;
}

/**
 * GET /reports/employee-work-log-compliance query schema.
 */
const complianceReportQuerySchema = Joi.object({
  ...periodFields,
  company_id: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
  sortBy: Joi.string()
    .valid('employee_name', 'employee_code', 'total_hours', 'shortfall_hours')
    .default('employee_name'),
  sortOrder: Joi.string().valid('ASC', 'DESC').default('ASC'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
}).custom(requireDateOrMonth, 'date-or-month-period');

/**
 * POST /reports/employee-work-log-compliance/remind body schema.
 *
 * Single-employee reminder: the frontend sends EITHER date (date mode) OR
 * month + year (month mode), plus the employeeId.  The backend re-validates
 * the period and re-calculates logged hours before sending the email, so the
 * reminder can never be sent to an employee who is already complete.
 */
const complianceReminderBodySchema = Joi.object({
  employeeId: Joi.number().integer().positive().required(),
  ...periodFields,
}).custom(requireDateOrMonth, 'date-or-month-period');

/**
 * POST /reports/employee-work-log-compliance/remind-bulk body schema.
 *
 * Bulk reminder: send to a selected list of employees OR to all employees
 * currently below the threshold (remindAll = true) for the given period.
 *
 * - employeeIds: explicit list of employee IDs to remind (required unless
 *   remindAll = true).
 * - remindAll:   when true, the backend ignores employeeIds and resolves the
 *   complete set of authorised, below-threshold employees itself — the
 *   frontend never needs to send a list of IDs for the "Remind All" case.
 * - company_id:  optional BU filter — only meaningful when remindAll=true.
 *   Narrows the scope to employees of that single BU (must be within the
 *   caller's authorised reach). When absent with remindAll=true the scope
 *   is every BU the caller is authorised to see (i.e. "All BUs").
 *
 * Max 200 explicit IDs per request to prevent runaway email bursts.
 */
const complianceReminderBulkBodySchema = Joi.object({
  ...periodFields,
  company_id: Joi.number().integer().positive().optional(),
  employeeIds: Joi.array()
    .items(Joi.number().integer().positive())
    .min(1)
    .max(200)
    .optional(),
  remindAll: Joi.boolean().default(false),
})
  .custom(requireDateOrMonth, 'date-or-month-period')
  .custom((value, helpers) => {
    if (!value.remindAll && (!value.employeeIds || value.employeeIds.length === 0)) {
      return helpers.message('Provide either employeeIds or set remindAll to true.');
    }
    return value;
  }, 'employeeIds-or-remindAll');

module.exports = {
  complianceReportQuerySchema,
  complianceReminderBodySchema,
  complianceReminderBulkBodySchema,
};
