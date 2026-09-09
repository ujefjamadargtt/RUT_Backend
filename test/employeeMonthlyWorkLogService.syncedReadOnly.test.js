'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage: the Monthly Work Log REPLACE-SAVE (submit/delete)
// must refuse to touch a month that already has at least one 'synced' row —
// see employeeMonthlyWorkLogService.js's header doc and
// employeeWorkLogRepository.hasSyncedEntriesInRange.
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeMonthlyWorkLogService = require('../src/services/employeeMonthlyWorkLogService');

const ORIGINAL = {
  hasSyncedEntriesInRange: employeeWorkLogRepository.hasSyncedEntriesInRange,
  deleteByEmployeeAndDateRange: employeeWorkLogRepository.deleteByEmployeeAndDateRange,
};

function restore() {
  employeeWorkLogRepository.hasSyncedEntriesInRange = ORIGINAL.hasSyncedEntriesInRange;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = ORIGINAL.deleteByEmployeeAndDateRange;
}

test('submitMonthlyWorkLog: a month already synced is rejected with 409 before the wipe-and-reinsert runs', async () => {
  employeeWorkLogRepository.hasSyncedEntriesInRange = async () => true;
  let deleted = false;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => { deleted = true; return 0; };

  await assert.rejects(
    () => employeeMonthlyWorkLogService.submitMonthlyWorkLog(101, 10, {
      month: 8,
      year: 2020,
      entries: [{ service_po_id: 378, hierarchy_node_id: 101, description: 'Resubmit attempt', hours: 100 }],
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

test('deleteMonthlyWorkLog: a month already synced is rejected with 409, not deleted', async () => {
  employeeWorkLogRepository.hasSyncedEntriesInRange = async () => true;
  let deleted = false;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => { deleted = true; return 0; };

  await assert.rejects(
    () => employeeMonthlyWorkLogService.deleteMonthlyWorkLog(101, 10, 8, 2020),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already been synced/);
      return true;
    }
  );
  assert.equal(deleted, false);
  restore();
});
