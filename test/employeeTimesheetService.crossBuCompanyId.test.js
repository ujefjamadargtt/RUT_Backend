'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the cross-BU work-log company_id fix: a work log's
// `company_id` must be anchored to the SELECTED SERVICE PO's own owning BU,
// not the caller's currently-active session BU (X-Company-Id) — see
// employeeTimesheetService.replaceDailyEntries/updateEntry/addTimeEntries and
// employeeMonthlyWorkLogService.submitMonthlyWorkLog. Without this, an
// employee mapped to multiple BUs who logs against a PO owned by a
// DIFFERENT BU than the one currently selected got that log silently
// mis-attributed to the active session's BU instead — invisible to
// "Sync Employee Work Logs" for the PO's actual owning BU.
//
// Same monkey-patch style as test/employeeTimesheetService.timeEntries.test.js —
// employeeTimesheetService.js holds live references to these SAME
// module-cached repository objects.
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeWorkLogTimeEntryRepository = require('../src/repositories/employeeWorkLogTimeEntryRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

const ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  employeeFindById: employeeRepository.findById,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  findAll: employeeWorkLogRepository.findAll,
  deleteByEmployeeAndDate: employeeWorkLogRepository.deleteByEmployeeAndDate,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
};

function restore() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  employeeWorkLogRepository.hasMonthlyEntry = ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.findAll = ORIGINAL.findAll;
  employeeWorkLogRepository.deleteByEmployeeAndDate = ORIGINAL.deleteByEmployeeAndDate;
  employeeWorkLogRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ORIGINAL.markApprovedByIds;
}

/**
 * Wires up every dependency replaceDailyEntries() touches other than the
 * one thing each test varies: whether the employee is mapped to the PO, and
 * what company_id resolveManualEntryReferences() resolves the PO to.
 * @param {{ mapped?: boolean, poCompanyId?: number|null }} opts
 * @returns {{ createdRows: object[] }} captures whatever bulkCreate() received
 */
function stubDeps({ mapped = true, poCompanyId = null } = {}) {
  const captured = { createdRows: null };

  employeeServicePOMappingRepository.findByEmployeeAndPO = async () =>
    mapped ? { status: 'active' } : null;
  timesheetService.resolveManualEntryReferences = async () => ({
    po: { service_po_name: 'Cross-BU PO', company_id: poCompanyId },
  });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.findAll = async () => ({ rows: [], count: 0 });
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => 0;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    captured.createdRows = rows;
    return rows.map((data, i) => ({ id: i + 1, get: () => ({ id: i + 1, ...data }) }));
  };

  return captured;
}

function dailyPayload() {
  return {
    timesheet_date: '2026-01-15',
    entries: [
      { service_po_id: 999, hours: 4, description: 'work' },
    ],
  };
}

test.after(() => restore());

test('same-BU case: employee mapped to one BU, PO belongs to that BU -> company_id is that BU (unchanged behavior)', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 10 });

  await employeeTimesheetService.replaceDailyEntries(501, 10, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
});

test('cross-BU case: employee mapped to BU-A and BU-B, PO belongs to BU-A, active session is BU-B -> company_id is BU-A (the PO owner), not BU-B', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 10 }); // PO -> BU-A (10)
  const activeSessionCompanyId = 20; // acting as BU-B

  await employeeTimesheetService.replaceDailyEntries(501, activeSessionCompanyId, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('cross-BU case (symmetric): PO belongs to BU-B, active session is BU-A -> company_id is BU-B (the PO owner), not BU-A', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 20 }); // PO -> BU-B (20)
  const activeSessionCompanyId = 10; // acting as BU-A

  await employeeTimesheetService.replaceDailyEntries(501, activeSessionCompanyId, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 20);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('BU-less/Centralised PO (company_id: null) falls back to the active session BU, preserving prior behavior', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: null });
  const activeSessionCompanyId = 10;

  await employeeTimesheetService.replaceDailyEntries(501, activeSessionCompanyId, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('unauthorized case: employee has no active mapping to the selected PO -> rejected with 403, never reaches the insert', async () => {
  const captured = stubDeps({ mapped: false, poCompanyId: 20 });

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(501, 10, dailyPayload()),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /not assigned to you/);
      return true;
    }
  );

  assert.equal(captured.createdRows, null);
});

// ─────────────────────────────────────────────────────────────────────────
// updateEntry() — same cross-BU company_id matrix, single-row edit path.
// ─────────────────────────────────────────────────────────────────────────

const UPDATE_ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  findByIdForEmployee: employeeWorkLogRepository.findByIdForEmployee,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  getMonthEntryModeSummary: employeeWorkLogRepository.getMonthEntryModeSummary,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  getDailyHours: employeeWorkLogRepository.getDailyHours,
  update: employeeWorkLogRepository.update,
  deleteByWorkLogId: employeeWorkLogTimeEntryRepository.deleteByWorkLogId,
};

function restoreUpdate() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = UPDATE_ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = UPDATE_ORIGINAL.resolveManualEntryReferences;
  employeeWorkLogRepository.findByIdForEmployee = UPDATE_ORIGINAL.findByIdForEmployee;
  employeeWorkLogRepository.hasMonthlyEntry = UPDATE_ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.getMonthEntryModeSummary = UPDATE_ORIGINAL.getMonthEntryModeSummary;
  employeeWorkLogRepository.checkDuplicate = UPDATE_ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.getDailyHours = UPDATE_ORIGINAL.getDailyHours;
  employeeWorkLogRepository.update = UPDATE_ORIGINAL.update;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = UPDATE_ORIGINAL.deleteByWorkLogId;
}

/**
 * Wires up every dependency updateEntry() touches other than the one thing
 * each test varies: whether the employee is mapped to the (possibly new)
 * PO, and what company_id resolveManualEntryReferences() resolves it to.
 * @param {{ mapped?: boolean, poCompanyId?: number|null }} opts
 * @returns {{ updateData: object }} captures whatever update() received
 */
function stubUpdateDeps({ mapped = true, poCompanyId = null } = {}) {
  const captured = { updateData: null };

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 42,
    employee_id: 501,
    service_po_id: 111,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2025-01-15',
    hours: 2,
    description: 'old',
    status: 'pending',
    timeEntries: [],
  });
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () =>
    mapped ? { status: 'active' } : null;
  timesheetService.resolveManualEntryReferences = async () => ({
    po: { service_po_name: 'Cross-BU PO', company_id: poCompanyId },
  });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.getMonthEntryModeSummary = async () => ({ hasTimeBased: false, hasHourly: false });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogRepository.getDailyHours = async () => 0;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async () => {};
  employeeWorkLogRepository.update = async (id, data) => {
    captured.updateData = data;
    return { get: () => ({ id, ...data }) };
  };

  return captured;
}

function updatePayload() {
  return { service_po_id: 999, hours: 4, description: 'updated' };
}

test.after(() => restoreUpdate());

test('updateEntry same-BU case: PO belongs to the active session BU -> company_id is that BU (unchanged behavior)', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: 10 });

  await employeeTimesheetService.updateEntry(501, 10, 42, updatePayload());

  assert.equal(captured.updateData.company_id, 10);
});

test('updateEntry cross-BU case: PO belongs to BU-A, active session is BU-B -> company_id is BU-A (the PO owner), not BU-B', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: 10 });
  const activeSessionCompanyId = 20;

  await employeeTimesheetService.updateEntry(501, activeSessionCompanyId, 42, updatePayload());

  assert.equal(captured.updateData.company_id, 10);
  assert.notEqual(captured.updateData.company_id, activeSessionCompanyId);
});

test('updateEntry cross-BU case (symmetric): PO belongs to BU-B, active session is BU-A -> company_id is BU-B (the PO owner), not BU-A', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: 20 });
  const activeSessionCompanyId = 10;

  await employeeTimesheetService.updateEntry(501, activeSessionCompanyId, 42, updatePayload());

  assert.equal(captured.updateData.company_id, 20);
  assert.notEqual(captured.updateData.company_id, activeSessionCompanyId);
});

test('updateEntry BU-less/Centralised PO (company_id: null) falls back to the active session BU, preserving prior behavior', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: null });
  const activeSessionCompanyId = 10;

  await employeeTimesheetService.updateEntry(501, activeSessionCompanyId, 42, updatePayload());

  assert.equal(captured.updateData.company_id, activeSessionCompanyId);
});

test('updateEntry unauthorized case: employee has no active mapping to the (new) selected PO -> rejected with 403, never reaches the update', async () => {
  const captured = stubUpdateDeps({ mapped: false, poCompanyId: 20 });

  await assert.rejects(
    () => employeeTimesheetService.updateEntry(501, 10, 42, updatePayload()),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /not assigned to you/);
      return true;
    }
  );

  assert.equal(captured.updateData, null);
});

// ─────────────────────────────────────────────────────────────────────────
// addTimeEntries() — same cross-BU company_id matrix, additive Time Entry path.
// ─────────────────────────────────────────────────────────────────────────

const ADD_ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  employeeFindById: employeeRepository.findById,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  getMonthEntryModeSummary: employeeWorkLogRepository.getMonthEntryModeSummary,
  getDailyHours: employeeWorkLogRepository.getDailyHours,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
  timeEntryBulkCreate: employeeWorkLogTimeEntryRepository.bulkCreate,
};

function restoreAddTimeEntries() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ADD_ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ADD_ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ADD_ORIGINAL.employeeFindById;
  employeeWorkLogRepository.hasMonthlyEntry = ADD_ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.checkDuplicate = ADD_ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.getMonthEntryModeSummary = ADD_ORIGINAL.getMonthEntryModeSummary;
  employeeWorkLogRepository.getDailyHours = ADD_ORIGINAL.getDailyHours;
  employeeWorkLogRepository.bulkCreate = ADD_ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ADD_ORIGINAL.markApprovedByIds;
  employeeWorkLogTimeEntryRepository.bulkCreate = ADD_ORIGINAL.timeEntryBulkCreate;
}

/**
 * Wires up every dependency addTimeEntries() touches other than the one
 * thing each test varies: whether the employee is mapped to the PO, and
 * what company_id resolveManualEntryReferences() resolves it to. No
 * existing row for this (employee, PO, node, date) — always the CREATE branch.
 * @param {{ mapped?: boolean, poCompanyId?: number|null }} opts
 * @returns {{ createdRows: object[] }} captures whatever bulkCreate() received
 */
function stubAddTimeEntriesDeps({ mapped = true, poCompanyId = null } = {}) {
  const captured = { createdRows: null };

  employeeServicePOMappingRepository.findByEmployeeAndPO = async () =>
    mapped ? { status: 'active' } : null;
  timesheetService.resolveManualEntryReferences = async () => ({
    po: { service_po_name: 'Cross-BU PO', company_id: poCompanyId },
  });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.checkDuplicate = async () => null; // no existing row -> always CREATE
  employeeWorkLogRepository.getMonthEntryModeSummary = async () => ({ hasTimeBased: false, hasHourly: false });
  employeeWorkLogRepository.getDailyHours = async () => 0;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => [];
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    captured.createdRows = rows;
    return rows.map((data, i) => ({ id: i + 1, ...data }));
  };

  return captured;
}

function addTimeEntriesPayload() {
  return {
    work_date: '2025-01-15',
    service_po_id: 999,
    time_entries: [{ start_time: '09:00', end_time: '10:00' }],
    description: 'work',
  };
}

test.after(() => restoreAddTimeEntries());

test('addTimeEntries same-BU case: PO belongs to the active session BU -> company_id is that BU (unchanged behavior)', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: 10 });

  await employeeTimesheetService.addTimeEntries(501, 10, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
});

test('addTimeEntries cross-BU case: PO belongs to BU-A, active session is BU-B -> company_id is BU-A (the PO owner), not BU-B', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: 10 });
  const activeSessionCompanyId = 20;

  await employeeTimesheetService.addTimeEntries(501, activeSessionCompanyId, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('addTimeEntries cross-BU case (symmetric): PO belongs to BU-B, active session is BU-A -> company_id is BU-B (the PO owner), not BU-A', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: 20 });
  const activeSessionCompanyId = 10;

  await employeeTimesheetService.addTimeEntries(501, activeSessionCompanyId, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 20);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('addTimeEntries BU-less/Centralised PO (company_id: null) falls back to the active session BU, preserving prior behavior', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: null });
  const activeSessionCompanyId = 10;

  await employeeTimesheetService.addTimeEntries(501, activeSessionCompanyId, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('addTimeEntries unauthorized case: employee has no active mapping to the selected PO -> rejected with 403, never reaches the insert', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: false, poCompanyId: 20 });

  await assert.rejects(
    () => employeeTimesheetService.addTimeEntries(501, 10, addTimeEntriesPayload()),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /not assigned to you/);
      return true;
    }
  );

  assert.equal(captured.createdRows, null);
});
