'use strict';

const Joi = require('joi');

const addManagerSchema = Joi.object({
  manager_user_id: Joi.number().integer().positive().required().messages({
    'any.required': 'manager_user_id is required.',
  }),
});

const grantServicePOSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'service_po_id is required.',
  }),
});

module.exports = {
  addManagerSchema,
  grantServicePOSchema,
};
