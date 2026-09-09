'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage: once an employee_work_logs row has been synced to the
// official Timesheet (status: 'synced'), it must become fully read-only —
// no edit, no append, no delete, and no whole-date replace-save may silently
// discard it. See EmployeeWorkLog.js's status doc comment ("Synced rows are
// read-only") and employeeWorkLogRepository.hasSyncedEntriesInRange.
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

const ORIGINAL = {
  findByIdForEmployee: employeeWorkLogRepository.findByIdForEmployee,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  findById: employeeWorkLogRepository.findById,
  hasSyncedEntriesInRange: employeeWorkLogRepository.hasSyncedEntriesInRange,
  deleteById: employeeWorkLogRepository.deleteById,
  deleteByEmployeeAndDate: employeeWorkLogRepository.deleteByEmployeeAndDate,
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
};

function restore() {
  employeeWorkLogRepository.findByIdForEmployee = ORIGINAL.findByIdForEmployee;
  employeeWorkLogRepository.checkDuplicate = ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.findById = ORIGINAL.findById;
  employeeWorkLogRepository.hasSyncedEntriesInRange = ORIGINAL.hasSyncedEntriesInRange;
  employeeWorkLogRepository.deleteById = ORIGINAL.deleteById;
  employeeWorkLogRepository.deleteByEmployeeAndDate = ORIGINAL.deleteByEmployeeAndDate;
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
}

test('updateEntry: a synced entry is rejected with 409 before any other validation runs', async () => {
  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 70,
    status: 'synced',
    service_po_id: 378,
    work_date: '2026-08-27',
    hours: 4,
    description: 'Existing',
    timeEntries: [],
  });

  await assert.rejects(
    () => employeeTimesheetService.updateEntry(101, 10, 70, { hours: 5 }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already been synced/);
      return true;
    }
  );
  restore();
});

test('deleteEntry: a synced entry is rejected with 409, not deleted', async () => {
  employeeWorkLogRepository.findByIdForEmployee = async () => ({ id: 70, status: 'synced' });
  let deleted = false;
  employeeWorkLogRepository.deleteById = async () => { deleted = true; };

  await assert.rejects(
    () => employeeTimesheetService.deleteEntry(101, 10, 70),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already been synced/);
      return true;
    }
  );
  assert.equal(deleted, false);
  restore();
});

test('addTimeEntries: appending to an existing synced entry is rejected with 409', async () => {
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
  timesheetService.resolveManualEntryReferences = async () => ({ po: { service_po_name: 'PO One' } });
  employeeWorkLogRepository.checkDuplicate = async () => ({ id: 70 });
  employeeWorkLogRepository.findById = async () => ({ id: 70, status: 'synced', timeEntries: [] });

  await assert.rejects(
    () => employeeTimesheetService.addTimeEntries(101, 10, {
      work_date: '2026-08-27',
      service_po_id: 378,
      hierarchy_node_id: 101,
      time_entries: [{ start_time: '09:00', end_time: '10:00' }],
      description: 'More work',
    }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already been synced/);
      return true;
    }
  );
  restore();
});

test('replaceDailyEntries: a date already synced is rejected with 409 before the wipe-and-reinsert runs', async () => {
  employeeWorkLogRepository.hasSyncedEntriesInRange = async () => true;
  let deleted = false;
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => { deleted = true; return 0; };

  await assert.rejects(
    () => employeeTimesheetService.replaceDailyEntries(101, 10, {
      timesheet_date: '2026-08-27',
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Edit attempt', hours: 4 }],
    }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already been synced/);
      return true;
    }
  );
  assert.equal(deleted, false);
  restore();
});
