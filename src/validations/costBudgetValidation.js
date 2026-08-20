'use strict';

const Joi = require('joi');
const { MONTH_STRING_PATTERN } = require('../helpers/monthPeriodHelper');

/**
 * Cost Budget Master Validation Schemas
 */

const monthField = () =>
  Joi.string().pattern(MONTH_STRING_PATTERN).messages({
    'string.pattern.base': 'month must be in YYYY-MM format.',
  });

const amountField = () =>
  Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .messages({
      'number.base': 'invoice_amount must be a number.',
      'number.min': 'invoice_amount cannot be negative.',
      'number.max': 'invoice_amount exceeds the maximum allowed value.',
    });

/**
 * POST /cost-budgets
 */
const createCostBudgetSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
    'any.required': 'service_po_id is required.',
  }),
  month: monthField().required().messages({
    'any.required': 'month is required.',
  }),
  invoice_amount: amountField().required().messages({
    'any.required': 'invoice_amount is required.',
  }),
  description: Joi.string().trim().max(2000).optional().allow('', null),
});

/**
 * PUT /cost-budgets/:id
 */
const updateCostBudgetSchema = Joi.object({
  invoice_amount: amountField().required().messages({
    'any.required': 'invoice_amount is required.',
  }),
  description: Joi.string().trim().max(2000).optional().allow('', null),
});

/**
 * GET /cost-budgets — query params
 */
const listCostBudgetQuerySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
  }),
  month: monthField().optional(),
});

module.exports = {
  createCostBudgetSchema,
  updateCostBudgetSchema,
  listCostBudgetQuerySchema,
};
