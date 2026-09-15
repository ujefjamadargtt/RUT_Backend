'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the Centralised PO sync BU-assignment fix, Monthly
// Work Log path — see
// test/employeeTimesheetService.centralisedPOCompanyId.test.js for the
// Daily-path coverage this mirrors, and its header comment for the full
// root-cause explanation. A Centralised PO's OWN company_id (even when it
// carries one) must never anchor the work log's BU; only the logging
// employee's own active session BU may.
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
  employeeWorkLogRepository.deleteByEmployeeAndDateRange = async () => 0;
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    captured.createdRows = rows;
    return rows.map((data, i) => ({ id: i + 1, get: () => ({ id: i + 1, ...data }) }));
  };
  employeeWorkLogRepository.getHierarchyBreakdownForRange = async () => [];
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({ mappedPOs: [], hierarchyRowsByPOId: new Map() });

  return captured;
}

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

test('Test 1 — Centralised PO + Komal mapped to BU-A: Timesheet-bound company_id is BU-A, not the PO\'s own BU', async () => {
  // Centralised PO carries its own company_id (e.g. stamped by whichever
  // BU-scoped actor created it) — must NOT anchor the work log.
  const captured = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  const komalBU = 10; // BU-A

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, komalBU, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 10);
  assert.notEqual(captured.createdRows[0].company_id, 99);
});

test('Test 2 — same Centralised PO, different employee mapped to BU-B: company_id follows BU-B', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  const otherEmployeeBU = 20; // BU-B

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(777, otherEmployeeBU, monthlyPayload());

  assert.equal(captured.createdRows.length, 1);
  assert.equal(captured.createdRows[0].company_id, 20);
});

test('Test 3 — multi-BU employee, same Centralised PO: company_id follows whichever BU the operation is scoped to', async () => {
  const capturedA = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 10, monthlyPayload());
  assert.equal(capturedA.createdRows[0].company_id, 10);

  const capturedB = stubDeps({ mapped: true, poCompanyId: 99, isCentralised: true });
  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 20, monthlyPayload());
  assert.equal(capturedB.createdRows[0].company_id, 20);
});

test('Test 4 — normal (non-centralised) PO: existing behavior unchanged, anchors to the PO\'s own BU', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 30, isCentralised: false });

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 10, monthlyPayload());

  assert.equal(captured.createdRows[0].company_id, 30);
});

test('Test 5 — cross-BU (non-centralised) PO: existing behavior unchanged, anchors to the PO owner\'s BU, not the session', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: 30, isCentralised: false });
  const sessionBU = 10;

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, sessionBU, monthlyPayload());

  assert.equal(captured.createdRows[0].company_id, 30);
  assert.notEqual(captured.createdRows[0].company_id, sessionBU);
});

test('Centralised PO with company_id: null (fully BU-less) still falls back to the session BU (unchanged)', async () => {
  const captured = stubDeps({ mapped: true, poCompanyId: null, isCentralised: true });

  await employeeMonthlyWorkLogService.submitMonthlyWorkLog(501, 10, monthlyPayload());

  assert.equal(captured.createdRows[0].company_id, 10);
});
