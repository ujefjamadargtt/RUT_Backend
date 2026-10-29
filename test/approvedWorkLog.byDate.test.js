'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, AuditLog, Employee, ServicePO } = require('../src/models');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const emailLogService = require('../src/services/emailLogService');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');
const {
  revertApprovedWorkLogsByDateSchema,
  deleteApprovedWorkLogsByDateSchema,
} = require('../src/validations/managerSelfServiceValidation');

/**
 * Day-wise bulk Revert / Delete of approved work logs: several employees x several dates, one shared reason,
 * one e-mail per employee with their own data. Repository, audit and e-mail are stubbed — no DB needed.
 */

const ADMIN_RANK = 1;
const MANAGER_ID = 900;

const ORIGINAL = {
  repo: { ...employeeWorkLogRepository },
  transaction: sequelize.transaction,
  auditCreate: AuditLog.create,
  sendAndLog: emailLogService.sendAndLog,
  employeeFindByPk: Employee.findByPk,
  poFindAll: ServicePO.findAll,
};

function restore() {
  Object.assign(employeeWorkLogRepository, ORIGINAL.repo);
  sequelize.transaction = ORIGINAL.transaction;
  AuditLog.create = ORIGINAL.auditCreate;
  emailLogService.sendAndLog = ORIGINAL.sendAndLog;
  Employee.findByPk = ORIGINAL.employeeFindByPk;
  ServicePO.findAll = ORIGINAL.poFindAll;
}

const PO_NAMES = { 7: 'abc', 8: 'xyz' };

function makeRow(id, employeeId, date, poId, hours, status = 'approved') {
  const data = {
    id, employee_id: employeeId, work_date: date, service_po_id: poId, hours, company_id: 3, status,
    synced_at: null, timesheet_import_id: null,
  };
  return { ...data, get: () => ({ ...data }) };
}

/** In-memory work-log table with a transaction lock queue (like SELECT ... FOR UPDATE). */
function installFakeTable(rows) {
  const state = { rows, audits: [], emails: [], poIdsSeen: [] };
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

  employeeWorkLogRepository.findApprovedByEmployeeAndDatesForUpdate = async (employeeId, dates, poIds) => {
    state.poIdsSeen.push(poIds);
    return state.rows.filter((r) => r.employee_id === employeeId && dates.includes(r.work_date) && r.status === 'approved' && !r.synced_at);
  };
  employeeWorkLogRepository.findTimeEntriesByWorkLogId = async () => [];
  employeeWorkLogRepository.revertApprovedById = async (id) => {
    const index = state.rows.findIndex((r) => r.id === id && r.status === 'approved');
    if (index < 0) return 0;
    state.rows[index] = makeRow(id, state.rows[index].employee_id, state.rows[index].work_date, state.rows[index].service_po_id, state.rows[index].hours, 'pending');
    return 1;
  };
  employeeWorkLogRepository.deleteApprovedById = async (id) => {
    const index = state.rows.findIndex((r) => r.id === id && r.status === 'approved');
    if (index < 0) return 0;
    state.rows.splice(index, 1);
    return 1;
  };
  AuditLog.create = async (row) => { state.audits.push(row); return row; };
  emailLogService.sendAndLog = async (mail) => { state.emails.push(mail); return {}; };
  Employee.findByPk = async (id) => ({ id, full_name: id === MANAGER_ID ? 'Mohan Manager' : `Employee ${id}`, email: `e${id}@example.com` });
  ServicePO.findAll = async ({ where }) => where.id[Object.getOwnPropertySymbols(where.id)[0]].map((id) => ({ id, service_po_name: PO_NAMES[id] }));
  return state;
}

const revertByDate = (body) =>
  managerSelfServiceService.revertApprovedWorkLogsByDate(MANAGER_ID, body, 3, MANAGER_ID, null, ADMIN_RANK, []);
const deleteByDate = (body) =>
  managerSelfServiceService.deleteApprovedWorkLogsByDate(MANAGER_ID, body, 3, MANAGER_ID, null, ADMIN_RANK, []);

function sampleRows() {
  return [
    makeRow(1, 101, '2026-10-10', 7, '12.00'),
    makeRow(2, 101, '2026-10-10', 8, '1.00'),
    makeRow(3, 101, '2026-10-11', 7, '4.00'),
    makeRow(4, 101, '2026-10-12', 7, '2.00'), // a date that is NOT selected
    makeRow(5, 102, '2026-10-10', 8, '6.50'),
    makeRow(6, 101, '2026-10-13', 7, '3.00', 'pending'), // pending: never touched
  ];
}

test('validation: selections, YYYY-MM-DD dates and a reason are required; delete also needs confirm:true', () => {
  const good = { selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-11'] }], reason: ' Wrong entries ' };
  const ok = revertApprovedWorkLogsByDateSchema.validate(good);
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.reason, 'Wrong entries');

  for (const bad of [
    { ...good, reason: '' },
    { ...good, reason: '   ' },
    { selections: good.selections },
    { ...good, selections: [] },
    { ...good, selections: [{ employee_id: 101, dates: [] }] },
    { ...good, selections: [{ employee_id: 101, dates: ['10-10-2026'] }] },
    { ...good, selections: [{ employee_id: 101, dates: ['2026-13-10'] }] },
    { ...good, selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-10'] }] },
    { ...good, selections: [{ employee_id: 'x', dates: ['2026-10-10'] }] },
  ]) {
    assert.ok(revertApprovedWorkLogsByDateSchema.validate(bad).error, `rejected: ${JSON.stringify(bad)}`);
  }

  assert.ok(deleteApprovedWorkLogsByDateSchema.validate(good).error, 'delete without confirm is rejected');
  assert.ok(deleteApprovedWorkLogsByDateSchema.validate({ ...good, confirm: false }).error, 'confirm:false is rejected');
  assert.equal(deleteApprovedWorkLogsByDateSchema.validate({ ...good, confirm: true }).error, undefined);
});

test('bulk revert: every approved log on the chosen dates goes pending, other dates/statuses untouched, one reason everywhere', async () => {
  try {
    const state = installFakeTable(sampleRows());
    const result = await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-11'] }, { employee_id: 102, dates: ['2026-10-10'] }],
      reason: 'Hours need correction',
    });

    assert.equal(result.total_logs_affected, 4);
    assert.equal(result.employees_processed, 2);
    assert.equal(result.employees_failed, 0);
    assert.equal(result.new_status, 'pending');

    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r.status]));
    assert.deepEqual(byId, { 1: 'pending', 2: 'pending', 3: 'pending', 4: 'approved', 5: 'pending', 6: 'pending' });

    assert.equal(state.audits.length, 4, 'one audit row per log');
    assert.ok(state.audits.every((a) => a.action === 'REVERT_APPROVED_LOG' && a.new_values.reason === 'Hours need correction'));
    assert.deepEqual(state.audits.map((a) => a.entity_id).sort(), [1, 2, 3, 5]);
  } finally { restore(); }
});

test('bulk e-mail: ONE e-mail per employee, grouped by date, containing only that employee\'s own logs', async () => {
  try {
    const state = installFakeTable(sampleRows());
    await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-11', '2026-10-10'] }, { employee_id: 102, dates: ['2026-10-10'] }],
      reason: 'Hours need correction',
    });

    assert.equal(state.emails.length, 2);
    const mail101 = state.emails.find((m) => m.to === 'e101@example.com');
    const mail102 = state.emails.find((m) => m.to === 'e102@example.com');

    for (const text of ['Date 10-10-26', 'abc - 12 hrs', 'xyz - 1 hrs', 'Date 11-10-26', 'abc - 4 hrs', 'Hours need correction', 'Mohan Manager', 'Employee 101']) {
      assert.ok(mail101.html.includes(text), `employee 101 e-mail contains "${text}"`);
    }
    assert.ok(mail101.html.indexOf('Date 10-10-26') < mail101.html.indexOf('Date 11-10-26'), 'dates in ascending order');
    assert.ok(!mail101.html.includes('12-10-26'), 'an unselected date is not mentioned');
    assert.ok(!mail101.html.includes('6.5 hrs'), "another employee's logs are not mentioned");

    assert.ok(mail102.html.includes('Date 10-10-26') && mail102.html.includes('xyz - 6.5 hrs'));
    assert.ok(!mail102.html.includes('abc'), "employee 101's logs are not in employee 102's e-mail");
    assert.equal(mail101.mailType, 'WORKLOG_APPROVED_REVERTED');
  } finally { restore(); }
});

test('bulk delete: logs are removed, snapshots + the shared reason are audited, each employee e-mailed once', async () => {
  try {
    const state = installFakeTable(sampleRows());
    const result = await deleteByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-11'] }, { employee_id: 102, dates: ['2026-10-10'] }],
      reason: 'Duplicate timesheet entries',
      confirm: true,
    });

    assert.equal(result.total_logs_affected, 4);
    assert.deepEqual(state.rows.map((r) => r.id).sort(), [4, 6], 'only unselected/non-approved rows remain');
    assert.equal(state.audits.length, 4);
    assert.ok(state.audits.every((a) => a.action === 'DELETE_APPROVED_LOG' && a.new_values.reason === 'Duplicate timesheet entries'));
    assert.ok(state.audits.every((a) => a.old_values.hours && a.old_values.work_date && a.old_values.employee_id), 'original record kept');
    assert.equal(state.emails.length, 2);
    assert.ok(state.emails.every((m) => m.mailType === 'WORKLOG_APPROVED_DELETED' && m.html.includes('Duplicate timesheet entries')));
    assert.match(state.emails[0].subject, /deleted/);
  } finally { restore(); }
});

test('a date with nothing approved is reported as skipped; an employee with nothing at all is nothing_to_do and gets no e-mail', async () => {
  try {
    const state = installFakeTable(sampleRows());
    const result = await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-20'] }, { employee_id: 102, dates: ['2026-10-25'] }],
      reason: 'r',
    });

    const r101 = result.results.find((r) => r.employee_id === 101);
    assert.equal(r101.status, 'done');
    assert.deepEqual(r101.affected_dates, ['2026-10-10']);
    assert.deepEqual(r101.skipped_dates, ['2026-10-20']);

    const r102 = result.results.find((r) => r.employee_id === 102);
    assert.equal(r102.status, 'nothing_to_do');
    assert.equal(r102.email_status, 'not_needed');
    assert.equal(state.emails.length, 1);
  } finally { restore(); }
});

test('one employee failing never blocks the others (your own timesheet is refused with 403)', async () => {
  try {
    const state = installFakeTable(sampleRows());
    state.rows.push(makeRow(9, MANAGER_ID, '2026-10-10', 7, '5.00'));
    const result = await revertByDate({
      selections: [{ employee_id: MANAGER_ID, dates: ['2026-10-10'] }, { employee_id: 101, dates: ['2026-10-10'] }],
      reason: 'r',
    });

    const own = result.results.find((r) => r.employee_id === MANAGER_ID);
    assert.equal(own.status, 'failed');
    assert.equal(own.status_code, 403);
    assert.equal(result.results.find((r) => r.employee_id === 101).status, 'done');
    assert.equal(result.employees_failed, 1);
    assert.equal(state.rows.find((r) => r.id === 9).status, 'approved', "the approver's own log is untouched");
  } finally { restore(); }
});

test('the same employee listed twice is merged into one pass and one e-mail', async () => {
  try {
    const state = installFakeTable(sampleRows());
    const result = await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10'] }, { employee_id: 101, dates: ['2026-10-11'] }],
      reason: 'r',
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.total_logs_affected, 3);
    assert.equal(state.emails.length, 1);
  } finally { restore(); }
});

test('a failed e-mail for one employee does not undo anything or stop the others', async () => {
  try {
    const state = installFakeTable(sampleRows());
    emailLogService.sendAndLog = async (mail) => {
      if (mail.to === 'e101@example.com') throw new Error('mail server down');
      state.emails.push(mail);
      return {};
    };
    const result = await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10'] }, { employee_id: 102, dates: ['2026-10-10'] }],
      reason: 'r',
    });
    assert.equal(result.results.find((r) => r.employee_id === 101).email_status, 'failed');
    assert.equal(result.results.find((r) => r.employee_id === 102).email_status, 'sent');
    assert.equal(state.rows.find((r) => r.id === 1).status, 'pending');
  } finally { restore(); }
});

test('an audit failure rolls back that employee only; the others still complete', async () => {
  try {
    const state = installFakeTable(sampleRows());
    // Fake table has no real rollback, so assert the engine reports failure and never e-mails the failed employee.
    AuditLog.create = async (row) => {
      if (row.entity_id === 5) throw new Error('audit table unavailable');
      state.audits.push(row);
      return row;
    };
    const result = await revertByDate({
      selections: [{ employee_id: 101, dates: ['2026-10-10'] }, { employee_id: 102, dates: ['2026-10-10'] }],
      reason: 'r',
    });
    assert.equal(result.results.find((r) => r.employee_id === 102).status, 'failed');
    assert.equal(result.results.find((r) => r.employee_id === 101).status, 'done');
    assert.equal(state.emails.length, 1);
    assert.equal(state.emails[0].to, 'e101@example.com');
  } finally { restore(); }
});

test('two concurrent bulk requests on the same selection: logs are processed once, one e-mail per employee', async () => {
  try {
    const state = installFakeTable(sampleRows());
    const body = { selections: [{ employee_id: 101, dates: ['2026-10-10', '2026-10-11'] }], reason: 'r' };
    const [a, b] = await Promise.all([revertByDate(body), revertByDate(body)]);

    assert.equal(a.total_logs_affected + b.total_logs_affected, 3, 'each log processed exactly once');
    assert.ok([a, b].some((r) => r.total_logs_affected === 0), 'the loser finds nothing left');
    assert.equal(state.audits.length, 3);
    assert.equal(state.emails.length, 1);
  } finally { restore(); }
});
