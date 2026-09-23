'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// New "Contributed %" column, requested for GET /reports/monthly-resource-
// utilization: what share of an employee's Monthly Capacity (the fixed cap,
// e.g. 176 — same denominator utilization_percentage already uses) was
// billable — e.g. capacity 176, 150 billable -> 85.23%. Deliberately against
// monthly_capacity, NOT total_hours (an earlier version of this column used
// total_hours; changed per explicit follow-up instruction to match
// utilization_percentage's own denominator instead). Computed inside
// buildPivotResponse(), so it's available on every pivot report that shares
// it (Monthly Resource Utilization and plain Resource Utilization), both
// per-row and in the full-dataset summary. Same monkey-patch style as
// test/reportService.r1EntityBuFilters.test.js.
const reportRepo = require('../src/repositories/reportRepository');
const reportService = require('../src/services/reportService');

const ORIGINAL = {
  getMonthlyResourceUtilization: reportRepo.getMonthlyResourceUtilization,
  getResourceUtilization: reportRepo.getResourceUtilization,
};

function restore() {
  reportRepo.getMonthlyResourceUtilization = ORIGINAL.getMonthlyResourceUtilization;
  reportRepo.getResourceUtilization = ORIGINAL.getResourceUtilization;
}

const COLUMNS = [
  { category_id: 1, category_name: 'Billable', service_type_id: 10, service_type_name: 'Development' },
  { category_id: 2, category_name: 'Non-Billable', service_type_id: 20, service_type_name: 'Bench' },
];

test('getMonthlyResourceUtilization: contributed_percentage = billable_total / monthly_capacity * 100 — NOT billable_total / total_hours', async () => {
  try {
    reportRepo.getMonthlyResourceUtilization = async () => ({
      columns: COLUMNS,
      rows: [
        // billable 150, non-billable 10 -> total_hours 160, DIFFERENT from
        // monthly_capacity 176, so the two possible formulas give different
        // answers and this test actually distinguishes them: against
        // total_hours it'd be 150/160*100=93.75; against monthly_capacity
        // (the correct one) it's 150/176*100=85.23.
        { employee_id: 1, employee_code: 'E1', full_name: 'A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '150.00' },
        { employee_id: 1, employee_code: 'E1', full_name: 'A', monthly_capacity: 176, service_type_id: 20, category_id: 2, category_name: 'Non-Billable', hours: '10.00' },
      ],
      count: 1,
    });

    const { data } = await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(data[0].billable_total, 150);
    assert.equal(data[0].total_hours, 160);
    assert.equal(data[0].contributed_percentage, 85.23); // 150 / 176 * 100, rounded — NOT 150/160
  } finally {
    restore();
  }
});

test('getMonthlyResourceUtilization: contributed_percentage is null when monthly_capacity is unavailable, even though total_hours is > 0', async () => {
  try {
    reportRepo.getMonthlyResourceUtilization = async () => ({
      columns: COLUMNS,
      rows: [
        { employee_id: 1, employee_code: 'E1', full_name: 'A', monthly_capacity: null, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '50.00' },
      ],
      count: 1,
    });

    const { data } = await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(data[0].total_hours, 50);
    assert.equal(data[0].utilization_percentage, null);
    assert.equal(data[0].contributed_percentage, null); // same "no capacity, no %" rule as utilization_percentage
  } finally {
    restore();
  }
});

test('getMonthlyResourceUtilization: summary contributed_percentage is computed from the FULL-dataset aggregate (billable_total/monthly_capacity), not by averaging per-employee percentages', async () => {
  try {
    reportRepo.getMonthlyResourceUtilization = async () => ({
      columns: COLUMNS,
      // Page only carries employee 1; the full-dataset summary reflects
      // every employee matching the filters (2 employees combined ->
      // monthly_capacity = employee_count * 176 = 352).
      rows: [
        { employee_id: 1, employee_code: 'E1', full_name: 'A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '10.00' },
      ],
      count: 2,
      summary: { billable_total: 176, non_billable_total: 176, total_hours: 352, leaves_hours: 0, total_utilization: 352, employee_count: 2 },
    });

    const { summary } = await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(summary.billable_total, 176);
    assert.equal(summary.contributed_percentage, 50); // 176 / (2 * 176) * 100 = 50 — NOT an average of per-row percentages
  } finally {
    restore();
  }
});

test('getMonthlyResourceUtilization: summary contributed_percentage is null when the full dataset has 0 employees (monthly_capacity aggregate is 0)', async () => {
  try {
    reportRepo.getMonthlyResourceUtilization = async () => ({
      columns: COLUMNS,
      rows: [],
      count: 0,
      summary: { billable_total: 0, non_billable_total: 0, total_hours: 0, leaves_hours: 0, total_utilization: 0, employee_count: 0 },
    });

    const { summary } = await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(summary.contributed_percentage, null);
  } finally {
    restore();
  }
});

test('getResourceUtilization (plain, no monthly_capacity column): contributed_percentage is null there too, same as utilization_percentage — no capacity to divide by', async () => {
  try {
    reportRepo.getResourceUtilization = async () => ({
      columns: COLUMNS,
      rows: [
        { employee_id: 1, employee_code: 'E1', full_name: 'A', service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '80.00' },
        { employee_id: 1, employee_code: 'E1', full_name: 'A', service_type_id: 20, category_id: 2, category_name: 'Non-Billable', hours: '20.00' },
      ],
      count: 1,
    });

    const { data } = await reportService.getResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(data[0].total_hours, 100);
    assert.equal(data[0].utilization_percentage, null); // no monthly_capacity selected by this report
    assert.equal(data[0].contributed_percentage, null); // same reason — no capacity to divide by
  } finally {
    restore();
  }
});
