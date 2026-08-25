'use strict';

const { Employee, Role, TeamMapping } = require('../models');

/**
 * Team Mapping Repository
 * Raw database access for team_mappings — Service PO Admin's own roster of
 * Managers. No business logic — that belongs in teamMappingService.js.
 */

/**
 * All Employees holding the given role_id, scoped to their home Business
 * Unit (employees.company_id) — used to list every Manager in the company
 * for the "Map Managers" drawer (role_id resolved by the caller via
 * roleRepository.findByName). Employee-keyed now that role assignment
 * lives on employee_roles, not users.role_id.
 *
 * @param {number} roleId
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const findUsersByRole = async (roleId, companyId) => {
  return Employee.findAll({
    where: { company_id: companyId, is_deleted: false },
    include: [{
      model: Role,
      as: 'roles',
      where: { id: roleId },
      attributes: [],
      through: { attributes: [], where: { status: 'active' } },
      required: true,
    }],
    attributes: ['id', 'email', 'status', 'created_at'],
    order: [['email', 'ASC']],
  });
};

/**
 * Every active team_mappings row for a company, keyed for a quick "which
 * Service PO Admin (if any) owns this Manager" lookup when building the
 * drawer's Manager list.
 *
 * @param {number} companyId
 * @returns {Promise<TeamMapping[]>}
 */
const findAllMappingsInCompany = async (companyId) => {
  return TeamMapping.findAll({
    where: { company_id: companyId, status: 'active' },
  });
};

/**
 * All active Managers belonging to one Service PO Admin's own team.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} companyId
 * @returns {Promise<TeamMapping[]>}
 */
const findByServicePOAdmin = async (servicePOAdminUserId, companyId) => {
  return TeamMapping.findAll({
    where: { service_po_admin_employee_id: servicePOAdminUserId, company_id: companyId, status: 'active' },
  });
};

/**
 * Find the (at most one) mapping for a given Manager, regardless of which
 * Service PO Admin owns it — the uniqueness/409 check.
 *
 * @param {number} managerUserId
 * @returns {Promise<TeamMapping|null>}
 */
const findByManager = async (managerUserId) => {
  return TeamMapping.findOne({ where: { manager_employee_id: managerUserId } });
};

/**
 * Find a specific Service PO Admin -> Manager mapping (ownership check for remove).
 *
 * @param {number} servicePOAdminUserId
 * @param {number} managerUserId
 * @param {number} companyId
 * @returns {Promise<TeamMapping|null>}
 */
const findByServicePOAdminAndManager = async (servicePOAdminUserId, managerUserId, companyId) => {
  return TeamMapping.findOne({
    where: { service_po_admin_employee_id: servicePOAdminUserId, manager_employee_id: managerUserId, company_id: companyId },
  });
};

/**
 * @param {object} data
 * @returns {Promise<TeamMapping>}
 */
const create = async (data) => {
  return TeamMapping.create(data);
};

/**
 * @param {number} id
 * @returns {Promise<number>} rows deleted
 */
const deleteById = async (id) => {
  return TeamMapping.destroy({ where: { id } });
};

module.exports = {
  findUsersByRole,
  findAllMappingsInCompany,
  findByServicePOAdmin,
  findByManager,
  findByServicePOAdminAndManager,
  create,
  deleteById,
};
