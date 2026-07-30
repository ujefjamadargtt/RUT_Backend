'use strict';

const Joi = require('joi');

/**
 * Auth Validation Schemas
 */

/**
 * POST /auth/login
 */
const loginSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .required()
    .messages({
      'string.base': 'Email must be a string.',
      'string.email': 'Please provide a valid email address.',
      'string.empty': 'Email is required.',
      'any.required': 'Email is required.',
    }),

  password: Joi.string()
    .min(6)
    .required()
    .messages({
      'string.base': 'Password must be a string.',
      'string.min': 'Password must be at least 6 characters.',
      'string.empty': 'Password is required.',
      'any.required': 'Password is required.',
    }),
});

/**
 * POST /auth/refresh-token
 */
const refreshTokenSchema = Joi.object({
  refresh_token: Joi.string()
    .trim()
    .required()
    .messages({
      'string.empty': 'Refresh token is required.',
      'any.required': 'Refresh token is required.',
    }),
});

/**
 * POST /auth/change-password
 */
const changePasswordSchema = Joi.object({
  current_password: Joi.string()
    .min(6)
    .required()
    .messages({
      'string.min': 'Current password must be at least 6 characters.',
      'any.required': 'Current password is required.',
    }),

  new_password: Joi.string()
    .min(8)
    .pattern(/[A-Z]/, 'uppercase letter')
    .pattern(/[a-z]/, 'lowercase letter')
    .pattern(/[0-9]/, 'digit')
    .pattern(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, 'special character')
    .disallow(Joi.ref('current_password'))
    .required()
    .messages({
      'string.min': 'New password must be at least 8 characters.',
      'string.pattern.name': 'New password must contain at least one {#name}.',
      'any.invalid': 'New password must differ from your current password.',
      'any.required': 'New password is required.',
    }),

  confirm_password: Joi.string()
    .valid(Joi.ref('new_password'))
    .required()
    .messages({
      'any.only': 'Confirm password must match the new password.',
      'any.required': 'Confirm password is required.',
    }),
});

/**
 * POST /auth/forgot-password
 */
const forgotPasswordSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .required()
    .messages({
      'string.email': 'Please provide a valid email address.',
      'any.required': 'Email is required.',
    }),
});

/**
 * POST /auth/reset-password
 */
const resetPasswordSchema = Joi.object({
  token: Joi.string().trim().required().messages({
    'any.required': 'Reset token is required.',
  }),

  new_password: Joi.string()
    .min(8)
    .pattern(/[A-Z]/, 'uppercase letter')
    .pattern(/[a-z]/, 'lowercase letter')
    .pattern(/[0-9]/, 'digit')
    .pattern(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, 'special character')
    .required()
    .messages({
      'string.min': 'New password must be at least 8 characters.',
      'string.pattern.name': 'Password must contain at least one {#name}.',
      'any.required': 'New password is required.',
    }),

  confirm_password: Joi.string()
    .valid(Joi.ref('new_password'))
    .required()
    .messages({
      'any.only': 'Passwords do not match.',
      'any.required': 'Confirm password is required.',
    }),
});

module.exports = {
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
