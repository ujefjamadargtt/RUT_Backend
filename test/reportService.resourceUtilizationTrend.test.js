'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported function —
// reportService.js holds a live reference to this SAME module-cached object.
// Same pattern as test/managementReportService.thresholdFilters.test.js.
const reportRepo = require('../src/repositories/reportRepository');
const reportService = require('../src/services/reportService');

const ORIGINAL = {
  getResourceUtilizationTrend: reportRepo.getResourceUtilizationTrend,
};

function restore() {
  reportRepo.getResourceUtilizationTrend = ORIGINAL.getResourceUtilizationTrend;
}

test('getResourceUtilizationTrendReport() computes Utilization % = (Billable Hours / Total Hours) * 100, rounded to 2 decimals, per Month + Resource — same formula as the existing Utilization Trend', async () => {
  reportRepo.getResourceUtilizationTrend = async () => ([
    { year: 2026, month: 8, employee_id: 1, employee_code: 'E1', full_name: 'Employee A', total_hours: '160.00', billable_hours: '120.00' },
    { year: 2026, month: 8, employee_id: 2, employee_code: 'E2', full_name: 'Employee B', total_hours: '150.00', billable_hours: '90.00' },
    { year: 2026, month: 9, employee_id: 1, employee_code: 'E1', full_name: 'Employee A', total_hours: '168.00', billable_hours: '126.00' },
  ]);

  const { data } = await reportService.getResourceUtilizationTrendReport(
    { month: 8, year: 2026 },
    [1]
  );

  assert.equal(data.length, 3);
  const empA_Aug = data.find((r) => r.employee_id === 1 && r.month_number === 8);
  const empB_Aug = data.find((r) => r.employee_id === 2 && r.month_number === 8);
  const empA_Sep = data.find((r) => r.employee_id === 1 && r.month_number === 9);

  assert.equal(empA_Aug.total_hours, 160);
  assert.equal(empA_Aug.billable_hours, 120);
  assert.equal(empA_Aug.utilization_percentage, 75);

  assert.equal(empB_Aug.utilization_percentage, 60);

  assert.equal(empA_Sep.utilization_percentage, 75);
  restore();
});

test('getResourceUtilizationTrendReport() returns Utilization % = 0 when Total Hours = 0 for a resource/month, never divides by zero', async () => {
  reportRepo.getResourceUtilizationTrend = async () => ([
    { year: 2026, month: 8, employee_id: 1, employee_code: 'E1', full_name: 'Employee A', total_hours: '0', billable_hours: '0' },
  ]);

  const { data } = await reportService.getResourceUtilizationTrendReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data[0].total_hours, 0);
  assert.equal(data[0].utilization_percentage, 0);
  restore();
});

test('getResourceUtilizationTrendReport() forwards hoursSource and roleId straight through to the repository, same as the existing Utilization Trend filters', async () => {
  let receivedFilters;
  reportRepo.getResourceUtilizationTrend = async (filters) => {
    receivedFilters = filters;
    return [];
  };

  await reportService.getResourceUtilizationTrendReport(
    { month: 8, year: 2026, hoursSource: 'O', roleId: '5', employeeId: '7', clientId: '3', poId: '9', serviceTypeId: '2' },
    [1, 2]
  );

  assert.equal(receivedFilters.hoursSource, 'O');
  assert.equal(receivedFilters.roleId, '5');
  assert.equal(receivedFilters.employeeId, 7);
  assert.equal(receivedFilters.clientId, 3);
  assert.equal(receivedFilters.poId, 9);
  assert.equal(receivedFilters.serviceTypeId, 2);
  assert.deepEqual(receivedFilters.companyIds, [1, 2]);
  restore();
});

test('getResourceUtilizationTrendReport() throws a 422 when neither month+year nor startDate+endDate is provided (same date-range contract as the other trend reports)', async () => {
  await assert.rejects(
    () => reportService.getResourceUtilizationTrendReport({}, [1]),
    (err) => err.statusCode === 422
  );
});

test('getResourceUtilizationTrendReport() paginates the flattened Month + Resource rows', async () => {
  reportRepo.getResourceUtilizationTrend = async () => (
    Array.from({ length: 15 }, (_, i) => ({
      year: 2026, month: 8, employee_id: i + 1, employee_code: `E${i + 1}`, full_name: `Employee ${i + 1}`,
      total_hours: '100.00', billable_hours: '50.00',
    }))
  );

  const { data, meta } = await reportService.getResourceUtilizationTrendReport(
    { month: 8, year: 2026, page: 2, limit: 10 },
    [1]
  );

  assert.equal(data.length, 5);
  assert.equal(meta.total, 15);
  assert.equal(meta.page, 2);
  restore();
});
