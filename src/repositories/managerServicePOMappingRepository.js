'use strict';

const { Op } = require('sequelize');
const { ManagerServicePOMapping } = require('../models');

/**
 * Manager Service PO Mapping Repository
 * Raw database access for manager_servicepo_mappings — a Service PO
 * Admin's grant of a Service PO to one of their own team Managers. No
 * business logic — that belongs in teamMappingService.js /
 * managerSelfServiceService.js.
 */

/**
 * Every active grant for a company — used to flag which Service POs are
 * already granted when building the "Map Service PO" drawer.
 *
 * @param {number} companyId
 * @returns {Promise<ManagerServicePOMapping[]>}
 */
const findAllMappingsInCompany = async (companyId) => {
  return ManagerServicePOMapping.findAll({
    where: { company_id: companyId, status: 'active' },
  });
};

/**
 * All active grants for one Manager — the Service POs available to them
 * when assigning Employees. Also the source for
 * servicePOMonthlyBudgetService.getAllowedServicePOIds() (GET /service-po-
 * monthly-budgets, /service-po-monthly-budgets/service-pos), so companyId
 * may be an array here too — every BU a BU-scoped caller is mapped to when
 * X-Company-Id is omitted (see resolveReportCompanyScope.js).
 *
 * @param {number} managerUserId
 * @param {number|number[]} companyId
 * @returns {Promise<ManagerServicePOMapping[]>}
 */
const findByManager = async (managerUserId, companyId) => {
  const companyWhere = Array.isArray(companyId) ? { [Op.in]: companyId } : companyId;
  return ManagerServicePOMapping.findAll({
    where: { manager_user_id: managerUserId, company_id: companyWhere, status: 'active' },
  });
};

/**
 * A specific Manager <-> Service PO grant (duplicate check / cascading
 * scope check / ownership check for revoke).
 *
 * @param {number} managerUserId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<ManagerServicePOMapping|null>}
 */
const findByManagerAndServicePO = async (managerUserId, servicePOId, companyId) => {
  return ManagerServicePOMapping.findOne({
    where: { manager_user_id: managerUserId, service_po_id: servicePOId, company_id: companyId, status: 'active' },
  });
};

/**
 * @param {object} data
 * @returns {Promise<ManagerServicePOMapping>}
 */
const create = async (data) => {
  return ManagerServicePOMapping.create(data);
};

/**
 * @param {number} id
 * @returns {Promise<number>} rows deleted
 */
const deleteById = async (id) => {
  return ManagerServicePOMapping.destroy({ where: { id } });
};

module.exports = {
  findAllMappingsInCompany,
  findByManager,
  findByManagerAndServicePO,
  create,
  deleteById,
};
