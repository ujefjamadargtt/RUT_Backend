'use strict';

const dashboardRepo = require('../repositories/dashboardRepository');
const serviceCategoryRepo = require('../repositories/serviceCategoryRepository');
const logger = require('../utils/logger');
const dateHelper = require('../helpers/dateHelper');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const publishVisibilityService = require('./publishVisibilityService');
const round2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

/**
 * Resolve month/year from query, defaulting to the current period.
 * @param {object} query
 * @returns {{ month: number, year: number }}
 */
function resolvePeriod(query = {}) {
  return {
    month: query.month ? parseInt(query.month, 10) : dateHelper.getCurrentMonth(),
    year: query.year ? parseInt(query.year, 10) : dateHelper.getCurrentYear(),
  };
}

// ── Analytics Dashboard fiscal-year/quarter helpers (Apr -> Mar) ──────────

/**
 * Resolve the fiscal year a query targets. `fiscalYear` names the year the
 * fiscal year STARTS in (e.g. fiscalYear=2026 means Apr-2026 -> Mar-2027).
 *
 * If an explicit month+year is given (the same pair resolveAnalyticsPeriod()
 * narrows every other tile to), the fiscal year is derived from THAT instead
 * of always defaulting to today — otherwise fiscal-year-scoped figures (e.g.
 * total_po_value_fiscal_year) silently ignore a caller's month/year filter
 * whenever fiscalYear itself isn't also explicitly supplied, even though
 * every other tile correctly narrows to the requested period.
 *
 * Defaults to the fiscal year containing today when neither fiscalYear nor
 * month+year is given.
 *
 * @param {object} query
 * @returns {number}
 */
function resolveFiscalYear(query = {}) {
  if (query.fiscalYear) return parseInt(query.fiscalYear, 10);

  if (query.month && query.year) {
    const month = parseInt(query.month, 10);
    const year = parseInt(query.year, 10);
    return month >= 4 ? year : year - 1;
  }

  const month = dateHelper.getCurrentMonth();
  const year = dateHelper.getCurrentYear();
  return month >= 4 ? year : year - 1;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @returns {{ start: string, end: string }} YYYY-MM-DD bounds of the full fiscal year */
function fiscalYearBounds(fiscalYear) {
  return { start: `${fiscalYear}-04-01`, end: `${fiscalYear + 1}-03-31` };
}

/** @returns {{ start: string, end: string }} YYYY-MM-DD bounds of one fiscal quarter (1-4) */
function fiscalQuarterBounds(fiscalYear, quarter) {
  const QUARTERS = {
    1: { startMonth: 4, startYear: fiscalYear, endMonth: 6, endYear: fiscalYear },
    2: { startMonth: 7, startYear: fiscalYear, endMonth: 9, endYear: fiscalYear },
    3: { startMonth: 10, startYear: fiscalYear, endMonth: 12, endYear: fiscalYear },
    4: { startMonth: 1, startYear: fiscalYear + 1, endMonth: 3, endYear: fiscalYear + 1 },
  };
  const q = QUARTERS[quarter];
  const lastDay = new Date(q.endYear, q.endMonth, 0).getDate();
  return {
    start: `${q.startYear}-${pad2(q.startMonth)}-01`,
    end: `${q.endYear}-${pad2(q.endMonth)}-${pad2(lastDay)}`,
  };
}

/** @returns {{ start: string, end: string }} YYYY-MM-DD bounds of one calendar month */
function calendarMonthBounds(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${year}-${pad2(month)}-01`, end: `${year}-${pad2(month)}-${pad2(lastDay)}` };
}

/**
 * Resolve the exact date window for tiles/charts (other than the trend
 * chart, which always spans the full fiscal year): an explicit
 * startDate/endDate wins, then a specific calendar month+year, then a
 * quarter within the fiscal year, then the whole fiscal year as the default.
 * @param {object} query
 * @param {number} fiscalYear
 * @returns {{ start: string, end: string }}
 */
function resolveAnalyticsPeriod(query, fiscalYear) {
  if (query.startDate && query.endDate) {
    return { start: query.startDate, end: query.endDate };
  }
  if (query.month && query.year) {
    return calendarMonthBounds(parseInt(query.year, 10), parseInt(query.month, 10));
  }
  if (query.quarter) {
    return fiscalQuarterBounds(fiscalYear, parseInt(query.quarter, 10));
  }
  return fiscalYearBounds(fiscalYear);
}

/**
 * Every {year, month} pair spanning a resolved period's bounds (inclusive),
 * in order. Since resolveAnalyticsPeriod() already resolves startDate/endDate
 * to exact YYYY-MM-DD bounds for every filter tier (fiscal year -> 12
 * months, quarter -> 3 months, explicit month+year -> 1 month, explicit
 * startDate/endDate -> whatever it spans), walking month-by-month between
 * them reuses that resolution instead of re-deriving the month list per tier.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {{ year: number, month: number }[]}
 */
function monthsInRange(startDate, endDate) {
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

const FISCAL_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(year, month) {
  return `${FISCAL_MONTH_NAMES[month - 1]}-${String(year).slice(2)}`;
}

// Monthly Hours Trend widget's output object keys are a fixed API contract
// (Billable / Non-Billable / Customer Non-Billable / Other) and are NOT
// changing. Which category maps to which bucket, however, is read entirely
// from service_categories.report_bucket_key (set via the
// 20260721_add_service_category_report_bucket_key.sql migration) rather than
// comparing category name strings — a category with no bucket assigned
// (NULL, e.g. a test/seed category) falls into "Other" so hours are never
// silently dropped from the chart total.
const REPORT_BUCKET_LABELS = {
  billable: 'Billable',
  non_billable: 'Non-Billable',
  customer_non_billable: 'Customer Non-Billable',
};
function normalizeTrendCategory(reportBucketKey) {
  return REPORT_BUCKET_LABELS[reportBucketKey] || 'Other';
}

// Same 3 buckets as REPORT_BUCKET_LABELS above, keyed in the snake_case shape
// groupTopPOsByCategory()/groupEmployeeCountByCategory() return.
const KNOWN_REPORT_BUCKETS = new Set(['billable', 'non_billable', 'customer_non_billable']);
function resolveReportBucket(reportBucketKey) {
  return KNOWN_REPORT_BUCKETS.has(reportBucketKey) ? reportBucketKey : 'other';
}

/**
 * Split the flat top-POs-by-hours rows (already capped to top 5 per category
 * by the repository) into billable / non-billable / customer-non-billable
 * buckets, driven by service_categories.report_bucket_key. Any category with
 * no bucket assigned (e.g. a test/seed category) is bucketed into "other" so
 * POs are never silently dropped from the widget.
 * @param {object[]} rows
 * @returns {{ billable: object[], non_billable: object[], customer_non_billable: object[], other: object[] }}
 */
function groupTopPOsByCategory(rows) {
  const buckets = { billable: [], non_billable: [], customer_non_billable: [], other: [] };

  for (const row of rows) {
    const { category_name, report_bucket_key, ...po } = row;
    buckets[resolveReportBucket(report_bucket_key)].push(po);
  }

  return buckets;
}

/**
 * Distinct employee count per category (billable / non-billable /
 * customer-non-billable / other), for the current month/year.
 * @param {object[]} rows - { category_name, report_bucket_key, employee_count }
 * @returns {{ billable: number, non_billable: number, customer_non_billable: number, other: number }}
 */
function groupEmployeeCountByCategory(rows) {
  const counts = { billable: 0, non_billable: 0, customer_non_billable: 0, other: 0 };

  for (const row of rows) {
    counts[resolveReportBucket(row.report_bucket_key)] += parseInt(row.employee_count, 10) || 0;
  }

  return counts;
}

/**
 * Group flat employee x Service-PO hour rows into one object per employee,
 * split into billable / non-billable / customer-non-billable buckets.
 * The split is driven by the PO's service-type category's
 * report_bucket_key; any category not flagged as the customer-non-billable
 * bucket falls back to the PO's is_billable flag, so pre-existing
 * Billable/Non-Billable classification for those rows is unchanged.
 *
 * @param {object[]} rows - { employee_id, employee_code, full_name, designation, service_po_id, service_po_code, service_po_name, service_type_name, is_billable, category_name, report_bucket_key, hours }
 * @returns {object[]}
 */
function buildEmployeeBillableBreakdown(rows) {
  const empMap = new Map();
  for (const row of rows) {
    if (!empMap.has(row.employee_id)) {
      empMap.set(row.employee_id, {
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        full_name: row.full_name,
        designation: row.designation,
        billable_hours: 0,
        non_billable_hours: 0,
        customer_non_billable_hours: 0,
        total_hours: 0,
        billable_pct: 0,
        billable_reasons: [],
        non_billable_reasons: [],
        customer_non_billable_reasons: [],
      });
    }

    const emp = empMap.get(row.employee_id);
    const hours = parseFloat(row.hours) || 0;
    const reason = {
      service_po_id: row.service_po_id,
      service_po_code: row.service_po_code,
      service_po_name: row.service_po_name,
      service_type_name: row.service_type_name,
      hours: round2(hours),
    };

    if (row.report_bucket_key === 'customer_non_billable') {
      emp.customer_non_billable_hours += hours;
      emp.customer_non_billable_reasons.push(reason);
    } else if (row.is_billable) {
      emp.billable_hours += hours;
      emp.billable_reasons.push(reason);
    } else {
      emp.non_billable_hours += hours;
      emp.non_billable_reasons.push(reason);
    }
  }

  return Array.from(empMap.values()).map((emp) => {
    const total = emp.billable_hours + emp.non_billable_hours + emp.customer_non_billable_hours;
    const billablePct = total > 0 ? round2((emp.billable_hours / total) * 100) : 0;

    const summaryParts = [];
    if (emp.billable_reasons.length) {
      summaryParts.push(
        `Billable: ${emp.billable_reasons.map((r) => `${r.service_po_name} (${r.hours}h)`).join(', ')}`
      );
    }
    if (emp.non_billable_reasons.length) {
      summaryParts.push(
        `Non-billable: ${emp.non_billable_reasons.map((r) => `${r.service_po_name} (${r.hours}h)`).join(', ')}`
      );
    }
    if (emp.customer_non_billable_reasons.length) {
      summaryParts.push(
        `Customer Non-Billable: ${emp.customer_non_billable_reasons.map((r) => `${r.service_po_name} (${r.hours}h)`).join(', ')}`
      );
    }

    return {
      ...emp,
      billable_hours: round2(emp.billable_hours),
      non_billable_hours: round2(emp.non_billable_hours),
      customer_non_billable_hours: round2(emp.customer_non_billable_hours),
      total_hours: round2(total),
      billable_pct: billablePct,
      reason_summary: `${billablePct}% billable (${round2(emp.billable_hours)}h of ${round2(total)}h). ${summaryParts.join('. ')}.`,
    };
  });
}

// Keywords (case-insensitive substring match on service_po_name — the
// project name, not the service type) that count as "bench" time for the
// Employee Bench % widget: Idle and On Bench only.
const BENCH_KEYWORDS = ['idle', 'bench'];
function isBenchServiceType(servicePOName) {
  const name = (servicePOName || '').toLowerCase();
  return BENCH_KEYWORDS.some((k) => name.includes(k));
}

/**
 * Dashboard Service
 * Calls all repository methods in parallel and assembles the combined stats object.
 */

/**
 * Assemble the full dashboard stats payload.
 * All repository queries run concurrently via Promise.all to minimise latency.
 *
 * @param {object} [query]      - req.query
 * @param {number} [query.month] - Optional 1-12 month override; defaults to the current month.
 * @param {number} [query.year]  - Optional year override; defaults to the current year.
 * @returns {Promise<object>}
 */
async function getDashboardStats(query = {}, companyId) {
  const { month: currentMonth, year: currentYear } = resolvePeriod(query);
  const { hoursSource, roleId } = query;

  logger.info('Dashboard: fetching all stats', { currentMonth, currentYear });

  // Publish visibility for Role ID 5 is applied per-row inside each of the
  // timesheet-derived queries below (an unpublished row is excluded, rather
  // than blocking the whole request). Headcounts (total/active employees,
  // clients, POs) and total_po_value_current_year are not timesheet-derived
  // and are unaffected — see getTotalRevenue.
  const [
    totalEmployees,
    activeEmployees,
    totalClients,
    activePOs,
    closedPOs,
    currentMonthHours,
    billableSplit,
    overallUtilisation,
    totalRevenue,
    recentActivity,
    topPOs,
    monthlyTrend,
    employeeCountByCategoryRows,
    activeCountsForPeriod,
  ] = await Promise.all([
    dashboardRepo.getTotalEmployees(companyId),
    dashboardRepo.getActiveEmployees(companyId),
    dashboardRepo.getTotalClients(companyId),
    dashboardRepo.getActivePOs(companyId),
    dashboardRepo.getClosedPOs(companyId),
    dashboardRepo.getCurrentMonthHours(currentMonth, currentYear, hoursSource, roleId, companyId),
    dashboardRepo.getCurrentMonthBillableSplit(currentMonth, currentYear, hoursSource, roleId, companyId),
    dashboardRepo.getOverallUtilisation(currentMonth, currentYear, hoursSource, roleId, companyId),
    dashboardRepo.getTotalRevenue({ year: currentYear, companyId }),
    dashboardRepo.getRecentTimesheetActivity(hoursSource, roleId, companyId),
    dashboardRepo.getTopPOsByHours(hoursSource, roleId, companyId),
    dashboardRepo.getMonthlyHoursTrend(hoursSource, roleId, companyId),
    dashboardRepo.getEmployeeCountByCategory(currentMonth, currentYear, roleId, companyId),
    dashboardRepo.getActiveCountsForPeriod(currentMonth, currentYear, roleId, companyId),
  ]);

  const inactiveEmployees = totalEmployees - activeEmployees;
  const topPOsByCategory = groupTopPOsByCategory(topPOs);
  const employeeCountByCategory = groupEmployeeCountByCategory(employeeCountByCategoryRows);

  return {
    as_of: dateHelper.nowISO(),
    period: {
      month: currentMonth,
      year: currentYear,
    },

    // ── Workforce ──────────────────────────────────────────────────────────────
    workforce: {
      total_employees: totalEmployees,
      active_employees: activeEmployees,
      inactive_employees: inactiveEmployees,
      employee_count_by_category: employeeCountByCategory,
    },

    // ── Clients & POs ──────────────────────────────────────────────────────────
    portfolio: {
      total_clients: totalClients,
      active_pos: activePOs,
      closed_pos: closedPOs,
      total_pos: activePOs + closedPOs,
    },

    // ── Current month metrics ─────────────────────────────────────────────────
    current_month: {
      total_hours_logged: round2(currentMonthHours),
      billable_hours_logged: round2(billableSplit.billable_hours),
      non_billable_hours_logged: round2(billableSplit.non_billable_hours),
      overall_utilisation_pct: overallUtilisation,
      // Activity-based counts (distinct active employees/clients with logged
      // hours this period) — comparable to /dashboard/analytics tiles, unlike
      // workforce.active_employees/portfolio.total_clients above which are
      // global, all-time headcounts unaffected by month/year.
      active_employees: activeCountsForPeriod.active_employees,
      active_clients: activeCountsForPeriod.active_clients,
    },

    // ── Financial ─────────────────────────────────────────────────────────────
    financials: {
      total_po_value_current_year: totalRevenue,
    },

    // ── Trend & activity data (for charts / feeds) ────────────────────────────
    charts: {
      monthly_hours_trend: monthlyTrend,
      top_pos_by_hours: topPOsByCategory,
    },

    activity: {
      recent_timesheet_entries: recentActivity,
    },
  };
}

/**
 * Per-employee billable vs non-billable hour breakdown for a month/year,
 * with the contributing Service POs as the "reason" for the split.
 *
 * @param {object} query - { month, year, page, limit, search }
 * @returns {Promise<{ data: object[], meta: object, period: object }>}
 */
async function getEmployeeBillableBreakdown(query = {}, companyId) {
  const { month, year } = resolvePeriod(query);
  const { page, limit, offset } = getPaginationParams(query);

  logger.info('Dashboard: getEmployeeBillableBreakdown', { month, year, page, limit });

  const { rows, count } = await dashboardRepo.getEmployeeBillableBreakdown({
    month,
    year,
    search: query.search || null,
    limit,
    offset,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
    companyId,
  });

  const data = buildEmployeeBillableBreakdown(rows);

  const meta = getPaginationMeta(count, page, limit);

  return { data, meta, period: { month, year } };
}

/**
 * Per-Service-PO billable/non-billable classification for a month/year,
 * with the service type/category context that explains the classification.
 *
 * @param {object} query - { month, year, page, limit, search, is_billable }
 * @returns {Promise<{ data: object[], meta: object, period: object }>}
 */
async function getPOBillableBreakdown(query = {}, companyId) {
  const { month, year } = resolvePeriod(query);
  const { page, limit, offset } = getPaginationParams(query);

  const isBillable = query.is_billable !== undefined
    ? query.is_billable === 'true' || query.is_billable === true
    : undefined;

  logger.info('Dashboard: getPOBillableBreakdown', { month, year, page, limit });

  const { rows, count } = await dashboardRepo.getPOBillableBreakdown({
    month,
    year,
    search: query.search || null,
    isBillable,
    limit,
    offset,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
    companyId,
  });

  const data = rows.map((row) => {
    const category = row.category_name ? ` under category "${row.category_name}"` : '';
    const reason = row.is_billable
      ? `Billable — classified as service type "${row.service_type_name}"${category}.`
      : `Non-billable — classified as service type "${row.service_type_name}"${category}.`;

    return {
      service_po_id: row.service_po_id,
      service_po_code: row.service_po_code,
      service_po_name: row.service_po_name,
      client_name: row.client_name,
      status: row.status,
      is_billable: row.is_billable,
      service_type_name: row.service_type_name,
      category_name: row.category_name,
      hours_logged: round2(row.hours_logged),
      reason,
    };
  });

  const meta = getPaginationMeta(count, page, limit);

  return { data, meta, period: { month, year } };
}

/**
 * All contributing employees by hours logged, per Service PO, for a month/year.
 *
 * @param {object} query - { month, year, page, limit, search, is_billable, service_type_id, service_category_id }
 * @returns {Promise<{ data: object[], meta: object, period: object }>}
 */
async function getTopEmployeesByPO(query = {}, companyId) {
  const { month, year } = resolvePeriod(query);
  const { page, limit, offset } = getPaginationParams(query);

  const isBillable = query.is_billable !== undefined
    ? query.is_billable === 'true' || query.is_billable === true
    : undefined;
  const serviceTypeId = query.service_type_id ? parseInt(query.service_type_id, 10) : undefined;
  const serviceCategoryId = query.service_category_id ? parseInt(query.service_category_id, 10) : undefined;

  logger.info('Dashboard: getTopEmployeesByPO', { month, year, isBillable, serviceTypeId, serviceCategoryId, page, limit });

  const { rows, count } = await dashboardRepo.getTopEmployeesByPO({
    month,
    year,
    search: query.search || null,
    isBillable,
    serviceTypeId,
    serviceCategoryId,
    limit,
    offset,
    hoursSource: query.hoursSource,
    roleId: query.roleId,
    companyId,
  });

  // Group the flat (PO, employee, rank) rows into one object per PO.
  const poMap = new Map();
  for (const row of rows) {
    if (!poMap.has(row.service_po_id)) {
      poMap.set(row.service_po_id, {
        service_po_id: row.service_po_id,
        service_po_code: row.service_po_code,
        service_po_name: row.service_po_name,
        client_name: row.client_name,
        is_billable: row.is_billable,
        service_type_name: row.service_type_name,
        category_name: row.category_name,
        top_employees: [],
      });
    }
    poMap.get(row.service_po_id).top_employees.push({
      employee_id: row.employee_id,
      employee_code: row.employee_code,
      full_name: row.full_name,
      hours: round2(row.hours),
    });
  }

  const data = Array.from(poMap.values());
  const meta = getPaginationMeta(count, page, limit);

  return { data, meta, period: { month, year } };
}

const MONTH_LABELS = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Build the chronological list of { year, month } periods ending at
 * (endMonth, endYear) inclusive, going back `monthsBack` months.
 *
 * @param {number} endMonth
 * @param {number} endYear
 * @param {number} monthsBack
 * @returns {{ periods: {year:number, month:number}[], windowStart: string, windowEnd: string }}
 */
function buildMonthWindow(endMonth, endYear, monthsBack) {
  const periods = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(endYear, endMonth - 1 - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const first = periods[0];
  const last = periods[periods.length - 1];
  const windowStart = `${first.year}-${String(first.month).padStart(2, '0')}-01`;
  const lastDay = new Date(last.year, last.month, 0); // day 0 of next month = last day of `last.month`
  const windowEnd = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;

  return { periods, windowStart, windowEnd };
}

/**
 * Top-N POs by absolute hour movement between two periods, for one side
 * (billable or non-billable) of the split.
 *
 * @param {Map<number, {service_po_name:string, is_billable:boolean, hours:number}>} prevPOs
 * @param {Map<number, {service_po_name:string, is_billable:boolean, hours:number}>} curPOs
 * @param {boolean} isBillableSide
 * @param {number} [topN=3]
 * @returns {object[]} [{ service_po_id, service_po_name, previous_hours, current_hours, delta }]
 */
function computeDrivers(prevPOs, curPOs, isBillableSide, topN = 3) {
  const ids = new Set();
  for (const [id, po] of prevPOs) if (po.is_billable === isBillableSide) ids.add(id);
  for (const [id, po] of curPOs) if (po.is_billable === isBillableSide) ids.add(id);

  const drivers = [];
  for (const id of ids) {
    const prev = prevPOs.get(id);
    const cur = curPOs.get(id);
    const previousHours = round2(prev ? prev.hours : 0);
    const currentHours = round2(cur ? cur.hours : 0);
    const delta = round2(currentHours - previousHours);
    if (delta === 0) continue;
    drivers.push({
      service_po_id: id,
      service_po_name: (cur || prev).service_po_name,
      previous_hours: previousHours,
      current_hours: currentHours,
      delta,
    });
  }

  drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return drivers.slice(0, topN);
}

/**
 * Format a delta as "increased/decreased/unchanged" clause for the summary sentence.
 */
function describeDelta(delta) {
  const abs = Math.abs(delta);
  if (delta === 0) return 'unchanged';
  return delta > 0 ? `increased by ${abs}h` : `decreased by ${abs}h`;
}

function formatDrivers(drivers) {
  if (!drivers.length) return '';
  return drivers
    .map((d) => `${d.service_po_name} (${d.delta > 0 ? '+' : ''}${d.delta}h)`)
    .join(', ');
}

/**
 * Billable vs non-billable hours trend across the last N months, with each
 * month's change vs the immediately preceding month broken down by the
 * specific Service POs that drove the increase/decrease on each side.
 *
 * @param {object} query - { month, year, months }
 *   month/year: optional end period, defaults to current month. Must be given together.
 *   months: optional lookback window size, default 6, clamped 2-24.
 * @returns {Promise<{ trend: object[], months: number, period: object }>}
 */
async function getBillableTrend(query = {}, companyId) {
  const { month: endMonth, year: endYear } = resolvePeriod(query);
  const monthsBack = Math.min(24, Math.max(2, query.months ? parseInt(query.months, 10) : 6));

  const { periods, windowStart, windowEnd } = buildMonthWindow(endMonth, endYear, monthsBack);

  logger.info('Dashboard: getBillableTrend', { endMonth, endYear, monthsBack, windowStart, windowEnd });

  // Publish visibility for Role ID 5 is applied per-row inside
  // getBillableTrendDetail(): a timesheet row only counts if its import
  // batch is published, so a window spanning several months still shows
  // real data for whichever of those months ARE published.
  const rows = await dashboardRepo.getBillableTrendDetail({ windowStart, windowEnd, hoursSource: query.hoursSource, roleId: query.roleId, companyId });

  // Group flat rows into one bucket per period, each holding a per-PO hours map.
  const periodMap = new Map();
  for (const p of periods) {
    periodMap.set(`${p.year}-${p.month}`, {
      billable_hours: 0,
      non_billable_hours: 0,
      pos: new Map(), // service_po_id -> { service_po_name, is_billable, hours }
    });
  }
  for (const row of rows) {
    const key = `${row.year}-${row.month}`;
    const bucket = periodMap.get(key);
    if (!bucket) continue; // outside the requested window (shouldn't happen)

    const hours = parseFloat(row.hours) || 0;
    if (row.is_billable) bucket.billable_hours += hours;
    else bucket.non_billable_hours += hours;

    bucket.pos.set(row.service_po_id, {
      service_po_name: row.service_po_name,
      is_billable: row.is_billable,
      hours,
    });
  }

  const trend = periods.map((p, idx) => {
    const key = `${p.year}-${p.month}`;
    const bucket = periodMap.get(key);
    const label = `${MONTH_LABELS[p.month]} ${p.year}`;

    const billable_hours = round2(bucket.billable_hours);
    const non_billable_hours = round2(bucket.non_billable_hours);
    const total_hours = round2(billable_hours + non_billable_hours);
    const billable_pct = total_hours > 0 ? round2((billable_hours / total_hours) * 100) : 0;

    let change = null;
    if (idx > 0) {
      const prevPeriod = periods[idx - 1];
      const prevBucket = periodMap.get(`${prevPeriod.year}-${prevPeriod.month}`);
      const prevLabel = `${MONTH_LABELS[prevPeriod.month]} ${prevPeriod.year}`;

      const billable_delta = round2(billable_hours - round2(prevBucket.billable_hours));
      const non_billable_delta = round2(non_billable_hours - round2(prevBucket.non_billable_hours));

      const billable_drivers = computeDrivers(prevBucket.pos, bucket.pos, true);
      const non_billable_drivers = computeDrivers(prevBucket.pos, bucket.pos, false);

      const billableSentence = `Billable hours ${describeDelta(billable_delta)} vs ${prevLabel}` +
        (billable_drivers.length ? `, driven by: ${formatDrivers(billable_drivers)}.` : '.');
      const nonBillableSentence = `Non-billable hours ${describeDelta(non_billable_delta)} vs ${prevLabel}` +
        (non_billable_drivers.length ? `, driven by: ${formatDrivers(non_billable_drivers)}.` : '.');

      change = {
        vs_label: prevLabel,
        billable_delta,
        non_billable_delta,
        billable_drivers,
        non_billable_drivers,
        reason_summary: `${billableSentence} ${nonBillableSentence}`,
      };
    }

    return {
      year: p.year,
      month: p.month,
      label,
      billable_hours,
      non_billable_hours,
      total_hours,
      billable_pct,
      change,
    };
  });

  return {
    trend,
    months: monthsBack,
    period: { month: endMonth, year: endYear },
  };
}

/**
 * Analytics Dashboard: everything from /dashboard/stats (workforce,
 * portfolio, financials, activity feed), /dashboard/top-employees-by-po, and
 * /dashboard/employee-billable-breakdown, PLUS the original stat tiles and 5
 * charts (Monthly Hours Trend, Hours by Client, Hours by Employee, Client x
 * Service PO, Employee Bench %), all sharing one filter set.
 *
 * Fiscal year runs Apr -> Mar. The Monthly Hours Trend chart always spans
 * the full selected fiscal year (12 months) — EXCEPT when an explicit
 * month+year is given, in which case the trend narrows to that single
 * month, same as every other tile/chart/section. Every other tile/chart/
 * section, including financials.total_po_value_fiscal_year, is scoped to
 * the resolved period — an explicit startDate/endDate, else an explicit
 * month+year, else the selected quarter, else the whole fiscal year — and
 * to employeeId/clientId/poId/serviceTypeId/serviceCategoryId, exactly like
 * every other filtered tile (it reuses scopedFilters directly; the name
 * "_fiscal_year" reflects its default span when no narrower period is
 * given, not a hardcoded scope).
 * workforce/portfolio headcounts (total_employees, total_clients,
 * active_pos, closed_pos) are all-time snapshots unaffected by any period
 * filter, matching /dashboard/stats' existing semantics.
 *
 * @param {object} query - {
 *   fiscalYear, quarter, month, year, startDate, endDate,
 *   employeeId, clientId, poId, serviceTypeId, serviceCategoryId
 * }
 * @returns {Promise<object>} { filters_applied, workforce, portfolio, financials, tiles, charts, activity }
 */
async function getAnalyticsDashboard(query = {}, companyId) {
  const fiscalYear = resolveFiscalYear(query);
  const fyBounds = fiscalYearBounds(fiscalYear);
  const period = resolveAnalyticsPeriod(query, fiscalYear);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;
  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;
  // Only added to the total_po_value_fiscal_year call below (via scopedFilters
  // + these two) — not part of trendFilters, so the trend chart's filter
  // behavior is unchanged.
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;
  const serviceCategoryId = query.serviceCategoryId ? parseInt(query.serviceCategoryId, 10) : undefined;

  // The Monthly Hours Trend chart normally always spans the full selected
  // fiscal year (12 months), regardless of quarter. An explicit month+year
  // is the one exception: it narrows the trend down to that single month,
  // matching how startDate/endDate/month+year/quarter already narrow every
  // other tile/chart via resolveAnalyticsPeriod().
  const explicitMonth = query.month && query.year
    ? { month: parseInt(query.month, 10), year: parseInt(query.year, 10) }
    : null;
  const trendBounds = explicitMonth
    ? calendarMonthBounds(explicitMonth.year, explicitMonth.month)
    : fyBounds;

  const scopedFilters = { startDate: period.start, endDate: period.end, employeeId, clientId, poId, hoursSource: query.hoursSource, roleId: query.roleId, companyId };
  const trendFilters = { startDate: trendBounds.start, endDate: trendBounds.end, employeeId, clientId, poId, hoursSource: query.hoursSource, roleId: query.roleId, companyId };

  logger.info('Dashboard: getAnalyticsDashboard', { fiscalYear, period, employeeId, clientId, poId });

  // Publish visibility for Role ID 5 is applied per-row: a timesheet row
  // only counts if its import batch is published (see buildAnalyticsFilters()
  // for the scopedFilters/trendFilters-driven calls below, and the
  // publishGuard added directly to getOverallUtilisationForPeriod/
  // getEmployeeCountByCategoryForPeriod/getTopPOsByHoursForPeriod/
  // getRecentTimesheetActivityForPeriod). That way a window spanning several
  // months (a quarter, a fiscal year) still shows real data for whichever of
  // those months ARE published, instead of blocking the whole window because
  // one sibling month isn't. globalTotalEmployees/globalActiveEmployees/
  // globalTotalClients/globalActivePOs/globalClosedPOs (all-time headcounts)
  // and totalBudgetCost (cost_budget_master-based, not timesheet-derived —
  // see getTotalBudgetCost) are unaffected either way.
  const [
    tilesRow,
    trendRows,
    byClientRows,
    byEmployeeRows,
    clientByPORows,
    benchRows,
    globalTotalEmployees,
    globalActiveEmployees,
    globalTotalClients,
    globalActivePOs,
    globalClosedPOs,
    totalBudgetCost,
    capacityUtilisationPct,
    employeeCountByCategoryRows,
    topPOsRows,
    recentActivityRows,
    employeesByPORows,
    employeeBillableBreakdownRows,
  ] = await Promise.all([
    dashboardRepo.getAnalyticsTiles(scopedFilters),
    dashboardRepo.getAnalyticsMonthlyTrend(trendFilters),
    dashboardRepo.getAnalyticsHoursByClient(scopedFilters),
    dashboardRepo.getAnalyticsHoursByEmployee(scopedFilters),
    dashboardRepo.getAnalyticsClientByPO(scopedFilters),
    dashboardRepo.getAnalyticsBenchDetail(scopedFilters),
    dashboardRepo.getTotalEmployees(companyId),
    dashboardRepo.getActiveEmployees(companyId),
    dashboardRepo.getTotalClients(companyId),
    dashboardRepo.getActivePOs(companyId),
    dashboardRepo.getClosedPOs(companyId),
    // financials.total_po_value_fiscal_year now sources from
    // cost_budget_master.invoice_amount (Budget Cost) via getTotalBudgetCost(),
    // not service_pos.po_value. getTotalRevenue() (SUM(po_value)) is left
    // for /dashboard/stats's total_po_value_current_year, unaffected by this.
    dashboardRepo.getTotalBudgetCost({
      ...scopedFilters,
      serviceTypeId,
      serviceCategoryId,
    }),
    dashboardRepo.getOverallUtilisationForPeriod(period.start, period.end, query.hoursSource, query.roleId, companyId),
    dashboardRepo.getEmployeeCountByCategoryForPeriod(period.start, period.end, query.roleId, companyId),
    dashboardRepo.getTopPOsByHoursForPeriod(period.start, period.end, query.hoursSource, query.roleId, companyId),
    dashboardRepo.getRecentTimesheetActivityForPeriod(period.start, period.end, query.hoursSource, query.roleId, companyId),
    dashboardRepo.getEmployeesByPOForPeriod(scopedFilters),
    dashboardRepo.getEmployeeBillableBreakdownForPeriod(scopedFilters),
  ]);

  const globalInactiveEmployees = globalTotalEmployees - globalActiveEmployees;
  const employeeCountByCategory = groupEmployeeCountByCategory(employeeCountByCategoryRows);
  const topPOsByCategory = groupTopPOsByCategory(topPOsRows);

  // ── Employees by Service PO (all contributors, per PO with activity in the window) ──
  const poEmployeeMap = new Map();
  for (const row of employeesByPORows) {
    if (!poEmployeeMap.has(row.service_po_id)) {
      poEmployeeMap.set(row.service_po_id, {
        service_po_id: row.service_po_id,
        service_po_code: row.service_po_code,
        service_po_name: row.service_po_name,
        client_name: row.client_name,
        is_billable: row.is_billable,
        service_type_name: row.service_type_name,
        category_name: row.category_name,
        top_employees: [],
      });
    }
    poEmployeeMap.get(row.service_po_id).top_employees.push({
      employee_id: row.employee_id,
      employee_code: row.employee_code,
      full_name: row.full_name,
      hours: round2(row.hours),
    });
  }
  const employees_by_po = Array.from(poEmployeeMap.values());

  // ── Employee Billable Breakdown (billable vs non-billable vs customer-non-billable hours per employee, with reasons) ──
  const employee_billable_breakdown = buildEmployeeBillableBreakdown(employeeBillableBreakdownRows);

  // ── Monthly Hours Trend: 12 fixed months (Apr fiscalYear -> Mar fiscalYear+1),
  //    or just the single requested month when an explicit month+year is given ──
  const fiscalMonths = [];
  if (explicitMonth) {
    fiscalMonths.push(explicitMonth);
  } else {
    for (let i = 0; i < 12; i++) {
      const month = ((3 + i) % 12) + 1; // starts at April (4)
      const year = month >= 4 ? fiscalYear : fiscalYear + 1;
      fiscalMonths.push({ year, month });
    }
  }
  const emptyTrendBucket = () => ({ Billable: 0, 'Non-Billable': 0, 'Customer Non-Billable': 0, Other: 0 });
  const trendByMonth = new Map();
  for (const row of trendRows) {
    const key = `${row.year}-${row.month}`;
    if (!trendByMonth.has(key)) trendByMonth.set(key, emptyTrendBucket());
    const bucket = trendByMonth.get(key);
    const category = normalizeTrendCategory(row.report_bucket_key);
    bucket[category] = round2(bucket[category] + (parseFloat(row.hours) || 0));
  }
  const monthly_hours_trend = fiscalMonths.map(({ year, month }) => ({
    year,
    month,
    label: monthLabel(year, month),
    ...(trendByMonth.get(`${year}-${month}`) || emptyTrendBucket()),
  }));

  // ── Hours by Client / Hours by Employee ──────────────────────────────────
  const hours_by_client = byClientRows.map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    hours: round2(r.hours),
  }));

  const hours_by_employee = byEmployeeRows.map((r) => ({
    employee_id: r.employee_id,
    employee_code: r.employee_code,
    full_name: r.full_name,
    billable_hours: round2(r.billable_hours),
    non_billable_hours: round2(r.non_billable_hours),
    hours: round2(r.hours),
  }));

  // ── Client x Service PO (flat rows; frontend pivots into a matrix) ──────
  const client_x_service_po = clientByPORows.map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    service_po_id: r.service_po_id,
    service_po_name: r.service_po_name,
    hours: round2(r.hours),
  }));

  // ── Employee Bench % (Idle + On Bench only) ─────────────────────────────
  const empBenchMap = new Map();
  for (const row of benchRows) {
    if (!empBenchMap.has(row.employee_id)) {
      empBenchMap.set(row.employee_id, {
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        full_name: row.full_name,
        bench_hours: 0,
        total_hours: 0,
      });
    }
    const emp = empBenchMap.get(row.employee_id);
    const hours = parseFloat(row.hours) || 0;
    emp.total_hours += hours;
    if (isBenchServiceType(row.service_po_name)) emp.bench_hours += hours;
  }
  const employee_bench_pct = Array.from(empBenchMap.values())
    .map((emp) => ({
      ...emp,
      bench_hours: round2(emp.bench_hours),
      total_hours: round2(emp.total_hours),
      bench_pct: emp.total_hours > 0 ? round2((emp.bench_hours / emp.total_hours) * 100) : 0,
    }))
    .sort((a, b) => b.bench_pct - a.bench_pct);

  // ── Tiles ─────────────────────────────────────────────────────────────
  const totalHours = round2(tilesRow.total_hours);
  const billableHours = round2(tilesRow.billable_hours);
  const activeEmployees = parseInt(tilesRow.active_employees, 10) || 0;

  return {
    as_of: dateHelper.nowISO(),
    filters_applied: {
      fiscal_year: fiscalYear,
      quarter: query.quarter ? parseInt(query.quarter, 10) : null,
      month: query.month ? parseInt(query.month, 10) : null,
      year: query.year ? parseInt(query.year, 10) : null,
      period: { start_date: period.start, end_date: period.end },
      employee_id: employeeId || null,
      client_id: clientId || null,
      service_po_id: poId || null,
    },

    // ── Workforce (all-time headcounts, unaffected by the period filter) ────
    workforce: {
      total_employees: globalTotalEmployees,
      active_employees: globalActiveEmployees,
      inactive_employees: globalInactiveEmployees,
      employee_count_by_category: employeeCountByCategory,
    },

    // ── Clients & POs (all-time counts, unaffected by the period filter) ────
    portfolio: {
      total_clients: globalTotalClients,
      active_pos: globalActivePOs,
      closed_pos: globalClosedPOs,
      total_pos: globalActivePOs + globalClosedPOs,
    },

    // ── Financials (scoped to the resolved period + filters, via scopedFilters) ──
    // total_po_value_fiscal_year now sources from cost_budget_master.invoice_amount
    // (Budget Cost), not service_pos.po_value — see getTotalBudgetCost() above.
    financials: {
      total_po_value_fiscal_year: round2(totalBudgetCost),
    },

    tiles: {
      total_hours: totalHours,
      billable_hours: billableHours,
      non_billable_hours: round2(totalHours - billableHours),
      total_cost: round2(tilesRow.total_cost),
      utilization_pct: totalHours > 0 ? round2((billableHours / totalHours) * 100) : 0,
      capacity_utilisation_pct: capacityUtilisationPct,
      active_employees: activeEmployees,
      active_clients: parseInt(tilesRow.active_clients, 10) || 0,
      active_service_pos: parseInt(tilesRow.active_service_pos, 10) || 0,
      avg_hours_per_employee: activeEmployees > 0 ? round2(totalHours / activeEmployees) : 0,
    },
    charts: {
      monthly_hours_trend,
      hours_by_client,
      hours_by_employee,
      client_x_service_po,
      employee_bench_pct,
      top_pos_by_hours: topPOsByCategory,
      employees_by_po,
      employee_billable_breakdown,
    },

    activity: {
      recent_timesheet_entries: recentActivityRows,
    },
  };
}

/**
 * Cost Trend by Type: total cost per month, grouped by service-type category
 * (Billable / Non-Billable / Customer Non-Billable / any other category
 * present in service_categories). Category names come from `knownCategoryNames`
 * (fetched once via serviceCategoryRepo.findAll() by the caller and shared
 * with buildClientCategoryCostMatrix() to avoid fetching twice) — nothing is
 * hardcoded, so a newly added category appears automatically. Every month in
 * `months` is zero-filled for every known category so the chart never has
 * gaps; a category that shows up in the cost data but isn't in the
 * known-category list (e.g. "Uncategorized" for a service type with no
 * category assigned) is still appended per month so cost is never silently
 * dropped.
 *
 * @param {object} costTrendFilters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @param {{ year: number, month: number }[]} months - months to include, in order
 * @param {string[]} knownCategoryNames - every category name currently in service_categories
 * @returns {Promise<{ month: string, categories: { category_name: string, cost: number }[] }[]>}
 */
async function buildCostTrendByType(costTrendFilters, months, knownCategoryNames) {
  const rows = await dashboardRepo.getCostTrendByType(costTrendFilters);

  const costByKey = new Map(); // `${year}-${month}-${category_name}` -> cost
  const extraCategoriesByMonth = new Map(); // `${year}-${month}` -> Set(category_name)

  for (const row of rows) {
    costByKey.set(`${row.year}-${row.month}-${row.category_name}`, parseFloat(row.cost) || 0);
    if (!knownCategoryNames.includes(row.category_name)) {
      const monthKey = `${row.year}-${row.month}`;
      if (!extraCategoriesByMonth.has(monthKey)) extraCategoriesByMonth.set(monthKey, new Set());
      extraCategoriesByMonth.get(monthKey).add(row.category_name);
    }
  }

  return months.map(({ year, month }) => {
    const monthKey = `${year}-${month}`;
    const allCategoryNames = [...knownCategoryNames, ...(extraCategoriesByMonth.get(monthKey) || [])];
    return {
      month: monthLabel(year, month),
      categories: allCategoryNames.map((name) => ({
        category_name: name,
        cost: round2(costByKey.get(`${monthKey}-${name}`) || 0),
      })),
    };
  });
}

/**
 * Client x Category Cost Matrix: per client, total cost broken down by
 * service-type category, plus the client's overall total cost. Takes no
 * filters and applies none — always the complete, unfiltered dataset, same
 * as buildClientWiseCostAnalytics(). Category names come from
 * `knownCategoryNames` (fetched once by the caller and shared with
 * buildCostTrendByType() to avoid fetching twice) — nothing is hardcoded, so
 * a newly added category appears automatically. A category that shows up in
 * the cost data but isn't in the known-category list (e.g. "Uncategorized")
 * is still added to that client's categories map so cost is never silently
 * dropped. Sorted by total cost descending, matching the other client
 * reports.
 *
 * @param {string[]} knownCategoryNames - every category name currently in service_categories
 * @returns {Promise<{ client_id: number, client_name: string, categories: object, total_cost: number }[]>}
 */
async function buildClientCategoryCostMatrix(knownCategoryNames, hoursSource, roleId, companyId) {
  const rows = await dashboardRepo.getClientCategoryCostMatrix(hoursSource, roleId, companyId);

  const clientMap = new Map();
  for (const row of rows) {
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        categories: Object.fromEntries(knownCategoryNames.map((name) => [name, 0])),
        total_cost: 0,
      });
    }
    const client = clientMap.get(row.client_id);
    const cost = round2(parseFloat(row.cost) || 0);
    client.categories[row.category_name] = cost;
    client.total_cost = round2(client.total_cost + cost);
  }

  return Array.from(clientMap.values()).sort((a, b) => b.total_cost - a.total_cost);
}

/**
 * Client Wise Analytics: total cost, total hours, average cost/hour, distinct
 * project (Service PO) count, and share of the overall total cost, per
 * client for the resolved period. Reuses the same
 * fiscalYear/quarter/month/year/startDate/endDate/employeeId/clientId/poId/
 * serviceTypeId filters as the rest of Analytics2's period-scoped reports.
 * percentage_of_total_cost is each client's total_cost divided by the sum of
 * every client's total_cost in this same (filtered) result set.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<{
 *   client_id: number, client_name: string, total_cost: number, total_hours: number,
 *   average_cost_per_hour: number, total_projects: number, percentage_of_total_cost: number
 * }[]>}
 */
async function buildClientWiseAnalytics(filters) {
  const rows = await dashboardRepo.getClientWiseAnalytics(filters);

  const overallTotalCost = rows.reduce((sum, row) => sum + (parseFloat(row.total_cost) || 0), 0);

  return rows.map((row) => {
    const totalCost = parseFloat(row.total_cost) || 0;
    const totalHours = parseFloat(row.total_hours) || 0;
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      total_cost: round2(totalCost),
      total_hours: round2(totalHours),
      average_cost_per_hour: totalHours > 0 ? round2(totalCost / totalHours) : 0,
      total_projects: parseInt(row.total_projects, 10) || 0,
      percentage_of_total_cost: overallTotalCost > 0 ? round2((totalCost / overallTotalCost) * 100) : 0,
    };
  });
}

/**
 * Leave Hours Trend: total hours logged per month against the "Leaves"
 * service type only, over the resolved period. Reuses the same
 * fiscalYear/quarter/month/year/startDate/endDate/employeeId/clientId/poId/
 * serviceTypeId filters as the rest of Analytics2's period-scoped reports.
 * Every month in `months` is zero-filled so the trend never has gaps.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @param {{ year: number, month: number }[]} months - months to include, in order
 * @returns {Promise<{ month: string, leave_hours: number }[]>}
 */
async function buildLeaveHoursTrend(filters, months) {
  const rows = await dashboardRepo.getLeaveHoursTrend(filters);
  const hoursByMonth = new Map(rows.map((row) => [`${row.year}-${row.month}`, parseFloat(row.leave_hours) || 0]));

  return months.map(({ year, month }) => ({
    month: monthLabel(year, month),
    leave_hours: round2(hoursByMonth.get(`${year}-${month}`) || 0),
  }));
}

/**
 * No Work Trend: total hours logged per month against Service POs named
 * exactly "Idle" or "On Bench", over the resolved period. Reuses the same
 * fiscalYear/quarter/month/year/startDate/endDate/employeeId/clientId/poId/
 * serviceTypeId filters as the rest of Analytics2's period-scoped reports.
 * Every month in `months` is zero-filled so the trend never has gaps.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @param {{ year: number, month: number }[]} months - months to include, in order
 * @returns {Promise<{ month: string, no_work_hours: number }[]>}
 */
async function buildNoWorkTrend(filters, months) {
  const rows = await dashboardRepo.getNoWorkTrend(filters);
  const hoursByMonth = new Map(rows.map((row) => [`${row.year}-${row.month}`, parseFloat(row.no_work_hours) || 0]));

  return months.map(({ year, month }) => ({
    month: monthLabel(year, month),
    no_work_hours: round2(hoursByMonth.get(`${year}-${month}`) || 0),
  }));
}

/**
 * Project Wise Analytics: one row per Service PO (project) for the resolved
 * period — client, service-type category (dynamic, via
 * dashboardRepo.getProjectWiseAnalytics()'s service_categories join), total
 * cost, and a month-by-month cost breakdown. Reuses the same
 * fiscalYear/quarter/month/year/startDate/endDate/employeeId/clientId/poId/
 * serviceTypeId filters and the same `months` list (12 fiscal months / the
 * quarter's 3 months / a single month / a custom range's months) as the
 * rest of Analytics2's period-scoped reports. Every month in `months` is
 * zero-filled per project so the breakdown never has gaps. Projects are
 * returned in the order the repository query emits them (by service_po_id),
 * which is stable and predictable rather than re-sorted here.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @param {{ year: number, month: number }[]} months - months to include, in order
 * @returns {Promise<{
 *   service_po_id: number, project_name: string, client_name: string, category_name: string,
 *   total_cost: number, monthly_cost_breakdown: { month: string, cost: number }[]
 * }[]>}
 */
async function buildProjectWiseAnalytics(filters, months) {
  const rows = await dashboardRepo.getProjectWiseAnalytics(filters);

  const projectMap = new Map();
  for (const row of rows) {
    if (!projectMap.has(row.service_po_id)) {
      projectMap.set(row.service_po_id, {
        service_po_id: row.service_po_id,
        project_name: row.project_name,
        client_name: row.client_name,
        category_name: row.category_name,
        total_cost: 0,
        costByMonth: new Map(),
      });
    }
    const project = projectMap.get(row.service_po_id);
    const cost = round2(parseFloat(row.cost) || 0);
    project.costByMonth.set(`${row.year}-${row.month}`, cost);
    project.total_cost = round2(project.total_cost + cost);
  }

  return Array.from(projectMap.values()).map((project) => ({
    service_po_id: project.service_po_id,
    project_name: project.project_name,
    client_name: project.client_name,
    category_name: project.category_name,
    total_cost: project.total_cost,
    monthly_cost_breakdown: months.map(({ year, month }) => ({
      month: monthLabel(year, month),
      cost: round2(project.costByMonth.get(`${year}-${month}`) || 0),
    })),
  }));
}

/**
 * NEW analytics (additive, not a replacement of any existing report):
 * Budget Cost (cost_budget_master.invoice_amount) vs Actual Billed Amount
 * (service_po_monthly_budgets.billed_amount) comparison, built from
 * dashboardRepo.getBudgetVsBilled()'s flat per-(Service PO, month, year)
 * rows. Variance = Billed Amount - Budget Cost. Variance % = (Variance /
 * Budget Cost) x 100, returned as `null` (not 0 or Infinity) when Budget
 * Cost is 0 — a percentage of a zero budget is undefined, not zero.
 *
 * @param {object[]} rows - dashboardRepo.getBudgetVsBilled() rows: { service_po_id, service_po_code, service_po_name, client_name, year, month, budget_cost, billed_amount }
 * @returns {{
 *   monthly: { month: string, budget_cost: number, billed_amount: number, variance: number, variance_pct: number|null }[],
 *   by_service_po: { service_po_id: number, service_po_code: string, service_po_name: string, client_name: string, budget_cost: number, billed_amount: number, variance: number, variance_pct: number|null }[],
 *   summary: { total_budget_cost: number, total_billed_amount: number, total_variance: number, total_variance_pct: number|null },
 *   over_budget_service_pos: object[],
 *   under_budget_service_pos: object[],
 * }}
 */
function buildBudgetVsBilledAnalytics(rows) {
  const variancePct = (budget, variance) => (budget > 0 ? round2((variance / budget) * 100) : null);

  // ── A. Monthly Budget vs Billed ──────────────────────────────────────
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
      return { month: monthLabel(year, month), budget_cost, billed_amount, variance, variance_pct: variancePct(budget_cost, variance) };
    });

  // ── B. Service PO Budget vs Billed ───────────────────────────────────
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
  const by_service_po = Array.from(poMap.values()).map((po) => {
    const variance = round2(po.billed_amount - po.budget_cost);
    return { ...po, variance, variance_pct: variancePct(po.budget_cost, variance) };
  });

  // ── C. Overall Cost Summary ──────────────────────────────────────────
  const totalBudgetCost = round2(by_service_po.reduce((sum, po) => sum + po.budget_cost, 0));
  const totalBilledAmount = round2(by_service_po.reduce((sum, po) => sum + po.billed_amount, 0));
  const totalVariance = round2(totalBilledAmount - totalBudgetCost);
  const summary = {
    total_budget_cost: totalBudgetCost,
    total_billed_amount: totalBilledAmount,
    total_variance: totalVariance,
    total_variance_pct: variancePct(totalBudgetCost, totalVariance),
  };

  // ── D/E. Over-Budget / Under-Budget Service POs ──────────────────────
  const over_budget_service_pos = by_service_po.filter((po) => po.billed_amount > po.budget_cost);
  const under_budget_service_pos = by_service_po.filter((po) => po.billed_amount < po.budget_cost);

  return { monthly, by_service_po, summary, over_budget_service_pos, under_budget_service_pos };
}

/**
 * Client Wise Cost Analytics: total hours and total cost per client across
 * the ENTIRE dataset, sorted by total cost descending (already sorted by the
 * repository query). Takes no filters and applies none — fiscal year,
 * quarter, month/year, employeeId, clientId, poId, and serviceTypeId are all
 * intentionally ignored, unlike every other Analytics2 report. Client names
 * come straight from the clients table via
 * dashboardRepo.getClientWiseCostAnalytics() — nothing is hardcoded.
 *
 * @returns {Promise<{ client_id: number, client_name: string, total_hours: number, total_cost: number }[]>}
 */
async function buildClientWiseCostAnalytics(hoursSource, companyId) {
  const rows = await dashboardRepo.getClientWiseCostAnalytics(hoursSource, undefined, companyId);
  return rows.map((row) => ({
    client_id: row.client_id,
    client_name: row.client_name,
    total_hours: round2(parseFloat(row.total_hours) || 0),
    total_cost: round2(parseFloat(row.total_cost) || 0),
  }));
}

/**
 * Top Clients by Cost: every client ranked by total cost across the entire
 * (unfiltered, all-time) dataset, paginated independently of every other
 * Analytics2 report via its own topClientsPage/topClientsLimit query params
 * (default limit 15). rank is the 1-based position in the full ranking
 * (continues across pages), not a per-page index.
 *
 * Reuses buildClientWiseCostAnalytics() (already the correct, all-time,
 * cost-descending-sorted client list) and paginates it in memory, rather
 * than running its own separate cost query — the two are the exact same
 * dataset (same unfiltered, all-time scope; same JOINs; same ORDER BY total
 * cost) and had drifted into duplicate SQL that fixed the cost formula in
 * one place but not the other. Reusing the one already-fixed source means
 * this can't happen again.
 *
 * @param {{ page: number, limit: number, offset: number }} pagination
 * @returns {Promise<{ data: object[], pagination: { page: number, limit: number, total_records: number, total_pages: number } }>}
 */
async function buildTopClientsByCost(pagination, hoursSource, companyId) {
  const { page, limit, offset } = pagination;
  const allClients = await buildClientWiseCostAnalytics(hoursSource, companyId);

  const data = allClients.slice(offset, offset + limit).map((client, idx) => ({
    rank: offset + idx + 1,
    ...client,
  }));

  const meta = getPaginationMeta(allClients.length, page, limit);

  return {
    data,
    pagination: {
      page: meta.page,
      limit: meta.limit,
      total_records: meta.total,
      total_pages: meta.totalPages,
    },
  };
}

/**
 * Analytics2: Monthly Resource Utilization Percentage + Cost Trend by Type +
 * Client Wise Cost Analytics + Top Clients by Cost + Client x Category Cost
 * Matrix + Client Wise Analytics + Leave Hours Trend + No Work Trend +
 * Project Wise Analytics + Budget vs Billed. Ten separate reports sharing
 * one route/response — as of the Invoice Master cost migration, every
 * "cost"/"billed amount" figure among the first nine now sources from
 * service_po_monthly_budgets.billed_amount (Invoice Master) instead of
 * monthly_costs (see the "NEW IMPLEMENTATION" banner in
 * dashboardRepository.js); the tenth (budget_vs_billed) is new and
 * additionally reads cost_budget_master.invoice_amount as "Budget Cost".
 *
 * Filter behavior falls into three groups:
 * - Period-scoped (monthly_resource_utilization, cost_trend_by_type,
 *   client_wise_analytics, leave_hours_trend, no_work_trend,
 *   project_wise_analytics): reuse the same fiscal-year/period resolution
 *   helpers as getAnalyticsDashboard() so fiscalYear/quarter/month/year/
 *   startDate/endDate/employeeId/clientId/poId behave identically;
 *   serviceTypeId additionally scopes these six.
 * - Always unfiltered (client_wise_cost_analytics, top_clients_by_cost,
 *   client_category_cost_matrix): no query parameter affects any of these
 *   three — always the complete, all-time dataset.
 * - top_clients_by_cost is additionally paginated independently via its own
 *   topClientsPage/topClientsLimit query params.
 *
 * - monthly_resource_utilization: per month with any logged hours, the share
 *   of total hours logged against a Billable-category Service PO.
 *   Utilization % = (billable hours / total hours) x 100
 * - cost_trend_by_type: per month in the resolved period — all 12 fiscal
 *   months for a fiscal-year-only query, the 3 months of the quarter for a
 *   quarter query, or the single month for a month+year query — total cost
 *   broken down by service-type category.
 * - client_wise_cost_analytics: total hours/cost per client across the
 *   entire dataset (unfiltered), sorted by total cost descending.
 * - top_clients_by_cost: every client ranked by total cost, all-time,
 *   unfiltered, paginated (default 15 per page).
 * - client_category_cost_matrix: per client, total cost broken down by
 *   service-type category, plus the client's overall total cost — entire
 *   dataset, unfiltered.
 * - client_wise_analytics: total cost, total hours, average cost/hour,
 *   project count, and % of overall total cost, per client, for the
 *   resolved period.
 * - leave_hours_trend: per month in the resolved period, total hours logged
 *   against the "Leaves" service type only.
 * - no_work_trend: per month in the resolved period, total hours logged
 *   against Service POs named "Idle" or "On Bench" only.
 * - project_wise_analytics: one row per Service PO for the resolved period —
 *   client, service-type category (dynamic), total cost, and a month-by-
 *   month cost breakdown using the same month list as cost_trend_by_type.
 * - budget_vs_billed: NEW — Budget Cost (cost_budget_master.invoice_amount)
 *   vs Actual Billed Amount (service_po_monthly_budgets.billed_amount) for
 *   the resolved period, scoped by clientId/poId/serviceTypeId (employeeId
 *   does not apply — both source tables are Service-PO-level, never
 *   per-employee). See buildBudgetVsBilledAnalytics() for the monthly/
 *   per-Service-PO/summary/over-budget/under-budget breakdown.
 *
 * @param {object} query - {
 *   fiscalYear, quarter, month, year, startDate, endDate, employeeId,
 *   clientId, poId, serviceTypeId, topClientsPage, topClientsLimit
 * }
 * @returns {Promise<{
 *   monthly_resource_utilization: { month: string, total_hours: number, billable_hours: number, utilization_percentage: number }[],
 *   cost_trend_by_type: { month: string, categories: { category_name: string, cost: number }[] }[],
 *   client_wise_cost_analytics: { client_id: number, client_name: string, total_hours: number, total_cost: number }[],
 *   top_clients_by_cost: { data: object[], pagination: { page: number, limit: number, total_records: number, total_pages: number } },
 *   client_category_cost_matrix: { client_id: number, client_name: string, categories: object, total_cost: number }[],
 *   client_wise_analytics: object[],
 *   leave_hours_trend: { month: string, leave_hours: number }[],
 *   no_work_trend: { month: string, no_work_hours: number }[],
 *   project_wise_analytics: { service_po_id: number, project_name: string, client_name: string, category_name: string, total_cost: number, monthly_cost_breakdown: { month: string, cost: number }[] }[],
 *   budget_vs_billed: { monthly: object[], by_service_po: object[], summary: object, over_budget_service_pos: object[], under_budget_service_pos: object[] }
 * }>}
 */
async function getMonthlyResourceUtilization(query = {}, companyId) {
  const fiscalYear = resolveFiscalYear(query);
  const period = resolveAnalyticsPeriod(query, fiscalYear);

  const employeeId = query.employeeId ? parseInt(query.employeeId, 10) : undefined;
  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const poId = query.poId ? parseInt(query.poId, 10) : undefined;
  const serviceTypeId = query.serviceTypeId ? parseInt(query.serviceTypeId, 10) : undefined;

  const filters = { startDate: period.start, endDate: period.end, employeeId, clientId, poId, hoursSource: query.hoursSource, roleId: query.roleId, companyId };
  const costTrendFilters = { ...filters, serviceTypeId };
  const months = monthsInRange(period.start, period.end);

  // Top Clients by Cost paginates independently of everything else on this
  // endpoint — its own query params, defaulting to a page size of 15.
  const topClientsPagination = getPaginationParams({
    page: query.topClientsPage,
    limit: query.topClientsLimit || 15,
  });

  logger.info('Dashboard: getMonthlyResourceUtilization', {
    fiscalYear, period, employeeId, clientId, poId, serviceTypeId, topClientsPagination,
  });

  // Fetched once and shared with both cost_trend_by_type and
  // client_category_cost_matrix so the category list is only queried once.
  const categoryNames = (await serviceCategoryRepo.findAll({ companyId })).map((c) => c.name);

  // Publish visibility for Role ID 5 is applied per-row inside
  // buildAnalyticsFilters() (shared by getMonthlyBillableUtilization,
  // getCostTrendByType, getClientWiseAnalytics, getLeaveHoursTrend,
  // getNoWorkTrend, getProjectWiseAnalytics via `filters`/`costTrendFilters`
  // above): a timesheet row is only counted if its import batch is
  // published. That way a window spanning several months (a quarter, a
  // fiscal year) still shows real data for whichever of those months ARE
  // published, instead of blocking the whole window because one sibling
  // month isn't.
  //
  // client_category_cost_matrix, client_wise_cost_analytics, and
  // top_clients_by_cost are the exception: their own queries are still the
  // same whole-dataset aggregates (untouched — no "selected period" to
  // filter rows against), but for Role ID 5 specifically, the whole
  // response is withheld whenever the selected period isn't fully
  // published — matching every other gated report/dashboard entry point's
  // "block, don't partially populate" behavior.
  const blockAlwaysOnCostReports = await publishVisibilityService.shouldBlockUnpublishedData(
    { startDate: period.start, endDate: period.end },
    query.roleId
  );
  const emptyTopClientsByCost = {
    data: [],
    pagination: {
      page: topClientsPagination.page,
      limit: topClientsPagination.limit,
      total_records: 0,
      total_pages: 0,
    },
  };

  const [
    utilizationRows,
    costTrendByType,
    clientWiseCostAnalytics,
    topClientsByCost,
    clientCategoryCostMatrix,
    clientWiseAnalytics,
    leaveHoursTrend,
    noWorkTrend,
    projectWiseAnalytics,
    budgetVsBilledRows,
  ] = await Promise.all([
    dashboardRepo.getMonthlyBillableUtilization(filters),
    buildCostTrendByType(costTrendFilters, months, categoryNames),
    blockAlwaysOnCostReports ? [] : buildClientWiseCostAnalytics(query.hoursSource, companyId),
    blockAlwaysOnCostReports ? emptyTopClientsByCost : buildTopClientsByCost(topClientsPagination, query.hoursSource, companyId),
    blockAlwaysOnCostReports ? [] : buildClientCategoryCostMatrix(categoryNames, query.hoursSource, undefined, companyId),
    buildClientWiseAnalytics(costTrendFilters),
    buildLeaveHoursTrend(costTrendFilters, months),
    buildNoWorkTrend(costTrendFilters, months),
    buildProjectWiseAnalytics(costTrendFilters, months),
    // NEW — Budget Cost (cost_budget_master) vs Actual Billed Amount
    // (Invoice Master) comparison. Additive only; every report above is
    // unaffected by this addition.
    dashboardRepo.getBudgetVsBilled(costTrendFilters),
  ]);

  const monthlyResourceUtilization = utilizationRows.map((row) => {
    const totalHours = parseFloat(row.total_hours) || 0;
    const billableHours = parseFloat(row.billable_hours) || 0;
    return {
      month: monthLabel(row.year, row.month),
      total_hours: round2(totalHours),
      billable_hours: round2(billableHours),
      utilization_percentage: totalHours > 0 ? round2((billableHours / totalHours) * 100) : 0,
    };
  });

  return {
    monthly_resource_utilization: monthlyResourceUtilization,
    cost_trend_by_type: costTrendByType,
    client_wise_cost_analytics: clientWiseCostAnalytics,
    top_clients_by_cost: topClientsByCost,
    client_category_cost_matrix: clientCategoryCostMatrix,
    client_wise_analytics: clientWiseAnalytics,
    leave_hours_trend: leaveHoursTrend,
    no_work_trend: noWorkTrend,
    project_wise_analytics: projectWiseAnalytics,
    // NEW — additive field, see buildBudgetVsBilledAnalytics().
    budget_vs_billed: buildBudgetVsBilledAnalytics(budgetVsBilledRows),
  };
}

module.exports = {
  getDashboardStats,
  getEmployeeBillableBreakdown,
  getPOBillableBreakdown,
  getTopEmployeesByPO,
  getBillableTrend,
  getAnalyticsDashboard,
  getMonthlyResourceUtilization,
};