'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const managementReportRepo = require('../src/repositories/managementReportRepository');
const { Company } = require('../src/models');
const managementReportService = require('../src/services/managementReportService');

const ORIGINAL = {
  getResourceCostUtilization: managementReportRepo.getResourceCostUtilization,
  companyFindAll: Company.findAll,
};

function restore() {
  managementReportRepo.getResourceCostUtilization = ORIGINAL.getResourceCostUtilization;
  Company.findAll = ORIGINAL.companyFindAll;
}

const QUERY = { startMonth: 4, startYear: 2026, endMonth: 6, endYear: 2026 };

const SAMPLE_ROW = {
  employee_id: 1, employee_code: 'EMP001', employee_name: 'Ravichandran',
  bu_name: 'IBM',
  service_po_id: 301, service_po_code: 'SPO-301', service_po_name: 'Capital-M',
  client_id: 5, client_name: 'LIC',
  project_id: 9, project_name: 'Capital-M',
  project_managers: 'Balaji, Suresh',
  months: [
    { month: 4, year: 2026, cappedHours: 176, resourceBudgetHours: 130, loggedHours: 88, monthlyCtc: 4167, projectionPercentage: 73.86, actualPercentage: 50, contribution: 2083.5 },
    { month: 5, year: 2026, cappedHours: 176, resourceBudgetHours: 100, loggedHours: 42, monthlyCtc: 4500, projectionPercentage: 56.82, actualPercentage: 23.86, contribution: 1073.86 },
    { month: 6, year: 2026, cappedHours: 176, resourceBudgetHours: 0, loggedHours: 0, monthlyCtc: 0, projectionPercentage: 0, actualPercentage: 0, contribution: 0 },
  ],
};

test('getResourceCostUtilization: throws 422 when no month/year range is given', async () => {
  await assert.rejects(
    () => managementReportService.getResourceCostUtilization({}, [1]),
    (err) => { assert.equal(err.statusCode, 422); return true; }
  );
});

test('getResourceCostUtilization: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    managementReportRepo.getResourceCostUtilization = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, summary: [] };
    };

    await managementReportService.getResourceCostUtilization({ ...QUERY, businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: entityIds narrows companyIds via a real Entity->Company lookup', async () => {
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    let received;
    managementReportRepo.getResourceCostUtilization = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, summary: [] };
    };

    await managementReportService.getResourceCostUtilization({ ...QUERY, entityIds: '5,6' }, [1, 2, 3]);

    assert.deepEqual(received.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: employeeId/clientId/poId/projectManagerId singular+comma-list aliases all parse into the repo\'s multi-select arrays', async () => {
  try {
    let received;
    managementReportRepo.getResourceCostUtilization = async (filters) => {
      received = filters;
      return { rows: [], count: 0, summary: [] };
    };

    await managementReportService.getResourceCostUtilization({
      ...QUERY,
      employeeId: '1,2,3',
      clientId: '5',
      poId: '301,302',
      projectManagerId: '9',
    }, [1]);

    assert.deepEqual(received.employeeIds, [1, 2, 3]);
    assert.deepEqual(received.clientIds, [5]);
    assert.deepEqual(received.poIds, [301, 302]);
    assert.deepEqual(received.projectManagerIds, [9]);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: shapes a roster row into { months[], monthlyCtc from first month, expectedCtc/billedStatus null, projectManagers as array }', async () => {
  try {
    managementReportRepo.getResourceCostUtilization = async () => ({
      rows: [SAMPLE_ROW], count: 1, summary: [],
    });

    const { data } = await managementReportService.getResourceCostUtilization(QUERY, [1]);

    assert.equal(data.length, 1);
    const row = data[0];
    assert.equal(row.employeeCode, 'EMP001');
    assert.equal(row.expectedCtc, null);
    assert.equal(row.billedStatus, null);
    assert.equal(row.monthlyCtc, 4167); // first month's own CTC, not a fixed/blended value
    assert.deepEqual(row.projectManagers, ['Balaji', 'Suresh']); // merged, not duplicated into separate rows
    assert.equal(row.months.length, 3);
    assert.equal(row.months[0].month, 'Apr');
    assert.equal(row.months[1].month, 'May');
    assert.equal(row.months[1].monthlyCtc, 4500); // each month keeps its OWN Monthly CTC for Contribution
    assert.equal(row.months[1].contribution, 1073.86);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: summary rows are reshaped with camelCase keys and month labels', async () => {
  try {
    managementReportRepo.getResourceCostUtilization = async () => ({
      rows: [],
      count: 0,
      summary: [
        { month: 4, year: 2026, resource_count: '3', service_po_count: '2', total_resource_budget_hours: '230', total_logged_hours: '130', total_contribution: '3157.36' },
      ],
    });

    const { summary } = await managementReportService.getResourceCostUtilization(QUERY, [1]);

    assert.equal(summary.length, 1);
    assert.equal(summary[0].month, 'Apr');
    assert.equal(summary[0].resourceCount, 3);
    assert.equal(summary[0].totalContribution, 3157.36);
  } finally {
    restore();
  }
});

test('exportResourceCostUtilization: calls the repo with exportAll=true and skips pagination in the response', async () => {
  try {
    let received;
    managementReportRepo.getResourceCostUtilization = async (filters) => {
      received = filters;
      return { rows: [SAMPLE_ROW], count: 1, summary: [] };
    };

    const result = await managementReportService.exportResourceCostUtilization(QUERY, [1]);

    assert.equal(received.exportAll, true);
    assert.equal(result.data.length, 1);
    assert.equal(result.meta, undefined);
    assert.deepEqual(result.period, { startMonth: 4, startYear: 2026, endMonth: 6, endYear: 2026 });
  } finally {
    restore();
  }
});
