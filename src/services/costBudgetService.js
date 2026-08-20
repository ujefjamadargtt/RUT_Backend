'use strict';

const costBudgetRepository = require('../repositories/costBudgetRepository');
const servicePORepository = require('../repositories/servicePORepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { parseMonthString, toMonthString } = require('../helpers/monthPeriodHelper');
const logger = require('../utils/logger');

/**
 * Cost Budget Service
 * Business logic for the Cost Budget Master (month-wise Invoice Amount per
 * Service PO) — see database/migrations/20260858_create_cost_budget_master.sql.
 * Isolated from the existing service_po_monthly_budgets feature.
 */

const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Confirm a Service PO exists and belongs to the caller's company.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<ServicePO>}
 */
async function assertServicePOExists(servicePOId, companyId) {
  const po = await servicePORepository.findById(servicePOId, companyId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  return po;
}

/**
 * @param {CostBudget} record
 * @returns {object}
 */
function toResponse(record) {
  const json = record.toJSON();
  return {
    id: json.id,
    service_po_id: json.service_po_id,
    service_po_code: json.servicePO ? json.servicePO.service_po_code : null,
    service_po_name: json.servicePO ? json.servicePO.service_po_name : null,
    client: json.servicePO && json.servicePO.client
      ? { id: json.servicePO.client.id, client_code: json.servicePO.client.client_code, client_name: json.servicePO.client.client_name }
      : null,
    month: toMonthString(json.month, json.year),
    invoice_amount: round2(json.invoice_amount),
    description: json.description,
    status: json.status,
    created_at: json.created_at,
    updated_at: json.updated_at,
  };
}

/**
 * POST /cost-budgets — create.
 * @param {object} data - { service_po_id, month: "YYYY-MM", invoice_amount, description }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>}
 */
const create = async (data, userId, req) => {
  const companyId = req.companyId;
  const { service_po_id } = data;
  const { month, year } = parseMonthString(data.month);

  await assertServicePOExists(service_po_id, companyId);

  const existing = await costBudgetRepository.findOne(service_po_id, month, year, companyId);
  if (existing) {
    const err = new Error(
      `A cost budget record already exists for this Service PO and month (${data.month}).`
    );
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    service_po_id,
    month,
    year,
    invoice_amount: round2(data.invoice_amount),
    description: data.description ?? null,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const record = await costBudgetRepository.create(payload);
  await createAuditLog(userId, 'CREATE', 'cost_budget_master', record.id, null, payload, req ? getIpAddress(req) : null);
  logger.info('Cost budget created', { servicePOId: service_po_id, month: data.month, userId });

  const withAssociations = await costBudgetRepository.findById(record.id, companyId);
  return toResponse(withAssociations);
};

/**
 * PUT /cost-budgets/:id — update invoice_amount/description. The Service PO
 * and month are immutable via update (deactivate + create a new record to
 * move a budget to a different Service PO/month).
 * @param {number} id
 * @param {object} data - { invoice_amount, description }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>}
 */
const update = async (id, data, userId, req) => {
  const companyId = req.companyId;

  const existing = await costBudgetRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Cost budget record not found.');
    err.statusCode = 404;
    throw err;
  }

  const oldValues = { invoice_amount: existing.invoice_amount, description: existing.description };
  const payload = {
    invoice_amount: round2(data.invoice_amount),
    description: data.description ?? null,
    updated_by: userId,
  };

  await costBudgetRepository.update(id, payload, companyId);
  await createAuditLog(userId, 'UPDATE', 'cost_budget_master', id, oldValues, payload, req ? getIpAddress(req) : null);
  logger.info('Cost budget updated', { id, userId });

  const updated = await costBudgetRepository.findById(id, companyId);
  return toResponse(updated);
};

/**
 * DELETE /cost-budgets/:id — soft deactivate (status='inactive'), matching
 * this project's mapping-table soft-delete convention.
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deactivate = async (id, userId, req) => {
  const companyId = req.companyId;

  const existing = await costBudgetRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Cost budget record not found.');
    err.statusCode = 404;
    throw err;
  }

  await costBudgetRepository.update(id, { status: 'inactive', updated_by: userId }, companyId);
  await createAuditLog(userId, 'DELETE', 'cost_budget_master', id, { status: existing.status }, { status: 'inactive' }, req ? getIpAddress(req) : null);
  logger.info('Cost budget deactivated', { id, userId });
};

/**
 * GET /cost-budgets/service-po/:servicePoId — every monthly record for one
 * Service PO.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<object[]>}
 */
const listByServicePO = async (servicePOId, companyId) => {
  await assertServicePOExists(servicePOId, companyId);
  const records = await costBudgetRepository.findByServicePO(servicePOId, companyId);
  return records.map(toResponse);
};

/**
 * GET /cost-budgets — filtered list (service_po_id and/or month, both optional).
 * @param {object} query - { service_po_id?, month? } (month is "YYYY-MM")
 * @param {number} companyId
 * @returns {Promise<object[]>}
 */
const list = async (query, companyId) => {
  const filters = {};
  if (query.service_po_id !== undefined) filters.service_po_id = query.service_po_id;
  if (query.month !== undefined) {
    const { month, year } = parseMonthString(query.month);
    filters.month = month;
    filters.year = year;
  }

  const records = await costBudgetRepository.findAll(filters, companyId);
  return records.map(toResponse);
};

module.exports = {
  create,
  update,
  deactivate,
  listByServicePO,
  list,
};
