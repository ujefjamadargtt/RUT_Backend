'use strict';

const { EmployeeServicePOMapping, Employee, ServicePO } = require('../models');

/**
 * Employee Service PO Mapping Repository
 * Raw database access — no business logic.
 */

/**
 * Find a mapping row for one (employee, PO) pair, regardless of status —
 * used to detect a duplicate before creating a new row.
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const findByEmployeeAndPO = async (employeeId, servicePOId, companyId) => {
  return EmployeeServicePOMapping.findOne({
    where: { employee_id: employeeId, service_po_id: servicePOId, company_id: companyId },
  });
};

/**
 * Find a single mapping row by primary key.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const findById = async (id, companyId) => {
  return EmployeeServicePOMapping.findOne({ where: { id, company_id: companyId } });
};

/**
 * Insert a new mapping row.
 * @param {object} data - { company_id, employee_id, service_po_id, status, created_by, updated_by }
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const create = async (data) => {
  return EmployeeServicePOMapping.create(data);
};

/**
 * Update a mapping row's status.
 * @param {number} id
 * @param {string} status - 'active' | 'inactive'
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const updateStatus = async (id, status, updatedBy, companyId) => {
  const mapping = await EmployeeServicePOMapping.findOne({ where: { id, company_id: companyId } });
  if (!mapping) return null;
  return mapping.update({ status, updated_by: updatedBy });
};

/**
 * Hard-delete a mapping row.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<number>} rows deleted
 */
const remove = async (id, companyId) => {
  return EmployeeServicePOMapping.destroy({ where: { id, company_id: companyId } });
};

/**
 * List every Service PO mapped to one Employee, joined with the PO's
 * name/code, optionally filtered by status. This is the ONLY query the
 * Employee Timesheet module (Phase 3) uses to discover which Service POs an
 * employee may self-log time against — unmapped POs are never returned.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findByEmployee = async (employeeId, companyId, status) => {
  const where = { employee_id: employeeId, company_id: companyId };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: ['id', 'service_po_code', 'service_po_name', 'status', 'client_id'],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

/**
 * List every Employee mapped to one Service PO, joined with the employee's
 * name/code, optionally filtered by status.
 * @param {number} servicePOId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findByServicePO = async (servicePOId, companyId, status) => {
  const where = { service_po_id: servicePOId, company_id: companyId };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

module.exports = {
  findByEmployeeAndPO,
  findById,
  create,
  updateStatus,
  remove,
  findByEmployee,
  findByServicePO,
};
