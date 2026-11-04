'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Employee, ServicePO, EmployeeServicePOMapping } = require('../src/models');
const timesheetService = require('../src/services/timesheetService');

/**
 * validateRows() is the shared preview builder of the Excel upload and the Sync Employee Work Logs
 * flows: every valid/error preview row must carry employeeId / employeeCode / employeeName.
 */

const ORIGINAL = {
  employeeFindAll: Employee.findAll,
  poFindAll: ServicePO.findAll,
  mappingFindAll: EmployeeServicePOMapping.findAll,
};
const restore = () => {
  Employee.findAll = ORIGINAL.employeeFindAll;
  ServicePO.findAll = ORIGINAL.poFindAll;
  EmployeeServicePOMapping.findAll = ORIGINAL.mappingFindAll;
};

function stubDb() {
  const counts = { employees: 0 };
  EmployeeServicePOMapping.findAll = async () => [];
  Employee.findAll = async () => {
    counts.employees += 1;
    return [{ id: 7, employee_code: 'EMP001', full_name: 'Rahul Sharma', status: 'active' }];
  };
  ServicePO.findAll = async () => [{ id: 3, service_po_name: 'Alpha PO', subProjects: [], serviceType: null }];
  return counts;
}

test('Excel row: resourceName stays the sheet value, employeeName is the matched full name', async () => {
  const counts = stubDb();
  const { validRows, errorRows } = await timesheetService.validateRows([
    { rowNumber: 1, resourceName: 'EMP001', servicePOName: 'Alpha PO', date: '2026-09-01', hours: 8 },
  ], 10);
  restore();

  assert.equal(errorRows.length, 0);
  assert.equal(validRows[0].resourceName, 'EMP001');
  assert.equal(validRows[0].employeeId, 7);
  assert.equal(validRows[0].employeeCode, 'EMP001');
  assert.equal(validRows[0].employeeName, 'Rahul Sharma');
  assert.equal(counts.employees, 1, 'employees are resolved in one query, not per row');
});

test('Employee Sync row: resourceName becomes the full name (was the employee code)', async () => {
  stubDb();
  const { validRows } = await timesheetService.validateRows([
    { rowNumber: 1, resourceName: 'EMP001', employeeId: 7, poId: 3, servicePOName: 'Alpha PO', date: '2026-09-01', hours: 8 },
  ], 10);
  restore();

  assert.equal(validRows[0].resourceName, 'Rahul Sharma');
  assert.equal(validRows[0].employeeName, 'Rahul Sharma');
  assert.equal(validRows[0].employeeCode, 'EMP001');
});

test('Error rows carry the same fields; an unmatched employee has employeeName null, never the code/id', async () => {
  stubDb();
  const { errorRows } = await timesheetService.validateRows([
    { rowNumber: 1, resourceName: 'EMP001', servicePOName: 'Missing PO', date: '2026-09-01', hours: 8 }, // matched employee, bad PO
    { rowNumber: 2, resourceName: 'NOPE', servicePOName: 'Alpha PO', date: '2026-09-01', hours: 8 },     // unmatched employee
  ], 10);
  restore();

  assert.equal(errorRows.length, 2);
  assert.equal(errorRows[0].row.employeeName, 'Rahul Sharma');
  assert.equal(errorRows[0].row.employeeId, 7);
  assert.equal(errorRows[0].row.resourceName, 'EMP001');
  assert.equal(errorRows[1].row.employeeName, null);
  assert.equal(errorRows[1].row.employeeCode, null);
  assert.equal(errorRows[1].row.employeeId, null);
  assert.equal(errorRows[1].row.resourceName, 'NOPE');
});
