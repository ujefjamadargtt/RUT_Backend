'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the cross-BU work-log company_id fix, Monthly Work
// Log path — see test/employeeTimesheetService.crossBuCompanyId.test.js for
// the Daily-path coverage this mirrors. A Monthly submission's `company_id`
// must be anchored to the SELECTED SERVICE PO's own owning BU, not the
// caller's currently-active session BU (X-Company-Id) — see
// employeeMonthlyWorkLogService.submitMonthlyWorkLog.
//
// Same monkey-patch style as the Daily test: employeeMonthlyWorkLogService.js
// calls employeeTimesheetService.assertProjectMapped/loadMappedPOsWithHierarchy
// via the live module-cached `employeeTimesheetService` object, so patching
// the lower-level repository functions those internally rely on exercises
// the real assertProjectMapped logic rather than bypassing it.
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');
const employeeMonthlyWorkLogService = require('../src/services/employeeMonthlyWorkLogService');

const ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  employeeFindById: employeeRepository.findById,
  deleteByEmployeeAndDateRange: employeeWorkLogRepository.deleteByEmployeeAndDateRange,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
  getHierarchyBreakdownForRange: employeeWorkLogRepository.getHierarchyBreakdownForRange,
  loadMappedPOsWithHierarchy: employeeTimesheetService.loadMappedPOsWithHierarchy,
};

function restore() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = ORIGINAL.deleteByEmployeeAndDateRange;
  employeeWorkLogRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ORIGINAL.markApprovedByIds;
  employeeWorkLogRepository.getHierarchyBreakdownForRange = ORIGINAL.getHierarchyBreakdownForRange;
  employeeTimesheetService.loadMappedPOsWithHierarchy = ORIGINAL.loadMappedPOsWithHierarchy;
}

/**
 * Wires up every dependency submitMonthlyWorkLog() touches other than the
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
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => 0;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    captured.createdRows = rows;
    return rows.map((data, i) => ({ id: i + 1, get: () => ({ id: i + 1, ...data }) }));
  };
  // Only exercised by submitMonthlyWorkLog's trailing buildMonthlyWorkLogDTO
  // call (the response shape) — not the write path itself, so a bare no-op
  // return is enough here.
  employeeWorkLogRepository.getHierarchyBreakdownForRange = async () => [];
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({ mappedPOs: [], hierarchyRowsByPOId: new Map() });

  return captured;
}

// A month solidly in the past regardless of when this test runs, so
// dateHelper.isMonthlyLogEligible never blocks the submission.
function monthlyPayload() {
  return {
    month: 1,
    year: 2025,
    entries: [
      { service_po_id: 999, hours: 4, description: 'work' },
    ],
  };
}

test.after(() => restore());

test('same-BU case: employee mapped to one BU, PO belongs to that BU -> company_id is that BU (unchanged behavior)', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 10 });

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 10, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
});

test('cross-BU case: employee mapped to BU-A and BU-B, PO belongs to BU-A, active session is BU-B -> company_id is BU-A (the PO owner), not BU-B', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 10 }); // PO -> BU-A (10)
  const activeSessionCompanyId = 20; // acting as BU-B

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, activeSessionCompanyId, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('cross-BU case (symmetric): PO belongs to BU-B, active session is BU-A -> company_id is BU-B (the PO owner), not BU-A', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 20 }); // PO -> BU-B (20)
  const activeSessionCompanyId = 10; // acting as BU-A

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, activeSessionCompanyId, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 20);
  assert.notEqual(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('BU-less/Centralised PO (company_id: null) falls back to the active session BU, preserving prior behavior', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: null });
  const activeSessionCompanyId = 10;

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, activeSessionCompanyId, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, activeSessionCompanyId);
});

test('unauthorized case: employee has no active mapping to the selected PO -> rejected with 403, never reaches the insert', async () => {
  const captured = stubDeps({ mapped: false, poCompanyId: 20 });

  await assert.rejects(
    () => employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 10, monthlyPayload()),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /not assigned to you/);
      return true;
    }
  );

  assert.equal(captured.createdRows, null);
});
