'use strict';

const Joi = require('joi');

/**
 * Employee Timesheet Validation Schemas (Employee Self Timesheet module)
 */

/**
 * A single line item within a POST /employee-timesheets/entries REPLACE SAVE
 * payload — no timesheet_date of its own (the whole array shares the one
 * top-level date), no duplicate-entry concerns (the service layer wipes and
 * reinserts every entry for that date in one transaction, so there is no
 * "existing" row to collide with — see replaceDailyEntriesSchema).
 */
const dailyEntryLineSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Service PO is required.',
    'number.base': 'Service PO must be a number.',
  }),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  // Optional: which Service PO Hierarchy node (Parent or Child) the hours
  // are logged against — see servicePOHierarchyService.js. Purely a tag
  // alongside service_po_id, which stays the required/authoritative field.
  hierarchy_node_id: Joi.number().integer().positive().optional().allow(null),
  hours: Joi.number().positive().max(12).required().messages({
    'any.required': 'Hours is required.',
    'number.base': 'Hours must be a number.',
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  description: Joi.string().trim().min(1).max(2000).required().messages({
    'any.required': 'Description is required.',
    'string.min': 'Description cannot be empty.',
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
});

/**
 * POST /employee-timesheets/entries
 * REPLACE SAVE: the frontend always sends the COMPLETE set of entries for
 * one employee/date — the service layer deletes every existing entry for
 * that date and reinserts exactly this list, in one transaction. An empty
 * `entries` array is valid — it means "clear this date's timesheet
 * entirely." The 12-hour/day cap is validated at the service layer against
 * the SUM of this array's `hours`, not per line.
 */
const replaceDailyEntriesSchema = Joi.object({
  timesheet_date: Joi.date().iso().required().messages({
    'any.required': 'Date is required.',
    'date.format': 'Date must be in ISO format (YYYY-MM-DD).',
  }),
  entries: Joi.array().items(dailyEntryLineSchema).required().messages({
    'any.required': 'entries is required.',
    'array.base': 'entries must be an array.',
  }),
});

/**
 * PUT /employee-timesheets/entries/:id
 */
const updateEntrySchema = Joi.object({
  service_po_id: Joi.number().integer().positive().optional(),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  hierarchy_node_id: Joi.number().integer().positive().optional().allow(null),
  hours: Joi.number().positive().max(12).optional().messages({
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  description: Joi.string().trim().min(1).max(2000).optional().messages({
    'string.min': 'Description cannot be empty.',
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
  timesheet_date: Joi.date().iso().optional().messages({
    'date.format': 'Date must be in ISO format (YYYY-MM-DD).',
  }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /employee-timesheets/calendar
 */
const monthYearQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required().messages({
    'any.required': 'month is required.',
  }),
  year: Joi.number().integer().min(2000).required().messages({
    'any.required': 'year is required.',
  }),
});

/**
 * GET /employee-timesheets/monthly-summary
 * viewType is optional and defaults to 'day' — omitting it entirely keeps
 * today's exact response (per-date Service PO hierarchy breakdown).
 * viewType=month switches to the aggregated Service PO totals table.
 */
const monthlySummaryQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required().messages({
    'any.required': 'month is required.',
  }),
  year: Joi.number().integer().min(2000).required().messages({
    'any.required': 'year is required.',
  }),
  viewType: Joi.string().valid('day', 'month').optional().default('day').messages({
    'any.only': 'viewType must be either day or month.',
  }),
});

/**
 * GET /employee-timesheets/daily
 */
const dailyQuerySchema = Joi.object({
  date: Joi.date().iso().required().messages({
    'any.required': 'date is required.',
    'date.format': 'date must be in ISO format (YYYY-MM-DD).',
  }),
});

module.exports = {
  replaceDailyEntriesSchema,
  updateEntrySchema,
  monthYearQuerySchema,
  monthlySummaryQuerySchema,
  dailyQuerySchema,
};
