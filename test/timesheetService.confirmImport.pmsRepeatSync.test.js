'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Integration regression test for the "Timesheet Imports never leave
// pending" bug: a "Sync Employee Work Logs" import that confirmed cleanly
// (0 errors) must end up status='completed', AND a LATER repeat preview
// for the same company+month+year must never silently revert that already-
// completed row back to 'pending' (previewPmsImport()'s find-or-update
// reuse used to match ANY status, including 'completed'). Runs against the
// real dev DB using one genuinely existing, active Employee+ServicePO pair
// under a distinctive test period unlikely to collide with real data.
const { sequelize, TimesheetImportHistory, EmployeeWorkLog, Timesheet, User } = require('../src/models');
const timesheetService = require('../src/services/timesheetService');

const EMPLOYEE_ID = 316;
const SERVICE_PO_ID = 158;
const COMPANY_ID = 34;
const MONTH = 6;
const YEAR = 2031; // distinctive test period, unlikely to collide with real data

let userId;
const workLogIds = [];
const importIds = [];

test.before(async () => {
  const user = await User.findOne({ raw: true });
  userId = user.id;
});

test.after(async () => {
  if (importIds.length) {
    await Timesheet.destroy({ where: { timesheet_import_id: importIds } }).catch(() => {});
    await TimesheetImportHistory.destroy({ where: { id: importIds } }).catch(() => {});
  }
  if (workLogIds.length) {
    await EmployeeWorkLog.destroy({ where: { id: workLogIds }, force: true }).catch(() => {});
  }
  await sequelize.close();
});

test('confirmImport(): Sync import with 0 errors -> status "completed", and a repeat preview for the same period never reverts it back to pending', async () => {
  const workLog = await EmployeeWorkLog.create({
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-0${MONTH}-15`,
    hours: 5,
    log_type: 'daily',
    description: 'regression test row',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(preview.importId);
  assert.equal(preview.errorRows, 0);
  assert.equal(preview.validRows, 1);

  const confirmResult = await timesheetService.confirmImport(preview.importId, userId, null, COMPANY_ID);
  assert.equal(confirmResult.status, 'completed');
  assert.equal(confirmResult.insertedRows, 1);

  const afterConfirm = await TimesheetImportHistory.findByPk(preview.importId, { raw: true });
  assert.equal(afterConfirm.status, 'completed');

  // The regression itself: preview Sync again for the SAME period.
  const secondPreview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(secondPreview.importId);

  const stillCompleted = await TimesheetImportHistory.findByPk(preview.importId, { raw: true });
  assert.equal(
    stillCompleted.status,
    'completed',
    'the already-confirmed row must not be reverted to pending by a later preview'
  );
  assert.notEqual(
    secondPreview.importId,
    preview.importId,
    'a repeat preview over an already-completed period must create a new row, not overwrite the completed one'
  );
});
