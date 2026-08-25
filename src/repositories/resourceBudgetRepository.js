'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { ResourceBudget, EmployeeServicePOMapping, Employee, ServicePO } = require('../models');

/**
 * Resource Budget Repository
 * All direct database interaction for resource_budget_master. No business
 * logic — the 176-hour validation lives in resourceBudgetService.js.
 */

const employeeInclude = {
  model: Employee,
  as: 'employee',
  attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
};

const servicePOInclude = {
  model: ServicePO,
  as: 'servicePO',
  attributes: ['id', 'service_po_code', 'service_po_name'],
};

/**
 * Builds a `company_id` WHERE fragment — Op.in-aware for an array (a
 * company-less Admin/Entity Admin's resolved owned-Company-id scope, see
 * companyAccessControlService.resolveActorCompanyScope), plain equality for
 * a number. No "omit when undefined" fallback — every function below must
 * always be company-scoped.
 *
 * @param {number|number[]} companyId
 * @returns {object}
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

/**
 * @param {number} id
 * @param {number|number[]} companyId
 * @returns {Promise<ResourceBudget|null>}
 */
const findById = async (id, companyId) => {
  return ResourceBudget.findOne({ where: { id, ...companyScope(companyId) }, include: [employeeInclude, servicePOInclude] });
};

/**
 * Find the record for one (emp_id, service_po_id, month, year), regardless
 * of status — used for the duplicate-prevention check before create.
 * @param {number} empId
 * @param {number} servicePOId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<ResourceBudget|null>}
 */
const findOne = async (empId, servicePOId, month, year, companyId, transaction) => {
  return ResourceBudget.findOne({
    where: { emp_id: empId, service_po_id: servicePOId, month, year, ...companyScope(companyId) },
    transaction,
  });
};

/**
 * Every resource budget record for a Service PO.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<ResourceBudget[]>}
 */
const findByServicePO = async (servicePOId, companyId) => {
  return ResourceBudget.findAll({
    where: { service_po_id: servicePOId, ...companyScope(companyId) },
    include: [employeeInclude, servicePOInclude],
    order: [['year', 'DESC'], ['month', 'DESC'], ['emp_id', 'ASC']],
  });
};

/**
 * Filtered list — emp_id and/or month/year, each optional.
 * @param {{ emp_id?: number, month?: number, year?: number }} filters
 * @param {number} companyId
 * @returns {Promise<ResourceBudget[]>}
 */
const findAll = async (filters, companyId) => {
  const where = { ...companyScope(companyId) };
  if (filters.emp_id !== undefined) where.emp_id = filters.emp_id;
  if (filters.month !== undefined) where.month = filters.month;
  if (filters.year !== undefined) where.year = filters.year;

  return ResourceBudget.findAll({
    where,
    include: [employeeInclude, servicePOInclude],
    order: [['year', 'DESC'], ['month', 'DESC']],
  });
};

/**
 * SUM(hours) for one employee + month/year across every ACTIVE resource
 * budget record, optionally excluding one record (by id — used by the
 * single-record update flow) and/or one Service PO (used by the bulk flow,
 * which is replacing every row for that Service PO in this same call).
 *
 * @param {number} empId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @param {{ excludeId?: number, excludeServicePOId?: number }} [exclude]
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<number>}
 */
const sumActiveHoursForEmployeeMonth = async (empId, month, year, companyId, exclude = {}, transaction) => {
  const where = { emp_id: empId, month, year, ...companyScope(companyId), status: 'active' };
  if (exclude.excludeId !== undefined && exclude.excludeId !== null) {
    where.id = { [Op.ne]: exclude.excludeId };
  }
  if (exclude.excludeServicePOId !== undefined && exclude.excludeServicePOId !== null) {
    where.service_po_id = { [Op.ne]: exclude.excludeServicePOId };
  }

  const result = await ResourceBudget.findOne({
    where,
    attributes: [[fn('COALESCE', fn('SUM', col('hours')), literal('0')), 'total_hours']],
    raw: true,
    transaction,
  });

  return parseFloat(result ? result.total_hours : 0) || 0;
};

/**
 * @param {object} data
 * @param {object} [options] - Sequelize options, e.g. { transaction }
 * @returns {Promise<ResourceBudget>}
 */
const create = async (data, options) => {
  return ResourceBudget.create(data, options);
};

/**
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<ResourceBudget|null>}
 */
const update = async (id, data, companyId, transaction) => {
  const [affectedRows, [updated]] = await ResourceBudget.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
    transaction,
  });
  return affectedRows === 0 ? null : updated;
};

/**
 * Whether an employee is mapped to a Service PO — reuses the existing
 * employee_servicepo_mapping table (EmployeeServicePOMapping), the table
 * this application actually populates when an employee is assigned to a
 * Service PO (service_po_resources, used by an older/unused allocation
 * flow, is empty in practice). Only an 'active' mapping counts.
 * @param {number} empId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const isEmployeeMappedToServicePO = async (empId, servicePOId, companyId) => {
  const mapping = await EmployeeServicePOMapping.findOne({
    where: { employee_id: empId, service_po_id: servicePOId, ...companyScope(companyId), status: 'active' },
  });
  return !!mapping;
};

/**
 * Employees mapped to a Service PO — feeds the "select employees to budget
 * hours for" screen. Reuses employee_servicepo_mapping (EmployeeServicePOMapping),
 * the same table employeeServicePOMappingRepository.findByServicePO() already
 * queries elsewhere in the app. Only 'active' mappings are returned.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const findMappedEmployees = async (servicePOId, companyId) => {
  const mappings = await EmployeeServicePOMapping.findAll({
    where: { service_po_id: servicePOId, ...companyScope(companyId), status: 'active' },
    include: [employeeInclude],
    order: [[{ model: Employee, as: 'employee' }, 'full_name', 'ASC']],
  });

  return mappings.map((mapping) => mapping.employee).filter(Boolean);
};

module.exports = {
  findById,
  findOne,
  findByServicePO,
  findAll,
  sumActiveHoursForEmployeeMonth,
  create,
  update,
  isEmployeeMappedToServicePO,
  findMappedEmployees,
};
