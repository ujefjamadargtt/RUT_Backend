'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const managementReportRepository = require('../src/repositories/managementReportRepository');

const originalQuery = sequelize.query;
function restore() {
  sequelize.query = originalQuery;
}

const FILTERS = { startMonth: 8, startYear: 2026, endMonth: 8, endYear: 2026, limit: 20, offset: 0 };

test('getPMWiseUtilization: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await managementReportRepository.getPMWiseUtilization({ ...FILTERS, companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result, {
      rows: [],
      count: 0,
      summary: { total_resource_count: 0, total_project_count: 0, total_logged_hours: 0, total_available_hours: 0 },
    });
  } finally {
    restore();
  }
});

test('getProjectWiseUtilization: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await managementReportRepository.getProjectWiseUtilization({ ...FILTERS, companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result, {
      rows: [],
      count: 0,
      summary: { total_resource_count: 0, total_logged_hours: 0, total_available_hours: 0 },
    });
  } finally {
    restore();
  }
});

test('getPMWiseUtilization: a non-empty companyIds runs the data/count/summary queries (three total)', async () => {
  try {
    const calls = [];
    sequelize.query = async (sql) => {
      calls.push(sql);
      if (sql.includes('COUNT(*)')) return [{ total: '0' }];
      if (sql.includes('SUM(resource_count)')) return [{ total_resource_count: '0', total_project_count: '0', total_logged_hours: '0', total_available_hours: '0' }];
      return [];
    };

    await managementReportRepository.getPMWiseUtilization({ ...FILTERS, companyIds: [1, 2] });

    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});
