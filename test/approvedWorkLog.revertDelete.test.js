'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, AuditLog, Employee, ServicePO } = require('../src/models');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const emailLogService = require('../src/services/emailLogService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');
const employeeMonthlyWorkLogService = require('../src/services/employeeMonthlyWorkLogService');
const { approvedWorkLogActionSchema } = require('../src/validations/managerSelfServiceValidation');

/**
 * Approver Revert / Delete of an approved work log, and the employee-side lock on approved logs
 * (scope: Employee + Log Date + PO). Repository, audit and e-mail are stubbed — no DB needed.
 */

const ADMIN_RANK = 1; // admin tier: passes assertOwnEmployeeForApproval (self-approval is still blocked)
const MANAGER_ID = 900;
const EMPLOYEE_ID = 101;

const ORIGINAL = {
  repo: { ...employeeWorkLogRepository },
  transaction: sequelize.transaction,
  auditCreate: AuditLog.create,
  sendAndLog: emailLogService.sendAndLog,
  employeeFindByPk: Employee.findByPk,
  poFindByPk: ServicePO.findByPk,
  getPmPoIds: employeeServicePOMappingService.getProjectManagerServicePOIds,
};

function restore() {
  Object.assign(employeeWorkLogRepository, ORIGINAL.repo);
  sequelize.transaction = ORIGINAL.transaction;
  AuditLog.create = ORIGINAL.auditCreate;
  emailLogService.sendAndLog = ORIGINAL.sendAndLog;
  Employee.findByPk = ORIGINAL.employeeFindByPk;
  ServicePO.findByPk = ORIGINAL.poFindByPk;
  employeeServicePOMappingService.getProjectManagerServicePOIds = ORIGINAL.getPmPoIds;
}

function makeRow(overrides = {}) {
  const data = {
    id: 55, employee_id: EMPLOYEE_ID, service_po_id: 7, company_id: 3, work_date: '2026-10-05', hours: '8.00',
    status: 'approved', synced_at: null, timesheet_import_id: null, description: 'work',
    servicePO: { service_po_name: 'Alpha PO' }, ...overrides,
  };
  return { ...data, get: () => ({ ...data }) };
}

/**
 * In-memory stand-in for the one row, with a lock queue like SELECT ... FOR UPDATE: a second transaction waits
 * until the first has finished and then sees its result.
 */
function installFakeRow(initial) {
  const state = { row: initial, calls: [], audits: [], emails: [] };
  let chain = Promise.resolve();

  sequelize.transaction = async (fn) => {
    let release;
    const previous = chain;
    chain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn({ LOCK: { UPDATE: 'UPDATE' } });
    } finally {
      release();
    }
  };

  employeeWorkLogRepository.findById = async () => state.row;
  employeeWorkLogRepository.findByIdForUpdate = async () => state.row;
  employeeWorkLogRepository.findTimeEntriesByWorkLogId = async () => [{ id: 1, start_time: '09:00', end_time: '17:00' }];
  employeeWorkLogRepository.revertApprovedById = async (id, params) => {
    state.calls.push(['revert', id, params]);
    if (!state.row || state.row.status !== 'approved' || state.row.synced_at) return 0;
    state.row = makeRow({ status: 'pending' });
    return 1;
  };
  employeeWorkLogRepository.deleteApprovedById = async (id) => {
    state.calls.push(['delete', id]);
    if (!state.row || state.row.status !== 'approved' || state.row.synced_at) return 0;
    state.row = null;
    return 1;
  };
  AuditLog.create = async (row) => { state.audits.push(row); return row; };
  emailLogService.sendAndLog = async (mail) => { state.emails.push(mail); return {}; };
  Employee.findByPk = async (id) => (id === EMPLOYEE_ID
    ? { id, full_name: 'Asha Employee', email: 'asha@example.com' }
    : { id, full_name: 'Mohan Manager' });
  return state;
}

const revert = (reason = 'Incorrect hours submitted') =>
  managerSelfServiceService.revertApprovedWorkLog(MANAGER_ID, 55, reason, 3, MANAGER_ID, '1.1.1.1', ADMIN_RANK, []);
const remove = (reason = 'Duplicate timesheet entry') =>
  managerSelfServiceService.deleteApprovedWorkLog(MANAGER_ID, 55, reason, 3, MANAGER_ID, '1.1.1.1', ADMIN_RANK, []);

test('1 + 12 + 13: reverting an approved, unsynced log -> pending, audited with the reason, employee e-mailed', async () => {
  try {
    const state = installFakeRow(makeRow());
    const result = await revert();

    assert.equal(result.new_status, 'pending');
    assert.equal(result.previous_status, 'approved');
    assert.equal(result.email_status, 'sent');
    assert.deepEqual(state.calls[0], ['revert', 55, { reason: 'Incorrect hours submitted', revertedBy: MANAGER_ID }]);

    assert.equal(state.audits.length, 1);
    const audit = state.audits[0];
    assert.equal(audit.action, 'REVERT_APPROVED_LOG');
    assert.equal(audit.entity_id, 55);
    assert.equal(audit.user_id, MANAGER_ID);
    assert.equal(audit.old_values.status, 'approved');
    assert.equal(audit.new_values.new_status, 'pending');
    assert.equal(audit.new_values.previous_status, 'approved');
    assert.equal(audit.new_values.reason, 'Incorrect hours submitted');
    assert.equal(audit.new_values.employee_id, EMPLOYEE_ID);
    assert.equal(audit.new_values.log_date, '2026-10-05');
    assert.equal(audit.new_values.po_id, 7);

    assert.equal(state.emails.length, 1);
    const mail = state.emails[0];
    assert.equal(mail.to, 'asha@example.com');
    assert.equal(mail.mailType, 'WORKLOG_APPROVED_REVERTED');
    for (const text of ['Asha Employee', 'Date 05-10-26', 'Alpha PO - 8 hrs', 'Approved', 'Pending', 'Incorrect hours submitted', 'Mohan Manager']) {
      assert.ok(mail.html.includes(text), `revert e-mail contains "${text}"`);
    }
  } finally { restore(); }
});

test('2 + 12 + 13: deleting an approved, unsynced log -> removed, full snapshot + reason audited, employee e-mailed', async () => {
  try {
    const state = installFakeRow(makeRow());
    const result = await remove();

    assert.equal(result.new_status, 'deleted');
    assert.equal(state.row, null, 'the active record is gone');
    assert.equal(result.deleted_log.hours, '8.00');

    const audit = state.audits[0];
    assert.equal(audit.action, 'DELETE_APPROVED_LOG');
    // original record preserved
    assert.equal(audit.old_values.employee_id, EMPLOYEE_ID);
    assert.equal(audit.old_values.work_date, '2026-10-05');
    assert.equal(audit.old_values.service_po_id, 7);
    assert.equal(audit.old_values.hours, '8.00');
    assert.equal(audit.old_values.status, 'approved');
    assert.equal(audit.old_values.time_entries.length, 1);
    // delete details preserved
    assert.equal(audit.new_values.reason, 'Duplicate timesheet entry');
    assert.equal(audit.new_values.action_by, MANAGER_ID);
    assert.equal(audit.new_values.new_status, 'deleted');
    assert.ok(audit.new_values.action_at);

    const mail = state.emails[0];
    assert.equal(mail.mailType, 'WORKLOG_APPROVED_DELETED');
    for (const text of ['Deleted', 'Approved', 'Duplicate timesheet entry', 'Delete reason', 'Mohan Manager', 'Date 05-10-26', 'Alpha PO - 8 hrs']) {
      assert.ok(mail.html.includes(text), `delete e-mail contains "${text}"`);
    }
  } finally { restore(); }
});

test('3: a missing, empty or blank reason is rejected by validation', () => {
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }, { reason: 5 }]) {
    const { error } = approvedWorkLogActionSchema.validate(body);
    assert.ok(error, `rejected: ${JSON.stringify(body)}`);
  }
  const ok = approvedWorkLogActionSchema.validate({ reason: '  Wrong PO ' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.reason, 'Wrong PO');
  assert.ok(approvedWorkLogActionSchema.validate({ reason: 'x'.repeat(1001) }).error);
});

test('4: callers who may not approve this employee get 403 and nothing changes', async () => {
  try {
    const state = installFakeRow(makeRow());

    // a manager can never act on their own timesheet
    await assert.rejects(
      () => managerSelfServiceService.revertApprovedWorkLog(EMPLOYEE_ID, 55, 'r', 3, EMPLOYEE_ID, null, ADMIN_RANK, []),
      (err) => err.statusCode === 403
    );

    // a Project Manager mapped to no Service PO
    employeeServicePOMappingService.getProjectManagerServicePOIds = async () => [];
    await assert.rejects(
      () => managerSelfServiceService.deleteApprovedWorkLog(MANAGER_ID, 55, 'r', 3, MANAGER_ID, null, 6, []),
      (err) => err.statusCode === 403
    );

    // a Project Manager mapped to a different PO only
    employeeServicePOMappingService.getProjectManagerServicePOIds = async () => [99];
    await assert.rejects(
      () => managerSelfServiceService.revertApprovedWorkLog(MANAGER_ID, 55, 'r', 3, MANAGER_ID, null, 6, []),
      (err) => err.statusCode === 403
    );

    assert.equal(state.calls.length, 0);
    assert.equal(state.audits.length, 0);
    assert.equal(state.emails.length, 0);
    assert.equal(state.row.status, 'approved');
  } finally { restore(); }
});

test('5: pending / rejected logs can be neither reverted nor deleted (409); unknown id is 404', async () => {
  try {
    for (const status of ['pending', 'rejected']) {
      const state = installFakeRow(makeRow({ status }));
      await assert.rejects(revert, (err) => err.statusCode === 409 && /approved/.test(err.message));
      await assert.rejects(remove, (err) => err.statusCode === 409 && /approved/.test(err.message));
      assert.equal(state.calls.length, 0);
      assert.equal(state.audits.length, 0);
      assert.equal(state.emails.length, 0);
    }
    installFakeRow(null);
    await assert.rejects(revert, (err) => err.statusCode === 404);
  } finally { restore(); }
});

test('6: synced logs can be neither reverted nor deleted (409), even when status still reads approved', async () => {
  try {
    for (const row of [
      makeRow({ status: 'synced', synced_at: new Date(), timesheet_import_id: 4 }),
      makeRow({ status: 'approved', synced_at: new Date() }),
    ]) {
      const state = installFakeRow(row);
      await assert.rejects(revert, (err) => err.statusCode === 409 && /synced/.test(err.message));
      await assert.rejects(remove, (err) => err.statusCode === 409 && /synced/.test(err.message));
      assert.equal(state.calls.length, 0);
    }
  } finally { restore(); }
});

test('6b: a Sync that lands between the first check and the row lock is caught by the re-check inside the transaction', async () => {
  try {
    const state = installFakeRow(makeRow());
    // first read (outside the transaction) still sees approved; by the time the lock is granted it is synced
    employeeWorkLogRepository.findByIdForUpdate = async () => makeRow({ status: 'synced', synced_at: new Date(), timesheet_import_id: 4 });
    await assert.rejects(remove, (err) => err.statusCode === 409 && /synced/.test(err.message));
    assert.equal(state.calls.length, 0, 'nothing was deleted');
    assert.equal(state.audits.length, 0);
    assert.equal(state.emails.length, 0);
  } finally { restore(); }
});

test('14: two concurrent requests -> exactly one succeeds, the other gets 409; one audit row, one e-mail', async () => {
  try {
    for (const op of [revert, remove]) {
      const state = installFakeRow(makeRow());
      const results = await Promise.allSettled([op(), op()]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].reason.statusCode, 409);
      assert.equal(state.audits.length, 1);
      assert.equal(state.emails.length, 1);
    }
  } finally { restore(); }
});

test('a failed e-mail never undoes the action: still succeeds, email_status failed, audit kept', async () => {
  try {
    const state = installFakeRow(makeRow());
    emailLogService.sendAndLog = async () => { throw new Error('mail server down'); };
    const result = await revert();
    assert.equal(result.new_status, 'pending');
    assert.equal(result.email_status, 'failed');
    assert.equal(state.row.status, 'pending');
    assert.equal(state.audits.length, 1);
  } finally { restore(); }
});

test('an employee without an e-mail address: action succeeds, email_status no_email', async () => {
  try {
    const state = installFakeRow(makeRow());
    Employee.findByPk = async (id) => ({ id, full_name: 'No Mail', email: null });
    const result = await remove();
    assert.equal(result.email_status, 'no_email');
    assert.equal(state.emails.length, 0);
    assert.equal(state.row, null);
  } finally { restore(); }
});

test('an audit failure rolls the whole action back (it is written inside the transaction, throwOnError)', async () => {
  try {
    const state = installFakeRow(makeRow());
    AuditLog.create = async () => { throw new Error('audit table unavailable'); };
    await assert.rejects(revert, /audit table unavailable/);
    assert.equal(state.emails.length, 0, 'no e-mail for an action that failed');
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------------------
// Employee-side restrictions
// ---------------------------------------------------------------------------------------------------------

test('7: an employee cannot update or delete an approved log', async () => {
  try {
    employeeWorkLogRepository.findByIdForEmployee = async () => ({ id: 70, status: 'approved', service_po_id: 7, work_date: '2026-10-05' });
    let touched = false;
    employeeWorkLogRepository.update = async () => { touched = true; };
    employeeWorkLogRepository.deleteById = async () => { touched = true; };

    await assert.rejects(
      () => employeeTimesheetService.updateEntry(EMPLOYEE_ID, 3, 70, { hours: 2 }),
      (err) => err.statusCode === 409 && err.message === 'This timesheet log is approved and cannot be edited.'
    );
    await assert.rejects(
      () => employeeTimesheetService.deleteEntry(EMPLOYEE_ID, 3, 70),
      (err) => err.statusCode === 409 && /approved/.test(err.message)
    );
    assert.equal(touched, false);
  } finally { restore(); }
});

test('8 + 9: the approved-log lock is per PO — the approved PO is refused, other POs on the same date are allowed', async () => {
  try {
    let query;
    employeeWorkLogRepository.findApprovedInRange = async (employeeId, start, end, options) => {
      query = { employeeId, start, end, options };
      // XYZ (id 8) is approved; ABC (id 7) is approved; PQR (id 9) has none
      const approved = [{ id: 1, service_po_id: 7, work_date: '2026-10-05', hours: '4' }, { id: 2, service_po_id: 8, work_date: '2026-10-05', hours: '2' }];
      return approved.filter((row) => !options.servicePOIds || options.servicePOIds.includes(row.service_po_id));
    };

    await assert.rejects(
      () => employeeTimesheetService.assertNoApprovedLogForPOs(EMPLOYEE_ID, '2026-10-05', '2026-10-05', [7]),
      (err) => err.statusCode === 409 && /approved timesheet log already exists for Service PO #7/.test(err.message)
    );
    await assert.rejects(() => employeeTimesheetService.assertNoApprovedLogForPOs(EMPLOYEE_ID, '2026-10-05', '2026-10-05', [8]), /Service PO #8/);
    await assert.rejects(() => employeeTimesheetService.assertNoApprovedLogForPOs(EMPLOYEE_ID, '2026-10-05', '2026-10-05', [9, 7]), /Service PO #7/);
    await employeeTimesheetService.assertNoApprovedLogForPOs(EMPLOYEE_ID, '2026-10-05', '2026-10-05', [9]);
    await employeeTimesheetService.assertNoApprovedLogForPOs(EMPLOYEE_ID, '2026-10-05', '2026-10-05', []);
    assert.deepEqual(query.options.servicePOIds, [9], 'only the POs being written to are looked up');
  } finally { restore(); }
});

test('8: replaceDailyEntries refuses a line for a PO that already has an approved log that day, before any wipe', async () => {
  try {
    employeeWorkLogRepository.hasSyncedEntriesInRange = async () => false;
    employeeWorkLogRepository.findApprovedInRange = async () => [{ id: 1, service_po_id: 7, work_date: '2026-10-05', hours: '4' }];
    let wiped = false;
    employeeWorkLogRepository.deleteByEmployeeAndDate = async () => { wiped = true; };

    await assert.rejects(
      () => employeeTimesheetService.replaceDailyEntries(EMPLOYEE_ID, 3, {
        timesheet_date: '2026-10-05',
        entries: [{ service_po_id: 7, hours: 2, description: 'more' }, { service_po_id: 9, hours: 1, description: 'other' }],
      }),
      (err) => err.statusCode === 409 && /Service PO #7/.test(err.message)
    );
    assert.equal(wiped, false);
  } finally { restore(); }
});

test('8: addTimeEntries refuses another log against an approved PO on that date', async () => {
  try {
    const { employeeServicePOMappingRepository } = { employeeServicePOMappingRepository: require('../src/repositories/employeeServicePOMappingRepository') };
    const original = employeeServicePOMappingRepository.findByEmployeeAndPO;
    employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
    try {
      employeeWorkLogRepository.findApprovedInRange = async () => [{ id: 1, service_po_id: 7, work_date: '2026-10-05', hours: '4' }];
      await assert.rejects(
        () => employeeTimesheetService.addTimeEntries(EMPLOYEE_ID, 3, {
          work_date: '2026-10-05', service_po_id: 7, time_entries: [{ start_time: '09:00', end_time: '10:00' }],
        }),
        (err) => err.statusCode === 409 && /approved timesheet log already exists/.test(err.message)
      );
    } finally {
      employeeServicePOMappingRepository.findByEmployeeAndPO = original;
    }
  } finally { restore(); }
});

test('employee monthly delete is refused while the month holds an approved log; an approver delete is not', async () => {
  try {
    employeeWorkLogRepository.hasSyncedEntriesInRange = async () => false;
    employeeWorkLogRepository.findApprovedInRange = async () => [{ id: 1, service_po_id: 7, work_date: '2026-09-30', hours: '8' }];
    let deleted = 0;
    employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => { deleted += 1; };

    await assert.rejects(
      () => employeeMonthlyWorkLogService.deleteMonthlyWorkLog(EMPLOYEE_ID, 3, 9, 2026),
      (err) => err.statusCode === 409 && /approved/.test(err.message)
    );
    assert.equal(deleted, 0);

    await employeeMonthlyWorkLogService.deleteMonthlyWorkLog(EMPLOYEE_ID, 3, 9, 2026, { byApprover: true });
    assert.equal(deleted, 1);
  } finally { restore(); }
});

test('employee monthly submit: refuses a PO that already has an approved log in the month, and never wipes approved rows', async () => {
  try {
    employeeWorkLogRepository.hasSyncedEntriesInRange = async () => false;
    employeeWorkLogRepository.findApprovedInRange = async () => [{ id: 1, service_po_id: 7, work_date: '2026-09-12', hours: '8' }];
    await assert.rejects(
      () => employeeMonthlyWorkLogService.submitMonthlyWorkLog(EMPLOYEE_ID, 3, {
        month: 9, year: 2026, entries: [{ service_po_id: 7, hours: 100, description: 'x' }],
      }),
      (err) => err.statusCode === 409 && /Service PO #7/.test(err.message)
    );
  } finally { restore(); }
});

test('the replace-save wipes pass keepApproved so an approved row can never be deleted by an employee save', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/employeeTimesheetService.js'), 'utf8');
  assert.match(src, /deleteByEmployeeAndDate\(employeeId, dateStr, companyId, transaction, true\)/);
  const monthly = require('fs').readFileSync(require.resolve('../src/services/employeeMonthlyWorkLogService.js'), 'utf8');
  assert.match(monthly, /scopeServicePOIds, !forceApproved\)/);
});
