'use strict';

const projectRepository = require('../repositories/projectRepository');
const clientRepository = require('../repositories/clientRepository');
const companyAccessControlService = require('./companyAccessControlService');
const { resolveActorCompanyScope, resolveCreateCompanyIdForActor, resolveActorFullReach, intersectCompanyIdsWithEntity, intersectIdsWithBuHierarchy, expandBusinessUnitIdsToFamily } = companyAccessControlService;
const { generateProjectCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { parseIdList } = require('../utils/idListParser');
const logger = require('../utils/logger');

/**
 * Project Service
 * All business logic for the Project Master module. Mirrors
 * clientService.js's shape — Project is a standalone, company-scoped
 * grouping every Service PO must belong to (independent of Client).
 */

/**
 * Retrieve a paginated list of projects with optional filters.
 *
 * @param {object} query - Express req.query (page, limit, status, search, sort_by, sort_order)
 * @returns {Promise<{ data: Project[], meta: object }>}
 */
const getAll = async (query = {}, authContext) => {
  let companyId = await resolveActorCompanyScope(authContext);

  // BU Hierarchy / Sub-BU support — a BU-scoped actor's own single active
  // BU is expanded to its whole Parent + Sub-BU family (see
  // expandBusinessUnitIdsToFamily()'s doc comment), so the Project dropdown
  // used by Service PO creation — and this same Project Master list —
  // surfaces a shared Project that still lives at the Parent level even
  // while working under one specific Sub-BU, matching clientService.getAll()'s
  // identical fix and resolveCreateCompanyIdForActor()'s create-side one.
  if (typeof companyId === 'number') {
    companyId = await expandBusinessUnitIdsToFamily([companyId]);
  }

  // Optional entityIds/businessUnitIds multi-select narrowing on top of the
  // already-resolved BU/role scope — meaningful whenever that scope is an
  // array: a company-less actor's owned-Companies reach, OR (since the
  // family expansion above) a BU-scoped actor's own Parent+Sub-BU family.
  // Never widens access — see intersectCompanyIdsWithEntity()/intersectIds()'s
  // own doc comments.
  if (Array.isArray(companyId)) {
    companyId = await intersectCompanyIdsWithEntity(companyId, parseIdList(query.entityIds));
    companyId = await intersectIdsWithBuHierarchy(companyId, parseIdList(query.businessUnitIds));
  }
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || null,
    status: query.status || null,
    client_id: query.client_id ? parseInt(query.client_id, 10) : null,
    companyId,
    // A company-less Admin/Entity Admin (companyId resolved as an array of
    // owned Company ids) must still see their OWN Project(s) created with
    // no Business Unit assigned yet (company_id NULL) — see
    // projectRepository.companyScope()'s doc comment. No-op for a BU-scoped
    // actor (companyId a plain number there, never an array).
    createdBy: authContext.employeeId,
  };

  const sort = {
    sortBy: query.sort_by || 'project_name',
    sortOrder: query.sort_order || 'ASC',
  };

  const { rows, count } = await projectRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  // Total Service POs per project — one bulk GROUP BY query for the whole
  // page rather than one COUNT per row.
  const poCountByProjectId = await projectRepository.countServicePOsByProjectIds(
    rows.map((row) => row.id),
    companyId
  );
  const data = rows.map((row) => ({
    ...row.get({ plain: true }),
    total_service_pos: poCountByProjectId.get(row.id) || 0,
  }));

  return { data, meta };
};

/**
 * Retrieve a single project by ID.
 *
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<Project>}
 */
const getById = async (id, authContext) => {
  const companyId = await resolveActorCompanyScope(authContext);
  const project = await projectRepository.findById(id, companyId, authContext.employeeId);

  if (!project) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }

  const total_service_pos = await projectRepository.countServicePOsByProject(id, companyId);

  return { ...project.get({ plain: true }), total_service_pos };
};

/**
 * Create a new project. Auto-generates a project_code using the PRJ
 * prefix if one is not supplied.
 *
 * Client is mandatory (see Joi's createProjectSchema) — validated here
 * for existence, active status, and same-company membership, the same
 * pattern every other cross-entity FK in this codebase follows.
 *
 * Business Unit resolution for a company-less actor (Admin/Entity Admin):
 *   1. `company_id` in the request body (explicit picker on the frontend),
 *      validated to be one of the actor's own owned Companies.
 *   2. Neither present → BU assignment is deferred, same as Client — the
 *      Project is created with `company_id` NULL and can be mapped to a
 *      Business Unit later. This is what lets a company-less actor create a
 *      Project under a BU-less Client (the two must be able to start out in
 *      the same "no BU yet" state, or a BU-less Client would be permanently
 *      unable to have any Project at all).
 * A BU-scoped actor's own `req.companyId` always wins — body is ignored for
 * them entirely (their own mapped Business Units may still override via
 * resolveCreateCompanyIdForActor's body-company_id branch, same as Client).
 *
 * @param {object} data   - Validated body (client_id, project_name, project_description, status, [project_code], [company_id])
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<Project>}
 */
const create = async (data, userId, req) => {
  const { company_id: bodyCompanyId, ...fields } = data;

  // For a BU-scoped actor (BU Admin/Project Manager) who doesn't explicitly
  // override company_id, the Project's own Business Unit should follow
  // whichever BU the selected Client already belongs to, rather than
  // silently defaulting to whatever BU happens to be active in the
  // X-Company-Id header — otherwise a multi-BU actor picking a Client under
  // one of their OTHER mapped BUs gets a spurious "Client not found" purely
  // because their active header BU doesn't happen to match it (same root
  // cause/fix as servicePOService.create()). resolveCreateCompanyIdForActor
  // still fully validates this derived BU is one of the actor's own mapped
  // Business Units below — this only changes WHERE the BU signal comes from.
  // Scoped to BU-scoped actors only: a company-less actor (Admin/Entity
  // Admin) keeps its existing "either an owned Company or BU-less" client
  // resolution below untouched.
  const preFetchedClient = (req.companyId != null && bodyCompanyId == null)
    ? await clientRepository.findByIdUnscoped(fields.client_id)
    : null;
  const effectiveBodyCompanyId = bodyCompanyId != null
    ? bodyCompanyId
    : (preFetchedClient && preFetchedClient.company_id != null ? preFetchedClient.company_id : null);

  const companyId = await resolveCreateCompanyIdForActor(req, effectiveBodyCompanyId, { required: false, resourceLabel: 'a Project' });
  const authContext = { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
  data = fields;

  // Client lookup: when this Project is being created WITH a Business
  // Unit, `companyId` is that one concrete company and the referenced
  // Client must belong to it — OR, BU Hierarchy / Sub-BU support, to a
  // Business Unit one hop apart in the hierarchy from it (a Sub-BU
  // referencing its Parent's shared Client, or vice versa; see
  // companyAccessControlService.areSameOrRelatedBusinessUnits()), same as
  // servicePOService.create()'s identical fix. Fetch unscoped and verify
  // manually rather than clientRepository.findById()'s exact-match
  // companyScope(), since that can't express the hierarchy relationship.
  // When a company-less actor creates a Project with NO Business Unit, the
  // Client they picked can either belong to one of that actor's OWN owned
  // Companies, or itself have no Business Unit — companyScope()'s array
  // form can't express "IN (...) OR IS NULL" (SQL IN never matches NULL)
  // either, so the same fetch-unscoped-then-verify pattern applies there.
  let client;
  if (companyId != null) {
    const candidate = preFetchedClient || await clientRepository.findByIdUnscoped(data.client_id);
    const clientInScope = !!candidate && (
      candidate.company_id === companyId ||
      await companyAccessControlService.areSameOrRelatedBusinessUnits(candidate.company_id, companyId)
    );
    client = clientInScope ? candidate : null;
  } else {
    const ownedCompanyIds = await resolveActorCompanyScope(authContext);
    const candidate = await clientRepository.findByIdUnscoped(data.client_id);
    const clientInScope =
      candidate && (candidate.company_id === null || ownedCompanyIds.includes(candidate.company_id));
    client = clientInScope ? candidate : null;
  }
  if (!client) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }
  if (client.status !== 'active') {
    const err = new Error('Cannot create a Project for an inactive client.');
    err.statusCode = 400;
    throw err;
  }

  // Reject a duplicate project_name up front (case-insensitive, scoped to
  // this company) — project_code uniqueness alone doesn't stop the same
  // Project from being entered twice under two different codes.
  const duplicateName = await projectRepository.findByName(data.project_name, companyId);
  if (duplicateName) {
    const err = new Error(`Project "${data.project_name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  let project_code = data.project_code || generateProjectCode();
  let attempts = 0;
  while (await projectRepository.findByCode(project_code, companyId)) {
    if (data.project_code) {
      const err = new Error(`Project code "${data.project_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
    if (attempts >= 5) {
      const err = new Error('Failed to generate a unique project code. Please try again.');
      err.statusCode = 500;
      throw err;
    }
    project_code = generateProjectCode();
    attempts++;
  }

  const payload = {
    ...data,
    project_code,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const project = await projectRepository.create(payload);

  await createAuditLog(
    userId,
    'CREATE',
    'projects',
    project.id,
    null,
    { project_code: project.project_code, project_name: project.project_name },
    getIpAddress(req)
  );

  logger.info('Project created', { projectId: project.id, project_code: project.project_code, userId });

  return project;
};

/**
 * Update an existing project.
 *
 * Looks the Project up via resolveActorFullReach() (NOT
 * resolveActorCompanyScope(req.companyId)) — same fix as clientService.
 * update(): req.companyId is only the caller's single CURRENTLY ACTIVE
 * Business Unit, but GET /projects/GET /projects/:id (which the Edit form's
 * list is populated from) already span every Business Unit the caller
 * manages. Scoping the existence check to just the active BU meant opening
 * any Project from a DIFFERENT BU than whichever one happened to be
 * currently selected 404'd on Save — "Project not found" — even for a
 * no-op rename, before any field-level logic ever ran. The exact same class
 * of bug just fixed for Client, and it surfaces together with it: moving a
 * Client to a different BU (clientService.update()) leaves any of that
 * Client's own Projects still pointing at the OLD BU, so re-opening one of
 * THOSE Projects to update it next hits this identical gap.
 *
 * Business Unit REASSIGNMENT: an optional `company_id` in the body moves the
 * Project to a different Business Unit — same authorization rule
 * clientService.update() uses (never re-validated against req.companyId,
 * the currently-active BU, since a multi-BU actor must be able to move a
 * Project between ANY of their own mapped/owned BUs):
 *   - BU-scoped actor (req.companyId set): the target company_id must be one
 *     of req.employeeBusinessUnits, else 403.
 *   - Company-less actor (Admin/Entity Admin): the target company_id must be
 *     one of their own owned Companies (resolveOwnedCompanyIds), else 403.
 * Omitted (or equal to the Project's current company_id) -> no BU change.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<Project>}
 */
const update = async (id, data, userId, req) => {
  const scope = await resolveActorFullReach({
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    employeeBusinessUnits: req.employeeBusinessUnits,
  });

  const existing = await projectRepository.findById(id, scope, req.employeeId);
  if (!existing) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }

  const { company_id: bodyCompanyId, ...projectFields } = data;

  let companyId = existing.company_id;
  if (bodyCompanyId != null && bodyCompanyId !== existing.company_id) {
    if (req.companyId != null) {
      // BU Hierarchy / Sub-BU support — expanded to the actor's whole
      // Parent + Sub-BU family (see expandBusinessUnitIdsToFamily()'s doc
      // comment), same as resolveCreateCompanyIdForActor()/create() above:
      // a BU Admin mapped to only one Sub-BU may still reassign a Project
      // to any of its siblings, not just their own literal mapping.
      const rawMappedIds = (req.employeeBusinessUnits || []).map((bu) => bu.id);
      const mappedBuIds = await expandBusinessUnitIdsToFamily(rawMappedIds);
      if (!mappedBuIds.includes(bodyCompanyId)) {
        const err = new Error(`Business Unit #${bodyCompanyId} is not one of your mapped Business Units.`);
        err.statusCode = 403;
        throw err;
      }
    } else {
      const ownedCompanyIds = (await companyAccessControlService.resolveOwnedCompanyIds(req.hierarchyRank, req.employeeId)) || [];
      if (!ownedCompanyIds.includes(bodyCompanyId)) {
        const err = new Error(`Business Unit #${bodyCompanyId} is not one of your own Business Units.`);
        err.statusCode = 403;
        throw err;
      }
    }
    companyId = bodyCompanyId;
  }

  // If client_id is being changed, validate the new client — same
  // conditional-on-change pattern servicePOService.update() uses. Checked
  // against the DESTINATION company (the new BU when one is being
  // assigned), consistent with the uniqueness checks below. BU Hierarchy /
  // Sub-BU support: fetched unscoped and checked via
  // areSameOrRelatedBusinessUnits() (same fix as create() above), not
  // clientRepository.findById()'s exact-match companyScope(), so a Sub-BU
  // can still reassign to its Parent's shared Client (and vice versa).
  if (data.client_id && data.client_id !== existing.client_id) {
    const client = await clientRepository.findByIdUnscoped(data.client_id);
    const clientInScope = !!client && (
      client.company_id === companyId ||
      await companyAccessControlService.areSameOrRelatedBusinessUnits(client.company_id, companyId)
    );
    if (!clientInScope) {
      const err = new Error('Client not found.');
      err.statusCode = 404;
      throw err;
    }
    if (client.status !== 'active') {
      const err = new Error('Cannot reassign a Project to an inactive client.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (data.project_code && data.project_code !== existing.project_code) {
    const conflict = await projectRepository.findByCode(data.project_code, companyId);
    if (conflict) {
      const err = new Error(`Project code "${data.project_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Same rule as create() — a renamed (or BU-moved) project can't collide
  // with another project's name in the same DESTINATION company.
  if (data.project_name && data.project_name.trim().toLowerCase() !== existing.project_name.toLowerCase()) {
    const nameConflict = await projectRepository.findByName(data.project_name, companyId);
    if (nameConflict && nameConflict.id !== id) {
      const err = new Error(`Project "${data.project_name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const oldValues = {
    client_id: existing.client_id,
    project_code: existing.project_code,
    project_name: existing.project_name,
    project_description: existing.project_description,
    status: existing.status,
    company_id: existing.company_id,
  };

  const payload = { ...projectFields, company_id: companyId, updated_by: userId };
  const updated = await projectRepository.update(id, payload, existing.company_id);

  await createAuditLog(
    userId,
    'UPDATE',
    'projects',
    id,
    oldValues,
    payload,
    getIpAddress(req)
  );

  logger.info('Project updated', { projectId: id, userId });

  return updated;
};

/**
 * Soft-delete a project. Refuses to delete if any Service PO still
 * references it.
 *
 * Looks the Project up via resolveActorFullReach() — same reasoning as
 * update()'s own doc comment above.
 *
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deleteProject = async (id, userId, req) => {
  const scope = await resolveActorFullReach({
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    employeeBusinessUnits: req.employeeBusinessUnits,
  });

  const existing = await projectRepository.findById(id, scope, req.employeeId);
  if (!existing) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }

  if (existing.status === 'inactive') {
    const err = new Error('Project is already inactive.');
    err.statusCode = 400;
    throw err;
  }

  const poCount = await projectRepository.countServicePOsByProject(id, existing.company_id);
  if (poCount > 0) {
    const err = new Error(
      `Cannot delete project "${existing.project_name}". ` +
      `${poCount} Service PO(s) are linked to this project. ` +
      'Reassign them to a different project before deleting.'
    );
    err.statusCode = 409;
    throw err;
  }

  await projectRepository.softDelete(id, userId, existing.company_id);

  await createAuditLog(
    userId,
    'DELETE',
    'projects',
    id,
    { status: 'active' },
    { status: 'inactive' },
    getIpAddress(req)
  );

  logger.info('Project soft-deleted', { projectId: id, userId });
};

/**
 * Return a lightweight list of all active projects — for form dropdowns.
 *
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<Project[]>}
 */
const getActiveProjects = async (authContext) => {
  const companyId = await resolveActorCompanyScope(authContext);
  return projectRepository.getActiveProjects(companyId, authContext.employeeId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  deleteProject,
  getActiveProjects,
};
