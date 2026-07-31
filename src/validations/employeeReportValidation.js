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

module.exports = {
  dailyReportQuerySchema,
  monthlyReportQuerySchema,
  rangeReportQuerySchema,
};
