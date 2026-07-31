'use strict';

const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeRepository = require('../repositories/employeeRepository');
const servicePORepository = require('../repositories/servicePORepository');
const logger = require('../utils/logger');

/**
 * Employee Service PO Mapping Service
 * Business rules for which Service POs an Employee may self-log time
 * against (Employee Self Timesheet, Phase 2). All company_id-scoped.
 */

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/**
 * Assign a Service PO to an Employee. One Employee -> many Service POs;
 * one Service PO -> many Employees (plain many-to-many). Prevents a
 * duplicate mapping row from ever existing for the same pair — an existing
 * row of ANY status must go through Activate/Deactivate instead.
 *
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const assign = async (employeeId, servicePOId, userId, companyId) => {
  const employee = await employeeRepository.findById(employeeId, companyId);
  if (!employee) {
    throw notFoundError(`Employee #${employeeId} was not found in this company.`);
  }

  const servicePO = await servicePORepository.findById(servicePOId, companyId);
  if (!servicePO) {
    throw notFoundError(`Service PO #${servicePOId} was not found in this company.`);
  }

  const existing = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId, companyId);
  if (existing) {
    const err = new Error(
      existing.status === 'active'
        ? `Employee #${employeeId} is already mapped to Service PO #${servicePOId}.`
        : `A mapping between Employee #${employeeId} and Service PO #${servicePOId} already exists but is inactive. Use Activate Mapping instead.`
    );
    err.statusCode = 409;
    throw err;
  }

  const mapping = await employeeServicePOMappingRepository.create({
    company_id: companyId,
    employee_id: employeeId,
    service_po_id: servicePOId,
    status: 'active',
    created_by: userId,
    updated_by: userId,
  });

  logger.info('Employee-ServicePO mapping created', { mappingId: mapping.id, employeeId, servicePOId, userId });

  return mapping;
};

/**
 * Hard-delete a mapping row.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const removeMapping = async (id, companyId) => {
  const mapping = await employeeServicePOMappingRepository.findById(id, companyId);
  if (!mapping) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  await employeeServicePOMappingRepository.remove(id, companyId);
  logger.info('Employee-ServicePO mapping removed', { mappingId: id });
};

/**
 * Set a mapping row's status to 'active'.
 * @param {number} id
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const activateMapping = async (id, userId, companyId) => {
  const updated = await employeeServicePOMappingRepository.updateStatus(id, 'active', userId, companyId);
  if (!updated) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  logger.info('Employee-ServicePO mapping activated', { mappingId: id, userId });
  return updated;
};

/**
 * Set a mapping row's status to 'inactive'.
 * @param {number} id
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const deactivateMapping = async (id, userId, companyId) => {
  const updated = await employeeServicePOMappingRepository.updateStatus(id, 'inactive', userId, companyId);
  if (!updated) {
    throw notFoundError(`Mapping #${id} was not found.`);
  }
  logger.info('Employee-ServicePO mapping deactivated', { mappingId: id, userId });
  return updated;
};

/**
 * List every Service PO mapped to one Employee.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getEmployeeMappings = async (employeeId, companyId, status) => {
  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, status);
};

/**
 * List every Employee mapped to one Service PO.
 * @param {number} servicePOId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getServicePOEmployees = async (servicePOId, companyId, status) => {
  return employeeServicePOMappingRepository.findByServicePO(servicePOId, companyId, status);
};

module.exports = {
  assign,
  removeMapping,
  activateMapping,
  deactivateMapping,
  getEmployeeMappings,
  getServicePOEmployees,
};
