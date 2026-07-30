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
  employee: ['employee'],
  comparison: ['compare', 'comparison', ' vs ', ' versus '],
  executive_summary: ['executive summary', 'business overview', 'how are we doing', 'company overview', 'overall summary'],
};

const UNSUPPORTED_INTENT_KEYWORDS = {
  forecast: ['forecast', 'predict', 'projection', 'next quarter', 'next month trend'],
  recommendation: ['recommend', 'suggest a resource', 'best resource', 'who should i staff'],
  project_health: ['health score', 'project health', 'risk score'],
  what_if: ['what if', 'simulate', 'simulation', 'hypothetical'],
};

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

  return {
    matchedIntents,
    unsupportedIntents,
    period: extractPeriod(question),
  };
}

module.exports = { classifyIntent, SUPPORTED_INTENT_KEYWORDS, UNSUPPORTED_INTENT_KEYWORDS };
