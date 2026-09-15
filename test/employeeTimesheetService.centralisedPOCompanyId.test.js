'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the Centralised PO sync BU-assignment fix: for a
// Centralised Service PO (is_centralised: true), the work log's `company_id`
// must ALWAYS be the logging employee's own active session BU, never the
// PO's own `company_id` — even when that PO happens to carry a specific,
// non-null `company_id` of its own (a BU-scoped actor's own BU gets stamped
// on a Centralised PO at creation time, see servicePOService.create; see
// also the memory note "centralised-po-scope-nuance"). Before this fix,
// `company_id: po.company_id ?? companyId` treated such a PO exactly like a
// normal/cross-BU PO, so "Sync Employee Work Logs" silently assigned the
// resulting Timesheet to the PO's creator's BU instead of the actual logging
// employee's BU.
//
// Normal/cross-BU PO behavior (is_centralised: false or absent) is NOT
// touched by this fix — see employeeTimesheetService.crossBuCompanyId.test.js,
// which continues to pass unmodified since `po.is_centralised` is undefined
// there.
//
// Same monkey-patch style as employeeTimesheetService.crossBuCompanyId.test.js.
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
 * @param {{ mapped?: boolean, poCompanyId?: number|null, isCentralised?: boolean }} opts
 * @returns {{ createdRows: object[] }} captures whatever bulkCreate() received
 */
function stubDeps({ mapped = true, poCompanyId = null, isCentralised = false } = {}) {
  const captured = { createdRows: null };

  employeeServicePOMappingRepository.findByEmployeeAndPO = async () =>
    mapped ? { status: 'active' } : null;
  timesheetService.resolveManualEntryReferences = async () => ({
    po: { service_po_name: 'Centralised PO', company_id: poCompanyId, is_centralised: isCentralised },
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

// ─────────────────────────────────────────────────────────────────────────
// replaceDailyEntries()
// ─────────────────────────────────────────────────────────────────────────

test('Centralised PO (Komal -> BU-A): company_id is the employee/session BU, not the PO creator BU', async () => {
  // Centralised PO created by a BU-scoped actor under BU-B (99) — has its
  // own specific company_id, is_centralised: true.
  const captured = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  const komalSessionBU = 10; // BU-A

  await employeeTimesheetService.replaceDailyEntries(501, komalSessionBU, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10, 'Timesheet BU must be the employee\'s own BU (BU-A)');
  assert.notEqual(captured.createdRows[0].company_id, 99, 'must NOT fall back to the Centralised PO\'s own BU');
});

test('Same Centralised PO, different employee mapped to BU-B: company_id follows that employee\'s BU', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  const otherEmployeeSessionBU = 20; // BU-B

  await employeeTimesheetService.replaceDailyEntries(777, otherEmployeeSessionBU, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 20);
});

test('Centralised PO with company_id: null (fully BU-less) still falls back to the session BU (unchanged)', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: null, isCentralised: true });

  await employeeTimesheetService.replaceDailyEntries(501, 10, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
});

test('Normal (non-centralised) PO behavior is unchanged: company_id still anchors to the PO\'s own owning BU', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 30, isCentralised: false });
  const sessionBU = 10;

  await employeeTimesheetService.replaceDailyEntries(501, sessionBU, dailyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 30, 'normal PO must still anchor to its own BU, not the session BU');
});

// ─────────────────────────────────────────────────────────────────────────
// updateEntry() — same Centralised PO matrix, single-row edit path.
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

function stubUpdateDeps({ mapped = true, poCompanyId = null, isCentralised = false } = {}) {
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
    po: { service_po_name: 'Centralised PO', company_id: poCompanyId, is_centralised: isCentralised },
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

test('updateEntry: Centralised PO with its own BU -> company_id is the session/employee BU, not the PO\'s BU', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: 99, isCentralised: true });

  await employeeTimesheetService.updateEntry(501, 10, 42, updatePayload());

  assert.equal(captured.updateData.company_id, 10);
  assert.notEqual(captured.updateData.company_id, 99);
});

test('updateEntry: normal PO behavior unchanged', async () => {
  const captured = stubUpdateDeps({ mapped: true, poCompanyId: 30, isCentralised: false });

  await employeeTimesheetService.updateEntry(501, 10, 42, updatePayload());

  assert.equal(captured.updateData.company_id, 30);
});

// ─────────────────────────────────────────────────────────────────────────
// addTimeEntries() — same Centralised PO matrix, additive Time Entry path.
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

function stubAddTimeEntriesDeps({ mapped = true, poCompanyId = null, isCentralised = false } = {}) {
  const captured = { createdRows: null };

  employeeServicePOMappingRepository.findByEmployeeAndPO = async () =>
    mapped ? { status: 'active' } : null;
  timesheetService.resolveManualEntryReferences = async () => ({
    po: { service_po_name: 'Centralised PO', company_id: poCompanyId, is_centralised: isCentralised },
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

test('addTimeEntries: Centralised PO with its own BU -> company_id is the session/employee BU, not the PO\'s BU', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: 99, isCentralised: true });

  await employeeTimesheetService.addTimeEntries(501, 10, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
  assert.notEqual(captured.createdRows[0].company_id, 99);
});

test('addTimeEntries: normal PO behavior unchanged', async () => {
  const captured = stubAddTimeEntriesDeps({ mapped: true, poCompanyId: 30, isCentralised: false });

  await employeeTimesheetService.addTimeEntries(501, 10, addTimeEntriesPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 30);
});
