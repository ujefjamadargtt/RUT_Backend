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
 * cron trigger fans out to one aiInsightService.runJob() call per active
 * company, run independently via Promise.allSettled — one company's failure
 * (e.g. no data for the period) never blocks another company's run.
 *
 * Event-driven jobs (new_po_staffing_suggestion, frequency = 'event') are
 * intentionally excluded here — they have no cron_expression and instead
 * fire from servicePOService.js's create() hook with the triggering PO's
 * own companyId.
 */
async function runForAllCompanies(job) {
  const companies = await companyRepository.findAll({ status: 'active' });

  const results = await Promise.allSettled(
    companies.map((company) => aiInsightService.runJob(job.job_key, {}, company.id))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.error('Scheduler: job failed for company', {
        jobKey: job.job_key,
        companyId: companies[i].id,
        error: result.reason.message,
      });
    }
  });
}

async function start() {
  await aiInsightJobRepo.ensureSeeded();

  const jobs = await aiInsightJobRepo.findActiveCronJobs();
  schedulerService.registerJobs(jobs, runForAllCompanies);

  logger.info('AI Insight scheduler started', {
    registeredJobs: schedulerService.getRegisteredJobKeys(),
  });
}

module.exports = { start };
