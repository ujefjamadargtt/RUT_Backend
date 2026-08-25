'use strict';

const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeRepository = require('../repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const employeeRoleRepository = require('../repositories/employeeRoleRepository');
const servicePORepository = require('../repositories/servicePORepository');
// NOT destructured — kept as a module reference so tests can monkey-patch
// individual functions on it (same pattern as employeeService.js), unlike a
// destructured import which captures the function value at require-time.
const companyAccessControlService = require('./companyAccessControlService');
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
 * Assign a Service PO to an Employee. One Employee -> many Service POs;
 * one Service PO -> many Employees (plain many-to-many). Prevents a
 * duplicate mapping row from ever existing for the same pair — an existing
 * row of ANY status must go through Activate/Deactivate instead.
 *
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const assign = async (employeeId, servicePOId, userId, companyId) => {
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

  const servicePO = await servicePORepository.findById(servicePOId, companyId);
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

  const mapping = await employeeServicePOMappingRepository.create({
    company_id: resolvedCompanyId,
    employee_id: employeeId,
    service_po_id: servicePOId,
    status: 'active',
    created_by: userId,
    updated_by: userId,
  });

  logger.info('Employee-ServicePO mapping created', { mappingId: mapping.id, employeeId, servicePOId, userId });

  return mapping;
};

/**
 * Auto-map a newly-created Employee to every active Centralised Service PO
 * applicable to their company AND owner — called from every backend
 * Employee-creation path (employeeService.create, employeeImportService.
 * importEmployees), inside the SAME transaction as the Employee insert, so a
 * mapping failure rolls back the whole employee creation rather than
 * leaving a partial record.
 *
 * "Applicable" covers two kinds of Centralised PO (see
 * servicePORepository.getActiveCentralisedPOIds()):
 * - Scoped to this SAME company (company_id matches) — original behavior,
 *   unchanged; ownership is already structurally guaranteed by the exact
 *   company_id match itself (Companies only ever belong to one Entity/Admin).
 * - With NO Business Unit at all (company_id NULL) — NOT global. A BU-less
 *   Centralised PO is still owned by whichever Admin/Entity Admin created
 *   it (its own `created_by`), the same "company-less record ownership is
 *   exact created_by-hierarchy equality, never a blanket match" rule every
 *   other company-less resource in this codebase already follows (see
 *   companyAccessControlService.resolveCompanyIdsOwnedByCreator()'s doc
 *   comment). Concretely: it's applicable to this new Employee only if
 *   either (a) the Employee's own `companyId` falls within the SAME Admin/
 *   Entity Admin ownership hierarchy the PO's creator belongs to, or (b) the
 *   Employee ALSO has no Business Unit at all, in which case it's
 *   applicable only when the PO's `created_by` is this SAME creating actor
 *   (`userId`) — exact equality, no cascade, mirroring
 *   resolveActorRecordAccessScope()'s "company_id IS NULL AND created_by =
 *   them" rule.
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
  const candidates = await servicePORepository.getActiveCentralisedPOIds(companyId);
  if (!candidates.length) return;

  const applicable = [];
  for (const po of candidates) {
    if (po.company_id !== null) {
      // Matched this exact company — ownership already guaranteed
      // structurally, same as before this fix.
      applicable.push(po);
      continue;
    }

    // BU-less Centralised PO — must belong to the SAME Admin/Entity Admin
    // ownership hierarchy as this new Employee, not reach every employee
    // on the platform just because it has no Business Unit.
    if (companyId != null) {
      const ownedCompanyIds = await companyAccessControlService.resolveCompanyIdsOwnedByCreator(po.created_by);
      if (ownedCompanyIds.includes(companyId)) applicable.push(po);
    } else if (po.created_by === userId) {
      applicable.push(po);
    }
  }
  if (!applicable.length) return;

  const records = applicable.map(({ id: service_po_id, company_id }) => ({
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
    servicePOIds: applicable.map((p) => p.id),
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
 * @param {number} servicePOId
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getServicePOEmployees = async (servicePOId, authContext, status) => {
  const companyId = await companyAccessControlService.resolveActorCompanyScope(authContext);
  const po = await servicePORepository.findById(servicePOId, companyId, authContext.employeeId);
  if (!po) {
    throw notFoundError(`Service PO #${servicePOId} was not found.`);
  }
  return employeeServicePOMappingRepository.findByServicePO(servicePOId, status);
};

/**
 * Role-name fragments (matched case-insensitively, by substring) that grant
 * an Employee unrestricted Service PO visibility for the "Manage Service PO
 * Mapping" screen — see getServicePOOptionsForEmployee()/
 * saveEmployeeServicePOMappings() below. "Delivery Head" is not its own row
 * in the `roles` table today (it's a per-Service-PO staffing field,
 * service_pos.delivery_head_employee_id) — the business is folding it into
 * the "Service PO Admin" role itself (e.g. renaming it to "Service PO
 * Admin/Delivery Head"), so both fragments are matched independently to
 * keep working regardless of the exact final role name.
 */
const UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS = ['service po admin', 'delivery head'];

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
 * can never assert "this employee is Service PO Admin" itself.
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
 * GET the Employee Service PO Mapping screen's data: every Service PO the
 * Employee is eligible to be mapped to, plus their currently mapped Service
 * PO ids — the frontend renders these as a checkbox list (Test cases 1-5).
 *
 * MOST IMPORTANT BUSINESS RULE: an Employee holding Service PO Admin or
 * Delivery Head sees every eligible Service PO within the caller's
 * authorized company/tenant scope, regardless of their own Business Unit —
 * see servicePORepository.getEligibleForMapping()'s doc comment. Every
 * other role stays restricted to their own Business Unit(s) plus
 * Centralised/BU-less POs, same as the rest of this module.
 *
 * @param {number} employeeId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId } — the CALLER's, not the target Employee's
 * @returns {Promise<{ employee_id: number, unrestricted: boolean, eligible_service_pos: object[], mapped_service_po_ids: number[] }>}
 */
const getServicePOOptionsForEmployee = async (employeeId, authContext) => {
  const companyId = await companyAccessControlService.resolveActorCompanyScope(authContext);
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
 * @param {number} employeeId
 * @param {number[]} servicePOIds - the DESIRED full set of active mappings
 * @param {number} userId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId } — the CALLER's
 * @returns {Promise<EmployeeServicePOMapping[]>} the employee's mappings after save
 */
const saveEmployeeServicePOMappings = async (employeeId, servicePOIds, userId, authContext) => {
  const companyId = await companyAccessControlService.resolveActorCompanyScope(authContext);
  const employee = await resolveMappingTargetEmployee(employeeId, companyId);
  const { unrestricted, businessUnitIds } = await resolveMappingEligibilityInputs(employee);

  const eligiblePOs = await servicePORepository.getEligibleForMapping({
    companyId,
    createdBy: authContext.employeeId,
    unrestricted,
    businessUnitIds,
  });
  const eligibleById = new Map(eligiblePOs.map((po) => [po.id, po]));

  const desiredIds = [...new Set(servicePOIds)];
  const invalidIds = desiredIds.filter((id) => !eligibleById.has(id));
  if (invalidIds.length > 0) {
    const err = new Error(`Service PO(s) ${invalidIds.join(', ')} are not eligible for Employee #${employeeId}.`);
    err.statusCode = 400;
    throw err;
  }

  const existingRows = await employeeServicePOMappingRepository.findByEmployeeAndPOIds(employeeId, [...eligibleById.keys()]);
  const existingByPOId = new Map(existingRows.map((row) => [row.service_po_id, row]));
  const desiredSet = new Set(desiredIds);

  const toCreate = [];
  const toActivateIds = [];
  const toDeactivateIds = [];

  for (const poId of desiredIds) {
    const existing = existingByPOId.get(poId);
    if (!existing) {
      toCreate.push({
        company_id: eligibleById.get(poId).company_id,
        employee_id: employeeId,
        service_po_id: poId,
        status: 'active',
        created_by: userId,
        updated_by: userId,
      });
    } else if (existing.status !== 'active') {
      toActivateIds.push(existing.id);
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

  logger.info('Employee-ServicePO mappings saved', {
    employeeId,
    created: toCreate.length,
    activated: toActivateIds.length,
    deactivated: toDeactivateIds.length,
    userId,
  });

  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId);
};

module.exports = {
  assign,
  autoMapCentralisedServicePOs,
  removeMapping,
  activateMapping,
  deactivateMapping,
  getEmployeeMappings,
  getServicePOEmployees,
  hasUnrestrictedServicePOVisibility,
  getServicePOOptionsForEmployee,
  saveEmployeeServicePOMappings,
};
