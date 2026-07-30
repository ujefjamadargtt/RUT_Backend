'use strict';

const Joi = require('joi');

/**
 * User Validation Schemas
 *
 * Password complexity: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special char.
 */

const passwordComplexity = Joi.string()
  .min(8)
  .max(128)
  .pattern(/[A-Z]/, 'uppercase letter')
  .pattern(/[a-z]/, 'lowercase letter')
  .pattern(/[0-9]/, 'digit')
  .pattern(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/, 'special character')
  .messages({
    'string.min': 'Password must be at least 8 characters.',
    'string.max': 'Password cannot exceed 128 characters.',
    'string.pattern.name': 'Password must contain at least one {#name}.',
    'string.empty': 'Password is required.',
    'any.required': 'Password is required.',
  });

/**
 * PUT /users/:id/change-password
 */
const changePasswordSchema = Joi.object({
  old_password: Joi.string().required().messages({
    'string.empty': 'old_password is required.',
    'any.required': 'old_password is required.',
  }),
  new_password: passwordComplexity.required(),
});

/**
 * POST /users — Create new portal user
 */
const createUserSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .max(100)
    .required()
    .messages({
      'string.email': 'Please provide a valid email address.',
      'string.max': 'Email cannot exceed 100 characters.',
      'any.required': 'Email is required.',
    }),

  password: passwordComplexity.required(),

  confirm_password: Joi.string()
    .valid(Joi.ref('password'))
    .required()
    .messages({
      'any.only': 'Confirm password must match the password.',
      'any.required': 'Confirm password is required.',
    }),

  role_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Role ID must be a number.',
      'number.positive': 'Role ID must be a positive integer.',
    }),

  role_ids: Joi.array()
    .items(
      Joi.number().integer().positive().messages({
        'number.base': 'Role ID must be a number.',
        'number.positive': 'Role ID must be a positive integer.',
      })
    )
    .min(1)
    .optional()
    .messages({
      'array.base': 'Role IDs must be an array of positive integers.',
      'array.min': 'At least one role must be provided.',
    }),

  employee_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .allow(null)
    .messages({
      'number.base': 'Employee ID must be a number.',
      'number.positive': 'Employee ID must be a positive integer.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .default('active')
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),
}).or('role_id', 'role_ids').messages({
  'object.missing': 'At least one role must be provided via role_id or role_ids.',
});

/**
 * PUT /users/:id — Update existing user
 */
const updateUserSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .max(100)
    .optional()
    .messages({
      'string.email': 'Please provide a valid email address.',
      'string.max': 'Email cannot exceed 100 characters.',
    }),

  role_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Role ID must be a number.',
      'number.positive': 'Role ID must be a positive integer.',
    }),

  role_ids: Joi.array()
    .items(
      Joi.number().integer().positive().messages({
        'number.base': 'Role ID must be a number.',
        'number.positive': 'Role ID must be a positive integer.',
      })
    )
    .min(1)
    .optional()
    .messages({
      'array.base': 'Role IDs must be an array of positive integers.',
      'array.min': 'At least one role must be provided.',
    }),

  employee_id: Joi.number()
    .integer()
    .positive()
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
 * PUT /users/:id/password — Admin password reset
 */
const adminResetPasswordSchema = Joi.object({
  new_password: passwordComplexity.required(),

  confirm_password: Joi.string()
    .valid(Joi.ref('new_password'))
    .required()
    .messages({
      'any.only': 'Passwords do not match.',
      'any.required': 'Confirm password is required.',
    }),
});

/**
 * GET /users — list query params
 */
const listUsersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  role_id: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'last_login').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createUserSchema,
  updateUserSchema,
  adminResetPasswordSchema,
  changePasswordSchema,
  listUsersQuerySchema,
  passwordComplexity,
};
