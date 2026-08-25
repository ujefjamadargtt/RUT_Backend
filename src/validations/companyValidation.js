'use strict';

const Joi = require('joi');

/**
 * Company Validation Schemas
 * Entity Admin only — every route using these is gated by
 * requireEntityAdmin (repurposed from requirePlatformAdmin when Entity
 * Admin was introduced — see database/migrations/20260826_add_entity_admin_role.sql).
 */

/**
 * POST /companies — create a bare company under one of the calling Entity
 * Admin's own owned Entities. Decoupled from admin-minting (Employee-as-
 * Identity redesign) — assigning a BU Admin afterward is an ordinary
 * Employee Master create/update call (role_ids + business_unit_ids), not
 * part of this payload.
 */
const createCompanySchema = Joi.object({
  entity_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Entity ID must be a number.',
      'number.positive': 'Entity ID must be a positive integer.',
      'any.required': 'Entity is required.',
    }),

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

  // Drives the Original Timesheet publish rule (see
  // src/utils/timesheetPublishPolicy.js) — see companies.is_original_data_visible's
  // column comment in src/models/Company.js for the full rule.
  is_original_data_visible: Joi.boolean().optional().default(false).messages({
    'boolean.base': 'is_original_data_visible must be true or false.',
  }),
});

/**
 * PATCH /companies/:id — update a company (name/status/is_original_data_visible)
 */
const updateCompanySchema = Joi.object({
  company_name: Joi.string().trim().min(2).max(150).optional(),
  status: Joi.string().trim().lowercase().valid('active', 'inactive').optional(),
  is_original_data_visible: Joi.boolean().optional().messages({
    'boolean.base': 'is_original_data_visible must be true or false.',
  }),
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
