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
const employeeMonthlyWorkLogService = require('../src/services/employeeMonthlyWorkLogService');

const ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  findByIdAndServicePOWithParent: servicePOHierarchyRepository.findByIdAndServicePOWithParent,
  employeeFindById: employeeRepository.findById,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  getMonthEntryModeSummary: employeeWorkLogRepository.getMonthEntryModeSummary,
  findAll: employeeWorkLogRepository.findAll,
  deleteByEmployeeAndDate: employeeWorkLogRepository.deleteByEmployeeAndDate,
  deleteByEmployeeAndDateRange: employeeWorkLogRepository.deleteByEmployeeAndDateRange,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
  getDailyHours: employeeWorkLogRepository.getDailyHours,
  teBulkCreate: employeeWorkLogTimeEntryRepository.bulkCreate,
  findByIdForEmployee: employeeWorkLogRepository.findByIdForEmployee,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  update: employeeWorkLogRepository.update,
  teDeleteByWorkLogId: employeeWorkLogTimeEntryRepository.deleteByWorkLogId,
  findById: employeeWorkLogRepository.findById,
};

function restore() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  employeeWorkLogRepository.hasMonthlyEntry = ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.getMonthEntryModeSummary = ORIGINAL.getMonthEntryModeSummary;
  employeeWorkLogRepository.findAll = ORIGINAL.findAll;
  employeeWorkLogRepository.deleteByEmployeeAndDate = ORIGINAL.deleteByEmployeeAndDate;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = ORIGINAL.deleteByEmployeeAndDateRange;
  employeeWorkLogRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ORIGINAL.markApprovedByIds;
  employeeWorkLogRepository.getDailyHours = ORIGINAL.getDailyHours;
  employeeWorkLogTimeEntryRepository.bulkCreate = ORIGINAL.teBulkCreate;
  employeeWorkLogRepository.findByIdForEmployee = ORIGINAL.findByIdForEmployee;
  employeeWorkLogRepository.checkDuplicate = ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.update = ORIGINAL.update;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = ORIGINAL.teDeleteByWorkLogId;
  employeeWorkLogRepository.findById = ORIGINAL.findById;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = ORIGINAL.findByIdAndServicePOWithParent;
}

function stubCommonDeps({ hasMonthly = false, hasTimeBased = false, hasHourly = false } = {}) {
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
  timesheetService.resolveManualEntryReferences = async () => ({ po: { service_po_name: 'PO One' } });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => hasMonthly;
  employeeWorkLogRepository.getMonthEntryModeSummary = async () => ({ hasMonthly, hasTimeBased, hasHourly });
  employeeWorkLogRepository.findAll = async () => ({ rows: [] });
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
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => [];
  return { getRows: () => capturedRows };
}

// ── ISSUE 1 — existing TIME_BASED entry must survive a same-day resend that
// adds a slot for a DIFFERENT Project/Task without resending the first
// entry's own breakdown (the exact reported "converted to Hourly" bug).

test('ISSUE 1 / TEST 9: an existing TIME_BASED entry (task 101) is preserved unchanged when a NEW line is added for a different task (202), even though the resend of task 101 has no time_entries of its own', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findAll = async () => ({
    rows: [
      {
        service_po_id: 378,
        hierarchy_node_id: 101,
        timeEntries: [{ start_time: '09:00', end_time: '10:00', description: 'Work A' }],
      },
    ],
  });

  const { getRows } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      // Task 101 resent WITHOUT time_entries — exactly what a frontend
      // limited to GET /daily's aggregate-hours-only response would send.
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Work A', hours: 1 },
      // A brand-new line for a DIFFERENT task under the same PO.
      { service_po_id: 378, hierarchy_node_id: 202, description: 'Work B', time_entries: [{ start_time: '11:00', end_time: '12:00' }] },
    ],
  });

  assert.equal(getRows().length, 2);
  const task101Row = getRows().find((r) => r.hierarchy_node_id === 101);
  const task202Row = getRows().find((r) => r.hierarchy_node_id === 202);

  // Task 101 must still be TIME_BASED (has resolvedEntries), not silently
  // downgraded to a plain hours-only row.
  assert.equal(task101Row.hours, 1);
  const task101Result = result.find((r) => r.hierarchy_node_id === 101);
  const task202Result = result.find((r) => r.hierarchy_node_id === 202);
  assert.equal(task101Result.time_entries.length, 1, 'task 101 must keep its TIME_BASED breakdown, not become Hourly');
  assert.equal(task101Result.time_entries[0].start_time, '09:00');
  assert.equal(task101Result.time_entries[0].end_time, '10:00');
  assert.equal(task101Result.time_entries[0].description, 'Work A');
  assert.equal(task202Result.time_entries.length, 1);

  restore();
});

test('preserveExistingTimeEntries: a line that DOES supply its own time_entries is never overridden by an existing row', async () => {
  stubCommonDeps();
  employeeWorkLogRepository.findAll = async () => ({
    rows: [{ service_po_id: 378, hierarchy_node_id: 101, timeEntries: [{ start_time: '09:00', end_time: '10:00', description: 'Old' }] }],
  });
  const { getRows } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'New', time_entries: [{ start_time: '13:00', end_time: '14:00' }] },
    ],
  });

  assert.equal(getRows()[0].hours, 1);
  restore();
});

test('preserveExistingTimeEntries: a genuinely NEW hours-only line with no existing row is unaffected (stays Hourly)', async () => {
  stubCommonDeps();
  const { getRows } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [{ service_po_id: 500, hierarchy_node_id: 999, description: 'Fresh hourly', hours: 4 }],
  });

  assert.equal(getRows()[0].hours, 4);
  restore();
});

// ── ISSUE 2 — monthly TIME_BASED/HOURLY/MONTHLY mutual exclusivity, all 6
// directions from the CORE BUSINESS RULE matrix.

test('TEST 4: TIME_BASED exists this month -> attempting HOURLY is rejected, message names the existing mode', async () => {
  stubCommonDeps({ hasTimeBased: true });
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Hourly attempt', hours: 4 }],
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /already have Start\/End Time based/);
      assert.match(err.message, /Hourly timesheet entries cannot be added/);
      return true;
    }
  );
  restore();
});

test('TEST 6: HOURLY exists this month -> attempting TIME_BASED is rejected, message names the existing mode', async () => {
  stubCommonDeps({ hasHourly: true });
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Time attempt', time_entries: [{ start_time: '09:00', end_time: '10:00' }] }],
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /already have Hourly/);
      assert.match(err.message, /Start\/End Time based timesheet entries cannot be added/);
      return true;
    }
  );
  restore();
});

test('TEST 7: MONTHLY exists this month -> attempting TIME_BASED is rejected, message names the existing mode', async () => {
  stubCommonDeps({ hasMonthly: true });
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Time attempt', time_entries: [{ start_time: '09:00', end_time: '10:00' }] }],
    }),
    (err) => {
      assert.match(err.message, /already have Monthly/);
      assert.match(err.message, /Start\/End Time based timesheet entries cannot be added/);
      return true;
    }
  );
  restore();
});

test('MONTHLY exists this month -> attempting HOURLY is rejected, message names the existing mode', async () => {
  stubCommonDeps({ hasMonthly: true });
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Hourly attempt', hours: 4 }],
    }),
    (err) => {
      assert.match(err.message, /already have Monthly/);
      assert.match(err.message, /Hourly timesheet entries cannot be added/);
      return true;
    }
  );
  restore();
});

test('mixing TIME_BASED and HOURLY within the SAME request (no pre-existing data) is rejected', async () => {
  stubCommonDeps();
  captureWrites();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [
        { service_po_id: 378, hierarchy_node_id: 101, description: 'Time', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
        { service_po_id: 400, hierarchy_node_id: 202, description: 'Hours', hours: 2 },
      ],
    }),
    { statusCode: 400 }
  );
  restore();
});

test('TEST 8 / TEST 1-3: TIME_BASED exists this month -> adding another TIME_BASED entry (different PO) is ALLOWED', async () => {
  stubCommonDeps({ hasTimeBased: true });
  const { getRows } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [{ service_po_id: 400, hierarchy_node_id: 303, description: 'Another slot', time_entries: [{ start_time: '14:00', end_time: '15:30' }] }],
  });

  assert.equal(getRows().length, 1);
  assert.equal(result[0].time_entries.length, 1);
  restore();
});

// REVERSED per explicit user direction (2026-08-27, after the mode-mixing
// fix first shipped): Daily entries (TIME_BASED or HOURLY) already existing
// for a month must NOT block submitting a Monthly Work Log for that same
// month — Monthly is allowed to consolidate/replace them, same as
// submitMonthlyWorkLog's pre-existing deleteByEmployeeAndDateRange wipe
// already did before the mode-mixing fix was introduced. Only the REVERSE
// direction (a Monthly log already exists -> Daily creation blocked, via
// assertNoMonthlyLogForDate) is still enforced — see TEST 7 above.

function stubMonthlySubmit() {
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => 0;
  employeeWorkLogRepository.bulkCreate = async (rows) => rows.map((r, i) => ({ id: 700 + i, ...r }));
  employeeWorkLogRepository.getHierarchyBreakdownForRange = async () => [];
  const employeeTimesheetServiceModule = require('../src/services/employeeTimesheetService');
  const originalLoadMapped = employeeTimesheetServiceModule.loadMappedPOsWithHierarchy;
  employeeTimesheetServiceModule.loadMappedPOsWithHierarchy = async () => ({ mappedPOs: [], hierarchyRowsByPOId: new Map() });
  return () => { employeeTimesheetServiceModule.loadMappedPOsWithHierarchy = originalLoadMapped; };
}

test('TIME_BASED exists this month -> submitMonthlyWorkLog (Monthly) is ALLOWED (consolidates/replaces the daily entries)', async () => {
  stubCommonDeps({ hasTimeBased: true });
  const restoreLoadMapped = stubMonthlySubmit();

  let deletedRange = null;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async (employeeId, startDate, endDate) => {
    deletedRange = { employeeId, startDate, endDate };
    return 1;
  };

  const result = await employeeMonthlyWorkLogService.submitMonthlyWorkLog(101, 10, {
    month: 8,
    year: 2020, // safely in the past -> eligible
    entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Monthly consolidation', hours: 100 }],
  });

  assert.ok(result);
  assert.equal(deletedRange.employeeId, 101, 'the existing Daily rows for the month must still be wiped, same as before');

  restoreLoadMapped();
  restore();
});

test('HOURLY exists this month -> submitMonthlyWorkLog (Monthly) is ALLOWED (consolidates/replaces the daily entries)', async () => {
  stubCommonDeps({ hasHourly: true });
  const restoreLoadMapped = stubMonthlySubmit();

  const result = await employeeMonthlyWorkLogService.submitMonthlyWorkLog(101, 10, {
    month: 8,
    year: 2020,
    entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Monthly consolidation', hours: 100 }],
  });

  assert.ok(result);

  restoreLoadMapped();
  restore();
});

test('no conflicting mode exists -> submitMonthlyWorkLog succeeds (re-submitting an existing Monthly log is unaffected)', async () => {
  stubCommonDeps({ hasMonthly: true }); // an existing MONTHLY row must NOT block a new Monthly submission
  const restoreLoadMapped = stubMonthlySubmit();

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(101, 10, {
    month: 8,
    year: 2020,
    entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Resubmit', hours: 100 }],
  });

  restoreLoadMapped();
  restore();
});

// ── updateEntry / addTimeEntries also enforce the same axis, not just
// replaceDailyEntries — closing the loophole those endpoints would
// otherwise leave open.

test('updateEntry: switching a row to HOURLY (empty time_entries) is rejected when TIME_BASED already exists elsewhere in the month', async () => {
  stubCommonDeps({ hasTimeBased: true });
  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 70,
    service_po_id: 378,
    sub_project_id: null,
    hierarchy_node_id: 202,
    work_date: '2026-08-27',
    hours: 1,
    status: 'pending',
    description: 'Existing',
    timeEntries: [{ start_time: '09:00', end_time: '10:00' }],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;

  await assert.rejects(
    () => employeeTimesheetService.updateEntry(101, 10, 70, { time_entries: [], hours: 3 }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /already have Start\/End Time based/);
      return true;
    }
  );
  restore();
});

test('addTimeEntries: rejected when an HOURLY entry already exists elsewhere in the month', async () => {
  stubCommonDeps({ hasHourly: true });
  employeeWorkLogRepository.checkDuplicate = async () => null;

  await assert.rejects(
    () => employeeTimesheetService.addTimeEntries(101, 10, {
      work_date: '2026-08-27',
      service_po_id: 378,
      hierarchy_node_id: 101,
      time_entries: [{ start_time: '09:00', end_time: '10:00' }],
      description: 'New task',
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /already have Hourly/);
      return true;
    }
  );
  restore();
});
