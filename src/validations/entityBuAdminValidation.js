'use strict';

const Joi = require('joi');

/**
 * Entity BU Admin ("BU Admin Master") Validation Schemas.
 */

const updateBuAdminSchema = Joi.object({
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

const listBuAdminsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'last_login').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

module.exports = {
  updateBuAdminSchema,
  setStatusSchema,
  listBuAdminsQuerySchema,
};
