'use strict';

const Joi = require('joi');
const { passwordComplexity } = require('./userValidation');

/**
 * Company Validation Schemas
 * Platform-level only — every route using these is gated by
 * requirePlatformAdmin, not a business role.
 */

/**
 * POST /companies — create a company + its first Company Admin, one transaction
 */
const createCompanySchema = Joi.object({
  company_code: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(20)
    .required()
    .messages({
      'string.min': 'Company code must be at least 2 characters.',
      'string.max': 'Company code cannot exceed 20 characters.',
      'string.empty': 'Company code is required.',
      'any.required': 'Company code is required.',
    }),

  company_name: Joi.string()
    .trim()
    .min(2)
    .max(150)
    .required()
    .messages({
      'string.min': 'Company name must be at least 2 characters.',
      'string.max': 'Company name cannot exceed 150 characters.',
      'string.empty': 'Company name is required.',
      'any.required': 'Company name is required.',
    }),

  admin_email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .max(100)
    .required()
    .messages({
      'string.email': 'Please provide a valid admin email address.',
      'any.required': 'Admin email is required.',
    }),

  admin_password: passwordComplexity.required(),
});

/**
 * PATCH /companies/:id — update a company (name/status only)
 */
const updateCompanySchema = Joi.object({
  company_name: Joi.string().trim().min(2).max(150).optional(),
  status: Joi.string().trim().lowercase().valid('active', 'inactive').optional(),
})
  .min(1)
  .messages({ 'object.min': 'At least one field must be provided for update.' });

/**
 * GET /companies — list query params
 */
const listCompaniesQuerySchema = Joi.object({
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(150).optional().allow(''),
});

module.exports = {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
};
