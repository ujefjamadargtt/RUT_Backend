'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the reported bug: an Admin/multi-BU actor could
// see an import/timesheet row in the combined "All BU" Imports list (GET
// /timesheets/import/history, which aggregates every BU the caller can
// reach), but deleting that SAME row 404'd with "No matching import
// record(s) found to delete." whenever the caller's currently-active
// Business Unit (X-Company-Id) differed from the row's own company_id.
//
// Root cause: deleteTimesheet()/deleteImports() were scoped to a single
// req.companyId (or, for a company-less Admin/Entity Admin,
// resolveCompanyContextForCompanyLessActors' single auto-picked company),
// while the list view aggregates across the caller's full reach. Fix:
// timesheetController.deleteTimesheet/deleteImports now resolve the
// caller's FULL BU/owned-Company reach via
// companyAccessControlService.resolveActorFullReach() (same fix already
// used for getClientById/getProjectById/getServicePOById's single-record
// lookups), and the repository layer's findById/findByIds are now
// Op.in-aware for that array — see employeeWorkLogRepository... no,
// timesheetRepository.js's companyScope().
//
// Integration tests against the real dev DB (same style as
// timesheetService.confirmImport.pmsRepeatSync.test.js), using two
// DIFFERENT real companies to simulate "row belongs to BU A, caller's
// active BU is B, but caller's full reach includes both."
const {
  sequelize,
  TimesheetImportHistory,
  EmployeeWorkLog,
  Timesheet,
  User,
} = require('../src/models');
const timesheetService = require('../src/services/timesheetService');

const EMPLOYEE_ID = 316;
const SERVICE_PO_ID = 158;
const ROW_COMPANY_ID = 34; // the BU the row actually belongs to
const OTHER_COMPANY_ID = 89; // a real, different BU — simulates "wrong active BU"
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

test('deleteTimesheet: a row belonging to BU A is found and deleted when the caller\'s reach is [BU B, BU A] (multi-BU/Admin reach), not just BU A alone', async () => {
  const MONTH = 11;
  const workLog = await EmployeeWorkLog.create({
    company_id: ROW_COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-${MONTH}-05`,
    hours: 4,
    log_type: 'daily',
    description: 'full-reach single-delete regression row',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, ROW_COMPANY_ID);
  importIds.push(preview.importId);
  await timesheetService.confirmImport(preview.importId, userId, null, ROW_COMPANY_ID);

  const timesheetRow = await Timesheet.findOne({
    where: { employee_id: EMPLOYEE_ID, service_po_id: SERVICE_PO_ID, timesheet_date: `${YEAR}-${MONTH}-05` },
    raw: true,
  });
  assert.ok(timesheetRow, 'expected a timesheet row to exist after sync');

  // Old behavior (single, mismatched companyId) would 404 here.
  await assert.rejects(
    () => timesheetService.deleteTimesheet(timesheetRow.id, OTHER_COMPANY_ID),
    /not found/i,
    'a companyId scoped to a DIFFERENT BU must still fail — this proves the fix does not weaken authorization'
  );

  // New behavior: caller's full reach (an array including the row's real BU) succeeds.
  await timesheetService.deleteTimesheet(timesheetRow.id, [OTHER_COMPANY_ID, ROW_COMPANY_ID]);

  const afterDelete = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(afterDelete.status, 'approved', 'restore-to-approved behavior must still apply for a full-reach delete');

  const timesheetAfterDelete = await Timesheet.findByPk(timesheetRow.id, { raw: true });
  assert.equal(timesheetAfterDelete, null);
});

test('deleteImports: an import belonging to BU A is found and deleted when the caller\'s reach is [BU B, BU A]', async () => {
  const MONTH = 12;
  const workLog = await EmployeeWorkLog.create({
    company_id: ROW_COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    service_po_id: SERVICE_PO_ID,
    work_date: `${YEAR}-${MONTH}-06`,
    hours: 5,
    log_type: 'daily',
    description: 'full-reach bulk-delete regression row',
    status: 'approved',
  });
  workLogIds.push(workLog.id);

  const preview = await timesheetService.previewPmsImport(MONTH, YEAR, userId, ROW_COMPANY_ID);
  importIds.push(preview.importId);
  await timesheetService.confirmImport(preview.importId, userId, null, ROW_COMPANY_ID);

  // Old behavior (single, mismatched companyId) would 404 here.
  await assert.rejects(
    () => timesheetService.deleteImports([preview.importId], OTHER_COMPANY_ID),
    /No matching import record/,
    'a companyId scoped to a DIFFERENT BU must still fail — this proves the fix does not weaken authorization'
  );

  // New behavior: caller's full reach (an array including the row's real BU) succeeds.
  const result = await timesheetService.deleteImports([preview.importId], [OTHER_COMPANY_ID, ROW_COMPANY_ID]);
  assert.equal(result.deletedImportCount, 1);
  assert.equal(result.revertedWorkLogs, 1);

  const restored = await EmployeeWorkLog.findByPk(workLog.id, { raw: true });
  assert.equal(restored.status, 'approved');
});
