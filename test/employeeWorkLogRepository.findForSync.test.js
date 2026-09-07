'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for Sync's BU isolation: "the same work log must never
// appear in both BU syncs" — findForSync(companyId, month, year) is what
// Admin Timesheet's "Sync Employee Work Logs" (timesheetService.
// previewPmsImport) reads from, filtered on the work log row's OWN
// company_id (which mirrors its Service PO's owning BU, not the employee's
// home BU — see employeeTimesheetService.replaceDailyEntries' cross-BU
// company_id comment). A work log stamped company_id=BU-B must be picked up
// ONLY when syncing BU-B, never when syncing BU-A, even for an employee
// mapped to both.
//
// Integration test against the real dev DB (same style as
// timesheetService.confirmImport.pmsRepeatSync.test.js) — findForSync is a
// raw Sequelize query, not meaningfully unit-testable via monkey-patching.
// Uses one genuinely existing Employee/ServicePO/Company set under a
// distinctive test period unlikely to collide with real data.
const { sequelize, EmployeeWorkLog, Employee, ServicePO, Company } = require('../src/models');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');

const MONTH = 7;
const YEAR = 2031; // distinctive test period, unlikely to collide with real data

let employeeId;
let servicePOId;
let companyAId;
let companyBId;
const workLogIds = [];

test.before(async () => {
  const employee = await Employee.findOne({ raw: true });
  employeeId = employee.id;

  const servicePO = await ServicePO.findOne({ raw: true });
  servicePOId = servicePO.id;

  const companies = await Company.findAll({ limit: 2, raw: true });
  if (companies.length < 2) {
    throw new Error('findForSync BU-isolation test requires at least 2 Company rows in the dev DB.');
  }
  [{ id: companyAId }, { id: companyBId }] = companies;
});

test.after(async () => {
  if (workLogIds.length) {
    await EmployeeWorkLog.destroy({ where: { id: workLogIds }, force: true }).catch(() => {});
  }
  await sequelize.close();
});

test('findForSync(companyId, ...) only returns work logs whose OWN company_id matches — a BU-B row never surfaces in a BU-A sync, and vice versa', async () => {
  const workLogA = await EmployeeWorkLog.create({
    company_id: companyAId,
    employee_id: employeeId,
    service_po_id: servicePOId,
    work_date: `${YEAR}-0${MONTH}-10`,
    hours: 3,
    log_type: 'daily',
    description: 'BU-A sync isolation regression row',
    status: 'approved', // findForSync excludes only 'pending'
  });
  workLogIds.push(workLogA.id);

  const workLogB = await EmployeeWorkLog.create({
    company_id: companyBId,
    employee_id: employeeId,
    service_po_id: servicePOId,
    work_date: `${YEAR}-0${MONTH}-11`,
    hours: 5,
    log_type: 'daily',
    description: 'BU-B sync isolation regression row',
    status: 'approved',
  });
  workLogIds.push(workLogB.id);

  const syncedForA = await employeeWorkLogRepository.findForSync(companyAId, MONTH, YEAR);
  const idsForA = syncedForA.map((row) => row.id);
  assert.ok(idsForA.includes(workLogA.id), 'BU-A sync must pick up the BU-A work log');
  assert.ok(!idsForA.includes(workLogB.id), 'BU-A sync must NOT pick up the BU-B work log');

  const syncedForB = await employeeWorkLogRepository.findForSync(companyBId, MONTH, YEAR);
  const idsForB = syncedForB.map((row) => row.id);
  assert.ok(idsForB.includes(workLogB.id), 'BU-B sync must pick up the BU-B work log');
  assert.ok(!idsForB.includes(workLogA.id), 'BU-B sync must NOT pick up the BU-A work log');
});
