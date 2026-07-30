'use strict';

const Joi = require('joi');

/**
 * Sub-Project Validation Schemas
 */

const subProjectCodePattern = /^[A-Z0-9_/-]{2,30}$/;

/**
 * POST /sub-projects — Create new sub-project
 * The server auto-generates sub_project_code.
 */
const createSubProjectSchema = Joi.object({
  service_po_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Service PO ID must be a number.',
      'number.positive': 'Service PO ID must be a positive integer.',
      'any.required': 'Service PO is required.',
    }),

  sub_project_name: Joi.string()
    .trim()
    .min(3)
    .max(200)
    .required()
    .messages({
      'string.min': 'Sub-project name must be at least 3 characters.',
      'string.max': 'Sub-project name cannot exceed 200 characters.',
      'string.empty': 'Sub-project name is required.',
      'any.required': 'Sub-project name is required.',
    }),

  description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Description cannot exceed 2000 characters.',
    }),

  start_date: Joi.date()
    .iso()
    .required()
    .messages({
      'date.base': 'Start date must be a valid date.',
      'date.format': 'Start date must be in ISO format (YYYY-MM-DD).',
      'any.required': 'Start date is required.',
    }),

  end_date: Joi.date()
    .iso()
    .min(Joi.ref('start_date'))
    .required()
    .messages({
      'date.base': 'End date must be a valid date.',
      'date.format': 'End date must be in ISO format (YYYY-MM-DD).',
      'date.min': 'End date must be on or after the start date.',
      'any.required': 'End date is required.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive', 'completed', 'on-hold')
    .default('active')
    .messages({
      'any.only': 'Status must be one of: active, inactive, completed, on-hold.',
    }),
});

/**
 * PUT /sub-projects/:id — Update existing sub-project
 * All fields optional, at least one required.
 */
const updateSubProjectSchema = Joi.object({
  sub_project_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(subProjectCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Sub-project code must be 2-30 uppercase alphanumeric characters.',
    }),

  service_po_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Service PO ID must be a number.',
      'number.positive': 'Service PO ID must be a positive integer.',
    }),

  sub_project_name: Joi.string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .messages({
      'string.min': 'Sub-project name must be at least 3 characters.',
      'string.max': 'Sub-project name cannot exceed 200 characters.',
    }),

  description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null),

  start_date: Joi.date().iso().optional(),

  end_date: Joi.date()
    .iso()
    .when('start_date', {
      is: Joi.date().required(),
      then: Joi.date().min(Joi.ref('start_date')).messages({
        'date.min': 'End date must be on or after the start date.',
      }),
    })
    .optional(),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive', 'completed', 'on-hold')
    .optional()
    .messages({
      'any.only': 'Status must be one of: active, inactive, completed, on-hold.',
    }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /sub-projects — list query params
 */
const listSubProjectsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'completed', 'on-hold', 'all').default('active'),
  service_po_id: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string()
    .valid('sub_project_name', 'sub_project_code', 'start_date', 'end_date', 'created_at')
    .default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createSubProjectSchema,
  updateSubProjectSchema,
  listSubProjectsQuerySchema,
};
