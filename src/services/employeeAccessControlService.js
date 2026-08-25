'use strict';

const { Op } = require('sequelize');
const companyAccessControlService = require('./companyAccessControlService');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const teamMappingRepository = require('../repositories/teamMappingRepository');
const employeeRepository = require('../repositories/employeeRepository');

/**
 * Centralized Employee object-level authorization (fixes the GET
 * /employees/:id IDOR/BOLA finding — an authenticated caller of ANY role
 * could previously read any Employee record in scope purely by guessing/
 * incrementing the ID, because employeeRepository's company_id filter is a
 * no-op for Admin/Entity Admin, who never get req.companyId populated —
 * see resolveCompany.js — and every other role had no per-object check at
 * all beyond "same company").
 *
 * Returns a Sequelize `where` fragment expressing exactly the set of
 * Employees the caller may read, to be merged into the SAME query that
 * already 404s when a row doesn't exist — an out-of-scope Employee and a
 * genuinely nonexistent one produce the identical "not found" response, so
 * this never discloses whether a given ID exists (see employeeService.js's
 * getByIdWithEmail/getAll).
 *
 * Existing role hierarchy only (roles.hierarchy_rank — see
 * src/config/roleHierarchy.js and roleHierarchyService.js); no new RBAC
 * concept is introduced here:
 *   1 Platform Admin  - never reaches business routes (auth.js blocks it).
 *   2 Admin           - scoped to their own sub-hierarchy: their OWN
 *                       Employee Master record (an Admin is also an
 *                       Employee and must appear in Employee Master like
 *                       anyone else), plus Employees they directly created,
 *                       plus every Employee in a Company
 *                       under an Entity they own (transitively, via Entity
 *                       Admins they created) — the same scope
 *                       requireAdmin.js/entityRepository.findIdsOwnedByAdmin()
 *                       already give Admin for Company/Entity Master, so a
 *                       second, unrelated Admin account never sees the
 *                       first Admin's Employees.
 *   3 Entity Admin    - scoped to Companies under Entities they own.
 *   4 BU Admin        - scoped to their own Company.
 *   5 Project Admin   - scoped to their own Company (no Project Admin ->
 *                       Service PO Admin/Employee mapping table exists yet
 *                       to narrow this further — see the doc comment below).
 *   6 Service PO Admin- their own Employee record, plus every Employee
 *                       mapped to a Manager on their team (team_mappings).
 *   7 Manager         - their own Employee record, plus every Employee
 *                       mapped to them (manager_employee_mappings).
 *   8 Employee        - their own Employee record only.
 *   HR (no rank)      - scoped to their own Company.
 *
 * Manager/Service-PO-Admin scope is resolved the same DATA-DRIVEN way
 * resolveEmployeeScope() (timesheetApprovalReportService.js) and
 * assertOwnEmployee() (managerSelfServiceService.js) already do: whoever
 * the mapping tables say is a Manager/Service PO Admin for an Employee gets
 * that access, regardless of their role name/rank — a User's PRIMARY role
 * can be anything and they can still hold a Secondary Manager mapping (a
 * real, already-seen case). This is computed unconditionally for every
 * caller below their own tier, not gated behind a role-name check, so it
 * also naturally covers a caller who holds Manager/Service PO Admin as an
 * ADDITIONAL operational role (see database/migrations/
 * 20260850_add_user_additional_roles.sql) on top of a different primary
 * role — the union-of-roles behavior required for multi-role accounts.
 *
 * KNOWN GAP (documented, not invented around): Project Admin and BU Admin
 * both have a `*.view_mapped_employees` capability seeded in
 * role_capabilities, implying an intended narrower-than-company-wide scope,
 * but no mapping table backing either capability exists in the schema
 * today (only Manager -> Employee and Service PO Admin -> Manager do).
 * Falling back to company-wide for these two tiers is the tightest bound
 * the EXISTING schema supports without inventing a new mapping table; it
 * still closes the reported cross-company/ID-guessing vulnerability. A
 * true fix for the finer-grained restriction needs a real Project
 * Admin/BU Admin employee-mapping table first.
 *
 * @param {object} authContext
 * @param {number} authContext.userId - req.userId
 * @param {number|null} authContext.employeeId - req.employeeId (caller's own linked Employee, if any)
 * @param {number|null} authContext.companyId - req.companyId (undefined/null for Admin/Entity Admin)
 * @param {number|null} authContext.hierarchyRank - req.hierarchyRank (primary role only)
 * @param {string[]} authContext.roleNames - req.userRoles (primary + active additional roles)
 * @returns {Promise<object>} a Sequelize `where` fragment; `{}` means unrestricted
 */
const resolveEmployeeAccessWhere = async ({ userId, employeeId, companyId, hierarchyRank, roleNames = [] }) => {
  const hasRole = (name) => roleNames.some((r) => (r || '').toLowerCase() === name);

  // Admin (rank 2) — scoped to their OWN sub-hierarchy, not the whole
  // platform: reuses entityRepository.findIdsOwnedByAdmin() (the same
  // "Entities this Admin owns, transitively via Entity Admins they
  // created" resolution requireAdmin.js/requireEntityAdminOrAdmin.js
  // already use for Company/Entity Master), so a second, unrelated Admin
  // account never sees the first Admin's Employees. Three components,
  // unioned:
  //   - the Admin's own Employee Master record (an Admin is also an
  //     Employee and must be listed/fetchable like any other, not hidden
  //     because of their Admin role);
  //   - every Employee this Admin directly created (Entity Admins/BU
  //     Admins/BU Heads minted via employeeService.create — these often
  //     have company_id NULL, so they'd be invisible to the company_id-IN
  //     clause below on their own);
  //   - every Employee belonging to a Company under an Entity this Admin
  //     owns (transitively) — the regular business Employees within that
  //     sub-hierarchy.
  if (hierarchyRank === 2) {
    const ownWhere = { [Op.or]: [{ id: employeeId }, { created_by: employeeId }] };
    const companyIds = await companyAccessControlService.resolveOwnedCompanyIds(hierarchyRank, employeeId);
    if (companyIds.length === 0) {
      return ownWhere;
    }
    return { [Op.or]: [ownWhere, await employeeRepository.employeeScope(companyIds)] };
  }

  // Entity Admin (rank 3) — every Company under an Entity they own.
  if (hierarchyRank === 3) {
    const companyIds = await companyAccessControlService.resolveOwnedCompanyIds(hierarchyRank, employeeId);
    if (companyIds.length === 0) return { id: -1 };
    return employeeRepository.employeeScope(companyIds);
  }

  // BU Admin / Project Admin / HR — own Company only. See the KNOWN GAP
  // note above for why Project Admin/BU Admin stop at company-wide.
  // employeeScope() (not a bare company_id filter) because a target
  // Employee created after the Employee-Business-Unit redesign never gets
  // its own company_id populated — see employeeRepository.js's doc comment
  // on employeeScope() — a bare company_id match would 404/hide them.
  if (hierarchyRank === 4 || hierarchyRank === 5 || hasRole('hr')) {
    return companyId ? employeeRepository.employeeScope(companyId) : { id: -1 };
  }

  // Everyone else (Service PO Admin, Manager, Employee, and anyone holding
  // either as an additional role) — individual, data-driven scope: their
  // own Employee record, plus whoever manager_employee_mappings/
  // team_mappings actually say they manage.
  if (!companyId) {
    return { id: -1 };
  }

  const employeeIds = new Set();
  if (employeeId) employeeIds.add(employeeId);

  const [managedDirectly, spaTeam] = await Promise.all([
    managerEmployeeMappingRepository.findByManager(employeeId, companyId),
    teamMappingRepository.findByServicePOAdmin(employeeId, companyId),
  ]);
  managedDirectly.forEach((m) => employeeIds.add(m.employee_id));

  if (spaTeam.length > 0) {
    const managerEmployeeIds = spaTeam.map((t) => t.manager_employee_id);
    const teamMappings = await managerEmployeeMappingRepository.findByManagerEmployeeIds(managerEmployeeIds, companyId);
    teamMappings.forEach((m) => employeeIds.add(m.employee_id));
  }

  if (employeeIds.size === 0) {
    return { id: -1 };
  }

  return { id: { [Op.in]: [...employeeIds] }, ...(await employeeRepository.employeeScope(companyId)) };
};

module.exports = { resolveEmployeeAccessWhere };
