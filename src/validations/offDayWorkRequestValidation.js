'use strict';

const Joi = require('joi');

/**
 * Off-Day Approval Gate Validation Schemas — Employee-side (Employee Self
 * Timesheet module). The Project Manager side reuses
 * managerSelfServiceValidation.rejectWorkLogSchema as-is (identical shape:
 * a mandatory `remark`).
 */

const createOffDayRequestSchema = Joi.object({
  service_po_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Service PO is required.',
    'number.base': 'Service PO must be a number.',
  }),
  work_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({
    'any.required': 'Work date is required.',
    'string.pattern.base': 'Work date must be in YYYY-MM-DD format.',
  }),
  reason: Joi.string().trim().max(1000).allow('').optional().messages({
    'string.max': 'reason cannot exceed 1000 characters.',
  }),
});

const resubmitOffDayRequestSchema = Joi.object({
  reason: Joi.string().trim().max(1000).allow('').optional().messages({
    'string.max': 'reason cannot exceed 1000 characters.',
  }),
});

const listOffDayRequestsQuerySchema = Joi.object({
  work_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().messages({
    'string.pattern.base': 'work_date must be in YYYY-MM-DD format.',
  }),
});

const listOffDayQueueQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  // 'all' (default, or the param omitted) — pending, approved, AND rejected
  // requests this caller may act on, still-pending ones first. A specific
  // status narrows to just that one — matching how the equivalent
  // timesheet-approval list endpoints support a status filter.
  status: Joi.string().valid('all', 'pending', 'approved', 'rejected').default('all').messages({
    'any.only': 'status must be all, pending, approved, or rejected.',
  }),
  // Both required together to actually filter (matches GET /my-team/timesheets/
  // approval-summary's own startDate/endDate) — either alone, or neither, applies
  // no date filtering.
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  // Nice-to-have quick filter — matches employee name/code, Service PO
  // name, or the request's reason. Not the primary access control (that's
  // still X-Company-Id + assertOwnEmployeeForApproval).
  search: Joi.string().trim().max(200).allow('').optional(),
});

/**
 * POST /my-team/off-day-requests/bulk-approve — a multi-select action from
 * the Weekend Requests queue. Capped at 100 ids per call (matches this
 * queue's own listOffDayQueueQuerySchema page-size ceiling — a multi-select
 * can never exceed one page anyway) — keep BULK_APPROVE_MAX_IDS in
 * offDayWorkRequestService.js in sync with this.
 */
const bulkApproveOffDayRequestsSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(100).unique().required().messages({
    'any.required': 'ids is required.',
    'array.min': 'At least one id is required.',
    'array.max': 'Cannot bulk-approve more than 100 requests at once.',
    'array.unique': 'ids must not contain duplicates.',
  }),
});

module.exports = {
  createOffDayRequestSchema,
  resubmitOffDayRequestSchema,
  listOffDayRequestsQuerySchema,
  listOffDayQueueQuerySchema,
  bulkApproveOffDayRequestsSchema,
};
