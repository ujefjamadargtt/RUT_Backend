'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Project-Wise Timesheet Report (GET /reports/project-timesheet) — client
// requirement #5: employee-wise, day-wise entries with activity description,
// Project Manager, leave hours and approval status; project-wise and
// employee-wise filtering; Excel/CSV download.

const { projectTimesheetReportQuerySchema } = require('../src/validations/projectTimesheetReportValidation');
const repository = require('../src/repositories/projectTimesheetReportRepository');
const service = require('../src/services/projectTimesheetReportService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const validate = (q) => projectTimesheetReportQuerySchema.validate(q);

test('validation: exactly one period — month+year OR start_date+end_date', () => {
  assert.equal(validate({ month: 9, year: 2026 }).error, undefined);
  assert.equal(validate({ start_date: '2026-09-01', end_date: '2026-09-30' }).error, undefined);
  assert.match(validate({}).error.message, /exactly one period/);
  assert.match(validate({ month: 9, year: 2026, start_date: '2026-09-01', end_date: '2026-09-30' }).error.message, /exactly one period/);
  assert.match(validate({ month: 9 }).error.message, /together/);
  assert.match(validate({ start_date: '2026-09-01' }).error.message, /together/);
  assert.match(validate({ month: 9, year: 2026, project_ids: '1;2' }).error.message, /comma-separated list of ids/);
});

test('period: a range over 366 days or reversed is rejected', () => {
  assert.throws(() => service.resolvePeriod({ start_date: '2025-01-01', end_date: '2026-06-01' }), /cannot exceed 366 days/);
  assert.throws(() => service.resolvePeriod({ start_date: '2026-09-30', end_date: '2026-09-01' }), /on or before/);
  assert.deepEqual(service.resolvePeriod({ month: 2, year: 2026 }).period, { type: 'month', month: 2, year: 2026, start_date: '2026-02-01', end_date: '2026-02-28' });
});

const BASE = { employeeIds: [1, 2], startDate: '2026-09-01', endDate: '2026-09-30' };

test('SQL filter: project filter + include_leave also brings the SAME employees\' leave entries', () => {
  const { whereSql, replacements } = repository.buildWhere({ ...BASE, servicePoIds: [147], includeLeave: true });
  const sql = whereSql.replace(/\s+/g, ' ');
  assert.match(sql, /\( ?\(wl\.service_po_id IN \(:servicePoIds\)\) OR \(LOWER/);
  assert.match(sql, /EXISTS \( SELECT 1 FROM employee_work_logs wl2 .* wl2\.employee_id = wl\.employee_id .* wl2\.service_po_id IN \(:servicePoIds\)/);
  assert.deepEqual(replacements.servicePoIds, [147]);
});

test('SQL filter: project filter without include_leave shows project entries only', () => {
  const sql = repository.buildWhere({ ...BASE, projectIds: [9], includeLeave: false }).whereSql;
  assert.match(sql, /\(sp\.project_id IN \(:projectIds\)\)/);
  assert.doesNotMatch(sql, /EXISTS/);
});

test('SQL filter: no project filter + include_leave=false excludes leave rows; employee scope always applied', () => {
  const sql = repository.buildWhere({ ...BASE, includeLeave: false }).whereSql;
  assert.match(sql, /NOT \(LOWER\(TRIM\(COALESCE\(st\.service_type_name, ''\)\)\) IN \('leave', 'leaves'\)\)/);
  assert.match(sql, /wl\.employee_id IN \(:employeeIds\)/);
});

test('SQL filter: null employeeIds (Project Manager scope) drops the employee condition', () => {
  const { whereSql, replacements } = repository.buildWhere({ ...BASE, employeeIds: null, servicePoIds: [28], includeLeave: true });
  assert.doesNotMatch(whereSql, /wl\.employee_id IN \(:employeeIds\)/);
  assert.equal(replacements.employeeIds, undefined);
});

test('record: leave entries report hours as Leave Hours, not Logged Hours; status labels', () => {
  const leave = service.toRecord({ id: 1, hours: '8.00', is_leave: true, status: 'approved', log_type: 'daily', project_name: null });
  assert.equal(leave.work_type, 'Leave');
  assert.equal(leave.logged_hours, 0);
  assert.equal(leave.leave_hours, 8);
  assert.equal(leave.project_name, 'Leave');
  const work = service.toRecord({ id: 2, hours: '3.07', is_leave: false, status: 'synced', log_type: 'monthly', project_name: 'RUT' });
  assert.equal(work.logged_hours, 3.07);
  assert.equal(work.approval_status_label, 'Approved (Synced)');
  assert.equal(work.entry_type, 'Monthly');
});

test('Project Manager: scoped to their own PM Service POs (a requested PO outside them is dropped)', async () => {
  const original = {
    getPm: employeeServicePOMappingService.getProjectManagerServicePOIds,
    findRows: repository.findRows,
    getTotals: repository.getTotals,
  };
  let captured;
  employeeServicePOMappingService.getProjectManagerServicePOIds = async () => [28, 147];
  repository.findRows = async (filters) => { captured = filters; return []; };
  repository.getTotals = async () => ({ entry_count: 0, employee_count: 0 });
  try {
    await service.getReport({ month: 9, year: 2026, service_po_ids: '147,999', page: 1, limit: 10 }, { employeeId: 268, hierarchyRank: 6 }, [23]);
    assert.deepEqual(captured.servicePoIds, [147]);
    assert.equal(captured.employeeIds, null);

    employeeServicePOMappingService.getProjectManagerServicePOIds = async () => [];
    const empty = await service.getReport({ month: 9, year: 2026, page: 1, limit: 10 }, { employeeId: 268, hierarchyRank: 6 }, [23]);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.totals.entry_count, 0);
  } finally {
    employeeServicePOMappingService.getProjectManagerServicePOIds = original.getPm;
    repository.findRows = original.findRows;
    repository.getTotals = original.getTotals;
  }
});

test('Excel export columns cover every requirement field', () => {
  const labels = service.DETAIL_COLUMNS.map((c) => c.label);
  ['Employee ID', 'Employee Name', 'Date', 'Day', 'Project', 'Service PO', 'Logged Hours', 'Leave Hours',
    'Activity / Work Description', 'Project Manager', 'Approval Status'].forEach((label) => assert.ok(labels.includes(label), label));
});
