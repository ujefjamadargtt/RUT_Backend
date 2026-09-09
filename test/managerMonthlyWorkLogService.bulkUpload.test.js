'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const xlsx = require('xlsx');

const { Employee } = require('../src/models');
const employeeRepository = require('../src/repositories/employeeRepository');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');
const employeeMonthlyWorkLogService = require('../src/services/employeeMonthlyWorkLogService');
const managerMonthlyWorkLogService = require('../src/services/managerMonthlyWorkLogService');

const ORIGINAL = {
  findByCode: employeeRepository.findByCode,
  findById: employeeRepository.findById,
  findByManager: managerEmployeeMappingRepository.findByManager,
  employeeFindAll: Employee.findAll,
  loadMappedPOsWithHierarchy: employeeTimesheetService.loadMappedPOsWithHierarchy,
  submitMonthlyWorkLog: employeeMonthlyWorkLogService.submitMonthlyWorkLog,
};

function restore() {
  employeeRepository.findByCode = ORIGINAL.findByCode;
  employeeRepository.findById = ORIGINAL.findById;
  managerEmployeeMappingRepository.findByManager = ORIGINAL.findByManager;
  Employee.findAll = ORIGINAL.employeeFindAll;
  employeeTimesheetService.loadMappedPOsWithHierarchy = ORIGINAL.loadMappedPOsWithHierarchy;
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = ORIGINAL.submitMonthlyWorkLog;
}

test.after(() => restore());

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-upload-'));

function writeSheet(rows) {
  const filePath = path.join(TMP_DIR, `sheet-${Date.now()}-${Math.random()}.xlsx`);
  const header = ['Employee Code', 'Employee Name', 'Service PO Name', 'Hours', 'Description'];
  const data = [header, ...rows];
  const sheet = xlsx.utils.aoa_to_sheet(data);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  xlsx.writeFile(workbook, filePath);
  return filePath;
}

// A month solidly in the past, so dateHelper.isMonthlyLogEligible never blocks the submission.
const PERIOD = { month: 1, year: 2025 };

// Stubs the Manager-tier lookup path: findByManager returns PRIMARY mapping rows (deliberately
// including a Business Unit the caller/manager themself doesn't belong to, to prove the fix
// doesn't reintroduce the BU-scoping bug already fixed in getMyEmployees), and Employee.findAll
// resolves those mapped ids with no company/BU scoping at all.
function stubPrimaryTeam(managerUserId, employees) {
  managerEmployeeMappingRepository.findByManager = async (calledManagerId) => {
    assert.equal(calledManagerId, managerUserId);
    return employees.map((e) => ({ employee_id: e.id, mapping_type: 'PRIMARY' }));
  };
  // The real query filters Employee.findAll by { id: { [Op.in]: mappedEmployeeIds }}, but every
  // test here maps `employees` 1:1 with what findByManager just returned, so returning the full
  // stubbed list is equivalent without having to unpack the Op.in symbol in a mock.
  Employee.findAll = async () => employees;
}

test('Gate 1 rejects the whole file when a row\'s Employee Code is not one of the caller\'s PRIMARY-mapped Employees', async () => {
  stubPrimaryTeam(42, [{ id: 1, employee_code: 'E999', status: 'active', is_deleted: false }]); // file uses E001, not E999
  let submitCalled = false;
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async () => { submitCalled = true; };

  const filePath = writeSheet([['E001', 'Alice', 'PO Alpha', 10, 'work']]);

  await assert.rejects(
    () => managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(42, 10, filePath, PERIOD, 42, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.details.phase, 'ownership');
      assert.equal(err.details.error_rows.length, 1);
      return true;
    }
  );
  assert.equal(submitCalled, false);
});

// Regression coverage for the bug this fixed: resolving a row's Employee Code must NEVER be
// scoped to the manager's own active Business Unit — a PRIMARY-mapped Employee can legitimately
// sit in a different Business Unit entirely (manager_employee_mappings is the access grant, not
// shared BU membership). companyId (10) here deliberately differs from the mapped Employee's own
// Business Unit membership, which this stub doesn't even model, to prove no BU filter is applied.
test('Gate 1 succeeds for a PRIMARY-mapped Employee regardless of the manager\'s own active Business Unit (companyId)', async () => {
  stubPrimaryTeam(42, [{ id: 1, employee_code: 'E001', status: 'active', is_deleted: false }]);
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({
    mappedPOs: [{ id: 501, service_po_name: 'PO Alpha' }],
    hierarchyRowsByPOId: new Map(),
  });
  const submittedCalls = [];
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async (employeeId, companyId, data, options) => {
    submittedCalls.push({ employeeId, companyId });
    return { month: data.month, year: data.year };
  };

  const filePath = writeSheet([['E001', 'Alice', 'PO Alpha', 10, 'work']]);
  // companyId = 999, an arbitrary BU the stub never associates with the Employee at all.
  const result = await managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(42, 999, filePath, PERIOD, 42, '127.0.0.1');

  assert.equal(result.employees_processed, 1);
  assert.equal(submittedCalls.length, 1);
  assert.equal(submittedCalls[0].employeeId, 1);
});

test('Gate 2 rejects the whole file when a row\'s Service PO is not mapped to the Employee', async () => {
  stubPrimaryTeam(42, [{ id: 1, employee_code: 'E001', status: 'active', is_deleted: false }]);
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({
    mappedPOs: [{ id: 501, service_po_name: 'PO Alpha' }],
    hierarchyRowsByPOId: new Map(),
  });
  let submitCalled = false;
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async () => { submitCalled = true; };

  const filePath = writeSheet([['E001', 'Alice', 'PO Beta (not mapped)', 10, 'work']]);

  await assert.rejects(
    () => managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(42, 10, filePath, PERIOD, 42, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.details.phase, 'service_po');
      assert.equal(err.details.error_rows.length, 1);
      return true;
    }
  );
  assert.equal(submitCalled, false);
});

test('happy path: both gates pass -> groups rows by employee and REPLACE-SAVEs each, auto-approved, Main-PO-only', async () => {
  stubPrimaryTeam(42, [
    { id: 1, employee_code: 'E001', status: 'active', is_deleted: false },
    { id: 2, employee_code: 'E002', status: 'active', is_deleted: false },
  ]);
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({
    mappedPOs: [
      { id: 501, service_po_name: 'PO Alpha' },
      { id: 502, service_po_name: 'PO Gamma' },
    ],
    hierarchyRowsByPOId: new Map(),
  });

  const submittedCalls = [];
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async (employeeId, companyId, data, options) => {
    submittedCalls.push({ employeeId, companyId, data, options });
    return { month: data.month, year: data.year };
  };

  const filePath = writeSheet([
    ['E001', 'Alice', 'PO Alpha', 10, 'work A'],
    ['E001', 'Alice', 'PO Gamma', 5, ''],
    ['E002', 'Bob', 'PO Alpha', 8, 'work B'],
  ]);

  const result = await managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(42, 10, filePath, PERIOD, 42, '127.0.0.1');

  assert.equal(result.employees_processed, 2);
  assert.equal(result.total_rows, 3);
  assert.equal(submittedCalls.length, 2);

  const forEmp1 = submittedCalls.find((c) => c.employeeId === 1);
  assert.equal(forEmp1.data.entries.length, 2);
  assert.equal(forEmp1.options.forceApproved, true);
  assert.equal(forEmp1.options.allowHierarchyNode, false);
  assert.equal(forEmp1.options.creatorId, 42);

  const forEmp2 = submittedCalls.find((c) => c.employeeId === 2);
  assert.equal(forEmp2.data.entries.length, 1);
  assert.equal(forEmp2.data.entries[0].service_po_id, 501);
  assert.equal(forEmp2.data.entries[0].hours, 8);
});

// Description is optional (min-length/required was mistakenly copied from the Employee
// self-service schema at first) — a row with a genuinely blank Description must still succeed.
test('a row with a blank Description still passes both gates and saves with description: \'\'', async () => {
  stubPrimaryTeam(42, [{ id: 1, employee_code: 'E001', status: 'active', is_deleted: false }]);
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({
    mappedPOs: [{ id: 501, service_po_name: 'PO Alpha' }],
    hierarchyRowsByPOId: new Map(),
  });
  const submittedCalls = [];
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async (employeeId, companyId, data) => {
    submittedCalls.push(data);
    return { month: data.month, year: data.year };
  };

  const filePath = writeSheet([['E001', 'Alice', 'PO Alpha', 10, '']]);
  await managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(42, 10, filePath, PERIOD, 42, '127.0.0.1');

  assert.equal(submittedCalls[0].entries[0].description, '');
});

test('Admin-tier caller bypasses the PRIMARY-manager ownership gate entirely', async () => {
  employeeRepository.findByCode = async () => ({ id: 1, status: 'active', is_deleted: false });
  let mappingLookupCalled = false;
  managerEmployeeMappingRepository.findByManager = async () => {
    mappingLookupCalled = true;
    return [];
  };
  employeeTimesheetService.loadMappedPOsWithHierarchy = async () => ({
    mappedPOs: [{ id: 501, service_po_name: 'PO Alpha' }],
    hierarchyRowsByPOId: new Map(),
  });
  employeeMonthlyWorkLogService.submitMonthlyWorkLog = async () => ({});

  const filePath = writeSheet([['E001', 'Alice', 'PO Alpha', 10, 'work']]);

  // hierarchyRank 2 = Admin tier (<= ADMIN_TIER_MAX_RANK)
  const result = await managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(7, 10, filePath, PERIOD, 7, '127.0.0.1', 2, []);

  assert.equal(result.employees_processed, 1);
  assert.equal(mappingLookupCalled, false);
});
