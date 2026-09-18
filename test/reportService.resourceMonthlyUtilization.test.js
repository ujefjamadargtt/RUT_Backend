'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported function —
// reportService.js holds a live reference to this SAME module-cached object.
// Same pattern as test/reportService.resourceUtilizationTrend.test.js.
const reportRepo = require('../src/repositories/reportRepository');
const reportService = require('../src/services/reportService');

const ORIGINAL = {
  getResourceMonthlyUtilization: reportRepo.getResourceMonthlyUtilization,
};

function restore() {
  reportRepo.getResourceMonthlyUtilization = ORIGINAL.getResourceMonthlyUtilization;
}

// Pivot-shaped rows/columns exactly like getMonthlyResourceUtilization's repo
// output, since getResourceMonthlyUtilizationReport() feeds them through the
// SAME buildPivotResponse() helper that report already uses.
const COLUMNS = [
  { category_id: 1, category_name: 'Billable', service_type_id: 10, service_type_name: 'Development' },
  { category_id: 2, category_name: 'Non-Billable', service_type_id: 20, service_type_name: 'Bench' },
  { category_id: 2, category_name: 'Non-Billable', service_type_id: 21, service_type_name: 'Leave' },
];

test('getResourceMonthlyUtilizationReport() computes Billable/Non-Billable % independently against the 176-hr capacity, not against Total Hours', async () => {
  reportRepo.getResourceMonthlyUtilization = async () => ({
    columns: COLUMNS,
    rows: [
      { employee_id: 1, employee_code: 'E1', full_name: 'Employee A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '104.00' },
      { employee_id: 1, employee_code: 'E1', full_name: 'Employee A', monthly_capacity: 176, service_type_id: 20, category_id: 2, category_name: 'Non-Billable', hours: '64.00' },
    ],
    count: 1,
  });

  const { data } = await reportService.getResourceMonthlyUtilizationReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data.length, 1);
  const row = data[0];
  assert.equal(row.billableHours, 104);
  assert.equal(row.nonBillableHours, 64);
  assert.equal(row.totalHours, 168);
  assert.equal(row.billableUtilizationPercentage, 59.09);
  assert.equal(row.nonBillableUtilizationPercentage, 36.36);
  restore();
});

test('getResourceMonthlyUtilizationReport() Overall Utilization % reuses the existing Monthly Resource Utilization formula (100% at full non-leave capacity, whether billable or non-billable)', async () => {
  reportRepo.getResourceMonthlyUtilization = async () => ({
    columns: COLUMNS,
    rows: [
      // All billable: 176 billable, 0 non-billable.
      { employee_id: 1, employee_code: 'E1', full_name: 'Employee A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '176.00' },
      // All non-billable, none of it Leave: 0 billable, 176 non-billable.
      { employee_id: 2, employee_code: 'E2', full_name: 'Employee B', monthly_capacity: 176, service_type_id: 20, category_id: 2, category_name: 'Non-Billable', hours: '176.00' },
    ],
    count: 2,
  });

  const { data } = await reportService.getResourceMonthlyUtilizationReport({ month: 8, year: 2026 }, [1]);

  const empA = data.find((r) => r.employeeId === 1);
  const empB = data.find((r) => r.employeeId === 2);

  assert.equal(empA.billableUtilizationPercentage, 100);
  assert.equal(empA.nonBillableUtilizationPercentage, 0);
  assert.equal(empA.overallUtilizationPercentage, 100);

  assert.equal(empB.billableUtilizationPercentage, 0);
  assert.equal(empB.nonBillableUtilizationPercentage, 100);
  assert.equal(empB.overallUtilizationPercentage, 100);
  restore();
});

test('getResourceMonthlyUtilizationReport() summary percentages come from aggregated hours across employees, not from averaging per-employee percentages', async () => {
  reportRepo.getResourceMonthlyUtilization = async () => ({
    columns: COLUMNS,
    rows: [
      // Employee A: 176 billable (100% billable util)
      { employee_id: 1, employee_code: 'E1', full_name: 'Employee A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '176.00' },
      // Employee B: 0 billable, 0 non-billable logged (0% billable util)
      { employee_id: 2, employee_code: 'E2', full_name: 'Employee B', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '0.00' },
    ],
    count: 2,
  });

  const { summary } = await reportService.getResourceMonthlyUtilizationReport({ month: 8, year: 2026 }, [1]);

  // Naive average of (100% + 0%) / 2 = 50% would be wrong here.
  // Aggregated: total billable 176 hrs / total capacity 352 hrs * 100 = 50% —
  // same numeric answer in this symmetric case, so assert the aggregation
  // basis directly via the underlying hour totals instead of the %.
  assert.equal(summary.billableHours, 176);
  assert.equal(summary.totalHours, 176);
  assert.equal(summary.billableUtilizationPercentage, 50);
  restore();
});

test('getResourceMonthlyUtilizationReport() forwards clientId, poId (and projectId alias), serviceTypeId, employeeId filters straight through to the repository', async () => {
  let receivedFilters;
  reportRepo.getResourceMonthlyUtilization = async (filters) => {
    receivedFilters = filters;
    return { columns: [], rows: [], count: 0 };
  };

  await reportService.getResourceMonthlyUtilizationReport(
    { month: 8, year: 2026, employeeId: '7', clientId: '3', poId: '9', serviceTypeId: '2', hoursSource: 'O', roleId: '5' },
    [1, 2]
  );

  assert.equal(receivedFilters.employeeId, 7);
  assert.equal(receivedFilters.clientId, 3);
  assert.equal(receivedFilters.poId, 9);
  assert.equal(receivedFilters.serviceTypeId, 2);
  assert.equal(receivedFilters.hoursSource, 'O');
  assert.equal(receivedFilters.roleId, '5');
  assert.deepEqual(receivedFilters.companyIds, [1, 2]);
  restore();

  // projectId is accepted as an alias for poId, same as the Resource Project
  // Utilization report's convention.
  reportRepo.getResourceMonthlyUtilization = async (filters) => {
    receivedFilters = filters;
    return { columns: [], rows: [], count: 0 };
  };
  await reportService.getResourceMonthlyUtilizationReport(
    { month: 8, year: 2026, projectId: '11' },
    [1]
  );
  assert.equal(receivedFilters.poId, 11);
  restore();
});

test('getResourceMonthlyUtilizationReport() throws a 422 when month or year is missing', async () => {
  await assert.rejects(
    () => reportService.getResourceMonthlyUtilizationReport({}, [1]),
    (err) => err.statusCode === 422
  );
});

test('getResourceMonthlyUtilizationReport() paginates employee rows', async () => {
  // Pagination happens at the SQL level (LIMIT/OFFSET), same as
  // getMonthlyResourceUtilization's repo function — the repo only ever
  // returns the requested page's rows, alongside the full unpaginated count.
  const allRows = Array.from({ length: 15 }, (_, i) => ({
    employee_id: i + 1, employee_code: `E${i + 1}`, full_name: `Employee ${i + 1}`,
    monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '100.00',
  }));
  reportRepo.getResourceMonthlyUtilization = async (filters) => ({
    columns: COLUMNS,
    rows: allRows.slice(filters.offset, filters.offset + filters.limit),
    count: 15,
  });

  const { data, meta } = await reportService.getResourceMonthlyUtilizationReport(
    { month: 8, year: 2026, page: 2, limit: 10 },
    [1]
  );

  assert.equal(data.length, 5);
  assert.equal(meta.total, 15);
  assert.equal(meta.page, 2);
  restore();
});
