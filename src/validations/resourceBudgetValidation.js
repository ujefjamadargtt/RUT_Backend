'use strict';

const Joi = require('joi');
const { MONTH_STRING_PATTERN } = require('../helpers/monthPeriodHelper');

/**
 * Resource Budget Master Validation Schemas
 */

const monthField = () =>
  Joi.string().pattern(MONTH_STRING_PATTERN).messages({
    'string.pattern.base': 'month must be in YYYY-MM format.',
  });

const hoursField = () =>
  Joi.number()
    .precision(2)
    .min(0)
    .max(9999)
    .messages({
      'number.base': 'hours must be a number.',
      'number.min': 'hours cannot be negative.',
      'number.max': 'hours exceeds the maximum allowed value.',
    });

/**
 * POST /resource-budgets
 */
const createResourceBudgetSchema = Joi.object({
  emp_id: Joi.number().integer().positive().required().messages({
    'number.base': 'emp_id must be a number.',
    'number.positive': 'emp_id must be a positive integer.',
    'any.required': 'emp_id is required.',
  }),
  service_po_id: Joi.number().integer().positive().required().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
    'any.required': 'service_po_id is required.',
  }),
  month: monthField().required().messages({
    'any.required': 'month is required.',
  }),
  hours: hoursField().required().messages({
    'any.required': 'hours is required.',
  }),
});

/**
 * PUT /resource-budgets/:id
 */
const updateResourceBudgetSchema = Joi.object({
  hours: hoursField().required().messages({
    'any.required': 'hours is required.',
  }),
});

/**
 * POST /resource-budgets/bulk
 */
const bulkResourceBudgetSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
    'any.required': 'service_po_id is required.',
  }),
  month: monthField().required().messages({
    'any.required': 'month is required.',
  }),
  resources: Joi.array()
    .items(
      Joi.object({
        emp_id: Joi.number().integer().positive().required().messages({
          'number.base': 'emp_id must be a number.',
          'number.positive': 'emp_id must be a positive integer.',
          'any.required': 'emp_id is required.',
        }),
        hours: hoursField().required().messages({
          'any.required': 'hours is required.',
        }),
      })
    )
    .min(1)
    .unique('emp_id')
    .required()
    .messages({
      'array.min': 'resources must contain at least one entry.',
      'array.unique': 'resources cannot contain duplicate emp_id entries.',
      'any.required': 'resources is required.',
    }),
});

/**
 * GET /resource-budgets — query params
 */
const listResourceBudgetQuerySchema = Joi.object({
  emp_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'emp_id must be a number.',
    'number.positive': 'emp_id must be a positive integer.',
  }),
  month: monthField().optional(),
});

module.exports = {
  createResourceBudgetSchema,
  updateResourceBudgetSchema,
  bulkResourceBudgetSchema,
  listResourceBudgetQuerySchema,
};
