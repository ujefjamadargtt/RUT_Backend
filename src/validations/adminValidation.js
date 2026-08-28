'use strict';

const Joi = require('joi');
const { passwordComplexity } = require('./userValidation');

/**
 * Admin ("Manage Entity Admins/BU Admins") Validation Schemas — Platform
 * Admin creates Admin (POST /admins); Admin itself manages Entity
 * Admins/BU Admins via entityAdmin.routes.js / entityBuAdmin.routes.js.
 */

const createAdminSchema = Joi.object({
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

const updateAdminSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(100).optional(),
})
  .min(1)
  .messages({ 'object.min': 'At least one field must be provided for update.' });

const listAdminsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'last_login').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  createAdminSchema,
  updateAdminSchema,
  listAdminsQuerySchema,
};
