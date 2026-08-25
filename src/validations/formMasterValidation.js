'use strict';

const Joi = require('joi');

/**
 * Form Master Validation Schemas
 *
 * A row is a MODULE when module_name is null, and a FORM (registered under
 * that module) when module_name is a string — see formMasterService.js.
 * seq is never accepted from the client on create/update: it's computed
 * server-side, and can only be changed via the dedicated reorder schemas
 * below.
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

const positiveId = Joi.number().integer().positive().messages({
  'number.base': 'Must be a positive integer ID.',
  'number.positive': 'Must be a positive integer ID.',
});

const seqValue = Joi.number().integer().positive().messages({
  'number.base': 'seq must be a positive integer.',
  'number.positive': 'seq must be a positive integer.',
});

const categoryId = Joi.number().integer().positive().allow(null).messages({
  'number.base': 'category_id must be a positive integer or null.',
  'number.positive': 'category_id must be a positive integer or null.',
});

/**
 * POST /forms
 * module_name omitted or null => create a module (form_name is the
 * module's own name). module_name a string => create a form under that
 * existing module.
 */
const createFormSchema = Joi.object({
  form_name: formName.required().messages({
    'any.required': 'Form name is required.',
  }),
  module_name: moduleName.allow(null).default(null),
  status: status.default('active'),
  // Only meaningful when module_name is a string (creating a form, not a
  // module) — assigns the new form directly under a category instead of
  // straight under the module. Omitted/null => Module -> Form (unchanged).
  category_id: categoryId,
});

/**
 * PUT /forms/:id
 * module_name may be sent as null (only valid if the row is already a
 * module) or a string (only valid if the row is already a form, in which
 * case it moves the form to that module). Omitting it leaves the row's
 * type/parent unchanged.
 */
const updateFormSchema = Joi.object({
  module_name: moduleName.allow(null),
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
  module_name: Joi.string().trim().max(100).allow(''),
});

/**
 * GET /forms/modules — query params schema. Defaults to active-only, unlike
 * listFormsSchema's 'all' default, since this feeds the Create Form
 * dropdown, which should offer only modules a new form can actually be
 * registered under.
 */
const listModulesSchema = Joi.object({
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
});

const reorderItemsSchema = Joi.array()
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
  });

/**
 * PATCH /forms/modules/reorder
 */
const reorderModulesSchema = Joi.object({
  items: reorderItemsSchema,
});

/**
 * PATCH /forms/reorder
 * All ids in items must already belong to module_name — reordering never
 * moves a form to a different module.
 */
const reorderFormsSchema = Joi.object({
  module_name: moduleName.required().messages({
    'any.required': 'Module name is required.',
  }),
  items: reorderItemsSchema,
});

/**
 * PUT /forms/:id/move
 * module_id moves the form to a different module (by the module row's own
 * id — unlike create/update, which address a module by name); category_id
 * assigns/reassigns/clears (null) its category. At least one of the two
 * must be given. Renaming and status changes are NOT part of this
 * endpoint — use PUT /forms/:id for those.
 */
const moveFormSchema = Joi.object({
  module_id: positiveId,
  category_id: categoryId,
})
  .min(1)
  .messages({
    'object.min': 'At least one of module_id or category_id must be provided.',
  });

module.exports = {
  createFormSchema,
  updateFormSchema,
  listFormsSchema,
  listModulesSchema,
  reorderModulesSchema,
  reorderFormsSchema,
  moveFormSchema,
};
