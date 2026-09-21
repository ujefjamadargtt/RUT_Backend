'use strict';

const { Op } = require('sequelize');
const { OffDayWorkRequest, Employee, Company, ServicePO, Sequelize } = require('../models');

function buildIncludes() {
  return [
    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'full_name'] },
    { model: Company, as: 'company', attributes: ['id', 'company_code', 'company_name'] },
    { model: ServicePO, as: 'servicePO', attributes: ['id', 'service_po_name'] },
  ];
}

/**
 * @param {number} id
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const findById = async (id) => {
  return OffDayWorkRequest.findOne({ where: { id }, include: buildIncludes() });
};

/**
 * The one row (if any) for this (employee, service PO, date) — matches
 * uq_off_day_work_requests_employee_po_date. Whatever status it's
 * currently in (pending/approved/rejected) is the single source of truth
 * for this combination; there is never more than one row.
 *
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {string} workDate - YYYY-MM-DD
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const findByEmployeeServicePODate = async (employeeId, servicePOId, workDate) => {
  return OffDayWorkRequest.findOne({
    where: { employee_id: employeeId, service_po_id: servicePOId, work_date: workDate },
  });
};

/**
 * Any ACTIVE (pending or approved) request this Employee has for this
 * date, across WHICHEVER Service PO — an Employee may only have one
 * live off-day request per date at a time (reject with 400 if this
 * finds one, per the create-request contract), independent of the
 * per-(employee, service_po, work_date) uniqueness
 * findByEmployeeServicePODate/the DB's own unique index enforce.
 *
 * @param {number} employeeId
 * @param {string} workDate
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const findActiveForEmployeeDate = async (employeeId, workDate) => {
  return OffDayWorkRequest.findOne({
    where: { employee_id: employeeId, work_date: workDate, status: { [Op.in]: ['pending', 'approved'] } },
  });
};

/**
 * @param {{employeeId:number, companyId:number|null, servicePOId:number, workDate:string, reason:string, createdBy:number}} params
 * @returns {Promise<OffDayWorkRequest>}
 */
const create = async ({ employeeId, companyId, servicePOId, workDate, reason, createdBy }) => {
  return OffDayWorkRequest.create({
    employee_id: employeeId,
    company_id: companyId,
    service_po_id: servicePOId,
    work_date: workDate,
    reason: reason || '',
    status: 'pending',
    created_by: createdBy,
    updated_by: createdBy,
  });
};

/**
 * Employee Resubmit — atomically flips ONE row from 'rejected' back to
 * 'pending' with a fresh reason, clearing the previous decision. The
 * status='rejected' guard makes this a no-op (0 rows) if the row isn't
 * currently rejected.
 *
 * @param {number} id
 * @param {{ reason: string, updatedBy: number }} params
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const resubmit = async (id, { reason, updatedBy }) => {
  const [count] = await OffDayWorkRequest.update(
    {
      status: 'pending',
      reason: reason || '',
      approver_id: null,
      decided_at: null,
      decision_remark: null,
      updated_by: updatedBy,
    },
    { where: { id, status: 'rejected' } }
  );
  if (count === 0) return null;
  return findById(id);
};

/**
 * Project Manager Approve — atomically flips ONE row from 'pending' to
 * 'approved'. The status='pending' guard makes this a no-op (0 rows) rather
 * than a race if the row was already decided a moment earlier.
 *
 * @param {number} id
 * @param {number} approverId
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const approve = async (id, approverId) => {
  const [count] = await OffDayWorkRequest.update(
    { status: 'approved', approver_id: approverId, decided_at: new Date(), updated_by: approverId },
    { where: { id, status: 'pending' } }
  );
  if (count === 0) return null;
  return findById(id);
};

/**
 * Project Manager Reject — atomically flips ONE row from 'pending' to
 * 'rejected', recording the mandatory remark and who/when.
 *
 * @param {number} id
 * @param {{ remark: string, approverId: number }} params
 * @returns {Promise<OffDayWorkRequest|null>}
 */
const reject = async (id, { remark, approverId }) => {
  const [count] = await OffDayWorkRequest.update(
    { status: 'rejected', decision_remark: remark, approver_id: approverId, decided_at: new Date(), updated_by: approverId },
    { where: { id, status: 'pending' } }
  );
  if (count === 0) return null;
  return findById(id);
};

/**
 * Every request an Employee has ever raised, newest first — optionally
 * narrowed to one date (what the Daily Timesheet gate/UI needs to know:
 * "is there already a request for the date I'm looking at").
 *
 * @param {number} employeeId
 * @param {{ workDate?: string }} [filters]
 * @returns {Promise<OffDayWorkRequest[]>}
 */
const findAllForEmployee = async (employeeId, { workDate } = {}) => {
  const where = { employee_id: employeeId };
  if (workDate) where.work_date = workDate;

  return OffDayWorkRequest.findAll({
    where,
    include: buildIncludes(),
    order: [['created_at', 'DESC']],
  });
};

/**
 * Every request for the Weekend Requests queue — NOT scoped by company/BU
 * by default (same reasoning as employeeWorkLogRepository's approval-path
 * lookups: a row's company_id mirrors the Service PO's owning BU at
 * request time, which can differ from an approver's own active session
 * BU). The caller (offDayWorkRequestService.listPendingQueue) is expected
 * to run every row through managerSelfServiceService.
 * assertOwnEmployeeForApproval and keep only what that approver may
 * actually act on — this is deliberately the whole matching set, capped
 * generously, not a pre-scoped page.
 *
 * `companyId`, when given, narrows to requests raised against THAT one
 * Business Unit specifically — the Weekend Requests screen's own BU
 * filter (independent of assertOwnEmployeeForApproval's own
 * callerBuIds-based "is this employee even mine" authorization check,
 * which stays unaffected and still spans every BU this caller reaches).
 *
 * `startDate`/`endDate`, when BOTH given, narrow to `work_date` falling
 * within that inclusive range — same semantics as the Timesheet Approval
 * endpoints' own startDate/endDate. Either alone (or neither) applies no
 * date filtering.
 *
 * `status`:
 *   - 'all' (or omitted) — every status, still-pending rows first (oldest
 *     first), decided rows (approved/rejected) after — so an approved/
 *     rejected request stays visible as a record of what's been handled
 *     instead of vanishing from the queue, without displacing what still
 *     needs a decision.
 *   - 'pending' | 'approved' | 'rejected' — that status only, oldest first.
 *
 * `search`, when given, matches (case-insensitively) the requesting
 * Employee's name/code, the Service PO's name, or the request's own
 * `reason` — a nice-to-have quick filter, not the primary access control.
 *
 * @param {{ status?: 'all'|'pending'|'approved'|'rejected', companyId?: number, startDate?: string, endDate?: string, search?: string, limit?: number }} [options]
 * @returns {Promise<{rows: OffDayWorkRequest[], count: number}>}
 */
const findAllForQueue = async ({ status = 'all', companyId = null, startDate = null, endDate = null, search = null, limit = 500 } = {}) => {
  const where = status && status !== 'all' ? { status } : {};
  if (companyId != null) where.company_id = companyId;
  if (startDate && endDate) where.work_date = { [Op.between]: [startDate, endDate] };
  if (search) {
    const term = `%${search}%`;
    where[Op.or] = [
      { reason: { [Op.iLike]: term } },
      { '$employee.full_name$': { [Op.iLike]: term } },
      { '$employee.employee_code$': { [Op.iLike]: term } },
      { '$servicePO.service_po_name$': { [Op.iLike]: term } },
    ];
  }

  const order = status && status !== 'all'
    ? [['created_at', 'ASC']]
    : [[Sequelize.literal(`("OffDayWorkRequest"."status" = 'pending')`), 'DESC'], ['created_at', 'ASC']];

  return OffDayWorkRequest.findAndCountAll({
    where,
    include: buildIncludes(),
    order,
    limit,
    // Needed for the $employee.*$/$servicePO.*$ dot-notation where clauses
    // above to resolve against the joined tables, not just this model's
    // own columns.
    subQuery: false,
  });
};

module.exports = {
  findById,
  findByEmployeeServicePODate,
  findActiveForEmployeeDate,
  create,
  resubmit,
  approve,
  reject,
  findAllForEmployee,
  findAllForQueue,
};
