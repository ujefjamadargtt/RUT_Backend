'use strict';

const { Op } = require('sequelize');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeRepository = require('../repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const employeeRoleRepository = require('../repositories/employeeRoleRepository');
const servicePORepository = require('../repositories/servicePORepository');
const companyRepository = require('../repositories/companyRepository');
// NOT destructured — kept as a module reference so tests can monkey-patch
// individual functions on it (same pattern as employeeService.js), unlike a
// destructured import which captures the function value at require-time.
const companyAccessControlService = require('./companyAccessControlService');
const employeeAccessControlService = require('./employeeAccessControlService');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Employee Service PO Mapping Service
 * Business rules for which Service POs an Employee may self-log time
 * against (Employee Self Timesheet, Phase 2). All company_id-scoped.
 */

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/**
 * @param {number} employeeId
 * @throws {{ statusCode: 400 }} the employee does not currently hold the
 *   Project Manager role
 */
async function assertEmployeeHoldsProjectManagerRole(employeeId) {
  const roles = await employeeRoleRepository.findRolesByEmployeeId(employeeId);
  if (!hasUnrestrictedServicePOVisibility(roles.map((role) => role.role_name))) {
    const err = new Error(
      `Employee #${employeeId} does not currently hold the Project Manager role and cannot be assigned as Project Manager for a Service PO.`
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Assign a Service PO to an Employee. One Employee -> many Service POs;
 * one Service PO -> many Employees (plain many-to-many). Prevents a
 * duplicate mapping row from ever existing for the same pair — an existing
 * row of ANY status must go through Activate/Deactivate instead (or, to
 * change only the `is_project_manager` flag of an already-existing row,
 * setMappingProjectManagerFlag()).
 *
 * `isProjectManager` (Section 11.B of the PM redesign spec — the Service PO
 * Master "Map Employees" entry point) is validated server-side against the
 * employee's CURRENT role set — never trusted from the request alone: an
 * employee who does not currently hold the Project Manager role cannot be
 * assigned `is_project_manager: true` for any Service PO (400), even by an
 * Admin. Omitted/false is always allowed (a plain employee mapping).
 *
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} userId
 * @param {number} companyId
 * @param {boolean} [isProjectManager]
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const assign = async (employeeId, servicePOId, userId, companyId, isProjectManager = false) => {
  // `companyId` may be a single number (BU-scoped actor) or an array (a
  // company-less Admin/Entity Admin's resolved owned-Company scope, see
  // companyAccessControlService.resolveActorCompanyScope) — both lookups
  // below now correctly scope by either shape, closing the previous
  // unscoped cross-tenant employee-existence leak.
  let employee = await employeeRepository.findById(employeeId, companyId);
  let employeeIsUnassigned = false;

  if (!employee) {
    // Not found under this scope could mean "belongs to a different
    // company" (must stay blocked) OR "has no Business Unit assigned yet"
    // (no company to have matched in the first place). An unassigned
    // Employee shouldn't be stuck unmappable until someone gets around to
    // assigning them a BU first, so confirm genuine non-assignment
    // (no legacy company_id, no employee_business_units row at all — not
    // just none in THIS scope) and let the mapping through if so.
    const candidate = await employeeRepository.findById(employeeId, null);
    if (candidate && candidate.company_id == null) {
      const businessUnits = await employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employeeId);
      if (businessUnits.length === 0) {
        employee = candidate;
        employeeIsUnassigned = true;
      }
    }
  }

  if (!employee) {
    throw notFoundError(`Employee #${employeeId} was not found in this company.`);
  }

  // includeCentralised: true — a Centralised Service PO must be assignable
  // regardless of company scope or who created it (decided design).
  const servicePO = await servicePORepository.findById(servicePOId, companyId, userId, null, null, true);
  if (!servicePO) {
    throw notFoundError(`Service PO #${servicePOId} was not found in this company.`);
  }

  // The mapping row itself needs ONE concrete company_id — a Service PO
  // always carries its own single company_id, so that's the natural owner
  // of the mapping regardless of which company the Employee themselves
  // belongs to. Cross-company mapping (an Employee from one company
  // resourced onto another company's Service PO) is intentionally allowed
  // — both `employee` and `servicePO` were already independently verified
  // above to fall within the caller's authorized scope; there's no
  // same-company requirement between the two of them.
  const resolvedCompanyId = servicePO.company_id;

  const existing = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId);
  if (existing) {
    const err = new Error(
      existing.status === 'active'
        ? `Employee #${employeeId} is already mapped to Service PO #${servicePOId}.`
        : `A mapping between Employee #${employeeId} and Service PO #${servicePOId} already exists but is inactive. Use Activate Mapping instead.`
    );
    err.statusCode = 409;
    throw err;
  }

  if (isProjectManager) {
    await assertEmployeeHoldsProjectManagerRole(employeeId);
  }

  const mapping = await employeeServicePOMappingRepository.create({
    company_id: resolvedCompanyId,
    employee_id: employeeId,
    service_po_id: servicePOId,
    status: 'active',
    is_project_manager: isProjectManager,
    created_by: userId,
    updated_by: userId,
  });

  logger.info('Employee-ServicePO mapping created', { mappingId: mapping.id, employeeId, servicePOId, userId });

  return mapping;
};

/**
 * Auto-map a newly-created Employee to every active Centralised Service
 * PO — called from every backend Employee-creation path (employeeService.
 * create, employeeImportService.importEmployees), inside the SAME
 * transaction as the Employee insert, so a mapping failure rolls back the
 * whole employee creation rather than leaving a partial record.
 *
 * By decided design, a Centralised Service PO is BU-less and is for every
 * Employee — regardless of the new Employee's own Business Unit, and
 * regardless of which Admin created the PO. servicePORepository.
 * getActiveCentralisedPOIds() already returns every is_centralised
 * candidate; every one of them is applicable here unconditionally.
 *
 * Each mapping row's own company_id is set to that PO's own company_id
 * (null for a BU-less PO), not the employee's — same "the Service PO owns
 * the mapping's company_id" precedent assign() above already establishes.
 *
 * Only ever runs at employee-creation time — it does not, and must not, run
 * when a PO's is_centralised flag changes, so existing employees are never
 * retroactively mapped/unmapped by a later flag flip. Manual mappings
 * (assign()) and this automatic path share the same unique constraint
 * (uq_employee_servicepo_mapping) + bulkCreate ignoreDuplicates, so whichever
 * one runs first "wins" and the other is silently a no-op for that pair.
 *
 * @param {number} employeeId
 * @param {number|null} companyId
 * @param {number} userId - the actor creating this Employee (becomes the
 *   new Employee's own `created_by`)
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
const autoMapCentralisedServicePOs = async (employeeId, companyId, userId, transaction) => {
  const candidates = await servicePORepository.getActiveCentralisedPOIds();
  if (!candidates.length) return;

  const records = candidates.map(({ id: service_po_id, company_id }) => ({
    company_id,
    employee_id: employeeId,
    service_po_id,
    status: 'active',
    created_by: userId,
    updated_by: userId,
  }));

  await employeeServicePOMappingRepository.bulkCreate(records, { transaction });

  logger.info('Employee auto-mapped to Centralised Service POs', {
    employeeId,
    companyId,
    servicePOIds: candidates.map((p) => p.id),
  });
};

/**
 * Auto-map a newly-created Centralised Service PO to every existing
 * eligible Employee — the mirror of autoMapCentralisedServicePOs() above,
 * in the other direction: that one runs at EMPLOYEE-creation time and
 * reaches existing Centralised POs; this one runs at Service-PO-creation
 * time and reaches existing Employees.
 *
 * By decided design, a Centralised Service PO is BU-less and is for every
 * Employee:
 * - BU-less (companyId == null, the normal case for a Centralised PO): every
 *   active, non-deleted Employee platform-wide (employeeRepository.
 *   findAllActiveIds()) — not scoped to the creating actor's own ownership
 *   hierarchy.
 * - Scoped to one company (companyId != null — a legacy/edge case): every
 *   ACTIVE Employee actually assigned (employee_business_units, status
 *   'active') to that SAME Business Unit, unchanged from before.
 *
 * Each mapping row's own company_id is set to this PO's own company_id
 * (null for a BU-less PO), same "the Service PO owns the mapping's
 * company_id" precedent assign()/autoMapCentralisedServicePOs() above
 * already establish.
 *
 * Only ever runs at Service-PO-creation time — it does not, and must not,
 * run when an existing PO's is_centralised flag changes, so existing
 * Employees are never retroactively mapped/unmapped by a later flag flip
 * (same precedent as autoMapCentralisedServicePOs()). Manual mappings
 * (assign()) and this automatic path share the same unique constraint
 * (uq_employee_servicepo_mapping) + bulkCreate ignoreDuplicates, so
 * whichever one runs first "wins" and the other is silently a no-op for
 * that pair.
 *
 * @param {number} servicePOId
 * @param {number|null} companyId - the new Service PO's own company_id
 * @param {number} userId - the actor creating this Service PO (becomes the
 *   new mapping rows' own `created_by`)
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
const autoMapExistingEmployeesToCentralisedServicePO = async (servicePOId, companyId, userId, transaction) => {
  let employeeIds;

  if (companyId != null) {
    employeeIds = await employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds([companyId]);
  } else {
    const allActive = await employeeRepository.findAllActiveIds();
    employeeIds = allActive.map((e) => e.id);
  }

  if (!employeeIds.length) return;

  const records = employeeIds.map((employee_id) => ({
    company_id: companyId,
    employee_id,
    service_po_id: servicePOId,
    status: 'active',
    created_by: userId,
    updated_by: userId,
  }));

  await employeeServicePOMappingRepository.bulkCreate(records, { transaction });

  logger.info('Centralised Service PO auto-mapped to existing Employees', {
    servicePOId,
    companyId,
    employeeIds,
  });
};

/**
 * Hard-delete a mapping row.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const removeMapping = async (id, companyId) => {
  const mapping = await employeeServicePOMappingRepository.findById(id, companyId);
  if (!mapping) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  await employeeServicePOMappingRepository.remove(id, companyId);
  logger.info('Employee-ServicePO mapping removed', { mappingId: id });
};

/**
 * Set a mapping row's status to 'active'.
 * @param {number} id
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const activateMapping = async (id, userId, companyId) => {
  const updated = await employeeServicePOMappingRepository.updateStatus(id, 'active', userId, companyId);
  if (!updated) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  logger.info('Employee-ServicePO mapping activated', { mappingId: id, userId });
  return updated;
};

/**
 * Set a mapping row's status to 'inactive'.
 * @param {number} id
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const deactivateMapping = async (id, userId, companyId) => {
  const updated = await employeeServicePOMappingRepository.updateStatus(id, 'inactive', userId, companyId);
  if (!updated) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  logger.info('Employee-ServicePO mapping deactivated', { mappingId: id, userId });
  return updated;
};

/**
 * List every Service PO mapped to one Employee.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getEmployeeMappings = async (employeeId, companyId, status) => {
  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, status);
};

/**
 * List every Employee mapped to one Service PO.
 *
 * Authorization is checked against the SERVICE PO itself (servicePORepository.
 * findById, which already correctly handles a company-less actor's OWN
 * BU-less Service PO via the createdBy fallback in its companyScope()) —
 * NOT by filtering the mapping rows by company_id, which would incorrectly
 * exclude every mapping on a Centralised (BU-less, company_id NULL) PO even
 * for the actor who created it (the mapping rows themselves carry the PO's
 * own company_id, i.e. null, same precedent as autoMapCentralisedServicePOs()
 * above). Once the caller is confirmed to be allowed to see this specific
 * PO, its mappings are listed unscoped by company_id — servicePOId already
 * narrows to exactly one, already-authorized PO.
 *
 * Uses resolveEmployeeMappingScope() (below) — NOT resolveActorCompanyScope()
 * — for this PO-access check: a BU Admin/Project Manager/Delivery Head
 * mapped to MULTIPLE Business Units must be able to open ANY Service PO
 * within their own managed set without first selecting that exact BU via
 * X-Company-Id (the route this backs uses authenticateIdentity, not the
 * full authenticate, specifically so resolveCompany's mandatory-header gate
 * for a multi-BU actor never applies here — see employeeServicePOMapping.
 * routes.js). resolveActorCompanyScope() would instead fall back to ONLY
 * the currently-selected req.companyId, incorrectly 404ing (or demanding a
 * header) for a PO in one of the caller's OTHER managed BUs. Admin/Entity
 * Admin behavior is unchanged either way — both helpers resolve identically
 * for those two ranks.
 *
 * @param {number} servicePOId
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null, employeeBusinessUnits: number[] }} authContext
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getServicePOEmployees = async (servicePOId, authContext, status) => {
  const companyId = await resolveEmployeeMappingScope(authContext);
  // includeCentralised: true — a Centralised Service PO must be viewable
  // regardless of company scope or who created it (decided design).
  const po = await servicePORepository.findById(servicePOId, companyId, authContext.employeeId, null, null, true);
  if (!po) {
    throw notFoundError(`Service PO #${servicePOId} was not found.`);
  }
  return employeeServicePOMappingRepository.findByServicePO(servicePOId, status);
};

/**
 * Role-name fragments (matched case-insensitively, by substring) that grant
 * an Employee unrestricted Service PO visibility for the "Manage Service PO
 * Mapping" screen — see getServicePOOptionsForEmployee()/
 * saveEmployeeServicePOMappings() below. Renamed from "Service PO Admin" to
 * "Project Manager" (see database/migrations/
 * 20260896_rename_service_po_admin_role_to_project_manager.sql) — matched
 * by fragment (not exact-equality) so this keeps working regardless of
 * casing. "Delivery Head" is NOT this role — it's a separate per-Service-PO
 * staffing field (service_pos.delivery_head_employee_id), not its own row
 * in the `roles` table, and is unaffected by this rename.
 */
const UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS = ['project manager'];

/**
 * @param {string[]} roleNames - the Employee's ACTUAL roles, always fetched
 *   server-side (employeeRoleRepository) — never trusted from the request.
 * @returns {boolean}
 */
function hasUnrestrictedServicePOVisibility(roleNames = []) {
  return roleNames.some((name) => {
    const normalized = (name || '').toLowerCase();
    return UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
  });
}

/**
 * The Service PO ids a Project Manager is the EXPLICIT approver of, for the
 * Timesheet Approval redesign — REUSES the existing employee_servicepo_mapping
 * table as-is (no new PM<->PO table), but ONLY the rows this employee is
 * explicitly marked as PM for (is_project_manager = true), never merely
 * every Service PO they happen to be mapped to. Every consumer of the
 * approval-routing logic (managerSelfServiceService.
 * assertOwnEmployeeForApproval/getMyEmployees, pmDashboardService's
 * pending_approvals scoping) calls this same function rather than
 * re-deriving the relationship.
 *
 * PM DETERMINATION — OLD vs NEW: previously, "is this employee the PM of
 * this Service PO" was inferred purely from (a) an active mapping row
 * existing, regardless of any explicit designation. That meant an Employee
 * holding the Project Manager role who was simply mapped to a Service PO as
 * an ordinary team member was incorrectly treated as its approver. Now it
 * requires an explicit is_project_manager = true on that SPECIFIC mapping
 * row — set only via assign()/saveEmployeeServicePOMappings()/
 * setMappingProjectManagerFlag(), each of which independently confirms the
 * employee currently holds the Project Manager role before allowing it, and
 * each of which is reverted to false (never deleted) the moment that role is
 * removed (see clearProjectManagerAssignmentsForEmployee()). The mapping row
 * — and the employee's ordinary access to the Service PO — is completely
 * unaffected either way.
 *
 * EXCLUDES Centralised Service POs (Leaves, On Bench, Training & Upskilling,
 * HR and Admin Activity, etc.) — a Centralised PO is auto-mapped to EVERY
 * Employee at creation time (see autoMapCentralisedServicePOs()) with
 * is_project_manager defaulting false, so this exclusion is now mostly
 * belt-and-suspenders, kept for defense in depth against a Centralised PO
 * ever being explicitly PM-assigned by mistake.
 *
 * @param {number} employeeId
 * @returns {Promise<number[]>}
 */
const getProjectManagerServicePOIds = async (employeeId) => {
  const mappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active', { onlyProjectManager: true });
  const allPoIds = mappings.map((m) => m.service_po_id);
  if (allPoIds.length === 0) return [];

  const centralisedIds = new Set(await servicePORepository.findCentralisedIdsAmong(allPoIds));
  return allPoIds.filter((id) => !centralisedIds.has(id));
};

/**
 * ANY employee's own active, non-Centralised Service PO mapping ids —
 * regardless of is_project_manager (unlike getProjectManagerServicePOIds()
 * above, which this employee is very likely NOT flagged true on; they're
 * ordinarily a plain team member, not the PM). Used ONLY by
 * resolveApprovalRoutingServicePOIds() below to find a REPORTING employee's
 * own real project(s), so a stray Centralised-PO (Leave/Bench/etc.) entry
 * can be routed to THAT project's actual Project Manager — a completely
 * different question from "which POs is this employee the PM of."
 *
 * @param {number} employeeId
 * @returns {Promise<number[]>}
 */
const getEmployeeRealProjectServicePOIds = async (employeeId) => {
  const mappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
  const allPoIds = mappings.map((m) => m.service_po_id);
  if (allPoIds.length === 0) return [];

  const centralisedIds = new Set(await servicePORepository.findCentralisedIdsAmong(allPoIds));
  return allPoIds.filter((id) => !centralisedIds.has(id));
};

/**
 * Resolve the Service PO ids whose Project Manager(s) should be notified
 * for a given Employee's pending work (the Timesheet Approval Reminder —
 * see employeeTimesheetService.remindPrimaryManagerForApproval).
 *
 * A Centralised PO (Leaves, On Bench, Training & Upskilling, HR and Admin
 * Activity, etc.) has no genuine Project Manager of its own — it's
 * auto-mapped to every Employee — so a pending entry against one is instead
 * routed through THIS SAME Employee's own real (non-Centralised) Service
 * PO mapping(s) (getEmployeeRealProjectServicePOIds() above — this reporting
 * employee is being looked up as an ordinary team member here, NOT as a
 * Project Manager, so it is deliberately NOT filtered by
 * is_project_manager): if I'm mapped to Ambulance Tracker and I log a Leave,
 * my Leave entry should reach Ambulance Tracker's own Project Manager(s),
 * not go unrouted (and definitely not reach every Project Manager in the
 * company who happens to be auto-mapped to "Leaves" too).
 *
 * @param {number} employeeId
 * @param {number[]} pendingServicePOIds - see employeeWorkLogRepository.getPendingServicePOIds
 * @returns {Promise<number[]>}
 */
const resolveApprovalRoutingServicePOIds = async (employeeId, pendingServicePOIds) => {
  if (!pendingServicePOIds || pendingServicePOIds.length === 0) return [];

  const centralisedIds = new Set(await servicePORepository.findCentralisedIdsAmong(pendingServicePOIds));
  const nonCentralisedIds = pendingServicePOIds.filter((id) => !centralisedIds.has(id));
  if (centralisedIds.size === 0) return nonCentralisedIds;

  const employeeRealPOIds = await getEmployeeRealProjectServicePOIds(employeeId);
  return [...new Set([...nonCentralisedIds, ...employeeRealPOIds])];
};

/**
 * The active employees EXPLICITLY assigned as Project Manager
 * (is_project_manager = true) for ANY of the given Service PO ids — the
 * reverse of getProjectManagerServicePOIds() above. Used by the Timesheet
 * Approval Reminder (employeeTimesheetService.remindPrimaryManagerForApproval)
 * to find every Project Manager who should be notified about an Employee's
 * pending work. Deduplicated by employee id — a Project Manager mapped to
 * more than one of the given Service POs is returned exactly once.
 *
 * PM DETERMINATION — OLD vs NEW: previously this filtered every actively-
 * mapped employee down to whichever ones currently held the Project Manager
 * role (employeeRoleRepository.findRolesByEmployeeId +
 * hasUnrestrictedServicePOVisibility) — so ANY employee holding that role
 * who happened to be mapped to the PO (as an ordinary team member, not
 * necessarily its PM) was notified as if they approved it. Now the mapping
 * row itself must explicitly carry is_project_manager = true (enforced at
 * write time — see assign()/saveEmployeeServicePOMappings()/
 * setMappingProjectManagerFlag() — to already require the Project Manager
 * role, and reverted to false the moment that role is removed — see
 * clearProjectManagerAssignmentsForEmployee()), so no live role re-check is
 * needed here: is_project_manager = true is the sole, sufficient condition.
 *
 * EXCLUDES Centralised Service POs from `servicePoIds` before resolving —
 * same reasoning as getProjectManagerServicePOIds() above, applied in the
 * reverse direction: since a Centralised PO (Leaves, On Bench, etc.) is
 * auto-mapped to every Employee, "find the Project Manager(s) of this PO"
 * would otherwise return every Project-Manager-role Employee in the
 * company for a pending Leave/Bench entry, flooding unrelated PMs with a
 * reminder that has nothing to do with their actual project.
 *
 * @param {number[]} servicePoIds
 * @returns {Promise<Array<{ id: number, full_name: string, email: string, status: string }>>}
 */
const getProjectManagersForServicePOs = async (servicePoIds) => {
  if (!servicePoIds || servicePoIds.length === 0) return [];

  const centralisedIds = new Set(await servicePORepository.findCentralisedIdsAmong(servicePoIds));
  const nonCentralisedPoIds = servicePoIds.filter((id) => !centralisedIds.has(id));
  if (nonCentralisedPoIds.length === 0) return [];

  const mappings = await employeeServicePOMappingRepository.findByServicePOs(nonCentralisedPoIds, 'active', { onlyProjectManager: true });
  const candidateById = new Map();
  for (const mapping of mappings) {
    if (mapping.employee && mapping.employee.status === 'active' && !candidateById.has(mapping.employee.id)) {
      candidateById.set(mapping.employee.id, mapping.employee);
    }
  }
  return [...candidateById.values()];
};

/**
 * Resolve the target Employee for the mapping screen — same resolution
 * assign() already does (including the genuinely-unassigned-Employee
 * fallback, so a brand-new Employee with no Business Unit yet isn't stuck
 * unmappable), factored out here so getServicePOOptionsForEmployee() and
 * saveEmployeeServicePOMappings() share one path without touching assign()
 * itself.
 * @param {number} employeeId
 * @param {number|number[]} companyId - caller's authorized scope
 * @returns {Promise<Employee>}
 */
async function resolveMappingTargetEmployee(employeeId, companyId) {
  let employee = await employeeRepository.findById(employeeId, companyId);
  if (!employee) {
    const candidate = await employeeRepository.findById(employeeId, null);
    if (candidate && candidate.company_id == null) {
      const businessUnits = await employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employeeId);
      if (businessUnits.length === 0) {
        employee = candidate;
      }
    }
  }
  if (!employee) {
    throw notFoundError(`Employee #${employeeId} was not found in this company.`);
  }
  return employee;
}

/**
 * Compute { unrestricted, businessUnitIds } for one Employee — the two
 * inputs servicePORepository.getEligibleForMapping() needs. Role is always
 * re-fetched from the database (employeeRoleRepository) — a request body
 * can never assert "this employee is Project Manager" itself.
 * @param {Employee} employee
 * @returns {Promise<{ unrestricted: boolean, businessUnitIds: number[] }>}
 */
async function resolveMappingEligibilityInputs(employee) {
  const [roles, businessUnits] = await Promise.all([
    employeeRoleRepository.findRolesByEmployeeId(employee.id),
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employee.id),
  ]);

  const unrestricted = hasUnrestrictedServicePOVisibility(roles.map((role) => role.role_name));
  const businessUnitIds = [
    ...new Set([...businessUnits.map((bu) => bu.id), ...(employee.company_id != null ? [employee.company_id] : [])]),
  ];

  return { unrestricted, businessUnitIds };
}

/**
 * Normalize the Save action's desired mapping set into { desiredIds,
 * desiredPMByPOId } — `servicePOEntries` may be a plain array of Service PO
 * ids (is_project_manager defaults false for every one — fully backward
 * compatible with the original API contract, and how a non-Project-Manager
 * Employee's mapping screen keeps working unchanged) OR an array mixing
 * plain ids with `{ service_po_id, is_project_manager }` objects (Section
 * 11.A of the PM redesign spec — the Employee Master mapping screen's
 * per-row "also make Project Manager" checkbox, shown only when the target
 * Employee holds the Project Manager role). A duplicate id keeps its LAST
 * occurrence's flag, same as a plain array naturally de-dupes by value.
 *
 * @param {Array<number|{service_po_id:number, is_project_manager?:boolean}>} servicePOEntries
 * @returns {{ desiredIds: number[], desiredPMByPOId: Map<number, boolean> }}
 */
function normalizeServicePOEntries(servicePOEntries) {
  const desiredPMByPOId = new Map();
  for (const entry of servicePOEntries) {
    const isObject = entry !== null && typeof entry === 'object';
    const poId = isObject ? entry.service_po_id : entry;
    const isProjectManager = isObject ? !!entry.is_project_manager : false;
    desiredPMByPOId.set(poId, isProjectManager);
  }
  return { desiredIds: [...desiredPMByPOId.keys()], desiredPMByPOId };
}

/**
 * GET the Employee Service PO Mapping screen's data: every Service PO the
 * Employee is eligible to be mapped to, plus their currently mapped Service
 * PO ids — the frontend renders these as a checkbox list (Test cases 1-5).
 *
 * MOST IMPORTANT BUSINESS RULE: an Employee holding Project Manager or
 * Delivery Head sees every eligible Service PO within the caller's
 * authorized company/tenant scope, regardless of their own Business Unit —
 * see servicePORepository.getEligibleForMapping()'s doc comment. Every
 * other role stays restricted to their own Business Unit(s) plus
 * Centralised/BU-less POs, same as the rest of this module.
 *
 * Uses resolveEmployeeMappingScope() (NOT resolveActorCompanyScope()) for
 * the CALLER's scope — same reasoning as getServicePOEmployees()/assign()'s
 * resolveScope() above: a BU Admin/Project Manager/Delivery Head managing
 * MULTIPLE Business Units under the same Admin must see/save every eligible
 * Service PO across ALL of them, not just whichever ONE happens to be the
 * active Global BU (req.companyId). resolveActorCompanyScope() previously
 * used here narrowed a multi-BU caller to that single active BU, so opening
 * this screen for an Employee/PO outside it wrongly rejected an otherwise
 * legitimately-eligible mapping ("Service PO(s) ... are not eligible") —
 * the exact bug already fixed for assign()/getServicePOEmployees() but
 * missed here.
 *
 * @param {number} employeeId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId, employeeBusinessUnits } — the CALLER's, not the target Employee's
 * @returns {Promise<{ employee_id: number, unrestricted: boolean, eligible_service_pos: object[], mapped_service_po_ids: number[] }>}
 */
const getServicePOOptionsForEmployee = async (employeeId, authContext) => {
  const companyId = await resolveEmployeeMappingScope(authContext);
  const employee = await resolveMappingTargetEmployee(employeeId, companyId);

  const [{ unrestricted, businessUnitIds }, currentMappings] = await Promise.all([
    resolveMappingEligibilityInputs(employee),
    employeeServicePOMappingRepository.findByEmployee(employeeId, companyId),
  ]);

  const eligiblePOs = await servicePORepository.getEligibleForMapping({
    companyId,
    createdBy: authContext.employeeId,
    unrestricted,
    businessUnitIds,
  });

  return {
    employee_id: employeeId,
    unrestricted,
    eligible_service_pos: eligiblePOs.map((po) => ({
      id: po.id,
      service_po_code: po.service_po_code,
      service_po_name: po.service_po_name,
      company_id: po.company_id,
      is_centralised: po.is_centralised,
      client: po.client ? { id: po.client.id, client_name: po.client.client_name } : null,
      project: po.project ? { id: po.project.id, project_name: po.project.project_name } : null,
    })),
    mapped_service_po_ids: currentMappings.filter((m) => m.status === 'active').map((m) => m.service_po_id),
    // The subset of mapped_service_po_ids this Employee is explicitly the
    // Project Manager for (is_project_manager = true) — lets the frontend
    // pre-check each row's "also make Project Manager" toggle without a
    // second round-trip. Always empty when `unrestricted` is false (the
    // Employee doesn't hold the Project Manager role, so the toggle isn't
    // offered at all).
    project_manager_service_po_ids: currentMappings
      .filter((m) => m.status === 'active' && m.is_project_manager)
      .map((m) => m.service_po_id),
  };
};

/**
 * Replace an Employee's Service PO mapping set to exactly `servicePOIds` —
 * the Employee Service PO Mapping screen's Save action (Test cases 6-8).
 *
 * Every requested id is revalidated server-side against the SAME eligible-
 * PO computation getServicePOOptionsForEmployee() uses — never trusts the
 * request body for the Employee's role/company/Business Unit; an id
 * outside that set is rejected with a 400 for the whole request, nothing is
 * partially saved.
 *
 * Existing rows are diff-synced, never hard-deleted: a currently-active row
 * for a PO no longer selected is set to 'inactive' (the same soft-removal
 * pattern activateMapping()/deactivateMapping() already use), a currently-
 * inactive row for a newly-selected PO is reactivated, and a brand-new pair
 * gets a fresh 'active' row — mirrors employeeRoleRepository.
 * replaceForEmployee()'s keep/add/remove idiom. uq_employee_servicepo_mapping
 * (employee_id, service_po_id) prevents any duplicate row regardless of how
 * many times the same set is saved.
 *
 * Uses resolveEmployeeMappingScope() (NOT resolveActorCompanyScope()) for
 * the CALLER's scope — see getServicePOOptionsForEmployee()'s doc comment
 * above for why: a multi-BU caller's full managed scope, not just their
 * single currently-active Business Unit.
 *
 * `is_project_manager` per entry (Section 11.A of the PM redesign spec) is
 * validated the same way assign() validates it: a `true` entry requires the
 * target Employee to CURRENTLY hold the Project Manager role (`unrestricted`
 * below — server-resolved, never trusted from the request), else the WHOLE
 * save is rejected with 400 before anything is written, same as an
 * ineligible Service PO id. An existing row's `is_project_manager` is
 * updated in place when the desired value differs (true -> false or
 * false -> true) — it is NEVER deleted/recreated to change this flag, and
 * changing it never touches `status`.
 *
 * @param {number} employeeId
 * @param {Array<number|{service_po_id:number, is_project_manager?:boolean}>} servicePOEntries - the DESIRED full set of active mappings
 * @param {number} userId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId, employeeBusinessUnits } — the CALLER's
 * @returns {Promise<EmployeeServicePOMapping[]>} the employee's mappings after save
 */
const saveEmployeeServicePOMappings = async (employeeId, servicePOEntries, userId, authContext) => {
  const companyId = await resolveEmployeeMappingScope(authContext);
  const employee = await resolveMappingTargetEmployee(employeeId, companyId);
  const { unrestricted, businessUnitIds } = await resolveMappingEligibilityInputs(employee);

  const { desiredIds, desiredPMByPOId } = normalizeServicePOEntries(servicePOEntries);

  if (!unrestricted) {
    const requestedPMIds = desiredIds.filter((id) => desiredPMByPOId.get(id));
    if (requestedPMIds.length > 0) {
      const err = new Error(
        `Employee #${employeeId} does not currently hold the Project Manager role and cannot be assigned as Project Manager for Service PO(s) ${requestedPMIds.join(', ')}.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const eligiblePOs = await servicePORepository.getEligibleForMapping({
    companyId,
    createdBy: authContext.employeeId,
    unrestricted,
    businessUnitIds,
  });
  const eligibleById = new Map(eligiblePOs.map((po) => [po.id, po]));

  // Grandfather in the Employee's own currently-ACTIVE mappings, even for a
  // Service PO whose status has since moved outside the "open for new
  // assignment" set getEligibleForMapping() enforces (in-progress/on-hold/
  // pending) — e.g. completed/closed. Save always resends the FULL desired
  // set (see this function's own doc comment above), so an already-mapped
  // PO the caller didn't proactively uncheck must not fail the WHOLE save;
  // only a genuinely NEW selection is held to the "still open" eligibility
  // rule. Real bug this fixes: an Employee actively mapped to a PO that
  // later closes/completes could never have ANYTHING else about them saved
  // (a role, a Business Unit, another Service PO) without this Save
  // rejecting the whole request as "not eligible" for that one closed PO.
  const currentActiveMappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
  const currentActivePOIds = new Set(currentActiveMappings.map((m) => m.service_po_id));

  const invalidIds = desiredIds.filter((id) => !eligibleById.has(id) && !currentActivePOIds.has(id));
  if (invalidIds.length > 0) {
    const err = new Error(`Service PO(s) ${invalidIds.join(', ')} are not eligible for Employee #${employeeId}.`);
    err.statusCode = 400;
    throw err;
  }

  // Every currently-eligible id, every desired id, AND every currently-
  // active mapped id (so a grandfathered PO's existing row is found — both
  // to leave it untouched when still desired, and to correctly deactivate
  // it when the caller DID remove it from the desired set).
  const relevantIds = [...new Set([...eligibleById.keys(), ...desiredIds, ...currentActivePOIds])];
  const existingRows = await employeeServicePOMappingRepository.findByEmployeeAndPOIds(employeeId, relevantIds);
  const existingByPOId = new Map(existingRows.map((row) => [row.service_po_id, row]));
  const desiredSet = new Set(desiredIds);

  const toCreate = [];
  const toActivateIds = [];
  const toDeactivateIds = [];
  const toSetPMTrueIds = [];
  const toSetPMFalseIds = [];

  for (const poId of desiredIds) {
    const existing = existingByPOId.get(poId);
    const desiredIsPM = !!desiredPMByPOId.get(poId);
    if (!existing) {
      toCreate.push({
        company_id: eligibleById.get(poId).company_id,
        employee_id: employeeId,
        service_po_id: poId,
        status: 'active',
        is_project_manager: desiredIsPM,
        created_by: userId,
        updated_by: userId,
      });
    } else {
      if (existing.status !== 'active') {
        toActivateIds.push(existing.id);
      }
      // Section 13: updating an existing mapping's PM flag (either
      // direction) updates that SAME row — never a separate create/delete.
      if ((existing.is_project_manager === true) !== desiredIsPM) {
        (desiredIsPM ? toSetPMTrueIds : toSetPMFalseIds).push(existing.id);
      }
    }
  }

  for (const [poId, row] of existingByPOId) {
    if (!desiredSet.has(poId) && row.status === 'active') {
      toDeactivateIds.push(row.id);
    }
  }

  if (toCreate.length > 0) {
    await employeeServicePOMappingRepository.bulkCreate(toCreate);
  }
  if (toActivateIds.length > 0) {
    await employeeServicePOMappingRepository.bulkUpdateStatus(toActivateIds, 'active', userId);
  }
  if (toDeactivateIds.length > 0) {
    await employeeServicePOMappingRepository.bulkUpdateStatus(toDeactivateIds, 'inactive', userId);
  }
  if (toSetPMTrueIds.length > 0) {
    await employeeServicePOMappingRepository.bulkSetProjectManagerFlag(toSetPMTrueIds, true, userId);
  }
  if (toSetPMFalseIds.length > 0) {
    await employeeServicePOMappingRepository.bulkSetProjectManagerFlag(toSetPMFalseIds, false, userId);
  }

  logger.info('Employee-ServicePO mappings saved', {
    employeeId,
    created: toCreate.length,
    activated: toActivateIds.length,
    deactivated: toDeactivateIds.length,
    pmFlagSetTrue: toSetPMTrueIds.length,
    pmFlagSetFalse: toSetPMFalseIds.length,
    userId,
  });

  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId);
};

/**
 * Role-name fragments (matched case-insensitively, by substring, from the
 * caller's own SERVER-VERIFIED active role — req.userRoles, resolved by
 * middlewares/auth.js from the verified JWT — never a role/mode a request
 * parameter could assert) that grant authority to manage Service PO ->
 * Employee mappings: see getEmployeeOptionsForServicePO() below. Distinct
 * from UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS above — that one governs
 * "which Service POs can an EMPLOYEE be mapped to" (Employee -> PO
 * direction); this one governs "who may open the Service PO -> Employee
 * Mapping screen at all" (the reverse direction, PO -> Employee).
 * "service po admin" was renamed to "project manager" — see
 * UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS's doc comment above.
 */
const SERVICE_PO_MAPPING_AUTHORITY_ROLE_FRAGMENTS = ['bu admin', 'project manager'];

/**
 * @param {string[]} roleNames - the CALLER's own actual active role(s),
 *   always server-resolved (req.userRoles) — never trusted from the request.
 * @returns {boolean}
 */
function hasServicePOMappingAuthority(roleNames = []) {
  return roleNames.some((name) => {
    const normalized = (name || '').toLowerCase();
    return SERVICE_PO_MAPPING_AUTHORITY_ROLE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
  });
}

/**
 * Resolve the "same Admin/company scope" Employee list scope for the
 * Service PO -> Employee Mapping screen (getEmployeeOptionsForServicePO()
 * below) — deliberately NOT the Service PO's own single company_id, and
 * NOT just the caller's currently SELECTED Global Business Unit
 * (authContext.companyId, a single value even for a multi-BU actor).
 *
 * For a BU Admin/Project Manager/Delivery Head, "same Admin/company
 * scope" means the ENTIRE tenant their owning Admin manages — the same
 * full scope that Admin themselves would see — NOT merely the Business
 * Unit(s) this specific actor personally happens to be mapped to (a BU
 * Admin managing only 2 of 5 BUs under the same Admin must still see every
 * Employee across all 5, matching the "BU Admin/Project Manager/Delivery
 * Head are operating under the Admin's scope" business rule). Resolved via
 * companyAccessControlService.resolveAdminScopeForBusinessUnits(), walking
 * UP from the caller's own Business Unit(s) (authContext.employeeBusinessUnits
 * — every BU they're actively mapped to, populated by middlewares/auth.js,
 * independent of X-Company-Id/whichever ONE is "selected" right now) to
 * the Admin who owns them, then back DOWN to that Admin's full scope.
 *
 * Admin/Entity Admin (company-less) keep using the SAME owned-Company-array
 * resolution every other part of this codebase already uses for them
 * (companyAccessControlService.resolveOwnedCompanyIds) — this function
 * changes nothing for those two tiers.
 *
 * @param {{ hierarchyRank: number|null, employeeId: number|null, companyId: number|null, employeeBusinessUnits: number[] }} authContext
 * @returns {Promise<number[]>}
 */
async function resolveEmployeeMappingScope({ hierarchyRank, employeeId, companyId, employeeBusinessUnits = [] }) {
  if (hierarchyRank === 2 || hierarchyRank === 3) {
    const owned = await companyAccessControlService.resolveOwnedCompanyIds(hierarchyRank, employeeId);
    return owned || [];
  }
  const ownBusinessUnits = employeeBusinessUnits.length > 0
    ? employeeBusinessUnits
    : (companyId != null ? [companyId] : []);
  if (ownBusinessUnits.length === 0) return [];
  return companyAccessControlService.resolveAdminScopeForBusinessUnits(ownBusinessUnits);
}

/**
 * Resolve the `{ companyId, accessWhere }` pair to spread straight into
 * employeeRepository.findAll()/getActiveEmployees()'s `filters` for the
 * Service PO -> Employee Mapping / `service_po_id` flows
 * (getEmployeeOptionsForServicePO() below; employeeService.getAll()/
 * getActiveEmployees()'s servicePOId branches) — NOT for authorizing the
 * Service PO itself (getServicePOEmployees() above correctly keeps using
 * plain resolveEmployeeMappingScope() for that, since a Service PO always
 * carries a real company_id, so the gap described below never applies
 * there — only to Employees).
 *
 * For Admin (rank 2) / Entity Admin (rank 3): reuses
 * employeeAccessControlService.resolveEmployeeAccessWhere() AS-IS. Its
 * scope for these two ranks is ALREADY tenant-wide (every Company under
 * their owned Entity hierarchy) with NO Business-Unit narrowing — AND,
 * critically, for Admin it already includes the "Employee this Admin
 * directly created but hasn't assigned a Business Unit to yet"
 * (`created_by: employeeId`) fallback (see that function's own doc
 * comment).
 *
 * For every other rank (BU Admin, Project Manager, Delivery Head, and
 * anyone else): resolveEmployeeAccessWhere() would instead apply its
 * narrow "my own team" scope — bypassed here in favor of the caller's
 * OWNING Admin's full scope (companyAccessControlService.
 * resolveAdminOwnershipForBusinessUnits()) — but that scope MUST be built
 * as the SAME kind of accessWhere fragment the Admin themselves gets, not
 * a bare companyId/employeeScope() call: an Employee the owning Admin
 * directly created but never assigned a Business Unit to (confirmed root
 * cause of a BU Admin/Project Manager/Delivery Head seeing fewer
 * Employees — e.g. "10 of 18" — than their owning Admin's real total)
 * matches NEITHER a plain company_id/employee_business_units check NOR
 * `{ id: adminId }` — only `{ created_by: adminId }`. So this builds
 * `{ id: adminId } OR { created_by: adminId } OR employeeScope(companyIds) }`
 * for each resolved owning Admin, exactly mirroring
 * resolveEmployeeAccessWhere()'s own rank-2 formula.
 *
 * @param {object} authContext - { hierarchyRank, employeeId, companyId, employeeBusinessUnits, ... } — the CALLER's
 * @returns {Promise<{ companyId: number|number[]|undefined, accessWhere: object|undefined }>}
 */
async function resolveEmployeeMappingAccessScope(authContext) {
  if (authContext.hierarchyRank === 2 || authContext.hierarchyRank === 3) {
    const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
    return { companyId: undefined, accessWhere };
  }

  const ownBusinessUnits = authContext.employeeBusinessUnits && authContext.employeeBusinessUnits.length > 0
    ? authContext.employeeBusinessUnits
    : (authContext.companyId != null ? [authContext.companyId] : []);
  if (ownBusinessUnits.length === 0) {
    return { companyId: [], accessWhere: undefined };
  }

  const { adminIds, companyIds } = await companyAccessControlService.resolveAdminOwnershipForBusinessUnits(ownBusinessUnits);
  if (adminIds.length === 0) {
    // No owning Admin resolvable at all (legacy/edge-case data) — fall
    // back to the plain Business-Unit scope, same defensive behavior as
    // resolveEmployeeMappingScope().
    return { companyId: companyIds, accessWhere: undefined };
  }

  const employeeScopeWhere = await employeeRepository.employeeScope(companyIds);
  const orConditions = [];
  for (const adminId of adminIds) {
    orConditions.push({ id: adminId }, { created_by: adminId });
  }
  if (employeeScopeWhere[Op.or]) {
    orConditions.push(...employeeScopeWhere[Op.or]);
  } else if (Object.keys(employeeScopeWhere).length > 0) {
    orConditions.push(employeeScopeWhere);
  }

  return { companyId: undefined, accessWhere: { [Op.or]: orConditions } };
}

/**
 * GET the Service PO -> Employee Mapping screen's data — the REVERSE
 * direction of getServicePOOptionsForEmployee(): every Employee within the
 * caller's authorized Admin/company scope, plus which of them are already
 * mapped to THIS ONE Service PO, so the frontend can render a checkbox
 * list (☑ mapped / ☐ not mapped) without a second round-trip.
 *
 * MOST IMPORTANT BUSINESS RULE, deliberately the OPPOSITE of
 * getServicePOOptionsForEmployee()/servicePORepository.getEligibleForMapping()
 * above: the returned Employee list is NEVER *automatically* narrowed by
 * Business Unit — not the Service PO's own BU, not the caller's currently
 * selected Global BU, not even whether the Employee has a BU at all.
 * Employee BU is not an ambient access restriction for this specific
 * screen; only the caller's authorized Admin/company/tenant scope is
 * (resolveEmployeeMappingScope() above) — a cross-company/cross-tenant
 * Employee is still never exposed. See this function's own tests for the
 * exact scenarios this covers.
 *
 * `options.business_unit_id`, if given, is a DIFFERENT thing: the frontend
 * panel's own opt-in Entity → BU filter dropdowns, explicitly chosen by the
 * caller to narrow what THEY see — same as `options.search` — applied via
 * employeeRepository.findAll()'s `businessUnitId` filter strictly ON TOP OF
 * the full scope above, never in place of it. It does not change, and must
 * never be made to change, the rule above.
 *
 * Restricted to callers who actually hold Service PO mapping authority
 * (hasServicePOMappingAuthority() above, or Admin/Entity Admin who are
 * senior to all three roles it names) — resolved from the caller's own
 * server-verified active role, never a role/mode the request could assert.
 *
 * @param {number} servicePOId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId, roleNames, employeeBusinessUnits } — the CALLER's
 * @param {object} [options] - { search, page, limit, business_unit_id }
 * @returns {Promise<{ service_po_id: number, eligible_employees: object[], mapped_employee_ids: number[], meta: object }>}
 * @throws {{ statusCode: 403 }} caller lacks Service PO mapping authority
 * @throws {{ statusCode: 404 }} Service PO not found (or outside the caller's tenant scope)
 */
const getEmployeeOptionsForServicePO = async (servicePOId, authContext, options = {}) => {
  const isSeniorTier = authContext.hierarchyRank != null && authContext.hierarchyRank <= 3;
  if (!isSeniorTier && !hasServicePOMappingAuthority(authContext.roleNames)) {
    const err = new Error('You are not authorized to manage Service PO employee mappings.');
    err.statusCode = 403;
    throw err;
  }

  // resolveEmployeeMappingScope() here too (NOT resolveActorCompanyScope())
  // — same reasoning as getServicePOEmployees() above: a multi-BU BU Admin/
  // Project Manager/Delivery Head must be able to open ANY Service PO
  // within their own managed set without X-Company-Id having been set to
  // that exact BU first.
  const tenantScope = await resolveEmployeeMappingScope(authContext);
  // includeCentralised: true — a Centralised Service PO must be viewable
  // regardless of company scope or who created it (decided design).
  const po = await servicePORepository.findById(servicePOId, tenantScope, authContext.employeeId, null, null, true);
  if (!po) {
    throw notFoundError(`Service PO #${servicePOId} was not found.`);
  }

  const { companyId: employeeScopeId, accessWhere: employeeAccessWhere } = await resolveEmployeeMappingAccessScope(authContext);

  // The panel's own opt-in Entity → BU filter — see this function's doc comment. Invalid/absent
  // values are simply ignored (no filter applied), matching getAll()'s same permissive handling of
  // this field.
  const parsedBusinessUnitId = Number(options.business_unit_id);
  const businessUnitId = Number.isInteger(parsedBusinessUnitId) && parsedBusinessUnitId > 0
    ? parsedBusinessUnitId
    : null;

  const { page, limit, offset } = getPaginationParams(options);
  const [{ rows, count }, mappedRows] = await Promise.all([
    employeeRepository.findAll(
      { search: options.search || '', status: 'active', companyId: employeeScopeId, accessWhere: employeeAccessWhere, businessUnitId },
      { limit, offset },
      { sortBy: 'full_name', sortOrder: 'ASC' }
    ),
    employeeServicePOMappingRepository.findByServicePO(servicePOId, 'active'),
  ]);

  return {
    service_po_id: servicePOId,
    eligible_employees: rows.map((employee) => {
      const plain = employee.toJSON ? employee.toJSON() : { ...employee };
      return {
        id: plain.id,
        full_name: plain.full_name,
        employee_code: plain.employee_code,
        designation: plain.designation,
        status: plain.status,
      };
    }),
    mapped_employee_ids: mappedRows.map((row) => row.employee_id),
    // The subset of mapped_employee_ids explicitly assigned as this Service
    // PO's Project Manager (is_project_manager = true) — Section 11.B of
    // the PM redesign spec: lets the frontend pre-select each mapped
    // employee's "Employee" vs "Project Manager" radio without a second
    // round-trip.
    project_manager_employee_ids: mappedRows.filter((row) => row.is_project_manager).map((row) => row.employee_id),
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Update ONLY an existing mapping row's `is_project_manager` flag — never
 * creates a new row, never touches `status`. Backs both:
 *   - Section 8 Case 1 ("remove PM status only" — employee stays mapped),
 *     and its promote-to-PM mirror, from the Employee Master mapping screen;
 *   - Section 11.B's Service PO Master "Map Employees" screen, once an
 *     employee is already mapped and the caller later changes their
 *     "Employee" vs "Project Manager" radio for that one Service PO.
 *
 * Turning it ON (isProjectManager = true) requires the mapping's OWN
 * employee to currently hold the Project Manager role — server-resolved,
 * never trusted from the request — else 400 (Section 13). Turning it OFF
 * (false) is always allowed and never deletes the mapping (Section 7/8).
 *
 * @param {number} id - the mapping row's own id
 * @param {boolean} isProjectManager
 * @param {number} userId
 * @param {number|number[]} companyId - the CALLER's authorized scope
 * @returns {Promise<EmployeeServicePOMapping>}
 * @throws {{ statusCode: 404 }} mapping not found (or outside the caller's scope)
 * @throws {{ statusCode: 400 }} isProjectManager=true but the employee doesn't hold the Project Manager role
 */
const setMappingProjectManagerFlag = async (id, isProjectManager, userId, companyId) => {
  const mapping = await employeeServicePOMappingRepository.findById(id, companyId);
  if (!mapping) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }

  if (isProjectManager) {
    await assertEmployeeHoldsProjectManagerRole(mapping.employee_id);
  }

  const updated = await employeeServicePOMappingRepository.updateProjectManagerFlag(id, isProjectManager, userId, companyId);
  logger.info('Employee-ServicePO mapping PM flag updated', { mappingId: id, isProjectManager, userId });
  return updated;
};

/**
 * Section 6/7 of the PM redesign spec: when an Employee's Project Manager
 * role is removed/disabled (via any role-update path — currently
 * employeeService.js's update()), every Service PO mapping row where they
 * held is_project_manager = true reverts to a plain employee mapping. The
 * mapping row itself is NEVER deleted — only the flag — so the employee
 * keeps their ordinary access to every one of those Service POs.
 *
 * @param {number} employeeId
 * @param {number} userId
 * @param {object} [transaction] - runs inside the caller's own role-update transaction
 * @returns {Promise<number>} number of mapping rows reverted
 */
const clearProjectManagerAssignmentsForEmployee = async (employeeId, userId, transaction) => {
  const count = await employeeServicePOMappingRepository.clearProjectManagerFlagForEmployee(employeeId, userId, transaction);
  if (count > 0) {
    logger.info('Project Manager role removed — reverted PM-flagged Service PO mappings to plain employee mappings', {
      employeeId, count, userId,
    });
  }
  return count;
};

/**
 * GET the Entity → Business Unit filter dropdown options for the Service PO
 * -> Map Employees screen (EntityBuFilterBar / `business_unit_id` on
 * getEmployeeOptionsForServicePO() above).
 *
 * Deliberately NOT backed by GET /entities or GET /companies: both 403 a BU
 * Admin/Project Manager/Delivery Head (Entity Admin/Admin only), and even
 * for a BU Admin, GET /companies ignores `entity_id` and returns only that
 * BU Admin's own directly-mapped BUs — narrower than the "owning Admin's
 * full scope" getEmployeeOptionsForServicePO() itself is scoped to (see its
 * doc comment). Reusing resolveEmployeeMappingScope() — the SAME plain
 * company/BU id list already used above to authorize the PO lookup — means
 * these dropdowns can never offer an Entity/BU wider (or narrower) than what
 * the eligible-employee query itself would actually honour.
 *
 * @param {object} authContext - { companyId, hierarchyRank, employeeId, roleNames, employeeBusinessUnits } — the CALLER's
 * @returns {Promise<{ entities: {id: number, entity_name: string}[], business_units: {id: number, company_name: string, entity_id: number}[] }>}
 * @throws {{ statusCode: 403 }} caller lacks Service PO mapping authority
 */
const getEmployeeMappingFilterOptions = async (authContext) => {
  const isSeniorTier = authContext.hierarchyRank != null && authContext.hierarchyRank <= 3;
  if (!isSeniorTier && !hasServicePOMappingAuthority(authContext.roleNames)) {
    const err = new Error('You are not authorized to manage Service PO employee mappings.');
    err.statusCode = 403;
    throw err;
  }

  const businessUnitIds = await resolveEmployeeMappingScope(authContext);
  const companies = await companyRepository.findByIdsWithEntity(businessUnitIds);

  const business_units = companies.map((c) => ({
    id: c.id,
    company_name: c.company_name,
    entity_id: c.entity_id,
  }));

  // Deduped by entity_id, in first-seen order (companies already arrive
  // sorted by company_name) — good enough for a filter dropdown, no
  // separate sort pass needed.
  const entityMap = new Map();
  for (const c of companies) {
    if (c.entity && !entityMap.has(c.entity_id)) {
      entityMap.set(c.entity_id, { id: c.entity_id, entity_name: c.entity.entity_name });
    }
  }

  return { entities: Array.from(entityMap.values()), business_units };
};

module.exports = {
  assign,
  autoMapCentralisedServicePOs,
  autoMapExistingEmployeesToCentralisedServicePO,
  removeMapping,
  activateMapping,
  deactivateMapping,
  getEmployeeMappings,
  getServicePOEmployees,
  getProjectManagerServicePOIds,
  getEmployeeRealProjectServicePOIds,
  getProjectManagersForServicePOs,
  resolveApprovalRoutingServicePOIds,
  hasUnrestrictedServicePOVisibility,
  getServicePOOptionsForEmployee,
  saveEmployeeServicePOMappings,
  setMappingProjectManagerFlag,
  clearProjectManagerAssignmentsForEmployee,
  hasServicePOMappingAuthority,
  getEmployeeOptionsForServicePO,
  getEmployeeMappingFilterOptions,
  resolveEmployeeMappingScope,
  resolveEmployeeMappingAccessScope,
};
