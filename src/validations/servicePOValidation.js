'use strict';

const Joi = require('joi');

/**
 * Service PO Validation Schemas
 */

const poCodePattern = /^[A-Z0-9_/-]{2,30}$/;

/**
 * POST /service-pos — Create new Service PO
 */
const createServicePOSchema = Joi.object({
  service_po_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(poCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'PO code must be 2-30 uppercase alphanumeric characters (hyphens, underscores, slashes allowed).',
    }),

  service_po_name: Joi.string()
    .trim()
    .min(3)
    .max(200)
    .required()
    .messages({
      'string.min': 'Service PO name must be at least 3 characters.',
      'string.max': 'Service PO name cannot exceed 200 characters.',
      'any.required': 'Service PO name is required.',
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

  project_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Project ID must be a number.',
      'number.positive': 'Project ID must be a positive integer.',
      'any.required': 'Project is required.',
    }),

  // Employee Master ID — never a User Master ID. Mandatory on create per
  // the Client -> Project -> Service PO -> Delivery Head flow; see
  // updateServicePOSchema below for why it's optional on update.
  delivery_head_employee_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Delivery Head employee ID must be a number.',
      'number.positive': 'Delivery Head employee ID must be a positive integer.',
      'any.required': 'Delivery Head is required.',
    }),

  service_type_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Service type ID must be a number.',
      'number.positive': 'Service type ID must be a positive integer.',
      'any.required': 'Service type is required.',
    }),

  po_value: Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .optional()
    .allow(null)
    .messages({
      'number.base': 'PO value must be a number.',
      'number.min': 'PO value cannot be negative.',
      'number.max': 'PO value exceeds maximum allowed amount.',
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

  expected_man_hours: Joi.number()
    .precision(2)
    .min(0)
    .max(9_999_999_999)
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Expected man hours must be a number.',
      'number.min': 'Expected man hours cannot be negative.',
    }),

  is_billable: Joi.boolean()
    .default(true)
    .messages({
      'boolean.base': 'is_billable must be a boolean (true or false).',
    }),

  account_manager: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow(null, '')
    .messages({
      'string.max': 'Account manager name cannot exceed 100 characters.',
    }),

  service_description: Joi.string()
    .trim()
    .max(5000)
    .optional()
    .allow(null, '')
    .messages({
      'string.max': 'Service description cannot exceed 5000 characters.',
    }),

  invoice_frequency: Joi.string()
    .valid('monthly', 'milestone-based', 'internal-no-invoice', 'poc', 'yearly-amc')
    .optional()
    .allow(null)
    .messages({
      'any.only': 'Invoice frequency must be one of: monthly, milestone-based, internal-no-invoice, poc, yearly-amc.',
    }),

  invoice_amount: Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Invoice amount must be a number.',
      'number.min': 'Invoice amount cannot be negative.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed')
    .default('pending')
    .messages({
      'any.only': 'Status must be one of: in-progress, completed, on-hold, pending, cancelled, closed.',
    }),
});

/**
 * PUT /service-pos/:id — Update Service PO
 */
const updateServicePOSchema = Joi.object({
  service_po_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(poCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'PO code must be 2-30 uppercase alphanumeric characters.',
    }),

  service_po_name: Joi.string()
    .trim()
    .min(3)
    .max(200)
    .optional(),

  client_id: Joi.number().integer().positive().optional(),

  project_id: Joi.number().integer().positive().optional(),

  // Optional on update — mandatory only for NEW Service PO creation, so a
  // pre-existing PO created before this feature (no Delivery Head yet)
  // isn't broken, and one can be added later via edit.
  delivery_head_employee_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Delivery Head employee ID must be a number.',
      'number.positive': 'Delivery Head employee ID must be a positive integer.',
    }),

  service_type_id: Joi.number().integer().positive().optional(),

  po_value: Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .optional()
    .allow(null),

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

  expected_man_hours: Joi.number()
    .precision(2)
    .min(0)
    .max(9_999_999_999)
    .optional()
    .allow(null),

  is_billable: Joi.boolean().optional(),

  account_manager: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow(null, ''),

  service_description: Joi.string()
    .trim()
    .max(5000)
    .optional()
    .allow(null, ''),

  invoice_frequency: Joi.string()
    .valid('monthly', 'milestone-based', 'internal-no-invoice', 'poc', 'yearly-amc')
    .optional()
    .allow(null)
    .messages({
      'any.only': 'Invoice frequency must be one of: monthly, milestone-based, internal-no-invoice, poc, yearly-amc.',
    }),

  invoice_amount: Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Invoice amount must be a number.',
      'number.min': 'Invoice amount cannot be negative.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed')
    .optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * POST /service-pos/:id/resources — Allocate employees to a PO
 */
const allocateResourcesSchema = Joi.object({
  employee_ids: Joi.array()
    .items(
      Joi.number()
        .integer()
        .positive()
        .messages({
          'number.base': 'Each employee ID must be a number.',
          'number.positive': 'Each employee ID must be a positive integer.',
        })
    )
    .min(1)
    .max(100)
    .unique()
    .required()
    .messages({
      'array.base': 'employee_ids must be an array.',
      'array.min': 'At least one employee must be specified.',
      'array.max': 'Cannot allocate more than 100 employees at once.',
      'array.unique': 'Duplicate employee IDs are not allowed.',
      'any.required': 'employee_ids is required.',
    }),
});

/**
 * DELETE /service-pos/:id/resources — Remove employees from a PO
 */
const removeResourcesSchema = Joi.object({
  employee_ids: Joi.array()
    .items(Joi.number().integer().positive())
    .min(1)
    .unique()
    .required()
    .messages({
      'array.min': 'At least one employee ID must be specified for removal.',
      'any.required': 'employee_ids is required.',
    }),
});

/**
 * GET /service-pos — list query params
 */
const listServicePOsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed', 'all').default('all'),
  client_id: Joi.number().integer().positive().optional(),
  project_id: Joi.number().integer().positive().optional(),
  service_category_id: Joi.number().integer().positive().optional(),
  service_type_id: Joi.number().integer().positive().optional(),
  service_po_id: Joi.number().integer().positive().optional(),
  is_billable: Joi.boolean().optional(),
  search: Joi.string().trim().max(100).optional().allow(''),
  start_date_from: Joi.date().iso().optional(),
  start_date_to: Joi.date().iso().min(Joi.ref('start_date_from')).optional(),
  sort_by: Joi.string()
    .valid('service_po_name', 'service_po_code', 'start_date', 'end_date', 'po_value', 'created_at')
    .default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createServicePOSchema,
  updateServicePOSchema,
  allocateResourcesSchema,
  removeResourcesSchema,
  listServicePOsQuerySchema,
};