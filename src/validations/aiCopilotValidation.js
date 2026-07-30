'use strict';

const Joi = require('joi');

/**
 * AI Copilot Validation Schemas
 */

/**
 * POST /ai/query
 */
const aiQuerySchema = Joi.object({
  question: Joi.string().trim().min(3).max(500).required().messages({
    'string.empty': 'question is required.',
    'string.min': 'question must be at least 3 characters.',
    'string.max': 'question cannot exceed 500 characters.',
    'any.required': 'question is required.',
  }),
  // Optional, same convention every other analytics endpoint in this app
  // already uses (roleId sent directly by the frontend; hoursSource picks
  // modified_hours vs original hours_logged) — kept consistent rather than
  // introducing a different convention for this one new endpoint.
  roleId: Joi.number().integer().positive().optional(),
  hoursSource: Joi.string().valid('O', 'M').optional(),
});

module.exports = { aiQuerySchema };
