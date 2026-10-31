'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const monthly = require('../src/services/aiInsightMonthly.service');
const { MONTHLY_JOBS, combineTotals } = require('../src/services/aiInsightMonthlyJobs');
const { JOB_DEFINITIONS } = require('../src/repositories/aiInsightJobRepository');
const { JOB_TEMPLATES } = require('../src/utils/promptBuilder');

test('the report month is the calendar month that just ended (business timezone)', () => {
  const p = monthly.previousMonthPeriod(new Date('2026-10-15T10:00:00+05:30'));
  assert.deepEqual([p.start, p.end, p.month, p.year, p.label, p.periodMonth], ['2026-09-01', '2026-09-30', 9, 2026, 'Sep-2026', '2026-09-01']);
  // 00:30 IST on the 1st is still the new month in IST even though it is the previous day in UTC
  assert.equal(monthly.previousMonthPeriod(new Date('2026-10-01T00:30:00+05:30')).label, 'Sep-2026');
  assert.equal(monthly.previousMonthPeriod(new Date('2027-01-10T10:00:00+05:30')).label, 'Dec-2026');
});

test('shiftPeriod moves whole months across a year boundary', () => {
  const sep = monthly.previousMonthPeriod(new Date('2026-10-15T10:00:00+05:30'));
  assert.equal(monthly.shiftPeriod(sep, -1).label, 'Aug-2026');
  assert.equal(monthly.shiftPeriod(monthly.previousMonthPeriod(new Date('2027-02-10T10:00:00+05:30')), -2).label, 'Nov-2026');
});

test('quarter-end months are Mar / Jun / Sep / Dec', () => {
  const at = (iso) => monthly.isQuarterEndMonth(monthly.previousMonthPeriod(new Date(iso)));
  assert.equal(at('2026-10-05T10:00:00+05:30'), true); // Sep
  assert.equal(at('2026-11-05T10:00:00+05:30'), false); // Oct
  assert.equal(at('2027-01-05T10:00:00+05:30'), true); // Dec
  assert.equal(at('2027-04-05T10:00:00+05:30'), true); // Mar
});

test('sync status and the pending note name the units still to sync', () => {
  const units = [{ id: 1, name: 'BU-A' }, { id: 2, name: 'BU-B' }, { id: 3, name: 'BU-C' }, { id: 4, name: 'BU-D' }];
  const status = monthly.buildSyncStatus(units, new Set([1, 2]));
  assert.equal(status.synced_count, 2);
  assert.equal(status.total_count, 4);
  assert.deepEqual(status.pending.map((u) => u.name), ['BU-C', 'BU-D']);
  const period = monthly.previousMonthPeriod(new Date('2026-10-15T10:00:00+05:30'));
  const note = monthly.pendingNote(period, status, 'tenant');
  assert.match(note, /BU-C, BU-D/);
  assert.match(note, /2 of 4 synced/);
  assert.match(monthly.pendingNote(period, monthly.buildSyncStatus([units[2]], new Set()), 'bu'), /BU-C/);
});

test('the data signature is stable for equal data and changes when the data or the sync set changes', () => {
  const a = monthly.signatureOf({ data: { x: 1, y: [1, 2] }, pending: [3] });
  assert.equal(a, monthly.signatureOf({ data: { x: 1, y: [1, 2] }, pending: [3] }));
  assert.notEqual(a, monthly.signatureOf({ data: { x: 2, y: [1, 2] }, pending: [3] }));
  assert.notEqual(a, monthly.signatureOf({ data: { x: 1, y: [1, 2] }, pending: [] }));
});

test('every seeded monthly job has a registry entry, a prompt template and the right audience', () => {
  const monthlyDefs = JOB_DEFINITIONS.filter((d) => d.frequency === 'monthly');
  assert.equal(monthlyDefs.length, Object.keys(MONTHLY_JOBS).length);
  for (const def of monthlyDefs) {
    const spec = MONTHLY_JOBS[def.job_key];
    assert.ok(spec, `${def.job_key} has a registry entry`);
    assert.ok(JOB_TEMPLATES[def.job_key], `${def.job_key} has a prompt template`);
    assert.equal(def.schedule_type, 'DL', `${def.job_key} runs daily (retry until every unit is synced)`);
    assert.deepEqual(def.audience_roles, spec.scope === 'bu' ? ['BU Admin'] : ['Admin']);
    assert.deepEqual(JOB_TEMPLATES[def.job_key].audienceRoles, def.audience_roles);
    assert.ok(monthly.isMonthlyJob(def.job_key));
  }
  assert.equal(monthly.isMonthlyJob('new_po_staffing_suggestion'), false);
});

test('the old weekly / daily / monthly jobs are no longer seeded; the PO event job stays', () => {
  const keys = JOB_DEFINITIONS.map((d) => d.job_key);
  ['weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
    'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review']
    .forEach((k) => assert.ok(!keys.includes(k), `${k} removed`));
  assert.ok(keys.includes('new_po_staffing_suggestion'));
});

test('combineTotals sums hours and recomputes the percentages against combined capacity', () => {
  const t = combineTotals([
    { headcount: 2, capacity_hours: 200, logged_hours: 100, billable_hours: 80, non_billable_hours: 20, bench_hours: 10 },
    { headcount: 3, capacity_hours: 300, logged_hours: 300, billable_hours: 150, non_billable_hours: 150, bench_hours: 40 },
  ]);
  assert.equal(t.headcount, 5);
  assert.equal(t.capacity_hours, 500);
  assert.equal(t.utilization_pct, 80);
  assert.equal(t.billable_utilization_pct, 46);
});
