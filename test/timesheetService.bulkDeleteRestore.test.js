'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the bulk/import Timesheet-delete restore target:
// deleteImports() used to revert a synced-then-deleted work log all the way
// back to 'pending' (employeeWorkLogRepository.revertSyncStatusByImportIds),
// unlike the single-timesheet delete path (deleteTimesheet ->
// revertSyncStatusByTuple), which reverts to 'approved' since a Manager's
// approval already happened and must not be re-requested. Per the confirmed
// business requirement, BOTH delete paths must land on 'approved', so a
// synced-then-deleted work log is immediately eligible for the next sync
// without requiring the employee to resubmit or the Team Lead to re-approve.
//
// Integration tests against the real dev DB (same style as
// timesheetService.confirmImport.pmsRepeatSync.test.js), using the same
// known-active Employee/ServicePO/Company set, under distinctive test
// periods unlikely to collide with real data or with other test files.
const {
  sequelize,
  TimesheetImportHistory,
  EmployeeWorkLog,
  Timesheet,
  User,
} = require('../src/models');
const timesheetService = require('../src/services/timesheetService');
const timesheetRepository = require('../src/repositories/timesheetRepository');

const EMPLOYEE_ID = 316;
const SERVICE_PO_ID = 158;
const COMPANY_ID = 34;
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

test('deleteTimesheet (single delete): Approved -> Synced -> delete -> Approved (unchanged behavior)', async () => {
  const MONTH = 8;
  const workLog = await EmployeeWorkLog.create({
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-0${MONTH}-05`,
    hours: 4,
    log_type: 'daily',
    description: 'single-delete restore regression row',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(preview.importId);
  const confirmResult = await timesheetService.confirmImport(preview.importId, userId, null, COMPANY_ID);
  assert.equal(confirmResult.status, 'completed');

  const synced = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(synced.status, 'synced');

  const timesheetRow = await Timesheet.findOne({
    where: { employee_id: EMPLOYEE_ID, service_po_id: SERVICE_PO_ID, timesheet_date: `${YEAR}-0${MONTH}-05` },
    raw: true,
  });
  assert.ok(timesheetRow, 'expected a timesheet row to exist after sync');

  await timesheetService.deleteTimesheet(timesheetRow.id, COMPANY_ID);

  const afterDelete = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(afterDelete.status, 'approved', 'single delete must restore to approved (not pending)');
  assert.equal(afterDelete.synced_at, null);
  assert.equal(afterDelete.timesheet_import_id, null);

  const timesheetAfterDelete = await Timesheet.findByPk(timesheetRow.id, { raw: true });
  assert.equal(timesheetAfterDelete, null, 'the deleted timesheet row must be gone');
});

test('deleteImports (bulk/import delete): Approved -> Synced -> delete import -> Approved (NOT pending)', async () => {
  const MONTH = 9;
  const workLog = await EmployeeWorkLog.create({
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-0${MONTH}-06`,
    hours: 6,
    log_type: 'daily',
    description: 'bulk-delete restore regression row (synced)',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  // An unrelated, never-synced work log in the SAME company+month, to prove
  // deleteImports only touches rows tied to the deleted import, never
  // unrelated rows sitting at a different status.
  const unrelatedWorkLog = await EmployeeWorkLog.create({
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-0${MONTH}-07`,
    hours: 2,
    log_type: 'daily',
    description: 'unrelated pending row, must be untouched by deleteImports',
    status: 'pending',
  });
  workLogIds.push(unrelatedWorkLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(preview.importId);
  const confirmResult = await timesheetService.confirmImport(preview.importId, userId, null, COMPANY_ID);
  assert.equal(confirmResult.status, 'completed');
  assert.equal(confirmResult.insertedRows, 1, 'only the approved row should have synced, not the pending one');

  const synced = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(synced.status, 'synced');
  assert.equal(synced.timesheet_import_id, preview.importId);

  const deleteResult = await timesheetService.deleteImports([preview.importId], COMPANY_ID);
  assert.equal(deleteResult.revertedWorkLogs, 1);
  assert.equal(deleteResult.deletedTimesheetRows, 1);

  const restored = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(restored.status, 'approved', 'bulk/import delete must restore to approved, not pending');
  assert.equal(restored.synced_at, null);
  assert.equal(restored.timesheet_import_id, null);

  const unrelatedAfter = await EmployeeWorkLog.findByPk(unrelatedWorkLog.id, { raw: true });
  assert.equal(unrelatedAfter.status, 'pending', 'an unrelated, never-synced work log must be untouched');

  // Next sync: the restored 'approved' row must be picked up again WITHOUT
  // any re-approval step, and the timesheet row must be recreated.
  const secondPreview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(secondPreview.importId);
  assert.equal(secondPreview.validRows, 1, 'the restored approved row must be eligible for the next sync');

  const secondConfirm = await timesheetService.confirmImport(secondPreview.importId, userId, null, COMPANY_ID);
  assert.equal(secondConfirm.status, 'completed');
  assert.equal(secondConfirm.insertedRows, 1);

  const resynced = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(resynced.status, 'synced', 'the work log must be synced again on the next run');

  const recreatedTimesheet = await Timesheet.findOne({
    where: { employee_id: EMPLOYEE_ID, service_po_id: SERVICE_PO_ID, timesheet_date: `${YEAR}-0${MONTH}-06` },
    raw: true,
  });
  assert.ok(recreatedTimesheet, 'the timesheet row must be recreated by the next sync');
});

test('deleteImports: if the timesheet delete step fails, the work log status restore is rolled back (stays synced)', async () => {
  const MONTH = 10;
  const workLog = await EmployeeWorkLog.create({
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-${MONTH}-08`,
    hours: 3,
    log_type: 'daily',
    description: 'transaction-rollback regression row',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, COMPANY_ID);
  importIds.push(preview.importId);
  const confirmResult = await timesheetService.confirmImport(preview.importId, userId, null, COMPANY_ID);
  assert.equal(confirmResult.status, 'completed');

  const original = timesheetRepository.deleteByImportIds;
  timesheetRepository.deleteByImportIds = async () => {
    throw new Error('simulated failure deleting timesheet rows');
  };
  try {
    await assert.rejects(
      () => timesheetService.deleteImports([preview.importId], COMPANY_ID),
      /simulated failure/
    );
  } finally {
    timesheetRepository.deleteByImportIds = original;
  }

  const afterFailedDelete = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(
    afterFailedDelete.status,
    'synced',
    'a rolled-back delete must leave the work log at synced, never committed as approved'
  );

  const timesheetStillThere = await Timesheet.findOne({
    where: { employee_id: EMPLOYEE_ID, service_po_id: SERVICE_PO_ID, timesheet_date: `${YEAR}-${MONTH}-08` },
    raw: true,
  });
  assert.ok(timesheetStillThere, 'the timesheet row must still exist since the delete transaction rolled back');
});
