'use strict';

const Joi = require('joi');

/**
 * Entity Validation Schemas — mirrors projectValidation.js's shape.
 */

const entityCodePattern = /^[A-Z0-9_-]{2,20}$/;

const createEntitySchema = Joi.object({
  entity_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(entityCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Entity code must be 2-20 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  entity_name: Joi.string()
    .trim()
    .min(2)
    .max(150)
    .required()
    .messages({
      'string.min': 'Entity name must be at least 2 characters.',
      'string.max': 'Entity name cannot exceed 150 characters.',
      'string.empty': 'Entity name is required.',
      'any.required': 'Entity name is required.',
    }),

  // Optional at create time — an Admin may create an Entity unassigned and
  // assign it to an Entity Admin later via update(). Must be an existing
  // Entity Admin user id created by the calling Admin (enforced server-side
  // in entityService.js, never trusted from the request alone).
  entity_admin_employee_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Entity Admin employee ID must be a number.',
      'number.positive': 'Entity Admin employee ID must be a positive integer.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .default('active')
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),
});

const updateEntitySchema = Joi.object({
  entity_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(entityCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Entity code must be 2-20 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  entity_name: Joi.string()
    .trim()
    .min(2)
    .max(150)
    .optional()
    .messages({
      'string.min': 'Entity name must be at least 2 characters.',
      'string.max': 'Entity name cannot exceed 150 characters.',
    }),

  // (Re)assign this Entity to a different Entity Admin — same server-side
  // ownership validation as create().
  entity_admin_employee_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Entity Admin employee ID must be a number.',
      'number.positive': 'Entity Admin employee ID must be a positive integer.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .optional()
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

const listEntitiesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('entity_name', 'entity_code', 'created_at').default('entity_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createEntitySchema,
  updateEntitySchema,
  listEntitiesQuerySchema,
};
