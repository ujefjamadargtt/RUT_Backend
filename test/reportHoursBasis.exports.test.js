'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const crossBuRepo = require('../src/repositories/crossBuEmployeePoHoursReportRepository');
const crossBuService = require('../src/services/crossBuEmployeePoHoursReportService');
const utilisationController = require('../src/controllers/utilisationReportController');
const { crossBuEmployeePoHoursReportQuerySchema } = require('../src/validations/crossBuEmployeePoHoursReportValidation');
const {
  employeeWorkLogHoursSummaryQuerySchema,
  employeeWorkLogHoursSummaryDetailQuerySchema,
} = require('../src/validations/employeeWorkLogHoursSummaryValidation');

const keysOf = (cols) => cols.map((c) => c.key);

test('cross-bu: sort_by=hours follows the Hours basis (Original -> hours/logged, Adjusted -> adjusted_hours); other keys unchanged', () => {
  assert.match(crossBuRepo.resolveOrderBy('hours', 'O'), /^hours DESC/);
  assert.match(crossBuRepo.resolveOrderBy('hours', 'M'), /^adjusted_hours DESC NULLS LAST/);
  assert.match(crossBuRepo.resolveOrderBy('hours', undefined), /^adjusted_hours DESC NULLS LAST/);
  assert.match(crossBuRepo.resolveOrderBy('po', 'O'), /^sp\.service_po_name/);
  assert.match(crossBuRepo.resolveOrderBy('nonsense; DROP', 'O'), /^e\.full_name/);
});

test('cross-bu: export carries ONE hours column, header suffixed (Original) for O', () => {
  const original = crossBuService.detailColumnsFor({ hoursSource: 'O' });
  assert.ok(keysOf(original).includes('logged_hours'));
  assert.ok(!keysOf(original).includes('adjusted_hours'));
  assert.equal(original.find((c) => c.key === 'logged_hours').label, 'Logged Hours (Original)');

  for (const q of [{ hoursSource: 'M' }, {}]) {
    const adjusted = crossBuService.detailColumnsFor(q);
    assert.ok(keysOf(adjusted).includes('adjusted_hours'));
    assert.ok(!keysOf(adjusted).includes('logged_hours'));
  }
  assert.equal(crossBuService.flowColumnsFor({ hoursSource: 'O' }).find((c) => c.key === 'hours').label, 'Hours (Original)');
  assert.equal(crossBuService.flowColumnsFor({}).find((c) => c.key === 'hours').label, 'Hours (Adjusted)');
});

test('cross-bu: Adjusted export reads the adjusted BU matrix, Original the as-logged one', async () => {
  const saved = { ...crossBuRepo };
  const calls = [];
  crossBuRepo.getBuMatrix = async () => { calls.push('orig'); return []; };
  crossBuRepo.getBuMatrixAdjusted = async () => { calls.push('adj'); return []; };
  crossBuRepo.findRows = async () => [];
  try {
    // Reach scope with no companyIds resolves to "no filters" and short-circuits — drive the service via a Platform-Admin-like context instead.
    const expand = require('../src/services/companyAccessControlService');
    const savedExpand = expand.expandBusinessUnitIdsWithDescendants;
    expand.expandBusinessUnitIdsWithDescendants = async (ids) => ids;
    try {
      await crossBuService.getExport({ month: 9, year: 2026, hoursSource: 'O' }, { hierarchyRank: 4 }, [1]);
      await crossBuService.getExport({ month: 9, year: 2026 }, { hierarchyRank: 4 }, [1]);
    } finally { expand.expandBusinessUnitIdsWithDescendants = savedExpand; }
  } finally { Object.assign(crossBuRepo, saved); }
  assert.deepEqual(calls, ['orig', 'adj']);
});

test('cross-bu: totals expose original_* and adjusted_* Own / Cross / Not Classified hours, existing fields kept', () => {
  const t = crossBuService.toTotals({
    employee_count: 3, total_hours: '100', own_bu_hours: '60', cross_bu_hours: '30', unclassified_hours: '10', cross_bu_employee_count: 1,
    adjusted_total_hours: '90', adjusted_own_bu_hours: '55', adjusted_cross_bu_hours: '27', adjusted_unclassified_hours: '8',
  });
  assert.equal(t.total_hours, 100);
  assert.equal(t.own_bu_hours, 60);
  assert.equal(t.original_own_bu_hours, 60);
  assert.equal(t.original_cross_bu_hours, 30);
  assert.equal(t.original_unclassified_hours, 10);
  assert.equal(t.adjusted_total_hours, 90);
  assert.equal(t.adjusted_own_bu_hours, 55);
  assert.equal(t.adjusted_cross_bu_hours, 27);
  assert.equal(t.adjusted_unclassified_hours, 8);
});

test('employee-project-utilisation export: one hours + one % column per basis, merge columns match', () => {
  const orig = utilisationController.empProjectColumnsFor({ hoursSource: 'O' });
  assert.deepEqual(keysOf(orig), ['employeeName', 'projectName', 'clientName', 'loggedHours', 'originalUtilizationPercentage']);
  assert.match(orig.find((c) => c.key === 'loggedHours').label, /\(Original\)$/);
  const adj = utilisationController.empProjectColumnsFor({});
  assert.deepEqual(keysOf(adj), ['employeeName', 'projectName', 'clientName', 'adjustedHours', 'totalUtilizationPercentage']);

  for (const q of [{ hoursSource: 'O' }, {}]) {
    const cols = keysOf(utilisationController.empProjectColumnsFor(q));
    utilisationController.empProjectMergeGroupsFor(q).columns.forEach((k) => assert.ok(cols.includes(k), k));
  }
});

test('bu-wise-utilisation export drops the original* twin columns and labels the basis', () => {
  const cols = utilisationController.buColumnsFor({ hoursSource: 'O' });
  assert.ok(!keysOf(cols).some((k) => k.startsWith('original')));
  assert.match(cols.find((c) => c.key === 'billableHours').label, /\(Original\)$/);
  assert.match(utilisationController.buColumnsFor({}).find((c) => c.key === 'billableHours').label, /\(Adjusted\)$/);
});

test('hoursSource is accepted on the report query schemas; invalid is normalised to M, not rejected', () => {
  const run = (schema, base, hoursSource) => schema.validate({ ...base, hoursSource }, { stripUnknown: true });
  for (const [schema, base] of [
    [crossBuEmployeePoHoursReportQuerySchema, { month: 9, year: 2026 }],
    [employeeWorkLogHoursSummaryQuerySchema, { month: 9, year: 2026 }],
    [employeeWorkLogHoursSummaryDetailQuerySchema, { month: 9, year: 2026 }],
  ]) {
    assert.equal(run(schema, base, 'O').value.hoursSource, 'O');
    assert.equal(run(schema, base, 'M').value.hoursSource, 'M');
    assert.equal(run(schema, base, 'bogus').error, undefined);
    assert.equal(run(schema, base, 'bogus').value.hoursSource, 'M');
    assert.equal(run(schema, base, undefined).value.hoursSource, undefined);
  }
});
