'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Employee } = require('../src/models');
const employeeRepository = require('../src/repositories/employeeRepository');
const accessControl = require('../src/services/employeeAccessControlService');
const summaryRepository = require('../src/repositories/employeeWorkLogHoursSummaryRepository');
const summaryService = require('../src/services/employeeWorkLogHoursSummaryService');

const ORIGINAL = {
  findAll: Employee.findAll,
  employeeScope: employeeRepository.employeeScope,
  resolveEmployeeAccessWhere: accessControl.resolveEmployeeAccessWhere,
  getSummary: summaryRepository.getSummary,
  getDetails: summaryRepository.getDetails,
};

function restore() {
  Employee.findAll = ORIGINAL.findAll;
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  accessControl.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  summaryRepository.getSummary = ORIGINAL.getSummary;
  summaryRepository.getDetails = ORIGINAL.getDetails;
}

function stubAuthorizedEmployees(ids) {
  employeeRepository.employeeScope = async () => ({ tenant_scope: true });
  accessControl.resolveEmployeeAccessWhere = async ({ companyId }) => ({ company_scope: companyId });
  Employee.findAll = async () => ids.map((id) => ({ id }));
}

test('summary resolves a month, authorizes across every reachable BU, and paginates aggregated employee rows', async () => {
  stubAuthorizedEmployees([11, 22]);
  let filters;
  summaryRepository.getSummary = async (input) => {
    filters = input;
    return { rows: [{ employee_id: 11, total_hours: '152.50' }], count: 2 };
  };

  const result = await summaryService.getSummary(
    { month: 8, year: 2026, page: 2, limit: 1, sortBy: 'total_hours', sortOrder: 'DESC' },
    { userId: 5, employeeId: 5, hierarchyRank: 4, roleNames: ['BU Admin'] },
    [10, 30]
  );

  assert.deepEqual(filters.employeeIds, [11, 22]);
  assert.equal(filters.startDate, '2026-08-01');
  assert.equal(filters.endDate, '2026-08-31');
  assert.equal(filters.offset, 1);
  assert.equal(result.meta.total, 2);
  assert.equal(result.period.type, 'month');
  restore();
});

test('an explicitly requested employee is intersected with the authorized employee set', async () => {
  stubAuthorizedEmployees([11, 22]);
  let filters;
  summaryRepository.getSummary = async (input) => {
    filters = input;
    return { rows: [], count: 0 };
  };

  await summaryService.getSummary(
    { date: '2026-08-28', employeeId: 22, page: 1, limit: 10, sortBy: 'employee_name', sortOrder: 'ASC' },
    { userId: 5, employeeId: 5, hierarchyRank: 6, roleNames: ['Service PO Admin'] },
    [10]
  );

  assert.deepEqual(filters.employeeIds, [22]);
  assert.equal(filters.startDate, '2026-08-28');
  assert.equal(filters.endDate, '2026-08-28');
  restore();
});

test('detail request returns 404 before querying work logs for an employee outside the authorized scope', async () => {
  stubAuthorizedEmployees([11]);
  let detailsCalled = false;
  summaryRepository.getDetails = async () => {
    detailsCalled = true;
    return {};
  };

  await assert.rejects(
    () => summaryService.getDetails(22, { date: '2026-08-28', page: 1, limit: 20 }, { employeeId: 5, hierarchyRank: 7 }, [10]),
    (error) => error.statusCode === 404
  );
  assert.equal(detailsCalled, false);
  restore();
});
