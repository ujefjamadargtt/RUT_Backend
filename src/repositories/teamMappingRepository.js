'use strict';

const { User, TeamMapping } = require('../models');

/**
 * Team Mapping Repository
 * Raw database access for team_mappings — Service PO Admin's own roster of
 * Managers. No business logic — that belongs in teamMappingService.js.
 */

/**
 * All Users holding the given role_id within one company — used to list
 * every Manager in the company for the "Map Managers" drawer (role_id
 * resolved by the caller via roleRepository.findByName).
 *
 * @param {number} roleId
 * @param {number} companyId
 * @returns {Promise<User[]>}
 */
const findUsersByRole = async (roleId, companyId) => {
  return User.findAll({
    where: { role_id: roleId, company_id: companyId, is_deleted: false },
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
    where: { service_po_admin_user_id: servicePOAdminUserId, company_id: companyId, status: 'active' },
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
  return TeamMapping.findOne({ where: { manager_user_id: managerUserId } });
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
    where: { service_po_admin_user_id: servicePOAdminUserId, manager_user_id: managerUserId, company_id: companyId },
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
