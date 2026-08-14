'use strict';

const Joi = require('joi');

/**
 * Service PO Monthly Budget Validation Schemas
 */

// Shared amount field — non-negative decimal, 2 decimal places, matches
// DECIMAL(15,2) in service_po_monthly_budgets.
const amountField = (label) =>
  Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .messages({
      'number.base': `${label} must be a number.`,
      'number.min': `${label} cannot be negative.`,
      'number.max': `${label} exceeds the maximum allowed value.`,
    });

/**
 * GET /service-po-monthly-budgets — query params
 *
 * year is always required. service_po_id and month are each independently
 * optional EXCEPT month becomes required the moment service_po_id is given
 * (a single-record fetch is meaningless without a month — the table's
 * uniqueness is service_po_id + month + year).
 *
 *   ?year=2026                        -> every record in 2026 (role-scoped)
 *   ?month=8&year=2026                -> every record in August 2026 (role-scoped)
 *   ?service_po_id=101&month=8&year=2026 -> the single record for that PO
 *
 * See servicePOMonthlyBudgetService.listMonthlyBudgets / getOne.
 */
const getServicePOMonthlyBudgetQuerySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
  }),
  month: Joi.number()
    .integer()
    .min(1)
    .max(12)
    .when('service_po_id', { is: Joi.exist(), then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      'number.min': 'month must be between 1 and 12.',
      'number.max': 'month must be between 1 and 12.',
      'any.required': 'month is required when service_po_id is given.',
    }),
  year: Joi.number().integer().min(2000).max(2100).required().messages({
    'number.min': 'year must be a valid year.',
    'number.max': 'year must be a valid year.',
    'any.required': 'year is required.',
  }),
});

/**
 * POST /service-po-monthly-budgets — create/update (upsert)
 */
const upsertServicePOMonthlyBudgetSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'number.base': 'service_po_id must be a number.',
    'number.positive': 'service_po_id must be a positive integer.',
    'any.required': 'service_po_id is required.',
  }),
  month: Joi.number().integer().min(1).max(12).required().messages({
    'number.min': 'month must be between 1 and 12.',
    'number.max': 'month must be between 1 and 12.',
    'any.required': 'month is required.',
  }),
  year: Joi.number().integer().min(2000).max(2100).required().messages({
    'number.min': 'year must be a valid year.',
    'number.max': 'year must be a valid year.',
    'any.required': 'year is required.',
  }),
  invoice_amount: amountField('invoice_amount').required().messages({
    'any.required': 'invoice_amount is required.',
  }),
  invoice_description: Joi.string().trim().max(2000).optional().allow('', null),
  billed_amount: amountField('billed_amount').required().messages({
    'any.required': 'billed_amount is required.',
  }),
  billed_remark: Joi.string().trim().max(2000).optional().allow('', null),
});

module.exports = {
  getServicePOMonthlyBudgetQuerySchema,
  upsertServicePOMonthlyBudgetSchema,
};
