'use strict';

const { AiInsightJob } = require('../models');

/**
 * AiInsightJob Repository
 * Job configuration is code-defined (JOB_DEFINITIONS below) but persisted in
 * the ai_insight_jobs table so an admin can later flip is_active or tweak
 * cron_expression directly in the DB without a redeploy. ensureSeeded()
 * inserts any definition missing from the table on every startup — it never
 * overwrites a row that already exists, so manual DB edits survive restarts.
 */

/**
 * Each job's schedule is set in its own columns (see utils/scheduleExpression.js):
 * schedule_type MI / DL / WL / ML / QL, plus scheduled_time (HH:mm), week_day (MON..SUN),
 * month_day (1-28) and interval_minutes as the type needs.
 *
 * The insight jobs implemented by this module. frequency='event' means
 * the job has no cron schedule — it fires from an application event
 * (see servicePOService.js's create() hook for new_po_staffing_suggestion).
 */
const JOB_DEFINITIONS = [
  // ── Monthly, sync-gated reports (services/aiInsightMonthly.service.js) ──────
  // Run daily for the month that just ended; a unit's data appears only after its timesheets are synced,
  // and a report is replaced (not repeated) as more units sync. Capacity = the admin-set Monthly Cap Hours.
  // BU Admin — one report per Business Unit / Sub-BU:
  {
    job_key: 'bu_utilization_summary',
    title: 'BU Monthly Utilization Summary',
    description: 'Utilization and billable utilization against the monthly cap, with change vs the previous month.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_underutilised_employees',
    title: 'Under-utilised Employees',
    description: 'Employees below 60% of the monthly cap, with hours logged.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_overtime_overcap',
    title: 'Over-cap and Overtime',
    description: 'Employees at or above 90% of the monthly cap, and those above it, with repeat offenders.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_bench_nonbillable',
    title: 'Bench and Non-billable Load',
    description: 'Hours spent on Idle / On Bench and other non-billable POs, and who carries them.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_po_concentration',
    title: 'PO Hours and Concentration',
    description: 'Hours by Service PO and single-person dependency on a PO.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_client_hours',
    title: 'Client-wise Hours',
    description: 'Top clients by hours, their share and change vs the previous month.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_timesheet_compliance',
    title: 'Timesheet Compliance',
    description: 'Pending approvals by manager and employees with no timesheet logs (does not wait for sync).',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  {
    job_key: 'bu_po_timeline_risk',
    title: 'PO Timeline Risk',
    description: 'In-progress POs past their end date or ending within 30 days of the month end, with hours still logged.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['BU Admin'],
  },
  // Admin — one report per tenant, across all its Business Units:
  {
    job_key: 'tenant_monthly_summary',
    title: 'Monthly Summary (All BUs)',
    description: 'Combined utilization against cap, billable share and trend, BU by BU.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_bu_comparison',
    title: 'BU Comparison and Capacity',
    description: 'BU ranking and where spare capacity and overload sit (only when every BU is synced).',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_client_concentration',
    title: 'Client Concentration (All BUs)',
    description: 'Client share of hours across all BUs and concentration risk.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_overtime_burnout',
    title: 'Overtime and Burnout Risk',
    description: 'Employees at or above 90% of cap across BUs, and repeat high months.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_nonbillable_leakage',
    title: 'Non-billable Leakage',
    description: 'Non-billable and bench hours by BU.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_sync_compliance_health',
    title: 'Sync and Compliance Health',
    description: 'Which BUs / Sub-BUs are synced for the month and pending approvals per BU.',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'tenant_quarter_end_brief',
    title: 'Quarter-end Brief',
    description: 'Utilization trend across the quarter, BU by BU (quarter-end months, once every BU is synced).',
    frequency: 'monthly',
    schedule_type: 'DL', scheduled_time: '06:00', // runs daily 06:00 for the month just ended; sync-gated, stops once every unit is synced
    audience_roles: ['Admin'],
  },
  {
    job_key: 'new_po_staffing_suggestion',
    title: 'New PO Staffing Suggestion',
    description: 'Suggested employees for a newly created Service PO, based on matching skills, availability, and bench %.',
    frequency: 'event',
    // event-driven: no schedule columns
    audience_roles: ['Admin', 'BU Admin'],
  },
];

/**
 * Insert any job definition not already present in the table. Existing
 * rows (including any admin-edited fields) are left untouched.
 * @returns {Promise<void>}
 */
async function ensureSeeded() {
  for (const definition of JOB_DEFINITIONS) {
    await AiInsightJob.findOrCreate({
      where: { job_key: definition.job_key },
      defaults: definition,
    });
  }
}

/**
 * @returns {Promise<AiInsightJob[]>}
 */
async function findAll() {
  return AiInsightJob.findAll({ order: [['id', 'ASC']] });
}

/**
 * @param {string} jobKey
 * @returns {Promise<AiInsightJob|null>}
 */
async function findByKey(jobKey) {
  return AiInsightJob.findOne({ where: { job_key: jobKey } });
}

/**
 * Active, scheduled jobs. Event-driven jobs (frequency = 'event') are NEVER returned,
 * even if a schedule was set on them by mistake: they need a reference (e.g. the new
 * Service PO's id) that only their triggering event has, so a timer can't run them.
 * @returns {Promise<AiInsightJob[]>}
 */
async function findActiveCronJobs() {
  return AiInsightJob.findAll({
    where: { is_active: true },
  }).then((jobs) => jobs.filter((job) => job.frequency !== 'event' && (job.schedule_type || job.cron_expression)));
}

/**
 * Record the outcome of a job run.
 * @param {string} jobKey
 * @param {{ status: 'success'|'failed', error?: string, runAt: Date }} result
 * @returns {Promise<void>}
 */
async function recordRunResult(jobKey, { status, error, runAt }) {
  await AiInsightJob.update(
    { last_run_at: runAt, last_run_status: status, last_error: error || null },
    { where: { job_key: jobKey } }
  );
}

module.exports = {
  JOB_DEFINITIONS,
  ensureSeeded,
  findAll,
  findByKey,
  findActiveCronJobs,
  recordRunResult,
};
