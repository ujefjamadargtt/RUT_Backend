'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

// Regression test for the "Sync Employee Work Logs" bug: previewPmsImport()
// reuses/overwrites the existing timesheet_import_history row for a given
// company+month+year+source instead of creating a new one, so the row
// never accumulates duplicates for repeat syncs. Before this fix, that
// reuse lookup matched a row REGARDLESS of status — including an already
// 'completed' row whose timesheets are already committed and live. A
// second preview call for the same month then silently reset that row's
// status back to 'pending' (via updateImportHistory), even though nothing
// about the already-imported data changed and nothing ever re-confirmed
// it — leaving it stuck at 'pending' forever and invisible to the
// frontend's completed-only Timesheet Imports list.
const { TimesheetImportHistory } = require('../src/models');
const timesheetImportRepository = require('../src/repositories/timesheetImportRepository');

const ORIGINAL_FIND_ONE = TimesheetImportHistory.findOne;

function restore() {
  TimesheetImportHistory.findOne = ORIGINAL_FIND_ONE;
}

test('findByMonthYearSource(): excludes completed/partial rows from the reuse lookup', async () => {
  let capturedWhere;
  TimesheetImportHistory.findOne = async ({ where }) => {
    capturedWhere = where;
    return null;
  };

  await timesheetImportRepository.findByMonthYearSource(40, 8, 2026, 'pms');

  assert.equal(capturedWhere.company_id, 40);
  assert.equal(capturedWhere.import_month, 8);
  assert.equal(capturedWhere.import_year, 2026);
  assert.equal(capturedWhere.source, 'pms');
  assert.ok(capturedWhere.status, 'status filter must be present');
  const notInValues = capturedWhere.status[Op.notIn];
  assert.deepEqual([...notInValues].sort(), ['completed', 'partial']);

  restore();
});

test('findByMonthYearSource(): a pending row for the same period is still matched by the lookup (unaffected by this fix)', async () => {
  const pendingRow = { id: 5, status: 'pending' };
  TimesheetImportHistory.findOne = async () => pendingRow;

  const result = await timesheetImportRepository.findByMonthYearSource(40, 8, 2026, 'pms');

  assert.equal(result, pendingRow);

  restore();
});
