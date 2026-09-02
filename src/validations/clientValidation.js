'use strict';

const Joi = require('joi');

/**
 * Client Validation Schemas
 */

const clientCodePattern = /^[A-Z0-9_-]{2,20}$/;

/**
 * POST /clients — Create new client
 */
const createClientSchema = Joi.object({
  // Only meaningful for a company-less actor (Admin/Entity Admin/Platform
  // Admin — req.companyId is undefined for them by design). A BU-scoped
  // actor's own req.companyId always wins over this field, so it can't be
  // used to create a Client in a company the caller doesn't belong to; see
  // clientService.resolveCreateCompanyId().
  company_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Business Unit (company_id) must be a number.',
  }),

  client_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(clientCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Client code must be 2-20 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  client_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      'string.min': 'Client name must be at least 2 characters.',
      'string.max': 'Client name cannot exceed 100 characters.',
      'string.empty': 'Client name is required.',
      'any.required': 'Client name is required.',
    }),

  industry: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Industry cannot exceed 100 characters.',
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
 * PUT /clients/:id — Update existing client
 */
const updateClientSchema = Joi.object({
  client_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(clientCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Client code must be 2-20 uppercase alphanumeric characters (hyphens and underscores allowed).',
    }),

  client_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .messages({
      'string.min': 'Client name must be at least 2 characters.',
      'string.max': 'Client name cannot exceed 100 characters.',
    }),

  industry: Joi.string()
    .trim()
    .max(100)
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
 * GET /clients — list query params
 */
const listClientsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  industry: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('client_name', 'client_code', 'industry', 'created_at').default('client_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
  // Optional BU filter — Admin/Entity Admin: narrows to that BU only (BU-less
  // records are excluded). BU-scoped actors: validated against their own BUs
  // by resolveReportCompanyScope before this ever reaches the service.
  company_id: Joi.number().integer().positive().optional(),
});

module.exports = {
  createClientSchema,
  updateClientSchema,
  listClientsQuerySchema,
};
