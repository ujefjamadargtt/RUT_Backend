'use strict';

const Joi = require('joi');

/**
 * Employee Service PO Mapping Validation Schemas
 */

/**
 * POST /employee-servicepo-mapping
 * `is_project_manager` (Section 11.B — the Service PO Master "Map
 * Employees" entry point) defaults false — a plain employee mapping unless
 * explicitly requested otherwise. Server-side (employeeServicePOMappingService.
 * assign()) still validates the target Employee actually holds the Project
 * Manager role before honoring `true` — this schema only shapes the request.
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
  is_project_manager: Joi.boolean().default(false),
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
 * Employee — an empty array is valid (unmaps everything). Each entry is
 * EITHER a plain Service PO id (is_project_manager defaults false — the
 * original, still-fully-supported contract) OR
 * `{ service_po_id, is_project_manager }` (Section 11.A — the Employee
 * Master mapping screen's per-row "also make Project Manager" checkbox).
 * Mixing both forms in the same array is allowed.
 */
const servicePOEntrySchema = Joi.alternatives().try(
  Joi.number().integer().positive(),
  Joi.object({
    service_po_id: Joi.number().integer().positive().required(),
    is_project_manager: Joi.boolean().default(false),
  })
);

const saveEmployeeMappingsSchema = Joi.object({
  service_po_ids: Joi.array().items(servicePOEntrySchema).required().messages({
    'any.required': 'service_po_ids is required.',
    'array.base': 'service_po_ids must be an array.',
  }),
});

/**
 * PUT /employee-servicepo-mapping/:id/project-manager
 */
const updateProjectManagerFlagSchema = Joi.object({
  is_project_manager: Joi.boolean().required().messages({
    'any.required': 'is_project_manager is required.',
    'boolean.base': 'is_project_manager must be true or false.',
  }),
});

/**
 * GET /employee-servicepo-mapping/service-po/:servicePOId/options
 */
const getServicePOEmployeeOptionsQuerySchema = Joi.object({
  search: Joi.string().trim().max(100).optional().allow(''),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  // Panel's own opt-in Entity → BU filter dropdowns — see
  // employeeServicePOMappingService.getEmployeeOptionsForServicePO()'s doc comment.
  business_unit_id: Joi.number().integer().positive().optional(),
});

module.exports = {
  assignMappingSchema,
  listMappingsQuerySchema,
  saveEmployeeMappingsSchema,
  updateProjectManagerFlagSchema,
  getServicePOEmployeeOptionsQuerySchema,
};
