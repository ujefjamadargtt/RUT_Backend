'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');

const { scheduleToCron, resolveJobCronExpression } = require('../src/utils/scheduleExpression');
const schedulerService = require('../src/services/scheduler.service');
const { JOB_DEFINITIONS } = require('../src/repositories/aiInsightJobRepository');

/**
 * Job schedule columns (schedule_type DL/WL/ML/QL/MI + scheduled_time / week_day /
 * month_day / interval_minutes) replace a hand-written cron. The seeded jobs must
 * keep the exact schedules they had before.
 */

test('every seeded job converts to the SAME cron it used before', () => {
  const before = {
    weekly_resource_digest: '0 9 * * 1',
    po_ending_alerts: '0 8 * * *',
    bench_escalation: '15 8 * * *',
    sole_contributor_risk: '0 9 * * 2',
    monthly_cost_commentary: '0 9 1 * *',
    client_concentration: '30 9 1 * *',
    utilization_anomaly: '0 10 1 * *',
    quarter_end_review: '0 9 1 1,4,7,10 *',
  };

  for (const job of JOB_DEFINITIONS) {
    if (job.frequency === 'event') {
      assert.equal(job.schedule_type, undefined, `${job.job_key} has no schedule`);
      assert.equal(resolveJobCronExpression(job), null);
      continue;
    }
    assert.equal(resolveJobCronExpression(job), before[job.job_key], job.job_key);
  }
});

test('DL / WL / ML / QL / MI produce the expected cron', () => {
  assert.equal(scheduleToCron({ schedule_type: 'DL', scheduled_time: '09:30' }), '30 9 * * *');
  assert.equal(scheduleToCron({ schedule_type: 'DL', scheduled_time: '00:05' }), '5 0 * * *');
  assert.equal(scheduleToCron({ schedule_type: 'DL', scheduled_time: '23:59' }), '59 23 * * *');
  assert.equal(scheduleToCron({ schedule_type: 'WL', week_day: 'MON', scheduled_time: '09:00' }), '0 9 * * 1');
  assert.equal(scheduleToCron({ schedule_type: 'WL', week_day: 'SUN', scheduled_time: '18:45' }), '45 18 * * 0');
  assert.equal(scheduleToCron({ schedule_type: 'ML', month_day: 15, scheduled_time: '10:00' }), '0 10 15 * *');
  assert.equal(scheduleToCron({ schedule_type: 'QL', month_day: 1, scheduled_time: '09:00' }), '0 9 1 1,4,7,10 *');
  assert.equal(scheduleToCron({ schedule_type: 'MI', interval_minutes: 15 }), '*/15 * * * *');
  assert.equal(scheduleToCron({ schedule_type: 'MI', interval_minutes: 1 }), '* * * * *');
});

test('values as the database returns them are accepted (TIME as HH:mm:ss, numbers as strings, any case)', () => {
  assert.equal(scheduleToCron({ schedule_type: 'DL', scheduled_time: '08:15:00' }), '15 8 * * *');
  assert.equal(scheduleToCron({ schedule_type: 'dl', scheduled_time: '8:15' }), '15 8 * * *');
  assert.equal(scheduleToCron({ schedule_type: 'WL', week_day: 'tue', scheduled_time: '09:00:00' }), '0 9 * * 2');
  assert.equal(scheduleToCron({ schedule_type: 'ML', month_day: '28', scheduled_time: '23:59:00' }), '59 23 28 * *');
  assert.equal(scheduleToCron({ schedule_type: 'MI', interval_minutes: '30' }), '*/30 * * * *');
});

test('every generated cron is accepted by node-cron', () => {
  const samples = [
    { schedule_type: 'MI', interval_minutes: 1 },
    { schedule_type: 'MI', interval_minutes: 30 },
    { schedule_type: 'DL', scheduled_time: '00:00' },
    { schedule_type: 'DL', scheduled_time: '23:59' },
    { schedule_type: 'WL', week_day: 'SAT', scheduled_time: '12:00' },
    { schedule_type: 'ML', month_day: 28, scheduled_time: '23:59' },
    { schedule_type: 'QL', month_day: 28, scheduled_time: '00:00' },
  ];
  for (const sample of samples) {
    assert.equal(cron.validate(scheduleToCron(sample)), true, JSON.stringify(sample));
  }
});

test('an incomplete or invalid schedule is rejected with INVALID_SCHEDULE', () => {
  const bad = [
    { schedule_type: 'XX' },
    { schedule_type: 'DL' },
    { schedule_type: 'DL', scheduled_time: '25:00' },
    { schedule_type: 'DL', scheduled_time: '09:60' },
    { schedule_type: 'WL', scheduled_time: '09:00' },
    { schedule_type: 'WL', week_day: 'XYZ', scheduled_time: '09:00' },
    { schedule_type: 'WL', week_day: 'MON' },
    { schedule_type: 'ML', scheduled_time: '09:00' },
    { schedule_type: 'ML', month_day: 0, scheduled_time: '09:00' },
    { schedule_type: 'ML', month_day: 29, scheduled_time: '09:00' },
    { schedule_type: 'QL', month_day: 31, scheduled_time: '09:00' },
    { schedule_type: 'QL', month_day: 1 },
    { schedule_type: 'MI' },
    { schedule_type: 'MI', interval_minutes: 0 },
    { schedule_type: 'MI', interval_minutes: 7 },
    { schedule_type: 'MI', interval_minutes: 45 },
    { schedule_type: 'MI', interval_minutes: 60 },
  ];
  for (const job of bad) {
    assert.throws(() => resolveJobCronExpression(job), (err) => err.code === 'INVALID_SCHEDULE', JSON.stringify(job));
  }
});

test('no schedule_type: falls back to a raw cron_expression, else null; schedule_type wins over a stale cron', () => {
  assert.equal(scheduleToCron({ schedule_type: null }), null);
  assert.equal(resolveJobCronExpression({ schedule_type: null, cron_expression: '0 9 * * 1' }), '0 9 * * 1');
  assert.equal(resolveJobCronExpression({ schedule_type: null, cron_expression: null }), null);
  assert.equal(resolveJobCronExpression({ cron_expression: ' */5 * * * * ' }), '*/5 * * * *');
  assert.equal(
    resolveJobCronExpression({ schedule_type: 'DL', scheduled_time: '08:15', cron_expression: '0 0 * * *' }),
    '15 8 * * *'
  );
});

// ── scheduler.service wiring ────────────────────────────────────────────────

function withStubbedCron(run) {
  const original = cron.schedule;
  const scheduled = [];
  cron.schedule = (expression, _fn, options) => {
    scheduled.push({ expression, options });
    return { stop() {} };
  };
  try {
    run(scheduled);
  } finally {
    cron.schedule = original;
    schedulerService.stopAll();
  }
}

test('scheduler.service registers jobs from their schedule columns, and a raw cron as a fallback', () => {
  withStubbedCron((scheduled) => {
    schedulerService.registerJob({ job_key: 'a', schedule_type: 'DL', scheduled_time: '08:15:00' }, async () => {});
    schedulerService.registerJob({ job_key: 'b', schedule_type: 'WL', week_day: 'MON', scheduled_time: '09:00:00' }, async () => {});
    schedulerService.registerJob({ job_key: 'c', schedule_type: 'MI', interval_minutes: 15 }, async () => {});
    schedulerService.registerJob({ job_key: 'd', schedule_type: null, cron_expression: '0 9 * * 2' }, async () => {});

    assert.deepEqual(scheduled.map((s) => s.expression), ['15 8 * * *', '0 9 * * 1', '*/15 * * * *', '0 9 * * 2']);
    assert.deepEqual(schedulerService.getRegisteredJobKeys(), ['a', 'b', 'c', 'd']);
  });
});

test('scheduler.service skips (never throws on) an incomplete schedule, a bad cron, or an event job', () => {
  withStubbedCron((scheduled) => {
    schedulerService.registerJob({ job_key: 'incomplete', schedule_type: 'WL', scheduled_time: '09:00' }, async () => {});
    schedulerService.registerJob({ job_key: 'bad-cron', schedule_type: null, cron_expression: 'not a cron' }, async () => {});
    schedulerService.registerJob({ job_key: 'event', schedule_type: null, cron_expression: null }, async () => {});

    assert.equal(scheduled.length, 0);
    assert.deepEqual(schedulerService.getRegisteredJobKeys(), []);
  });
});
