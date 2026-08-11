'use strict';

const { Op, fn, col, literal } = require('sequelize');
const {
  ServicePO,
  ServicePOResource,
  Client,
  Project,
  ServiceType,
  ServiceCategory,
  Employee,
  Timesheet,
  sequelize,
} = require('../models');

/**
 * ServicePO Repository
 * All direct database interaction for service_pos and service_po_resources.
 */

/**
 * Retrieve a paginated, filtered list of Service POs.
 * Joins Client and ServiceType for display columns.
 *
 * @param {object} filters    - { search, status, client_id, service_category_id, service_type_id, service_po_id, is_billable, start_date_from, start_date_to }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: ServicePO[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, client_id, project_id, service_category_id, service_type_id, service_po_id, is_billable, start_date_from, start_date_to, companyId } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'created_at', sortOrder = 'DESC' } = sort;

  const where = { is_deleted: false, company_id: companyId };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (client_id) {
    where.client_id = client_id;
  }

  if (project_id) {
    where.project_id = project_id;
  }

  if (service_type_id) {
    where.service_type_id = service_type_id;
  }

  if (service_po_id) {
    where.id = service_po_id;
  }

  if (typeof is_billable === 'boolean') {
    where.is_billable = is_billable;
  }

  if (start_date_from) {
    where.start_date = { ...(where.start_date || {}), [Op.gte]: start_date_from };
  }

  if (start_date_to) {
    where.start_date = { ...(where.start_date || {}), [Op.lte]: start_date_to };
  }

  if (search && search.trim()) {
    where[Op.or] = [
      { service_po_name: { [Op.iLike]: `%${search.trim()}%` } },
      { service_po_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
  }

  const allowedSortColumns = ['service_po_name', 'service_po_code', 'start_date', 'end_date', 'po_value', 'created_at'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const serviceTypeInclude = {
    model: ServiceType,
    as: 'serviceType',
    attributes: ['id', 'service_type_name'],
    required: !!service_category_id, // NEW
    include: [
      {
        model: ServiceCategory,
        as: 'serviceCategory',
        attributes: ['id', 'name'],
        required: !!service_category_id,
        ...(service_category_id ? { where: { id: service_category_id } } : {}),
      },
    ],
  };

  return ServicePO.findAndCountAll({
    where,
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
      serviceTypeInclude,
    ],
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    distinct: true,
    subQuery: false,
  });
};

/**
 * Retrieve a single Service PO with full details:
 * client, service type, and allocated resources (employees).
 *
 * @param {number} id
 * @returns {Promise<ServicePO|null>}
 */
const findById = async (id, companyId) => {
  return ServicePO.findOne({
    where: { id, is_deleted: false, company_id: companyId },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name', 'industry'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: ServiceType,
        as: 'serviceType',
        attributes: ['id', 'service_type_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
      {
        model: Employee,
        as: 'employees',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
        through: { attributes: ['id', 'created_at'] },
      },
    ],
  });
};

/**
 * Find a Service PO by its unique code, regardless of status or soft-delete
 * state — used for uniqueness checks so a code held by a closed/cancelled/
 * deleted PO can never be reassigned.
 *
 * @param {string} code
 * @returns {Promise<ServicePO|null>}
 */
const findByCode = async (code, companyId) => {
  return ServicePO.findOne({
    where: { service_po_code: code, company_id: companyId },
    attributes: ['id', 'service_po_code', 'status'],
  });
};

/**
 * Insert a new Service PO record.
 *
 * @param {object} data
 * @returns {Promise<ServicePO>}
 */
const create = async (data) => {
  return ServicePO.create(data);
};

/**
 * Update an existing Service PO by primary key.
 *
 * @param {number} id
 * @param {object} data
 * @returns {Promise<ServicePO|null>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await ServicePO.update(data, {
    where: { id, company_id: companyId },
    returning: true,
  });

  if (affectedRows === 0) {
    return null;
  }

  return updated;
};

/**
 * Close a Service PO — sets status = 'closed'.
 *
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const close = async (id, updatedBy, companyId) => {
  const [affectedRows] = await ServicePO.update(
    { status: 'closed', updated_by: updatedBy },
    { where: { id, is_deleted: false, company_id: companyId } }
  );
  return affectedRows > 0;
};

/**
 * Upsert employee allocations into service_po_resources.
 * Uses bulkCreate with ignoreDuplicates so re-allocating already-assigned
 * employees is idempotent and not an error.
 *
 * @param {number} poId
 * @param {number[]} employeeIds
 * @returns {Promise<ServicePOResource[]>}
 */
const allocateResources = async (poId, employeeIds, companyId) => {
  const records = employeeIds.map((employee_id) => ({
    service_po_id: poId,
    employee_id,
    company_id: companyId,
  }));

  return ServicePOResource.bulkCreate(records, {
    ignoreDuplicates: true,
  });
};

/**
 * Remove a single employee from a Service PO.
 *
 * @param {number} poId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<number>} Number of rows deleted
 */
const deallocateResource = async (poId, employeeId, companyId) => {
  return ServicePOResource.destroy({
    where: {
      service_po_id: poId,
      employee_id: employeeId,
      company_id: companyId,
    },
  });
};

/**
 * Return all employees currently allocated to a PO.
 *
 * @param {number} poId
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const getResources = async (poId, companyId) => {
  const resources = await ServicePOResource.findAll({
    where: { service_po_id: poId, company_id: companyId },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
      },
    ],
    attributes: ['id', 'service_po_id', 'employee_id', 'created_at'],
    order: [[{ model: Employee, as: 'employee' }, 'full_name', 'ASC']],
  });

  return resources;
};

/**
 * Calculate utilisation for a PO: sum of hours logged vs expected man hours.
 *
 * @param {number} poId
 * @returns {Promise<{ total_hours_logged: number, expected_man_hours: number }>}
 */
const getUtilisation = async (poId, companyId) => {
  const po = await ServicePO.findOne({
    where: { id: poId, company_id: companyId },
    attributes: ['id', 'expected_man_hours'],
  });

  if (!po) {
    return null;
  }

  const result = await Timesheet.findOne({
    where: { service_po_id: poId, company_id: companyId },
    attributes: [[fn('COALESCE', fn('SUM', col('hours_logged')), literal('0')), 'total_hours_logged']],
    raw: true,
  });

  return {
    total_hours_logged: parseFloat(result ? result.total_hours_logged : 0),
    expected_man_hours: parseFloat(po.expected_man_hours || 0),
  };
};

/**
 * Return all active Service POs (for dropdowns, validation lookups etc.).
 *
 * @returns {Promise<ServicePO[]>}
 */
const getActivePOs = async (companyId) => {
  return ServicePO.findAll({
    where: { status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] }, is_deleted: false, company_id: companyId },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: ServiceType,
        as: 'serviceType',
        attributes: ['id', 'service_type_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
    ],
    attributes: ['id', 'service_po_code', 'service_po_name', 'start_date', 'end_date', 'is_billable'],
    order: [['service_po_name', 'ASC']],
  });
};

const softDelete = async (id, updatedBy, companyId) => {
  const po = await ServicePO.findOne({ where: { id, is_deleted: false, company_id: companyId } });
  if (!po) return null;
  return po.update({ status: 'cancelled', is_deleted: true, updated_by: updatedBy });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
  close,
  softDelete,
  allocateResources,
  deallocateResource,
  getResources,
  getUtilisation,
  getActivePOs,
};
