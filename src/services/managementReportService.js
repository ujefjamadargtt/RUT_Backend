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

/**
 * Case-insensitive query-param lookup — some frontend callers send a
 * threshold param in a different case than the one this API documents
 * (e.g. `benchthresholdhours` instead of `benchThresholdHours`). Express's
 * req.query keys are exact-match only, so `query.benchThresholdHours` was
 * silently undefined whenever the caller sent the lowercase form, and the
 * report fell back to its default threshold instead of the one actually
 * requested. This does not rename or add any parameter — it just lets the
 * one documented name be read regardless of the casing it arrives in.
 *
 * @param {object} query
 * @param {string} name - the documented/canonical param name
 * @returns {*} the raw value, or undefined if not present in any casing
 */
function getParamCaseInsensitive(query, name) {
  if (query[name] !== undefined) return query[name];
  const lowerName = name.toLowerCase();
  const key = Object.keys(query).find((k) => k.toLowerCase() === lowerName);
  return key !== undefined ? query[key] : undefined;
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
async function getServicePOProfitability(query, companyIds) {
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
    ...filters, isBillable, serviceCategoryId, serviceTypeId, limit, offset, companyIds,
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
async function getBudgetedMarginForecast(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  logger.info('ManagementReport: getBudgetedMarginForecast', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getBudgetedMarginForecast({
    ...filters, limit, offset, companyIds,
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
async function getResourceStaffingPlanAccuracy(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;

  // A raw value present (including 0) means the caller explicitly asked to
  // filter by it — apply it at the SQL level, before pagination, so
  // `meta.total`/the returned page both reflect the filtered set. Absent
  // entirely, behavior is unchanged from before this fix: every row is
  // returned, each merely annotated with `at_risk` computed against the
  // display default of 20%.
  const rawVarianceThresholdPct = getParamCaseInsensitive(query, 'varianceThresholdPct');
  const varianceThresholdPctFilter = rawVarianceThresholdPct !== undefined && rawVarianceThresholdPct !== ''
    ? parseFloat(rawVarianceThresholdPct)
    : undefined;
  const varianceThresholdPctForFlag = varianceThresholdPctFilter !== undefined ? varianceThresholdPctFilter : 20;

  logger.info('ManagementReport: getResourceStaffingPlanAccuracy', { filters, varianceThresholdPctFilter, page, limit });

  const { rows, count } = await managementReportRepo.getResourceStaffingPlanAccuracy({
    ...filters, employeeId, varianceThresholdPct: varianceThresholdPctFilter, limit, offset, companyIds,
  });

  // Same "at risk" formula the filter itself now applies in SQL (absolute
  // variance %, >= threshold) — kept here only to annotate each already-
  // filtered row for display, never to re-filter.
  const enriched = rows.map((r) => ({
    ...r,
    at_risk: r.variance_pct !== null && Math.abs(parseFloat(r.variance_pct)) >= varianceThresholdPctForFlag,
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
      variance_threshold_pct_used: varianceThresholdPctForFlag,
      variance_threshold_filter_applied: varianceThresholdPctFilter !== undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Client Profitability & Revenue Concentration Report
// ---------------------------------------------------------------------------
async function getClientProfitabilityConcentration(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  logger.info('ManagementReport: getClientProfitabilityConcentration', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getClientProfitabilityConcentration({
    ...filters, limit, offset, companyIds,
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
async function getEmployeeCapacityForecast(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;
  const designation = query.designation ? String(query.designation).trim() : undefined;
  // Frontend sends this as `benchthresholdhours` (all lowercase); reading it
  // case-insensitively is what actually lets the requested value reach the
  // query at all — see getParamCaseInsensitive's doc comment.
  const rawBenchThresholdHours = getParamCaseInsensitive(query, 'benchThresholdHours');
  const benchThresholdHours = rawBenchThresholdHours !== undefined && rawBenchThresholdHours !== ''
    ? rawBenchThresholdHours
    : undefined;

  logger.info('ManagementReport: getEmployeeCapacityForecast', { filters, benchThresholdHours, page, limit });

  const { rows, count } = await managementReportRepo.getEmployeeCapacityForecast({
    ...filters, employeeId, designation, benchThresholdHours, limit, offset, companyIds,
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
// 7. Service PO Timeline Risk Report — date-elapsed risk only
//    (on_track/overdue). The hours-budget dimension this report used to
//    also cover (consumed_hours_pct, at_risk/critical levels,
//    projected_exhaustion_date) required service_pos.expected_man_hours,
//    which was retired — see database/migrations/
//    20260884_drop_service_pos_invoice_amount_and_expected_man_hours.sql.
// ---------------------------------------------------------------------------
function computeTimelineRisk(row, asOfDate) {
  const start = new Date(row.start_date);
  const end = new Date(row.end_date);
  const totalDays = Math.max(1, Math.round((end - start) / 86400000));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.round((asOfDate - start) / 86400000)));
  const elapsedPct = round2((elapsedDays / totalDays) * 100);

  // Date-elapsed risk only — the hours-budget dimension (consumed_hours_pct,
  // at_risk/critical levels, projected_exhaustion_date) required an
  // expected-hours target, which no longer exists on Service PO.
  const isOverdue = asOfDate > end && !['completed', 'closed', 'cancelled'].includes(row.status);
  const riskLevel = isOverdue ? 'overdue' : 'on_track';

  return {
    ...row,
    elapsed_time_pct: elapsedPct,
    risk_level: riskLevel,
  };
}

async function getServicePOTimelineRisk(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  // This report's own 5 documented filters (asOfDate/status/clientId/poId/
  // search) were read with exact-case `query.X` lookups — silently
  // undefined whenever the caller sent a different casing (e.g.
  // `clientid`/`poid`/`asofdate`), the same class of bug already confirmed
  // for `benchThresholdHours` in getEmployeeCapacityForecast (that
  // frontend integration sends multi-word params in one lowercase run).
  // Reading case-insensitively here fixes it without touching
  // parseCommonFilters, which every other report also depends on.
  const rawAsOfDate = getParamCaseInsensitive(query, 'asOfDate');
  const asOfDate = rawAsOfDate ? new Date(rawAsOfDate) : new Date();

  const rawClientId = getParamCaseInsensitive(query, 'clientId');
  const clientId = rawClientId ? parseInt(rawClientId, 10) : undefined;

  const rawPoId = getParamCaseInsensitive(query, 'poId');
  const poId = rawPoId ? parseInt(rawPoId, 10) : undefined;

  const rawStatus = getParamCaseInsensitive(query, 'status');
  const status = rawStatus || undefined;

  const rawSearch = getParamCaseInsensitive(query, 'search');
  const search = rawSearch ? String(rawSearch).trim() : undefined;

  logger.info('ManagementReport: getServicePOTimelineRisk', { clientId, poId, status, search, asOfDate, page, limit });

  const { rows, count } = await managementReportRepo.getServicePOTimelineRiskRaw({
    ...filters, clientId, poId, status, search, limit, offset, companyIds,
  });

  const enriched = rows.map((r) => computeTimelineRisk(r, asOfDate));
  const meta = getPaginationMeta(count, page, limit);

  return {
    data: enriched,
    meta,
    summary: {
      overdue_count_on_page: enriched.filter((r) => r.risk_level === 'overdue').length,
    },
    as_of_date: asOfDate.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// 8. Delivery Head / Account Owner Performance Report
// ---------------------------------------------------------------------------
async function getDeliveryHeadPerformance(query, companyIds) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const deliveryHeadEmployeeId = query.deliveryHeadEmployeeId ? parseInt(query.deliveryHeadEmployeeId, 10) : undefined;

  logger.info('ManagementReport: getDeliveryHeadPerformance', { filters, page, limit });

  const { rows, count } = await managementReportRepo.getDeliveryHeadPerformance({
    ...filters, deliveryHeadEmployeeId, limit, offset, companyIds,
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
// 9. Invoice Realization / Billing Efficiency Report
// ---------------------------------------------------------------------------
async function getInvoiceRealizationTrend(query, companyIds) {
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
    clientId, poId, limit, offset, companyIds,
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
async function getServiceLineBusinessMix(query, companyIds) {
  const filters = parseCommonFilters(query);
  requireMonthYear(filters);

  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const compareMonth = query.compareMonth ? parseInt(query.compareMonth, 10) : undefined;
  const compareYear = query.compareYear ? parseInt(query.compareYear, 10) : undefined;

  logger.info('ManagementReport: getServiceLineBusinessMix', { filters, compareMonth, compareYear });

  const { rows, priorRows } = await managementReportRepo.getServiceLineBusinessMix({
    ...filters, serviceCategoryId, serviceTypeId, compareMonth, compareYear, companyIds,
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
