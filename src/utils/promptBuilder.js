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

// Shared by the monthly, sync-gated jobs (services/aiInsightMonthly.service.js).
const MONTHLY_BASE = `This is a MONTHLY report about the calendar month named in the data ("period"), built only from timesheets that have been synced.
Capacity means headcount x the monthly cap hours set by the Admin (monthly_cap_hours_per_employee / capacity_hours); utilization % = logged hours / capacity. Never assume a 176-hour month — use the cap in the data.
Hours only: do not mention cost, rates or budgets.
If the data has a "data_coverage" section, some units are not synced yet: state in the summary which units are included and which are pending, and do not draw conclusions about the pending units.
Name people, Business Units, POs and clients exactly as given. Be specific and short; every finding must carry a number from the data.`;

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
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a Weekly Resource Digest summarizing the just-ended work week for Admin and BU Admin.
Cover: overall utilization (hours/billable/utilization %), the biggest risks visible in the data (bench, sole-contributor concentration, etc.), notable achievements (e.g. POs completed, strong client delivery), and the top 3 recommended actions for the week ahead.`,
  },
  po_ending_alerts: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate PO Ending Alerts for Admin and BU Admin.

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
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a Bench Escalation report for HR.
The data lists employees with bench percentage >= 75% over the trailing 30 days, their bench hours, and (if any) their last active project. For each notable employee, infer a likely reason from the data (e.g. no active assignment, project ended), suggest which of the listed understaffed active projects they could be deployed to, and assign a priority (high/medium/low) based on how high their bench % is and how long they appear to have been idle.`,
  },
  sole_contributor_risk: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a Sole Contributor Risk report for Admin and BU Admin.
The data lists active Service POs where a single employee contributed >= 90% of logged hours in the last 90 days. For each, explain the risk (single point of failure / key-person dependency) and recommend cross-training or a backup resource.`,
  },
  monthly_cost_commentary: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate Monthly Cost Commentary for Admin and BU Admin.
The data compares the just-ended month's total cost and headcount against the prior month, and lists the top cost-driving clients. Explain the cost movement (increase/decrease and by how much), plausible reasons grounded in the data (e.g. headcount change, client mix), and recommendations.
Remember: current_total_cost, previous_total_cost, and every cost in top_cost_driving_clients are Indian Rupees — display them with ₹, never "$".`,
  },
  client_concentration: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a Client Concentration report for Admin and BU Admin.

The data lists the top clients by cost over a trailing period (current_window) versus the prior period of the same length (previous_window), in top_clients — each entry has client_name, cost, revenue_share_pct (its share of total_cost), previous_cost, and trend_pct (change vs the prior period; null if there is no prior-period data for that client).

This report must be concise and management-focused — do not produce a detailed year-over-year breakdown, a full cost-share table, or a risk-threshold analysis. Structure it simply as:
- Top 3 Clients: the three highest clients from top_clients ranked by revenue_share_pct, each shown with its Concentration % (revenue_share_pct).
- Top 3 Total: the sum of those three clients' revenue_share_pct.
- For each of the top 3, its Trend vs the previous quarter: use trend_pct as given (e.g. "+5%" / "-3%"); if trend_pct is null, say there is no prior-period data for that client rather than inventing a figure.
- Do not list more than the top 3 clients unless the data reveals a genuinely unusual concentration risk (e.g. Top 3 Total well above half of total_cost) worth a single extra callout sentence.
Ground every percentage strictly in revenue_share_pct / trend_pct as given — never invent a number not present in the data.`,
  },
  utilization_anomaly: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a Utilization Anomaly report for Admin and BU Admin.
The data compares this month's utilization % against last month's, plus the clients with the biggest hour swings between the two months. Explain what changed and why, using only the clients/swings given.`,
  },
  quarter_end_review: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a complete Quarter End Review for Admin and BU Admin.
The data covers the fiscal quarter that just ended: utilization, cost, top clients, resource risk counts (bench, sole-contributor), completed POs, and new clients onboarded. Produce a rounded review covering achievements, risks, utilization, a resource summary, and recommendations for next quarter.
Remember: total_cost and every cost in top_clients_by_cost are Indian Rupees — display them with ₹, never "$".`,
  },
  bu_utilization_summary: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Monthly Utilization Summary for one Business Unit / Sub-BU. Report logged hours against capacity (headcount x monthly cap), billable utilization, and the change vs the previous month. Say plainly whether the unit is under-, well- or over-utilised and what most likely drove the change.`,
  },
  bu_underutilised_employees: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Under-utilised employees (below 60% of the monthly cap). State how many of the headcount, how many logged zero hours, and list the lowest employees with their hours and %. Recommend who to allocate first and flag zero-hour employees for a check (leave, onboarding, or a missing timesheet).`,
  },
  bu_overtime_overcap: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Over-cap and overtime. State how many employees are at or above 90% of the cap and how many are above it, list the highest with hours above cap, and call out those who were also at or above 90% the previous month (repeat) as the burnout risk. Recommend workload redistribution.`,
  },
  bu_bench_nonbillable: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Bench and non-billable load. Give bench and non-billable share of logged hours, the change vs the previous month, who carries the bench hours, and which non-billable POs take the most hours. Recommend how to reduce idle time.`,
  },
  bu_po_concentration: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
PO hours and concentration. Show where the hours went (top POs with share) and the sole-contributor risks (one person above 90% of a PO). For each risk, name the person and PO and recommend a backup or cross-training.`,
  },
  bu_client_hours: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Client-wise hours. List the top clients with hours, share and change vs the previous month, state the top-3 share, and flag any client that grew or shrank sharply. Keep it short.`,
  },
  bu_timesheet_compliance: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
Timesheet compliance. Report work logs by status, how many are still pending approval and with which primary manager (oldest pending date), and employees who logged nothing in the month. Recommend who must approve or submit, in priority order. If the data_coverage section says the unit is not synced yet, say that sync is pending.`,
  },
  bu_po_timeline_risk: {
    audienceRoles: ['BU Admin'],
    instructions: `${MONTHLY_BASE}
PO timeline risk. Dates are measured at the month end given in measured_at. List in-progress POs already past their end date (days overdue, hours still being logged) and POs ending within 30 days. Recommend which need an end-date extension, closure, or replacement work first. Display dates as DD-MMM-YYYY.`,
  },
  tenant_monthly_summary: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Monthly summary across all Business Units of the tenant. Give the combined utilization against capacity, billable utilization and trend vs the previous month, then the strongest and weakest Business Units. Recommend the top actions for the month ahead.`,
  },
  tenant_bu_comparison: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Business Unit comparison and capacity. Rank the Business Units by utilization and show where capacity is spare (low utilization, hours that could be absorbed) versus overloaded (employees at or above 90%, hours above cap). Suggest concrete cross-BU capacity moves, naming the Business Units.`,
  },
  tenant_client_concentration: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Client concentration across all Business Units. List the top clients with share of hours, how many Business Units serve each, and the top-3 share. Flag over-reliance on one client (for example a top-3 share above half) and give one clear recommendation.`,
  },
  tenant_overtime_burnout: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Overtime and burnout risk across Business Units. State how many employees are at or above 90% of cap and above it, which Business Units concentrate them, and how many were high in both months (repeat). Recommend staffing or workload changes per Business Unit.`,
  },
  tenant_nonbillable_leakage: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Non-billable leakage. Give non-billable and bench share of all logged hours and rank the Business Units by non-billable hours. Say where the leakage is largest and what to review first. Hours only — do not estimate money.`,
  },
  tenant_sync_compliance_health: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Sync and compliance health for the month. List which Business Units / Sub-BUs are synced and which are pending, and the pending-approval work logs per Business Unit. Recommend who to chase first. Do not describe utilization — only readiness of the data.`,
  },
  tenant_quarter_end_brief: {
    audienceRoles: ['Admin'],
    instructions: `${MONTHLY_BASE}
Quarter-end brief. Cover the three months of the quarter: utilization and billable utilization trend, bench hours, and Business Units ranked for the quarter. Give the top 3 risks, top 3 opportunities and the recommended focus for the next quarter.`,
  },
  new_po_staffing_suggestion: {
    audienceRoles: ['Admin', 'BU Admin'],
    instructions: `Generate a New PO Staffing Suggestion for the Admin / BU Admin who just created this Service PO.
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
