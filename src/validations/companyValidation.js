'use strict';

const Joi = require('joi');
const { passwordComplexity } = require('./userValidation');
const { createEmployeeSchema } = require('./employeeValidation');

/**
 * Company Validation Schemas
 * Entity Admin only — every route using these is gated by
 * requireEntityAdmin (repurposed from requirePlatformAdmin when Entity
 * Admin was introduced — see database/migrations/20260826_add_entity_admin_role.sql).
 */

/**
 * The BU Admin's Employee profile fields, nested under `employee` in the
 * request body — reuses createEmployeeSchema's fields/validation verbatim
 * instead of maintaining a second copy of the same rules. `email`/`password`
 * are forked to optional here because the login credentials for this flow
 * are collected separately, under `admin` (see createCompanySchema below and
 * companyService.createWithAdmin's cross-check that employee.email, when
 * given, matches admin.admin_email) — but the frontend's Employee-creation
 * form component sends `email` on this object too, so it must stay an
 * allowed key rather than becoming "not allowed". Manager-assignment fields
 * are dropped entirely (forbidden) since no other User can exist yet in a
 * company that doesn't exist yet. is_timesheet_approval_required is also
 * forbidden — a BU Admin's own timesheets are always auto-published
 * (never held for approval); the backend hardcodes this to false in
 * companyService.createWithAdmin rather than letting the creation form
 * opt in to approval-required.
 */
const employeeSubSchema = createEmployeeSchema
  .fork(['email', 'password'], (schema) => schema.optional())
  .fork(
    ['primary_manager_user_id', 'secondary_manager_user_id', 'is_timesheet_approval_required'],
    (schema) => schema.forbidden()
  );

/**
 * POST /companies — create a company + its first BU Admin, one transaction,
 * under one of the calling Entity Admin's own owned Entities. Body shape
 * matches the frontend's three-section form: `company`, `admin` (login
 * credentials), `employee` (the same fields/validation as POST /employees).
 */
const createCompanySchema = Joi.object({
  company: Joi.object({
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
  })
    .required()
    .messages({ 'any.required': 'Company details are required.' }),

  admin: Joi.object({
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
  })
    .required()
    .messages({ 'any.required': 'Admin login details are required.' }),

  employee: employeeSubSchema
    .required()
    .messages({ 'any.required': 'Employee details are required.' }),
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
