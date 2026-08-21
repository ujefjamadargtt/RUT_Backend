'use strict';

const Joi = require('joi');
const { createEmployeeSchema } = require('./employeeValidation');

/**
 * BU Head Validation Schemas
 *
 * createBuHeadSchema extends employeeValidation.createEmployeeSchema
 * verbatim (per the requirement that BU Head reuses the EXACT existing
 * Employee creation validation — employee_code/email/duplicate-shape rules,
 * etc. — rather than a parallel rule set), adding only `company_ids` (the
 * initial set of existing Companies/"BUs" to map this BU Head to — at least
 * one is required, since the Employee record created alongside it needs a
 * home company_id; see buHeadService.createBuHead). Manager assignment
 * fields are forbidden here — a BU Head's own Employee record has no
 * Primary/Secondary Manager, the same way a BU Admin's own Employee record
 * (created via companyService.createWithAdmin) never gets one.
 */
const companyIdsField = Joi.array()
  .items(Joi.number().integer().positive())
  .min(1)
  .required()
  .messages({
    'array.min': 'At least one company_id is required.',
    'any.required': 'company_ids is required.',
  });

const createBuHeadSchema = createEmployeeSchema
  .fork(['primary_manager_user_id', 'secondary_manager_user_id'], (schema) => schema.forbidden())
  .keys({
    company_ids: companyIdsField,
  });

/**
 * PUT /bu-heads/:id
 */
const updateBuHeadSchema = Joi.object({
  status: Joi.string().trim().lowercase().valid('active', 'inactive').optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

const setStatusSchema = Joi.object({
  status: Joi.string().trim().lowercase().valid('active', 'inactive').required(),
});

/**
 * POST /bu-heads/:id/companies
 */
const mapCompaniesSchema = Joi.object({
  company_ids: companyIdsField,
});

const listBuHeadsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'last_login').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createBuHeadSchema,
  updateBuHeadSchema,
  setStatusSchema,
  mapCompaniesSchema,
  listBuHeadsQuerySchema,
};
