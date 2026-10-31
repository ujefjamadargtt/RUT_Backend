'use strict';

const schedulerService = require('../services/scheduler.service');
const aiInsightJobRepo = require('../repositories/aiInsightJobRepository');
const aiInsightService = require('../services/aiInsight.service');
const aiInsightMonthlyService = require('../services/aiInsightMonthly.service');
const companyRepository = require('../repositories/companyRepository');
const logger = require('../utils/logger');
const { resolveJobCronExpression } = require('../utils/scheduleExpression');

/**
 * AI Insight Scheduler
 *
 * Wires the generic scheduler engine (services/scheduler.service.js) to the
 * AI Insight jobs: seeds job configuration on first run (insert-if-missing),
 * then registers every active, cron-scheduled job so it fires automatically
 * on server startup — no API call is required to make any of this run.
 * Daily/weekly/monthly/quarterly jobs each keep their own cron_expression
 * from ai_insight_jobs, so only the jobs actually due at a given time fire.
 *
 * Every job is company-scoped (see aiInsightDataRepository.js), so a single
 * cron trigger fans out to one aiInsightService.runJob() call per insight
 * unit — an active BU with no Sub-BUs, or an active Sub-BU (a Parent BU that
 * has Sub-BUs never runs itself) — run ONE AT A TIME, not in parallel: one company's
 * failure (e.g. no data for the period) never blocks another's, but an AI-gateway
 * failure (every provider down / a bad model or key) ends the run early instead of
 * repeating the same failing call for every remaining company.
 *
 * Event-driven jobs (new_po_staffing_suggestion, frequency = 'event') are
 * intentionally excluded here — they have no cron_expression and instead
 * fire from servicePOService.js's create() hook with the triggering PO's
 * own companyId.
 */
async function runForAllCompanies(job) {
  // Monthly, sync-gated jobs walk every tenant / unit themselves (daily retry until all are synced).
  if (aiInsightMonthlyService.isMonthlyJob(job.job_key)) {
    await aiInsightMonthlyService.runMonthlyJob(job);
    return;
  }

  // Insight units are leaf Companies only: a BU without Sub-BUs runs BU-wise;
  // a BU that has Sub-BUs is skipped and each of its Sub-BUs runs instead.
  const companyIds = await companyRepository.findInsightLeafCompanyIds();

  // One company at a time — never a burst of N simultaneous AI calls (which trips
  // the providers' rate limits and makes the gateway cascade through every
  // key/model/provider). One company's failure never blocks the next company.
  for (let i = 0; i < companyIds.length; i += 1) {
    const companyId = companyIds[i];
    try {
      await aiInsightService.runJob(job.job_key, {}, companyId);
    } catch (err) {
      logger.error('Scheduler: job failed for company', { jobKey: job.job_key, companyId, error: err.message });

      // The AI side itself is down/misconfigured (every provider exhausted, or a
      // non-retryable provider/auth/model error): the remaining companies would
      // only repeat the same failing calls — stop this run and try again next tick.
      if (isAiGatewayFailure(err)) {
        logger.warn('Scheduler: AI gateway failure — skipping the remaining companies for this run', {
          jobKey: job.job_key,
          skippedCompanies: companyIds.length - i - 1,
        });
        return;
      }
    }
  }
}

/**
 * Errors raised by providers/gateway.provider.js carry either `attempts` (every
 * provider exhausted) or `provider` (a non-retryable provider error / bad JSON);
 * a company-specific failure (e.g. a data/SQL error) carries neither.
 */
function isAiGatewayFailure(err) {
  return Boolean(err && (err.attempts || err.provider));
}

// Jobs that fire in the same minute used to start together, i.e. several AI calls
// at once. They now share ONE queue (a single AI call in flight across all jobs),
// and a job that is still queued/running is not queued again — with a short
// interval (e.g. MI 1) a slow run would otherwise pile up a backlog without end.
const activeJobKeys = new Set();
let queue = Promise.resolve();

/**
 * @param {{ job_key: string }} job
 * @returns {Promise<void>}
 */
function runExclusively(job) {
  if (activeJobKeys.has(job.job_key)) {
    logger.warn('Scheduler: previous run of this job is still queued/running — skipping this trigger', {
      jobKey: job.job_key,
    });
    return Promise.resolve();
  }

  activeJobKeys.add(job.job_key);
  const run = queue.then(() => runForAllCompanies(job));
  queue = run.catch(() => {}); // one failed run must never break the queue for the next one
  return run.finally(() => activeJobKeys.delete(job.job_key));
}

// A schedule edited in ai_insight_jobs (schedule_type / scheduled_time / ... / is_active) takes effect without a
// restart: the job list is re-read this often and only jobs whose cron changed are re-registered.
const SCHEDULE_REFRESH_MS = 30 * 1000;
const reportedInvalid = new Set();

/**
 * Make the registered cron tasks match ai_insight_jobs: register a new / changed schedule, drop a job that
 * was switched off. A job whose schedule did not change is left alone.
 */
async function syncSchedules() {
  const jobs = await aiInsightJobRepo.findActiveCronJobs();
  const activeKeys = new Set(jobs.map((job) => job.job_key));

  for (const job of jobs) {
    let expression;
    try {
      expression = resolveJobCronExpression(job);
    } catch (err) {
      const problem = `${job.job_key}:${err.message}`;
      if (!reportedInvalid.has(problem)) {
        reportedInvalid.add(problem);
        logger.error('Scheduler: invalid schedule — job not (re)registered', { jobKey: job.job_key, error: err.message });
      }
      continue;
    }
    if (expression && schedulerService.getRegisteredCron(job.job_key) !== expression) {
      schedulerService.registerJob(job, runExclusively);
    }
  }

  for (const jobKey of schedulerService.getRegisteredJobKeys()) {
    if (!activeKeys.has(jobKey)) {
      schedulerService.unregisterJob(jobKey);
      logger.info('Scheduler: job switched off — unregistered', { jobKey });
    }
  }
}

let refreshing = false;
function startScheduleRefresh() {
  const timer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await syncSchedules();
    } catch (err) {
      logger.error('Scheduler: schedule refresh failed', { error: err.message });
    } finally {
      refreshing = false;
    }
  }, SCHEDULE_REFRESH_MS);
  timer.unref();
}

async function start() {
  await aiInsightJobRepo.ensureSeeded();

  const jobs = await aiInsightJobRepo.findActiveCronJobs();
  schedulerService.registerJobs(jobs, runExclusively);
  startScheduleRefresh();

  logger.info('AI Insight scheduler started', {
    registeredJobs: schedulerService.getRegisteredJobKeys(),
  });
}

module.exports = { start, syncSchedules, runForAllCompanies, runExclusively };
