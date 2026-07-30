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
 * The 10 insight jobs implemented by this module. frequency='event' means
 * the job has no cron schedule — it fires from an application event
 * (see servicePOService.js's create() hook for new_po_staffing_suggestion).
 */
const JOB_DEFINITIONS = [
  {
    job_key: 'weekly_resource_digest',
    title: 'Weekly Resource Digest',
    description: 'Overall utilization, major risks, achievements, and top 3 actions for the week just ended.',
    frequency: 'weekly',
    cron_expression: '0 9 * * 1', // every Monday, 9 AM
    audience_roles: ['Management'],
  },
  {
    job_key: 'po_ending_alerts',
    title: 'PO Ending Alerts',
    description: 'Service POs ending within 30/15/7 days, employees becoming free, and suggested reallocations.',
    frequency: 'daily',
    cron_expression: '0 8 * * *',
    audience_roles: ['Project Manager', 'Division Head'],
  },
  {
    job_key: 'bench_escalation',
    title: 'Bench Escalation',
    description: 'Employees with bench >= 75% over the trailing 30 days, with reason, priority, and suggested projects.',
    frequency: 'daily',
    cron_expression: '15 8 * * *',
    audience_roles: ['HR'],
  },
  {
    job_key: 'sole_contributor_risk',
    title: 'Sole Contributor Risk',
    description: 'Active projects where one employee contributes more than 90% of hours, with cross-training/backup suggestions.',
    frequency: 'weekly',
    cron_expression: '0 9 * * 2', // Tuesday, 9 AM
    audience_roles: ['Division Head'],
  },
  {
    job_key: 'monthly_cost_commentary',
    title: 'Monthly Cost Commentary',
    description: 'Cost movement vs the prior month, reasons, and recommendations.',
    frequency: 'monthly',
    cron_expression: '0 9 1 * *', // 1st of every month, 9 AM
    audience_roles: ['Finance', 'Management'],
  },
  {
    job_key: 'client_concentration',
    title: 'Client Concentration',
    description: 'Top clients, revenue share, trend, and concentration risk.',
    frequency: 'monthly',
    cron_expression: '30 9 1 * *',
    audience_roles: ['Management'],
  },
  {
    job_key: 'utilization_anomaly',
    title: 'Utilization Anomaly',
    description: 'Current vs previous month utilization, with an explanation of the increase/decrease.',
    frequency: 'monthly',
    cron_expression: '0 10 1 * *',
    audience_roles: ['Management'],
  },
  {
    job_key: 'quarter_end_review',
    title: 'Quarter End Review',
    description: 'Complete quarter review: achievements, risks, utilization, resource summary, recommendations.',
    frequency: 'quarterly',
    cron_expression: '0 9 1 1,4,7,10 *', // 1st of Jan/Apr/Jul/Oct, 9 AM
    audience_roles: ['Management'],
  },
  {
    job_key: 'new_po_staffing_suggestion',
    title: 'New PO Staffing Suggestion',
    description: 'Suggested employees for a newly created Service PO, based on matching skills, availability, and bench %.',
    frequency: 'event',
    cron_expression: null,
    audience_roles: ['Project Manager'],
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
 * Active, cron-scheduled jobs (excludes event-driven jobs, which have no
 * cron_expression and are never picked up by the scheduler loop).
 * @returns {Promise<AiInsightJob[]>}
 */
async function findActiveCronJobs() {
  return AiInsightJob.findAll({
    where: { is_active: true },
  }).then((jobs) => jobs.filter((job) => job.cron_expression));
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
