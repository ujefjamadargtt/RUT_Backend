'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/servicePOHierarchyService.deleteGuard.test.js —
// employeeTimesheetService.js holds live references to these SAME
// module-cached repository objects (it does `const x = require(...)` then
// calls `x.someFn(...)`, never destructures at import time), so mutating a
// property here is visible to the service's own calls.
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeWorkLogTimeEntryRepository = require('../src/repositories/employeeWorkLogTimeEntryRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

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
  findByIdForEmployee: employeeWorkLogRepository.findByIdForEmployee,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  update: employeeWorkLogRepository.update,
  teBulkCreate: employeeWorkLogTimeEntryRepository.bulkCreate,
  teDeleteByWorkLogId: employeeWorkLogTimeEntryRepository.deleteByWorkLogId,
  findById: employeeWorkLogRepository.findById,
  resubmitById: employeeWorkLogRepository.resubmitById,
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
  employeeWorkLogRepository.findByIdForEmployee = ORIGINAL.findByIdForEmployee;
  employeeWorkLogRepository.checkDuplicate = ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.update = ORIGINAL.update;
  employeeWorkLogRepository.findById = ORIGINAL.findById;
  employeeWorkLogRepository.resubmitById = ORIGINAL.resubmitById;
  employeeWorkLogTimeEntryRepository.bulkCreate = ORIGINAL.teBulkCreate;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = ORIGINAL.teDeleteByWorkLogId;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = ORIGINAL.findByIdAndServicePOWithParent;
}

/**
 * A tiny in-memory stand-in for `employee_work_logs` +
 * `employee_work_log_time_entries`, wired into the repository functions
 * addTimeEntries() actually calls — lets a test exercise MULTIPLE sequential
 * addTimeEntries() calls and see each one's effect on what the previous call
 * already persisted, which a purely stateless per-call mock can't do.
 */
function installFakeWorkLogStore() {
  const workLogs = new Map(); // id -> row
  const timeEntriesByWorkLog = new Map(); // workLogId -> [{start_time, end_time}]
  let nextId = 1;

  employeeWorkLogRepository.checkDuplicate = async (employeeId, servicePOId, hierarchyNodeId, date) => {
    for (const row of workLogs.values()) {
      if (row.service_po_id === servicePOId && (row.hierarchy_node_id || null) === (hierarchyNodeId || null) && row.work_date === date) {
        return row;
      }
    }
    return null;
  };
  employeeWorkLogRepository.findById = async (id) => {
    const row = workLogs.get(id);
    if (!row) return null;
    return { ...row, timeEntries: timeEntriesByWorkLog.get(id) || [] };
  };
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    return rows.map((data) => {
      const id = nextId++;
      const row = { id, ...data };
      workLogs.set(id, row);
      timeEntriesByWorkLog.set(id, []);
      return { id, get: () => ({ id, ...data }) };
    });
  };
  employeeWorkLogRepository.update = async (id, data) => {
    const row = { ...workLogs.get(id), ...data };
    workLogs.set(id, row);
    return { get: () => row };
  };
  employeeWorkLogRepository.getDailyHours = async (date, employeeId, excludeId) => {
    let total = 0;
    for (const row of workLogs.values()) {
      if (row.work_date === date && row.id !== excludeId) total += parseFloat(row.hours);
    }
    return total;
  };
  employeeWorkLogTimeEntryRepository.bulkCreate = async (workLogId, entries) => {
    const existing = timeEntriesByWorkLog.get(workLogId) || [];
    timeEntriesByWorkLog.set(workLogId, [...existing, ...entries]);
    return entries;
  };

  return { workLogs, timeEntriesByWorkLog };
}

function stubCommonDeps() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
  timesheetService.resolveManualEntryReferences = async () => ({ po: { service_po_name: 'PO One' } });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = async (id) => (id ? { id, node_name: `Node ${id}`, node_type: 'PARENT' } : null);
}

test('replaceDailyEntries: a line with time_entries stores the SUMMED duration as hours, ignoring any hours field, and persists each segment', async () => {
  stubCommonDeps();

  let capturedWorkLogRow;
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => 0;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    capturedWorkLogRow = rows[0];
    return rows.map((r, i) => ({ id: 900 + i, get: () => ({ id: 900 + i, ...r }) }));
  };

  let capturedTimeEntries;
  employeeWorkLogTimeEntryRepository.bulkCreate = async (workLogId, entries) => {
    capturedTimeEntries = { workLogId, entries };
    return [];
  };

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-01',
    entries: [
      {
        service_po_id: 401,
        hierarchy_node_id: null,
        description: 'Module A work',
        // Ticket example: 09:30-10:20 (50 min) + 14:00-15:00 (60 min) = 1.83h
        time_entries: [
          { start_time: '09:30', end_time: '10:20' },
          { start_time: '14:00', end_time: '15:00' },
        ],
        hours: 999, // must be ignored — hours is always derived from time_entries
      },
    ],
  });

  assert.equal(capturedWorkLogRow.hours, 1.83);
  assert.equal(capturedTimeEntries.workLogId, 900);
  assert.equal(capturedTimeEntries.entries.length, 2);
  assert.equal(capturedTimeEntries.entries[0].duration_hours, 0.83);
  assert.equal(capturedTimeEntries.entries[1].duration_hours, 1);
  assert.equal(result[0].time_entries.length, 2);

  restore();
});

test('replaceDailyEntries: overlapping time_entries on the same line are rejected with a 400', async () => {
  stubCommonDeps();

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-01',
      entries: [
        {
          service_po_id: 401,
          description: 'Overlapping',
          time_entries: [
            { start_time: '09:00', end_time: '10:00' },
            { start_time: '09:30', end_time: '11:00' },
          ],
        },
      ],
    }),
    { statusCode: 400 }
  );

  restore();
});

test('replaceDailyEntries: a plain hours-only line (no time_entries) behaves exactly as before', async () => {
  stubCommonDeps();

  let capturedWorkLogRow;
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => 0;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    capturedWorkLogRow = rows[0];
    return rows.map((r, i) => ({ id: 900 + i, get: () => ({ id: 900 + i, ...r }) }));
  };
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => {
    throw new Error('should not be called for an hours-only line');
  };

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-01',
    entries: [
      { service_po_id: 401, description: 'Plain hours entry', hours: 4 },
    ],
  });

  assert.equal(capturedWorkLogRow.hours, 4);
  assert.deepEqual(result[0].time_entries, []);

  restore();
});

test('updateEntry: supplying a new time_entries array replaces the breakdown and recalculates hours, discarding any hours field', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 55,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-01',
    hours: 4,
    status: 'pending',
    description: 'old',
    timeEntries: [],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedUpdatePayload;
  employeeWorkLogRepository.update = async (id, data) => {
    capturedUpdatePayload = data;
    return { get: () => ({ id, ...data }) };
  };

  let deletedWorkLogId = null;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async (workLogId) => {
    deletedWorkLogId = workLogId;
    return 0;
  };
  let capturedTimeEntries;
  employeeWorkLogTimeEntryRepository.bulkCreate = async (workLogId, entries) => {
    capturedTimeEntries = entries;
    return [];
  };

  const result = await employeeTimesheetService.updateEntry(101, 10, 55, {
    time_entries: [{ start_time: '09:00', end_time: '11:00' }],
    hours: 999, // must be ignored
  });

  assert.equal(deletedWorkLogId, 55);
  assert.equal(capturedUpdatePayload.hours, 2);
  assert.equal(capturedTimeEntries.length, 1);
  assert.equal(result.time_entries.length, 1);

  restore();
});

test('updateEntry: omitting time_entries entirely keeps the existing breakdown and its hours untouched', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 56,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-01',
    hours: 1.83,
    status: 'pending',
    description: 'Module A work',
    timeEntries: [
      { start_time: '09:30', end_time: '10:20' },
      { start_time: '14:00', end_time: '15:00' },
    ],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedUpdatePayload;
  employeeWorkLogRepository.update = async (id, data) => {
    capturedUpdatePayload = data;
    return { get: () => ({ id, ...data }) };
  };
  let capturedTimeEntries;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async () => 2;
  employeeWorkLogTimeEntryRepository.bulkCreate = async (workLogId, entries) => {
    capturedTimeEntries = entries;
    return [];
  };

  await employeeTimesheetService.updateEntry(101, 10, 56, { description: 'Module A work, edited' });

  // Hours stays the same combined total (1.83) since the effective time
  // entries are unchanged from what the row already had.
  assert.equal(capturedUpdatePayload.hours, 1.83);
  assert.equal(capturedTimeEntries.length, 2);

  restore();
});

test('updateEntry: an explicit empty time_entries array clears the breakdown and falls back to a plain hours value', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 57,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-01',
    hours: 1.83,
    status: 'pending',
    description: 'Module A work',
    timeEntries: [{ start_time: '09:30', end_time: '10:20' }],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedUpdatePayload;
  employeeWorkLogRepository.update = async (id, data) => {
    capturedUpdatePayload = data;
    return { get: () => ({ id, ...data }) };
  };
  let bulkCreateCalled = false;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async () => 1;
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => {
    bulkCreateCalled = true;
    return [];
  };

  await employeeTimesheetService.updateEntry(101, 10, 57, { time_entries: [], hours: 3 });

  assert.equal(capturedUpdatePayload.hours, 3);
  assert.equal(bulkCreateCalled, false);

  restore();
});

// ── addTimeEntries: the dedicated Time Entry form — must never override ────
// Exactly the user-reported scenario: Module M1 logged once, Task T1 logged
// once, then a LATER, separate call adds more segments to T1 — M1 must stay
// untouched and T1's earlier segment must not be lost/replaced.

test('addTimeEntries: logging M1 then T1 then adding MORE segments to T1 later never disturbs M1 or T1\'s earlier segment', async () => {
  stubCommonDeps();
  const store = installFakeWorkLogStore();

  // 1) Log Module M1: 01:00-02:00 (1h).
  const m1 = await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 91, // M1
    time_entries: [{ start_time: '01:00', end_time: '02:00' }],
    description: 'Module M1',
  });
  assert.equal(m1.hours, 1);

  // 2) Log Task T1: 03:00-04:00 (1h) — a DIFFERENT module/task, same date.
  const t1First = await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 92, // T1
    time_entries: [{ start_time: '03:00', end_time: '04:00' }],
    description: 'Task T1',
  });
  assert.equal(t1First.hours, 1);

  // 3) LATER, separate call: add ANOTHER segment to T1: 04:00-06:00 (2h).
  // Must not require resending T1's first segment, and must not touch M1.
  const t1Second = await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 92, // T1
    time_entries: [{ start_time: '04:00', end_time: '06:00' }],
  });

  // T1 now totals 1h + 2h = 3h, and BOTH segments are present — the first
  // one was never deleted or overridden by the second call.
  assert.equal(t1Second.hours, 3);
  assert.equal(t1Second.time_entries.length, 2);
  assert.deepEqual(
    t1Second.time_entries.map((e) => `${e.start_time}-${e.end_time}`),
    ['03:00-04:00', '04:00-06:00']
  );

  // M1's own row is completely untouched by everything that happened to T1.
  const m1Row = store.workLogs.get(m1.id);
  assert.equal(m1Row.hours, 1);
  assert.equal(store.timeEntriesByWorkLog.get(m1.id).length, 1);

  // Only two work log rows exist total — M1 and T1, never a third.
  assert.equal(store.workLogs.size, 2);

  restore();
});

test('addTimeEntries: a new segment overlapping one already saved by an earlier call is rejected', async () => {
  stubCommonDeps();
  installFakeWorkLogStore();

  await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 92,
    time_entries: [{ start_time: '03:00', end_time: '04:00' }],
    description: 'Task T1',
  });

  await assert.rejects(
    () => employeeTimesheetService.addTimeEntries(101, 10, {
      work_date: '2026-08-01',
      service_po_id: 401,
      hierarchy_node_id: 92,
      time_entries: [{ start_time: '03:30', end_time: '05:00' }], // overlaps 03:00-04:00
    }),
    { statusCode: 400 }
  );

  restore();
});

test('addTimeEntries: description is fully optional, including on the FIRST call for a Module/Task — defaults to blank, never rejected', async () => {
  stubCommonDeps();
  installFakeWorkLogStore();

  const first = await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 92,
    time_entries: [{ start_time: '03:00', end_time: '04:00' }],
    // no description at all — must succeed, defaulting to blank
  });
  assert.equal(first.description, '');

  // Second call on the SAME entry: still no description needed, and the
  // blank description from the first call is preserved (omitting means
  // "don't change", same as every other field here).
  const second = await employeeTimesheetService.addTimeEntries(101, 10, {
    work_date: '2026-08-01',
    service_po_id: 401,
    hierarchy_node_id: 92,
    time_entries: [{ start_time: '04:00', end_time: '05:00' }],
  });
  assert.equal(second.description, '');
  assert.equal(second.hours, 2);

  restore();
});

// ── resubmitEntry: a rejected work log's original entry type (plain hours,
// or TIME_BASED via its `timeEntries` breakdown) must be preserved through
// Reject -> Resubmit — resubmit only flips status, it must never touch
// hours/time_entries itself (those are only ever changed via updateEntry,
// tested above), so a TIME_BASED row's hours stays exactly what its time
// entries computed, never a stray caller-supplied value.

test('resubmitEntry: a rejected TIME_BASED entry resubmits with hours still the one derived from its time entries', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 61,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-10',
    hours: 0.83, // 09:30-10:20, the authoritative sum of its own time_entries
    status: 'rejected',
    description: 'Module A work',
    timeEntries: [{ start_time: '09:30', end_time: '10:20' }],
  });
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedResubmitId;
  employeeWorkLogRepository.resubmitById = async (id) => {
    capturedResubmitId = id;
    return { id, status: 'pending', hours: 0.83, timeEntries: [{ start_time: '09:30', end_time: '10:20' }] };
  };

  const result = await employeeTimesheetService.resubmitEntry(101, 10, 61);

  assert.equal(capturedResubmitId, 61);
  assert.equal(result.status, 'pending');
  // Never converted to hours-only: the time_entries breakdown survives
  // resubmit untouched, and hours still matches it (0.83, not some other
  // value) — resubmit never recalculates or overwrites either.
  assert.equal(result.hours, 0.83);
  assert.equal(result.timeEntries.length, 1);
  assert.deepEqual(result.timeEntries[0], { start_time: '09:30', end_time: '10:20' });

  restore();
});

test('resubmitEntry: editing Start/End Time on a rejected TIME_BASED entry BEFORE resubmit recalculates hours from the new times, never a manually supplied value', async () => {
  stubCommonDeps();

  // Step 1: employee edits the rejected entry's End Time via updateEntry
  // (09:30-10:20, 0.83h -> 09:30-11:00, 1.5h) — mirrors the real flow of
  // "Edit -> Save Changes -> still REJECTED -> Resubmit".
  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 62,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-10',
    hours: 0.83,
    status: 'rejected',
    description: 'Module A work',
    timeEntries: [{ start_time: '09:30', end_time: '10:20' }],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedUpdatePayload;
  employeeWorkLogRepository.update = async (id, data) => {
    capturedUpdatePayload = data;
    return { get: () => ({ id, ...data }) };
  };
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async () => 1;
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => [];

  const edited = await employeeTimesheetService.updateEntry(101, 10, 62, {
    time_entries: [{ start_time: '09:30', end_time: '11:00' }],
    hours: 5, // must be ignored — recalculated from the new times instead
  });

  assert.equal(capturedUpdatePayload.hours, 1.5);
  // Editing a REJECTED row leaves it 'rejected' — Resubmit stays a separate,
  // deliberate step (see updateEntry's own doc comment).
  assert.equal(capturedUpdatePayload.status, 'rejected');
  assert.equal(edited.time_entries[0].end_time, '11:00');

  // Step 2: resubmit — must use the freshly-recalculated 1.5h, not the
  // original 0.83h and not the manually-supplied 5.
  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 62,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-10',
    hours: 1.5,
    status: 'rejected',
    description: 'Module A work',
    timeEntries: [{ start_time: '09:30', end_time: '11:00' }],
  });

  employeeWorkLogRepository.getDailyHours = async () => 0;
  employeeWorkLogRepository.resubmitById = async (id) => ({
    id, status: 'pending', hours: 1.5, timeEntries: [{ start_time: '09:30', end_time: '11:00' }],
  });

  const result = await employeeTimesheetService.resubmitEntry(101, 10, 62);

  assert.equal(result.hours, 1.5);
  assert.notEqual(result.hours, 5);
  assert.notEqual(result.hours, 0.83);

  restore();
});

test('resubmitEntry: only a rejected entry can be resubmitted', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 63,
    service_po_id: 401,
    hierarchy_node_id: null,
    work_date: '2026-08-10',
    hours: 5,
    status: 'pending',
    description: 'Hours-wise entry',
    timeEntries: [],
  });

  await assert.rejects(
    () => employeeTimesheetService.resubmitEntry(101, 10, 63),
    { statusCode: 409 }
  );

  restore();
});

test('resubmitEntry: a plain HOURS_WISE rejected entry resubmits unchanged (no time_entries involved)', async () => {
  stubCommonDeps();

  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 64,
    service_po_id: 401,
    sub_project_id: null,
    hierarchy_node_id: null,
    work_date: '2026-08-10',
    hours: 5,
    status: 'rejected',
    description: 'Hours-wise entry',
    timeEntries: [],
  });
  employeeWorkLogRepository.getDailyHours = async () => 0;

  let capturedResubmitId;
  employeeWorkLogRepository.resubmitById = async (id) => {
    capturedResubmitId = id;
    return { id, status: 'pending', hours: 5, timeEntries: [] };
  };

  const result = await employeeTimesheetService.resubmitEntry(101, 10, 64);

  assert.equal(capturedResubmitId, 64);
  assert.equal(result.status, 'pending');
  assert.equal(result.hours, 5);
  assert.deepEqual(result.timeEntries, []);

  restore();
});
