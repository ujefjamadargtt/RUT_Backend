'use strict';

const { Op } = require('sequelize');
const { ServicePOMonthlyBudget, ServicePO, Client } = require('../models');

// Same "currently active" statuses servicePORepository.getActivePOs() uses
// for its dropdown — the Service PO Manager screen should only ever ask for
// budget data on POs that are actually still open.
const ACTIVE_PO_STATUSES = ['in-progress', 'on-hold', 'pending'];

/**
 * Service PO Monthly Budget Repository
 * All direct database interaction for service_po_monthly_budgets.
 */

const servicePOInclude = {
  model: ServicePO,
  as: 'servicePO',
  attributes: ['id', 'service_po_code', 'service_po_name', 'client_id', 'is_billable', 'status'],
  include: [
    {
      model: Client,
      as: 'client',
      attributes: ['id', 'client_code', 'client_name'],
    },
  ],
};

/**
 * Find the single budget record for a Service PO in a given month/year,
 * scoped to the caller's company.
 *
 * @param {number} servicePOId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<ServicePOMonthlyBudget|null>}
 */
const findOne = async (servicePOId, month, year, companyId) => {
  return ServicePOMonthlyBudget.findOne({
    where: { service_po_id: servicePOId, month, year, company_id: companyId },
    include: [servicePOInclude],
  });
};

/**
 * Find a budget record by primary key, scoped to the caller's company.
 *
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<ServicePOMonthlyBudget|null>}
 */
const findById = async (id, companyId) => {
  return ServicePOMonthlyBudget.findOne({
    where: { id, company_id: companyId },
    include: [servicePOInclude],
  });
};

/**
 * Every active Service PO in the caller's company, each with its monthly
 * budget row for the given month/year LEFT-joined in (null when no entry has
 * been filled in yet) — feeds the Service PO Manager "current month" screen,
 * which must show every PO regardless of whether it already has data.
 *
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<ServicePO[]>} each with a `monthlyBudgets` array (0 or 1 entries)
 */
const findActiveServicePOsWithBudget = async (month, year, companyId) => {
  return ServicePO.findAll({
    where: { status: { [Op.in]: ACTIVE_PO_STATUSES }, is_deleted: false, company_id: companyId },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
      {
        model: ServicePOMonthlyBudget,
        as: 'monthlyBudgets',
        where: { month, year },
        required: false,
      },
    ],
    attributes: ['id', 'service_po_code', 'service_po_name', 'is_billable', 'status'],
    order: [['service_po_name', 'ASC']],
  });
};

/**
 * Insert a new monthly budget record.
 *
 * @param {object} data
 * @returns {Promise<ServicePOMonthlyBudget>}
 */
const create = async (data) => {
  return ServicePOMonthlyBudget.create(data);
};

/**
 * Update an existing monthly budget record by primary key.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @returns {Promise<ServicePOMonthlyBudget|null>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await ServicePOMonthlyBudget.update(data, {
    where: { id, company_id: companyId },
    returning: true,
  });

  return affectedRows === 0 ? null : updated;
};

module.exports = {
  findOne,
  findById,
  findActiveServicePOsWithBudget,
  create,
  update,
};
