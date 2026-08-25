'use strict';

const { Op, fn, col } = require('sequelize');
const { Project, ServicePO, Client } = require('../models');
const logger = require('../utils/logger');

/**
 * Project Repository
 * All direct database interaction for the projects table lives here.
 * No business logic — that belongs in projectService.js. Mirrors
 * clientRepository.js's shape (Project is the closest analog to Client:
 * a standalone, company-scoped master entity a Service PO belongs to).
 */

/**
 * Builds a `company_id` WHERE fragment. Accepts a single number (BU-scoped
 * actor's own `req.companyId`), an array (a company-less actor's resolved
 * list of owned Company ids — see
 * companyAccessControlService.resolveActorCompanyScope; empty array
 * correctly matches nothing), or `null` (a Project created with no
 * Business Unit — see projectService.js's resolveOptionalCreateCompanyId()
 * usage — matches only OTHER BU-less Projects, e.g. for the create-time
 * duplicate-name/code check). Same pattern as clientRepository.js.
 *
 * `createdBy`, when given alongside the ARRAY form, additionally matches a
 * Project this SAME company-less actor created with no Business Unit at
 * all (company_id NULL — resolveOptionalCreateCompanyId's documented
 * "defer BU assignment" path for Admin/Entity Admin). Without this, `company_id
 * IN (ownedCompanyIds)` can never match a NULL row (SQL IN never matches
 * NULL) — an Admin's own just-created, still-unassigned Project would be
 * permanently invisible to their own list/detail/update/delete calls, which
 * all resolve their scope through this same array form. Same "let the actor
 * see their own not-yet-company-scoped record" fix already applied to
 * Employee (employeeAccessControlService.resolveEmployeeAccessWhere's rank-2
 * `created_by` branch) and to manager_employee_mappings
 * (managerEmployeeMappingRepository.companyScopeOrNull).
 *
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy]
 * @returns {object}
 */
function companyScope(companyId, createdBy = null) {
  if (Array.isArray(companyId)) {
    if (createdBy != null) {
      return {
        [Op.or]: [
          { company_id: { [Op.in]: companyId } },
          { company_id: null, created_by: createdBy },
        ],
      };
    }
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

const CLIENT_INCLUDE = {
  model: Client,
  as: 'client',
  attributes: ['id', 'client_code', 'client_name'],
  required: false,
};

/**
 * Retrieve a paginated, filtered, sorted list of projects.
 *
 * @param {object} filters       - { search, status, client_id, companyId }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: Project[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, client_id: clientId, companyId, createdBy } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'project_name', sortOrder = 'ASC' } = sort;

  // companyScope(), when createdBy is given, may itself be an [Op.or]
  // fragment (in-scope-companies OR my-own-unscoped-record) — kept in its
  // own [Op.and] entry rather than spread into `where` directly, so the
  // search filter below (which needs its own, unrelated Op.or) can never
  // collide with and overwrite it under the same object key.
  const where = { is_deleted: false, [Op.and]: [companyScope(companyId, createdBy)] };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (clientId) {
    where.client_id = clientId;
  }

  if (search && search.trim()) {
    where[Op.and].push({
      [Op.or]: [
        { project_name: { [Op.iLike]: `%${search.trim()}%` } },
        { project_code: { [Op.iLike]: `%${search.trim()}%` } },
      ],
    });
  }

  const allowedSortColumns = ['project_name', 'project_code', 'created_at', 'status'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'project_name';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'ASC';

  return Project.findAndCountAll({
    where,
    include: [CLIENT_INCLUDE],
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    attributes: ['id', 'client_id', 'project_code', 'project_name', 'project_description', 'status', 'created_at', 'updated_at', 'created_by'],
  });
};

/**
 * Find a single project by primary key.
 *
 * @param {number} id
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy] - see companyScope()'s doc comment
 * @returns {Promise<Project|null>}
 */
const findById = async (id, companyId, createdBy = null) => {
  return Project.findOne({
    where: { id, ...companyScope(companyId, createdBy), is_deleted: false },
    include: [CLIENT_INCLUDE],
    attributes: ['id', 'client_id', 'project_code', 'project_name', 'project_description', 'status', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a single project by primary key with NO company filter — the caller
 * MUST independently verify the returned row is actually within its own
 * authorized reach before using it. Exists for cross-entity FK validation
 * (e.g. servicePOService.create()'s Project check) where a strict
 * companyId-scoped findById() would wrongly 404 a Project that has no
 * Business Unit assigned yet at all (company_id NULL — same "defer BU
 * assignment" case findById()'s own companyScope() doc comment describes)
 * even though it's genuinely available to attach. Same idiom as
 * clientRepository.findByIdUnscoped().
 *
 * @param {number} id
 * @returns {Promise<Project|null>}
 */
const findByIdUnscoped = async (id) => {
  return Project.findOne({
    where: { id, is_deleted: false },
    include: [CLIENT_INCLUDE],
    attributes: ['id', 'client_id', 'project_code', 'project_name', 'project_description', 'status', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a project by its project_code, scoped to one company (uniqueness is
 * per-company — see the uq_projects_company_code composite constraint).
 *
 * @param {string} code
 * @param {number} companyId
 * @returns {Promise<Project|null>}
 */
const findByCode = async (code, companyId) => {
  return Project.findOne({
    where: { project_code: code, company_id: companyId },
    attributes: ['id', 'project_code', 'project_name', 'status'],
  });
};

/**
 * Find a project by its name (case-insensitive, trimmed), scoped to one
 * company — uniqueness of the human-readable name, alongside the
 * machine-facing code uniqueness findByCode() already enforces. Excludes
 * soft-deleted rows — a deleted project's name is free to reuse.
 *
 * @param {string} name
 * @param {number} companyId
 * @returns {Promise<Project|null>}
 */
const findByName = async (name, companyId) => {
  return Project.findOne({
    where: { project_name: { [Op.iLike]: name.trim() }, company_id: companyId, is_deleted: false },
    attributes: ['id', 'project_code', 'project_name'],
  });
};

/**
 * Insert a new project record.
 *
 * @param {object} data - Fields to insert.
 * @returns {Promise<Project>}
 */
const create = async (data) => {
  return Project.create(data);
};

/**
 * Update an existing project by primary key.
 *
 * @param {number} id
 * @param {object} data - Fields to update.
 * @param {number} companyId
 * @returns {Promise<Project|null>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await Project.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
  });

  if (affectedRows === 0) {
    return null;
  }

  return updated;
};

/**
 * Soft-delete a project by setting is_deleted and status.
 *
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<boolean>} true if a row was affected.
 */
const softDelete = async (id, updatedBy, companyId) => {
  const [affectedRows] = await Project.update(
    { status: 'inactive', is_deleted: true, updated_by: updatedBy },
    { where: { id, ...companyScope(companyId) } }
  );
  return affectedRows > 0;
};

/**
 * Return all projects with status = 'active', ordered by name.
 * Used for dropdown lists.
 *
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy] - see companyScope()'s doc comment
 * @returns {Promise<Project[]>}
 */
const getActiveProjects = async (companyId, createdBy = null) => {
  return Project.findAll({
    where: { status: 'active', is_deleted: false, ...companyScope(companyId, createdBy) },
    attributes: ['id', 'project_code', 'project_name', 'company_id'],
    order: [['project_name', 'ASC']],
  });
};

/**
 * Count non-deleted Service POs linked to a given project.
 * Used before deletion to prevent orphaning — deliberately a plain
 * is_deleted-scoped count (NOT a `status: 'active'` filter, which would be
 * a no-op since ServicePO's status enum has no 'active' value — see
 * clientRepository.countActivePOsByClient's equivalent, dead-code bug).
 *
 * @param {number} projectId
 * @param {number} companyId
 * @returns {Promise<number>}
 */
const countServicePOsByProject = async (projectId, companyId) => {
  return ServicePO.count({
    where: {
      project_id: projectId,
      is_deleted: false,
      ...companyScope(companyId),
    },
  });
};

/**
 * Count non-deleted Service POs for MULTIPLE projects in one query (single
 * GROUP BY, not N+1) — powers the "Total Service POs" column on the
 * Project list/detail response.
 *
 * @param {number[]} projectIds
 * @param {number} companyId
 * @returns {Promise<Map<number, number>>} project_id -> count (projects with 0 POs are simply absent from the map)
 */
const countServicePOsByProjectIds = async (projectIds, companyId) => {
  if (!projectIds || projectIds.length === 0) return new Map();

  const rows = await ServicePO.findAll({
    attributes: ['project_id', [fn('COUNT', col('id')), 'po_count']],
    where: {
      project_id: { [Op.in]: projectIds },
      is_deleted: false,
      ...companyScope(companyId),
    },
    group: ['project_id'],
    raw: true,
  });

  return new Map(rows.map((row) => [row.project_id, parseInt(row.po_count, 10)]));
};

module.exports = {
  findAll,
  findById,
  findByIdUnscoped,
  findByCode,
  findByName,
  create,
  update,
  softDelete,
  getActiveProjects,
  countServicePOsByProject,
  countServicePOsByProjectIds,
};
