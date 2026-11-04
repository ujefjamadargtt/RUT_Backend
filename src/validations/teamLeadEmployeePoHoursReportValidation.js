'use strict';

const Joi = require('joi');

const idList = Joi.string().trim().pattern(/^\d+(,\d+)*$/).allow('').optional().messages({
  'string.pattern.base': '{{#label}} must be a comma-separated list of ids.',
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
const teamLeadEmployeePoHoursQuerySchema = Joi.object(reportFilterKeys)
  .and('month', 'year')
  .oxor('month', 'startDate');

/** GET /reports/team-lead-employee-po-hours/export */
const teamLeadEmployeePoHoursExportQuerySchema = Joi.object({
  ...reportFilterKeys,
  format: Joi.string().lowercase().valid('excel').default('excel'),
})
  .and('month', 'year')
  .oxor('month', 'startDate');

/** GET /reports/team-lead-employee-po-hours/filter-options — optional period only. */
const teamLeadEmployeePoHoursFilterOptionsQuerySchema = Joi.object({
  month: reportFilterKeys.month,
  year: reportFilterKeys.year,
  startDate: reportFilterKeys.startDate,
  endDate: reportFilterKeys.endDate,
})
  .and('month', 'year')
  .oxor('month', 'startDate');

module.exports = {
  teamLeadEmployeePoHoursQuerySchema,
  teamLeadEmployeePoHoursExportQuerySchema,
  teamLeadEmployeePoHoursFilterOptionsQuerySchema,
};
