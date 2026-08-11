'use strict';

const moment = require('moment-timezone');
const servicePOMonthlyBudgetRepository = require('../repositories/servicePOMonthlyBudgetRepository');
const servicePORepository = require('../repositories/servicePORepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const dateHelper = require('../helpers/dateHelper');
const { getDeadlineInfo } = require('../config/servicePOMonthlyBudget.config');
const logger = require('../utils/logger');

/**
 * Service PO Monthly Budget Service
 * Business logic for the Service PO Manager's month-wise Invoice Amount /
 * Billed Amount master (see database/migrations/20260853_*.sql).
 */

const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Confirm a Service PO exists and belongs to the caller's company.
 * findById() is already company-scoped, so a PO from another company simply
 * 404s here, same as a genuinely missing id.
 *
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
 * GET /service-po-monthly-budgets — fetch the single record for one Service
 * PO in one month/year.
 *
 * @param {object} query - { service_po_id, month, year }
 * @param {number} companyId
 * @returns {Promise<ServicePOMonthlyBudget>}
 */
const getOne = async (query, companyId) => {
  const { service_po_id, month, year } = query;

  await assertServicePOExists(service_po_id, companyId);

  const record = await servicePOMonthlyBudgetRepository.findOne(service_po_id, month, year, companyId);
  if (!record) {
    const err = new Error('Service PO monthly budget not found.');
    err.statusCode = 404;
    throw err;
  }

  return record;
};

/**
 * GET /service-po-monthly-budgets/current — everything the Service PO
 * Manager screen needs for the CURRENT server month/year: the deadline
 * status plus every active Service PO's existing entry (or defaulted-to-zero
 * placeholder when nothing has been filled in yet).
 *
 * @param {number} companyId
 * @returns {Promise<object>}
 */
const getCurrentMonth = async (companyId) => {
  const month = dateHelper.getCurrentMonth();
  const year = dateHelper.getCurrentYear();
  const monthName = moment.tz(dateHelper.DEFAULT_TZ).format('MMMM');

  const { deadline, days_remaining, deadline_passed } = getDeadlineInfo(month, year);

  const servicePOs = await servicePOMonthlyBudgetRepository.findActiveServicePOsWithBudget(month, year, companyId);

  const data = servicePOs.map((po) => {
    const budget = po.monthlyBudgets && po.monthlyBudgets[0];
    return {
      service_po_id: po.id,
      service_po_code: po.service_po_code,
      service_po_name: po.service_po_name,
      client: po.client ? { id: po.client.id, client_code: po.client.client_code, client_name: po.client.client_name } : null,
      invoice_amount: budget ? round2(budget.invoice_amount) : 0,
      invoice_description: budget ? budget.invoice_description : null,
      billed_amount: budget ? round2(budget.billed_amount) : 0,
      billed_remark: budget ? budget.billed_remark : null,
      updated_at: budget ? budget.updated_at : null,
    };
  });

  return {
    month,
    year,
    month_name: monthName,
    deadline,
    days_remaining,
    deadline_passed,
    service_pos: data,
  };
};

/**
 * POST /service-po-monthly-budgets — upsert (create or update) the record
 * for one Service PO + month/year, per the unique constraint on
 * (service_po_id, month, year).
 *
 * Editing after the deadline is ALLOWED (not blocked) — the deadline is a
 * data-completeness target for the Service PO Manager, not a hard cutoff;
 * the response still reports deadline_passed so the caller/UI can warn the
 * user. Centralizing this policy here means switching to a hard block later
 * is a one-place change (see getDeadlineInfo's doc comment).
 *
 * @param {object} data - { service_po_id, month, year, invoice_amount, invoice_description, billed_amount, billed_remark }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<{ record: ServicePOMonthlyBudget, deadline: object }>}
 */
const upsert = async (data, userId, req) => {
  const companyId = req.companyId;
  const { service_po_id, month, year } = data;

  await assertServicePOExists(service_po_id, companyId);

  const deadlineInfo = getDeadlineInfo(month, year);

  const existing = await servicePOMonthlyBudgetRepository.findOne(service_po_id, month, year, companyId);

  const payload = {
    service_po_id,
    month,
    year,
    invoice_amount: round2(data.invoice_amount),
    invoice_description: data.invoice_description ?? null,
    billed_amount: round2(data.billed_amount),
    billed_remark: data.billed_remark ?? null,
    company_id: companyId,
    updated_by: userId,
  };

  let record;
  let action;

  if (existing) {
    action = 'UPDATE';
    const oldValues = {
      invoice_amount: existing.invoice_amount,
      invoice_description: existing.invoice_description,
      billed_amount: existing.billed_amount,
      billed_remark: existing.billed_remark,
    };

    record = await servicePOMonthlyBudgetRepository.update(existing.id, payload, companyId);

    await createAuditLog(
      userId,
      'UPDATE',
      'service_po_monthly_budgets',
      existing.id,
      oldValues,
      payload,
      req ? getIpAddress(req) : null
    );
  } else {
    action = 'CREATE';
    payload.created_by = userId;
    record = await servicePOMonthlyBudgetRepository.create(payload);

    await createAuditLog(
      userId,
      'CREATE',
      'service_po_monthly_budgets',
      record.id,
      null,
      payload,
      req ? getIpAddress(req) : null
    );
  }

  logger.info('Service PO monthly budget upserted', { servicePOId: service_po_id, month, year, action, userId });

  const withAssociations = await servicePOMonthlyBudgetRepository.findById(record.id, companyId);

  return { record: withAssociations, deadline: deadlineInfo };
};

module.exports = {
  getOne,
  getCurrentMonth,
  upsert,
};
