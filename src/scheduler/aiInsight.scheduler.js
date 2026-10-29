'use strict';

const schedulerService = require('../services/scheduler.service');
const aiInsightJobRepo = require('../repositories/aiInsightJobRepository');
const aiInsightService = require('../services/aiInsight.service');
const companyRepository = require('../repositories/companyRepository');
const logger = require('../utils/logger');

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

async function start() {
  await aiInsightJobRepo.ensureSeeded();

  const jobs = await aiInsightJobRepo.findActiveCronJobs();
  schedulerService.registerJobs(jobs, runExclusively);

  logger.info('AI Insight scheduler started', {
    registeredJobs: schedulerService.getRegisteredJobKeys(),
  });
}

module.exports = { start, runForAllCompanies, runExclusively };
