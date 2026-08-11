'use strict';

const projectRepository = require('../repositories/projectRepository');
const clientRepository = require('../repositories/clientRepository');
const { generateProjectCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
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
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    client_id: query.client_id ? parseInt(query.client_id, 10) : null,
    companyId,
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
const getById = async (id, companyId) => {
  const project = await projectRepository.findById(id, companyId);

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
 * @param {object} data   - Validated body (client_id, project_name, project_description, status, [project_code])
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<Project>}
 */
const create = async (data, userId, req) => {
  const companyId = req.companyId;

  const client = await clientRepository.findById(data.client_id, companyId);
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
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<Project>}
 */
const update = async (id, data, userId, req) => {
  const companyId = req.companyId;

  const existing = await projectRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }

  // If client_id is being changed, validate the new client — same
  // conditional-on-change pattern servicePOService.update() uses.
  if (data.client_id && data.client_id !== existing.client_id) {
    const client = await clientRepository.findById(data.client_id, companyId);
    if (!client) {
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

  const oldValues = {
    client_id: existing.client_id,
    project_code: existing.project_code,
    project_name: existing.project_name,
    project_description: existing.project_description,
    status: existing.status,
  };

  const payload = { ...data, updated_by: userId };
  const updated = await projectRepository.update(id, payload, companyId);

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
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deleteProject = async (id, userId, req) => {
  const companyId = req.companyId;

  const existing = await projectRepository.findById(id, companyId);
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

  const poCount = await projectRepository.countServicePOsByProject(id, companyId);
  if (poCount > 0) {
    const err = new Error(
      `Cannot delete project "${existing.project_name}". ` +
      `${poCount} Service PO(s) are linked to this project. ` +
      'Reassign them to a different project before deleting.'
    );
    err.statusCode = 409;
    throw err;
  }

  await projectRepository.softDelete(id, userId, companyId);

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
 * @param {number} companyId
 * @returns {Promise<Project[]>}
 */
const getActiveProjects = async (companyId) => {
  return projectRepository.getActiveProjects(companyId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  deleteProject,
  getActiveProjects,
};
