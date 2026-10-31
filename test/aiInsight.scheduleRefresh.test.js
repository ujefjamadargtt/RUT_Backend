'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiInsightJobRepo = require('../src/repositories/aiInsightJobRepository');
const schedulerService = require('../src/services/scheduler.service');
const scheduler = require('../src/scheduler/aiInsight.scheduler');

const ORIGINAL = {
  findActiveCronJobs: aiInsightJobRepo.findActiveCronJobs,
  registerJob: schedulerService.registerJob,
};
function restore() {
  aiInsightJobRepo.findActiveCronJobs = ORIGINAL.findActiveCronJobs;
  schedulerService.registerJob = ORIGINAL.registerJob;
  schedulerService.stopAll();
}

test('a schedule edited in the DB is re-registered without a restart; an unchanged one is left alone', async () => {
  const registered = [];
  schedulerService.registerJob = (job) => { registered.push(`${job.job_key}@${job.scheduled_time}`); ORIGINAL.registerJob(job, async () => {}); };
  let jobs = [{ job_key: 'refresh-a', schedule_type: 'DL', scheduled_time: '06:00' }];
  aiInsightJobRepo.findActiveCronJobs = async () => jobs;
  try {
    await scheduler.syncSchedules();
    assert.equal(schedulerService.getRegisteredCron('refresh-a'), '0 6 * * *');
    await scheduler.syncSchedules(); // nothing changed
    assert.equal(registered.length, 1);

    jobs = [{ job_key: 'refresh-a', schedule_type: 'DL', scheduled_time: '18:06' }]; // edited in the DB
    await scheduler.syncSchedules();
    assert.equal(schedulerService.getRegisteredCron('refresh-a'), '6 18 * * *');
    assert.equal(registered.length, 2);
  } finally {
    restore();
  }
});

test('a job switched off in the DB is unregistered; an invalid schedule does not break the refresh', async () => {
  schedulerService.registerJob = (job) => ORIGINAL.registerJob(job, async () => {});
  let jobs = [
    { job_key: 'refresh-b', schedule_type: 'DL', scheduled_time: '07:00' },
    { job_key: 'refresh-bad', schedule_type: 'WL', scheduled_time: '07:00' }, // WL without a week_day
  ];
  aiInsightJobRepo.findActiveCronJobs = async () => jobs;
  try {
    await scheduler.syncSchedules();
    assert.ok(schedulerService.getRegisteredJobKeys().includes('refresh-b'));
    assert.ok(!schedulerService.getRegisteredJobKeys().includes('refresh-bad'));

    jobs = []; // everything switched off
    await scheduler.syncSchedules();
    assert.ok(!schedulerService.getRegisteredJobKeys().includes('refresh-b'));
  } finally {
    restore();
  }
});
