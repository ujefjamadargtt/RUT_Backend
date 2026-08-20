'use strict';

const { CostBudget, ServicePO, Client } = require('../models');

/**
 * Cost Budget Repository
 * All direct database interaction for cost_budget_master. No business logic.
 */

const servicePOInclude = {
  model: ServicePO,
  as: 'servicePO',
  attributes: ['id', 'service_po_code', 'service_po_name', 'client_id'],
  include: [
    {
      model: Client,
      as: 'client',
      attributes: ['id', 'client_code', 'client_name'],
    },
  ],
};

/**
 * Find a record by primary key, scoped to the caller's company.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<CostBudget|null>}
 */
const findById = async (id, companyId) => {
  return CostBudget.findOne({ where: { id, company_id: companyId }, include: [servicePOInclude] });
};

/**
 * Find the record for one Service PO + month/year, regardless of status —
 * used for the duplicate-prevention check before create.
 * @param {number} servicePOId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<CostBudget|null>}
 */
const findOne = async (servicePOId, month, year, companyId) => {
  return CostBudget.findOne({ where: { service_po_id: servicePOId, month, year, company_id: companyId } });
};

/**
 * Every cost budget record for a Service PO, most recent month first.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<CostBudget[]>}
 */
const findByServicePO = async (servicePOId, companyId) => {
  return CostBudget.findAll({
    where: { service_po_id: servicePOId, company_id: companyId },
    include: [servicePOInclude],
    order: [['year', 'DESC'], ['month', 'DESC']],
  });
};

/**
 * Filtered list — month/year and/or service_po_id, each optional.
 * @param {{ service_po_id?: number, month?: number, year?: number }} filters
 * @param {number} companyId
 * @returns {Promise<CostBudget[]>}
 */
const findAll = async (filters, companyId) => {
  const where = { company_id: companyId };
  if (filters.service_po_id !== undefined) where.service_po_id = filters.service_po_id;
  if (filters.month !== undefined) where.month = filters.month;
  if (filters.year !== undefined) where.year = filters.year;

  return CostBudget.findAll({
    where,
    include: [servicePOInclude],
    order: [['year', 'DESC'], ['month', 'DESC']],
  });
};

/**
 * @param {object} data
 * @returns {Promise<CostBudget>}
 */
const create = async (data) => {
  return CostBudget.create(data);
};

/**
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @returns {Promise<CostBudget|null>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await CostBudget.update(data, {
    where: { id, company_id: companyId },
    returning: true,
  });
  return affectedRows === 0 ? null : updated;
};

module.exports = {
  findById,
  findOne,
  findByServicePO,
  findAll,
  create,
  update,
};
