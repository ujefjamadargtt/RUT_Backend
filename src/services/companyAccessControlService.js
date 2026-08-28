'use strict';

const { Op } = require('sequelize');
const { Entity, Company } = require('../models');
const entityRepository = require('../repositories/entityRepository');

/**
 * Shared "which Companies may this company-less actor act within" resolver.
 *
 * Admin (rank 2) and Entity Admin (rank 3) have no single `req.companyId`
 * (see resolveCompany.js) — every company-scoped resource (Clients, Service
 * POs, Timesheets, ...) that wants to let them in at all must resolve an
 * explicit list of Company ids instead, scoped to that specific Admin/
 * Entity Admin's OWN sub-hierarchy, never every Company on the platform.
 * Extracted here so every resource applies the SAME scope — the same bug
 * (an unrelated second Admin seeing the first Admin's data) was found
 * independently in employeeAccessControlService.js and clientService.js;
 * this stops it from having to be independently re-fixed a third time.
 *
 * - Admin (rank 2): every Company under an Entity they own, transitively —
 *   via Entity Admins they directly created (entityRepository.
 *   findIdsOwnedByAdmin, the same resolution requireAdmin.js already uses
 *   for Company/Entity Master).
 * - Entity Admin (rank 3): every Company under an Entity THEY directly own
 *   (entities.entity_admin_employee_id = their own id).
 * - Any other rank: not applicable — returns `null` (that actor has their
 *   own single `req.companyId` instead; callers should use that, not this).
 *
 * @param {number|null} hierarchyRank
 * @param {number|null} employeeId
 * @returns {Promise<number[]|null>} array of Company ids (possibly empty —
 *   means "owns nothing yet", not "unrestricted"), or `null` if this rank
 *   doesn't use company-list scoping at all.
 */
async function resolveOwnedCompanyIds(hierarchyRank, employeeId) {
  let entityIds;

  if (hierarchyRank === 2) {
    entityIds = await entityRepository.findIdsOwnedByAdmin(employeeId);
  } else if (hierarchyRank === 3) {
    const entities = await Entity.findAll({
      where: { entity_admin_employee_id: employeeId, is_deleted: false },
      attributes: ['id'],
    });
    entityIds = entities.map((e) => e.id);
  } else {
    return null;
  }

  if (entityIds.length === 0) return [];

  const companies = await Company.findAll({
    where: { entity_id: { [Op.in]: entityIds }, is_deleted: false },
    attributes: ['id'],
  });
  return companies.map((c) => c.id);
}

/**
 * Resolve every Company owned by a specific creator, trying BOTH the Admin
 * (rank 2) and Entity Admin (rank 3) ownership resolutions from
 * resolveOwnedCompanyIds() above — unlike that function, this doesn't need
 * to know the creator's rank ahead of time, since the only thing being
 * asked here is "what does THIS employeeId's own Entity/Company hierarchy
 * look like," not "what should the CURRENT request's authorization allow."
 *
 * Used to scope a BU-less (company_id NULL) record — e.g. a Centralised
 * Service PO — back to whichever Admin/Entity Admin created it, instead of
 * treating "no Business Unit" as "every Business Unit." A BU-less record is
 * NOT global; it's still owned by its creator's own authorized Company
 * hierarchy, the same as every other company-less record in this codebase
 * (see resolveActorRecordAccessScope()'s doc comment above) — this just
 * checks ownership from the creator's side instead of the current actor's.
 *
 * @param {number} creatorEmployeeId
 * @returns {Promise<number[]>}
 */
async function resolveCompanyIdsOwnedByCreator(creatorEmployeeId) {
  const [adminOwnedEntityIds, entityAdminEntities] = await Promise.all([
    entityRepository.findIdsOwnedByAdmin(creatorEmployeeId),
    Entity.findAll({
      where: { entity_admin_employee_id: creatorEmployeeId, is_deleted: false },
      attributes: ['id'],
    }),
  ]);

  const entityIds = [...new Set([...adminOwnedEntityIds, ...entityAdminEntities.map((e) => e.id)])];
  if (entityIds.length === 0) return [];

  const companies = await Company.findAll({
    where: { entity_id: { [Op.in]: entityIds }, is_deleted: false },
    attributes: ['id'],
  });
  return companies.map((c) => c.id);
}

/**
 * Resolve the effective Company scope for any company-scoped resource
 * (Client, ServiceType, ServiceCategory, ServicePO, ...): the actor's own
 * `req.companyId` if they have one, otherwise their RESOLVED list of owned
 * Company ids (possibly empty — never "unrestricted"). Pass the result
 * straight into a repository's `company_id` WHERE fragment — a plain
 * number for a BU-scoped actor (unchanged behavior), or an array for a
 * company-less actor (Admin/Entity Admin), which the repository should
 * turn into `company_id: { [Op.in]: companyIds }` (an empty array
 * correctly matches nothing).
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @returns {Promise<number|number[]>}
 */
async function resolveActorCompanyScope({ companyId, hierarchyRank, employeeId }) {
  if (companyId != null) {
    return companyId;
  }
  const ownedCompanyIds = await resolveOwnedCompanyIds(hierarchyRank, employeeId);
  return ownedCompanyIds || [];
}

/**
 * Same purpose as resolveActorCompanyScope(), but for READS/writes that
 * must also surface the caller's OWN records created with NO Business
 * Unit at all (`company_id: null`) — see resolveOptionalCreateCompanyId()'s
 * doc comment: Client/Project defer BU assignment for a company-less actor
 * (Admin/Entity Admin), so `company_id` legitimately stays NULL until
 * mapped later. Without this, a company-less actor who creates a record
 * with no company assigned can never see/edit/delete it again through the
 * ordinary list/detail endpoints — resolveActorCompanyScope()'s array form
 * turns into `company_id IN (ownedCompanyIds)`, and SQL `IN` never matches
 * NULL, so their own just-created row silently vanishes from their own
 * view (the exact bug this fixes).
 *
 * A BU-scoped actor's plain `companyId` is returned unchanged (identical
 * to resolveActorCompanyScope() — a BU-scoped actor's own records always
 * carry a real company_id, this only matters for a company-less actor).
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @returns {Promise<number|{ ownedCompanyIds: number[], createdBy: number|null }>}
 *   a plain companyId for a BU-scoped actor, or an object for a
 *   company-less actor — pass straight into the repository's
 *   companyScope()-equivalent, which must handle this object shape (see
 *   clientRepository.js/projectRepository.js's companyScope()).
 */
async function resolveActorRecordAccessScope({ companyId, hierarchyRank, employeeId }) {
  if (companyId != null) {
    return companyId;
  }
  const ownedCompanyIds = await resolveOwnedCompanyIds(hierarchyRank, employeeId);
  return { ownedCompanyIds: ownedCompanyIds || [], createdBy: employeeId };
}

/**
 * Resolve which company a new company-scoped record (Client, ServiceType,
 * ServiceCategory, ServicePO, Project, ...) is being created in.
 * - BU-scoped actor (`authContext.companyId` set): ALWAYS wins — any
 *   `company_id` supplied in the body is ignored, so a BU-scoped actor can
 *   never create a record in a company other than their own.
 * - Company-less actor (Admin/Entity Admin — `authContext.companyId` is
 *   `undefined`): must supply `bodyCompanyId`, validated to be one of THIS
 *   actor's own owned Companies (resolveOwnedCompanyIds) — not merely "any
 *   company that exists." Without this membership check, any Admin could
 *   create a record in a completely unrelated Entity's company just by
 *   guessing an id.
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @param {number|null|undefined} bodyCompanyId
 * @param {string} [resourceLabel] - for the error message, e.g. "Client", "Service Type"
 * @returns {Promise<number>}
 * @throws {Error} 400 if neither is present, 403 if the body-supplied company isn't one of the actor's own
 */
async function resolveCreateCompanyId(authContext, bodyCompanyId, resourceLabel = 'this record') {
  if (authContext.companyId != null) {
    return authContext.companyId;
  }

  if (bodyCompanyId == null) {
    const err = new Error(`company_id (Business Unit) is required to create ${resourceLabel}.`);
    err.statusCode = 400;
    throw err;
  }

  const ownedCompanyIds = await resolveOwnedCompanyIds(authContext.hierarchyRank, authContext.employeeId);
  if (!ownedCompanyIds || !ownedCompanyIds.includes(bodyCompanyId)) {
    const err = new Error(`Business Unit #${bodyCompanyId} is not one of your own Business Units.`);
    err.statusCode = 403;
    throw err;
  }

  return bodyCompanyId;
}

/**
 * Same resolution as resolveCreateCompanyId(), but for flows where Business
 * Unit assignment is deliberately deferred to a later step — Employee
 * Import: an Admin/Entity Admin may import Employees with no Business Unit
 * at all (company_id stays NULL at creation, mapped afterward via the
 * ordinary Employee Master edit / Role & BU Mapping screen), the same
 * "optional at create time" treatment employeeService.create() already
 * gives business_unit_ids for a company-less actor. A BU-scoped actor's own
 * `authContext.companyId` still always wins, same as resolveCreateCompanyId()
 * — this only changes the no-`bodyCompanyId` case for a company-less actor
 * from "400 error" to "creates with company_id = NULL".
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @param {number|null|undefined} bodyCompanyId
 * @returns {Promise<number|null>}
 * @throws {Error} 403 if the body-supplied company isn't one of the actor's own
 */
async function resolveOptionalCreateCompanyId(authContext, bodyCompanyId) {
  if (authContext.companyId != null) {
    return authContext.companyId;
  }

  if (bodyCompanyId == null) {
    return null;
  }

  const ownedCompanyIds = await resolveOwnedCompanyIds(authContext.hierarchyRank, authContext.employeeId);
  if (!ownedCompanyIds || !ownedCompanyIds.includes(bodyCompanyId)) {
    const err = new Error(`Business Unit #${bodyCompanyId} is not one of your own Business Units.`);
    err.statusCode = 403;
    throw err;
  }

  return bodyCompanyId;
}

/**
 * Resolve a SINGLE effective companyId for a company-less actor (Admin rank
 * 2 / Entity Admin rank 3) on endpoints that are only meaningful for exactly
 * one Business Unit at a time (Reports, Dashboard analytics, Timesheet Admin
 * CRUD, Cost Budget, Service PO Monthly Budget) — these read `req.companyId`
 * directly and have no concept of an owned-Company-id ARRAY the way
 * Client/Project/ServicePO do. Mirrors resolveCompany.js's own BU-selection
 * contract (0 owned -> reject, 1 owned -> auto-select, >1 owned -> an
 * X-Company-Id header is required and validated) so the UX is identical to
 * what a multi-BU BU Admin already sees, just resolved against OWNED
 * companies instead of employee_business_units membership.
 *
 * @param {number|null} hierarchyRank
 * @param {number|null} employeeId
 * @param {number|null} headerCompanyId - parsed X-Company-Id header, if any
 * @returns {Promise<{ companyId: number }|{ error: { statusCode: number, code: string, message: string } }>}
 */
async function resolveSingleCompanyIdForCompanyLessActor(hierarchyRank, employeeId, headerCompanyId) {
  const ownedCompanyIds = (await resolveOwnedCompanyIds(hierarchyRank, employeeId)) || [];

  if (ownedCompanyIds.length === 0) {
    return {
      error: {
        statusCode: 403,
        code: 'NO_BUSINESS_UNIT',
        message: 'Access denied: no Business Unit is assigned to your account.',
      },
    };
  }

  if (ownedCompanyIds.length === 1) {
    return { companyId: ownedCompanyIds[0] };
  }

  if (headerCompanyId == null) {
    return {
      error: {
        statusCode: 400,
        code: 'COMPANY_HEADER_REQUIRED',
        message: 'Please select a Business Unit (X-Company-Id header) before performing this operation.',
      },
    };
  }

  if (!ownedCompanyIds.includes(headerCompanyId)) {
    return {
      error: {
        statusCode: 403,
        code: 'BU_NOT_MAPPED',
        message: 'Access denied: the selected Business Unit is not assigned to your account.',
      },
    };
  }

  return { companyId: headerCompanyId };
}

/**
 * Same purpose as resolveActorCompanyScope(), but for a BU-DEPENDENT
 * dropdown/list read that should respect an OPTIONALLY selected Global
 * Business Unit (X-Company-Id header) for a company-less actor (Admin/
 * Entity Admin) WITHOUT requiring one. Unlike
 * resolveCompanyContextForCompanyLessActors.js (mandatory header — 400/403
 * when missing/invalid for a multi-BU owner, used by Reports/Dashboard/
 * Timesheet Admin/Cost Budget/Service PO Monthly Budget, all of which read
 * `req.companyId` directly with no array concept), this degrades gracefully
 * to the actor's full owned-Company-id ARRAY when no Business Unit is
 * currently selected — so a resource whose OTHER read/write paths
 * legitimately span every owned Company (e.g. Service PO's own list/detail,
 * and Cost Budget's create/update, which validates a submitted
 * `service_po_id` against the full owned set on purpose — see
 * costBudget.routes.js's doc comment) keeps that existing behavior
 * unchanged by default, while a specific BU-DEPENDENT read (e.g. the Active
 * Service PO dropdown a Cost Budget screen populates) can narrow to
 * exactly the selected BU when the caller's Global BU selector actually
 * sends one.
 *
 * A BU-scoped actor (`authContext.companyId` already set) is returned
 * unchanged — same as resolveActorCompanyScope(). A header naming a
 * Company the actor doesn't own is REJECTED (403), never silently ignored
 * or silently widened back to the full set — same trust rule as every
 * other X-Company-Id validation in this codebase.
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @param {number|null} headerCompanyId - parsed X-Company-Id header, if any
 * @returns {Promise<number|number[]>} plain companyId (BU-scoped actor, or a
 *   company-less actor with a valid selected BU narrows to `[headerCompanyId]`),
 *   or the full owned-Company-id array when no BU is selected
 * @throws {Error} 403 if the header names a Company not in the actor's owned set
 */
async function resolveActorCompanyScopeForSelectedBU(authContext, headerCompanyId) {
  if (authContext.companyId != null) {
    return authContext.companyId;
  }

  const ownedCompanyIds = (await resolveOwnedCompanyIds(authContext.hierarchyRank, authContext.employeeId)) || [];

  if (headerCompanyId == null) {
    return ownedCompanyIds;
  }

  if (!ownedCompanyIds.includes(headerCompanyId)) {
    const err = new Error('Access denied: the selected Business Unit is not assigned to your account.');
    err.statusCode = 403;
    throw err;
  }

  return [headerCompanyId];
}

/**
 * Resolve the Admin (hierarchy_rank 2) employeeId that ultimately owns a
 * given Company (Business Unit) — walks Company -> Entity ->
 * Entity.created_by. Entity Master management is Admin-only (see
 * entityRepository.js's own doc comments), so an Entity's `created_by` is
 * the Admin who created it — the "normal case going forward" per
 * entityRepository.findIdsOwnedByAdmin()'s doc comment, which this
 * mirrors in reverse (Admin -> owned Entities, here Entity -> owning
 * Admin). Does NOT handle the legacy "Entity re-assigned to a different
 * Entity Admin" fallback that function's OR-clause covers — deliberately:
 * that's about which Entities an Admin's FORWARD scope includes, not about
 * finding a stable single owner to resolve scope FROM.
 *
 * @param {number} companyId
 * @returns {Promise<number|null>} the owning Admin's employeeId, or null if unresolvable
 */
async function resolveOwningAdminIdForCompany(companyId) {
  const company = await Company.findOne({
    where: { id: companyId, is_deleted: false },
    attributes: ['id', 'entity_id'],
  });
  if (!company || company.entity_id == null) return null;

  const entity = await Entity.findOne({
    where: { id: company.entity_id, is_deleted: false },
    attributes: ['id', 'created_by'],
  });
  return entity ? entity.created_by : null;
}

/**
 * Resolve BOTH the owning Admin id(s) AND the FULL Company scope for a BU
 * Admin/Service PO Admin/Delivery Head (or any other non-Admin/Entity-
 * Admin actor) — "operating under the Admin's scope," per the Service PO ->
 * Employee Mapping requirement: these roles must see EVERY Company/
 * employee their owning Admin sees, not just the Business Unit(s) they
 * personally happen to be mapped to (a BU Admin managing only 2 of 5 BUs
 * under the same Admin must still see all 5 BUs' worth of Employees here,
 * matching what the Admin themselves would see for their own scope).
 *
 * Exposes `adminIds` (not just the resolved Company scope) because the
 * Admin's own Employee-visibility rule (resolveEmployeeAccessWhere's rank-2
 * branch) is `{ id: adminId } OR { created_by: adminId } OR
 * employeeScope(companyIds)` — an Employee the Admin directly created but
 * hasn't assigned a Business Unit to yet matches NEITHER `id` NOR
 * `employeeScope`, only `created_by`. A caller that only asked for the
 * Company scope (resolveAdminScopeForBusinessUnits below, used for Service
 * PO authorization — a Service PO always carries a real company_id, so this
 * gap never applies there) would silently drop those Employees from an
 * Employee-list query — the actual root cause of a BU Admin/Service PO
 * Admin/Delivery Head seeing FEWER Employees than their owning Admin does
 * for the exact same tenant (confirmed: BU-mapped Employees only account
 * for part of an Admin's total — the rest were created directly by that
 * Admin and never assigned to any Business Unit at all).
 *
 * Resolves the owning Admin from each of the actor's OWN Business Units
 * (resolveOwningAdminIdForCompany above — normally all the same Admin, but
 * unioned in case of legacy data spanning more than one). Falls back to
 * the actor's own Business Unit ids as the Company scope (empty adminIds)
 * if no owning Admin can be resolved at all — defensive, so legacy/edge-
 * case data never locks an actor out of even their own BUs.
 *
 * @param {number[]} ownBusinessUnitIds - the actor's own employee_business_units ids (or their single active companyId, wrapped)
 * @returns {Promise<{ adminIds: number[], companyIds: number[] }>}
 */
async function resolveAdminOwnershipForBusinessUnits(ownBusinessUnitIds) {
  if (!ownBusinessUnitIds || ownBusinessUnitIds.length === 0) {
    return { adminIds: [], companyIds: [] };
  }

  const adminIds = new Set();
  for (const businessUnitId of ownBusinessUnitIds) {
    const adminId = await resolveOwningAdminIdForCompany(businessUnitId);
    if (adminId != null) adminIds.add(adminId);
  }
  if (adminIds.size === 0) {
    return { adminIds: [], companyIds: ownBusinessUnitIds };
  }

  const scopeSets = await Promise.all(
    [...adminIds].map((adminId) => resolveOwnedCompanyIds(2, adminId))
  );
  const companyIds = [...new Set(scopeSets.flat())];
  return {
    adminIds: [...adminIds],
    companyIds: companyIds.length > 0 ? companyIds : ownBusinessUnitIds,
  };
}

/**
 * Same resolution as resolveAdminOwnershipForBusinessUnits() above, but for
 * callers that only need the Company SCOPE (e.g. Service PO authorization
 * — a Service PO always carries a real company_id, so the "created_by, no
 * BU assigned" gap that function's doc comment describes never applies to
 * POs, only to Employees). Kept as a thin wrapper so existing callers don't
 * need to unpack `{ adminIds, companyIds }` when they only ever used the
 * scope array.
 *
 * @param {number[]} ownBusinessUnitIds
 * @returns {Promise<number[]>}
 */
async function resolveAdminScopeForBusinessUnits(ownBusinessUnitIds) {
  const { companyIds } = await resolveAdminOwnershipForBusinessUnits(ownBusinessUnitIds);
  return companyIds;
}

module.exports = {
  resolveOwnedCompanyIds,
  resolveCompanyIdsOwnedByCreator,
  resolveActorCompanyScope,
  resolveActorRecordAccessScope,
  resolveCreateCompanyId,
  resolveOptionalCreateCompanyId,
  resolveSingleCompanyIdForCompanyLessActor,
  resolveActorCompanyScopeForSelectedBU,
  resolveOwningAdminIdForCompany,
  resolveAdminOwnershipForBusinessUnits,
  resolveAdminScopeForBusinessUnits,
};
