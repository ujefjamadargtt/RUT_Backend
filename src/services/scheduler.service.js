'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');

/**
 * Generic Scheduler Service
 *
 * One engine for every cron-driven job in the app, regardless of domain.
 * Callers register a list of { job_key, cron_expression } configs plus a
 * single handler function; this module owns all node-cron wiring so no
 * other file ever calls cron.schedule() directly — that is what keeps
 * scheduling logic from being duplicated per job. Each job keeps its own
 * cron expression, so daily/weekly/monthly/quarterly jobs all run
 * independently and only fire at their own configured time.
 */

const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const registeredTasks = new Map();

/**
 * Register and start one cron-scheduled job. Re-registering the same
 * job_key stops the previous task first, so this is safe to call again
 * (e.g. after an admin edits a job's cron_expression).
 *
 * @param {{ job_key: string, cron_expression: string }} job
 * @param {(job: object) => Promise<void>} handler
 */
function registerJob(job, handler) {
  if (!job.cron_expression) {
    logger.warn('Scheduler: job has no cron_expression — skipping (event-driven job?)', { jobKey: job.job_key });
    return;
  }

  if (!cron.validate(job.cron_expression)) {
    logger.error('Scheduler: invalid cron expression — job not registered', {
      jobKey: job.job_key,
      cronExpression: job.cron_expression,
    });
    return;
  }

  if (registeredTasks.has(job.job_key)) {
    registeredTasks.get(job.job_key).stop();
  }

  const task = cron.schedule(
    job.cron_expression,
    async () => {
      logger.info('Scheduler: job triggered', { jobKey: job.job_key });
      try {
        await handler(job);
      } catch (err) {
        // The handler (aiInsightService.runJob) already logs and records
        // its own failure — this catch exists only so a bug in the handler
        // can never take down node-cron's internal timer loop.
        logger.error('Scheduler: unhandled error running job', { jobKey: job.job_key, error: err.message });
      }
    },
    { timezone: TIMEZONE }
  );

  registeredTasks.set(job.job_key, task);
  logger.info('Scheduler: job registered', {
    jobKey: job.job_key,
    cronExpression: job.cron_expression,
    timezone: TIMEZONE,
  });
}

/**
 * Register every job in the list, each with its own cron expression, using
 * the same handler. This is the one place a batch of jobs gets registered —
 * callers never loop over cron.schedule() themselves.
 *
 * @param {{ job_key: string, cron_expression: string }[]} jobs
 * @param {(job: object) => Promise<void>} handler
 */
function registerJobs(jobs, handler) {
  jobs.forEach((job) => registerJob(job, handler));
}

/**
 * Stop and unregister every currently-scheduled job.
 */
function stopAll() {
  for (const task of registeredTasks.values()) {
    task.stop();
  }
  registeredTasks.clear();
}

/**
 * @returns {string[]} job_key of every currently-registered job
 */
function getRegisteredJobKeys() {
  return Array.from(registeredTasks.keys());
}

module.exports = {
  registerJob,
  registerJobs,
  stopAll,
  getRegisteredJobKeys,
};
