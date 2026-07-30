'use strict';

const Joi = require('joi');

/**
 * Timesheet Validation Schemas
 */

const idsField = Joi.alternatives()
  .try(
    Joi.array().items(Joi.number().integer().positive()).min(1),
    Joi.number().integer().positive()
  )
  .messages({
    'alternatives.match': 'ids must be a positive integer or a non-empty array of positive integers.',
  });

/**
 * POST /timesheets
 *
 * timesheet_import_id is required — every manually-created entry must be
 * attached to the monthly sheet (Timesheet Import History record) it
 * belongs to, e.g. the sheet an Admin is backfilling a missing row into.
 * The service layer verifies it exists and enforces the employee's 176-hour
 * cap scoped to that one import.
 *
 * client_id / service_type_id / service_category_id are optional — an
 * Admin Panel form supplying them gets an extra cross-check that the
 * selected project belongs to the selected client, and the selected Service
 * Type belongs to the selected Service Category (service layer validates
 * this against the resolved Service PO); omitting them skips that check,
 * same as an Excel-imported row which never states them independently.
 */
const createTimesheetSchema = Joi.object({
  employee_id: Joi.number().integer().positive().required().messages({
    'any.required': 'employee_id is required.',
    'number.base': 'employee_id must be a number.',
  }),
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'service_po_id is required.',
    'number.base': 'service_po_id must be a number.',
  }),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  timesheet_import_id: Joi.number().integer().positive().required().messages({
    'any.required': 'timesheet_import_id is required.',
    'number.base': 'timesheet_import_id must be a number.',
  }),
  client_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'client_id must be a number.',
  }),
  service_type_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'service_type_id must be a number.',
  }),
  service_category_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'service_category_id must be a number.',
  }),
  timesheet_date: Joi.date().iso().required().messages({
    'any.required': 'timesheet_date is required.',
    'date.format': 'timesheet_date must be in ISO format (YYYY-MM-DD).',
  }),
  hours_logged: Joi.number().min(0).max(999.99).required().messages({
    'any.required': 'hours_logged is required.',
    'number.min': 'hours_logged must be greater than or equal to 0.',
    'number.max': 'hours_logged cannot exceed 999.99.',
  }),
});

/**
 * PUT /timesheets/:id
 */
const updateTimesheetSchema = Joi.object({
  employee_id: Joi.number().integer().positive().optional(),
  service_po_id: Joi.number().integer().positive().optional(),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  timesheet_date: Joi.date().iso().optional().messages({
    'date.format': 'timesheet_date must be in ISO format (YYYY-MM-DD).',
  }),
  hours_logged: Joi.number().min(0).max(999.99).optional().messages({
    'number.min': 'hours_logged must be greater than or equal to 0.',
    'number.max': 'hours_logged cannot exceed 999.99.',
  }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * PATCH /timesheets/:id/modified-hours
 * HR-only. Sets the admin-adjustable "Modified Hours" for one timesheet
 * entry — never touches hours_logged. Same 0-999.99 bounds as hours_logged.
 */
const updateModifiedHoursSchema = Joi.object({
  modified_hours: Joi.number().min(0).max(999.99).required().messages({
    'any.required': 'modified_hours is required.',
    'number.base': 'modified_hours must be a number.',
    'number.min': 'modified_hours must be greater than or equal to 0.',
    'number.max': 'modified_hours cannot exceed 999.99.',
  }),
});

/**
 * PUT /timesheets/import/:timesheetImportId/hours
 * HR-only. Bulk-updates modified_hours for several timesheet entries
 * belonging to one monthly import. Never touches is_publish — see
 * timesheetService.bulkUpdateImportModifiedHours().
 */
const bulkUpdateImportHoursSchema = Joi.object({
  timesheets: Joi.array()
    .items(
      Joi.object({
        id: Joi.number().integer().positive().required().messages({
          'any.required': 'id is required.',
          'number.base': 'id must be a number.',
        }),
        hours: Joi.number().min(0).max(999.99).required().messages({
          'any.required': 'hours is required.',
          'number.base': 'hours must be a number.',
          'number.min': 'hours must be greater than or equal to 0.',
          'number.max': 'hours cannot exceed 999.99.',
        }),
      })
    )
    .min(1)
    .required()
    .messages({
      'array.min': 'timesheets must contain at least one entry.',
      'any.required': 'timesheets is required.',
    }),
});

/**
 * DELETE /timesheets  — deletes raw timesheet entries by timesheets.id
 * DELETE /timesheets/import — deletes monthly sheets by timesheet_import_history.id
 * Both share the same { ids } shape.
 */
const bulkIdsSchema = Joi.object({
  ids: idsField,
  id: Joi.number().integer().positive().optional(),
})
  .or('ids', 'id')
  .messages({
    'object.missing': 'ids (or id) is required.',
  });

/**
 * GET /timesheets — query params schema
 */
const listTimesheetsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  employeeId: Joi.number().integer().positive().optional(),
  poId: Joi.number().integer().positive().optional(),
  subProjectId: Joi.number().integer().positive().optional(),
  sortBy: Joi.string().valid('timesheet_date', 'hours_logged', 'created_at').default('timesheet_date'),
  sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
  // NOT the authenticated user's real role (req.userRoles/JWT) — this is an
  // explicit product decision for the hours-visibility rule (see
  // src/utils/hoursVisibility.js). Only compared case-insensitively to
  // "management"; any other value (or omission) shows both hours fields.
  role: Joi.string().trim().min(1).optional(),
});

module.exports = {
  createTimesheetSchema,
  updateTimesheetSchema,
  updateModifiedHoursSchema,
  bulkUpdateImportHoursSchema,
  bulkIdsSchema,
  listTimesheetsQuerySchema,
};
