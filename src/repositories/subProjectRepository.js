'use strict';

const { Op } = require('sequelize');
const { SubProject, ServicePO, Client, ServiceType } = require('../models');
const logger = require('../utils/logger');

/**
 * Sub-Project Repository
 * All direct Sequelize interactions for the sub_projects table.
 */

// ─── Standard include for ServicePO (with nested Client + ServiceType) ────────
const servicePOInclude = {
  model: ServicePO,
  as: 'servicePO',
  attributes: [
    'id',
    'service_po_code',
    'service_po_name',
    'po_value',
    'start_date',
    'end_date',
    'is_billable',
    'status',
  ],
  include: [
    {
      model: Client,
      as: 'client',
      attributes: ['id', 'client_code', 'client_name'],
    },
    {
      model: ServiceType,
      as: 'serviceType',
      attributes: ['id', 'service_type_name'],
    },
  ],
};

/**
 * Retrieve a paginated, filtered, sorted list of sub-projects.
 *
 * @param {object} filters          - { service_po_id, status, search }
 * @param {{ limit, offset }} pagination
 * @param {{ sortBy, sortOrder }}  sort
 * @returns {Promise<{ rows: SubProject[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  try {
    const where = { is_deleted: false, company_id: filters.companyId };

    if (filters.service_po_id) {
      where.service_po_id = parseInt(filters.service_po_id, 10);
    }

    if (filters.status && filters.status !== 'all') {
      where.status = filters.status;
    }

    if (filters.search && filters.search.trim()) {
      const searchTerm = `%${filters.search.trim()}%`;
      where[Op.or] = [
        { sub_project_name: { [Op.iLike]: searchTerm } },
        { sub_project_code: { [Op.iLike]: searchTerm } },
        { description: { [Op.iLike]: searchTerm } },
      ];
    }

    const allowedSortColumns = [
      'sub_project_name',
      'sub_project_code',
      'start_date',
      'end_date',
      'created_at',
      'status',
    ];
    const sortBy = allowedSortColumns.includes(filters.sortBy || sort.sortBy)
      ? (filters.sortBy || sort.sortBy)
      : 'created_at';
    const sortOrder = ['ASC', 'DESC'].includes(
      (filters.sortOrder || sort.sortOrder || '').toUpperCase()
    )
      ? (filters.sortOrder || sort.sortOrder).toUpperCase()
      : 'DESC';

    const result = await SubProject.findAndCountAll({
      where,
      include: [servicePOInclude],
      order: [[sortBy, sortOrder]],
      limit: pagination.limit || 20,
      offset: pagination.offset || 0,
      distinct: true,
    });

    return result;
  } catch (error) {
    logger.error('SubProjectRepository.findAll error', { error: error.message });
    throw error;
  }
};

/**
 * Find a single sub-project by primary key, including its ServicePO.
 *
 * @param {number} id
 * @returns {Promise<SubProject|null>}
 */
const findById = async (id, companyId) => {
  try {
    return await SubProject.findOne({
      where: { id: parseInt(id, 10), is_deleted: false, company_id: companyId },
      include: [servicePOInclude],
    });
  } catch (error) {
    logger.error('SubProjectRepository.findById error', { id, error: error.message });
    throw error;
  }
};

/**
 * Get all sub-projects that belong to a specific Service PO.
 *
 * @param {number} poId
 * @param {number} companyId
 * @returns {Promise<SubProject[]>}
 */
const findByPO = async (poId, companyId) => {
  try {
    return await SubProject.findAll({
      where: { service_po_id: parseInt(poId, 10), is_deleted: false, company_id: companyId },
      include: [servicePOInclude],
      order: [['created_at', 'DESC']],
    });
  } catch (error) {
    logger.error('SubProjectRepository.findByPO error', { poId, error: error.message });
    throw error;
  }
};

/**
 * Find a sub-project by its unique code, scoped to one company (uniqueness
 * is per-company — see uq_sub_projects_company_code), regardless of status
 * or soft-delete state, so a code held by an inactive/deleted sub-project in
 * this company can never be reassigned.
 *
 * @param {string} code
 * @param {number} companyId
 * @returns {Promise<SubProject|null>}
 */
const findByCode = async (code, companyId) => {
  try {
    return await SubProject.findOne({
      where: { sub_project_code: code.trim().toUpperCase(), company_id: companyId },
    });
  } catch (error) {
    logger.error('SubProjectRepository.findByCode error', { code, error: error.message });
    throw error;
  }
};

/**
 * Create a new sub-project record.
 *
 * @param {object} data
 * @returns {Promise<SubProject>}
 */
const create = async (data) => {
  try {
    return await SubProject.create(data);
  } catch (error) {
    logger.error('SubProjectRepository.create error', { error: error.message });
    throw error;
  }
};

/**
 * Update a sub-project by id.
 *
 * @param {number} id
 * @param {object} data
 * @returns {Promise<[number, SubProject[]]>}
 */
const update = async (id, data, companyId) => {
  try {
    const [affectedCount, updatedRows] = await SubProject.update(data, {
      where: { id: parseInt(id, 10), company_id: companyId },
      returning: true,
    });
    return { affectedCount, record: updatedRows ? updatedRows[0] : null };
  } catch (error) {
    logger.error('SubProjectRepository.update error', { id, error: error.message });
    throw error;
  }
};

/**
 * Soft-delete: set status to 'inactive'.
 *
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<{ affectedCount: number }>}
 */
const softDelete = async (id, companyId) => {
  try {
    const [affectedCount] = await SubProject.update(
      { status: 'inactive', is_deleted: true },
      { where: { id: parseInt(id, 10), is_deleted: false, company_id: companyId } }
    );
    return { affectedCount };
  } catch (error) {
    logger.error('SubProjectRepository.softDelete error', { id, error: error.message });
    throw error;
  }
};

module.exports = {
  findAll,
  findById,
  findByPO,
  findByCode,
  create,
  update,
  softDelete,
};
