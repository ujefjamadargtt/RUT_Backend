'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const managementReportRepository = require('../src/repositories/managementReportRepository');

const originalQuery = sequelize.query;
function restore() {
  sequelize.query = originalQuery;
}

const FILTERS = { startMonth: 4, startYear: 2026, endMonth: 6, endYear: 2026, limit: 20, offset: 0 };

test('getResourceCostUtilization: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await managementReportRepository.getResourceCostUtilization({ ...FILTERS, companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result, { rows: [], count: 0, summary: [] });
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: a non-empty companyIds runs the data/count/summary queries (three total)', async () => {
  try {
    const calls = [];
    sequelize.query = async (sql) => {
      calls.push(sql);
      if (sql.includes('SELECT COUNT(*) AS total FROM roster')) return [{ total: '0' }];
      if (sql.includes('EXTRACT(MONTH FROM m.month_start)::int AS month') && sql.includes('GROUP BY m.month_start')) return [];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({ ...FILTERS, companyIds: [1, 2] });

    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: defaults to excluding non-billable Service POs (sp.is_billable = true)', async () => {
  try {
    let dataSql;
    sequelize.query = async (sql) => {
      if (!dataSql && sql.includes('json_agg')) dataSql = sql;
      if (sql.includes('SELECT COUNT(*)')) return [{ total: '0' }];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({ ...FILTERS, companyIds: [1] });

    assert.match(dataSql, /sp\.is_billable = true/);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: isBillable="all" omits the is_billable filter entirely', async () => {
  try {
    let dataSql;
    sequelize.query = async (sql) => {
      if (!dataSql && sql.includes('json_agg')) dataSql = sql;
      if (sql.includes('SELECT COUNT(*)')) return [{ total: '0' }];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({ ...FILTERS, companyIds: [1], isBillable: 'all' });

    assert.doesNotMatch(dataSql, /sp\.is_billable = true/);
    assert.doesNotMatch(dataSql, /sp\.is_billable = :isBillable/);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: projectManagerIds filters via is_project_manager=true EXISTS clause, never by mere mapping', async () => {
  try {
    let dataSql;
    let replacements;
    sequelize.query = async (sql, opts) => {
      if (!dataSql && sql.includes('json_agg')) { dataSql = sql; replacements = opts.replacements; }
      if (sql.includes('SELECT COUNT(*)')) return [{ total: '0' }];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({
      ...FILTERS, companyIds: [1], projectManagerIds: [42, 43],
    });

    assert.match(dataSql, /f_pm_esm\.is_project_manager = true/);
    assert.deepEqual(replacements.projectManagerIds, [42, 43]);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: exportAll=true omits LIMIT/OFFSET from the roster_page CTE', async () => {
  try {
    let dataSql;
    sequelize.query = async (sql) => {
      if (!dataSql && sql.includes('json_agg')) dataSql = sql;
      if (sql.includes('SELECT COUNT(*)')) return [{ total: '0' }];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({ ...FILTERS, companyIds: [1], exportAll: true });

    const rosterPageBlock = dataSql.slice(dataSql.indexOf('roster_page AS'), dataSql.indexOf('SELECT', dataSql.indexOf('roster_page AS') + 1));
    assert.doesNotMatch(rosterPageBlock, /LIMIT :limit OFFSET :offset/);
  } finally {
    restore();
  }
});

test('getResourceCostUtilization: employeeIds/clientIds/projectIds/poIds each append a scoped IN(...) condition', async () => {
  try {
    let dataSql;
    let replacements;
    sequelize.query = async (sql, opts) => {
      if (!dataSql && sql.includes('json_agg')) { dataSql = sql; replacements = opts.replacements; }
      if (sql.includes('SELECT COUNT(*)')) return [{ total: '0' }];
      return [];
    };

    await managementReportRepository.getResourceCostUtilization({
      ...FILTERS, companyIds: [1],
      employeeIds: [10], clientIds: [20], projectIds: [30], poIds: [40],
    });

    assert.match(dataSql, /e\.id IN \(:employeeIds\)/);
    assert.match(dataSql, /c\.id IN \(:clientIds\)/);
    assert.match(dataSql, /p\.id IN \(:projectIds\)/);
    assert.match(dataSql, /sp\.id IN \(:poIds\)/);
    assert.deepEqual(replacements.employeeIds, [10]);
    assert.deepEqual(replacements.clientIds, [20]);
    assert.deepEqual(replacements.projectIds, [30]);
    assert.deepEqual(replacements.poIds, [40]);
  } finally {
    restore();
  }
});
