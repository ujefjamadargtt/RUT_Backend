'use strict';

const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const offDayWorkRequestRepository = require('../repositories/offDayWorkRequestRepository');
const companyRepository = require('../repositories/companyRepository');
const timesheetService = require('./timesheetService');
const managerSelfServiceService = require('./managerSelfServiceService');
const weekOffPolicy = require('../utils/weekOffPolicy');
const logger = require('../utils/logger');

/**
 * Off-Day Approval Gate — an Employee asking permission to log hours on a
 * day their BU's Week Off Policy marks as off (weekOffPolicy.js), and the
 * Project Manager side that decides it. Deliberately mirrors the shape of
 * the existing Employee Work Log pending/approve/reject/resubmit lifecycle
 * (employeeTimesheetService.js / managerSelfServiceService.js) and reuses
 * managerSelfServiceService.assertOwnEmployeeForApproval verbatim for
 * authorization — there is no separate "who approves whom" table for this
 * feature; routing is the exact same Service-PO-based scope Timesheet
 * Approval already uses.
 *
 * Approving a request never itself creates the Employee Work Log entry —
 * it only clears employeeTimesheetService.replaceDailyEntries to accept
 * one for that exact (employee, service_po, work_date) going forward (see
 * that file's assertOffDayCleared()).
 */

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function assertProjectMapped(employeeId, servicePOId) {
  const mapping = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId);
  if (!mapping || mapping.status !== 'active') {
    throw forbiddenError(`Service PO #${servicePOId} is not assigned to you.`);
  }
}

/**
 * Whether `workDate` is an off day under the Week Off Policy of the BU that
 * OWNS `companyId` — exported so employeeTimesheetService's Daily Timesheet
 * gate can run the identical check a Service PO's own owning BU dictates,
 * not the caller's currently-active session BU (a cross-BU-mapped
 * Employee's PO can belong to a different BU than their active session —
 * see EmployeeWorkLog.js's own company_id doc comment).
 *
 * @param {number} companyId
 * @param {string} workDate - YYYY-MM-DD
 * @returns {Promise<boolean>}
 */
const isOffDayForCompany = async (companyId, workDate) => {
  // No resolvable BU (shouldn't happen for a real Service PO, but this is a
  // soft policy check, not a security boundary) — fail OPEN rather than
  // block or crash the write.
  if (!companyId) return false;

  const company = await companyRepository.findById(companyId);
  if (!company) return false;
  return weekOffPolicy.isOffDay(workDate, company.saturday_off_rule);
};

/**
 * Whether this exact (employee, service PO, date) already has an APPROVED
 * request — what the Daily Timesheet gate checks before accepting an entry
 * for an off day.
 *
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {string} workDate
 * @returns {Promise<boolean>}
 */
const hasApprovedRequest = async (employeeId, servicePOId, workDate) => {
  const existing = await offDayWorkRequestRepository.findByEmployeeServicePODate(employeeId, servicePOId, workDate);
  return !!existing && existing.status === 'approved';
};

/**
 * Employee "Send request" action — asks permission to log hours on an off
 * day, for one Service PO and one date. One row ever per (employee,
 * service_po, date); a rejected one is reopened only via the explicit
 * Resubmit action below, never silently reopened here.
 *
 * @param {number} employeeId
 * @param {number} companyId - the caller's active session company, used
 *   only to validate the Service PO the same way every other manual entry
 *   point does (timesheetService.resolveManualEntryReferences) — the
 *   request itself is recorded against the PO's OWN owning company
 *   (po.company_id), not this one.
 * @param {{ service_po_id: number, work_date: string, reason?: string }} data
 * @param {number} actorId
 * @returns {Promise<OffDayWorkRequest>}
 */
const createRequest = async (employeeId, companyId, data, actorId) => {
  const { service_po_id: servicePOId, work_date: workDate, reason } = data;

  await assertProjectMapped(employeeId, servicePOId);

  const { po } = await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: servicePOId },
    companyId,
    { skipPOCompanyScope: true, skipEmployeeCompanyScope: true }
  );

  const isOffDay = await isOffDayForCompany(po.company_id, workDate);
  if (!isOffDay) {
    throw badRequestError(
      `${workDate} is not an off day under your BU's Week Off Policy — log it directly on Daily Timesheet.`
    );
  }

  // One live request per date at a time, across whichever Service PO —
  // reject with 400 (not 409) per the create-request contract.
  const activeForDate = await offDayWorkRequestRepository.findActiveForEmployeeDate(employeeId, workDate);
  if (activeForDate) {
    if (activeForDate.status === 'approved') {
      throw badRequestError(`${workDate} already has an approved off-day request — you can log your hours.`);
    }
    throw badRequestError(`A request for ${workDate} is already pending.`);
  }

  // The specific (employee, service_po, date) slot — if it exists here it
  // must be 'rejected' (an active one would already have been caught
  // above), and can only be reopened via the explicit Resubmit action,
  // never a fresh insert (the DB's own unique index would reject it too).
  const existingSlot = await offDayWorkRequestRepository.findByEmployeeServicePODate(employeeId, servicePOId, workDate);
  if (existingSlot) {
    throw conflictError('This request was rejected — use Resubmit to send it again.');
  }

  const created = await offDayWorkRequestRepository.create({
    employeeId,
    companyId: po.company_id,
    servicePOId,
    workDate,
    reason,
    createdBy: actorId,
  });

  logger.info('Employee submitted an Off-Day Work Request', { employeeId, servicePOId, workDate });

  return created;
};

/**
 * Employee "Resubmit" action — the only way a REJECTED request becomes
 * 'pending' again, with a fresh reason. Symmetric with
 * employeeTimesheetService.resubmitEntry.
 *
 * @param {number} employeeId
 * @param {number} id
 * @param {string} reason
 * @returns {Promise<OffDayWorkRequest>}
 */
const resubmitRequest = async (employeeId, id, reason) => {
  const existing = await offDayWorkRequestRepository.findById(id);
  if (!existing || existing.employee_id !== employeeId) {
    throw notFoundError(`Off-Day Work Request #${id} was not found.`);
  }

  if (existing.status !== 'rejected') {
    throw conflictError(`Only a rejected request can be resubmitted (current status: ${existing.status}).`);
  }

  const nextReason = reason !== undefined ? reason : existing.reason;
  const updated = await offDayWorkRequestRepository.resubmit(id, { reason: nextReason, updatedBy: employeeId });
  if (!updated) {
    throw conflictError(`Only a rejected request can be resubmitted (current status: ${existing.status}).`);
  }

  logger.info('Employee resubmitted an Off-Day Work Request', { employeeId, id });

  return updated;
};

/**
 * Every request the Employee has raised, optionally narrowed to one date —
 * what the Daily Timesheet screen shows for the date currently open (Not
 * requested / Pending / Approved / Rejected).
 *
 * @param {number} employeeId
 * @param {{ work_date?: string }} query
 * @returns {Promise<OffDayWorkRequest[]>}
 */
const listMyRequests = async (employeeId, query = {}) => {
  return offDayWorkRequestRepository.findAllForEmployee(employeeId, { workDate: query.work_date });
};

const QUEUE_SCAN_LIMIT = 500;

/**
 * The calling Manager/Project Manager's "Weekend Requests" queue — every
 * pending request they're authorized to act on. Deliberately scans every
 * matching request (capped at QUEUE_SCAN_LIMIT) and keeps only the ones
 * assertOwnEmployeeForApproval allows, rather than pre-computing a scoped
 * SQL WHERE for authorization — this reuses that function's full
 * multi-tier logic verbatim (Admin/BU Admin/Project Manager/Team Lead all
 * resolve differently) and off-day requests are expected to stay a
 * low-volume queue.
 *
 * `companyId` DOES narrow the result set to that one Business Unit's
 * requests (pushed into the repository's own WHERE, unlike
 * assertOwnEmployeeForApproval's separate callerBuIds-based authorization
 * check, which still spans every BU this caller reaches) — same
 * X-Company-Id-driven single-active-BU scoping every other `/my-team/*`
 * endpoint (GET /my-team/timesheets, .../approval-summary) already applies.
 *
 * `status` defaults to 'all' — pending, approved, AND rejected requests
 * this caller may act on, still-pending ones first (see
 * offDayWorkRequestRepository.findAllForQueue's doc comment) — so a
 * decided request stays visible in the queue as a record of what's been
 * handled instead of disappearing the moment it's approved/rejected.
 * 'pending' | 'approved' | 'rejected' narrows to just that one.
 *
 * `startDate`/`endDate`, when BOTH given, narrow to `work_date` within
 * that inclusive range — same semantics as GET /my-team/timesheets/
 * approval-summary's own startDate/endDate.
 *
 * `search`, when given, matches employee name/code, Service PO name, or
 * the request's reason — a nice-to-have quick filter.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @param {number|null} hierarchyRank
 * @param {number[]} callerBuIds
 * @param {{ page?: number, limit?: number, status?: 'all'|'pending'|'approved'|'rejected', startDate?: string, endDate?: string, search?: string }} pagination
 * @returns {Promise<{ data: object[], meta: object }>}
 */
const listPendingQueue = async (managerUserId, companyId, hierarchyRank = null, callerBuIds = [], { page = 1, limit = 20, status = 'all', startDate, endDate, search } = {}) => {
  const { rows } = await offDayWorkRequestRepository.findAllForQueue({ status, companyId, startDate, endDate, search, limit: QUEUE_SCAN_LIMIT });

  const visible = [];
  for (const row of rows) {
    try {
      await managerSelfServiceService.assertOwnEmployeeForApproval(
        managerUserId, row.employee_id, companyId, hierarchyRank, callerBuIds, row.service_po_id
      );
      visible.push(row);
    } catch (err) {
      if (err.statusCode !== 403) throw err;
      // Not one of this caller's Employees/Service POs — not theirs to see.
    }
  }

  const total = visible.length;
  const start = (page - 1) * limit;
  const data = visible.slice(start, start + limit);
  const totalPages = Math.ceil(total / limit) || 0;

  return {
    data,
    meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

/**
 * Project Manager "Approve" action. Symmetric with
 * managerSelfServiceService.approveTimesheet.
 *
 * @param {number} managerUserId
 * @param {number} id
 * @param {number} companyId
 * @param {number} actorId
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<OffDayWorkRequest>}
 */
const approveRequest = async (managerUserId, id, companyId, actorId, hierarchyRank = null, callerBuIds = []) => {
  const existing = await offDayWorkRequestRepository.findById(id);
  if (!existing) {
    throw notFoundError(`Off-Day Work Request #${id} was not found.`);
  }

  await managerSelfServiceService.assertOwnEmployeeForApproval(
    managerUserId, existing.employee_id, companyId, hierarchyRank, callerBuIds, existing.service_po_id
  );

  if (existing.status !== 'pending') {
    throw conflictError(`Only a pending request can be approved (current status: ${existing.status}).`);
  }

  const approved = await offDayWorkRequestRepository.approve(id, actorId);
  if (!approved) {
    throw conflictError(`Only a pending request can be approved (current status: ${existing.status}).`);
  }

  logger.info('Project Manager approved an Off-Day Work Request', { managerUserId, id, employeeId: existing.employee_id, actorId });

  return approved;
};

// Kept in sync with offDayWorkRequestValidation.bulkApproveOffDayRequestsSchema's
// own `ids` array cap.
const BULK_APPROVE_MAX_IDS = 100;

/**
 * Project Manager multi-select "Approve" action from the Weekend Requests
 * queue — one call, several ids. Deliberately never aborts the whole batch
 * over one bad id (not yours to approve, already decided, or simply
 * missing): each id is resolved independently via the exact same
 * assertOwnEmployeeForApproval + status guard approveRequest() above uses,
 * and only genuinely unexpected errors (statusCode !== 403) propagate.
 * Mirrors this codebase's existing "individual failures never abort the
 * whole process" bulk-action philosophy (see e.g. the Employee bulk
 * upload).
 *
 * `failed[].reason` is one of 'not_found' | 'not_owned' | 'not_pending'.
 *
 * @param {number} managerUserId
 * @param {number[]} ids
 * @param {number} companyId
 * @param {number} actorId
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<{ approved: number[], failed: Array<{id:number, reason:string, message:string}> }>}
 */
const bulkApproveRequests = async (managerUserId, ids, companyId, actorId, hierarchyRank = null, callerBuIds = []) => {
  const targetIds = ids.slice(0, BULK_APPROVE_MAX_IDS);
  const approved = [];
  const failed = [];

  for (const id of targetIds) {
    try {
      const existing = await offDayWorkRequestRepository.findById(id);
      if (!existing) {
        failed.push({ id, reason: 'not_found', message: `Off-Day Work Request #${id} was not found.` });
        continue;
      }

      await managerSelfServiceService.assertOwnEmployeeForApproval(
        managerUserId, existing.employee_id, companyId, hierarchyRank, callerBuIds, existing.service_po_id
      );

      if (existing.status !== 'pending') {
        failed.push({
          id,
          reason: 'not_pending',
          message: `Only a pending request can be approved (current status: ${existing.status}).`,
        });
        continue;
      }

      const result = await offDayWorkRequestRepository.approve(id, actorId);
      if (!result) {
        failed.push({ id, reason: 'not_pending', message: 'This request was decided by someone else a moment ago.' });
        continue;
      }

      approved.push(id);
    } catch (err) {
      if (err.statusCode !== 403) throw err;
      failed.push({ id, reason: 'not_owned', message: err.message });
    }
  }

  logger.info('Project Manager bulk-approved Off-Day Work Requests', {
    managerUserId, actorId, requested: targetIds.length, approved: approved.length, failed: failed.length,
  });

  return { approved, failed };
};

/**
 * Project Manager "Reject" action — a remark is mandatory. Symmetric with
 * managerSelfServiceService.rejectWorkLogEntry.
 *
 * @param {number} managerUserId
 * @param {number} id
 * @param {string} remark
 * @param {number} companyId
 * @param {number} actorId
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<OffDayWorkRequest>}
 */
const rejectRequest = async (managerUserId, id, remark, companyId, actorId, hierarchyRank = null, callerBuIds = []) => {
  const existing = await offDayWorkRequestRepository.findById(id);
  if (!existing) {
    throw notFoundError(`Off-Day Work Request #${id} was not found.`);
  }

  await managerSelfServiceService.assertOwnEmployeeForApproval(
    managerUserId, existing.employee_id, companyId, hierarchyRank, callerBuIds, existing.service_po_id
  );

  if (existing.status !== 'pending') {
    throw conflictError(`Only a pending request can be rejected (current status: ${existing.status}).`);
  }

  const rejected = await offDayWorkRequestRepository.reject(id, { remark, approverId: actorId });
  if (!rejected) {
    throw conflictError(`Only a pending request can be rejected (current status: ${existing.status}).`);
  }

  logger.info('Project Manager rejected an Off-Day Work Request', { managerUserId, id, employeeId: existing.employee_id, actorId });

  return rejected;
};

module.exports = {
  isOffDayForCompany,
  hasApprovedRequest,
  createRequest,
  resubmitRequest,
  listMyRequests,
  listPendingQueue,
  approveRequest,
  bulkApproveRequests,
  rejectRequest,
};
