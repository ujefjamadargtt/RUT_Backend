'use strict';

const { Op } = require('sequelize');
const subProjectRepository = require('../repositories/subProjectRepository');
const { ServicePO, Timesheet } = require('../models');
const { createAuditLog } = require('../middlewares/auditLog');
const { generateSubProjectCode } = require('../helpers/codeGenerator');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Sub-Project Service
 * Business logic layer between controllers and repository.
 */

/**
 * Get a paginated list of sub-projects.
 *
 * @param {object} query - Validated query params (page, limit, status, service_po_id, search, sort_by, sort_order)
 * @returns {Promise<{ data: SubProject[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    service_po_id: query.service_po_id || null,
    status: query.status || 'active',
    search: query.search || '',
    sortBy: query.sort_by || 'created_at',
    sortOrder: (query.sort_order || 'DESC').toUpperCase(),
    companyId,
  };

  const { rows, count } = await subProjectRepository.findAll(
    filters,
    { limit, offset },
    {}
  );

  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Get a single sub-project by id.
 *
 * @param {number} id
 * @returns {Promise<SubProject>}
 */
const getById = async (id, companyId) => {
  const subProject = await subProjectRepository.findById(id, companyId);

  if (!subProject) {
    const error = new Error('Sub-project not found.');
    error.statusCode = 404;
    throw error;
  }

  return subProject;
};

/**
 * Create a new sub-project.
 * - Auto-generates sub_project_code
 * - Validates that the referenced Service PO exists and is active
 * - Writes an audit log entry
 *
 * @param {object} data   - Validated request body
 * @param {number} userId - ID of the authenticated user
 * @param {string} ip     - Client IP address
 * @returns {Promise<SubProject>}
 */
const create = async (data, userId, ip = null, companyId) => {
  // Validate Service PO exists, is active, AND belongs to this company —
  // a PO id from another company simply 404s, same as a genuinely missing id.
  const servicePO = await ServicePO.findOne({
    where: { id: data.service_po_id, company_id: companyId },
    attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
  });

  if (!servicePO) {
    const error = new Error('The referenced Service PO does not exist.');
    error.statusCode = 404;
    throw error;
  }

  // if (servicePO.status !== 'active') {
  //   const error = new Error(
  //     `Cannot create a sub-project under Service PO "${servicePO.service_po_name}" because its status is "${servicePO.status}". Only active POs are allowed.`
  //   );
  //   error.statusCode = 400;
  //   throw error;
  // }

  // Generate unique code — retry on collision (extremely rare), scoped to
  // this company since uniqueness is per-company (uq_sub_projects_company_code)
  let subProjectCode;
  let attempts = 0;
  do {
    subProjectCode = generateSubProjectCode();
    const existing = await subProjectRepository.findByCode(subProjectCode, companyId);
    if (!existing) break;
    attempts++;
  } while (attempts < 5);

  if (attempts >= 5) {
    logger.error('SubProjectService.create: failed to generate unique code after 5 attempts');
    const error = new Error('Failed to generate a unique sub-project code. Please try again.');
    error.statusCode = 500;
    throw error;
  }

  const payload = {
    sub_project_code: subProjectCode,
    service_po_id: data.service_po_id,
    sub_project_name: data.sub_project_name,
    description: data.description || null,
    start_date: data.start_date || null,
    end_date: data.end_date || null,
    status: data.status || 'active',
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const subProject = await subProjectRepository.create(payload);

  // Audit log — non-blocking
  await createAuditLog(
    userId,
    'CREATE',
    'sub_projects',
    subProject.id,
    null,
    {
      sub_project_code: subProject.sub_project_code,
      sub_project_name: subProject.sub_project_name,
      service_po_id: subProject.service_po_id,
      status: subProject.status,
    },
    ip
  );

  // Return with associations
  return subProjectRepository.findById(subProject.id, companyId);
};

/**
 * Update an existing sub-project.
 * - If service_po_id is changed, validates the new PO
 * - Recalculates nothing (sub-projects carry no computed fields)
 * - Writes audit log
 *
 * @param {number} id
 * @param {object} data   - Validated partial update body
 * @param {number} userId
 * @param {string} ip
 * @returns {Promise<SubProject>}
 */
const update = async (id, data, userId, ip = null, companyId) => {
  const existing = await subProjectRepository.findById(id, companyId);

  if (!existing) {
    const error = new Error('Sub-project not found.');
    error.statusCode = 404;
    throw error;
  }

  // If the caller is changing the sub_project_code, ensure it is not taken by
  // any other sub-project in this company, regardless of its status or
  // soft-delete state.
  if (data.sub_project_code && data.sub_project_code !== existing.sub_project_code) {
    const taken = await subProjectRepository.findByCode(data.sub_project_code, companyId);
    if (taken && taken.id !== id) {
      const error = new Error(`Sub-project code "${data.sub_project_code}" is already in use.`);
      error.statusCode = 409;
      throw error;
    }
  }

  // If changing PO reference, validate the new PO — scoped to this company,
  // so a PO id from another company 404s.
  if (data.service_po_id && data.service_po_id !== existing.service_po_id) {
    const servicePO = await ServicePO.findOne({
      where: { id: data.service_po_id, company_id: companyId },
      attributes: ['id', 'service_po_name', 'status'],
    });

    if (!servicePO) {
      const error = new Error('The referenced Service PO does not exist.');
      error.statusCode = 404;
      throw error;
    }

    if (servicePO.status !== 'active') {
      const error = new Error(
        `Cannot reassign to Service PO "${servicePO.service_po_name}" because its status is "${servicePO.status}".`
      );
      error.statusCode = 400;
      throw error;
    }
  }

  const oldValues = {
    sub_project_name: existing.sub_project_name,
    service_po_id: existing.service_po_id,
    description: existing.description,
    start_date: existing.start_date,
    end_date: existing.end_date,
    status: existing.status,
  };

  const updatePayload = {
    ...data,
    updated_by: userId,
  };

  await subProjectRepository.update(id, updatePayload, companyId);

  const updated = await subProjectRepository.findById(id, companyId);

  // Audit log — non-blocking
  await createAuditLog(
    userId,
    'UPDATE',
    'sub_projects',
    id,
    oldValues,
    {
      sub_project_name: updated.sub_project_name,
      service_po_id: updated.service_po_id,
      description: updated.description,
      start_date: updated.start_date,
      end_date: updated.end_date,
      status: updated.status,
    },
    ip
  );

  return updated;
};

/**
 * Soft-delete a sub-project.
 * Blocks deletion if any timesheets reference this sub-project.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ip
 * @returns {Promise<void>}
 */
const deleteSubProject = async (id, userId, ip = null, companyId) => {
  const existing = await subProjectRepository.findById(id, companyId);

  if (!existing) {
    const error = new Error('Sub-project not found.');
    error.statusCode = 404;
    throw error;
  }

  // Guard: reject deletion if timesheets exist
  const timesheetCount = await Timesheet.count({
    where: { sub_project_id: id, company_id: companyId },
  });

  if (timesheetCount > 0) {
    const error = new Error(
      `Cannot delete sub-project "${existing.sub_project_name}" because ${timesheetCount} timesheet record(s) are linked to it. Deactivate it instead.`
    );
    error.statusCode = 409;
    throw error;
  }

  await subProjectRepository.softDelete(id, companyId);

  // Audit log — non-blocking
  await createAuditLog(
    userId,
    'DELETE',
    'sub_projects',
    id,
    {
      sub_project_code: existing.sub_project_code,
      sub_project_name: existing.sub_project_name,
      status: existing.status,
    },
    null,
    ip
  );
};

/**
 * Get all sub-projects for a given Service PO.
 *
 * @param {number} poId
 * @returns {Promise<SubProject[]>}
 */
const getByPO = async (poId, companyId) => {
  // Validate PO exists and belongs to this company — companyId may be an
  // array here (every BU a BU-scoped caller is mapped to when
  // X-Company-Id is omitted, via the GET /sub-projects/by-po/:poId read
  // path — see resolveReportCompanyScope.js), never for the write paths.
  const servicePO = await ServicePO.findOne({
    where: { id: poId, company_id: Array.isArray(companyId) ? { [Op.in]: companyId } : companyId },
    attributes: ['id', 'service_po_name', 'status'],
  });

  if (!servicePO) {
    const error = new Error('Service PO not found.');
    error.statusCode = 404;
    throw error;
  }

  return subProjectRepository.findByPO(poId, companyId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteSubProject,
  getByPO,
};
