'use strict';

const Joi = require('joi');

/**
 * GET /reports/tenant-data-export — reporting period is mandatory (Sheets 4
 * & 5 are period-scoped; Sheets 1-3 are master data and ignore it), same
 * month/year convention as bu-performance-scorecard and the rest of the
 * Employee Reports module.
 */
const tenantDataExportQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required(),
  year: Joi.number().integer().min(2000).required(),
});

module.exports = { tenantDataExportQuerySchema };
