'use strict';

const { Op } = require('sequelize');
const moment = require('moment-timezone');
const { Employee, ServicePO, Company, Entity, sequelize } = require('../models');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const managerServicePOMappingRepository = require('../repositories/managerServicePOMappingRepository');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const servicePORepository = require('../repositories/servicePORepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const employeeRepository = require('../repositories/employeeRepository');
const { resolveCentralisedServicePOTenant, expandBusinessUnitIdsWithDescendants } = require('./companyAccessControlService');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');
const dateHelper = require('../helpers/dateHelper');
const emailLogService = require('./emailLogService');
const { buildApprovedWorkLogActionEmail } = require('../utils/emailTemplates');
const { parseIdList } = require('../utils/idListParser');

// Platform Admin (1) / Admin (2) / Entity Admin (3) — full cross-company scope, no mapping check needed.
const ADMIN_TIER_MAX_RANK = 3;
// BU Admin (4) — scoped to their own Business Units, verified via employeeRepository.findById(id, companyId).
const BU_ADMIN_RANK = 4;
// Project Manager (6) — Timesheet Approval scope is Service-PO-based (see
// assertOwnEmployeeForApproval/getMyEmployees below), NOT manager_employee_
// mappings-based. Project Admin (5) and Team Lead (7) are deliberately left
// out of this constant and keep using the original manager_employee_mappings
// path unchanged — Project Admin is explicitly out of scope for this
// redesign, and Team Lead's backend approval logic must remain untouched.
const PROJECT_MANAGER_RANK = 6;

/**
 * Manager Self-Service — a Manager's own view of their delegated Employees
 * and granted Service POs, and the final step of the delegation chain:
 * assigning a granted Service PO to one of their own Employees. This
 * reuses the EXISTING, UNMODIFIED employeeServicePOMappingService (the
 * same engine every other caller of Employee<->ServicePO mapping already
 * uses) — the only new logic here is the cascading scope check: the
 * Employee must be one this Manager was delegated (via
 * manager_employee_mappings) and the Service PO must be one this Manager
 * was granted (via manager_servicepo_mappings). Managers must NOT be able
 * to map another Manager's Employees — enforced by these same two checks.
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

/**
 * The Service POs a BU Admin may approve hours against: every PO owned by their Business Units
 * (and those BUs' Sub-BUs), plus their own tenant's Centralised POs (Leave/Bench/...) — which have
 * no BU of their own, so their logs follow the Employee. `includeParents` also adds the Parent BU
 * of a Sub-BU, because a PO created at the Parent level stamps its logs there while its Employees
 * sit in the Sub-BU (see employeeWorkLogRepository.resolveSyncScope).
 *
 * `ownPoIds` is returned separately from `centralisedPoIds`: Centralised POs are auto-mapped to
 * every employee, so they must never be used to decide which Employees are "mine".
 *
 * @param {number[]} buIds
 * @param {number} managerUserId
 * @param {{ includeParents?: boolean }} [options]
 * @returns {Promise<{ ownPoIds: number[], centralisedPoIds: number[] }>}
 */
async function resolveBuAdminPoScope(buIds, managerUserId, { includeParents = false } = {}) {
  const seed = [...new Set((buIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (seed.length === 0) return { ownPoIds: [], centralisedPoIds: [] };

  const children = await Company.findAll({ where: { parent_business_unit_id: { [Op.in]: seed } }, attributes: ['id'], raw: true });
  const scope = new Set([...seed, ...children.map((child) => Number(child.id))]);
  if (includeParents) {
    const seeds = await Company.findAll({ where: { id: { [Op.in]: seed } }, attributes: ['parent_business_unit_id'], raw: true });
    seeds.forEach((row) => { if (row.parent_business_unit_id != null) scope.add(Number(row.parent_business_unit_id)); });
  }

  const ownPOs = await ServicePO.findAll({ where: { company_id: { [Op.in]: [...scope] } }, attributes: ['id'], raw: true });
  const centralisedPOs = await servicePORepository.getActiveCentralisedPOIds(
    await resolveCentralisedServicePOTenant(seed, managerUserId)
  );
  return {
    ownPoIds: ownPOs.map((po) => Number(po.id)),
    centralisedPoIds: centralisedPOs.map((po) => Number(po.id)),
  };
}

/**
 * Is this Employee a member of one of the caller's own Business Units (or those BUs' Sub-BUs)?
 * Decides whose Centralised-PO hours (Leave/Bench/...) a Project Manager may approve.
 */
async function isEmployeeInCallerBus(employeeId, companyId, callerBuIds = []) {
  const scopeIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
  if (scopeIds.length === 0) return false;
  const employee = await employeeRepository.findById(employeeId, scopeIds.length === 1 ? scopeIds[0] : scopeIds);
  return !!employee;
}

/**
 * What a BU Admin may approve for ONE Employee — throws 403 when the Employee is not theirs.
 *
 *  - Employee is a MEMBER of the admin's BU: the Service POs of the admin's BUs PLUS the tenant's
 *    Centralised POs (Leave/Bench/Training/HR-Admin). A Centralised PO has no BU of its own, so
 *    those hours follow the Employee's own BU.
 *  - Employee is only MAPPED to a PO of the admin's BU (cross-BU resourcing, member of another
 *    BU): ONLY that BU's own Service POs. Their Centralised-PO hours belong to their OWN BU's
 *    admin (and their Project Manager) — never to the admin of the BU whose PO they happen to
 *    work on. No cross-BU approval of Centralised hours.
 *
 * @returns {Promise<{ isMember: boolean, allowedPoIds: number[] }>}
 */
async function resolveBuAdminEmployeeScope(managerUserId, employeeId, companyId, callerBuIds = []) {
  const scopeIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
  const { ownPoIds, centralisedPoIds } = await resolveBuAdminPoScope(scopeIds, managerUserId, { includeParents: true });

  const employee = await employeeRepository.findById(employeeId, scopeIds.length === 1 ? scopeIds[0] : scopeIds);
  const isMember = !!employee;
  if (!isMember) {
    // Not a member of this admin's BU — still theirs for their OWN BU's POs when actively mapped
    // to (or having logged against) one of them.
    const mappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
    const mappedToOwnPO = mappings.some((mapping) => ownPoIds.includes(Number(mapping.service_po_id)));
    const hasOwnPOWork = mappedToOwnPO || (ownPoIds.length > 0
      && await employeeWorkLogRepository.existsForEmployeeAndServicePOIds(employeeId, ownPoIds));
    if (!hasOwnPOWork) {
      throw forbiddenError('This Employee is not one of your mapped Employees.');
    }
  }
  return { isMember, allowedPoIds: isMember ? [...ownPoIds, ...centralisedPoIds] : [...ownPoIds] };
}

/**
 * The PO-id restriction the Timesheet Approval single-employee list/bulk paths apply for a BU
 * Admin caller (null for every other tier — Project Manager keeps getting its own list from
 * assertOwnEmployeeForApproval).
 */
async function resolveBuAdminApprovalPoIds(managerUserId, companyId, hierarchyRank, callerBuIds = [], employeeId = null) {
  if (hierarchyRank !== BU_ADMIN_RANK) return null;
  const { allowedPoIds } = await resolveBuAdminEmployeeScope(managerUserId, employeeId, companyId, callerBuIds);
  // The repository treats an EMPTY list as "no restriction" — nothing allowed must see nothing,
  // so fail closed with a never-matching id.
  return allowedPoIds.length > 0 ? allowedPoIds : [-1];
}

/**
 * The Manager's own delegated Employees, or every active employee inside an
 * Admin-tier caller's authorized Business Unit scope.
 *
 * @param {number} managerUserId
 * @param {number[]} companyIds - every accessible BU, or the selected BU —
 *   for Admin/BU Admin tier ONLY (see below); ignored for the Manager tier.
 * @param {number|null} hierarchyRank
 * @param {number|null} [explicitBusinessUnitId] - the Business Unit the
 *   caller explicitly selected (business_unit_id query param / X-Company-Id),
 *   or null when none was given — see the Manager-tier branch below for why
 *   this must be a separate signal from companyIds.
 * @returns {Promise<Array>}
 */
const getMyEmployees = async (managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId = null) => {
  // BU Admin (rank 4) has full access to all employees in their BUs —
  // same as Admin tier but scoped to their own BUs (enforced by the
  // companyIds filter at the bottom rather than by a mapping check).
  const isAdminOrBuAdminTier = hierarchyRank != null && hierarchyRank <= 4;
  const isProjectManagerTier = hierarchyRank === PROJECT_MANAGER_RANK;
  let mappings = [];
  let employeeWhere = { status: 'active', is_deleted: false };

  if (isProjectManagerTier) {
    // Project Manager "My Employees" is Service-PO-based, not
    // manager_employee_mappings-based: every Employee actively MAPPED
    // (employee_servicepo_mapping, status = active) to a Service PO this
    // Project Manager is mapped to, via the EXISTING employee_servicepo_mapping
    // table (see employeeServicePOMappingService.getProjectManagerServicePOIds
    // — no new PM<->PO table). mapping_type stays null for these employees
    // below (mappings is left empty) since that concept doesn't apply here.
    //
    // Deliberately driven by the mapping table alone, NOT by
    // employee_work_logs existence — a newly-mapped Employee who has not
    // logged any work yet must still appear here immediately (they have to,
    // to even be assignable a Service PO / show up for Timesheet Approval
    // before their first entry exists).
    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(managerUserId);
    if (poIds.length === 0) return [];
    const mappedRows = await employeeServicePOMappingRepository.findByServicePOs(poIds, 'active');
    const employeeIds = [...new Set(mappedRows.map((row) => row.employee_id))];
    if (employeeIds.length === 0) return [];
    employeeWhere = { id: employeeIds };
  } else if (!isAdminOrBuAdminTier) {
    // Do not restrict manager_employee_mappings.company_id here. Historic
    // mapping rows may have NULL company_id, while the Employee's active
    // employee_business_units membership is the authoritative BU assignment.
    mappings = await managerEmployeeMappingRepository.findByManager(managerUserId);
    if (mappings.length === 0) return [];
    employeeWhere = { id: mappings.map((mapping) => mapping.employee_id) };
  }

  const allEmployees = await Employee.findAll({
    where: employeeWhere,
    attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
    include: [{
      model: Company,
      as: 'businessUnits',
      attributes: ['id', 'company_name', 'entity_id'],
      through: { attributes: [], where: { status: 'active' } },
      required: false,
      include: [
        { model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false },
      ],
    }],
  });

  // The caller's own Employee record (req.userId/req.employeeId are the
  // same id — see middlewares/auth.js) must never appear in their own "My
  // Employees" list, no matter how it otherwise qualified (a direct
  // manager_employee_mappings row, or — the real case this closes — a
  // Project Manager who has personally logged work against a Service PO
  // they themselves manage, which the Service-PO-based branch above would
  // otherwise happily include). Left in, the Timesheet Approval screen
  // built from this list would show the Manager their own name/entries and
  // let them approve their own submitted hours (assertOwnEmployeeForApproval
  // now also blocks that action directly — see its own doc comment — but
  // this list must never have offered it in the first place).
  const employees = allEmployees.filter((employee) => employee.id !== managerUserId);

  const mappingByEmployeeId = new Map();
  for (const mapping of mappings) {
    // An Employee normally has at most one mapping for a Manager. Prefer the
    // primary assignment if legacy data contains both types for that pair.
    const existing = mappingByEmployeeId.get(mapping.employee_id);
    if (!existing || (mapping.mapping_type === 'PRIMARY' && existing.mapping_type !== 'PRIMARY')) {
      mappingByEmployeeId.set(mapping.employee_id, mapping);
    }
  }

  const withMeta = employees.map((employee) => {
    const businessUnits = (employee.businessUnits || []).map((businessUnit) => ({
      id: businessUnit.id,
      name: businessUnit.company_name,
      entity_id: businessUnit.entity_id,
      entity_name: businessUnit.entity?.entity_name || null,
    }));
    const businessUnitIds = businessUnits.map((businessUnit) => businessUnit.id);
    return {
      id: employee.id,
      employee_code: employee.employee_code,
      full_name: employee.full_name,
      designation: employee.designation,
      status: employee.status,
      business_unit_ids: businessUnitIds,
      business_units: businessUnits,
      mapping_type: mappingByEmployeeId.get(employee.id)?.mapping_type || null,
    };
  });

  if (isAdminOrBuAdminTier) {
    // Admin/BU Admin tier: companyIds IS the security boundary here (the
    // query above had no mapping-based restriction at all) — always filter
    // by it, selected BU or not, exactly as before.
    const selectedBusinessUnits = new Set(companyIds || []);
    // A BU Admin also approves hours on THEIR OWN BU's Service POs by Employees who belong to a
    // different BU (cross-BU resourcing) — without this, nobody at the PO's own BU could ever see
    // or approve those logs now that a BU Admin is limited to their own BU's POs.
    let crossBuEmployeeIds = new Set();
    if (hierarchyRank === BU_ADMIN_RANK) {
      const { ownPoIds } = await resolveBuAdminPoScope(companyIds, managerUserId);
      if (ownPoIds.length > 0) {
        const mappedRows = await employeeServicePOMappingRepository.findByServicePOs(ownPoIds, 'active');
        crossBuEmployeeIds = new Set(mappedRows.map((row) => row.employee_id));
      }
    }
    return withMeta.filter((employee) => crossBuEmployeeIds.has(employee.id)
      || employee.business_unit_ids.some((id) => selectedBusinessUnits.has(id)));
  }

  // Manager tier (Team Lead/Project Admin via manager_employee_mappings, or
  // Project Manager via Service PO-based employee_work_logs — see above):
  // employeeWhere already scoped the query to exactly this caller's
  // authorized Employees. Business Unit is a pure narrowing convenience here,
  // applied ONLY when
  // the caller explicitly selected one. A mapped Employee whose own
  // Business Unit differs from every Business Unit the MANAGER personally
  // belongs to must still appear by default — the mapping row is what
  // grants access, not shared BU membership. Filtering this list by
  // `companyIds` (the Manager's own reachable BUs) unconditionally used to
  // silently hide such an Employee even though HR/the Manager had
  // deliberately mapped them — see the bug report this fixed: a Manager
  // mapped to an Employee outside their own Business Unit never saw that
  // Employee in "My Employees" at all.
  if (explicitBusinessUnitId != null) {
    return withMeta.filter((employee) => employee.business_unit_ids.includes(explicitBusinessUnitId));
  }
  return withMeta;
};

/**
 * The Service POs granted to this Manager — or, for a BU Admin (rank 4),
 * every Service PO in their own Business Unit(s), mapped or not. A BU
 * Admin's authority is BU-wide by design (same as their Employee scope in
 * assertOwnEmployee/assertOwnEmployeeForApproval above) — unlike a Manager/
 * Team Lead, whose visibility here really is driven by individual
 * manager_servicepo_mappings grants, a BU Admin should never see an empty
 * list here just because nobody happened to create an explicit grant row
 * for them.
 *
 * Admin tier (Platform Admin/Admin/Entity Admin, rank <= ADMIN_TIER_MAX_RANK)
 * carries no company_id of its own (see resolveCompany.js's early-return for
 * ranks 1-3) and has no manager_servicepo_mappings grants to begin with —
 * this is a "my own self-service grants" list, which simply doesn't apply to
 * a cross-BU role. Return empty rather than falling through to a
 * company_id-scoped query with an undefined companyId.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]} [callerBuIds] - all caller BU ids (BU Admin path)
 * @returns {Promise<Array>}
 */
const getMyGrantedServicePOs = async (managerUserId, companyId, hierarchyRank = null, callerBuIds = []) => {
  if (Number.isInteger(hierarchyRank) && hierarchyRank <= ADMIN_TIER_MAX_RANK) {
    return [];
  }

  if (hierarchyRank === BU_ADMIN_RANK) {
    const scopeIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
    // Centralised POs (Leave/Bench/Training/HR-Admin) of this BU Admin's
    // OWN Admin tenant are OR'd in — never another Admin's (see
    // servicePORepository.centralisedTenantScope()'s doc comment).
    const centralisedScope = servicePORepository.centralisedTenantScope(
      await resolveCentralisedServicePOTenant(scopeIds, managerUserId)
    );
    return ServicePO.findAll({
      where: {
        is_deleted: false,
        [Op.or]: [{ company_id: { [Op.in]: scopeIds } }, ...(centralisedScope ? [centralisedScope] : [])],
      },
      attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
    });
  }

  if (hierarchyRank === PROJECT_MANAGER_RANK) {
    // A Project Manager's own Service POs are the ones they are the explicit PM of
    // (employee_servicepo_mapping.is_project_manager = true) — they hold no
    // manager_servicepo_mappings grants — plus their own Admin tenant's Centralised POs
    // (Leaves/On Bench/etc.). Same definition Timesheet Approval and the Monthly Work Log use.
    const ownPoIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(managerUserId);
    const tenantSeedIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
    const centralisedPOs = await servicePORepository.getActiveCentralisedPOIds(
      await resolveCentralisedServicePOTenant(tenantSeedIds, managerUserId)
    );
    const poIds = [...new Set([...ownPoIds, ...centralisedPOs.map((po) => po.id)])];
    if (poIds.length === 0) return [];
    return ServicePO.findAll({
      where: { id: poIds, is_deleted: false },
      attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
    });
  }

  const grants = await managerServicePOMappingRepository.findByManager(managerUserId, companyId);
  if (grants.length === 0) return [];

  const pos = await ServicePO.findAll({
    where: { id: grants.map((g) => g.service_po_id) },
    attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
  });
  return pos;
};

/**
 * Guard: confirm the caller is allowed to act on behalf of `employeeId`.
 *
 * - Admin / Entity Admin (rank ≤ 3): full cross-company scope — skip the
 *   mapping check entirely (they have no rows in manager_employee_mappings
 *   and don't need them).
 * - BU Admin (rank 4): scoped to their own Business Units — verify the
 *   target Employee belongs to ANY of the caller's BUs. Uses
 *   `callerBuIds` (the full array from req.employeeBusinessUnits) so a
 *   multi-BU Admin can act on employees in any of their BUs regardless of
 *   which single BU is in the X-Company-Id header.
 * - Everyone else (Manager and below): must have an active row in
 *   manager_employee_mappings.
 *
 * @param {number}      managerUserId
 * @param {number}      employeeId
 * @param {number}      companyId      — single BU from req.companyId (used for non-BU-Admin paths)
 * @param {number|null} hierarchyRank  — req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]  — all caller BU ids from req.employeeBusinessUnits (BU Admin path)
 */
async function assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds = []) {
  // Admin-tier: full scope, no mapping check needed.
  if (Number.isInteger(hierarchyRank) && hierarchyRank <= ADMIN_TIER_MAX_RANK) {
    return;
  }

  // BU Admin: employee must belong to ANY of the caller's active Business Units.
  if (hierarchyRank === BU_ADMIN_RANK) {
    // Use the full BU array when available; fall back to the single companyId so
    // callers that haven't been updated yet still work correctly.
    const scopeIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
    const employee = await employeeRepository.findById(employeeId, scopeIds.length === 1 ? scopeIds[0] : scopeIds);
    if (!employee) {
      throw forbiddenError('This Employee is not one of your mapped Employees.');
    }
    return;
  }

  // Manager and below: must have an explicit mapping row.
  const mapping = await managerEmployeeMappingRepository.findByManagerAndEmployee(managerUserId, employeeId, companyId);
  if (!mapping) {
    throw forbiddenError('This Employee is not one of your mapped Employees.');
  }
}

/**
 * Approval-specific ownership guard — used by the Timesheet Approval
 * read/action functions below (getTimesheets, getApprovalSummary,
 * approveTimesheet, rejectWorkLogEntry, bulkApproveTimesheets), by
 * getMyEmployees above, and by managerMonthlyWorkLogService's
 * get/submit/deleteMonthlyWorkLogForEmployee (Monthly Work Log shares the
 * exact same "is this Employee mine" question as Timesheet Approval, so it
 * must resolve a Project Manager's Employees the same Service-PO-based way).
 * Deliberately a SEPARATE function from
 * assertOwnEmployee() (kept completely unmodified above) — Service PO
 * delegation (assignServicePOToEmployee/getEmployeeServicePOs/
 * removeServicePOFromEmployee, further below) keeps calling the ORIGINAL
 * assertOwnEmployee(), so a Project Manager's unrelated Service-PO-delegation
 * ability is never affected by this Timesheet Approval redesign.
 *
 * - Admin / Entity Admin (rank ≤ 3) and BU Admin (rank 4): identical to
 *   assertOwnEmployee() — unchanged.
 * - Project Manager (rank 6): Service-PO-based, reusing the EXISTING
 *   employee_servicepo_mapping table (no new table) — see
 *   employeeServicePOMappingService.getProjectManagerServicePOIds. When
 *   `servicePoId` is given (one specific employee_work_logs row being
 *   approved/rejected), the check is scoped to THAT entry's own Service PO
 *   — a Project Manager mapped to PO1 but not PO2 must never approve/
 *   reject/view an Employee's PO2 entries just because they share PO1. When
 *   omitted (bulk actions spanning a date/month range, or the "is this
 *   Employee even mine" check for getTimesheets/getApprovalSummary), this
 *   only confirms the Employee has SOME logged work against one of this
 *   Project Manager's mapped Service POs.
 * - Everyone else (Team Lead rank 7, Project Admin rank 5): IDENTICAL to
 *   assertOwnEmployee()'s manager_employee_mappings check — completely
 *   unchanged. Project Admin is explicitly out of scope for the
 *   Project-Manager-specific redesign (left on the old path, same as Team
 *   Lead) per product decision.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number|null} hierarchyRank
 * @param {number[]} [callerBuIds]
 * @param {number|null} [servicePoId] - the specific entry's Service PO, when known
 * @returns {Promise<number[]|null>} the Service PO ids the caller may act
 *   within — for a Project Manager, their own real POs PLUS (once the
 *   target Employee is confirmed to be genuinely theirs) every Centralised
 *   PO, so that Employee's own Leave/Bench/Training/HR-Admin entries are
 *   included too — or null when no Service-PO-based restriction applies
 *   (every other tier)
 */
async function assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds = [], servicePoId = null) {
  // A Manager's own Employee record (req.userId/req.employeeId are the same
  // id post-identity-redesign — see middlewares/auth.js) must never qualify
  // as one of "my mapped Employees" here, no matter how it otherwise would
  // (a direct manager_employee_mappings row mapping someone to themselves,
  // or — the real-world case — a Project Manager who has personally logged
  // work against a Service PO they themselves manage). Without this, a
  // Manager/Project Manager could view/approve/reject their OWN submitted
  // timesheet entries, since every check below only asks "is this Employee
  // one this caller manages" and never "is this Employee the caller". "My
  // own timesheet" is reached exclusively via the employeeId-omitted path
  // (getTimesheets/getApprovalSummary's ownEmployeeId branch) — never
  // through this approval-guarded, explicit-employeeId path.
  if (employeeId === managerUserId) {
    throw forbiddenError('You cannot approve, reject, or view your own timesheet through Timesheet Approval.');
  }

  if (Number.isInteger(hierarchyRank) && hierarchyRank <= ADMIN_TIER_MAX_RANK) {
    return null;
  }

  if (hierarchyRank === BU_ADMIN_RANK) {
    // A BU Admin approves hours logged against THEIR OWN Business Units' Service POs only —
    // never another BU's — plus the Centralised-PO hours of Employees who belong to their BU (see
    // resolveBuAdminEmployeeScope). Returns null (NOT the PO list) on purpose:
    // managerMonthlyWorkLogService reads an array here as "this caller is a Project Manager"; the
    // Timesheet Approval list/bulk paths get the list from resolveBuAdminApprovalPoIds() instead.
    const { allowedPoIds } = await resolveBuAdminEmployeeScope(managerUserId, employeeId, companyId, callerBuIds);
    if (servicePoId != null && !allowedPoIds.includes(Number(servicePoId))) {
      throw forbiddenError('This work log entry does not belong to a Service PO your Business Unit may approve.');
    }
    return null;
  }

  if (hierarchyRank === PROJECT_MANAGER_RANK) {
    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(managerUserId);
    if (poIds.length === 0) {
      throw forbiddenError('You are not currently mapped to any Service PO as a Project Manager.');
    }

    if (servicePoId != null) {
      if (poIds.includes(servicePoId)) {
        return poIds;
      }
      // Not one of my own real POs — allow ONLY when it's a Centralised PO
      // (Leaves/On Bench/Training/HR-Admin — auto-mapped to every Employee,
      // so it has no genuine Project Manager of its own) AND this Employee
      // has otherwise logged real work against one of MY POs, i.e. they're
      // genuinely one of my own project's people, not a stranger's Leave
      // entry I happen to share a Centralised mapping with.
      const isCentralised = (await servicePORepository.findCentralisedIdsAmong([servicePoId])).length > 0;
      // ...and ONLY when that Employee also belongs to one of the PM's OWN Business Units: a PM
      // approves their own project's real work cross-BU, but a cross-BU Employee's Leave/Bench
      // belongs to that Employee's own BU (their BU Admin / Project Manager) — no cross-BU approval.
      const isMyEmployee = isCentralised
        && (await isEmployeeInCallerBus(employeeId, companyId, callerBuIds))
        && (await employeeWorkLogRepository.existsForEmployeeAndServicePOIds(employeeId, poIds));
      if (!isMyEmployee) {
        throw forbiddenError('This work log entry does not belong to a Service PO you manage.');
      }
      return poIds;
    }

    const hasWork = await employeeWorkLogRepository.existsForEmployeeAndServicePOIds(employeeId, poIds);
    if (!hasWork) {
      // Same rule getMyEmployees() uses to LIST this Project Manager's
      // Employees: an active employee_servicepo_mapping row on one of their
      // Service POs. Such an Employee (mapped, but no work logged there yet)
      // is shown in the PM's list, so opening them must not 403 — they get
      // their (possibly empty) entries on MY Service POs only. The
      // Centralised-PO widening below still requires real logged work.
      const activeMappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
      const isMappedToMyPO = activeMappings.some((mapping) => poIds.includes(mapping.service_po_id));
      if (!isMappedToMyPO) {
        throw forbiddenError('This Employee has not logged work against any Service PO you manage.');
      }
      return poIds;
    }
    // This Employee is confirmed to be genuinely mine (real project work
    // logged against one of my POs) — widen the scope to every Centralised
    // PO too, so THIS Employee's own Leave/Bench/Training/HR-Admin entries
    // are visible/approvable alongside their real project work. Safe: every
    // caller of this return value (getTimesheets/getApprovalSummary/
    // bulkApproveTimesheets) always further scopes by this SAME employeeId,
    // so this never leaks a different, unrelated employee's Centralised
    // entries.
    // A cross-BU Employee (not a member of any of this PM's BUs) keeps their Centralised hours with
    // their OWN BU's admin / Project Manager: the PM sees only the real POs they manage.
    if (!(await isEmployeeInCallerBus(employeeId, companyId, callerBuIds))) {
      return poIds;
    }
    // Only this Project Manager's OWN Admin tenant's Centralised POs.
    const tenantSeedIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
    const centralisedPOs = await servicePORepository.getActiveCentralisedPOIds(
      await resolveCentralisedServicePOTenant(tenantSeedIds, managerUserId)
    );
    return [...poIds, ...centralisedPOs.map((po) => po.id)];
  }

  // Team Lead / Project Admin: identical to assertOwnEmployee() — unchanged.
  const mapping = await managerEmployeeMappingRepository.findByManagerAndEmployee(managerUserId, employeeId, companyId);
  if (!mapping) {
    throw forbiddenError('This Employee is not one of your mapped Employees.');
  }
  return null;
}

async function assertGrantedServicePO(managerUserId, servicePOId, companyId) {
  const grant = await managerServicePOMappingRepository.findByManagerAndServicePO(managerUserId, servicePOId, companyId);
  if (!grant) {
    throw forbiddenError('This Service PO has not been granted to you.');
  }
}

/**
 * Assign a Service PO to one of the Manager's own Employees — the
 * cascading restriction, then delegates to the existing, unmodified
 * employeeServicePOMappingService.assign().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} companyId
 * @param {number} actorId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const assignServicePOToEmployee = async (managerUserId, employeeId, servicePOId, companyId, actorId, hierarchyRank = null, callerBuIds = []) => {
  await assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);
  await assertGrantedServicePO(managerUserId, servicePOId, companyId);

  const mapping = await employeeServicePOMappingService.assign(employeeId, servicePOId, actorId, companyId);

  logger.info('Manager assigned Service PO to own Employee', { managerUserId, employeeId, servicePOId, actorId });

  return mapping;
};

/**
 * List the Service POs currently assigned to one of the Manager's own
 * Employees — same scoping check as assign/remove, then delegates to the
 * existing, unmodified employeeServicePOMappingRepository.findByEmployee().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getEmployeeServicePOs = async (managerUserId, employeeId, companyId, hierarchyRank = null, callerBuIds = []) => {
  if (hierarchyRank === PROJECT_MANAGER_RANK) {
    // A Project Manager's "my Employee" is Service-PO-based (the same rule GET
    // /my-team/employees lists them by), not a manager_employee_mappings row — and they see
    // only the Employee's POs they manage (plus Centralised), never the whole list.
    const allowedPoIds = await assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);
    const mappings = await employeeServicePOMappingRepository.findByEmployee(employeeId, companyId);
    const allowed = new Set(allowedPoIds.map(Number));
    return mappings.filter((m) => allowed.has(Number(m.service_po_id)));
  }

  await assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);

  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId);
};

// listMyTeamTimesheetsQuerySchema's sortBy values (kept as-is for API
// backward-compatibility — the query param name doesn't change even though
// the underlying source/column does) mapped onto the actual
// employee_work_logs columns findAll() sorts by.
const TIMESHEET_SORT_BY_TO_WORK_LOG_COLUMN = {
  timesheet_date: 'work_date',
  hours_logged: 'hours',
  created_at: 'created_at',
};

/**
 * The Manager's own COMPLETE timesheet, or one of their mapped Employees'
 * complete timesheet — "complete" meaning every Service PO/hierarchy-node
 * entry that employee has, regardless of which Service PO the MANAGER
 * themselves is granted (Service PO mapping is never used to restrict
 * Timesheet view access — only Employee mapping is).
 *
 * Single unified source: `employee_work_logs` (employeeWorkLogRepository.
 * findAll()), covering every lifecycle stage (pending/approved/synced) in
 * ONE array — there is no longer a separate `drafts` collection. Approval
 * now happens on employee_work_logs BEFORE Sync (see getApprovalSummary/
 * bulkApproveTimesheets above), so this is also the same data Manager
 * approval acts on — one record shape, one collection, everywhere.
 * `approval_status` mirrors the row's own `status` column verbatim
 * (pending/approved/synced) — no separate label is invented for "not yet
 * synced" since employee_work_logs has no stage more granular than that.
 *
 * @param {number} managerUserId
 * @param {number|null} employeeId - null/omitted means "my own timesheet"
 * @param {number} ownEmployeeId - the calling Manager's own req.employeeId (may be null)
 * @param {number} companyId
 * @param {object} query - startDate, endDate, poId, subProjectId, sortBy, sortOrder, page, limit
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]   - all caller BU ids (req.employeeBusinessUnits mapped to ids)
 * @returns {Promise<{ data, meta }>}
 */
const getTimesheets = async (managerUserId, employeeId, ownEmployeeId, companyId, query, hierarchyRank = null, callerBuIds = []) => {
  let targetEmployeeId;
  let poIds = null;

  if (employeeId) {
    poIds = await assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds)
      ?? await resolveBuAdminApprovalPoIds(managerUserId, companyId, hierarchyRank, callerBuIds, employeeId);
    targetEmployeeId = employeeId;
  } else {
    targetEmployeeId = ownEmployeeId;
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;

  if (!targetEmployeeId) {
    // Manager has no linked Employee record of their own and asked for
    // "My Timesheet" — there is nothing to show, not an error.
    return {
      data: [],
      meta: { total: 0, page, limit, totalPages: 0, hasNext: false, hasPrev: false },
    };
  }

  const { rows, count } = await employeeWorkLogRepository.findAll(
    {
      employeeId: targetEmployeeId,
      companyId,
      startDate: query.startDate,
      endDate: query.endDate,
      poId: query.poId,
      poIds,
      subProjectId: query.subProjectId,
    },
    { limit, offset: (page - 1) * limit },
    {
      sortBy: TIMESHEET_SORT_BY_TO_WORK_LOG_COLUMN[query.sortBy] || 'work_date',
      sortOrder: query.sortOrder,
    }
  );

  const data = rows.map((row) => {
    const plain = row.toJSON();
    return {
      ...plain,
      timesheet_date: plain.work_date,
      hours_logged: plain.hours,
      approval_status: plain.status,
    };
  });

  const totalPages = Math.ceil(count / limit) || 0;

  return {
    data,
    meta: { total: count, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

/**
 * Manager "Approve" action — approves ONE pending Employee Work Log entry
 * belonging to one of the Manager's own (Primary or Secondary) mapped
 * Employees. Acts on `employee_work_logs`, exactly like rejectWorkLogEntry
 * below (same id space, same table) — NOT the official `timesheets` table.
 *
 * This used to target `timesheets` via timesheetRepository.publishById,
 * which was wrong: approval happens BEFORE Sync, on employee_work_logs (see
 * this file's other approval paths — bulkApproveTimesheets, and
 * rejectWorkLogEntry's own doc comment), and a not-yet-synced entry simply
 * doesn't exist in `timesheets` yet — every such id 404'd with "Timesheet
 * not found" the moment a Manager tried to approve one entry while another
 * entry (elsewhere in the SAME list, built from employee_work_logs) had
 * already been rejected via the sibling endpoint that correctly targets
 * employee_work_logs. Only a currently-'pending' row can be approved this
 * way — an already-approved/rejected/synced row 409s rather than silently
 * re-approving.
 *
 * @param {number} managerUserId
 * @param {number} id - employee_work_logs.id
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]   - all caller BU ids (BU Admin path)
 * @returns {Promise<EmployeeWorkLog>}
 */
const approveTimesheet = async (managerUserId, id, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const entry = await employeeWorkLogRepository.findById(id);
  if (!entry) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  await assertOwnEmployeeForApproval(managerUserId, entry.employee_id, companyId, hierarchyRank, callerBuIds, entry.service_po_id);

  if (entry.status !== 'pending') {
    throw conflictError(`Only a pending work log entry can be approved (current status: ${entry.status}).`);
  }

  const approved = await employeeWorkLogRepository.approveById(id);
  if (!approved) {
    // Lost a race against another action (e.g. a concurrent reject/resubmit)
    // between the status check above and the atomic update itself.
    throw conflictError(`Only a pending work log entry can be approved (current status: ${entry.status}).`);
  }

  await createAuditLog(
    actorId,
    'APPROVE',
    'employee_work_logs',
    id,
    { status: 'pending' },
    { status: 'approved' },
    ipAddress
  );

  logger.info('Manager approved Employee Work Log entry', { managerUserId, workLogId: id, employeeId: entry.employee_id, actorId });

  return approved;
};

/**
 * Day/Month-aggregated approval view — one bucket per calendar day (or
 * per calendar month, when log_type='monthly') summing every Service
 * PO/hierarchy-node Employee Work Log entry for that day/month. Approval
 * happens BEFORE Sync (see bulkApproveTimesheets below and
 * employeeTimesheetService.replaceDailyEntries) — this reads
 * `employee_work_logs` directly, never `timesheets`, so a Manager can act
 * on entries the Employee has genuinely already submitted, whether or not
 * Sync has run yet. Each bucket embeds its underlying rows in `entries` (no
 * separate drill-down call needed) via
 * employeeWorkLogRepository.findForApprovalSummary(), grouped here in
 * application code by work_date (daily) or (year, month) (monthly) — a
 * plain SQL GROUP BY can't also return the row-level detail `entries`
 * needs.
 *
 * @param {number} managerUserId
 * @param {number|null} employeeId - null/omitted means "my own timesheet"
 * @param {number} ownEmployeeId - the calling Manager's own req.employeeId (may be null)
 * @param {number} companyId
 * @param {object} query - startDate, endDate, log_type ('daily'|'monthly'), page, limit
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]   - all caller BU ids (BU Admin path)
 * @returns {Promise<{ data: object[], meta: object }>}
 */
const getApprovalSummary = async (managerUserId, employeeId, ownEmployeeId, companyId, query, hierarchyRank = null, callerBuIds = []) => {
  let targetEmployeeId;
  let poIds = null;

  if (employeeId) {
    poIds = await assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds)
      ?? await resolveBuAdminApprovalPoIds(managerUserId, companyId, hierarchyRank, callerBuIds, employeeId);
    targetEmployeeId = employeeId;
  } else {
    targetEmployeeId = ownEmployeeId;
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;

  if (!targetEmployeeId) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0, hasNext: false, hasPrev: false } };
  }

  const isMonthly = query.log_type === 'monthly';

  const rows = await employeeWorkLogRepository.findForApprovalSummary({
    employeeId: targetEmployeeId,
    startDate: query.startDate,
    endDate: query.endDate,
    servicePoIds: poIds,
  });

  // Group rows into buckets — keyed by the date string (daily) or
  // "year-month" (monthly) — preserving each row's full detail in `entries`.
  const bucketsByKey = new Map();
  for (const row of rows) {
    const plain = row.toJSON();
    const workDate = plain.work_date; // "YYYY-MM-DD"
    const key = isMonthly ? workDate.slice(0, 7) : workDate; // "YYYY-MM" or "YYYY-MM-DD"

    if (!bucketsByKey.has(key)) {
      bucketsByKey.set(key, isMonthly
        ? { employee_id: plain.employee_id, month: parseInt(workDate.slice(5, 7), 10), year: parseInt(workDate.slice(0, 4), 10), entries: [] }
        : { employee_id: plain.employee_id, date: workDate, entries: [] });
    }
    bucketsByKey.get(key).entries.push(plain);
  }

  const buckets = Array.from(bucketsByKey.values()).map((bucket) => {
    const totalHours = bucket.entries.reduce((sum, e) => sum + (parseFloat(e.hours) || 0), 0);
    // Priority: any 'pending' row makes the whole bucket 'pending' (still
    // needs Manager action); failing that, any 'rejected' row makes it
    // 'rejected' (needs Employee resubmit, not "approved" — a rejected-only
    // bucket must never read as approved); otherwise every row is
    // 'approved'/'synced', so the bucket is 'approved'.
    const approvalStatus = bucket.entries.some((e) => e.status === 'pending')
      ? 'pending'
      : bucket.entries.some((e) => e.status === 'rejected')
        ? 'rejected'
        : 'approved';
    return {
      ...bucket,
      total_hours: totalHours,
      entry_count: bucket.entries.length,
      approval_status: approvalStatus,
    };
  });

  buckets.sort((a, b) => (isMonthly
    ? (b.year - a.year) || (b.month - a.month)
    : b.date.localeCompare(a.date)));

  // Bucket counts are inherently small — bounded by the caller-supplied
  // date range (at most ~31 daily buckets, or a handful of monthly ones)
  // — so pagination is applied in-memory rather than via a second
  // COUNT(DISTINCT ...) aggregate query.
  const total = buckets.length;
  const totalPages = Math.ceil(total / limit) || 0;
  const paged = buckets.slice((page - 1) * limit, page * limit);

  return {
    data: paged,
    meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

/**
 * The combined "all my Employees" Timesheet Approval Summary — every mapped
 * Employee's day/month buckets in ONE server-paginated, server-sorted list,
 * replacing the frontend's one-getApprovalSummary()-call-per-Employee
 * fan-out (N requests, each silently capped at 100 buckets).
 *
 * Team = getMyEmployees() — exactly the list the Manager/Team Lead screen
 * already shows (same tier rules, same Business Unit narrowing, the caller's
 * own record never included), optionally narrowed further by `employee_ids`
 * (never widened). Bucket shape matches getApprovalSummary()'s, plus the
 * owning Employee's identity on every row since one response now spans many.
 *
 * Project Manager scope matches assertOwnEmployeeForApproval() per employee
 * (see employeeWorkLogRepository.findApprovalSummaryBucketsPage's poScope):
 * own-Service-PO rows always; Centralised-PO rows only for Employees with
 * real work on one of those POs. A PM with no Service PO of their own gets an
 * empty list here (the single-employee endpoint 403s instead).
 *
 * @param {number} managerUserId
 * @param {number[]} companyIds - req.companyIds (resolveMyTeamBusinessUnitScope)
 * @param {number|null} hierarchyRank
 * @param {number|null} explicitBusinessUnitId - req.explicitBusinessUnitId
 * @param {number[]} callerBuIds
 * @param {object} query - log_type, startDate, endDate, status, service_po_id,
 *   search, employee_ids, sortBy, sortOrder, page, limit
 * @returns {Promise<{ data: object[], meta: object }>}
 */
/**
 * Resolve the caller's own mapped team (narrowed by `employee_ids`, never
 * widened) plus, for a Project Manager caller, the same poScope predicate
 * assertOwnEmployeeForApproval() enforces per-employee — shared by
 * getApprovalSummaryAll() and exportApprovalSummaryAll() so both read
 * exactly the same authorized rows.
 * @returns {Promise<{ empty: true } | { empty: false, employeeIds: number[], poScope: object|null }>}
 */
// The BU / Sub BU filter, as a scope on the work logs' own company_id (null = no BU selected).
// See employeeWorkLogRepository.resolveApprovalLogScope.
async function resolveApprovalLogScope(explicitBusinessUnitId) {
  const id = parseInt(explicitBusinessUnitId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return employeeWorkLogRepository.resolveApprovalLogScope(id);
}

async function resolveApprovalSummaryTeamScope(managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId, callerBuIds, query) {
  const team = await getMyEmployees(managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId);
  let employeeIds = team.map((employee) => employee.id);
  const requestedIds = parseIdList(query.employee_ids);
  if (requestedIds) {
    const requested = new Set(requestedIds);
    employeeIds = employeeIds.filter((id) => requested.has(id));
  }
  if (employeeIds.length === 0) return { empty: true };

  let poScope = null;
  if (hierarchyRank === PROJECT_MANAGER_RANK) {
    const ownPoIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(managerUserId);
    if (ownPoIds.length === 0) return { empty: true };
    // Only this Project Manager's OWN Admin tenant's Centralised POs — same
    // seed as assertOwnEmployeeForApproval().
    const centralisedPOs = await servicePORepository.getActiveCentralisedPOIds(
      await resolveCentralisedServicePOTenant(callerBuIds, managerUserId)
    );
    // Centralised hours (Leave/Bench/...) only for Employees who belong to the PM's own BUs — a
    // cross-BU Employee's Centralised hours stay with their own BU (no cross-BU approval).
    const pmReach = new Set((await expandBusinessUnitIdsWithDescendants(callerBuIds.length > 0 ? callerBuIds : companyIds)).map(Number));
    const pmMemberEmployeeIds = team
      .filter((employee) => (employee.business_unit_ids || []).some((id) => pmReach.has(Number(id))))
      .map((employee) => employee.id);
    poScope = {
      ownPoIds,
      centralisedPoIds: centralisedPOs.map((po) => po.id),
      centralisedMemberEmployeeIds: employeeIds.filter((id) => pmMemberEmployeeIds.includes(id)),
    };
  } else if (hierarchyRank === BU_ADMIN_RANK && explicitBusinessUnitId == null) {
    // "All Business Units": a BU Admin must see only logs on THEIR OWN BUs' Service POs, not the
    // other-BU logs of an Employee who merely belongs to one of their BUs. With a BU explicitly
    // selected, the existing log-company filter (resolveApprovalLogScope) already narrows to it.
    const seedBuIds = callerBuIds.length > 0 ? callerBuIds : companyIds;
    const { ownPoIds, centralisedPoIds } = await resolveBuAdminPoScope(seedBuIds, managerUserId, { includeParents: true });
    if (ownPoIds.length + centralisedPoIds.length === 0) return { empty: true };
    // Centralised-PO hours (Leave/Bench/...) are approvable only for Employees who BELONG to this
    // admin's BU — a cross-BU Employee mapped to one of this BU's POs keeps their Centralised
    // hours with their own BU's admin / Project Manager (no cross-BU approval).
    const reach = new Set((await expandBusinessUnitIdsWithDescendants(seedBuIds)).map(Number));
    const memberIds = new Set(team
      .filter((employee) => (employee.business_unit_ids || []).some((id) => reach.has(Number(id))))
      .map((employee) => employee.id));
    poScope = {
      ownPoIds,
      centralisedPoIds,
      centralisedEmployeeIds: employeeIds.filter((id) => memberIds.has(id)),
    };
  }

  return { empty: false, employeeIds, poScope };
}

const getApprovalSummaryAll = async (managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId, callerBuIds, query) => {
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;
  const emptyResult = { data: [], meta: { total: 0, page, limit, totalPages: 0, hasNext: false, hasPrev: false } };

  const scope = await resolveApprovalSummaryTeamScope(managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId, callerBuIds, query);
  if (scope.empty) return emptyResult;
  const { employeeIds, poScope } = scope;
  const logScope = await resolveApprovalLogScope(explicitBusinessUnitId);

  const isMonthly = query.log_type === 'monthly';
  const { rows, total } = await employeeWorkLogRepository.findApprovalSummaryBucketsPage({
    logScope,
    employeeIds,
    startDate: query.startDate,
    endDate: query.endDate,
    isMonthly,
    poScope,
    status: query.status && query.status !== 'all' ? query.status : null,
    servicePoId: query.service_po_id ? parseInt(query.service_po_id, 10) : null,
    search: query.search || null,
    sortBy: query.sortBy || null,
    sortOrder: query.sortOrder || 'desc',
    limit,
    offset: (page - 1) * limit,
  });

  // Only this page's entries are loaded (one query), in the bucket's own order.
  const entryIds = rows.flatMap((row) => row.entry_ids || []);
  const entries = await employeeWorkLogRepository.findByIdsWithIncludes(entryIds);
  const entryById = new Map(entries.map((entry) => [entry.id, entry.toJSON()]));

  const data = rows.map((row) => {
    const periodDate = typeof row.period_date === 'string'
      ? row.period_date.slice(0, 10)
      : new Date(row.period_date).toISOString().slice(0, 10);
    const period = isMonthly
      ? { month: parseInt(periodDate.slice(5, 7), 10), year: parseInt(periodDate.slice(0, 4), 10) }
      : { date: periodDate };
    return {
      employee_id: row.employee_id,
      employee_name: row.full_name,
      employee_code: row.employee_code,
      employee: { id: row.employee_id, full_name: row.full_name, employee_code: row.employee_code },
      ...period,
      entries: (row.entry_ids || []).map((id) => entryById.get(id)).filter(Boolean),
      total_hours: parseFloat(row.total_hours) || 0,
      entry_count: row.entry_count,
      approval_status: row.approval_status,
    };
  });

  const totalPages = Math.ceil(total / limit) || 0;
  return {
    data,
    meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

const APPROVAL_SUMMARY_EXPORT_COLUMNS = [
  { key: 'employee', label: 'Employee', width: 32 },
  { key: 'period', label: 'Date', width: 16 },
  { key: 'service_po_name', label: 'Service PO Name', width: 36 },
  { key: 'total_hours', label: 'Total Hours', width: 14, numFmt: '0.00' },
  { key: 'entry_count', label: 'Entry Count', width: 12 },
  { key: 'approval_status', label: 'Approval Status', width: 16 },
];

function toApprovalSummaryExportRow(row, isMonthly) {
  const periodDate = typeof row.period_date === 'string'
    ? row.period_date.slice(0, 10)
    : new Date(row.period_date).toISOString().slice(0, 10);
  const period = isMonthly ? moment.utc(periodDate).format('MMMM YYYY') : periodDate;

  return {
    employee: row.employee_code ? `${row.full_name} (${row.employee_code})` : row.full_name,
    period,
    // A bucket almost always has exactly one Service PO, but an Employee can
    // log against more than one on the same date/month — never drop a PO
    // silently, join every distinct name touched that period.
    service_po_name: (row.service_po_names || []).join(', '),
    total_hours: parseFloat(row.total_hours) || 0,
    entry_count: row.entry_count,
    approval_status: row.approval_status ? row.approval_status.charAt(0).toUpperCase() + row.approval_status.slice(1) : '',
  };
}

/**
 * Every Timesheet Approval Summary bucket matching the filters (no
 * pagination) for the Excel export — same caller-only team/poScope
 * resolution as getApprovalSummaryAll(), so the export can never show a
 * row the JSON endpoint wouldn't. `entries` are never loaded (the export
 * has no drill-down) — only the aggregated bucket fields are needed.
 *
 * @param {number} managerUserId
 * @param {number[]} companyIds - req.companyIds (resolveMyTeamBusinessUnitScope)
 * @param {number|null} hierarchyRank
 * @param {number|null} explicitBusinessUnitId - req.explicitBusinessUnitId
 * @param {number[]} callerBuIds
 * @param {object} query - log_type, startDate, endDate, status, service_po_id, search, employee_ids
 * @returns {Promise<{ rows: object[], columns: object[] }>}
 */
const exportApprovalSummaryAll = async (managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId, callerBuIds, query) => {
  const scope = await resolveApprovalSummaryTeamScope(managerUserId, companyIds, hierarchyRank, explicitBusinessUnitId, callerBuIds, query);
  if (scope.empty) return { rows: [], columns: APPROVAL_SUMMARY_EXPORT_COLUMNS };
  const { employeeIds, poScope } = scope;
  const logScope = await resolveApprovalLogScope(explicitBusinessUnitId);

  const isMonthly = query.log_type === 'monthly';
  const rows = await employeeWorkLogRepository.findApprovalSummaryBuckets({
    logScope,
    employeeIds,
    startDate: query.startDate,
    endDate: query.endDate,
    isMonthly,
    poScope,
    status: query.status && query.status !== 'all' ? query.status : null,
    servicePoId: query.service_po_id ? parseInt(query.service_po_id, 10) : null,
    search: query.search || null,
  });

  return {
    rows: rows.map((row) => toApprovalSummaryExportRow(row, isMonthly)),
    columns: APPROVAL_SUMMARY_EXPORT_COLUMNS,
  };
};

/**
 * Bulk-approve — one action across several dates (daily) or several
 * months (monthly) for one Employee's PENDING Employee Work Log entries
 * (never `timesheets` — approval happens before Sync). Exactly one of
 * `dates`/`months` is expected (enforced by managerSelfServiceValidation.js's
 * Joi .xor()). Only rows currently status='pending' are touched; a
 * date/month with nothing pending is a harmless no-op (0 rows), not an
 * error — unlike the single-row approveTimesheet() above (which targets
 * `timesheets` directly and 409s on an already-approved row). That
 * distinction is deliberate: a bulk multi-select is inherently more likely
 * to include an already-settled item than one deliberate click on a
 * known-pending row.
 *
 * `approved` carries a per-bucket `already_settled` flag, true when that
 * date/month had rows but none were pending BY THE TIME this call's atomic
 * UPDATE ran — i.e. this call lost a race against another action (another
 * Manager's overlapping bulk-approve on a shared Centralised PO, or simply
 * an earlier approve/reject) that got there first. A bucket with no rows at
 * all (nothing was ever logged) stays `already_settled: false` — the two
 * cases both approve 0 rows but are NOT the same thing, and the caller
 * needs to tell them apart rather than seeing an unexplained 0.
 *
 * @param {number} managerUserId
 * @param {object} body - { employee_id, dates?, months? }
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]   - all caller BU ids (BU Admin path)
 * @returns {Promise<{ employee_id, approved: Array<{date?, month?, year?, rows_approved, already_settled}>, total_rows_approved }>}
 */
const bulkApproveTimesheets = async (managerUserId, body, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const { employee_id: employeeId, dates, months } = body;

  const poIds = (await assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds))
    ?? await resolveBuAdminApprovalPoIds(managerUserId, companyId, hierarchyRank, callerBuIds, employeeId);

  let totalRowsApproved = 0;
  let approved;

  await sequelize.transaction(async (transaction) => {
    if (dates) {
      const result = await employeeWorkLogRepository.approveByEmployeeAndDates(employeeId, dates, transaction, poIds);
      totalRowsApproved = result.total_rows_approved;
      approved = result.buckets;
    } else {
      const result = await employeeWorkLogRepository.approveByEmployeeAndMonths(employeeId, months, transaction, poIds);
      totalRowsApproved = result.total_rows_approved;
      approved = result.buckets;
    }
  });

  await createAuditLog(
    actorId,
    'APPROVE',
    'employee_work_logs',
    null,
    null,
    { employee_id: employeeId, dates: dates || null, months: months || null, total_rows_approved: totalRowsApproved },
    ipAddress
  );

  logger.info('Manager bulk-approved Employee Work Log entries', {
    managerUserId, employeeId, dates: dates || null, months: months || null, totalRowsApproved, actorId,
  });

  return { employee_id: employeeId, approved, total_rows_approved: totalRowsApproved };
};

/**
 * Manager "Reject" action — rejects ONE pending Employee Work Log entry
 * belonging to one of the Manager's own (Primary or Secondary) mapped
 * Employees, with a mandatory remark. Only a currently-'pending' row can be
 * rejected (PENDING -> REJECTED is the only valid entry into this status —
 * see EmployeeWorkLog.js's status doc comment); an already-approved/
 * rejected/synced row 409s rather than silently overwriting its state.
 * Symmetric with approveTimesheet/bulkApproveTimesheets above, but acts on
 * employee_work_logs (where 'pending' actually lives) rather than
 * `timesheets`.
 *
 * @param {number} managerUserId
 * @param {number} id - employee_work_logs.id
 * @param {string} remark - mandatory rejection reason (validated non-empty
 *   by managerSelfServiceValidation.rejectWorkLogSchema before this runs)
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank] - req.hierarchyRank from auth middleware
 * @param {number[]}    [callerBuIds]   - all caller BU ids (BU Admin path)
 * @returns {Promise<EmployeeWorkLog>}
 */
const rejectWorkLogEntry = async (managerUserId, id, remark, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const entry = await employeeWorkLogRepository.findById(id, companyId);
  if (!entry) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  await assertOwnEmployeeForApproval(managerUserId, entry.employee_id, companyId, hierarchyRank, callerBuIds, entry.service_po_id);

  if (entry.status !== 'pending') {
    throw conflictError(`Only a pending work log entry can be rejected (current status: ${entry.status}).`);
  }

  const rejected = await employeeWorkLogRepository.rejectById(id, { remark, rejectedBy: actorId });

  await createAuditLog(
    actorId,
    'REJECT',
    'employee_work_logs',
    id,
    { status: 'pending' },
    { status: 'rejected', remark },
    ipAddress
  );

  logger.info('Manager rejected Employee Work Log entry', {
    managerUserId, workLogId: id, employeeId: entry.employee_id, actorId,
  });

  return rejected;
};

/**
 * Remove a Service PO assignment from one of the Manager's own Employees —
 * same scoping check, then delegates to the existing removeMapping().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const removeServicePOFromEmployee = async (managerUserId, employeeId, servicePOId, companyId, hierarchyRank = null, callerBuIds = []) => {
  await assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);

  const existing = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId);
  if (!existing) {
    const err = new Error('This Service PO is not assigned to this Employee.');
    err.statusCode = 404;
    throw err;
  }

  await employeeServicePOMappingService.removeMapping(existing.id, companyId);

  logger.info('Manager removed Service PO from own Employee', { managerUserId, employeeId, servicePOId });
};

/**
 * Manager self-service "Map Employees" — claim the SECONDARY manager slot
 * for an Employee in the same company. HR sets the mandatory PRIMARY
 * manager at Employee creation (see employeeService.js); this is how a
 * Manager extends their own team afterward. Idempotent if the caller
 * already holds that slot; 409s if someone else does.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} actorId
 * @returns {Promise<ManagerEmployeeMapping>}
 */
const mapEmployeeToSelf = async (managerUserId, employeeId, companyId, actorId) => {
  // ORs the legacy company_id column with an active employee_business_units
  // membership — an Employee whose company_id is null but who holds a real
  // BU grant for this company (common for an Admin-created Employee) must
  // still resolve, or a Manager can never self-map to them.
  const employee = await Employee.findOne({
    where: {
      id: employeeId,
      is_deleted: false,
      [Op.or]: [{ company_id: companyId }, { '$businessUnits.id$': companyId }],
    },
    include: [{ model: Company, as: 'businessUnits', attributes: [], through: { attributes: [] } }],
  });
  if (!employee) {
    throw notFoundError('Employee not found in this company.');
  }

  const existing = await managerEmployeeMappingRepository.findByEmployeeAndType(employeeId, 'SECONDARY');
  if (existing) {
    if (existing.manager_user_id === managerUserId) {
      return existing;
    }
    throw conflictError('This Employee already has a Secondary Manager.');
  }

  const mapping = await managerEmployeeMappingRepository.create({
    company_id: companyId,
    manager_user_id: managerUserId,
    employee_id: employeeId,
    mapping_type: 'SECONDARY',
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  logger.info('Manager self-mapped as Secondary Manager', { managerUserId, employeeId, actorId });

  return mapping;
};

/**
 * Manager self-service "unmap" — remove the calling Manager's own mapping
 * (PRIMARY or SECONDARY, whichever they hold) for an Employee.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const unmapEmployeeFromSelf = async (managerUserId, employeeId, companyId) => {
  const mapping = await managerEmployeeMappingRepository.findByManagerAndEmployee(managerUserId, employeeId, companyId);
  if (!mapping) {
    throw notFoundError('This Employee is not one of your mapped Employees.');
  }

  await managerEmployeeMappingRepository.deleteById(mapping.id);

  logger.info('Manager removed own mapping to Employee', { managerUserId, employeeId });
};

/**
 * Approver "Revert" / "Delete" of an APPROVED, not-yet-synced Employee Work Log — the shared engine behind
 * revertApprovedWorkLog and deleteApprovedWorkLog.
 *
 * Authorisation is exactly the Approve/Reject one (assertOwnEmployeeForApproval, scoped to the entry's own
 * Service PO). The eligibility check is then repeated INSIDE the transaction on a row lock
 * (SELECT ... FOR UPDATE) and once more in the guarded UPDATE/DELETE itself, so a double click, a second
 * approver, an employee edit, or a Sync that finished a moment ago can never slip through: whoever gets
 * the lock second sees the final status and gets a 409. The audit row is written in the same transaction
 * (a failed audit write rolls the change back); the e-mail is sent after commit and can never undo it.
 *
 * @param {'REVERT'|'DELETE'} action
 * @param {number} managerUserId
 * @param {number} id - employee_work_logs.id
 * @param {string} reason - mandatory (validated by managerSelfServiceValidation before this runs)
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<object>}
 */
const performApprovedWorkLogAction = async (action, managerUserId, id, reason, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const isRevert = action === 'REVERT';
  const verb = isRevert ? 'reverted' : 'deleted';

  const entry = await employeeWorkLogRepository.findById(id);
  if (!entry) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  await assertOwnEmployeeForApproval(managerUserId, entry.employee_id, companyId, hierarchyRank, callerBuIds, entry.service_po_id);

  const assertApprovedAndUnsynced = (row) => {
    if (row.status === 'synced' || row.synced_at || row.timesheet_import_id) {
      throw conflictError(`Work log entry #${id} has already been synced to the official Timesheet and cannot be ${verb}.`);
    }
    if (row.status !== 'approved') {
      throw conflictError(`Only an approved work log entry can be ${verb} (current status: ${row.status}).`);
    }
  };
  assertApprovedAndUnsynced(entry);

  const actionAt = new Date();
  let snapshot;

  await sequelize.transaction(async (transaction) => {
    const locked = await employeeWorkLogRepository.findByIdForUpdate(id, transaction);
    if (!locked) {
      throw conflictError(`Work log entry #${id} no longer exists.`);
    }
    assertApprovedAndUnsynced(locked);

    snapshot = {
      ...locked.get({ plain: true }),
      time_entries: await employeeWorkLogRepository.findTimeEntriesByWorkLogId(id, transaction),
    };

    const affected = isRevert
      ? await employeeWorkLogRepository.revertApprovedById(id, { reason, revertedBy: actorId }, transaction)
      : await employeeWorkLogRepository.deleteApprovedById(id, transaction);
    if (affected !== 1) {
      throw conflictError(`Work log entry #${id} is no longer approved and unsynced, so it was not ${verb}.`);
    }

    await writeApprovedLogActionAudit({ isRevert, snapshot, reason, actorId, actionAt, ipAddress, transaction });
  });

  logger.info(`Approver ${verb} an approved Employee Work Log entry`, {
    managerUserId, workLogId: id, employeeId: snapshot.employee_id, actorId,
  });

  const emailStatus = await notifyEmployeeOfApprovedLogAction({
    action,
    employeeId: snapshot.employee_id,
    companyId: snapshot.company_id || companyId,
    reason,
    actorId,
    actionAt,
    logs: [{
      work_date: snapshot.work_date,
      service_po_id: snapshot.service_po_id,
      hours: snapshot.hours,
      po_name: entry.servicePO && entry.servicePO.service_po_name,
    }],
  });

  const base = {
    id,
    action_type: isRevert ? 'REVERT_APPROVED_LOG' : 'DELETE_APPROVED_LOG',
    previous_status: 'approved',
    new_status: isRevert ? 'pending' : 'deleted',
    reason,
    email_status: emailStatus,
  };
  return isRevert
    ? { ...base, work_log: await employeeWorkLogRepository.findById(id) }
    : { ...base, deleted_log: snapshot };
};

/**
 * Audit row for one reverted / deleted log, written inside the caller's transaction (a failed write rolls the
 * action back). Same shape for the single and the day-wise bulk path.
 */
const writeApprovedLogActionAudit = ({ isRevert, snapshot, reason, actorId, actionAt, ipAddress, transaction }) => {
  const actionType = isRevert ? 'REVERT_APPROVED_LOG' : 'DELETE_APPROVED_LOG';
  return createAuditLog(
    actorId,
    actionType,
    'employee_work_logs',
    snapshot.id,
    snapshot,
    {
      action_type: actionType,
      log_id: snapshot.id,
      employee_id: snapshot.employee_id,
      log_date: snapshot.work_date,
      po_id: snapshot.service_po_id,
      hours: snapshot.hours,
      previous_status: 'approved',
      new_status: isRevert ? 'pending' : 'deleted',
      reason,
      action_by: actorId,
      action_at: actionAt.toISOString(),
    },
    ipAddress,
    { transaction, throwOnError: true, companyId: snapshot.company_id }
  );
};

/**
 * Best-effort e-mail to ONE affected employee, AFTER the transaction committed — one e-mail listing every
 * affected date and its logs (date, then "PO - N hrs" per log). emailLogService.sendAndLog always writes one
 * email_logs row (status sent/failed + error), so a failed delivery is on record; a failure here is logged and
 * reported as email_status:'failed' but never undoes the action.
 *
 * @param {object} params
 * @param {Array<{ work_date: string, service_po_id: number, hours: number|string, po_name?: string }>} params.logs
 * @returns {Promise<'sent'|'failed'|'no_email'>}
 */
const notifyEmployeeOfApprovedLogAction = async ({ action, employeeId, companyId, reason, actorId, actionAt, logs }) => {
  try {
    const missingPoIds = [...new Set(logs.filter((log) => !log.po_name).map((log) => log.service_po_id))];
    const [employee, actor, pos] = await Promise.all([
      Employee.findByPk(employeeId, { attributes: ['id', 'full_name', 'email'] }),
      Employee.findByPk(actorId, { attributes: ['id', 'full_name'] }),
      missingPoIds.length > 0
        ? ServicePO.findAll({ where: { id: { [Op.in]: missingPoIds } }, attributes: ['id', 'service_po_name'] })
        : [],
    ]);

    if (!employee || !employee.email) {
      logger.warn('Approved work log action e-mail skipped: employee has no e-mail address', { employeeId });
      return 'no_email';
    }

    const poNameById = new Map((pos || []).map((po) => [po.id, po.service_po_name]));
    const byDate = new Map();
    for (const log of logs) {
      if (!byDate.has(log.work_date)) byDate.set(log.work_date, []);
      byDate.get(log.work_date).push({
        poName: log.po_name || poNameById.get(log.service_po_id) || `PO #${log.service_po_id}`,
        hours: log.hours,
      });
    }
    const groups = [...byDate.keys()].sort().map((date) => ({
      date: moment(date, 'YYYY-MM-DD').format('DD-MM-YY'),
      items: byDate.get(date),
    }));

    const { subject, html } = buildApprovedWorkLogActionEmail({
      action,
      employeeName: employee.full_name,
      groups,
      reason,
      actionByName: actor ? actor.full_name : `User #${actorId}`,
      actionAt: dateHelper.formatDateTime(actionAt),
    });

    await emailLogService.sendAndLog({
      to: employee.email,
      subject,
      html,
      mailType: action === 'REVERT' ? emailLogService.MAIL_TYPES.WORKLOG_APPROVED_REVERTED : emailLogService.MAIL_TYPES.WORKLOG_APPROVED_DELETED,
      companyId,
      triggeredByEmployeeId: actorId,
      relatedEmployeeId: employeeId,
    });
    return 'sent';
  } catch (err) {
    logger.error('Approved work log action e-mail failed (the action itself was completed)', {
      employeeId, action, error: err.message,
    });
    return 'failed';
  }
};

/**
 * Day-wise (bulk) Revert / Delete: the approver picks one or more employees and, per employee, one or more
 * dates; EVERY approved, unsynced log of that employee on those dates (all POs the approver may act on) is
 * reverted / deleted, with ONE shared reason.
 *
 * Each employee is processed in their own transaction on row locks (all-or-nothing per employee, and a
 * concurrent request simply finds nothing left to act on), authorised exactly like Bulk Approve
 * (assertOwnEmployeeForApproval + the Project Manager / BU Admin PO restriction). One employee failing never
 * blocks the others — the result lists every employee's outcome. Each employee then gets ONE e-mail with
 * their own dates and logs.
 *
 * @param {'REVERT'|'DELETE'} action
 * @param {number} managerUserId
 * @param {{ selections: Array<{ employee_id: number, dates: string[] }>, reason: string }} body
 * @returns {Promise<{ action_type: string, reason: string, total_logs_affected: number, employees_processed: number,
 *   employees_failed: number, results: object[] }>}
 */
const performApprovedWorkLogActionByDate = async (action, managerUserId, body, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const isRevert = action === 'REVERT';
  const verb = isRevert ? 'reverted' : 'deleted';
  const reason = body.reason;
  const actionAt = new Date();

  const datesByEmployee = new Map();
  for (const selection of body.selections) {
    const employeeId = Number(selection.employee_id);
    if (!datesByEmployee.has(employeeId)) datesByEmployee.set(employeeId, new Set());
    selection.dates.forEach((date) => datesByEmployee.get(employeeId).add(date));
  }

  const results = [];
  for (const [employeeId, dateSet] of datesByEmployee) {
    const dates = [...dateSet].sort();
    try {
      const poIds = (await assertOwnEmployeeForApproval(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds))
        ?? await resolveBuAdminApprovalPoIds(managerUserId, companyId, hierarchyRank, callerBuIds, employeeId);

      const affected = [];
      await sequelize.transaction(async (transaction) => {
        const rows = await employeeWorkLogRepository.findApprovedByEmployeeAndDatesForUpdate(employeeId, dates, poIds, transaction);
        for (const row of rows) {
          const snapshot = {
            ...row.get({ plain: true }),
            time_entries: await employeeWorkLogRepository.findTimeEntriesByWorkLogId(row.id, transaction),
          };
          const count = isRevert
            ? await employeeWorkLogRepository.revertApprovedById(row.id, { reason, revertedBy: actorId }, transaction)
            : await employeeWorkLogRepository.deleteApprovedById(row.id, transaction);
          if (count !== 1) {
            throw conflictError(`Work log entry #${row.id} is no longer approved and unsynced, so it was not ${verb}.`);
          }
          await writeApprovedLogActionAudit({ isRevert, snapshot, reason, actorId, actionAt, ipAddress, transaction });
          affected.push(snapshot);
        }
      });

      const affectedDates = [...new Set(affected.map((log) => log.work_date))];
      const emailStatus = affected.length > 0
        ? await notifyEmployeeOfApprovedLogAction({
            action,
            employeeId,
            companyId: affected[0].company_id || companyId,
            reason,
            actorId,
            actionAt,
            logs: affected,
          })
        : 'not_needed';

      logger.info(`Approver ${verb} approved Employee Work Logs by date`, {
        managerUserId, employeeId, dates, logsAffected: affected.length, actorId,
      });

      results.push({
        employee_id: employeeId,
        status: affected.length > 0 ? 'done' : 'nothing_to_do',
        logs_affected: affected.length,
        affected_dates: affectedDates,
        skipped_dates: dates.filter((date) => !affectedDates.includes(date)),
        email_status: emailStatus,
      });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error(`Bulk ${verb} of approved work logs failed for an employee`, { managerUserId, employeeId, error: err.message });
      }
      results.push({
        employee_id: employeeId,
        status: 'failed',
        status_code: statusCode,
        error: statusCode >= 500 ? 'An unexpected error occurred.' : err.message,
      });
    }
  }

  return {
    action_type: isRevert ? 'REVERT_APPROVED_LOG' : 'DELETE_APPROVED_LOG',
    previous_status: 'approved',
    new_status: isRevert ? 'pending' : 'deleted',
    reason,
    total_logs_affected: results.reduce((sum, r) => sum + (r.logs_affected || 0), 0),
    employees_processed: results.filter((r) => r.status === 'done').length,
    employees_failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
};

const revertApprovedWorkLogsByDate = (managerUserId, body, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) =>
  performApprovedWorkLogActionByDate('REVERT', managerUserId, body, companyId, actorId, ipAddress, hierarchyRank, callerBuIds);

const deleteApprovedWorkLogsByDate = (managerUserId, body, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) =>
  performApprovedWorkLogActionByDate('DELETE', managerUserId, body, companyId, actorId, ipAddress, hierarchyRank, callerBuIds);

/**
 * Approver "Revert": Approved -> Pending, with a mandatory reason. See performApprovedWorkLogAction.
 */
const revertApprovedWorkLog = (managerUserId, id, reason, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) =>
  performApprovedWorkLogAction('REVERT', managerUserId, id, reason, companyId, actorId, ipAddress, hierarchyRank, callerBuIds);

/**
 * Approver "Delete": removes an approved, unsynced log (snapshot + reason kept in audit_logs), with a
 * mandatory reason. See performApprovedWorkLogAction.
 */
const deleteApprovedWorkLog = (managerUserId, id, reason, companyId, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) =>
  performApprovedWorkLogAction('DELETE', managerUserId, id, reason, companyId, actorId, ipAddress, hierarchyRank, callerBuIds);

module.exports = {
  getMyEmployees,
  getMyGrantedServicePOs,
  getEmployeeServicePOs,
  getTimesheets,
  approveTimesheet,
  getApprovalSummary,
  getApprovalSummaryAll,
  exportApprovalSummaryAll,
  bulkApproveTimesheets,
  rejectWorkLogEntry,
  revertApprovedWorkLog,
  deleteApprovedWorkLog,
  revertApprovedWorkLogsByDate,
  deleteApprovedWorkLogsByDate,
  assignServicePOToEmployee,
  removeServicePOFromEmployee,
  mapEmployeeToSelf,
  unmapEmployeeFromSelf,
  assertOwnEmployee,
  assertOwnEmployeeForApproval,
};
