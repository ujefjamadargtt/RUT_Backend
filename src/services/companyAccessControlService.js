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

module.exports = {
  resolveOwnedCompanyIds,
  resolveCompanyIdsOwnedByCreator,
  resolveActorCompanyScope,
  resolveActorRecordAccessScope,
  resolveCreateCompanyId,
  resolveOptionalCreateCompanyId,
  resolveSingleCompanyIdForCompanyLessActor,
};
