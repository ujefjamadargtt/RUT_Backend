'use strict';

const Joi = require('joi');

/**
 * Role Validation Schemas
 *
 * System roles: HR, Finance, Division Head, Project Manager, Management
 */

/**
 * POST /roles — Create new role
 */
const createRoleSchema = Joi.object({
  role_name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .required()
    .messages({
      'string.base': 'Role name must be a string.',
      'string.min': 'Role name must be at least 2 characters.',
      'string.max': 'Role name cannot exceed 50 characters.',
      'string.empty': 'Role name is required.',
      'any.required': 'Role name is required.',
    }),

  permission: Joi.string()
    .valid('Read', 'Read & Write')
    .default('Read')
    .messages({ 'any.only': 'Permission must be Read or Read & Write.' }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .default('active')
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),

  is_original_data_visible: Joi.boolean()
    .default(false)
    .messages({
      'boolean.base': 'is_original_data_visible must be true or false.',
    }),
});

/**
 * PUT /roles/:id — Update existing role
 * At least one field required.
 */
const updateRoleSchema = Joi.object({
  role_name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .optional()
    .messages({
      'string.min': 'Role name must be at least 2 characters.',
      'string.max': 'Role name cannot exceed 50 characters.',
    }),

  permission: Joi.string()
    .valid('Read', 'Read & Write')
    .optional()
    .messages({ 'any.only': 'Permission must be Read or Read & Write.' }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .optional()
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),

  is_original_data_visible: Joi.boolean()
    .optional()
    .messages({
      'boolean.base': 'is_original_data_visible must be true or false.',
    }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /roles — list query params
 */
const listRolesQuerySchema = Joi.object({
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(50).optional().allow(''),
  sort_by: Joi.string().valid('role_name', 'created_at').default('role_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createRoleSchema,
  updateRoleSchema,
  listRolesQuerySchema,
};
