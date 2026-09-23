'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const managementReportRepo = require('../src/repositories/managementReportRepository');
const { Company } = require('../src/models');
const managementReportService = require('../src/services/managementReportService');

/**
 * R1 batch — pm-wise-utilization and project-wise-utilization. Both had a
 * page-level `rows.reduce(...)` summary; fixed to use the repo's new
 * full-dataset (unpaginated) summary query instead.
 */

const ORIGINAL = {
  getPMWiseUtilization: managementReportRepo.getPMWiseUtilization,
  getProjectWiseUtilization: managementReportRepo.getProjectWiseUtilization,
  companyFindAll: Company.findAll,
};

function restore() {
  managementReportRepo.getPMWiseUtilization = ORIGINAL.getPMWiseUtilization;
  managementReportRepo.getProjectWiseUtilization = ORIGINAL.getProjectWiseUtilization;
  Company.findAll = ORIGINAL.companyFindAll;
}

const QUERY = { startMonth: 8, startYear: 2026, endMonth: 8, endYear: 2026, month: 8, year: 2026 };

test('getPMWiseUtilization: businessUnitIds narrows companyIds before the repo call', async () => {
  try {
    let received;
    managementReportRepo.getPMWiseUtilization = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, summary: { total_resource_count: 0, total_project_count: 0, total_logged_hours: 0, total_available_hours: 0 } };
    };

    await managementReportService.getPMWiseUtilization({ ...QUERY, businessUnitIds: '2,999' }, [1, 2, 3]);

    assert.deepEqual(received, [2]);
  } finally {
    restore();
  }
});

test('getPMWiseUtilization: summary + utilization_pct come from the repo\'s full-dataset summary, not a page-level reduce', async () => {
  try {
    managementReportRepo.getPMWiseUtilization = async () => ({
      rows: [{ resource_count: 1, project_count: 1, total_logged_hours: '1', total_available_hours: '1' }], // page 1 only
      count: 10,
      summary: { total_resource_count: 40, total_project_count: 15, total_logged_hours: 800, total_available_hours: 1600 },
    });

    const { summary } = await managementReportService.getPMWiseUtilization(QUERY, [1]);

    assert.equal(summary.total_resource_count, 40);
    assert.equal(summary.total_logged_hours, 800);
    assert.equal(summary.utilization_pct, 50); // 800/1600*100, NOT derived from the single page-1 row
  } finally {
    restore();
  }
});

test('getProjectWiseUtilization: entityIds narrows companyIds via a real Entity->Company lookup', async () => {
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    let received;
    managementReportRepo.getProjectWiseUtilization = async (filters) => {
      received = filters.companyIds;
      return { rows: [], count: 0, summary: { total_resource_count: 0, total_logged_hours: 0, total_available_hours: 0 } };
    };

    await managementReportService.getProjectWiseUtilization({ ...QUERY, entityIds: '5,6' }, [1, 2, 3]);

    assert.deepEqual(received.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('getProjectWiseUtilization: summary comes from the repo\'s full-dataset summary, not a page-level reduce', async () => {
  try {
    managementReportRepo.getProjectWiseUtilization = async () => ({
      rows: [{ resource_count: 1, total_logged_hours: '1', total_available_hours: '1' }],
      count: 20,
      summary: { total_resource_count: 60, total_logged_hours: 900, total_available_hours: 1800 },
    });

    const { summary } = await managementReportService.getProjectWiseUtilization(QUERY, [1]);

    assert.equal(summary.total_resource_count, 60);
    assert.equal(summary.utilization_pct, 50);
  } finally {
    restore();
  }
});
