'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeWorkLogTimeEntryRepository = require('../src/repositories/employeeWorkLogTimeEntryRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');
const { replaceDailyEntriesSchema } = require('../src/validations/employeeTimesheetValidation');

const ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  findByIdAndServicePOWithParent: servicePOHierarchyRepository.findByIdAndServicePOWithParent,
  employeeFindById: employeeRepository.findById,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  deleteByEmployeeAndDate: employeeWorkLogRepository.deleteByEmployeeAndDate,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
  getDailyHours: employeeWorkLogRepository.getDailyHours,
  teBulkCreate: employeeWorkLogTimeEntryRepository.bulkCreate,
};

function restore() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  employeeWorkLogRepository.hasMonthlyEntry = ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.deleteByEmployeeAndDate = ORIGINAL.deleteByEmployeeAndDate;
  employeeWorkLogRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ORIGINAL.markApprovedByIds;
  employeeWorkLogRepository.getDailyHours = ORIGINAL.getDailyHours;
  employeeWorkLogTimeEntryRepository.bulkCreate = ORIGINAL.teBulkCreate;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = ORIGINAL.findByIdAndServicePOWithParent;
}

function stubCommonDeps() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
  timesheetService.resolveManualEntryReferences = async () => ({ po: { service_po_name: 'PO One' } });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogRepository.getDailyHours = async () => 0;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = async (id) => (id ? { id, node_name: `Node ${id}`, node_type: 'PARENT' } : null);
}

function captureWrites() {
  let capturedRows;
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => 0;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    capturedRows = rows;
    return rows.map((r, i) => ({ id: 900 + i, get: () => ({ id: 900 + i, ...r }) }));
  };
  const capturedTimeEntriesByWorkLog = new Map();
  employeeWorkLogTimeEntryRepository.bulkCreate = async (workLogId, entries) => {
    capturedTimeEntriesByWorkLog.set(workLogId, entries);
    return [];
  };
  return { getRows: () => capturedRows, getTimeEntries: (id) => capturedTimeEntriesByWorkLog.get(id) };
}

// ── The user's exact reported payload — description on each LINE, not on
// the nested time_entries themselves. Must pass Joi AND the service layer,
// with each segment ending up with the description of the line it came from.

test('the exact reported payload (PO 378 / node 104, two lines, description on each line not nested) is accepted end-to-end', async () => {
  const { error, value } = replaceDailyEntriesSchema.validate({
    timesheet_date: '2026-08-03',
    entries: [
      { service_po_id: '378', hierarchy_node_id: '104', description: 'AA', time_entries: [{ start_time: '00:00', end_time: '02:00' }] },
      { service_po_id: '378', hierarchy_node_id: '104', description: 'BB', time_entries: [{ start_time: '02:00', end_time: '03:00' }] },
    ],
  });
  assert.equal(error, undefined, error && error.message);

  stubCommonDeps();
  const { getRows, getTimeEntries } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: value.timesheet_date,
    entries: value.entries,
  });

  assert.equal(getRows().length, 1, 'both lines merge into ONE employee_work_logs row for the same PO+node+date');
  const entries = getTimeEntries(900);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.description), ['AA', 'BB']);
  assert.equal(result[0].time_entries.length, 2);
  assert.equal(result[0].hours, 3); // 2h + 1h
  restore();
});

// ── TEST 1 — same PO+task+date, two non-overlapping slots, both accepted.

test('TEST 1: same PO + task + date, 09:00-10:00 and 11:00-12:00, both accepted (no duplicate error)', async () => {
  stubCommonDeps();
  const { getRows, getTimeEntries } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 1', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 2', time_entries: [{ start_time: '11:00', end_time: '12:00' }] },
    ],
  });

  assert.equal(getRows().length, 1);
  assert.equal(getTimeEntries(900).length, 2);
  assert.equal(result[0].hours, 2);
  restore();
});

// ── TEST 2 — the exact same slot submitted twice for the same PO+task+date
// is handled by the EXISTING conflict rule (overlap), not silently allowed
// and not a bespoke new "identical slot" error.

test('TEST 2: the exact same slot (09:00-10:00) submitted twice is rejected by the existing overlap rule', async () => {
  stubCommonDeps();
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [
        { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 1', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
        { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 1 again', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
      ],
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /overlap/i);
      return true;
    }
  );
  restore();
});

// ── TEST 3 — back-to-back-ish but non-overlapping slots on the same PO+task.

test('TEST 3: same PO + task, 09:00-10:00 and 10:30-11:30, both accepted', async () => {
  stubCommonDeps();
  const { getRows, getTimeEntries } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 1', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 2', time_entries: [{ start_time: '10:30', end_time: '11:30' }] },
    ],
  });

  assert.equal(getRows().length, 1);
  assert.equal(getTimeEntries(900).length, 2);
  restore();
});

// ── TEST 5 — three slots, all saved.

test('TEST 5: three slots (09:00-10:00, 11:00-12:00, 14:00-15:30) all saved under one row', async () => {
  stubCommonDeps();
  const { getRows, getTimeEntries } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 1', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 2', time_entries: [{ start_time: '11:00', end_time: '12:00' }] },
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Slot 3', time_entries: [{ start_time: '14:00', end_time: '15:30' }] },
    ],
  });

  assert.equal(getRows().length, 1);
  assert.equal(getTimeEntries(900).length, 3);
  assert.equal(result[0].hours, 3.5);
  restore();
});

// ── TEST 6 — distinct descriptions stay associated with their own slot,
// never merged into one combined description.

test('TEST 6: each slot keeps its own description, never merged', async () => {
  stubCommonDeps();
  const { getTimeEntries } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Description A', time_entries: [{ start_time: '09:00', end_time: '10:00', description: 'Description A' }] },
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Description B', time_entries: [{ start_time: '11:00', end_time: '12:00', description: 'Description B' }] },
    ],
  });

  const entries = getTimeEntries(900);
  assert.deepEqual(entries.map((e) => e.description), ['Description A', 'Description B']);
  restore();
});

// ── A plain hours-only line repeated for the same PO+node is STILL rejected
// as a duplicate — the loosened rule must not regress this pre-existing
// behavior (this is the "existing duplicate validation" the spec says must
// be preserved for non-time-based entries).

test('a plain hours-only line repeated for the same PO+node is still rejected as a duplicate (pre-existing rule preserved)', async () => {
  stubCommonDeps();
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [
        { service_po_id: 378, hierarchy_node_id: 101, description: 'A', hours: 2 },
        { service_po_id: 378, hierarchy_node_id: 101, description: 'B', hours: 3 },
      ],
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Duplicate entry for Service PO #378/);
      return true;
    }
  );
  restore();
});

// ── Mixing a time-based line and an hours-only line under the SAME key is
// still rejected — merging only ever applies when EVERY line under the key
// is time-based.

test('mixing a time-based line and an hours-only line under the same PO+node key is still rejected as a duplicate', async () => {
  stubCommonDeps();
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [
        { service_po_id: 378, hierarchy_node_id: 101, description: 'A', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
        { service_po_id: 378, hierarchy_node_id: 101, description: 'B', hours: 3 },
      ],
    }),
    { statusCode: 400 }
  );
  restore();
});

// ── Different hierarchy nodes under the same PO are unaffected — never
// accidentally merged together.

test('two time-based lines for the SAME PO but DIFFERENT hierarchy nodes are never merged (separate rows)', async () => {
  stubCommonDeps();
  const { getRows } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Node 101', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
      { service_po_id: 378, hierarchy_node_id: 102, description: 'Node 102', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
    ],
  });

  assert.equal(getRows().length, 2);
  restore();
});
