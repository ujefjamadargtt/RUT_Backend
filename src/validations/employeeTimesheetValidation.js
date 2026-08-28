'use strict';

const Joi = require('joi');
const { TIME_PATTERN } = require('../helpers/workLogTimeHelper');

/**
 * Employee Timesheet Validation Schemas (Employee Self Timesheet module)
 */

/**
 * One Start Time/End Time segment within a `time_entries` array — see
 * EmployeeWorkLogTimeEntry.js. Chronological ordering (end_time > start_time)
 * and cross-segment overlap are deliberately NOT checked here; that's the
 * service layer's job (employeeTimesheetService.resolveHoursAndTimeEntries /
 * workLogTimeHelper.calculateHoursFromTimes/assertNoOverlappingEntries),
 * which returns a plain 400 with a specific message rather than a generic
 * 422 VALIDATION_ERROR envelope.
 */
const timeEntrySchema = Joi.object({
  start_time: Joi.string().pattern(TIME_PATTERN).required().messages({
    'any.required': 'start_time is required for every time entry.',
    'string.pattern.base': 'start_time must be in HH:MM (24-hour) format.',
  }),
  end_time: Joi.string().pattern(TIME_PATTERN).required().messages({
    'any.required': 'end_time is required for every time entry.',
    'string.pattern.base': 'end_time must be in HH:MM (24-hour) format.',
  }),
  // Each slot's OWN description — fully optional per segment, including
  // genuinely blank: a caller that wants distinct text per slot (Slot 1
  // "API development", Slot 2 "Bug fixing") may supply it here, and it's
  // kept exactly as given, never merged with another segment's text. A
  // caller that omits this (or the line's own description too) gets an
  // empty string stored, never a validation error — see
  // employeeTimesheetService.js's withFallbackDescription() and
  // EmployeeWorkLogTimeEntry.js's doc comment.
  description: Joi.string().trim().max(2000).allow('').optional().messages({
    'string.max': 'description cannot exceed 2000 characters.',
  }),
});

/**
 * A single line item within a POST /employee-timesheets/entries REPLACE SAVE
 * payload — no timesheet_date of its own (the whole array shares the one
 * top-level date). The service layer wipes and reinserts every entry for
 * that date in one transaction, so there is never a collision against an
 * "existing" DB row — but two lines in the SAME payload can still collide
 * with each other. Two lines sharing (service_po_id, hierarchy_node_id) are
 * allowed when EVERY one of them is time-based (carries `time_entries`) —
 * they're merged into that Module/Task's combined slot list (still subject
 * to the usual overlap check across the merged set). The same key repeated
 * on a plain hours-only line (no `time_entries`) is still rejected as a
 * duplicate — see employeeTimesheetService.replaceDailyEntries.
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
  // One or more Start Time/End Time segments against this Module/Task on
  // this date (see EmployeeWorkLogTimeEntry.js) — e.g. [{09:30-10:20},
  // {14:00-15:00}] both under the same Module. When given, `hours` below is
  // ignored — the service layer always recalculates it server-side as the
  // sum of every segment's own duration (see resolveHoursAndTimeEntries).
  time_entries: Joi.array().items(timeEntrySchema).min(1).optional().messages({
    'array.min': 'time_entries must contain at least one entry.',
  }),
  hours: Joi.number().positive().max(12).when('time_entries', {
    is: Joi.array().min(1).required(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }).messages({
    'any.required': 'Hours is required.',
    'number.base': 'Hours must be a number.',
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  // Required for a plain HOURLY line (no time_entries) — unchanged. Fully
  // optional (including blank) for a TIME_BASED line: each segment may
  // carry its own description instead (see timeEntrySchema above), and a
  // caller relying purely on per-segment text no longer needs to also fill
  // in a line-level one.
  description: Joi.string().trim().max(2000).allow('').when('time_entries', {
    is: Joi.array().min(1).required(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }).messages({
    'any.required': 'Description is required.',
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
  // Replace this entry's ENTIRE Start Time/End Time breakdown with exactly
  // these segments — see EmployeeWorkLogTimeEntry.js. Omitting this field
  // entirely leaves the existing breakdown (if any) untouched, same
  // "omit = don't change" convention as every other field here. An explicit
  // empty array IS accepted here (unlike the create path's `.min(1)`) as
  // "clear the breakdown, revert to a plain hours-only entry" — see
  // updateEntry()'s doc comment.
  time_entries: Joi.array().items(timeEntrySchema).optional().messages({
    'array.base': 'time_entries must be an array.',
  }),
  hours: Joi.number().positive().max(12).optional().messages({
    'number.positive': 'Hours must be greater than 0.',
    'number.max': 'Hours cannot exceed 12 per day.',
  }),
  description: Joi.string().trim().max(2000).allow('').optional().messages({
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

/**
 * POST /employee-timesheets/time-entries — the dedicated "Time Entry" form
 * (separate from the Daily Work Log's REPLACE SAVE). ADDITIVE, not a
 * replace: the given `time_entries` segments are appended to whatever this
 * Module/Task/date already has (find-or-create the employee_work_logs row,
 * then add these segments to its breakdown) — see
 * employeeTimesheetService.addTimeEntries()'s doc comment for why this has
 * to be a genuinely separate operation from replaceDailyEntries/updateEntry
 * (both of those REPLACE a line's entire time_entries set; this form must
 * never require the caller to resend segments already saved earlier in the
 * day, on this or a previous request).
 */
const addTimeEntriesSchema = Joi.object({
  work_date: Joi.date().iso().required().messages({
    'any.required': 'work_date is required.',
    'date.format': 'work_date must be in ISO format (YYYY-MM-DD).',
  }),
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Service PO is required.',
    'number.base': 'Service PO must be a number.',
  }),
  sub_project_id: Joi.number().integer().positive().optional().allow(null),
  hierarchy_node_id: Joi.number().integer().positive().optional().allow(null),
  time_entries: Joi.array().items(timeEntrySchema).min(1).required().messages({
    'any.required': 'time_entries is required.',
    'array.min': 'time_entries must contain at least one entry.',
  }),
  // Fully optional, including on this Module/Task's very first entry for
  // this date — a segment may carry its own description instead (see
  // timeEntrySchema), and a missing description anywhere resolves to an
  // empty string, never a validation error. Omitting this on an EXISTING
  // entry leaves its current description untouched (see addTimeEntries()'s
  // doc comment).
  description: Joi.string().trim().max(2000).allow('').optional().messages({
    'string.max': 'Description cannot exceed 2000 characters.',
  }),
});

/**
 * GET /employee-timesheets/entries — the Employee's own flat work log
 * list (id, status, rejection_remark, etc.) backing the Employee Work Log
 * list/history view.
 */
const listEntriesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  status: Joi.string().valid('pending', 'approved', 'rejected', 'synced').optional(),
  poId: Joi.number().integer().positive().optional(),
});

module.exports = {
  replaceDailyEntriesSchema,
  updateEntrySchema,
  addTimeEntriesSchema,
  monthYearQuerySchema,
  monthlySummaryQuerySchema,
  dailyQuerySchema,
  listEntriesQuerySchema,
};
