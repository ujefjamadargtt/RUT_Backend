'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for a real bug report on the "Remind for Approval"
// feature: an employee had 2 Service POs pending in the SAME month, each
// under a DIFFERENT Business Unit (a cross-BU-mapped employee — see
// employeeTimesheetService.replaceDailyEntries' own cross-BU company_id
// comment), and the reminder email only reached ONE Project Manager because
// getPendingServicePOIds/getPendingApprovalSummary were (incorrectly)
// scoped by the reminder-caller's currently-ACTIVE session companyId,
// dropping the pending row logged under the other Business Unit entirely.
// Both functions must see every pending row regardless of which company_id
// it carries — employee_id alone is the real, sufficient boundary, same
// convention as every other Employee-facing aggregate in this file (see
// findForApprovalSummary/findForApprovalSummaryByEmployees's own doc
// comments).
//
// Integration test against the real dev DB (same style as
// employeeWorkLogRepository.findForSync.test.js) — raw Sequelize queries,
// not meaningfully unit-testable via monkey-patching.
const { sequelize, EmployeeWorkLog, Employee, ServicePO, Company } = require('../src/models');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');

const MONTH = 9;
const YEAR = 2032; // distinctive test period, unlikely to collide with real data

let employeeId;
let servicePOAId;
let servicePOBId;
let companyAId;
let companyBId;
const workLogIds = [];

test.before(async () => {
  const employee = await Employee.findOne({ raw: true });
  employeeId = employee.id;

  const servicePOs = await ServicePO.findAll({ limit: 2, raw: true });
  if (servicePOs.length < 2) {
    throw new Error('pendingServicePOs cross-BU test requires at least 2 ServicePO rows in the dev DB.');
  }
  [{ id: servicePOAId }, { id: servicePOBId }] = servicePOs;

  const companies = await Company.findAll({ limit: 2, raw: true });
  if (companies.length < 2) {
    throw new Error('pendingServicePOs cross-BU test requires at least 2 Company rows in the dev DB.');
  }
  [{ id: companyAId }, { id: companyBId }] = companies;
});

test.after(async () => {
  if (workLogIds.length) {
    await EmployeeWorkLog.destroy({ where: { id: workLogIds }, force: true }).catch(() => {});
  }
  await sequelize.close();
});

test('getPendingServicePOIds: returns EVERY pending Service PO regardless of which Business Unit its work log row carries', async () => {
  const workLogA = await EmployeeWorkLog.create({
    company_id: companyAId,
    employee_id: employeeId,
    service_po_id: servicePOAId,
    work_date: `${YEAR}-0${MONTH}-05`,
    hours: 2,
    log_type: 'daily',
    description: 'cross-BU pending regression row — BU-A / PO-A',
    status: 'pending',
  });
  workLogIds.push(workLogA.id);

  const workLogB = await EmployeeWorkLog.create({
    company_id: companyBId,
    employee_id: employeeId,
    service_po_id: servicePOBId,
    work_date: `${YEAR}-0${MONTH}-06`,
    hours: 4,
    log_type: 'daily',
    description: 'cross-BU pending regression row — BU-B / PO-B',
    status: 'pending',
  });
  workLogIds.push(workLogB.id);

  const poIds = await employeeWorkLogRepository.getPendingServicePOIds(employeeId);

  assert.ok(poIds.includes(servicePOAId), 'must include the pending Service PO logged under Business Unit A');
  assert.ok(poIds.includes(servicePOBId), 'must include the pending Service PO logged under Business Unit B, even though it is a different BU');
});

test('getPendingApprovalSummary: counts pending rows across every Business Unit, not just the caller\'s currently-active one', async () => {
  const workLogA = await EmployeeWorkLog.create({
    company_id: companyAId,
    employee_id: employeeId,
    service_po_id: servicePOAId,
    work_date: `${YEAR}-0${MONTH}-15`,
    hours: 1,
    log_type: 'daily',
    description: 'cross-BU pending summary regression row — BU-A',
    status: 'pending',
  });
  workLogIds.push(workLogA.id);

  const workLogB = await EmployeeWorkLog.create({
    company_id: companyBId,
    employee_id: employeeId,
    service_po_id: servicePOBId,
    work_date: `${YEAR}-0${MONTH}-16`,
    hours: 1,
    log_type: 'daily',
    description: 'cross-BU pending summary regression row — BU-B',
    status: 'pending',
  });
  workLogIds.push(workLogB.id);

  // Pass BU-A as the "active session" companyId — a pre-fix regression would
  // have silently dropped the BU-B row from the count.
  const summary = await employeeWorkLogRepository.getPendingApprovalSummary(employeeId, companyAId);

  assert.ok(summary.count >= 2, `expected both cross-BU pending rows to be counted, got count=${summary.count}`);
});
