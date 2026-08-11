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
  const { search, status, client_id: clientId, companyId } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'project_name', sortOrder = 'ASC' } = sort;

  const where = { company_id: companyId, is_deleted: false };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (clientId) {
    where.client_id = clientId;
  }

  if (search && search.trim()) {
    where[Op.or] = [
      { project_name: { [Op.iLike]: `%${search.trim()}%` } },
      { project_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
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
 * @param {number} companyId
 * @returns {Promise<Project|null>}
 */
const findById = async (id, companyId) => {
  return Project.findOne({
    where: { id, company_id: companyId, is_deleted: false },
    include: [CLIENT_INCLUDE],
    attributes: ['id', 'client_id', 'project_code', 'project_name', 'project_description', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
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
    where: { id, company_id: companyId },
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
    { where: { id, company_id: companyId } }
  );
  return affectedRows > 0;
};

/**
 * Return all projects with status = 'active', ordered by name.
 * Used for dropdown lists.
 *
 * @param {number} companyId
 * @returns {Promise<Project[]>}
 */
const getActiveProjects = async (companyId) => {
  return Project.findAll({
    where: { status: 'active', is_deleted: false, company_id: companyId },
    attributes: ['id', 'project_code', 'project_name'],
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
      company_id: companyId,
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
      company_id: companyId,
    },
    group: ['project_id'],
    raw: true,
  });

  return new Map(rows.map((row) => [row.project_id, parseInt(row.po_count, 10)]));
};

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
  softDelete,
  getActiveProjects,
  countServicePOsByProject,
  countServicePOsByProjectIds,
};
