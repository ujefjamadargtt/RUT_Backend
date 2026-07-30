'use strict';

const Joi = require('joi');

/**
 * Employee Validation Schemas
 */

const employeeCodePattern = /^[A-Z0-9_/#-]{2,20}$/;

// Reusable sub-schemas
const experienceField = Joi.number()
  .precision(1)
  .min(0)
  .max(60)
  .messages({
    'number.base': 'Experience must be a number.',
    'number.min': 'Experience cannot be negative.',
    'number.max': 'Experience cannot exceed 60 years.',
  });

/**
 * POST /employees
 */
const createEmployeeSchema = Joi.object({
  employee_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(employeeCodePattern)
    .required()
    .messages({
      'string.pattern.base': 'Employee code must be 2-20 uppercase alphanumeric characters (- / # _ allowed).',
      'any.required': 'Employee code is required.',
    }),

  full_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      'string.min': 'Full name must be at least 2 characters.',
      'string.max': 'Full name cannot exceed 100 characters.',
      'any.required': 'Full name is required.',
    }),

  designation: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Designation cannot exceed 100 characters.',
    }),

  total_experience: experienceField.optional().allow(null),

  company_experience: experienceField
    .optional()
    .allow(null)
    .when('total_experience', {
      is: Joi.number().required(),
      then: Joi.number()
        .max(Joi.ref('total_experience'))
        .messages({
          'number.max': 'Company experience cannot exceed total experience.',
        }),
    }),

  email_id: Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: { allow: false } })
    .max(150)
    .optional()
    .allow('', null)
    .messages({
      'string.email': 'Email must be a valid email address.',
      'string.max': 'Email cannot exceed 150 characters.',
    }),

  resource_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Resource description cannot exceed 2000 characters.',
    }),

  date_of_joining: Joi.date()
    .iso()
    .max('now')
    .optional()
    .allow(null)
    .messages({
      'date.base': 'Date of joining must be a valid date.',
      'date.format': 'Date of joining must be in ISO format (YYYY-MM-DD).',
      'date.max': 'Date of joining cannot be in the future.',
    }),

  date_of_leaving: Joi.date()
    .iso()
    .min(Joi.ref('date_of_joining'))
    .optional()
    .allow(null)
    .messages({
      'date.base': 'Date of leaving must be a valid date.',
      'date.format': 'Date of leaving must be in ISO format (YYYY-MM-DD).',
      'date.min': 'Date of leaving must be on or after the date of joining.',
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
 * PUT /employees/:id
 * All fields optional, but at least one required.
 */
const updateEmployeeSchema = Joi.object({
  employee_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(employeeCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Employee code must be 2-20 uppercase alphanumeric characters (- / # _ allowed).',
    }),

  full_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .messages({
      'string.min': 'Full name must be at least 2 characters.',
      'string.max': 'Full name cannot exceed 100 characters.',
    }),

  designation: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow('', null),

  total_experience: experienceField.optional().allow(null),

  company_experience: experienceField.optional().allow(null),

  email_id: Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: { allow: false } })
    .max(150)
    .optional()
    .allow('', null)
    .messages({
      'string.email': 'Email must be a valid email address.',
      'string.max': 'Email cannot exceed 150 characters.',
    }),

  resource_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null),

  date_of_joining: Joi.date()
    .iso()
    .max('now')
    .optional()
    .allow(null),

  date_of_leaving: Joi.date()
    .iso()
    .optional()
    .allow(null),

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
 * GET /employees — query params schema
 */
const listEmployeesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  designation: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string()
    .valid('full_name', 'employee_code', 'date_of_joining', 'created_at', 'designation')
    .default('full_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesQuerySchema,
};
