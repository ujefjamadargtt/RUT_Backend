'use strict';

const Joi = require('joi');

/**
 * Form Master Validation Schemas
 */

const moduleName = Joi.string().trim().min(1).max(100).messages({
  'string.empty': 'Module name is required.',
  'string.max': 'Module name cannot exceed 100 characters.',
});

const formName = Joi.string().trim().min(1).max(150).messages({
  'string.empty': 'Form name is required.',
  'string.max': 'Form name cannot exceed 150 characters.',
});

const status = Joi.string().valid('active', 'inactive').messages({
  'any.only': 'Status must be active or inactive.',
});

/**
 * POST /forms
 */
const createFormSchema = Joi.object({
  module_name: moduleName.required().messages({
    'any.required': 'Module name is required.',
  }),
  form_name: formName.required().messages({
    'any.required': 'Form name is required.',
  }),
  status: status.default('active'),
});

/**
 * PUT /forms/:id
 */
const updateFormSchema = Joi.object({
  module_name: moduleName,
  form_name: formName,
  status,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /forms — query params schema
 */
const listFormsSchema = Joi.object({
  status: Joi.string().valid('active', 'inactive', 'all').default('all'),
  search: Joi.string().trim().max(150).allow(''),
});

module.exports = {
  createFormSchema,
  updateFormSchema,
  listFormsSchema,
};
