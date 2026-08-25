'use strict';

const Joi = require('joi');

/**
 * Project Validation Schemas
 * Mirrors clientValidation.js's shape.
 */

const projectCodePattern = /^[A-Z0-9_-]{2,30}$/;

/**
 * POST /projects — Create new project
 */
const createProjectSchema = Joi.object({
  // Only meaningful for a company-less actor (Admin/Entity Admin) — see
  // companyAccessControlService.resolveCreateCompanyId(). A BU-scoped
  // actor's own req.companyId always wins over this field.
  company_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Business Unit (company_id) must be a number.',
  }),

  client_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Client ID must be a number.',
      'number.positive': 'Client ID must be a positive integer.',
      'any.required': 'Client is required.',
    }),

  project_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(projectCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Project code must be 2-30 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  project_name: Joi.string()
    .trim()
    .min(2)
    .max(200)
    .required()
    .messages({
      'string.min': 'Project name must be at least 2 characters.',
      'string.max': 'Project name cannot exceed 200 characters.',
      'string.empty': 'Project name is required.',
      'any.required': 'Project name is required.',
    }),

  project_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Project description cannot exceed 2000 characters.',
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

/**
 * PUT /projects/:id — Update existing project
 */
const updateProjectSchema = Joi.object({
  client_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Client ID must be a number.',
      'number.positive': 'Client ID must be a positive integer.',
    }),

  project_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(projectCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Project code must be 2-30 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  project_name: Joi.string()
    .trim()
    .min(2)
    .max(200)
    .optional()
    .messages({
      'string.min': 'Project name must be at least 2 characters.',
      'string.max': 'Project name cannot exceed 200 characters.',
    }),

  project_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null),

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

/**
 * GET /projects — list query params
 */
const listProjectsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  client_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Client ID must be a number.',
    'number.positive': 'Client ID must be a positive integer.',
  }),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('project_name', 'project_code', 'created_at').default('project_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createProjectSchema,
  updateProjectSchema,
  listProjectsQuerySchema,
};
