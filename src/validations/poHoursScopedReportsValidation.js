'use strict';

const Joi = require('joi');
const { reportFilterKeys, periodRules } = require('./teamLeadEmployeePoHoursReportValidation');

// company_id is read by resolveReportCompanyScope (the BU picked in the Global BU selector); the
// Joi schema must let it through or the validate middleware would 422 it.
const companyId = Joi.number().integer().positive().optional();

const reportKeys = { ...reportFilterKeys, company_id: companyId };

const reportSchema = () => periodRules(Joi.object(reportKeys));

const exportSchema = () => periodRules(Joi.object({
  ...reportKeys,
  format: Joi.string().lowercase().valid('excel').default('excel'),
}));

const filterOptionsSchema = () => periodRules(Joi.object({
  month: reportFilterKeys.month,
  year: reportFilterKeys.year,
  startDate: reportFilterKeys.startDate,
  endDate: reportFilterKeys.endDate,
  company_id: companyId,
}));

module.exports = {
  buAdminEmployeePoHoursQuerySchema: reportSchema(),
  buAdminEmployeePoHoursExportQuerySchema: exportSchema(),
  buAdminEmployeePoHoursFilterOptionsQuerySchema: filterOptionsSchema(),
  projectManagerEmployeePoHoursQuerySchema: reportSchema(),
  projectManagerEmployeePoHoursExportQuerySchema: exportSchema(),
  projectManagerEmployeePoHoursFilterOptionsQuerySchema: filterOptionsSchema(),
};
