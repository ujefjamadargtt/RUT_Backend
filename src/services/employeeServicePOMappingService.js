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
 * Uses resolveEmployeeMappingScope() (below) — NOT resolveActorCompanyScope()
 * — for this PO-access check: a BU Admin/Service PO Admin/Delivery Head
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
 */
const SERVICE_PO_MAPPING_AUTHORITY_ROLE_FRAGMENTS = ['bu admin', 'service po admin', 'delivery head'];

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
 * For a BU Admin/Service PO Admin/Delivery Head, "same Admin/company
 * scope" means the ENTIRE tenant their owning Admin manages — the same
 * full scope that Admin themselves would see — NOT merely the Business
 * Unit(s) this specific actor personally happens to be mapped to (a BU
 * Admin managing only 2 of 5 BUs under the same Admin must still see every
 * Employee across all 5, matching the "BU Admin/Service PO Admin/Delivery
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
 * For every other rank (BU Admin, Service PO Admin, Delivery Head, and
 * anyone else): resolveEmployeeAccessWhere() would instead apply its
 * narrow "my own team" scope — bypassed here in favor of the caller's
 * OWNING Admin's full scope (companyAccessControlService.
 * resolveAdminOwnershipForBusinessUnits()) — but that scope MUST be built
 * as the SAME kind of accessWhere fragment the Admin themselves gets, not
 * a bare companyId/employeeScope() call: an Employee the owning Admin
 * directly created but never assigned a Business Unit to (confirmed root
 * cause of a BU Admin/Service PO Admin/Delivery Head seeing fewer
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
  // Service PO Admin/Delivery Head must be able to open ANY Service PO
  // within their own managed set without X-Company-Id having been set to
  // that exact BU first.
  const tenantScope = await resolveEmployeeMappingScope(authContext);
  const po = await servicePORepository.findById(servicePOId, tenantScope, authContext.employeeId);
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
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * GET the Entity → Business Unit filter dropdown options for the Service PO
 * -> Map Employees screen (EntityBuFilterBar / `business_unit_id` on
 * getEmployeeOptionsForServicePO() above).
 *
 * Deliberately NOT backed by GET /entities or GET /companies: both 403 a BU
 * Admin/Service PO Admin/Delivery Head (Entity Admin/Admin only), and even
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
  removeMapping,
  activateMapping,
  deactivateMapping,
  getEmployeeMappings,
  getServicePOEmployees,
  hasUnrestrictedServicePOVisibility,
  getServicePOOptionsForEmployee,
  saveEmployeeServicePOMappings,
  hasServicePOMappingAuthority,
  getEmployeeOptionsForServicePO,
  getEmployeeMappingFilterOptions,
  resolveEmployeeMappingScope,
  resolveEmployeeMappingAccessScope,
};
