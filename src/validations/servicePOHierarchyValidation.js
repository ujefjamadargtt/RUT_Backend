'use strict';

const Joi = require('joi');

/**
 * Service PO Hierarchy Validation Schemas.
 * node_type is never accepted from the client — it's implied by which
 * route is called (POST .../hierarchy/parent -> PARENT,
 * POST .../hierarchy/:parentId/child -> CHILD).
 */

/**
 * POST /service-pos/:servicePoId/hierarchy/parent — create a Parent
 * POST /service-pos/:servicePoId/hierarchy/:parentId/child — create a Child
 */
const createHierarchyNodeSchema = Joi.object({
  node_name: Joi.string().trim().min(1).max(255).required().messages({
    'any.required': 'Node name is required.',
    'string.min': 'Node name cannot be empty.',
    'string.max': 'Node name cannot exceed 255 characters.',
  }),
  display_order: Joi.number().integer().min(0).optional(),
});

/**
 * PUT /service-pos/hierarchy/:hierarchyId — rename (and/or reorder)
 */
const renameHierarchyNodeSchema = Joi.object({
  node_name: Joi.string().trim().min(1).max(255).optional().messages({
    'string.min': 'Node name cannot be empty.',
    'string.max': 'Node name cannot exceed 255 characters.',
  }),
  display_order: Joi.number().integer().min(0).optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

module.exports = {
  createHierarchyNodeSchema,
  renameHierarchyNodeSchema,
};
