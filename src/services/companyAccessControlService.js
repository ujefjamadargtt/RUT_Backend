'use strict';

const { Op } = require('sequelize');
const { Entity, Company } = require('../models');
const entityRepository = require('../repositories/entityRepository');
const companyRepository = require('../repositories/companyRepository');

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
 *   via Entities they created directly (entities.created_by = adminEmployeeId)
 *   OR via Entity Admins they created (entities.entity_admin_employee_id ->
 *   employees.created_by = adminEmployeeId). See
 *   entityRepository.findIdsOwnedByAdmin for the exact query.
 * - Entity Admin (rank 3): every Company under an Entity THEY directly own
 *   (entities.entity_admin_employee_id = their own employeeId).
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
 * The mirror of resolveCompanyIdsOwnedByCreator() above, from the VIEWER's
 * side instead of the creator's: given the Companies a viewer can already
 * see (their own reachable Business Units), resolve every employeeId who
 * may legitimately be the `created_by` of a BU-less (company_id NULL)
 * tenant-wide record — e.g. a Centralised Service PO — that viewer should
 * be allowed to see. That's each of those Companies' own Entity's creating
 * Admin (`entities.created_by`) and its assigned Entity Admin
 * (`entities.entity_admin_employee_id`, if any).
 *
 * This is the tenant boundary for a BU-less Centralised Service PO: one
 * Admin's Centralised PO must never leak into an unrelated Admin's own PO
 * Master list just because both have `company_id: null` — see
 * servicePORepository.companyScope()'s `centralisedOwnerIds` param, which
 * this feeds directly as a `created_by IN (...)` filter.
 *
 * @param {number[]} companyIds - the viewer's own reachable Business Unit ids
 * @returns {Promise<number[]>} possibly empty — means this viewer has no
 *   Company at all to derive a tenant from, so no Centralised PO should
 *   widen into their view either.
 */
async function resolveCentralisedOwnerCreatorIds(companyIds) {
  if (!companyIds || companyIds.length === 0) return [];

  const companies = await Company.findAll({
    where: { id: { [Op.in]: companyIds }, is_deleted: false },
    attributes: ['entity_id'],
  });
  const entityIds = [...new Set(companies.map((c) => c.entity_id).filter((id) => id != null))];
  if (entityIds.length === 0) return [];

  const entities = await Entity.findAll({
    where: { id: { [Op.in]: entityIds }, is_deleted: false },
    attributes: ['created_by', 'entity_admin_employee_id'],
  });

  const creatorIds = new Set();
  entities.forEach((e) => {
    if (e.created_by != null) creatorIds.add(e.created_by);
    if (e.entity_admin_employee_id != null) creatorIds.add(e.entity_admin_employee_id);
  });
  return [...creatorIds];
}

/**
 * Resolve the ADMIN TENANT a viewer's Centralised Service PO visibility is
 * bounded by — `{ companyIds, ownerIds }`, fed straight into
 * servicePORepository's `centralisedTenant` param (and its
 * getActiveCentralisedPOIds() auto-map lookup).
 *
 * Business rule: a Centralised Service PO is NOT globally visible. It
 * belongs to the Admin tenant it was created in, and is visible across
 * every Business Unit of THAT tenant only — never to an unrelated Admin
 * (the leak this exists to close: one Admin's Leaves/On Bench/... POs
 * showing up in a second Admin's PO Master, dropdowns and mapping screens).
 *
 * Tenant = the viewer's own Business Units (`companyIds`), expanded to every
 * Company owned by the Admin(s) who own those BUs (entities.created_by ->
 * resolveOwnedCompanyIds(2, ...)), so a Centralised PO stamped with one BU
 * stays visible to its sibling BUs under the SAME Admin. `ownerIds` are the
 * tenant's Admin/Entity Admin employeeIds (resolveCentralisedOwnerCreatorIds)
 * — the `created_by` anchor for a BU-less (company_id NULL) Centralised PO —
 * plus `actorEmployeeId` itself, so a company-less Admin still sees a BU-less
 * PO they created before owning any Entity.
 *
 * Platform Admin needs no special case: their resolved reach is every
 * Company (resolveReportCompanyScope), so their tenant is every Admin's.
 *
 * @param {number|number[]|null} companyIds - the viewer's resolved Company scope
 * @param {number|null} [actorEmployeeId]
 * @returns {Promise<{ companyIds: number[], ownerIds: number[] }>}
 */
async function resolveCentralisedServicePOTenant(companyIds, actorEmployeeId = null) {
  const ownIds = Array.isArray(companyIds) ? companyIds : (companyIds != null ? [companyIds] : []);
  let tenantCompanyIds = [...new Set(ownIds)];

  if (tenantCompanyIds.length > 0) {
    const companies = await Company.findAll({
      where: { id: { [Op.in]: tenantCompanyIds }, is_deleted: false },
      attributes: ['entity_id'],
    });
    const entityIds = [...new Set(companies.map((c) => c.entity_id).filter((id) => id != null))];
    if (entityIds.length > 0) {
      const entities = await Entity.findAll({
        where: { id: { [Op.in]: entityIds }, is_deleted: false },
        attributes: ['created_by'],
      });
      const adminIds = [...new Set(entities.map((e) => e.created_by).filter((id) => id != null))];
      const ownedSets = await Promise.all(adminIds.map((adminId) => resolveOwnedCompanyIds(2, adminId)));
      tenantCompanyIds = [...new Set([...tenantCompanyIds, ...ownedSets.flat().filter((id) => id != null)])];
    }
  }

  const ownerIds = new Set(await resolveCentralisedOwnerCreatorIds(tenantCompanyIds));
  if (actorEmployeeId != null) ownerIds.add(actorEmployeeId);
  return { companyIds: tenantCompanyIds, ownerIds: [...ownerIds] };
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
 * When a pre-resolved array arrives (from resolveReportCompanyScope via the
 * controller's req.companyIds), a company-less actor (rank 1-3) still needs
 * the `{ ownedCompanyIds, createdBy }` object shape so the repository also
 * surfaces their own BU-less records. BU-scoped actors (rank >= 4) never
 * create BU-less records, so the plain array is correct for them.
 *
 * @param {{ companyId: number|number[]|null, hierarchyRank: number|null, employeeId: number|null, selectedCompanyId?: number|null }} authContext
 * @returns {Promise<number|{ ownedCompanyIds: number[], createdBy: number|null }>}
 *   a plain companyId for a BU-scoped actor, or an object for a
 *   company-less actor — pass straight into the repository's
 *   companyScope()-equivalent, which must handle this object shape (see
 *   clientRepository.js/projectRepository.js's companyScope()).
 */
async function resolveActorRecordAccessScope({ companyId, hierarchyRank, employeeId, selectedCompanyId = null }) {
  // Array arrives when the controller passes req.companyIds (pre-resolved by
  // resolveReportCompanyScope). For a company-less actor (ranks 1-3) we must
  // still wrap it in the { ownedCompanyIds, createdBy } shape so the
  // repository's companyScope() also matches company_id IS NULL rows the
  // actor created — UNLESS a specific BU was explicitly requested via
  // company_id query param or X-Company-Id header, in which case the caller
  // only wants that BU's records and BU-less records are correctly excluded.
  // BU-scoped actors (rank >= 4) never produce BU-less rows, so the plain
  // array is always correct for them.
  if (Array.isArray(companyId)) {
    const isCompanyLess = Number.isInteger(hierarchyRank) && hierarchyRank <= 3;
    if (isCompanyLess && !selectedCompanyId) {
      return { ownedCompanyIds: companyId, createdBy: employeeId };
    }
    return companyId;
  }

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
 * Resolve the FULL array of Company ids a caller may view `/reports/*`
 * (and `/management-reports/*`, excluding bu-performance-scorecard, which
 * has its own separate req.entityIds-based mechanism) data for — the "no
 * X-Company-Id -> role reach, not nothing" contract, mirroring
 * resolveActorCompanyScopeForSelectedBU()'s pattern but (a) always returns
 * an ARRAY (a one-element array for a single-BU actor too, so every report
 * repository can use one `IN (:companyIds)` code path regardless of actor
 * type) and (b) also covers Platform Admin (rank 1), which
 * resolveOwnedCompanyIds()/resolveActorCompanyScopeForSelectedBU()
 * deliberately do not (Platform Admin sits above Entities, not under one —
 * "every BU" for Platform Admin means every non-deleted Company on the
 * whole platform, not an owned-Entity subset).
 *
 * Callers of this function must NOT run resolveCompany.js first — that
 * middleware 400s a BU-scoped actor mapped to more than one Business Unit
 * who omits X-Company-Id, which is exactly the case this function exists to
 * support (see resolveReportCompanyScope.js's own doc comment). Use
 * authenticateIdentity instead, so `req.companyId` is never set and
 * `req.employeeBusinessUnits` (the actor's own active BU-mapping rows) is
 * passed in here directly.
 *
 * `requestedCompanyId` may come from either the `X-Company-Id` header or a
 * `company_id` query param (the caller resolves precedence between the two
 * — reports.routes.js's middleware passes the query param first, falling
 * back to the header, per the /reports/* convention). Same entitlement rule
 * either way: must be one of the actor's reachable ids, or reject 403.
 *
 * - BU-scoped actor (rank >= 4, e.g. BU Head/BU Admin and below): every
 *   Business Unit in `authContext.employeeBusinessUnits` — 0 mapped BUs is
 *   a 403 (NO_BUSINESS_UNIT), matching resolveCompany.js's own pre-existing
 *   behavior for that case. `requestedCompanyId` narrows to that one BU if
 *   it's one of theirs, otherwise 403 — omitting it aggregates across every
 *   BU they're mapped to, never just one and never every BU on the platform.
 * - Platform Admin (rank 1): every non-deleted Company in the system.
 * - Admin (rank 2) / Entity Admin (rank 3): every Company under their own
 *   owned Entities (resolveOwnedCompanyIds) — possibly empty (owns nothing
 *   yet), never "every Company."
 *
 * @param {{ hierarchyRank: number|null, employeeId: number|null, employeeBusinessUnits: Array<{id: number}> }} authContext
 * @param {number|null} requestedCompanyId - parsed X-Company-Id header or company_id query param, if any
 * @returns {Promise<number[]>}
 * @throws {Error} 403 if requestedCompanyId isn't in the actor's reachable set,
 *   or 403 NO_BUSINESS_UNIT if a BU-scoped actor has no active BU mapping at all
 */
async function resolveReportCompanyScope(authContext, requestedCompanyId) {
  const { hierarchyRank, employeeId, employeeBusinessUnits } = authContext;

  let reachableCompanyIds;
  if (hierarchyRank === 1) {
    const companies = await Company.findAll({ where: { is_deleted: false }, attributes: ['id'] });
    reachableCompanyIds = companies.map((c) => c.id);
  } else if (hierarchyRank === 2 || hierarchyRank === 3) {
    reachableCompanyIds = (await resolveOwnedCompanyIds(hierarchyRank, employeeId)) || [];
  } else {
    const businessUnits = employeeBusinessUnits || [];
    if (businessUnits.length === 0) {
      const err = new Error('Access denied: no Business Unit is assigned to your account.');
      err.statusCode = 403;
      err.code = 'NO_BUSINESS_UNIT';
      throw err;
    }
    reachableCompanyIds = businessUnits.map((bu) => bu.id);
  }

  // BU Hierarchy / Sub-BU support — an actor mapped/owning a Parent BU
  // reaches its Sub-BUs too (Platform Admin's "every Company" and Admin/
  // Entity Admin's owned-via-entity_id set already include Sub-BUs
  // naturally, since a Sub-BU shares its parent's entity_id; this only
  // changes the BU-scoped-actor branch above, e.g. a BU Admin mapped
  // directly to "Technology" — with no Sub-BUs configured this is a no-op).
  reachableCompanyIds = await expandBusinessUnitIdsWithDescendants(reachableCompanyIds);

  if (requestedCompanyId == null) {
    return reachableCompanyIds;
  }

  if (!reachableCompanyIds.includes(requestedCompanyId)) {
    const err = new Error('Access denied: the selected Business Unit is not assigned to your account.');
    err.statusCode = 403;
    err.code = 'BU_NOT_MAPPED';
    throw err;
  }

  // The requested single BU may itself be a Parent — return it AND its
  // Sub-BUs (still a subset of reachableCompanyIds, already expanded above).
  const expandedRequested = await expandBusinessUnitIdsWithDescendants([requestedCompanyId]);
  return expandedRequested.filter((id) => reachableCompanyIds.includes(id));
}

/**
 * Resolve an actor's FULL reachable Company scope, deliberately IGNORING any
 * X-Company-Id header / company_id query param — for a single-record-by-ID
 * lookup (GET /clients/:id, /projects/:id, /service-pos/:id), never for a
 * list/dropdown read.
 *
 * Bug this exists to fix: client.routes.js/project.routes.js/
 * servicePO.routes.js's GET /:id routes run the same authenticateReadMultiBU
 * chain as their own GET / (list) sibling, so req.companyIds arrives already
 * narrowed by resolveReportCompanyScope() to a SINGLE Business Unit whenever
 * the Global BU selector (X-Company-Id) happens to be set — which, in
 * practice, is on nearly every request once a multi-BU actor has selected
 * one. That narrowing is the correct, deliberately tested behavior for a
 * LIST view (see servicePOService.getAll.buScope.test.js: "a company-less
 * Admin with a Business Unit SELECTED... narrows to just that ONE BU — the
 * bug fix"), but a direct single-record lookup by id has no "list" to filter
 * — a Client/Project/Service PO the actor has genuine access to (via ANY one
 * of their own mapped/owned Business Units) must resolve successfully
 * regardless of which OTHER Business Unit happens to be currently active
 * elsewhere in their session. Concretely: a BU Admin mapped to BUs 10 and 20,
 * currently active on BU 10, must still be able to open/reference a Client
 * that lives in BU 20 — same principle as resolveCreateCompanyIdForActor's
 * Client-BU-derivation fix on the create side.
 *
 * Thin wrapper around resolveReportCompanyScope() with requestedCompanyId
 * hard-coded to null, so it always returns the unnarrowed reachableCompanyIds
 * branch (every Business Unit this actor can reach) — same ranking rules
 * (Platform Admin -> every Company; Admin/Entity Admin -> owned Companies;
 * BU-scoped rank >= 4 -> every mapped Business Unit), reused rather than
 * duplicated.
 *
 * @param {{ hierarchyRank: number|null, employeeId: number|null, employeeBusinessUnits: Array<{id: number}> }} authContext
 * @returns {Promise<number[]>}
 * @throws {Error} 403 NO_BUSINESS_UNIT if a BU-scoped actor has no active BU mapping at all
 */
async function resolveActorFullReach(authContext) {
  return resolveReportCompanyScope(authContext, null);
}

/**
 * Narrows an already-resolved companyIds[] (BU/role reach, e.g. from
 * resolveReportCompanyScope) down to just the Companies that also belong to
 * one (or, now, any) of a set of Entities — backs the Reports/List-Master
 * modules' optional `entityId`/`entityIds` query param(s), meant to further
 * restrict the caller's existing BU scope, never to replace or widen it.
 *
 * Returns companyIds unchanged when entityId is null/undefined/an empty
 * array. An entityId outside the caller's own reach isn't an error — the
 * intersection simply yields [], same "no data" convention
 * managementReportService's getBUPerformanceScorecard already uses for an
 * empty entity/company set.
 *
 * @param {number[]} companyIds - the caller's already-authorized BU reach
 * @param {number|number[]|null} [entityId] - a single Entity id (legacy
 *   callers) or an array of Entity ids (new entityIds multi-select filter)
 * @returns {Promise<number[]>}
 */
async function intersectCompanyIdsWithEntity(companyIds, entityId) {
  if (entityId == null) return companyIds;
  const entityIds = Array.isArray(entityId) ? entityId : [entityId];
  if (entityIds.length === 0) return companyIds;

  const companies = await Company.findAll({
    where: { entity_id: { [Op.in]: entityIds }, is_deleted: false },
    attributes: ['id'],
  });
  const entityCompanyIds = new Set(companies.map((c) => c.id));

  return (companyIds || []).filter((id) => entityCompanyIds.has(id));
}

/**
 * Narrow an already-resolved reach array (e.g. companyIds from
 * resolveReportCompanyScope) down to just the ids also present in a
 * client-supplied requestedIds array — the `businessUnitIds` multi-select
 * filter's own intersection step. Unlike intersectCompanyIdsWithEntity(),
 * this needs no DB lookup: `reachIds` already IS the caller's authorized
 * Business Unit id set, so narrowing by a client-supplied subset is a plain
 * array intersection.
 *
 * `requestedIds` absent/empty means "no filter" (matches the spec's
 * "absent/empty = same as today" rule) — returns `reachIds` unchanged, NOT
 * "match nothing". An id in `requestedIds` outside `reachIds` is silently
 * dropped, never an error and never widens the result beyond `reachIds`.
 *
 * @param {number[]} reachIds - the caller's already-authorized id reach
 * @param {number[]|undefined|null} requestedIds - client-supplied subset filter
 * @returns {number[]}
 */
function intersectIds(reachIds, requestedIds) {
  if (!requestedIds || requestedIds.length === 0) return reachIds;
  const requested = new Set(requestedIds);
  return (reachIds || []).filter((id) => requested.has(id));
}

/**
 * BU Hierarchy / Sub-BU support — expand a Business Unit id set to also
 * include every immediate Sub-BU of any Parent BU present in it (depth-1
 * only, matching the hierarchy's own 2-level cap — a Sub-BU never has
 * children of its own, so this never needs to recurse). A leaf id (no
 * Sub-BUs, or already a Sub-BU) expands to itself unchanged.
 *
 * The single chokepoint every BU-hierarchy-aware filter funnels through —
 * see resolveReportCompanyScope() below (an actor's own reach) and
 * intersectIdsWithBuHierarchy() (a client-supplied businessUnitIds filter).
 * Callers pass the EXPANDED set straight into a `company_id IN (...)` SQL
 * filter — no dataset is loaded into JS to do this.
 *
 * @param {number[]} ids
 * @returns {Promise<number[]>}
 */
async function expandBusinessUnitIdsWithDescendants(ids) {
  if (!ids || ids.length === 0) return ids || [];
  const childIds = await companyRepository.findChildIds(ids);
  if (childIds.length === 0) return ids;
  return [...new Set([...ids, ...childIds])];
}

/**
 * BU Hierarchy / Sub-BU support — expand a Business Unit id set to the FULL
 * Parent + Sub-BU "family" of each id: a Sub-BU expands to itself + its
 * Parent + every sibling Sub-BU; a Parent BU expands to itself + every one
 * of its Sub-BUs (same direction as expandBusinessUnitIdsWithDescendants()).
 * A childless, parent-less BU expands to itself only.
 *
 * Used wherever "a foothold anywhere in a family" should grant reach to the
 * WHOLE family — e.g. companyService.getAllForEmployee()'s "Business Unit /
 * Sub Business Unit" dropdown (a BU Admin mapped to only one Sub-BU, e.g.
 * "DAS", must still SEE its sibling Sub-BUs, e.g. "IBM") and
 * resolveCreateCompanyIdForActor() below (that same BU Admin must then also
 * be able to actually CREATE a Client/Project/Service PO under "IBM" — the
 * dropdown showing an option the submit then rejects would be worse than
 * not showing it at all).
 *
 * @param {number[]} ids
 * @returns {Promise<number[]>}
 */
async function expandBusinessUnitIdsToFamily(ids) {
  if (!ids || ids.length === 0) return ids || [];
  const rows = await Company.findAll({
    where: { id: { [Op.in]: ids }, is_deleted: false },
    attributes: ['id', 'parent_business_unit_id'],
  });
  const rootIds = new Set();
  rows.forEach((row) => {
    rootIds.add(row.parent_business_unit_id != null ? row.parent_business_unit_id : row.id);
  });
  if (rootIds.size === 0) return ids;
  const familyMembers = await companyRepository.findFamilyMembers([...rootIds]);
  return [...new Set([...ids, ...familyMembers.map((c) => c.id)])];
}

/**
 * BU Hierarchy / Sub-BU support — whether two Business Unit ids are "the
 * same tenant" for CROSS-REFERENCE purposes: creating a record under
 * Business Unit A that must reference another record (Client, Project, ...)
 * already owned by Business Unit B. True when:
 *   - they're literally the same id, OR
 *   - B is A's own Parent BU (a Sub-BU may reference its Parent's shared
 *     masters — e.g. a Client created under the Parent before any Sub-BU
 *     existed), OR
 *   - A is B's own Parent BU (creating AS the Parent may reference a
 *     Sub-BU's own record — the mirror direction, same "parent reach
 *     includes children" rule every BU filter already follows).
 * Depth-1 only, matching the hierarchy's 2-level cap — no recursion needed.
 * Does NOT handle "record has no Business Unit at all" (company_id null) —
 * that's each caller's own separate, pre-existing `=== null` check.
 *
 * @param {number} companyIdA
 * @param {number} companyIdB
 * @returns {Promise<boolean>}
 */
async function areSameOrRelatedBusinessUnits(companyIdA, companyIdB) {
  if (companyIdA == null || companyIdB == null) return false;
  if (companyIdA === companyIdB) return true;

  const [a, b] = await Promise.all([
    Company.findOne({ where: { id: companyIdA, is_deleted: false }, attributes: ['id', 'parent_business_unit_id'] }),
    Company.findOne({ where: { id: companyIdB, is_deleted: false }, attributes: ['id', 'parent_business_unit_id'] }),
  ]);
  if (!a || !b) return false;

  return a.parent_business_unit_id === b.id || b.parent_business_unit_id === a.id;
}

/**
 * Same contract as intersectIds() above, but hierarchy-aware: a
 * client-supplied `requestedIds` entry that names a Parent BU also pulls in
 * that Parent's Sub-BUs before intersecting with `reachIds` — "Filter:
 * buIds = [1] where 1 is a parent BU should include its children" (the
 * Reports/List `businessUnitIds` multi-select filter's own hierarchy rule).
 * `requestedIds` absent/empty still means "no filter" (returns `reachIds`
 * unchanged), same as intersectIds().
 *
 * @param {number[]} reachIds - the caller's already-authorized id reach
 * @param {number[]|undefined|null} requestedIds - client-supplied subset filter
 * @returns {Promise<number[]>}
 */
async function intersectIdsWithBuHierarchy(reachIds, requestedIds) {
  if (!requestedIds || requestedIds.length === 0) return reachIds;
  const expandedRequestedIds = await expandBusinessUnitIdsWithDescendants(requestedIds);
  return intersectIds(reachIds, expandedRequestedIds);
}

/**
 * Resolve + validate the single explicit Business Unit id a WRITE/import
 * flow must stamp its rows with (Monthly Costs Excel import) — unlike
 * resolveActorCompanyScopeForSelectedBU()/resolveReportCompanyScope() (which
 * fall back to a role-reach ARRAY when no BU is specified, for read-only
 * multi-BU reports), a write flow that creates/updates real rows needs
 * exactly ONE concrete Business Unit, explicitly confirmed by the caller
 * every time — so this REQUIRES `bodyBusinessUnitId` whenever the caller has
 * any reachable Business Unit at all (400 if missing), and validates it
 * against that caller's own reach (403 if not theirs). Never silently
 * defaults or falls back to "every reachable BU."
 *
 * - BU-scoped actor (`authContext.companyId` already resolved by
 *   resolveCompany.js from X-Company-Id, itself already validated against
 *   that actor's own mapped Business Units): their reach is exactly that one
 *   BU — `bodyBusinessUnitId` must equal it (403 otherwise). The caller is
 *   expected to always send the same id in both places (this is what the
 *   Monthly Cost Import screen does), so this is a consistency check, not a
 *   second independent authorization decision.
 * - Platform Admin (rank 1): every non-deleted Company in the system.
 * - Admin (rank 2) / Entity Admin (rank 3): every Company under their own
 *   owned Entities (resolveOwnedCompanyIds).
 *
 * @param {{ companyId: number|null, hierarchyRank: number|null, employeeId: number|null }} authContext
 * @param {number|null} bodyBusinessUnitId - parsed business_unit_id from the multipart body, if any
 * @returns {Promise<number>}
 * @throws {Error} 403 if the caller has no reachable Business Unit, or bodyBusinessUnitId isn't in their reach; 400 if required and missing
 */
async function resolveImportBusinessUnitId(authContext, bodyBusinessUnitId) {
  let reachableCompanyIds;

  if (authContext.companyId != null) {
    reachableCompanyIds = [authContext.companyId];
  } else if (authContext.hierarchyRank === 1) {
    const companies = await Company.findAll({ where: { is_deleted: false }, attributes: ['id'] });
    reachableCompanyIds = companies.map((c) => c.id);
  } else {
    reachableCompanyIds = (await resolveOwnedCompanyIds(authContext.hierarchyRank, authContext.employeeId)) || [];
  }

  if (reachableCompanyIds.length === 0) {
    const err = new Error('Access denied: no Business Unit is available for cost import.');
    err.statusCode = 403;
    throw err;
  }

  if (bodyBusinessUnitId == null) {
    const err = new Error('business_unit_id is required to import Monthly Costs.');
    err.statusCode = 400;
    throw err;
  }

  if (!reachableCompanyIds.includes(bodyBusinessUnitId)) {
    const err = new Error(`Access denied: Business Unit #${bodyBusinessUnitId} is not one of your own Business Units.`);
    err.statusCode = 403;
    throw err;
  }

  return bodyBusinessUnitId;
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
 * Admin/Project Manager/Delivery Head (or any other non-Admin/Entity-
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

/**
 * Unified BU resolution for CREATE paths — the single place the
 * "multi-BU BU Admin body-company_id override" rule lives.
 *
 * Behaviour by actor type:
 *
 * BU-scoped actor (BU Admin and below — req.companyId is set):
 *   - Body sends a `company_id` that is one of their mapped BUs:
 *     → use the body value (Darshan selects "hfds" from the dropdown,
 *       even though "datai44" is in the X-Company-Id header).
 *   - Body sends a `company_id` NOT in their mapped BUs: → 403.
 *   - Body omits `company_id` (or sends the same as the header BU):
 *     → use req.companyId (the header / single-BU actor default).
 *
 * Company-less actor (Admin/Entity Admin — req.companyId is undefined/null):
 *   - `required=true` (default): bodyCompanyId must be present and must
 *     be one of their owned companies (400 if absent, 403 if not owned).
 *     Delegates to resolveCreateCompanyId.
 *   - `required=false`: bodyCompanyId is optional; absent → NULL (BU-less).
 *     Delegates to resolveOptionalCreateCompanyId.
 *
 * @param {object} req                 - Express request with companyId, hierarchyRank,
 *                                       employeeId, employeeBusinessUnits populated
 * @param {number|null|undefined} bodyCompanyId - company_id from the validated request body
 * @param {object}  [options]
 * @param {boolean} [options.required=true] - whether BU is mandatory for a company-less actor
 * @param {string}  [options.resourceLabel='this record'] - label for 400/403 error messages
 * @returns {Promise<number|null>}
 * @throws {Error} 400 / 403 if the BU is invalid for this actor
 */
async function resolveCreateCompanyIdForActor(req, bodyCompanyId, { required = true, resourceLabel = 'this record' } = {}) {
  if (req.companyId != null) {
    // BU-scoped actor.
    if (bodyCompanyId != null && bodyCompanyId !== req.companyId) {
      // The frontend explicitly chose a BU different from the active header BU.
      // Validate it is within this actor's own mapped Business Units — BU
      // Hierarchy / Sub-BU support: expanded to the WHOLE Parent + Sub-BU
      // family of each mapped id (see expandBusinessUnitIdsToFamily()'s doc
      // comment), so a BU Admin mapped to only one Sub-BU can still create
      // this record under any of its siblings or their shared Parent —
      // matching what companyService.getAllForEmployee()'s dropdown now
      // offers them.
      const rawMappedIds = (req.employeeBusinessUnits || []).map((bu) => bu.id);
      const mappedBuIds = await expandBusinessUnitIdsToFamily(rawMappedIds);
      if (!mappedBuIds.includes(bodyCompanyId)) {
        const err = new Error(`Business Unit #${bodyCompanyId} is not one of your mapped Business Units.`);
        err.statusCode = 403;
        throw err;
      }
      return bodyCompanyId;
    }
    // No body override, or body matches the header BU → header BU wins.
    return req.companyId;
  }

  // Company-less actor (Admin / Entity Admin).
  const authContext = { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
  if (required) {
    return resolveCreateCompanyId(authContext, bodyCompanyId ?? null, resourceLabel);
  }
  return resolveOptionalCreateCompanyId(authContext, bodyCompanyId ?? null);
}

module.exports = {
  resolveOwnedCompanyIds,
  resolveCompanyIdsOwnedByCreator,
  resolveCentralisedOwnerCreatorIds,
  resolveCentralisedServicePOTenant,
  resolveActorCompanyScope,
  resolveActorRecordAccessScope,
  resolveCreateCompanyId,
  resolveOptionalCreateCompanyId,
  resolveCreateCompanyIdForActor,
  resolveSingleCompanyIdForCompanyLessActor,
  resolveActorCompanyScopeForSelectedBU,
  resolveReportCompanyScope,
  resolveActorFullReach,
  intersectCompanyIdsWithEntity,
  intersectIds,
  expandBusinessUnitIdsWithDescendants,
  expandBusinessUnitIdsToFamily,
  intersectIdsWithBuHierarchy,
  areSameOrRelatedBusinessUnits,
  resolveImportBusinessUnitId,
  resolveOwningAdminIdForCompany,
  resolveAdminOwnershipForBusinessUnits,
  resolveAdminScopeForBusinessUnits,
};
