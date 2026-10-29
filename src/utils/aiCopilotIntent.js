'use strict';

const dateHelper = require('../helpers/dateHelper');

/**
 * AI Copilot — Intent Classification
 *
 * Deterministic, keyword-based classification (no LLM call, no external
 * NLP library) — matches this codebase's existing style of explicit,
 * auditable rules rather than a black-box classifier, and avoids spending a
 * second AI Gateway round-trip just to figure out what to ask the first one.
 *
 * A question can match more than one intent (e.g. "utilization and cost for
 * July") — every matched intent's data is collected and merged before a
 * single prompt is built, per the "aggregate before sending to AI" rule.
 *
 * Intents are split into two groups:
 *   - SUPPORTED: backed by data this codebase already computes somewhere
 *     (dashboardService, reportService, or a small new query reusing
 *     existing models — never a new invented formula).
 *   - UNSUPPORTED: named in the product spec (Forecast, Recommendation,
 *     Project Health, What-If) but this codebase has no existing
 *     forecasting method, skill taxonomy, or health-score formula to base
 *     them on. Detected so the copilot can say so honestly instead of
 *     silently mis-firing a wrong intent or fabricating an answer.
 */

const SUPPORTED_INTENT_KEYWORDS = {
  utilization: ['utilization', 'utilisation', 'underutilized', 'underutilised', 'overutilized', 'overutilised', 'billable percentage'],
  bench: ['bench', 'idle', 'unassigned', 'no active project', 'sitting free'],
  timesheet: ['timesheet', 'time sheet', 'missing entry', 'missing entries', 'late submission', 'late entr'],
  cost: ['cost', 'expense', 'spend', 'spending'],
  revenue: ['revenue', 'po value', 'sales', 'contract value'],
  profit: ['profit', 'margin', 'profitability'],
  client: ['client', 'customer'],
  project: ['project', 'service po', 'po status', 'purchase order'],
  resource: ['resource', 'allocation', 'staffing', 'headcount', 'workforce'],
  // misspellings are listed on purpose: a typo ("eployee") must not turn a valid question into "unmatched"
  employee: ['employee', 'eployee', 'employe ', 'emplyee', 'empolyee', 'emploee'],
  comparison: ['compare', 'comparison', ' vs ', ' versus '],
  executive_summary: ['executive summary', 'business overview', 'how are we doing', 'company overview', 'overall summary'],
};

const UNSUPPORTED_INTENT_KEYWORDS = {
  forecast: ['forecast', 'predict', 'projection', 'next quarter', 'next month trend'],
  recommendation: ['recommend', 'suggest a resource', 'best resource', 'who should i staff'],
  project_health: ['health score', 'project health', 'risk score'],
  what_if: ['what if', 'simulate', 'simulation', 'hypothetical'],
};

/**
 * "hours_filled": a question about how many hours employees filled, against a number the user
 * gave — "employees who filled less than 178 hours last month", "who logged more than 200 hrs".
 * It is not keyword-based: it needs a comparison word AND a number.
 *   lt  < less than / fewer than / below / under / lower than / <
 *   lte <= at most / up to / no more than / maximum / or less / or fewer
 *   gt  > more than / greater than / above / over / exceeding / higher than
 *   gte >= at least / minimum / no less than / or more
 * The number needs a unit (hours / hrs / h) or the question has to talk about filled / logged / worked
 * hours, so "cost below 5000" is not mistaken for an hours question.
 */
const HOURS_OPERATORS = [
  // order matters: the "or equal" phrases must be tried before their plain forms
  { op: 'lte', before: /\b(?:at most|up to|no more than|not more than|maximum(?: of)?|less than or equal to)\b|<=/, after: /\b(?:or less|or fewer|or below)\b/ },
  { op: 'gte', before: /\b(?:at least|no less than|not less than|minimum(?: of)?|greater than or equal to)\b|>=/, after: /\b(?:or more|or above|or greater)\b/ },
  { op: 'lt', before: /\b(?:less than|fewer than|lower than|below|under)\b|</, after: null },
  { op: 'gt', before: /\b(?:more than|greater than|higher than|above|over|exceeding|exceeds?)\b|>/, after: null },
];
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const HOURS_UNIT = '(?:hours?|hrs?|h)\\b';
const HOURS_TOPIC = /\b(?:hours?|hrs?|filled|logged|worked|timesheet)\b/;

/**
 * @param {string} question
 * @returns {{ operator: 'lt'|'lte'|'gt'|'gte', hours: number } | null}
 */
function extractHoursThreshold(question) {
  const q = String(question || '').toLowerCase();
  if (!HOURS_TOPIC.test(q)) return null;

  for (const { op, before, after } of HOURS_OPERATORS) {
    // "<operator> 178 [hours]"
    const prefix = new RegExp(`(?:${before.source})\\s*${NUMBER}\\s*(${HOURS_UNIT})?`).exec(q);
    if (prefix) {
      const hours = parseFloat(prefix[1]);
      if (Number.isFinite(hours)) return { operator: op, hours };
    }
    // "178 [hours] <or less / or more>"
    if (after) {
      const suffix = new RegExp(`${NUMBER}\\s*(?:${HOURS_UNIT})?\\s*(?:${after.source})`).exec(q);
      if (suffix) {
        const hours = parseFloat(suffix[1]);
        if (Number.isFinite(hours)) return { operator: op, hours };
      }
    }
  }
  return null;
}

/**
 * "po_hours": a question about the hours logged against Service POs / projects in a period —
 * "in september which service PO filled logs", "hours by service po last month", "po wise hours".
 * It needs a Service PO / project word AND an hours / logging word, so "which projects are over budget"
 * (no hours word) stays a plain "project" question. A PO question is answered from the hours actually
 * logged IN the month, never from the project summary's "hours delivered before the month".
 */
const PO_TERM = /\b(?:service\s*pos?|pos|po|purchase orders?|projects?)\b/;
const HOURS_OR_LOG_TERM = /\b(?:hours?|hrs?|logs?|logged|logging|filled|filling|booked|worked|timesheets?)\b/;

function isPoHoursQuestion(question) {
  const q = String(question || '').toLowerCase();
  return PO_TERM.test(q) && HOURS_OR_LOG_TERM.test(q);
}

/**
 * Example questions shown to the user when theirs could not be matched. Every one of them is matched by
 * classifyIntent() (a test enforces it), so clicking one always gets a real answer.
 */
const SUGGESTED_QUESTIONS = [
  'Who is underutilized this month?',
  'Which employees are on bench?',
  'Who has not filled their timesheet?',
  'Employees who filled less than 178 hours last month',
  'What is the cost for last month?',
  'Which clients had the most hours this month?',
  'Which Service POs logged hours last month?',
  'Which projects are over budget?',
  'Give me an executive summary',
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * @param {string} question
 * @returns {{ month: number, year: number, explicit: boolean }}
 */
function extractPeriod(question) {
  const q = question.toLowerCase();

  const monthIdx = MONTH_NAMES.findIndex((name) => q.includes(name));
  if (monthIdx !== -1) {
    const yearMatch = q.match(/\b(20\d{2})\b/);
    return {
      month: monthIdx + 1,
      year: yearMatch ? parseInt(yearMatch[1], 10) : dateHelper.getCurrentYear(),
      explicit: true,
    };
  }

  if (/\blast month\b|\bprevious month\b/.test(q)) {
    const month = dateHelper.getCurrentMonth();
    const year = dateHelper.getCurrentYear();
    return month === 1
      ? { month: 12, year: year - 1, explicit: true }
      : { month: month - 1, year, explicit: true };
  }

  // Default: "this month" / "current month" / no period mentioned at all.
  return { month: dateHelper.getCurrentMonth(), year: dateHelper.getCurrentYear(), explicit: false };
}

/**
 * @param {string} question
 * @returns {{
 *   matchedIntents: string[],
 *   unsupportedIntents: string[],
 *   period: { month: number, year: number, explicit: boolean },
 *   hoursThreshold: { operator: string, hours: number } | null,
 * }}
 */
function classifyIntent(question) {
  const q = ` ${question.toLowerCase()} `;

  const matchedIntents = Object.keys(SUPPORTED_INTENT_KEYWORDS).filter((intent) =>
    SUPPORTED_INTENT_KEYWORDS[intent].some((kw) => q.includes(kw))
  );

  const unsupportedIntents = Object.keys(UNSUPPORTED_INTENT_KEYWORDS).filter((intent) =>
    UNSUPPORTED_INTENT_KEYWORDS[intent].some((kw) => q.includes(kw))
  );

  // "employees who filled less than N hours": the dedicated intent already lists the employees with their
  // hours, so the generic per-employee intent is dropped (it would only add a second, larger data set).
  // "which service PO logged hours in September": answered from the hours logged IN that month per PO; the
  // generic "project" intent (project summary) is dropped so its "hours before the month" column cannot be
  // mistaken for them. A number in such a question ("more than 100 hours") then applies to the POs.
  const poHours = isPoHoursQuestion(question);
  if (poHours) {
    matchedIntents.push('po_hours');
    const projectIdx = matchedIntents.indexOf('project');
    if (projectIdx !== -1) matchedIntents.splice(projectIdx, 1);
  }

  const hoursThreshold = extractHoursThreshold(question);
  if (hoursThreshold && !poHours) {
    matchedIntents.push('hours_filled');
    const employeeIdx = matchedIntents.indexOf('employee');
    if (employeeIdx !== -1) matchedIntents.splice(employeeIdx, 1);
  }

  return {
    matchedIntents,
    unsupportedIntents,
    period: extractPeriod(question),
    hoursThreshold,
  };
}

module.exports = { classifyIntent, extractHoursThreshold, isPoHoursQuestion, SUGGESTED_QUESTIONS, SUPPORTED_INTENT_KEYWORDS, UNSUPPORTED_INTENT_KEYWORDS };
