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

module.exports = {
  assignMappingSchema,
  listMappingsQuerySchema,
};
