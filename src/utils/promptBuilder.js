'use strict';

/**
 * Prompt Builder
 *
 * Every AI Insight job has its own instruction template below, but they all
 * share one base builder and one response contract — this is the single
 * place prompt text is assembled, so there is no duplicated prompt-shaping
 * logic scattered across the scheduler/service layer.
 *
 * The scheduler/service always calls buildPrompt(jobKey, data, audienceRoles)
 * with the summarized JSON produced by aiInsightDataRepository.js — never
 * raw table rows.
 */

const RESPONSE_CONTRACT = `
Respond with ONLY valid JSON — no markdown, no code fences, no explanation before or after it.
The JSON must have exactly this shape:
{
  "job_key": string,
  "title": string,
  "severity": "critical" | "warning" | "info",
  "summary": string,
  "findings": string[],
  "actions": string[],
  "audience_roles": string[]
}
- "summary" is a short (2-4 sentence) executive overview.
- "findings" is an array of concise, specific observation strings, each grounded strictly in the data below.
- "actions" is an array of concrete, prioritized recommended actions.
- Never invent numbers, names, or facts that are not present in the data below.
- If the data shows no notable issues, still return valid JSON with severity "info" and say so plainly.
`.trim();

// Applies to every job whose data may include monetary values — a no-op for
// jobs whose data has none. Kept as one shared block rather than repeated
// per-template so the rule can never be missed for a job that adds a cost
// field later.
const CURRENCY_INSTRUCTION = `
Currency: this project operates in Indian Rupees. Whenever the data below contains a monetary value (cost, revenue, billing amount, project cost, client cost, etc.), always display it with the ₹ symbol. Never use "$" or the word "USD". Never convert currency or assume an exchange rate — if the data already provides a formatted INR value, use it exactly as given; otherwise simply prefix the numeric value with ₹.
`.trim();

/**
 * @param {object} params
 * @param {string} params.jobKey
 * @param {string[]} params.audienceRoles
 * @param {string} params.instructions - Job-specific guidance for the model
 * @param {object} params.data - Summarized business data (never raw tables)
 * @returns {string}
 */
function buildBasePrompt({ jobKey, audienceRoles, instructions, data }) {
  return [
    'You are an AI analyst for the RUT Portal (Resource Utilization Tracker) — an internal workforce/project analytics platform.',
    `Job: ${jobKey}`,
    `Intended audience role(s): ${audienceRoles.join(', ')}`,
    '',
    instructions.trim(),
    '',
    CURRENCY_INSTRUCTION,
    '',
    'Business data summary (JSON — this is the complete data you have access to):',
    JSON.stringify(data),
    '',
    RESPONSE_CONTRACT,
    '',
    `Set "job_key" to exactly "${jobKey}" and "audience_roles" to exactly ${JSON.stringify(audienceRoles)}.`,
  ].join('\n');
}

/**
 * Per-job instruction templates. Each entry is (data) => prompt string.
 * Keys MUST match the job_key values used by aiInsightJobRepository.js and
 * aiInsightDataRepository.js.
 */
const JOB_TEMPLATES = {
  weekly_resource_digest: {
    audienceRoles: ['Management'],
    instructions: `Generate a Weekly Resource Digest summarizing the just-ended work week for Management.
Cover: overall utilization (hours/billable/utilization %), the biggest risks visible in the data (bench, sole-contributor concentration, etc.), notable achievements (e.g. POs completed, strong client delivery), and the top 3 recommended actions for the week ahead.`,
  },
  po_ending_alerts: {
    audienceRoles: ['Project Manager', 'Division Head'],
    instructions: `Generate PO Ending Alerts for Project Managers and Division Heads.

The data buckets Service POs ending soon into three windows — within_7_days, within_15_days, within_30_days (each entry has service_po_name, client_name, end_date, days_remaining) — plus a combined employees_becoming_free list (employees whose every active PO assignment ends within the next 30 days) and candidate_open_projects (understaffed active projects to consider for reallocation).

A bare count (e.g. "6 POs") is not sufficient — always list the individual POs. Follow this structure:
- Dates in the data are ISO format (YYYY-MM-DD). Always convert and display them as DD-MMM-YYYY.
- Report the three windows in order — "Next 7 Days", "Next 15 Days", "Next 30 Days". For every PO in each window, list its PO Name (service_po_name), Client Name (client_name), and End Date (end_date, as DD-MMM-YYYY).
- After the three windows, list "Employees Becoming Free" from employees_becoming_free (name and designation) — note this reflects the full 30-day horizon, since the data does not split it by window.
- Then state totals: how many POs fall in each of the three windows, and the total number of employees becoming free.
- Finally, give recommendations: which POs are most urgent (soonest end_date), and which candidate_open_projects the freed-up employees could be reallocated to.
Ground every PO name, client, date, and employee strictly in the data — never invent one that is not present above.`,
  },
  bench_escalation: {
    audienceRoles: ['HR'],
    instructions: `Generate a Bench Escalation report for HR.
The data lists employees with bench percentage >= 75% over the trailing 30 days, their bench hours, and (if any) their last active project. For each notable employee, infer a likely reason from the data (e.g. no active assignment, project ended), suggest which of the listed understaffed active projects they could be deployed to, and assign a priority (high/medium/low) based on how high their bench % is and how long they appear to have been idle.`,
  },
  sole_contributor_risk: {
    audienceRoles: ['Division Head'],
    instructions: `Generate a Sole Contributor Risk report for the Division Head.
The data lists active Service POs where a single employee contributed >= 90% of logged hours in the last 90 days. For each, explain the risk (single point of failure / key-person dependency) and recommend cross-training or a backup resource.`,
  },
  monthly_cost_commentary: {
    audienceRoles: ['Finance', 'Management'],
    instructions: `Generate Monthly Cost Commentary for Finance and Management.
The data compares the just-ended month's total cost and headcount against the prior month, and lists the top cost-driving clients. Explain the cost movement (increase/decrease and by how much), plausible reasons grounded in the data (e.g. headcount change, client mix), and recommendations.
Remember: current_total_cost, previous_total_cost, and every cost in top_cost_driving_clients are Indian Rupees — display them with ₹, never "$".`,
  },
  client_concentration: {
    audienceRoles: ['Management'],
    instructions: `Generate a Client Concentration report for Management.

The data lists the top clients by cost over a trailing period (current_window) versus the prior period of the same length (previous_window), in top_clients — each entry has client_name, cost, revenue_share_pct (its share of total_cost), previous_cost, and trend_pct (change vs the prior period; null if there is no prior-period data for that client).

This report must be concise and management-focused — do not produce a detailed year-over-year breakdown, a full cost-share table, or a risk-threshold analysis. Structure it simply as:
- Top 3 Clients: the three highest clients from top_clients ranked by revenue_share_pct, each shown with its Concentration % (revenue_share_pct).
- Top 3 Total: the sum of those three clients' revenue_share_pct.
- For each of the top 3, its Trend vs the previous quarter: use trend_pct as given (e.g. "+5%" / "-3%"); if trend_pct is null, say there is no prior-period data for that client rather than inventing a figure.
- Do not list more than the top 3 clients unless the data reveals a genuinely unusual concentration risk (e.g. Top 3 Total well above half of total_cost) worth a single extra callout sentence.
Ground every percentage strictly in revenue_share_pct / trend_pct as given — never invent a number not present in the data.`,
  },
  utilization_anomaly: {
    audienceRoles: ['Management'],
    instructions: `Generate a Utilization Anomaly report for Management.
The data compares this month's utilization % against last month's, plus the clients with the biggest hour swings between the two months. Explain what changed and why, using only the clients/swings given.`,
  },
  quarter_end_review: {
    audienceRoles: ['Management'],
    instructions: `Generate a complete Quarter End Review for Management.
The data covers the fiscal quarter that just ended: utilization, cost, top clients, resource risk counts (bench, sole-contributor), completed POs, and new clients onboarded. Produce a rounded review covering achievements, risks, utilization, a resource summary, and recommendations for next quarter.
Remember: total_cost and every cost in top_clients_by_cost are Indian Rupees — display them with ₹, never "$".`,
  },
  new_po_staffing_suggestion: {
    audienceRoles: ['Project Manager'],
    instructions: `Generate a New PO Staffing Suggestion for the Project Manager who just created this Service PO.
The data has the new PO's details (client, service type/category, description, expected hours) and a shortlist of candidate employees with their designation, bench %, and a resource-description snippet. Rank the best-fit candidates based on how well their designation/description matches the PO's stated needs and their current availability (bench %), and explain why each recommended candidate is a good fit.`,
  },
};

/**
 * Build the full prompt for a given job.
 *
 * @param {string} jobKey
 * @param {object} data - Summarized data from aiInsightDataRepository.js
 * @param {string[]} [audienceRolesOverride] - Overrides the template's default audience roles
 * @returns {string}
 * @throws {Error} if no template is registered for jobKey
 */
function buildPrompt(jobKey, data, audienceRolesOverride) {
  const template = JOB_TEMPLATES[jobKey];
  if (!template) {
    throw new Error(`No prompt template registered for job_key "${jobKey}".`);
  }

  return buildBasePrompt({
    jobKey,
    audienceRoles: audienceRolesOverride || template.audienceRoles,
    instructions: template.instructions,
    data,
  });
}

module.exports = {
  buildPrompt,
  buildBasePrompt,
  JOB_TEMPLATES,
};
