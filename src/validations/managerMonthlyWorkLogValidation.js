'use strict';

const Joi = require('joi');
const { monthYearQuerySchema } = require('./employeeTimesheetValidation');

/**
 * Manager Monthly Work Log Validation Schemas.
 *
 * A single line item within a POST/PUT submission — same shape as Employee
 * self-service's monthlyEntryLineSchema (employeeMonthlyWorkLogValidation.js)
 * with two deliberate differences:
 *   - hierarchy_node_id is NOT accepted here: a Manager can only log
 *     against the Employee's Main PO itself, never drill into a specific
 *     Parent/Child hierarchy node (may be added later — see
 *     employeeMonthlyWorkLogService.submitMonthlyWorkLog's
 *     allowHierarchyNode option, which enforces this same rule server-side
 *     as defense in depth).
 *   - description is OPTIONAL here (employee self-service requires it) —
 *     per spec, only Employee Code/Name, Service PO, and Hours are
 *     mandatory for a Manager-filled entry.
 */
const managerMonthlyEntryLineSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Service PO is required.',
    'number.base': 'Service PO must be a number.',
  }),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  hours: Joi.number().positive().max(176).required().messages({
    'any.required': 'Hours is required.',
    'number.base': 'Hours must be a number.',
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 176 per month.',
  }),
  description: Joi.string().trim().max(2000).allow('').optional().messages({
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
});

/**
 * POST /my-team/employees/:employeeId/monthly-worklog
 * PUT  /my-team/employees/:employeeId/monthly-worklog
 * REPLACE SAVE for the whole month, scoped to the target Employee.
 */
const submitManagerMonthlyWorkLogSchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required().messages({
    'any.required': 'month is required.',
  }),
  year: Joi.number().integer().min(2000).required().messages({
    'any.required': 'year is required.',
  }),
  entries: Joi.array().items(managerMonthlyEntryLineSchema).required().messages({
    'any.required': 'entries is required.',
    'array.base': 'entries must be an array.',
  }),
});

module.exports = {
  managerMonthlyEntryLineSchema,
  submitManagerMonthlyWorkLogSchema,
  monthYearQuerySchema,
};
