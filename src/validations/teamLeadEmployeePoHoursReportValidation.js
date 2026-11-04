'use strict';

const Joi = require('joi');

const idList = Joi.string().trim().pattern(/^\d+(,\d+)*$/).allow('').optional().messages({
  'string.pattern.base': '{{#label}} must be a comma-separated list of ids.',
});

const MAX_RANGE_DAYS = 366;

// Both dates or neither; the range (inclusive) may not exceed MAX_RANGE_DAYS.
const rangeLimit = (value, helpers) => {
  if (value.startDate && value.endDate) {
    const days = Math.round((new Date(value.endDate) - new Date(value.startDate)) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) return helpers.message(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return value;
};

const periodRules = (schema) => schema
  .and('month', 'year')
  .and('startDate', 'endDate')
  .oxor('month', 'startDate')
  .custom(rangeLimit)
  .messages({
    'object.and': 'Send both month and year, or both startDate and endDate.',
    'object.oxor': 'Send either month+year or startDate+endDate, not both.',
  });

// Shared by the report and its export so the export accepts exactly what the screen does.
const reportFilterKeys = {
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2000).max(2100).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).optional(),
  hoursBasis: Joi.string().lowercase().valid('original', 'adjusted').default('original'),
  employeeIds: idList,
  clientIds: idList,
  projectIds: idList,
  servicePoIds: idList,
  entityIds: idList,
  buIds: idList,
  subBuIds: idList,
  search: Joi.string().trim().max(100).allow('').optional(),
};

/** GET /reports/team-lead-employee-po-hours — the Team Lead is always the authenticated caller. */
const teamLeadEmployeePoHoursQuerySchema = periodRules(Joi.object(reportFilterKeys));

/** GET /reports/team-lead-employee-po-hours/export */
const teamLeadEmployeePoHoursExportQuerySchema = periodRules(Joi.object({
  ...reportFilterKeys,
  format: Joi.string().lowercase().valid('excel').default('excel'),
}));

/** GET /reports/team-lead-employee-po-hours/filter-options — optional period only. */
const teamLeadEmployeePoHoursFilterOptionsQuerySchema = periodRules(Joi.object({
  month: reportFilterKeys.month,
  year: reportFilterKeys.year,
  startDate: reportFilterKeys.startDate,
  endDate: reportFilterKeys.endDate,
}));

module.exports = {
  reportFilterKeys,
  periodRules,
  teamLeadEmployeePoHoursQuerySchema,
  teamLeadEmployeePoHoursExportQuerySchema,
  teamLeadEmployeePoHoursFilterOptionsQuerySchema,
};
