'use strict';

const { sequelize, Employee, Company } = require('../models');
const { QueryTypes, Op } = require('sequelize');
const dashboardService = require('../services/dashboardService');
const reportService = require('../services/reportService');
const promptBuilder = require('../utils/promptBuilder');
const aiGateway = require('../providers/gateway.provider');
const { normalize } = require('../providers/responseNormalizer');
const { classifyIntent, extractHoursThreshold, SUGGESTED_QUESTIONS } = require('../utils/aiCopilotIntent');
const unmatchedQuestionRepo = require('../repositories/aiCopilotUnmatchedQuestionRepository');
const logger = require('../utils/logger');

/**
 * AI Copilot Service — Phase 1 (AI Chat API)
 *
 * Orchestrates: classify intent -> call EXISTING analytics services/models
 * (never a raw ad-hoc query built from user input, never new business
 * logic/formulas) -> merge results into one structured JSON object -> build
 * a prompt via the existing promptBuilder -> call the existing AI Gateway ->
 * return a normalized answer. The LLM never sees a table/column name, never
 * receives DB credentials, and never generates SQL — it only receives the
 * plain JSON objects below, exactly as dashboardService/reportService
 * already shape them for every other consumer in this app.
 *
 * Only intents backed by an existing, already-correct calculation are
 * "supported" here. Forecast/Recommendation(skill-match)/Project Health
 * (score)/What-If have no existing methodology anywhere in this codebase to
 * reuse — see aiCopilotIntent.js's UNSUPPORTED_INTENT_KEYWORDS — so instead
 * of inventing a formula and presenting it as the backend's calculation,
 * this returns an explicit "not available yet" response for those without
 * calling the AI Gateway at all.
 */

const round2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

// ── Per-intent instructions for the AI (what to do with the data, not what
// the data IS — the data itself is always the real, already-computed JSON) ──
const INTENT_INSTRUCTIONS = {
  utilization: 'The data lists each employee\'s billable/non-billable hours and total utilization for the stated month. Identify who is under-utilized (low total_utilization relative to the standard monthly cap hours (about one month of full-time work)) or over-utilized, and name them specifically.',
  hours_filled: 'The data lists the employees whose total hours filled in the stated month match the user\'s hours condition (threshold.operator: lt = less than, lte = at most, gt = more than, gte = at least; threshold.hours is the number). total_hours is everything the employee filled in the month, leave hours included (leaves_hours shows the leave part). List every employee shown, by name, with their total_hours, in the given order. State matching_count and the period. If truncated is true, say that only the first shown_count of matching_count are listed.',
  bench: 'The data lists employees currently on bench (idle) with their bench hours and bench percentage over the trailing window described in the data. Summarize who is on bench and for how long.',
  timesheet: 'The data lists active employees missing a timesheet entry for the specified check date. State exactly who is missing an entry and how many employees that is.',
  cost: 'The data lists cost records (salary/ops/total cost) for the stated month. Summarize total cost and any notably high-cost entries.',
  revenue: 'The data gives the total Service PO contract value (revenue) for the stated period. State the figure and what period it covers.',
  profit: 'The data gives revenue, cost, and profit (revenue - cost) for the stated period. State all three figures and whether profit is positive or negative.',
  client: 'The data lists hours logged per client for the stated period. Summarize which clients had the most/least activity.',
  project: 'The data lists Service POs with their value, expected hours, and billing status for the stated month. hours_delivered_before_month is the cumulative hours delivered BEFORE the first day of the stated month (history) — it is NOT the hours logged during the stated month, so never describe it as that. Summarize notable POs (e.g. over/under-utilized against expected hours).',
  po_hours: 'The data lists the Service POs that had hours logged DURING the stated month (hours_logged_in_month), most hours first; hours before that month are not included. List every Service PO shown, with its client and hours_logged_in_month, exactly as given. State po_count_with_hours and total_hours for the month. If threshold is present, only POs matching it are listed (lt = less than, lte = at most, gt = more than, gte = at least). If truncated is true, say that only the first shown_count of po_count_with_hours are listed. If po_count_with_hours is 0, say no Service PO had hours logged in that month.',
  resource: 'The data lists hours by employee and bench percentages for the stated period. Summarize resource allocation and any imbalances.',
  employee: 'The data lists per-employee hours/utilization for the stated period, filtered to the named employee(s) where possible. Answer specifically about the named employee(s) if present in the data, otherwise summarize across all employees shown.',
  comparison: 'The data includes hours-by-employee and hours-by-client for the stated period. Compare the specific entities the user named in their question using only the figures present in the data.',
  executive_summary: 'The data is a snapshot of workforce, portfolio, financials, and utilization tiles for the stated period. Produce a concise executive-level overview.',
};

/**
 * Most recent weekday (Mon-Fri) strictly before today — same rule as the
 * existing timesheet-compliance check elsewhere in this codebase (weekends
 * skipped, no holiday calendar). Re-implemented locally: the AI Insights
 * job that used to compute this (aiInsightDataRepository.js) no longer
 * exports a usable function for it (see note in the final report), and this
 * copilot must not modify that file.
 * @returns {string} YYYY-MM-DD
 */
function mostRecentWeekday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The caller's company scope as a list of ids: the reach array (req.companyIds), or a single id.
 * Anything else (no scope) is an empty list, which matches nothing — never "everything".
 * @param {number|number[]|null|undefined} companyId
 * @returns {number[]}
 */
function toCompanyIdList(companyId) {
  if (Array.isArray(companyId)) return companyId.filter((id) => Number.isInteger(id));
  return Number.isInteger(companyId) ? [companyId] : [];
}

/**
 * New, independent query (not a modification of any existing repository) —
 * mirrors the same "active, non-deleted employee with zero timesheet rows
 * on the most recent weekday" logic this codebase already uses elsewhere,
 * built directly against the Employee/Timesheet tables via sequelize.query
 * with bound replacements (no string concatenation of user input).
 */
async function getMissingTimesheetData(companyId) {
  const checkDate = mostRecentWeekday();
  const companyIds = toCompanyIdList(companyId);
  if (companyIds.length === 0) {
    return { checked_date: checkDate, missing_timesheet_count: 0, missing_employees: [] };
  }
  const rows = await sequelize.query(
    `SELECT e.id AS employee_id, e.full_name, e.designation
     FROM employees e
     WHERE e.is_deleted = false AND e.status = 'active'
       AND (e.company_id IN (:companyIds) OR EXISTS (
         SELECT 1 FROM employee_business_units ebu
         WHERE ebu.employee_id = e.id AND ebu.business_unit_id IN (:companyIds) AND ebu.status = 'active'
       ))
       AND NOT EXISTS (
         SELECT 1 FROM timesheets t WHERE t.employee_id = e.id AND t.timesheet_date = :checkDate
       )
     ORDER BY e.full_name
     LIMIT 50`,
    { replacements: { checkDate, companyIds }, type: QueryTypes.SELECT }
  );

  return {
    checked_date: checkDate,
    missing_timesheet_count: rows.length,
    missing_employees: rows,
  };
}

/**
 * Best-effort: does the question mention a specific employee by name? Used
 * only to narrow the "employee"/"comparison" intents when possible — falls
 * back to returning all employees' data (letting the AI narrow it in the
 * answer) if no confident name match is found. No fuzzy matching library —
 * a plain case-insensitive substring check against active employees'
 * full_name, reusing the existing Employee model.
 */
async function findMentionedEmployeeIds(question, companyId) {
  const q = question.toLowerCase();
  const companyIds = toCompanyIdList(companyId);
  if (companyIds.length === 0) return [];
  const employees = await Employee.findAll({
    where: {
      is_deleted: false,
      status: 'active',
      [Op.or]: [{ company_id: { [Op.in]: companyIds } }, { '$businessUnits.id$': { [Op.in]: companyIds } }],
    },
    attributes: ['id', 'full_name'],
    include: [{ model: Company, as: 'businessUnits', attributes: [], through: { attributes: [] } }],
  });
  return employees
    .filter((e) => q.includes(e.full_name.toLowerCase()))
    .map((e) => e.id);
}

// ── Intent -> existing-service data collectors ──────────────────────────────
// Every collector calls an EXISTING service function (dashboardService /
// reportService, already used by every other endpoint in this app) or the
// one small new query above — never a new aggregation/formula.
// Small LLM-facing row limit — separate from the report/service call's own
// pagination (which still runs normally). Free-tier providers (e.g. Groq's
// default TPM limit) reject an overly large prompt outright rather than
// gracefully truncating, so the copilot keeps what it forwards to the model
// compact regardless of how many rows the underlying report actually has.
const MAX_ROWS_TO_AI = 25;

// "Who filled fewer than N hours" has to look at EVERY employee in the caller's reach, not just the first page of
// the utilization report — but it forwards only a compact list to the model (id + name + hours is ~30 tokens a row).
const MAX_HOURS_FILLED_ROWS = 100;
const UTILIZATION_PAGE_SIZE = 100; // the report's own page-size ceiling
const MAX_UTILIZATION_PAGES = 40; // 4,000 employees — a safety stop, not an expected size

const MAX_PO_HOURS_ROWS = 60;

const HOURS_COMPARATORS = {
  lt: (hours, threshold) => hours < threshold,
  lte: (hours, threshold) => hours <= threshold,
  gt: (hours, threshold) => hours > threshold,
  gte: (hours, threshold) => hours >= threshold,
};

/**
 * Every employee row of the (already BU-scoped) Employee Utilization Summary for one month, all pages.
 * The report starts from the active employees and LEFT JOINs their timesheets, so an employee who filled
 * nothing is still a row (with 0 hours) — which is exactly who a "less than N hours" question is after.
 */
async function fetchAllUtilizationRows({ month, year, roleId, hoursSource }, companyId) {
  const rows = [];
  for (let page = 1; page <= MAX_UTILIZATION_PAGES; page += 1) {
    const { data, meta } = await reportService.getEmployeeUtilizationSummary(
      { month, year, roleId, hoursSource, page, limit: UTILIZATION_PAGE_SIZE, sortBy: 'full_name', sortOrder: 'ASC' },
      companyId
    );
    rows.push(...data);
    if (!meta || page >= meta.totalPages) break;
  }
  return rows;
}

/** Strip a row down to only the fields the AI actually needs to reason about. */
const pickUtilization = (r) => ({
  employee_id: r.employee_id,
  full_name: r.full_name,
  billable_total: r.billable_total,
  non_billable_total: r.non_billable_total,
  leaves_hours: r.leaves_hours,
  total_utilization_excl_leaves_pct: r.total_utilization_excl_leaves_pct,
});
const pickCost = (r) => ({
  employee_id: r.employee_id,
  full_name: r.full_name,
  salary_cost: r.salary_cost,
  ops_cost: r.ops_cost,
  total_cost: r.total_cost,
});
const pickServicePO = (r) => ({
  service_po_id: r.service_po_id,
  service_po_name: r.service_po_name,
  client_name: r.client_name,
  po_value: r.po_value,
  hours_delivered_before_month: r.hours_delivered_before_month,
  monthly_billable_amount: r.monthly_billable_amount,
});

const INTENT_COLLECTORS = {
  utilization: async ({ month, year, roleId, hoursSource, companyId }) => {
    const { data, summary } = await reportService.getEmployeeUtilizationSummary({ month, year, roleId, hoursSource, page: 1, limit: 100 }, companyId);
    return { month, year, employee_count: data.length, employees: data.slice(0, MAX_ROWS_TO_AI).map(pickUtilization), summary };
  },
  bench: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    return { month, year, employee_bench_pct: analytics.charts.employee_bench_pct.slice(0, MAX_ROWS_TO_AI) };
  },
  po_hours: async ({ month, year, roleId, hoursSource, companyId }, question) => {
    const threshold = extractHoursThreshold(question); // optional: "... more than 100 hours"
    const rows = [];
    for (let page = 1; page <= MAX_UTILIZATION_PAGES; page += 1) {
      const { data, meta } = await reportService.getServicePOHoursBudgetReport(
        { month, year, roleId, hoursSource, page, limit: UTILIZATION_PAGE_SIZE, sortBy: 'total_hours', sortOrder: 'DESC' },
        companyId
      );
      rows.push(...data);
      if (!meta || page >= meta.totalPages) break;
    }

    // the report also lists POs that only have a budget this month (0 hours) — they did not log anything
    const withHours = rows.filter((r) => parseFloat(r.total_hours || 0) > 0);
    const matching = threshold ? withHours.filter((r) => HOURS_COMPARATORS[threshold.operator](parseFloat(r.total_hours), threshold.hours)) : withHours;
    const ascending = threshold && (threshold.operator === 'lt' || threshold.operator === 'lte');
    const service_pos = matching
      .map((r) => ({
        service_po_id: r.service_po_id,
        service_po_code: r.service_po_code,
        service_po_name: r.service_po_name,
        client_name: r.client_name,
        hours_logged_in_month: round2(r.total_hours),
      }))
      .sort((a, b) => (ascending ? a.hours_logged_in_month - b.hours_logged_in_month : b.hours_logged_in_month - a.hours_logged_in_month) || String(a.service_po_name).localeCompare(String(b.service_po_name)));

    return {
      month,
      year,
      ...(threshold ? { threshold } : {}),
      po_count_with_hours: service_pos.length,
      total_hours: round2(service_pos.reduce((sum, r) => sum + r.hours_logged_in_month, 0)),
      shown_count: Math.min(service_pos.length, MAX_PO_HOURS_ROWS),
      truncated: service_pos.length > MAX_PO_HOURS_ROWS,
      service_pos: service_pos.slice(0, MAX_PO_HOURS_ROWS),
    };
  },
  hours_filled: async ({ month, year, roleId, hoursSource, companyId }, question) => {
    const threshold = extractHoursThreshold(question);
    const matches = HOURS_COMPARATORS[threshold.operator];
    const rows = await fetchAllUtilizationRows({ month, year, roleId, hoursSource }, companyId);

    const employees = rows
      .map((r) => ({
        employee_id: r.employee_id,
        full_name: r.full_name,
        total_hours: round2(parseFloat(r.billable_total || 0) + parseFloat(r.non_billable_total || 0)),
        leaves_hours: round2(r.leaves_hours),
      }))
      .filter((e) => matches(e.total_hours, threshold.hours));

    // closest to the limit the user is asking about first: fewest hours for "less than", most for "more than"
    const ascending = threshold.operator === 'lt' || threshold.operator === 'lte';
    employees.sort((a, b) => (ascending ? a.total_hours - b.total_hours : b.total_hours - a.total_hours) || a.full_name.localeCompare(b.full_name));

    return {
      month,
      year,
      threshold,
      employees_checked: rows.length,
      matching_count: employees.length,
      shown_count: Math.min(employees.length, MAX_HOURS_FILLED_ROWS),
      truncated: employees.length > MAX_HOURS_FILLED_ROWS,
      employees: employees.slice(0, MAX_HOURS_FILLED_ROWS),
    };
  },
  timesheet: async ({ companyId }) => getMissingTimesheetData(companyId),
  cost: async ({ month, year, roleId, hoursSource, companyId }) => {
    const { data, summary } = await reportService.getMonthlyCostSummary({ month, year, roleId, hoursSource, page: 1, limit: 100 }, companyId);
    return { month, year, record_count: data.length, records: data.slice(0, MAX_ROWS_TO_AI).map(pickCost), summary };
  },
  revenue: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    return { month, year, total_po_value: analytics.financials.total_po_value_fiscal_year };
  },
  profit: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    const revenue = analytics.financials.total_po_value_fiscal_year;
    const cost = analytics.tiles.total_cost;
    return { month, year, revenue, cost, profit: round2(revenue - cost) };
  },
  client: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    return { month, year, hours_by_client: analytics.charts.hours_by_client.slice(0, MAX_ROWS_TO_AI) };
  },
  project: async ({ month, year, roleId, hoursSource, companyId }) => {
    const { data, summary } = await reportService.getServicePOSummary({ month, year, roleId, hoursSource, page: 1, limit: 100 }, companyId);
    return { month, year, service_po_count: data.length, service_pos: data.slice(0, MAX_ROWS_TO_AI).map(pickServicePO), summary };
  },
  resource: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    return {
      month, year,
      hours_by_employee: analytics.charts.hours_by_employee.slice(0, MAX_ROWS_TO_AI),
      employee_bench_pct: analytics.charts.employee_bench_pct.slice(0, MAX_ROWS_TO_AI),
    };
  },
  employee: async ({ month, year, roleId, hoursSource, companyId }, question) => {
    const employeeIds = await findMentionedEmployeeIds(question, companyId);
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    const rows = employeeIds.length > 0
      ? analytics.charts.hours_by_employee.filter((r) => employeeIds.includes(r.employee_id))
      : analytics.charts.hours_by_employee.slice(0, MAX_ROWS_TO_AI);
    return { month, year, matched_employee_ids: employeeIds, employees: rows };
  },
  comparison: async ({ month, year, roleId, hoursSource, companyId }, question) => {
    const employeeIds = await findMentionedEmployeeIds(question, companyId);
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    const employees = employeeIds.length > 0
      ? analytics.charts.hours_by_employee.filter((r) => employeeIds.includes(r.employee_id))
      : analytics.charts.hours_by_employee.slice(0, MAX_ROWS_TO_AI);
    return { month, year, hours_by_employee: employees, hours_by_client: analytics.charts.hours_by_client.slice(0, MAX_ROWS_TO_AI) };
  },
  executive_summary: async ({ month, year, roleId, hoursSource, companyId }) => {
    const analytics = await dashboardService.getAnalyticsDashboard({ month, year, roleId, hoursSource }, companyId);
    return {
      month, year,
      workforce: analytics.workforce,
      portfolio: analytics.portfolio,
      financials: analytics.financials,
      tiles: analytics.tiles,
    };
  },
};

const SUPPORTED_TOPICS_MESSAGE =
  'I can currently answer questions about: utilization, bench, timesheet compliance, cost, revenue, profit, clients, resources/allocation, projects/Service POs, specific employees, comparisons, and an executive summary. ' +
  'Forecasting, resource recommendations, project health scoring, and what-if simulations are not available yet.';

/**
 * Remember a question the copilot could not answer, so the team can see what people really ask.
 * Fire-and-forget: saving it must never slow down, or break, the reply the user is waiting for.
 */
function recordUnmatchedQuestion({ question, reason, employeeId, companyId }) {
  return unmatchedQuestionRepo
    .record({ question, reason, employeeId, companyIds: toCompanyIdList(companyId) })
    .catch((err) => logger.warn('AI Copilot: could not save an unmatched question', { error: err.message }));
}

/**
 * @param {object} params
 * @param {string} params.question
 * @param {number} [params.roleId]      - passed through to underlying services, same optional convention every other analytics endpoint in this app already uses
 * @param {string} [params.hoursSource] - same convention ('O'|'M')
 * @param {string[]} [params.audienceRoles] - the caller's actual roles, for prompt context only
 * @param {number|number[]} params.companyId - the caller's authorized company reach (req.companyIds)
 * @returns {Promise<object>}
 */
async function answerQuestion({ question, roleId, hoursSource, audienceRoles = [], companyId, employeeId }) {
  const { matchedIntents, unsupportedIntents, period } = classifyIntent(question);

  if (matchedIntents.length === 0) {
    if (unsupportedIntents.length > 0) {
      recordUnmatchedQuestion({ question, reason: 'unsupported', employeeId, companyId });
      return {
        question,
        intents_detected: [],
        unsupported_intents_detected: unsupportedIntents,
        period,
        data: null,
        suggested_questions: SUGGESTED_QUESTIONS,
        answer: {
          summary: `That question is about ${unsupportedIntents.join(', ')}, which isn't available yet. ${SUPPORTED_TOPICS_MESSAGE}`,
          findings: [],
          actions: [],
          priority: 'info',
        },
      };
    }
    recordUnmatchedQuestion({ question, reason: 'unmatched', employeeId, companyId });
    return {
      question,
      intents_detected: [],
      unsupported_intents_detected: [],
      period,
      data: null,
      suggested_questions: SUGGESTED_QUESTIONS,
      answer: {
        summary: `I couldn't match that question to a topic I can answer yet. ${SUPPORTED_TOPICS_MESSAGE} You can try one of the suggested questions, or rephrase yours around one of these topics. We keep track of questions like this to decide what to add next.`,
        findings: [],
        actions: [],
        priority: 'info',
      },
    };
  }

  logger.info('AI Copilot: question classified', { question, matchedIntents, unsupportedIntents, period });

  // No Business Unit in reach (e.g. an Admin who owns nothing yet): there is no data to look at, and the
  // underlying queries must never be run with an empty scope.
  if (toCompanyIdList(companyId).length === 0) {
    return {
      question,
      intents_detected: matchedIntents,
      unsupported_intents_detected: unsupportedIntents,
      period,
      data: null,
      answer: {
        summary: 'No Business Unit is available to your account yet, so there is no data to answer this question.',
        findings: [],
        actions: [],
        priority: 'info',
      },
    };
  }

  const filters = { month: period.month, year: period.year, roleId, hoursSource, companyId };

  const collectedEntries = await Promise.all(
    matchedIntents.map(async (intent) => {
      const collector = INTENT_COLLECTORS[intent];
      const data = await collector(filters, question);
      return [intent, data];
    })
  );
  const data = Object.fromEntries(collectedEntries);

  const instructions = [
    `User's question (answer this directly, using only the data below): "${question}"`,
    '',
    ...matchedIntents.map((intent) => `- For the "${intent}" data: ${INTENT_INSTRUCTIONS[intent]}`),
    ...(unsupportedIntents.length > 0
      ? [
          '',
          `The question also touched on ${unsupportedIntents.join(', ')}, which this system cannot compute yet (no forecasting/recommendation/health-score/simulation capability exists). ` +
            'Explicitly say that part of the question isn\'t answerable yet, then answer only the part backed by the data below.',
        ]
      : []),
  ].join('\n');

  const jobKey = `ai_copilot_${matchedIntents.join('_')}`;
  const prompt = promptBuilder.buildBasePrompt({
    jobKey,
    audienceRoles: audienceRoles.length > 0 ? audienceRoles : ['User'],
    instructions,
    data,
  });

  const aiResponse = await aiGateway.generateInsight(jobKey, prompt);
  const normalized = normalize(jobKey, aiResponse);

  return {
    question,
    intents_detected: matchedIntents,
    unsupported_intents_detected: unsupportedIntents,
    period,
    data,
    answer: {
      summary: normalized.summary,
      findings: normalized.findings,
      actions: normalized.actions,
      priority: normalized.severity,
    },
  };
}

module.exports = { answerQuestion };
