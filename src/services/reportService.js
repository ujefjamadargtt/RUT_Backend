'use strict';

const reportRepo = require('../repositories/reportRepository');
const serviceCategoryRepo = require('../repositories/serviceCategoryRepository');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');
const dateHelper = require('../helpers/dateHelper');

/**
 * Report Service
 * Orchestrates repo calls, applies pagination, and shapes response data.
 */

/**
 * Parse and validate common query filters shared across most report endpoints.
 *
 * @param {object} query - Express req.query
 * @returns {object}
 */
function parseCommonFilters(query) {
  return {
    search: query.search ? String(query.search).trim() : undefined,
    sortBy: query.sortBy ? String(query.sortBy).trim() : undefined,
    sortOrder: query.sortOrder && ['ASC', 'DESC'].includes(query.sortOrder.toUpperCase())
      ? query.sortOrder.toUpperCase()
      : 'ASC',
    startDate: query.startDate || undefined,
    endDate: query.endDate || undefined,
    employeeId: query.employeeId ? parseInt(query.employeeId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    month: query.month ? parseInt(query.month, 10) : undefined,
    year: query.year ? parseInt(query.year, 10) : undefined,
    status: query.status || undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };
}

/**
 * Parse a multi-select ID filter from a query param. Accepts a single value
 * ("175"), a comma-separated list ("175,178,179"), or an array (repeated
 * query keys, e.g. employeeId=175&employeeId=178).
 *
 * @param {string|string[]|number|undefined} value
 * @returns {number[]|undefined} undefined when no usable ID was provided
 */
function parseIdList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const ids = raw
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => !isNaN(n));
  return ids.length > 0 ? ids : undefined;
}

/**
 * Employee Hourly Rate Report
 * Requires month and year filters.
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getEmployeeHourlyRate(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

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

  logger.info('Report: getEmployeeHourlyRate', { filters, page, limit });

  const { rows, count } = await reportRepo.getEmployeeHourlyRate({
    ...filters,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
}

/**
 * Monthly Cost Summary Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getMonthlyCostSummary(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  logger.info('Report: getMonthlyCostSummary', { filters, page, limit });

  const { rows, count } = await reportRepo.getMonthlyCostSummary({
    year: filters.year,
    month: filters.month,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  // Compute totals across the returned page for convenience
  const pageTotals = rows.reduce(
    (acc, row) => {
      acc.total_salary_cost += parseFloat(row.total_salary_cost) || 0;
      acc.total_ops_cost += parseFloat(row.total_ops_cost) || 0;
      acc.total_cost += parseFloat(row.total_cost) || 0;
      acc.total_billable_cost += parseFloat(row.total_billable_cost) || 0;
      return acc;
    },
    { total_salary_cost: 0, total_ops_cost: 0, total_cost: 0, total_billable_cost: 0 }
  );

  return {
    data: rows,
    meta,
    summary: {
      total_salary_cost: Math.round(pageTotals.total_salary_cost * 100) / 100,
      total_ops_cost: Math.round(pageTotals.total_ops_cost * 100) / 100,
      total_cost: Math.round(pageTotals.total_cost * 100) / 100,
      total_billable_cost: Math.round(pageTotals.total_billable_cost * 100) / 100,
    },
  };
}

/**
 * Timesheet Summary Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getTimesheetSummary(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  logger.info('Report: getTimesheetSummary', { filters, page, limit });

  const { rows, count } = await reportRepo.getTimesheetSummary({
    ...filters,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const pageTotalHours = rows.reduce(
    (acc, row) => acc + (parseFloat(row.hours_logged) || 0),
    0
  );

  return {
    data: rows,
    meta,
    summary: {
      total_hours_on_page: Math.round(pageTotalHours * 100) / 100,
    },
  };
}

/**
 * Service PO Utilisation Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getServicePOUtilisation(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  logger.info('Report: getServicePOUtilisation', { filters, page, limit });

  const { rows, count } = await reportRepo.getServicePOUtilisation({
    ...filters,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  // Classify utilisation for quick scanning
  const enriched = rows.map((row) => {
    const pct = parseFloat(row.utilisation_pct);
    let utilisation_status = 'no_data';
    if (!isNaN(pct)) {
      if (pct >= 100) utilisation_status = 'over_utilized';
      else if (pct >= 75) utilisation_status = 'on_track';
      else if (pct >= 50) utilisation_status = 'moderate';
      else utilisation_status = 'under_utilized';
    }
    return { ...row, utilisation_status };
  });

  return { data: enriched, meta };
}

/**
 * Sub-Project Hours Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getSubProjectHours(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  logger.info('Report: getSubProjectHours', { filters, page, limit });

  const { rows, count } = await reportRepo.getSubProjectHours({
    poId: filters.poId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    status: filters.status,
    search: filters.search,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const pageTotalHours = rows.reduce(
    (acc, row) => acc + (parseFloat(row.total_hours) || 0),
    0
  );

  return {
    data: rows,
    meta,
    summary: {
      total_hours_on_page: Math.round(pageTotalHours * 100) / 100,
    },
  };
}

/**
 * Shared pivot helper: converts flat employee × service_type repo rows into
 * per-employee objects with an `hours` map, billable/non-billable totals,
 * leave hours, and total utilization.
 *
 * @param {object[]} rawColumns - from repo (category_id, category_name, service_type_id, service_type_name)
 * @param {object[]} rawRows    - from repo (employee_id … service_type_id, category_id, hours)
 * @param {number}   count      - total distinct employee count
 * @param {number}   page
 * @param {number}   limit
 * @returns {{ columns, data, meta, summary }}
 */
function buildPivotResponse(rawColumns, rawRows, count, page, limit) {
  const round2 = (n) => Math.round(n * 100) / 100;

  // Column headers grouped by category
  const catMap = new Map();
  for (const col of rawColumns) {
    if (!catMap.has(col.category_id)) {
      catMap.set(col.category_id, {
        category_id:   col.category_id,
        category_name: col.category_name,
        service_types: [],
      });
    }
    catMap.get(col.category_id).service_types.push({
      id:   col.service_type_id,
      name: col.service_type_name,
    });
  }
  const columns = Array.from(catMap.values());

  // Identify billable category IDs and leave service type IDs by name
  const billableCategoryIds = new Set();
  const leaveServiceTypeIds = new Set();
  for (const col of rawColumns) {
    const catLower = col.category_name.toLowerCase();
    if (catLower.includes('billable') && !catLower.includes('non')) {
      billableCategoryIds.add(col.category_id);
    }
    const stLower = col.service_type_name.toLowerCase();
    if (stLower.includes('leave') || stLower.includes('vacation') || stLower.includes('holiday')) {
      leaveServiceTypeIds.add(col.service_type_id);
    }
  }

  // Pivot flat rows into per-employee objects.
  // All fields that are NOT pivot-specific are captured as employee fields so
  // extra columns (total_experience, clients, etc.) flow through automatically.
  const PIVOT_KEYS = new Set(['service_type_id', 'service_type_name', 'category_id', 'category_name', 'hours']);
  const empMap = new Map();
  for (const row of rawRows) {
    if (!empMap.has(row.employee_id)) {
      const empFields = {};
      for (const [k, v] of Object.entries(row)) {
        if (!PIVOT_KEYS.has(k)) empFields[k] = v;
      }
      empMap.set(row.employee_id, { ...empFields, hours: {} });
    }
    empMap.get(row.employee_id).hours[row.service_type_id] = parseFloat(row.hours) || 0;
  }

  // Compute per-employee totals
  const data = Array.from(empMap.values()).map((emp) => {
    let billable_total     = 0;
    let non_billable_total = 0;
    let leaves_hours       = 0;

    for (const col of rawColumns) {
      const h = emp.hours[col.service_type_id] || 0;
      if (billableCategoryIds.has(col.category_id)) {
        billable_total += h;
      } else {
        non_billable_total += h;
      }
      if (leaveServiceTypeIds.has(col.service_type_id)) {
        leaves_hours += h;
      }
    }

    const total_hours       = billable_total + non_billable_total;
    const total_utilization = total_hours - leaves_hours;

    return {
      ...emp,
      billable_total:     round2(billable_total),
      non_billable_total: round2(non_billable_total),
      total_hours:        round2(total_hours),
      leaves_hours:       round2(leaves_hours),
      total_utilization:  round2(total_utilization),
    };
  });

  const meta = getPaginationMeta(count, page, limit);

  const pageSummary = data.reduce(
    (acc, r) => {
      acc.billable_total     += r.billable_total;
      acc.non_billable_total += r.non_billable_total;
      acc.total_hours        += r.total_hours;
      acc.leaves_hours       += r.leaves_hours;
      acc.total_utilization  += r.total_utilization;
      return acc;
    },
    { billable_total: 0, non_billable_total: 0, total_hours: 0, leaves_hours: 0, total_utilization: 0 }
  );

  return {
    columns,
    data,
    meta,
    summary: {
      billable_total:     round2(pageSummary.billable_total),
      non_billable_total: round2(pageSummary.non_billable_total),
      total_hours:        round2(pageSummary.total_hours),
      leaves_hours:       round2(pageSummary.leaves_hours),
      total_utilization:  round2(pageSummary.total_utilization),
    },
  };
}

/**
 * Resource Allocation Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getResourceAllocation(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  const isBillable = query.isBillable !== undefined
    ? query.isBillable === 'true' || query.isBillable === true
    : undefined;
  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;

  logger.info('Report: getResourceAllocation', { filters, isBillable, serviceCategoryId, serviceTypeId, clientId, page, limit });

  const { rows, count } = await reportRepo.getResourceAllocation({
    employeeId: filters.employeeId,
    poId:       filters.poId,
    clientId,
    month:      filters.month,
    year:       filters.year,
    status:     filters.status,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    search:     filters.search,
    sortBy:     query.sortBy,
    sortOrder:  filters.sortOrder,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
}

/**
 * Operational Cost Breakdown Report
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getOperationalCostBreakdown(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

  logger.info('Report: getOperationalCostBreakdown', { filters, page, limit });

  const { rows, count } = await reportRepo.getOperationalCostBreakdown({
    year: filters.year,
    month: filters.month,
    employeeId: filters.employeeId,
    search: filters.search,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const pageTotals = rows.reduce(
    (acc, row) => {
      acc.salary_cost += parseFloat(row.salary_cost) || 0;
      acc.ops_cost += parseFloat(row.ops_cost) || 0;
      acc.total_cost += parseFloat(row.total_cost) || 0;
      acc.billable_cost += parseFloat(row.billable_cost) || 0;
      return acc;
    },
    { salary_cost: 0, ops_cost: 0, total_cost: 0, billable_cost: 0 }
  );

  return {
    data: rows,
    meta,
    summary: {
      total_salary_cost: Math.round(pageTotals.salary_cost * 100) / 100,
      total_ops_cost: Math.round(pageTotals.ops_cost * 100) / 100,
      total_cost: Math.round(pageTotals.total_cost * 100) / 100,
      total_billable_cost: Math.round(pageTotals.billable_cost * 100) / 100,
    },
  };
}

/**
 * Employee Utilization Summary Report
 * Requires month and year filters.
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object, summary: object }>}
 */
async function getEmployeeUtilizationSummary(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

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

  logger.info('Report: getEmployeeUtilizationSummary', { filters, page, limit });


  const { rows, count } = await reportRepo.getEmployeeUtilizationSummary({
    ...filters,
    sortBy: query.sortBy,
    sortOrder: filters.sortOrder,
    limit,
    offset,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const pageTotals = rows.reduce(
    (acc, row) => {
      acc.billable_total          += parseFloat(row.billable_total)          || 0;
      acc.non_billable_total      += parseFloat(row.non_billable_total)      || 0;
      acc.internal_support_hours  += parseFloat(row.internal_support_hours)  || 0;
      acc.team_management_hours   += parseFloat(row.team_management_hours)   || 0;
      acc.leaves_hours            += parseFloat(row.leaves_hours)            || 0;
      acc.lnd_hours               += parseFloat(row.lnd_hours)               || 0;
      acc.others_hours            += parseFloat(row.others_hours)            || 0;
      return acc;
    },
    {
      billable_total: 0, non_billable_total: 0, internal_support_hours: 0,
      team_management_hours: 0, leaves_hours: 0, lnd_hours: 0, others_hours: 0,
    }
  );

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    data: rows,
    meta,
    summary: {
      billable_total:         round2(pageTotals.billable_total),
      non_billable_total:     round2(pageTotals.non_billable_total),
      internal_support_hours: round2(pageTotals.internal_support_hours),
      team_management_hours:  round2(pageTotals.team_management_hours),
      leaves_hours:           round2(pageTotals.leaves_hours),
      lnd_hours:              round2(pageTotals.lnd_hours),
      others_hours:           round2(pageTotals.others_hours),
    },
  };
}

/**
 * Service PO Summary Report
 * Requires month and year. Returns one row per Service PO with hours delivered
 * before the selected month, available hours, and monthly billable amount.
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object, summary: object }>}
 */
async function getServicePOSummary(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

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

  const isBillable = query.is_billable !== undefined
    ? query.is_billable === 'true' || query.is_billable === true
    : undefined;

  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;

  logger.info('Report: getServicePOSummary', { filters, page, limit });

  const { rows, count } = await reportRepo.getServicePOSummary({
    month:      filters.month,
    year:       filters.year,
    status:     filters.status,
    clientId,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    poId,
    startDate:  filters.startDate,
    endDate:    filters.endDate,
    search:     filters.search,
    sortBy:     query.sortBy,
    sortOrder:  filters.sortOrder,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const round2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

  const pageTotals = rows.reduce(
    (acc, row) => {
      acc.total_po_value                += round2(row.po_value);
      acc.total_expected_man_hours      += round2(row.expected_man_hours);
      acc.total_hours_delivered         += round2(row.hours_delivered_before_month);
      acc.total_available_hours         += round2(row.available_hours);
      acc.total_monthly_billable_amount += round2(row.monthly_billable_amount);
      acc.total_invoiced_amount         += round2(row.invoiced_amount);
      acc.total_unbilled_amount         += round2(row.unbilled_amount);
      return acc;
    },
    {
      total_po_value: 0,
      total_expected_man_hours: 0,
      total_hours_delivered: 0,
      total_available_hours: 0,
      total_monthly_billable_amount: 0,
      total_invoiced_amount: 0,
      total_unbilled_amount: 0,
    }
  );

  return {
    data: rows,
    meta,
    summary: {
      total_po_value:                     round2(pageTotals.total_po_value),
      total_expected_man_hours:           round2(pageTotals.total_expected_man_hours),
      total_hours_delivered_before_month: round2(pageTotals.total_hours_delivered),
      total_available_hours:              round2(pageTotals.total_available_hours),
      total_monthly_billable_amount:      round2(pageTotals.total_monthly_billable_amount),
      total_invoiced_amount:              round2(pageTotals.total_invoiced_amount),
      total_unbilled_amount:              round2(pageTotals.total_unbilled_amount),
    },
  };
}

/**
 * Invoice PO Summary Report
 * Requires month and year. Same shape as getServicePOSummary, but
 * invoiced_amount/billed_amount/unbilled_amount are sourced from the
 * Service PO Monthly Budget master (service_po_monthly_budgets) instead of
 * being computed from timesheets/monthly_costs. This is a separate report
 * from Service PO Summary — its billing logic does not affect or share
 * state with getServicePOSummary.
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object, summary: object }>}
 */
async function getInvoicePOSummary(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = parseCommonFilters(query);

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

  const isBillable = query.is_billable !== undefined
    ? query.is_billable === 'true' || query.is_billable === true
    : undefined;

  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;

  logger.info('Report: getInvoicePOSummary', { filters, page, limit });

  const { rows, count } = await reportRepo.getInvoicePOSummary({
    month:      filters.month,
    year:       filters.year,
    status:     filters.status,
    clientId,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    poId,
    startDate:  filters.startDate,
    endDate:    filters.endDate,
    search:     filters.search,
    sortBy:     query.sortBy,
    sortOrder:  filters.sortOrder,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  const meta = getPaginationMeta(count, page, limit);

  const round2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

  const pageTotals = rows.reduce(
    (acc, row) => {
      acc.total_po_value                += round2(row.po_value);
      acc.total_expected_man_hours      += round2(row.expected_man_hours);
      acc.total_hours_delivered         += round2(row.hours_delivered_before_month);
      acc.total_available_hours         += round2(row.available_hours);
      acc.total_monthly_billable_amount += round2(row.monthly_billable_amount);
      acc.total_invoiced_amount         += round2(row.invoiced_amount);
      acc.total_billed_amount           += round2(row.billed_amount);
      acc.total_unbilled_amount         += round2(row.unbilled_amount);
      return acc;
    },
    {
      total_po_value: 0,
      total_expected_man_hours: 0,
      total_hours_delivered: 0,
      total_available_hours: 0,
      total_monthly_billable_amount: 0,
      total_invoiced_amount: 0,
      total_billed_amount: 0,
      total_unbilled_amount: 0,
    }
  );

  return {
    data: rows,
    meta,
    summary: {
      total_po_value:                     round2(pageTotals.total_po_value),
      total_expected_man_hours:           round2(pageTotals.total_expected_man_hours),
      total_hours_delivered_before_month: round2(pageTotals.total_hours_delivered),
      total_available_hours:              round2(pageTotals.total_available_hours),
      total_monthly_billable_amount:      round2(pageTotals.total_monthly_billable_amount),
      total_invoiced_amount:              round2(pageTotals.total_invoiced_amount),
      total_billed_amount:                round2(pageTotals.total_billed_amount),
      total_unbilled_amount:              round2(pageTotals.total_unbilled_amount),
    },
  };
}

/**
 * Resource Utilization Report — same pivot format as resource-allocation,
 * but month and year are required.
 *
 * @param {object} query - req.query (month, year required)
 * @returns {Promise<{ columns, data, meta, summary }>}
 */
async function getResourceUtilization(query, companyId) {
  const filters = parseCommonFilters(query);

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

  const { page, limit, offset } = getPaginationParams(query);

  logger.info('Report: getResourceUtilization', { filters, page, limit });

  const { columns: rawColumns, rows: rawRows, count } = await reportRepo.getResourceUtilization({
    month:      filters.month,
    year:       filters.year,
    employeeId: filters.employeeId,
    search:     filters.search,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  return buildPivotResponse(rawColumns, rawRows, count, page, limit);
}

/**
 * Monthly Resource Utilization Report
 * Full employee detail + dynamic service-type hours pivot for a given month/year.
 * Columns: Name, Designation, Total Experience, UVTech/GTT DATA (company_experience),
 *          Resource Description, Monthly Capacity (160), Monthly Billing Capacity (160),
 *          Client, [dynamic service-type columns], Billable Total, Non-Billable Total,
 *          Total Utilization (excl Leaves).
 *
 * @param {object} query - req.query (month, year required)
 * @returns {Promise<{ columns, data, meta, summary }>}
 */
async function getMonthlyResourceUtilization(query, companyId) {
  const filters = parseCommonFilters(query);

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

  const { page, limit, offset } = getPaginationParams(query);

  logger.info('Report: getMonthlyResourceUtilization', { filters, page, limit });

  const { columns: rawColumns, rows: rawRows, count } = await reportRepo.getMonthlyResourceUtilization({
    month:      filters.month,
    year:       filters.year,
    employeeId: filters.employeeId,
    search:     filters.search,
    limit,
    offset,
    hoursSource: filters.hoursSource,
    roleId: filters.roleId,
    companyId,
  });

  return buildPivotResponse(rawColumns, rawRows, count, page, limit);
}

async function getResourseProjectUtilizationReport(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);

  const now = new Date();
  const month = query.month ? parseInt(query.month, 10) : now.getMonth() + 1;
  const year = query.year ? parseInt(query.year, 10) : now.getFullYear();

  if (month < 1 || month > 12) {
    const err = new Error('month must be between 1 and 12.');
    err.statusCode = 422;
    throw err;
  }

  const filters = {
    month,
    year,

    search: query.search ? String(query.search).trim() : undefined,

    // employeeId(s) / clientId(s) / projectId(s) (or poId) are multi-select:
    // pass a single ID, a comma-separated list ("175,178,179"), or repeated
    // query keys. Both the singular and plural param names are accepted so
    // callers can use either convention (e.g. employeeId=1,2 or employeeIds=1,2).
    employeeIds: parseIdList(query.employeeIds ?? query.employeeId),
    employeeName: query.employeeName ? String(query.employeeName).trim() : undefined,

    clientIds: parseIdList(query.clientIds ?? query.clientId),
    clientName: query.clientName ? String(query.clientName).trim() : undefined,

    // poId is accepted as an alias for projectId — the Service PO id filter
    // is named poId on every other report/dashboard endpoint in this app.
    projectIds: parseIdList(query.projectIds ?? query.poId ?? query.projectId),
    projectName: query.projectName ? String(query.projectName).trim() : undefined,

    serviceTypeId: query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined,
    // serviceTypes is multi-select: pass a single ID, a comma-separated list,
    // or repeated query keys — same convention as employeeId/clientId/projectId.
    serviceTypeIds: parseIdList(query.serviceTypeIds ?? query.serviceTypes),
    projectType: query.projectType ? String(query.projectType).trim() : undefined,

    categoryId: query.categoryId ? parseInt(query.categoryId, 10) : undefined,
    category: query.category ? String(query.category).trim() : undefined,

    subProjectId: query.subProjectId ? parseInt(query.subProjectId, 10) : undefined,
    projectSubType: query.projectSubType ? String(query.projectSubType).trim() : undefined,

    limit,
    offset,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
    companyId,
  };

  logger.info('Report: getResourseProjectUtilizationReport', {
    filters,
    page,
    limit,
  });

  const { rows, costs, count } =
    await reportRepo.getResourseProjectUtilizationReport(filters);

  const costMap = new Map(
    costs.map((c) => [c.employee_id, parseFloat(c.total_cost) || 0])
  );

  const byEmployee = new Map();

  for (const row of rows) {
    if (!byEmployee.has(row.employee_id)) {
      byEmployee.set(row.employee_id, {
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        totalHours: 0,
        remarks: null,
        projects: [],
      });
    }

    const emp = byEmployee.get(row.employee_id);
    const hrs = parseFloat(row.project_hours) || 0;
    const rate = costMap.get(row.employee_id) || 0;

    emp.totalHours += hrs;

    emp.projects.push({
      client: row.client,
      projectName: row.project_name,
      projectType: row.project_type,
      projectSubType: row.project_sub_type,
      category: row.category,
      projectHours: hrs,
      billableAmount: row.is_billable
        ? Math.round(hrs * rate * 100) / 100
        : 0,
    });
  }

  const data = Array.from(byEmployee.values()).map((emp) => ({
    ...emp,
    totalHours: Math.round(emp.totalHours * 100) / 100,
  }));

  const meta = getPaginationMeta(count, page, limit);

  return {
    data,
    meta,
    month,
    year,
  };
}

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * Resolve exactly one filter mode — month+year XOR startDate+endDate — into
 * a concrete { startDate, endDate } range for getClientServicePOHoursReport.
 * Throws 422 on any ambiguous or incomplete combination.
 *
 * @param {object} query
 * @returns {{ startDate: string, endDate: string }}
 */
function resolveClientServicePODateRange(query) {
  const month = query.month !== undefined ? parseInt(query.month, 10) : undefined;
  const year = query.year !== undefined ? parseInt(query.year, 10) : undefined;
  const startDate = query.startDate || undefined;
  const endDate = query.endDate || undefined;

  const hasMonthYear = month !== undefined || year !== undefined;
  const hasRange = startDate !== undefined || endDate !== undefined;

  if (hasMonthYear && hasRange) {
    const err = new Error('Provide either month and year, or startDate and endDate — not both.');
    err.statusCode = 422;
    throw err;
  }
  if (!hasMonthYear && !hasRange) {
    const err = new Error('Provide either month and year, or startDate and endDate.');
    err.statusCode = 422;
    throw err;
  }

  if (hasMonthYear) {
    if (month === undefined || year === undefined || isNaN(month) || isNaN(year)) {
      const err = new Error('Both month and year are required together.');
      err.statusCode = 422;
      throw err;
    }
    if (month < 1 || month > 12) {
      const err = new Error('month must be between 1 and 12.');
      err.statusCode = 422;
      throw err;
    }
    return dateHelper.getMonthBounds(month, year);
  }

  if (!startDate || !endDate) {
    const err = new Error('Both startDate and endDate are required together.');
    err.statusCode = 422;
    throw err;
  }
  return { startDate, endDate };
}

/**
 * Client Service PO Hours Report — grouped by Client, each Client listing
 * all its Service POs with summed hours and a backend-computed
 * total_hrs_of_client. Independent of getAnalyticsClientByPO's Dashboard
 * chart (dashboardService.js) — does not call or alter it.
 *
 * @param {object} query - req.query (month+year XOR startDate+endDate required)
 * @param {number} companyId - req.companyId
 * @returns {Promise<Array<{ client_id, client_name, total_hrs_of_client, service_pos: Array }>>}
 */
async function getClientServicePOHoursReport(query, companyId) {
  const { startDate, endDate } = resolveClientServicePODateRange(query);

  const filters = {
    companyId,
    startDate,
    endDate,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    serviceTypeId: query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined,
    employeeId: query.employeeId ? parseInt(query.employeeId, 10) : undefined,
    status: query.status || undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };

  logger.info('Report: getClientServicePOHoursReport', { filters });

  const rows = await reportRepo.getClientServicePOHours(filters);

  const clientsById = new Map();
  for (const row of rows) {
    const clientId = row.client_id;
    if (!clientsById.has(clientId)) {
      clientsById.set(clientId, {
        client_id: clientId,
        client_name: row.client_name,
        total_hrs_of_client: 0,
        service_pos: [],
      });
    }
    const hours = round2(row.hours);
    const client = clientsById.get(clientId);
    client.service_pos.push({
      service_po_id: row.service_po_id,
      service_po_code: row.service_po_code,
      service_po_name: row.service_po_name,
      hours,
    });
    client.total_hrs_of_client = round2(client.total_hrs_of_client + hours);
  }

  return Array.from(clientsById.values());
}

// ── Trend/period helpers shared by the 5 new reports below, based on the
// Dashboard analytics/analytics2 endpoints (dashboardService.js) — kept as
// independent, isolated implementations (not calls into dashboardService.js)
// so these Reports stay correct even if the Dashboard's own shape changes,
// matching this file's own existing "separate, isolated implementation"
// convention (see getInvoicePOSummary's doc comment).

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function reportMonthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]}-${String(year).slice(2)}`;
}

/**
 * Every {year, month} pair spanning an inclusive date range, in order —
 * used to zero-fill trend series so a month with no activity still appears.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {{ year: number, month: number }[]}
 */
function monthsInDateRange(startDate, endDate) {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);

  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

// Keywords (case-insensitive substring match on service_po_name) that count
// as "bench" time — same rule as dashboardService.js's isBenchServiceType().
const BENCH_KEYWORDS = ['idle', 'bench'];
function isBenchServiceTypeReport(servicePOName) {
  const name = (servicePOName || '').toLowerCase();
  return BENCH_KEYWORDS.some((k) => name.includes(k));
}

/**
 * Client Cost Analytics Report — total hours/cost per client across the
 * entire dataset (unfiltered — matches Dashboard analytics2's
 * client_wise_cost_analytics report, which is deliberately never scoped by
 * period/employee/client/PO), a Top Clients by Cost ranking (paginated
 * independently via page/limit, default 15), and a per-client x
 * service-type-category cost matrix. Based on
 * dashboardService.js's buildClientWiseCostAnalytics()/
 * buildTopClientsByCost()/buildClientCategoryCostMatrix() — reproduced here
 * as an independent Reports Module implementation of the same business
 * logic (Invoice Master / service_po_monthly_budgets.billed_amount basis).
 *
 * @param {object} query - req.query: { hoursSource?, page?, limit? } (page/limit apply to top_clients only, default limit 15)
 * @param {number} companyId
 * @returns {Promise<{
 *   clients: { client_id: number, client_name: string, total_hours: number, total_cost: number }[],
 *   top_clients: { data: object[], pagination: { page: number, limit: number, total_records: number, total_pages: number } },
 *   category_matrix: { client_id: number, client_name: string, categories: object, total_cost: number }[],
 * }>}
 */
async function getClientCostAnalytics(query, companyId) {
  const hoursSource = query.hoursSource;

  const [hoursRows, costRows, categories, matrixRows] = await Promise.all([
    reportRepo.getClientCostAnalyticsHours({ companyId, hoursSource }),
    reportRepo.getClientCostAnalyticsCost({ companyId }),
    serviceCategoryRepo.findAll({ companyId }),
    reportRepo.getClientCategoryCostMatrixReport({ companyId }),
  ]);
  const categoryNames = categories.map((c) => c.name);

  const clientMap = new Map();
  for (const row of hoursRows) {
    clientMap.set(row.client_id, {
      client_id: row.client_id,
      client_name: row.client_name,
      total_hours: round2(row.total_hours),
      total_cost: 0,
    });
  }
  for (const row of costRows) {
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        total_hours: 0,
        total_cost: round2(row.total_cost),
      });
    } else {
      clientMap.get(row.client_id).total_cost = round2(row.total_cost);
    }
  }
  const clients = Array.from(clientMap.values()).sort((a, b) => b.total_cost - a.total_cost);

  const { page, limit, offset } = getPaginationParams({ page: query.page, limit: query.limit || 15 });
  const topClientsData = clients
    .slice(offset, offset + limit)
    .map((client, idx) => ({ rank: offset + idx + 1, ...client }));
  const topClientsMeta = getPaginationMeta(clients.length, page, limit);

  const matrixMap = new Map();
  for (const row of matrixRows) {
    if (!matrixMap.has(row.client_id)) {
      matrixMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        categories: Object.fromEntries(categoryNames.map((name) => [name, 0])),
        total_cost: 0,
      });
    }
    const client = matrixMap.get(row.client_id);
    const cost = round2(row.cost);
    client.categories[row.category_name] = cost;
    client.total_cost = round2(client.total_cost + cost);
  }

  return {
    clients,
    top_clients: {
      data: topClientsData,
      pagination: {
        page: topClientsMeta.page,
        limit: topClientsMeta.limit,
        total_records: topClientsMeta.total,
        total_pages: topClientsMeta.totalPages,
      },
    },
    category_matrix: Array.from(matrixMap.values()).sort((a, b) => b.total_cost - a.total_cost),
  };
}

/**
 * Client Wise Analytics Report — total cost, total hours, average
 * cost/hour, distinct project (Service PO) count, and % of total cost, per
 * client, for a given period. Based on Dashboard analytics2's
 * client_wise_analytics report (dashboardService.buildClientWiseAnalytics())
 * — an independent Reports Module implementation of the same business logic.
 * percentage_of_total_cost is computed against the sum of every client
 * matching these SAME filters (before pagination), not just the current page.
 *
 * @param {object} query - req.query: month+year XOR startDate+endDate (required),
 *   employeeId?, clientId?, poId?, serviceTypeId?, hoursSource?, roleId?, page?, limit?, sortBy?, sortOrder?
 * @param {number} companyId
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getClientWiseAnalyticsReport(query, companyId) {
  const { startDate, endDate } = resolveClientServicePODateRange(query);

  const filters = {
    companyId,
    startDate,
    endDate,
    employeeId: query.employeeId ? parseInt(query.employeeId, 10) : undefined,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    serviceTypeId: query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };

  const [hoursRows, costRows] = await Promise.all([
    reportRepo.getClientWiseAnalyticsHours(filters),
    reportRepo.getClientWiseAnalyticsCost(filters),
  ]);

  const clientMap = new Map();
  for (const row of hoursRows) {
    clientMap.set(row.client_id, {
      client_id: row.client_id,
      client_name: row.client_name,
      total_hours: parseFloat(row.total_hours) || 0,
      total_projects: parseInt(row.total_projects, 10) || 0,
      total_cost: 0,
    });
  }
  for (const row of costRows) {
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        total_hours: 0,
        total_projects: 0,
        total_cost: parseFloat(row.total_cost) || 0,
      });
    } else {
      clientMap.get(row.client_id).total_cost = parseFloat(row.total_cost) || 0;
    }
  }

  const allClients = Array.from(clientMap.values());
  const overallTotalCost = allClients.reduce((sum, c) => sum + c.total_cost, 0);

  const shaped = allClients.map((c) => ({
    client_id: c.client_id,
    client_name: c.client_name,
    total_cost: round2(c.total_cost),
    total_hours: round2(c.total_hours),
    average_cost_per_hour: c.total_hours > 0 ? round2(c.total_cost / c.total_hours) : 0,
    total_projects: c.total_projects,
    percentage_of_total_cost: overallTotalCost > 0 ? round2((c.total_cost / overallTotalCost) * 100) : 0,
  }));

  const allowedSort = ['total_cost', 'total_hours', 'average_cost_per_hour', 'total_projects', 'percentage_of_total_cost'];
  const sortBy = allowedSort.includes(query.sortBy) ? query.sortBy : 'total_cost';
  const sortOrder = (query.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  shaped.sort((a, b) => (a[sortBy] - b[sortBy]) * sortOrder);

  const { page, limit, offset } = getPaginationParams(query);
  const data = shaped.slice(offset, offset + limit);
  const meta = getPaginationMeta(shaped.length, page, limit);

  return { data, meta };
}

/**
 * Monthly Hours Trend Report — five month-by-month series over a given
 * period: hours by billable/non-billable/customer-non-billable/other
 * category, cost by service-type category (Invoice Master basis), overall
 * utilization % (billable hours / total hours), Leave hours, and No Work
 * (Idle/On Bench) hours. Based on Dashboard analytics' monthly_hours_trend
 * chart and analytics2's cost_trend_by_type/monthly_resource_utilization/
 * leave_hours_trend/no_work_trend reports — bundled into one report since
 * all five are month-by-month trends sharing the same period/filter
 * resolution; an independent Reports Module implementation of the same
 * business logic.
 *
 * @param {object} query - req.query: month+year XOR startDate+endDate (required),
 *   employeeId?, clientId?, poId?, serviceTypeId?, hoursSource?, roleId?
 * @param {number} companyId
 * @returns {Promise<{
 *   monthly_hours_by_category: { month: string, Billable: number, 'Non-Billable': number, 'Customer Non-Billable': number, Other: number }[],
 *   monthly_cost_by_category: { month: string, categories: { category_name: string, cost: number }[] }[],
 *   monthly_utilization: { month: string, total_hours: number, billable_hours: number, utilization_percentage: number }[],
 *   leave_hours_trend: { month: string, leave_hours: number }[],
 *   no_work_trend: { month: string, no_work_hours: number }[],
 * }>}
 */
async function getMonthlyHoursTrend(query, companyId) {
  const { startDate, endDate } = resolveClientServicePODateRange(query);

  const filters = {
    companyId,
    startDate,
    endDate,
    employeeId: query.employeeId ? parseInt(query.employeeId, 10) : undefined,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    serviceTypeId: query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };
  const months = monthsInDateRange(startDate, endDate);

  const [categoryRows, costRows, categories, utilizationRows, leaveRows, noWorkRows] = await Promise.all([
    reportRepo.getMonthlyHoursByCategory(filters),
    reportRepo.getMonthlyCostByCategory(filters),
    serviceCategoryRepo.findAll({ companyId }),
    reportRepo.getMonthlyUtilizationTrend(filters),
    reportRepo.getLeaveHoursTrendReport(filters),
    reportRepo.getNoWorkTrendReport(filters),
  ]);
  const categoryNames = categories.map((c) => c.name);

  const REPORT_BUCKET_LABELS = { billable: 'Billable', non_billable: 'Non-Billable', customer_non_billable: 'Customer Non-Billable' };
  const emptyBucket = () => ({ Billable: 0, 'Non-Billable': 0, 'Customer Non-Billable': 0, Other: 0 });
  const categoryByMonth = new Map();
  for (const row of categoryRows) {
    const key = `${row.year}-${row.month}`;
    if (!categoryByMonth.has(key)) categoryByMonth.set(key, emptyBucket());
    const bucket = categoryByMonth.get(key);
    const label = REPORT_BUCKET_LABELS[row.report_bucket_key] || 'Other';
    bucket[label] = round2(bucket[label] + (parseFloat(row.hours) || 0));
  }
  const monthly_hours_by_category = months.map(({ year, month }) => ({
    month: reportMonthLabel(year, month),
    ...(categoryByMonth.get(`${year}-${month}`) || emptyBucket()),
  }));

  // Cost by category — same "known categories + any extra encountered"
  // zero-fill approach as dashboardService.js's buildCostTrendByType(), so
  // a category with no cost this month still appears as 0 rather than
  // being silently absent.
  const costByKey = new Map();
  const extraCategoriesByMonth = new Map();
  for (const row of costRows) {
    costByKey.set(`${row.year}-${row.month}-${row.category_name}`, parseFloat(row.cost) || 0);
    if (!categoryNames.includes(row.category_name)) {
      const key = `${row.year}-${row.month}`;
      if (!extraCategoriesByMonth.has(key)) extraCategoriesByMonth.set(key, new Set());
      extraCategoriesByMonth.get(key).add(row.category_name);
    }
  }
  const monthly_cost_by_category = months.map(({ year, month }) => {
    const key = `${year}-${month}`;
    const allNames = [...categoryNames, ...(extraCategoriesByMonth.get(key) || [])];
    return {
      month: reportMonthLabel(year, month),
      categories: allNames.map((name) => ({
        category_name: name,
        cost: round2(costByKey.get(`${key}-${name}`) || 0),
      })),
    };
  });

  const utilizationByMonth = new Map(utilizationRows.map((row) => [`${row.year}-${row.month}`, row]));
  const monthly_utilization = months.map(({ year, month }) => {
    const row = utilizationByMonth.get(`${year}-${month}`);
    const totalHours = row ? parseFloat(row.total_hours) || 0 : 0;
    const billableHours = row ? parseFloat(row.billable_hours) || 0 : 0;
    return {
      month: reportMonthLabel(year, month),
      total_hours: round2(totalHours),
      billable_hours: round2(billableHours),
      utilization_percentage: totalHours > 0 ? round2((billableHours / totalHours) * 100) : 0,
    };
  });

  const leaveByMonth = new Map(leaveRows.map((row) => [`${row.year}-${row.month}`, parseFloat(row.leave_hours) || 0]));
  const leave_hours_trend = months.map(({ year, month }) => ({
    month: reportMonthLabel(year, month),
    leave_hours: round2(leaveByMonth.get(`${year}-${month}`) || 0),
  }));

  const noWorkByMonth = new Map(noWorkRows.map((row) => [`${row.year}-${row.month}`, parseFloat(row.no_work_hours) || 0]));
  const no_work_trend = months.map(({ year, month }) => ({
    month: reportMonthLabel(year, month),
    no_work_hours: round2(noWorkByMonth.get(`${year}-${month}`) || 0),
  }));

  return { monthly_hours_by_category, monthly_cost_by_category, monthly_utilization, leave_hours_trend, no_work_trend };
}

/**
 * Employee Bench Percentage Report — per employee, the share of their
 * total hours logged against "Idle"/"On Bench"-named Service POs, for a
 * given period. Based on Dashboard analytics' employee_bench_pct chart
 * (dashboardService.js) — an independent Reports Module implementation of
 * the same business logic.
 *
 * @param {object} query - req.query: month+year XOR startDate+endDate (required),
 *   employeeId?, clientId?, poId?, hoursSource?, roleId?, page?, limit?, sortBy?, sortOrder?
 * @param {number} companyId
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getEmployeeBenchPercentage(query, companyId) {
  const { startDate, endDate } = resolveClientServicePODateRange(query);

  const filters = {
    companyId,
    startDate,
    endDate,
    employeeId: query.employeeId ? parseInt(query.employeeId, 10) : undefined,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
  };

  const rows = await reportRepo.getEmployeeBenchDetailReport(filters);

  const empMap = new Map();
  for (const row of rows) {
    if (!empMap.has(row.employee_id)) {
      empMap.set(row.employee_id, {
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        full_name: row.full_name,
        bench_hours: 0,
        total_hours: 0,
      });
    }
    const emp = empMap.get(row.employee_id);
    const hours = parseFloat(row.hours) || 0;
    emp.total_hours += hours;
    if (isBenchServiceTypeReport(row.service_po_name)) emp.bench_hours += hours;
  }

  const shaped = Array.from(empMap.values()).map((emp) => ({
    employee_id: emp.employee_id,
    employee_code: emp.employee_code,
    full_name: emp.full_name,
    bench_hours: round2(emp.bench_hours),
    total_hours: round2(emp.total_hours),
    bench_pct: emp.total_hours > 0 ? round2((emp.bench_hours / emp.total_hours) * 100) : 0,
  }));

  const allowedSort = ['bench_pct', 'bench_hours', 'total_hours'];
  const sortBy = allowedSort.includes(query.sortBy) ? query.sortBy : 'bench_pct';
  const sortOrder = (query.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  shaped.sort((a, b) => (a[sortBy] - b[sortBy]) * sortOrder);

  const { page, limit, offset } = getPaginationParams(query);
  const data = shaped.slice(offset, offset + limit);
  const meta = getPaginationMeta(shaped.length, page, limit);

  return { data, meta };
}

/**
 * Budget vs Billed Report — Budget Cost (cost_budget_master.invoice_amount)
 * vs Actual Billed Amount (service_po_monthly_budgets.billed_amount) for a
 * given period: a monthly trend, a per-Service-PO breakdown (paginated), an
 * overall summary, and over-/under-budget Service PO lists. Based on
 * Dashboard analytics2's budget_vs_billed report
 * (dashboardService.buildBudgetVsBilledAnalytics()) — an independent
 * Reports Module implementation of the same business logic. employeeId has
 * no meaning here (both source tables are Service-PO-level, never
 * per-employee) and is intentionally not a supported filter.
 *
 * @param {object} query - req.query: month+year XOR startDate+endDate (required),
 *   clientId?, poId?, serviceTypeId?, page?, limit?, sortBy?, sortOrder?
 * @param {number} companyId
 * @returns {Promise<{
 *   monthly: object[], by_service_po: { data: object[], meta: object }, summary: object,
 *   over_budget_service_pos: object[], under_budget_service_pos: object[],
 * }>}
 */
async function getBudgetVsBilledReport(query, companyId) {
  const { startDate, endDate } = resolveClientServicePODateRange(query);

  const filters = {
    companyId,
    startDate,
    endDate,
    clientId: query.clientId ? parseInt(query.clientId, 10) : undefined,
    poId: query.poId ? parseInt(query.poId, 10) : undefined,
    serviceTypeId: query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined,
  };

  const rows = await reportRepo.getBudgetVsBilled(filters);

  const variancePct = (budget, variance) => (budget > 0 ? round2((variance / budget) * 100) : null);

  const monthlyMap = new Map();
  for (const row of rows) {
    const key = `${row.year}-${row.month}`;
    if (!monthlyMap.has(key)) {
      monthlyMap.set(key, { year: row.year, month: row.month, budget_cost: 0, billed_amount: 0 });
    }
    const bucket = monthlyMap.get(key);
    bucket.budget_cost = round2(bucket.budget_cost + (parseFloat(row.budget_cost) || 0));
    bucket.billed_amount = round2(bucket.billed_amount + (parseFloat(row.billed_amount) || 0));
  }
  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => (a.year - b.year) || (a.month - b.month))
    .map(({ year, month, budget_cost, billed_amount }) => {
      const variance = round2(billed_amount - budget_cost);
      return { month: reportMonthLabel(year, month), budget_cost, billed_amount, variance, variance_pct: variancePct(budget_cost, variance) };
    });

  const poMap = new Map();
  for (const row of rows) {
    if (!poMap.has(row.service_po_id)) {
      poMap.set(row.service_po_id, {
        service_po_id: row.service_po_id,
        service_po_code: row.service_po_code,
        service_po_name: row.service_po_name,
        client_name: row.client_name,
        budget_cost: 0,
        billed_amount: 0,
      });
    }
    const bucket = poMap.get(row.service_po_id);
    bucket.budget_cost = round2(bucket.budget_cost + (parseFloat(row.budget_cost) || 0));
    bucket.billed_amount = round2(bucket.billed_amount + (parseFloat(row.billed_amount) || 0));
  }
  const byServicePOAll = Array.from(poMap.values()).map((po) => {
    const variance = round2(po.billed_amount - po.budget_cost);
    return { ...po, variance, variance_pct: variancePct(po.budget_cost, variance) };
  });

  const allowedSort = ['budget_cost', 'billed_amount', 'variance', 'variance_pct'];
  const sortBy = allowedSort.includes(query.sortBy) ? query.sortBy : 'service_po_id';
  const sortOrder = (query.sortOrder || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  byServicePOAll.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * sortOrder;
  });

  const { page, limit, offset } = getPaginationParams(query);
  const byServicePOPage = byServicePOAll.slice(offset, offset + limit);
  const byServicePOMeta = getPaginationMeta(byServicePOAll.length, page, limit);

  const totalBudgetCost = round2(byServicePOAll.reduce((sum, po) => sum + po.budget_cost, 0));
  const totalBilledAmount = round2(byServicePOAll.reduce((sum, po) => sum + po.billed_amount, 0));
  const totalVariance = round2(totalBilledAmount - totalBudgetCost);
  const summary = {
    total_budget_cost: totalBudgetCost,
    total_billed_amount: totalBilledAmount,
    total_variance: totalVariance,
    total_variance_pct: variancePct(totalBudgetCost, totalVariance),
  };

  const over_budget_service_pos = byServicePOAll.filter((po) => po.billed_amount > po.budget_cost);
  const under_budget_service_pos = byServicePOAll.filter((po) => po.billed_amount < po.budget_cost);

  return {
    monthly,
    by_service_po: { data: byServicePOPage, meta: byServicePOMeta },
    summary,
    over_budget_service_pos,
    under_budget_service_pos,
  };
}

module.exports = {
  getEmployeeHourlyRate,
  getMonthlyCostSummary,
  getTimesheetSummary,
  getServicePOUtilisation,
  getSubProjectHours,
  getResourceAllocation,
  getOperationalCostBreakdown,
  getEmployeeUtilizationSummary,
  getServicePOSummary,
  getInvoicePOSummary,
  getResourceUtilization,
  getMonthlyResourceUtilization,
  getResourseProjectUtilizationReport,
  getClientServicePOHoursReport,
  getClientCostAnalytics,
  getClientWiseAnalyticsReport,
  getMonthlyHoursTrend,
  getEmployeeBenchPercentage,
  getBudgetVsBilledReport,
};