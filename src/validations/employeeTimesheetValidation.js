'use strict';

const Joi = require('joi');

/**
 * Employee Timesheet Validation Schemas (Employee Self Timesheet module)
 */

/**
 * POST /employee-timesheets/entries
 * Project, description, and hours are all mandatory; hours must be > 0 and
 * <= 12 (the daily cap is also enforced across ALL of a day's entries at
 * the service layer — this per-field bound just rejects an obviously
 * invalid single value early).
 */
const createEntrySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Service PO is required.',
    'number.base': 'Service PO must be a number.',
  }),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  hours: Joi.number().positive().max(12).required().messages({
    'any.required': 'Hours is required.',
    'number.base': 'Hours must be a number.',
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  description: Joi.string().trim().min(1).max(2000).required().messages({
    'any.required': 'Description is required.',
    'string.min': 'Description cannot be empty.',
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
  timesheet_date: Joi.date().iso().required().messages({
    'any.required': 'Date is required.',
    'date.format': 'Date must be in ISO format (YYYY-MM-DD).',
  }),
});

/**
 * PUT /employee-timesheets/entries/:id
 */
const updateEntrySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().optional(),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  hours: Joi.number().positive().max(12).optional().messages({
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  description: Joi.string().trim().min(1).max(2000).optional().messages({
    'string.min': 'Description cannot be empty.',
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
  timesheet_date: Joi.date().iso().optional().messages({
    'date.format': 'Date must be in ISO format (YYYY-MM-DD).',
  }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /employee-timesheets/calendar
 * GET /employee-timesheets/monthly-summary
 */
const monthYearQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required().messages({
    'any.required': 'month is required.',
  }),
  year: Joi.number().integer().min(2000).required().messages({
    'any.required': 'year is required.',
  }),
});

/**
 * GET /employee-timesheets/daily
 */
const dailyQuerySchema = Joi.object({
  date: Joi.date().iso().required().messages({
    'any.required': 'date is required.',
    'date.format': 'date must be in ISO format (YYYY-MM-DD).',
  }),
});

module.exports = {
  createEntrySchema,
  updateEntrySchema,
  monthYearQuerySchema,
  dailyQuerySchema,
};
