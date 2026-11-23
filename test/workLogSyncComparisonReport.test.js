'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/workLogSyncComparisonReportRepository');
const service = require('../src/services/workLogSyncComparisonReportService');
const {
  workLogSyncComparisonQuerySchema: schema,
  workLogSyncComparisonFilterOptionsQuerySchema: optionsSchema,
} = require('../src/validations/workLogSyncComparisonReportValidation');

/**
 * Work Log Sync Comparison Report — DB-free: SQL text assertions on the repository's query builder, the
 * validation schemas and the service's pure mappers. (The SQL, the After-sync reconciliation against
 * `timesheets` and the paging were also checked against the local database.)
 */

const BASE = { startDate: '2026-09-01', endDate: '2026-09-30' };
const REACH = { kind: 'reach', reachIds: [23, 24], includeTenantBuLessPOs: false };

// ---- query builder ---------------------------------------------------------------------------------

test('uses the Cross-BU report visibility rules (same rows for the same role)', () => {
  const reach = repository.buildSelect({ ...BASE, scope: REACH });
  assert.match(reach.selectSql, /eb\.member_ids && ARRAY\[:reachIds\]::int\[\] OR sp\.company_id IN \(:reachIds\)/);

  const pm = repository.buildSelect({ ...BASE, scope: { kind: 'servicePos', servicePoIds: [4, 5] } });
  assert.match(pm.selectSql, /wl\.service_po_id IN \(:scopeServicePoIds\)/);
  assert.deepEqual(pm.replacements.scopeServicePoIds, [4, 5]);

  const lead = repository.buildSelect({ ...BASE, scope: { kind: 'employees', employeeIds: [9] } });
  assert.match(lead.selectSql, /wl\.employee_id IN \(:scopeEmployeeIds\)/);
});

test('reads live (non soft-deleted) entries only, one row per work log entry', () => {
  const { selectSql } = repository.buildSelect({ ...BASE, scope: REACH });
  assert.match(selectSql, /employee_work_logs WHERE deleted_at IS NULL\) wl/);
  assert.match(selectSql, /wl\.id AS work_log_id/);
  assert.doesNotMatch(selectSql, /GROUP BY e\.id/);
});

test('Module is the PARENT node, Task is the CHILD node of the hierarchy', () => {
  const { selectSql } = repository.buildSelect({ ...BASE, scope: REACH });
  assert.match(selectSql, /WHEN hn\.node_type = 'CHILD' THEN hp\.node_name WHEN hn\.id IS NOT NULL THEN hn\.node_name END AS module_name/);
  assert.match(selectSql, /WHEN hn\.node_type = 'CHILD' THEN hn\.node_name END AS task_name/);
});

test('after-sync hours: only synced entries, shared by logged hours over ALL the key\'s synced entries', () => {
  const { selectSql } = repository.buildSelect({ ...BASE, scope: REACH, search: 'x', clientIds: [1] });
  assert.match(selectSql, /wl\.status = 'synced' AND t\.id IS NOT NULL AND ss\.sum_hours > 0/);
  assert.match(selectSql, /COALESCE\(t\.modified_hours, t\.hours_logged\) \* wl\.hours \/ ss\.sum_hours/);
  // the sharing denominator is built from its own unfiltered CTE, so filters/paging can't change a share
  const cte = selectSql.slice(selectSql.indexOf('sync_sum AS'), selectSql.indexOf('SELECT\n    wl.id'));
  assert.doesNotMatch(cte, /:search|:clientIds/);
});

test('every filter is applied; none leaks in when it is not sent', () => {
  const none = repository.buildSelect({ ...BASE, scope: REACH });
  ['employeeIds', 'employeeBuIds', 'employeeSubBuIds', 'clientIds', 'projectIds', 'servicePoIds', 'poBuIds', 'statuses', 'workType', 'search']
    .forEach((k) => assert.equal(none.replacements[k], undefined, k));

  const all = repository.buildSelect({
    ...BASE, scope: REACH, employeeIds: [1], employeeBuIds: [2], employeeSubBuIds: [3], clientIds: [4], projectIds: [5],
    servicePoIds: [6], poBuIds: [7], statuses: ['synced'], workType: 'cross', search: 'abc',
  });
  assert.deepEqual(
    ['employeeIds', 'employeeBuIds', 'employeeSubBuIds', 'clientIds', 'projectIds', 'servicePoIds', 'poBuIds', 'statuses', 'workType']
      .map((k) => all.replacements[k]),
    [[1], [2], [3], [4], [5], [6], [7], ['synced'], 'cross']
  );
  assert.equal(all.replacements.search, '%abc%');
});

test('search escapes LIKE wildcards so "%" and "_" are matched literally', () => {
  const { replacements } = repository.buildSelect({ ...BASE, scope: REACH, search: '100%_a' });
  assert.equal(replacements.search, '%100\\%\\_a%');
});

test('sort_by is allow-listed in the schema and unknown keys fall back to date', () => {
  assert.ok(Object.keys(repository.SORTS).every((k) => !schema.validate({ sort_by: k }).error));
  assert.ok(schema.validate({ sort_by: 'employee; DROP TABLE x' }).error);
});

// ---- validation ------------------------------------------------------------------------------------

test('period: exactly one of date | start_date+end_date | month+year; none defaults to the current month', () => {
  assert.ok(!schema.validate({}).error);
  assert.ok(!schema.validate({ date: '2026-09-15' }).error);
  assert.ok(!schema.validate({ start_date: '2026-09-01', end_date: '2026-09-15' }).error);
  assert.ok(!schema.validate({ month: 9, year: 2026 }).error);

  assert.match(schema.validate({ date: '2026-09-15', month: 9, year: 2026 }).error.message, /only one period/);
  assert.match(schema.validate({ date: '2026-09-15', start_date: '2026-09-01', end_date: '2026-09-02' }).error.message, /only one period/);
  assert.match(schema.validate({ start_date: '2026-09-01' }).error.message, /sent together/);
  assert.match(schema.validate({ end_date: '2026-09-01' }).error.message, /sent together/);
  assert.match(schema.validate({ month: 9 }).error.message, /sent together/);
  assert.match(schema.validate({ start_date: '2026-09-10', end_date: '2026-09-01' }).error.message, /on or before/);
  assert.match(schema.validate({ start_date: '2025-01-01', end_date: '2026-12-31' }).error.message, /366 days/);
  assert.ok(schema.validate({ date: 'not-a-date' }).error);
});

test('pagination defaults, bounds and sort order', () => {
  const { value } = schema.validate({});
  assert.equal(value.page, 1);
  assert.equal(value.limit, 50);
  assert.equal(value.sort_by, 'date');
  assert.equal(value.sort_order, 'desc');
  assert.equal(value.format, 'json');
  assert.ok(schema.validate({ page: 0 }).error);
  assert.ok(schema.validate({ limit: 501 }).error);
  assert.ok(schema.validate({ sort_order: 'sideways' }).error);
  assert.ok(schema.validate({ format: 'pdf' }).error);
});

test('filter-options accepts the same period modes and nothing else', () => {
  assert.ok(!optionsSchema.validate({ date: '2026-09-15' }).error);
  assert.ok(!optionsSchema.validate({ start_date: '2026-09-01', end_date: '2026-09-15' }).error);
  assert.ok(!optionsSchema.validate({ month: 9, year: 2026 }).error);
  assert.ok(optionsSchema.validate({ date: '2026-09-15', month: 9, year: 2026 }).error);
  assert.ok(optionsSchema.validate({ employee_ids: '1' }).error);
});

// ---- service ---------------------------------------------------------------------------------------

test('resolvePeriod supports a single date, a range and a month', () => {
  assert.deepEqual(service.resolvePeriod({ date: '2026-09-15' }),
    { startDate: '2026-09-15', endDate: '2026-09-15', period: { type: 'date', date: '2026-09-15', start_date: '2026-09-15', end_date: '2026-09-15' } });
  const range = service.resolvePeriod({ start_date: '2026-10-01', end_date: '2026-11-30' });
  assert.equal(range.period.type, 'range');
  assert.equal(range.endDate, '2026-11-30');
  const month = service.resolvePeriod({ month: 2, year: 2027 });
  assert.deepEqual([month.startDate, month.endDate, month.period.type], ['2027-02-01', '2027-02-28', 'month']);
});

test('toRecord: unsynced entry has null after-sync hours; synced entry carries the difference', () => {
  const base = {
    work_log_id: 1, work_date: new Date('2026-09-15T00:00:00Z'), employee_id: 2, employee_name: 'Om', employee_code: 'E1',
    module_name: 'Mod', task_name: 'Task', before_sync_hours: '8.00', description: 'd', work_type: 'cross', is_centralised: false,
  };
  const pending = service.toRecord({ ...base, status: 'pending', after_sync_hours: null });
  assert.equal(pending.after_sync_hours, null);
  assert.equal(pending.hours_difference, null);
  assert.equal(pending.is_synced, false);
  assert.equal(pending.date, '2026-09-15');
  assert.equal(pending.work_type_label, 'Cross BU');

  const synced = service.toRecord({ ...base, status: 'synced', after_sync_hours: '6.40' });
  assert.equal(synced.before_sync_hours, 8);
  assert.equal(synced.after_sync_hours, 6.4);
  assert.equal(synced.hours_difference, -1.6);
  assert.equal(synced.is_synced, true);
  assert.equal(synced.status_label, 'Synced');
});

test('toTotals splits hours by work type and counts synced vs not synced entries', () => {
  const t = service.toTotals({
    total_entries: 10, employee_count: 4, synced_entries: 6, before_sync_hours: '100', after_sync_hours: '60.5',
    own_before_hours: '70', own_after_hours: '40', cross_before_hours: '25', cross_after_hours: '20.5', na_before_hours: '5', na_after_hours: '0',
  });
  assert.equal(t.not_synced_entries, 4);
  assert.deepEqual(t.cross_bu, { before_sync_hours: 25, after_sync_hours: 20.5 });
  assert.equal(t.after_sync_hours, 60.5);
});

test('a caller with no scope gets an empty report with correct paging meta — never an error or other data', async () => {
  const calls = [];
  const original = { ...repository };
  repository.getSummary = async () => { calls.push('summary'); return {}; };
  repository.findPage = async () => { calls.push('page'); return []; };
  try {
    const result = await service.getReport({ page: 3, limit: 20 }, { hierarchyRank: 1, employeeId: 1 }, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(result.records, []);
    assert.equal(result.meta.total, 0);
    assert.equal(result.meta.page, 3);
    assert.equal(result.totals.total_entries, 0);
  } finally {
    Object.assign(repository, original);
  }
});

test('export columns follow the requested layout', () => {
  const labels = service.COLUMNS.map((c) => c.label);
  ['Employee Name', 'Date', 'Client', 'Project', 'Service PO', 'Module', 'Task', 'Before Sync Hrs', 'After Sync Hrs', 'Work Type', 'Description']
    .forEach((l) => assert.ok(labels.includes(l), l));
});
