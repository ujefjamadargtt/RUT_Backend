'use strict';

const Joi = require('joi');

/**
 * Category Validation Schemas
 *
 * A category always belongs to exactly one module (module_id — the
 * module's own form_master row id, see database/migrations/
 * 20260881_add_form_master_categories.sql) and is never moved between
 * modules through these schemas; forms move between categories/modules via
 * formMasterValidation.js's moveFormSchema instead. seq is never accepted
 * from the client — it's computed server-side, and can only be changed via
 * reorderCategoriesSchema.
 */

const positiveId = Joi.number().integer().positive().messages({
  'number.base': 'Must be a positive integer ID.',
  'number.positive': 'Must be a positive integer ID.',
});

const categoryName = Joi.string().trim().min(1).max(100).messages({
  'string.empty': 'Category name is required.',
  'string.max': 'Category name cannot exceed 100 characters.',
});

const description = Joi.string().trim().max(255).allow('', null).messages({
  'string.max': 'Description cannot exceed 255 characters.',
});

const status = Joi.string().valid('active', 'inactive').messages({
  'any.only': 'Status must be active or inactive.',
});

const seqValue = Joi.number().integer().positive().messages({
  'number.base': 'seq must be a positive integer.',
  'number.positive': 'seq must be a positive integer.',
});

/**
 * POST /forms/categories
 */
const createCategorySchema = Joi.object({
  module_id: positiveId.required().messages({
    'any.required': 'module_id is required.',
  }),
  name: categoryName.required().messages({
    'any.required': 'Category name is required.',
  }),
  description,
  status: status.default('active'),
});

/**
 * PUT /forms/categories/:id
 * module_id is immutable — a category is never moved to a different
 * module; only its own forms move.
 */
const updateCategorySchema = Joi.object({
  name: categoryName,
  description,
  status,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /forms/categories — query params schema
 */
const listCategoriesSchema = Joi.object({
  module_id: positiveId,
  status: Joi.string().valid('active', 'inactive', 'all').default('all'),
});

/**
 * PATCH /forms/categories/reorder
 * All ids in items must already belong to module_id.
 */
const reorderCategoriesSchema = Joi.object({
  module_id: positiveId.required().messages({
    'any.required': 'module_id is required.',
  }),
  items: Joi.array()
    .items(
      Joi.object({
        id: positiveId.required(),
        seq: seqValue.required(),
      })
    )
    .min(1)
    .unique('id')
    .required()
    .messages({
      'array.min': 'items must contain at least one entry.',
      'array.unique': 'items must not contain duplicate ids.',
      'any.required': 'items is required.',
    }),
});

module.exports = {
  createCategorySchema,
  updateCategorySchema,
  listCategoriesSchema,
  reorderCategoriesSchema,
};
