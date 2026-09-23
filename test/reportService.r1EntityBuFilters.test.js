'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reportRepo = require('../src/repositories/reportRepository');
const { Company } = require('../src/models');
const reportService = require('../src/services/reportService');

/**
 * R1 batch (Utilization reports) — entityIds/businessUnitIds wiring and,
 * where a summary block already existed, full-dataset aggregation.
 */

const ORIGINAL = {
  getMonthlyResourceUtilization: reportRepo.getMonthlyResourceUtilization,
  getEmployeeUtilizationSummary: reportRepo.getEmployeeUtilizationSummary,
  getResourceAllocation: reportRepo.getResourceAllocation,
  getResourseProjectUtilizationReport: reportRepo.getResourseProjectUtilizationReport,
  getResourceUtilizationTrend: reportRepo.getResourceUtilizationTrend,
  companyFindAll: Company.findAll,
};

function restore() {
  reportRepo.getMonthlyResourceUtilization = ORIGINAL.getMonthlyResourceUtilization;
  reportRepo.getEmployeeUtilizationSummary = ORIGINAL.getEmployeeUtilizationSummary;
  reportRepo.getResourceAllocation = ORIGINAL.getResourceAllocation;
  reportRepo.getResourseProjectUtilizationReport = ORIGINAL.getResourseProjectUtilizationReport;
  reportRepo.getResourceUtilizationTrend = ORIGINAL.getResourceUtilizationTrend;
  Company.findAll = ORIGINAL.companyFindAll;
}

test('getMonthlyResourceUtilization: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    reportRepo.getMonthlyResourceUtilization = async (filters) => {
      received = filters.companyIds;
      return { columns: [], rows: [], count: 0, summary: { billable_total: 0, non_billable_total: 0, total_hours: 0, leaves_hours: 0, total_utilization: 0, employee_count: 0 } };
    };

    await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026, businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getMonthlyResourceUtilization: summary comes from the repo\'s full-dataset summary, not the current page', async () => {
  try {
    reportRepo.getMonthlyResourceUtilization = async () => ({
      columns: [{ category_id: 1, category_name: 'Billable', service_type_id: 10, service_type_name: 'Dev' }],
      rows: [{ employee_id: 1, employee_code: 'E1', full_name: 'A', monthly_capacity: 176, service_type_id: 10, category_id: 1, category_name: 'Billable', hours: '10.00' }],
      count: 5,
      summary: { billable_total: 500, non_billable_total: 0, total_hours: 500, leaves_hours: 0, total_utilization: 500, employee_count: 5 },
    });

    const { summary } = await reportService.getMonthlyResourceUtilization({ month: 8, year: 2026 }, [1]);

    assert.equal(summary.billable_total, 500);
    assert.equal(summary.utilization_percentage, round2(500 / (5 * 176) * 100));
  } finally {
    restore();
  }
});

function round2(n) { return Math.round(n * 100) / 100; }

test('getEmployeeUtilizationSummary: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    reportRepo.getEmployeeUtilizationSummary = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, summary: { billable_total: 0, non_billable_total: 0, internal_support_hours: 0, team_management_hours: 0, leaves_hours: 0, lnd_hours: 0, others_hours: 0 } };
    };

    await reportService.getEmployeeUtilizationSummary({ month: 8, year: 2026, businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getEmployeeUtilizationSummary: summary comes from the repo\'s full-dataset summary, not a page-level reduce', async () => {
  try {
    reportRepo.getEmployeeUtilizationSummary = async () => ({
      rows: [{ billable_total: '1.00' }], // deliberately mismatched vs summary, to prove it isn't derived from rows
      count: 3,
      summary: { billable_total: 999, non_billable_total: 1, internal_support_hours: 2, team_management_hours: 3, leaves_hours: 4, lnd_hours: 5, others_hours: 6 },
    });

    const { summary } = await reportService.getEmployeeUtilizationSummary({ month: 8, year: 2026 }, [1]);

    assert.equal(summary.billable_total, 999);
    assert.equal(summary.others_hours, 6);
  } finally {
    restore();
  }
});

test('getResourceAllocation: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    reportRepo.getResourceAllocation = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0 };
    };

    await reportService.getResourceAllocation({ businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getResourseProjectUtilizationReport: entityIds/businessUnitIds narrow companyIds before the repo call', async () => {
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    let received;
    reportRepo.getResourseProjectUtilizationReport = async (filters) => {
      received = filters.companyIds;
      return { rows: [], costs: [], count: 0 };
    };

    await reportService.getResourseProjectUtilizationReport({ entityIds: '5', businessUnitIds: '2' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getResourceUtilizationTrendReport: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    reportRepo.getResourceUtilizationTrend = async (filters) => {
      received = filters.companyIds;
      return [];
    };

    await reportService.getResourceUtilizationTrendReport({ startDate: '2026-08-01', endDate: '2026-08-31', businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});
