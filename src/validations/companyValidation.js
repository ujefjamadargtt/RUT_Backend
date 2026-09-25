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
  // BU Hierarchy / Sub-BU support — when given, this Company is created as
  // a Sub-BU of that parent and always inherits the PARENT's entity_id (see
  // companyService.create()); entity_id is then optional here. Without it,
  // entity_id is required as before (a top-level Parent BU).
  parent_business_unit_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Parent Business Unit ID must be a number.',
    'number.positive': 'Parent Business Unit ID must be a positive integer.',
  }),

  entity_id: Joi.number()
    .integer()
    .positive()
    .when('parent_business_unit_id', { is: Joi.number().exist(), then: Joi.optional(), otherwise: Joi.required() })
    .messages({
      'number.base': 'Entity ID must be a number.',
      'number.positive': 'Entity ID must be a positive integer.',
      'any.required': 'Entity is required.',
    }),

  // "No need of BU code" for a Sub-BU — optional when parent_business_unit_id
  // is given (companyService.create() auto-generates one when omitted). A
  // top-level Parent BU still requires its own explicit code, as before.
  company_code: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(20)
    .when('parent_business_unit_id', { is: Joi.number().exist(), then: Joi.optional(), otherwise: Joi.required() })
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

  // Which Saturdays count as off for the Off-Day Approval Gate (see
  // src/utils/weekOffPolicy.js) — Sunday is always off for every BU. Defaults
  // to the strictest/most common pattern for a brand-new (top-level) BU. For
  // a Sub-BU (parent_business_unit_id given), companyService.create() always
  // overrides this with the PARENT's own saturday_off_rule instead — "off
  // day, it takes its parent" — so any value sent here is ignored in that case.
  saturday_off_rule: Joi.string().valid('ALL', 'ALT_1_3', 'ALT_2_4', 'NONE').optional().default('ALL').messages({
    'any.only': 'saturday_off_rule must be ALL, ALT_1_3, ALT_2_4, or NONE.',
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
  saturday_off_rule: Joi.string().valid('ALL', 'ALT_1_3', 'ALT_2_4', 'NONE').optional().messages({
    'any.only': 'saturday_off_rule must be ALL, ALT_1_3, ALT_2_4, or NONE.',
  }),
  // BU Hierarchy / Sub-BU support — reassign/detach this Company's parent.
  // `null` explicitly promotes a Sub-BU back to a top-level Parent BU; a
  // positive id re-validates the same depth-2/active-parent rules as create
  // (see companyService.update()/validateParentBusinessUnit()).
  parent_business_unit_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'Parent Business Unit ID must be a number.',
    'number.positive': 'Parent Business Unit ID must be a positive integer.',
  }),
})
  .min(1)
  .messages({ 'object.min': 'At least one field must be provided for update.' });

/**
 * GET /companies — list query params.
 * limit's max (500) is deliberately higher than the 100 most other masters
 * cap at — several "load BUs" dropdowns (Service PO/Employee/BU Head forms)
 * call this same endpoint with limit=200 expecting the full unpaginated set.
 */
const listCompaniesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(10),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(150).optional().allow(''),
  entity_id: Joi.number().integer().positive().optional(),
  // Multi-select narrowing (comma-separated ids), additive to the existing
  // single-value entity_id — see companyRepository.findAllForEntities().
  // entity_ids/business_unit_ids (this endpoint's own snake_case
  // convention) are the primary accepted names; entityIds/businessUnitIds
  // (camelCase, matching the Report endpoints' convention) are also
  // accepted for compatibility. The snake_case form wins when both are
  // somehow given.
  entity_ids: Joi.string().trim().optional(),
  business_unit_ids: Joi.string().trim().optional(),
  entityIds: Joi.string().trim().optional(),
  businessUnitIds: Joi.string().trim().optional(),
  sort_by: Joi.string().valid('company_name', 'company_code', 'status', 'created_at').default('company_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
};
