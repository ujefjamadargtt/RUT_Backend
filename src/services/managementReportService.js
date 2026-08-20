'use strict';

const managementReportRepo = require('../repositories/managementReportRepository');
const { Company } = require('../models');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Management Report Service
 * Orchestrates the 10 new management/business reports approved on top of
 * cost_budget_master / resource_budget_master. Mirrors reportService.js's
 * conventions (shared filter parsing, pagination, page-level summaries).
 */

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

function requireMonthYear(filters) {
  if (!filters.month || !filters.year) {
    const err = new Error('month and year query parameters are required for this report.');
    err.statusCode = 422;
    throw err;
  }
  if (filters.month < 1 || filters.month > 12) {
    const err = new Error('month must be between 1 and 12.');
    err.statusCode = 422;
    throw err;
  }
}

function parseCommonFilters(query) {
  return {
    search: query.search ? String(query.search).trim() : undefined,
    sortBy: query.sortBy ? String(query.sortBy).trim() : undefined,
    sortOrder: query.sortOrder && ['ASC', 'DESC'].includes(String(query.sortOrder).toUpperCase())
      ? String(query.sortOrder).toUpperCase()
      : undefined,
    month: query.month ? parseInt(query.month, 10) : undefined,
    year: query.year ? parseInt(query.year, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    status: query.status || undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };
}

// ---------------------------------------------------------------------------
// 1. Service PO Profitability (Margin) Report
// ---------------------------------------------------------------------------
async function getServicePOProfitability(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const isBillable = query.isBillable !== undefined
    ? query.isBillable === 'true' || query.isBillable === true
    : undefined;
  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;

  logger.info('ManagementReport: getServicePOProfitability', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getServicePOProfitability({
    ...filters, isBillable, serviceCategoryId, serviceTypeId, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.total_invoiced += parseFloat(r.invoiced_amount) || 0;
    acc.total_delivery_cost += parseFloat(r.delivery_cost) || 0;
    acc.total_margin += parseFloat(r.margin) || 0;
    return acc;
  }, { total_invoiced: 0, total_delivery_cost: 0, total_margin: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_invoiced_amount: round2(totals.total_invoiced),
      total_delivery_cost: round2(totals.total_delivery_cost),
      total_margin: round2(totals.total_margin),
      overall_margin_pct: totals.total_invoiced > 0 ? round2((totals.total_margin / totals.total_invoiced) * 100) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Budgeted Margin Forecast Report
// ---------------------------------------------------------------------------
async function getBudgetedMarginForecast(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  logger.info('ManagementReport: getBudgetedMarginForecast', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getBudgetedMarginForecast({
    ...filters, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.total_revenue += parseFloat(r.budgeted_revenue) || 0;
    acc.total_cost += parseFloat(r.budgeted_cost) || 0;
    acc.total_margin += parseFloat(r.forecasted_margin) || 0;
    return acc;
  }, { total_revenue: 0, total_cost: 0, total_margin: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_budgeted_revenue: round2(totals.total_revenue),
      total_budgeted_cost: round2(totals.total_cost),
      total_forecasted_margin: round2(totals.total_margin),
      overall_forecasted_margin_pct: totals.total_revenue > 0 ? round2((totals.total_margin / totals.total_revenue) * 100) : null,
    },
    note: 'cost_budget_master and resource_budget_master are newly introduced tables with no historical rows — this report will be empty for a PO/month until its future budget has been entered via POST /cost-budgets and /resource-budgets.',
  };
}

// ---------------------------------------------------------------------------
// 3. Resource Staffing Plan Accuracy Report
// ---------------------------------------------------------------------------
async function getResourceStaffingPlanAccuracy(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;
  const varianceThresholdPct = query.varianceThresholdPct ? parseFloat(query.varianceThresholdPct) : 20;

  logger.info('ManagementReport: getResourceStaffingPlanAccuracy', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getResourceStaffingPlanAccuracy({
    ...filters, employeeId, limit, offset, companyId,
  });

  const enriched = rows.map((r) => ({
    ...r,
    at_risk: r.variance_pct !== null && Math.abs(parseFloat(r.variance_pct)) >= varianceThresholdPct,
  }));

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.planned += parseFloat(r.planned_hours) || 0;
    acc.actual += parseFloat(r.actual_hours) || 0;
    return acc;
  }, { planned: 0, actual: 0 });

  return {
    data: enriched,
    meta,
    summary: {
      total_planned_hours: round2(totals.planned),
      total_actual_hours: round2(totals.actual),
      total_variance_hours: round2(totals.actual - totals.planned),
      variance_threshold_pct_used: varianceThresholdPct,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Client Profitability & Revenue Concentration Report
// ---------------------------------------------------------------------------
async function getClientProfitabilityConcentration(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  logger.info('ManagementReport: getClientProfitabilityConcentration', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getClientProfitabilityConcentration({
    ...filters, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.invoiced += parseFloat(r.total_invoiced) || 0;
    acc.cost += parseFloat(r.total_delivery_cost) || 0;
    acc.margin += parseFloat(r.total_margin) || 0;
    return acc;
  }, { invoiced: 0, cost: 0, margin: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_invoiced_amount: round2(totals.invoiced),
      total_delivery_cost: round2(totals.cost),
      total_margin: round2(totals.margin),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. BU (Company) Performance Scorecard — Entity Admin / Admin only
// ---------------------------------------------------------------------------
async function getBUPerformanceScorecard(query, req) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const entityIds = req.entityIds || [];
  if (entityIds.length === 0) {
    return { data: [], meta: getPaginationMeta(0, page, limit), summary: { total_invoiced_amount: 0, total_delivery_cost: 0, total_margin: 0 } };
  }

  const where = { entity_id: entityIds, is_deleted: false };
  if (query.companyId) where.id = parseInt(query.companyId, 10);

  const companies = await Company.findAll({ where, attributes: ['id'] });
  const companyIds = companies.map((c) => c.id);

  logger.info('ManagementReport: getBUPerformanceScorecard', { filters, entityIds, companyIds: companyIds.length, page, limit });

  const { rows, count } = await managementReportRepo.getBUPerformanceScorecard({
    ...filters, companyIds, limit, offset,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.invoiced += parseFloat(r.total_invoiced) || 0;
    acc.cost += parseFloat(r.total_delivery_cost) || 0;
    acc.margin += parseFloat(r.total_margin) || 0;
    return acc;
  }, { invoiced: 0, cost: 0, margin: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_invoiced_amount: round2(totals.invoiced),
      total_delivery_cost: round2(totals.cost),
      total_margin: round2(totals.margin),
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Employee Capacity & Bench Forecast Report
// ---------------------------------------------------------------------------
async function getEmployeeCapacityForecast(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;
  const designation = query.designation ? String(query.designation).trim() : undefined;
  const benchThresholdHours = query.benchThresholdHours;

  logger.info('ManagementReport: getEmployeeCapacityForecast', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getEmployeeCapacityForecast({
    ...filters, employeeId, designation, benchThresholdHours, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const benchCount = rows.filter((r) => r.bench_flag).length;
  const overallocatedCount = rows.filter((r) => r.overallocation_flag).length;

  return {
    data: rows,
    meta,
    summary: {
      bench_risk_count_on_page: benchCount,
      overallocated_count_on_page: overallocatedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Service PO Budget & Timeline Exhaustion Risk Report
// ---------------------------------------------------------------------------
function computeTimelineRisk(row, asOfDate) {
  const start = new Date(row.start_date);
  const end = new Date(row.end_date);
  const totalDays = Math.max(1, Math.round((end - start) / 86400000));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.round((asOfDate - start) / 86400000)));
  const elapsedPct = round2((elapsedDays / totalDays) * 100);

  const expectedHours = parseFloat(row.expected_man_hours) || 0;
  const deliveredHours = parseFloat(row.hours_delivered_to_date) || 0;
  const consumedPct = expectedHours > 0 ? round2((deliveredHours / expectedHours) * 100) : null;

  let riskLevel = 'on_track';
  const isOverdue = asOfDate > end && !['completed', 'closed', 'cancelled'].includes(row.status);
  if (isOverdue) {
    riskLevel = 'overdue';
  } else if (consumedPct !== null) {
    const gap = consumedPct - elapsedPct;
    if (deliveredHours > expectedHours || gap > 20) riskLevel = 'critical';
    else if (gap > 10) riskLevel = 'at_risk';
  }

  let projectedExhaustionDate = null;
  if (elapsedDays > 0 && deliveredHours > 0 && expectedHours > deliveredHours) {
    const burnRatePerDay = deliveredHours / elapsedDays;
    if (burnRatePerDay > 0) {
      const remainingHours = expectedHours - deliveredHours;
      const daysToExhaust = Math.ceil(remainingHours / burnRatePerDay);
      const projected = new Date(asOfDate.getTime() + daysToExhaust * 86400000);
      projectedExhaustionDate = projected.toISOString().slice(0, 10);
    }
  }

  return {
    ...row,
    elapsed_time_pct: elapsedPct,
    consumed_hours_pct: consumedPct,
    risk_level: riskLevel,
    // Linear extrapolation of the current burn rate — an ESTIMATE, not a
    // guaranteed date. Null when there isn't enough burn history yet.
    projected_exhaustion_date: projectedExhaustionDate,
  };
}

async function getServicePOTimelineRisk(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  const asOfDate = query.asOfDate ? new Date(query.asOfDate) : new Date();
  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;

  logger.info('ManagementReport: getServicePOTimelineRisk', { filters, asOfDate, page, limit });

  const { rows, count } = await managementReportRepo.getServicePOTimelineRiskRaw({
    ...filters, clientId, poId, limit, offset, companyId,
  });

  const enriched = rows.map((r) => computeTimelineRisk(r, asOfDate));
  const meta = getPaginationMeta(count, page, limit);

  return {
    data: enriched,
    meta,
    summary: {
      overdue_count_on_page: enriched.filter((r) => r.risk_level === 'overdue').length,
      critical_count_on_page: enriched.filter((r) => r.risk_level === 'critical').length,
      at_risk_count_on_page: enriched.filter((r) => r.risk_level === 'at_risk').length,
    },
    as_of_date: asOfDate.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// 8. Delivery Head / Account Owner Performance Report
// ---------------------------------------------------------------------------
async function getDeliveryHeadPerformance(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const deliveryHeadEmployeeId = query.deliveryHeadEmployeeId ? parseInt(query.deliveryHeadEmployeeId, 10) : undefined;

  logger.info('ManagementReport: getDeliveryHeadPerformance', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getDeliveryHeadPerformance({
    ...filters, deliveryHeadEmployeeId, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.invoiced += parseFloat(r.total_invoiced) || 0;
    acc.cost += parseFloat(r.total_delivery_cost) || 0;
    acc.margin += parseFloat(r.total_margin) || 0;
    acc.atRisk += parseInt(r.at_risk_po_count, 10) || 0;
    return acc;
  }, { invoiced: 0, cost: 0, margin: 0, atRisk: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_invoiced_amount: round2(totals.invoiced),
      total_delivery_cost: round2(totals.cost),
      total_margin: round2(totals.margin),
      total_at_risk_po_count: totals.atRisk,
    },
  };
}

// ---------------------------------------------------------------------------
// 9. Invoice Realization / Billing Efficiency Report
// ---------------------------------------------------------------------------
async function getInvoiceRealizationTrend(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  let { startMonth, startYear, endMonth, endYear } = query;
  if (!startMonth && filters.month && filters.year) {
    startMonth = filters.month; startYear = filters.year;
    endMonth = filters.month; endYear = filters.year;
  }
  if (!startMonth || !startYear || !endMonth || !endYear) {
    const err = new Error('Provide either (month & year) or (startMonth, startYear, endMonth, endYear).');
    err.statusCode = 422;
    throw err;
  }

  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;

  logger.info('ManagementReport: getInvoiceRealizationTrend', { startMonth, startYear, endMonth, endYear, page, limit });

  const { rows, count } = await managementReportRepo.getInvoiceRealizationTrend({
    ...filters,
    startMonth: parseInt(startMonth, 10),
    startYear: parseInt(startYear, 10),
    endMonth: parseInt(endMonth, 10),
    endYear: parseInt(endYear, 10),
    clientId, poId, limit, offset, companyId,
  });

  const meta = getPaginationMeta(count, page, limit);
  const totals = rows.reduce((acc, r) => {
    acc.invoiced += parseFloat(r.total_invoiced) || 0;
    acc.billed += parseFloat(r.total_billed) || 0;
    acc.unbilled += parseFloat(r.total_unbilled) || 0;
    return acc;
  }, { invoiced: 0, billed: 0, unbilled: 0 });

  return {
    data: rows,
    meta,
    summary: {
      total_invoiced_amount: round2(totals.invoiced),
      total_billed_amount: round2(totals.billed),
      total_unbilled_amount: round2(totals.unbilled),
    },
    note: 'months_outstanding counts months in the selected range with unbilled > 0 — the schema has no invoice due-date/payment-date field, so true days-overdue AR aging cannot be computed.',
  };
}

// ---------------------------------------------------------------------------
// 10. Service Line (Category/Type) Business Mix Report
// ---------------------------------------------------------------------------
async function getServiceLineBusinessMix(query, companyId) {
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const compareMonth = query.compareMonth ? parseInt(query.compareMonth, 10) : undefined;
  const compareYear = query.compareYear ? parseInt(query.compareYear, 10) : undefined;

  logger.info('ManagementReport: getServiceLineBusinessMix', { filters, compareMonth, compareYear });

  const { rows, priorRows } = await managementReportRepo.getServiceLineBusinessMix({
    ...filters, serviceCategoryId, serviceTypeId, compareMonth, compareYear, companyId,
  });

  const priorByType = new Map(priorRows.map((r) => [r.service_type_id, r]));
  const enriched = rows.map((r) => {
    const prior = priorByType.get(r.service_type_id);
    const growthPct = prior && parseFloat(prior.invoiced_amount) > 0
      ? round2(((parseFloat(r.invoiced_amount) - parseFloat(prior.invoiced_amount)) / parseFloat(prior.invoiced_amount)) * 100)
      : null;
    return { ...r, revenue_growth_pct: growthPct };
  });

  const totals = enriched.reduce((acc, r) => {
    acc.hours += parseFloat(r.hours_delivered) || 0;
    acc.cost += parseFloat(r.delivery_cost) || 0;
    acc.invoiced += parseFloat(r.invoiced_amount) || 0;
    acc.margin += parseFloat(r.margin) || 0;
    return acc;
  }, { hours: 0, cost: 0, invoiced: 0, margin: 0 });

  return {
    data: enriched,
    summary: {
      total_hours_delivered: round2(totals.hours),
      total_delivery_cost: round2(totals.cost),
      total_invoiced_amount: round2(totals.invoiced),
      total_margin: round2(totals.margin),
    },
    comparison_period: compareMonth && compareYear ? { month: compareMonth, year: compareYear } : null,
  };
}

module.exports = {
  getServicePOProfitability,
  getBudgetedMarginForecast,
  getResourceStaffingPlanAccuracy,
  getClientProfitabilityConcentration,
  getBUPerformanceScorecard,
  getEmployeeCapacityForecast,
  getServicePOTimelineRisk,
  getDeliveryHeadPerformance,
  getInvoiceRealizationTrend,
  getServiceLineBusinessMix,
};
