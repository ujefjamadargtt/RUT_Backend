'use strict';

const Joi = require('joi');
const { passwordComplexity } = require('./userValidation');

/**
 * Entity Admin Validation Schemas — Platform-level only, every route using
 * this is gated by requirePlatformAdmin. Mirrors companyValidation.js's
 * admin_email/admin_password fields, minus everything Company-specific
 * (Entity Admin creation never involves a Company or Entity).
 */

const createEntityAdminSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .max(100)
    .required()
    .messages({
      'string.email': 'Please provide a valid email address.',
      'any.required': 'Email is required.',
    }),

  password: passwordComplexity.required(),
});

const updateEntityAdminSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(100).optional(),
})
  .min(1)
  .messages({ 'object.min': 'At least one field must be provided for update.' });

const setStatusSchema = Joi.object({
  status: Joi.string().valid('active', 'inactive').required().messages({
    'any.only': 'status must be either "active" or "inactive".',
    'any.required': 'status is required.',
  }),
});

const listEntityAdminsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'last_login').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createEntityAdminSchema,
  updateEntityAdminSchema,
  setStatusSchema,
  listEntityAdminsQuerySchema,
};
