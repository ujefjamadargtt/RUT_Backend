'use strict';

const Joi = require('joi');

/**
 * Employee Service PO Mapping Validation Schemas
 */

/**
 * POST /employee-servicepo-mapping
 */
const assignMappingSchema = Joi.object({
  employee_id: Joi.number().integer().positive().required().messages({
    'any.required': 'employee_id is required.',
    'number.base': 'employee_id must be a number.',
  }),
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'service_po_id is required.',
    'number.base': 'service_po_id must be a number.',
  }),
});

/**
 * GET /employee-servicepo-mapping/employee/:employeeId
 * GET /employee-servicepo-mapping/service-po/:servicePOId
 */
const listMappingsQuerySchema = Joi.object({
  status: Joi.string().trim().lowercase().valid('active', 'inactive').optional(),
});

/**
 * PUT /employee-servicepo-mapping/employee/:employeeId
 * `service_po_ids` is the DESIRED full set of active mappings for this
 * Employee — an empty array is valid (unmaps everything).
 */
const saveEmployeeMappingsSchema = Joi.object({
  service_po_ids: Joi.array().items(Joi.number().integer().positive()).required().messages({
    'any.required': 'service_po_ids is required.',
    'array.base': 'service_po_ids must be an array.',
  }),
});

module.exports = {
  assignMappingSchema,
  listMappingsQuerySchema,
  saveEmployeeMappingsSchema,
};
