'use strict';

const { Op } = require('sequelize');
const { ManagerEmployeeMapping } = require('../models');

/**
 * Manager Employee Mapping Repository
 * Raw database access for manager_employee_mappings — an Employee's
 * Primary/Secondary Manager assignment. Each Employee has AT MOST one
 * PRIMARY and one SECONDARY manager row (unique index on
 * (employee_id, mapping_type) — see database/migrations/
 * 20260843_manager_employee_mappings_add_type.sql), set mandatorily
 * (PRIMARY) at Employee creation by HR (employeeService.js) and
 * optionally extended (SECONDARY) via Manager self-service
 * (managerSelfServiceService.js). No business logic here.
 */

/**
 * Every active mapping row for a company — used to flag which Employees
 * already have a Manager when building a "Map Employees" drawer.
 *
 * @param {number} companyId
 * @returns {Promise<ManagerEmployeeMapping[]>}
 */
const findAllMappingsInCompany = async (companyId) => {
  return ManagerEmployeeMapping.findAll({
    where: { company_id: companyId, status: 'active' },
  });
};

/**
 * All active mappings for one Manager (both PRIMARY and SECONDARY
 * employees) — their "My Employees" list.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @returns {Promise<ManagerEmployeeMapping[]>}
 */
const findByManager = async (managerUserId, companyId) => {
  return ManagerEmployeeMapping.findAll({
    where: { manager_user_id: managerUserId, company_id: companyId, status: 'active' },
  });
};

/**
 * Both mapping rows (PRIMARY and/or SECONDARY, whichever exist) for a
 * given Employee, regardless of which Manager(s) own them.
 *
 * @param {number} employeeId
 * @returns {Promise<ManagerEmployeeMapping[]>}
 */
const findAllByEmployee = async (employeeId) => {
  return ManagerEmployeeMapping.findAll({ where: { employee_id: employeeId } });
};

/**
 * Both mapping rows (PRIMARY and/or SECONDARY) for MANY Employees at once —
 * used to attach each employee's manager id/name in one batch (e.g.
 * employeeService.js's employee list/detail responses) instead of one
 * query per employee.
 *
 * @param {number[]} employeeIds
 * @returns {Promise<ManagerEmployeeMapping[]>}
 */
const findByEmployeeIds = async (employeeIds) => {
  if (!employeeIds || employeeIds.length === 0) return [];
  return ManagerEmployeeMapping.findAll({
    where: { employee_id: { [Op.in]: employeeIds }, status: 'active' },
  });
};

/**
 * Every active mapping row owned by ANY of the given Manager user IDs — the
 * Service PO Admin employee-scope lookup (a Service PO Admin's authorized
 * Employees are the union of every Employee mapped to a Manager on their
 * team; see teamMappingRepository.findByServicePOAdmin and
 * employeeAccessControlService.js). Same batching rationale as
 * findByEmployeeIds() above — one query for every Manager on the team,
 * never one query per Manager.
 *
 * @param {number[]} managerUserIds
 * @param {number} companyId
 * @returns {Promise<ManagerEmployeeMapping[]>}
 */
const findByManagerUserIds = async (managerUserIds, companyId) => {
  if (!managerUserIds || managerUserIds.length === 0) return [];
  return ManagerEmployeeMapping.findAll({
    where: { manager_user_id: { [Op.in]: managerUserIds }, company_id: companyId, status: 'active' },
  });
};

/**
 * The mapping row for one specific (employee, mapping_type) slot, if any —
 * the uniqueness/409 check when assigning a Primary or Secondary Manager.
 *
 * @param {number} employeeId
 * @param {'PRIMARY'|'SECONDARY'} mappingType
 * @returns {Promise<ManagerEmployeeMapping|null>}
 */
const findByEmployeeAndType = async (employeeId, mappingType) => {
  return ManagerEmployeeMapping.findOne({ where: { employee_id: employeeId, mapping_type: mappingType } });
};

/**
 * Find a specific Manager -> Employee mapping (ownership check for
 * remove / for the "is this my own Employee" scoping check), regardless of
 * mapping_type.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<ManagerEmployeeMapping|null>}
 */
const findByManagerAndEmployee = async (managerUserId, employeeId, companyId) => {
  return ManagerEmployeeMapping.findOne({
    where: { manager_user_id: managerUserId, employee_id: employeeId, company_id: companyId, status: 'active' },
  });
};

/**
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<ManagerEmployeeMapping>}
 */
const create = async (data, options = {}) => {
  return ManagerEmployeeMapping.create(data, options);
};

/**
 * @param {number} id
 * @returns {Promise<number>} rows deleted
 */
const deleteById = async (id) => {
  return ManagerEmployeeMapping.destroy({ where: { id } });
};

module.exports = {
  findAllMappingsInCompany,
  findByManager,
  findAllByEmployee,
  findByEmployeeIds,
  findByManagerUserIds,
  findByEmployeeAndType,
  findByManagerAndEmployee,
  create,
  deleteById,
};
