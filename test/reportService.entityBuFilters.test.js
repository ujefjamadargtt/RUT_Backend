'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reportRepo = require('../src/repositories/reportRepository');
const { Company } = require('../src/models');
const reportService = require('../src/services/reportService');

/**
 * Multi-Value Entity/BU Filtering — the two pilot report endpoints
 * (monthly-cost-summary, resource-monthly-utilization) wiring entityIds/
 * businessUnitIds into their existing companyIds scope, and surfacing the
 * repo's new full-dataset summary/totals instead of a per-page reduce.
 */

const ORIGINAL = {
  getMonthlyCostSummary: reportRepo.getMonthlyCostSummary,
  getResourceMonthlyUtilization: reportRepo.getResourceMonthlyUtilization,
  companyFindAll: Company.findAll,
};

function restore() {
  reportRepo.getMonthlyCostSummary = ORIGINAL.getMonthlyCostSummary;
  reportRepo.getResourceMonthlyUtilization = ORIGINAL.getResourceMonthlyUtilization;
  Company.findAll = ORIGINAL.companyFindAll;
}

test('getMonthlyCostSummary: no entityIds/businessUnitIds -> companyIds reach passed through unchanged (regression baseline)', async () => {
  try {
    let received;
    reportRepo.getMonthlyCostSummary = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, totals: { total_salary_cost: 0, total_ops_cost: 0, total_cost: 0, total_billable_cost: 0 } };
    };

    await reportService.getMonthlyCostSummary({}, [1, 2, 3]);

    assert.deepEqual(received, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('getMonthlyCostSummary: businessUnitIds narrows companyIds before hitting the repo, dropping unauthorized ids', async () => {
  try {
    let received;
    reportRepo.getMonthlyCostSummary = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, totals: { total_salary_cost: 0, total_ops_cost: 0, total_cost: 0, total_billable_cost: 0 } };
    };

    await reportService.getMonthlyCostSummary({ businessUnitIds: '2,999' }, [1, 2, 3]);

    // 999 is outside the caller's own reach ([1,2,3]) — silently dropped.
    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getMonthlyCostSummary: an empty/absent businessUnitIds string behaves exactly like omitting it', async () => {
  try {
    let received;
    reportRepo.getMonthlyCostSummary = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, totals: { total_salary_cost: 0, total_ops_cost: 0, total_cost: 0, total_billable_cost: 0 } };
    };

    await reportService.getMonthlyCostSummary({ businessUnitIds: '' }, [1, 2, 3]);

    assert.deepEqual(received, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('getMonthlyCostSummary: summary comes straight from the repo\'s full-dataset totals, not a page-level reduce', async () => {
  try {
    reportRepo.getMonthlyCostSummary = async () => ({
      rows: [{ total_salary_cost: '10.00' }], // deliberately mismatched vs totals, to prove summary isn't derived from rows
      count: 1,
      totals: { total_salary_cost: 999.995, total_ops_cost: 1, total_cost: 1000.995, total_billable_cost: 2 },
    });

    const { summary } = await reportService.getMonthlyCostSummary({}, [1]);

    assert.equal(summary.total_salary_cost, 1000); // rounded to 2dp, from totals not rows
    assert.equal(summary.total_cost, 1001);
  } finally {
    restore();
  }
});

test('getResourceMonthlyUtilizationReport: entityIds narrows companyIds via intersectCompanyIdsWithEntity before the repo call', async () => {
  try {
    let capturedEntityIds;
    Company.findAll = async ({ where }) => {
      capturedEntityIds = where.entity_id;
      return [{ id: 1 }, { id: 2 }]; // Companies under entities 5,6 — BU 3 is NOT among them
    };
    let received;
    reportRepo.getResourceMonthlyUtilization = async (filters) => {
      received = filters.companyIds;
      return { columns: [], rows: [], count: 0, summary: { billable_total: 0, non_billable_total: 0, total_hours: 0, leaves_hours: 0, total_utilization: 0, employee_count: 0 } };
    };

    await reportService.getResourceMonthlyUtilizationReport({ month: 8, year: 2026, entityIds: '5,6' }, [1, 2, 3]);

    assert.ok(capturedEntityIds, 'expected entity_id to be queried');
    assert.deepEqual(received.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('getResourceMonthlyUtilizationReport: summary/overall % are computed from the repo\'s full-dataset summary (employee_count-based capacity), not the current page\'s rows', async () => {
  try {
    reportRepo.getResourceMonthlyUtilization = async () => ({
      columns: [
        { category_id: 1, category_name: 'Billable', service_type_id: 10, service_type_name: 'Development' },
      ],
      // Page 1 only returns ONE employee's row...
      rows: [
        { employee_id: 1, employee_code: 'E1', full_name: 'Employee A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '176.00' },
      ],
      count: 3,
      // ...but the full filtered dataset spans 3 employees (528 capacity), and
      // logged 176 billable hours total across all of them.
      summary: { billable_total: 176, non_billable_total: 0, total_hours: 176, leaves_hours: 0, total_utilization: 176, employee_count: 3 },
    });

    const { summary } = await reportService.getResourceMonthlyUtilizationReport({ month: 8, year: 2026, page: 1, limit: 1 }, [1]);

    // 176 / (3 * 176) * 100 = 33.33%, NOT 176/176*100=100% (which is what a
    // page-scoped-only computation, using just the 1 returned row, would give).
    assert.equal(summary.billableUtilizationPercentage, 33.33);
    assert.equal(summary.overallUtilizationPercentage, 33.33);
  } finally {
    restore();
  }
});
