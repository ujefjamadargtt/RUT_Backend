'use strict';

const Joi = require('joi');

/**
 * RBAC Validation Schemas
 */

const positiveId = Joi.number().integer().positive().messages({
  'number.base': 'Must be a positive integer ID.',
  'number.positive': 'Must be a positive integer ID.',
});

/**
 * POST /roles/user-mappings
 */
const mappingSchema = Joi.object({
  user_id: positiveId.required().messages({
    'any.required': 'user_id is required.',
  }),
  role_id: positiveId.required().messages({
    'any.required': 'role_id is required.',
  }),
});

/**
 * POST /roles/form-mappings
 */
const roleFormMappingSchema = Joi.object({
  role_id: positiveId.required().messages({
    'any.required': 'role_id is required.',
  }),
  form_id: positiveId.required().messages({
    'any.required': 'form_id is required.',
  }),
});

/**
 * PUT /roles/user-mappings/:userId
 * Replaces the user's entire set of role mappings with this list.
 */
const replaceUserRolesSchema = Joi.object({
  role_ids: Joi.array()
    .items(positiveId)
    .min(1)
    .unique()
    .required()
    .messages({
      'array.min': 'role_ids must contain at least one role.',
      'array.unique': 'role_ids must not contain duplicate role IDs.',
      'any.required': 'role_ids is required.',
    }),
});

/**
 * GET /roles/form-mappings?id=:id
 * Fetches a single role_form_mapping row by its own primary key (query
 * param, not a path param — distinct from GET /roles/form-mappings/:roleId,
 * which lists every mapping for one role).
 */
const getRoleFormMappingQuerySchema = Joi.object({
  id: positiveId.required().messages({
    'any.required': 'id is required.',
  }),
});

/**
 * POST /roles/forms
 * Fetches every active form for the given roles, each annotated with its
 * current mapping status — the admin Role-Form mapping screen's data source.
 */
const formsForRolesSchema = Joi.object({
  roleIds: Joi.array()
    .items(positiveId)
    .min(1)
    .unique()
    .required()
    .messages({
      'array.min': 'roleIds must contain at least one role.',
      'array.unique': 'roleIds must not contain duplicate role IDs.',
      'any.required': 'roleIds is required.',
    }),
});

/**
 * POST /roles/forms/mapping
 * Maps or unmaps one form for one role via the status flag. Field names are
 * camelCase here (roleId, formId), unlike the snake_case role_id/form_id
 * used by the older POST /roles/form-mappings endpoint — kept exactly as
 * specified for this endpoint rather than normalized, since this is the
 * literal payload shape the frontend integration was built against.
 */
const mapFormSchema = Joi.object({
  roleId: positiveId.required().messages({
    'any.required': 'roleId is required.',
  }),
  formId: positiveId.required().messages({
    'any.required': 'formId is required.',
  }),
  status: Joi.boolean().required().messages({
    'any.required': 'status is required.',
    'boolean.base': 'status must be true (map) or false (unmap).',
  }),
});

module.exports = {
  mappingSchema,
  roleFormMappingSchema,
  replaceUserRolesSchema,
  getRoleFormMappingQuerySchema,
  formsForRolesSchema,
  mapFormSchema,
};
