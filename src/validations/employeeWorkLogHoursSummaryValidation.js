'use strict';

const Joi = require('joi');

const periodFields = {
  // Keep the validated ISO date as YYYY-MM-DD for the repository's DATE
  // predicates; Joi otherwise converts it into a JavaScript Date object.
  date: Joi.date().iso().raw().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).optional(),
};

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

const employeeWorkLogHoursSummaryQuerySchema = Joi.object({
  ...periodFields,
  company_id: Joi.number().integer().positive().optional(),
  employeeId: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
  sortBy: Joi.string().valid('employee_name', 'employee_code', 'total_hours').default('employee_name'),
  sortOrder: Joi.string().valid('ASC', 'DESC').default('ASC'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
}).custom(requireDateOrMonth, 'date-or-month-period');

const employeeWorkLogHoursSummaryDetailQuerySchema = Joi.object({
  ...periodFields,
  company_id: Joi.number().integer().positive().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).custom(requireDateOrMonth, 'date-or-month-period');

const employeeWorkLogHoursSummaryDetailParamsSchema = Joi.object({
  employeeId: Joi.number().integer().positive().required(),
});

module.exports = {
  employeeWorkLogHoursSummaryQuerySchema,
  employeeWorkLogHoursSummaryDetailQuerySchema,
  employeeWorkLogHoursSummaryDetailParamsSchema,
};
