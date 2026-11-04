'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const repo = require('../src/repositories/managementReportRepository');

const originalQuery = sequelize.query;
const FILTERS = { startMonth: 8, startYear: 2026, endMonth: 8, endYear: 2026, limit: 20, offset: 0, companyIds: [1] };

// Returns the ORDER BY clause of the paginated data query (the one with LIMIT).
async function orderByOf(fn, filters) {
  let dataSql = '';
  sequelize.query = async (sql) => {
    if (sql.includes('LIMIT :limit')) dataSql = sql;
    if (sql.includes('COUNT(*)')) return [{ total: '0' }];
    return [];
  };
  try {
    await fn({ ...FILTERS, ...filters });
  } finally {
    sequelize.query = originalQuery;
  }
  // Last ORDER BY = the outer one (earlier ones live inside CTEs / json_agg).
  const all = [...dataSql.matchAll(/ORDER BY\s+(\S+)\s+(ASC|DESC)/g)];
  const m = all[all.length - 1];
  return m && m[1];
}

const CASES = [
  ['getPMWiseUtilization', 'total_logged_hours', 'original_total_logged_hours'],
  ['getPMWiseUtilization', 'utilization_pct', 'original_utilization_pct'],
  ['getProjectWiseUtilization', 'total_logged_hours', 'original_total_logged_hours'],
  ['getProjectWiseUtilization', 'utilization_pct', 'original_utilization_pct'],
  ['getResourceWiseBench', 'avg_bench_pct', 'original_avg_bench_pct'],
];

for (const [fn, sortBy, twin] of CASES) {
  test(`${fn}: sortBy=${sortBy} sorts by ${twin} only when hoursSource=O`, async () => {
    assert.equal(await orderByOf(repo[fn], { sortBy, hoursSource: 'O' }), twin);
    assert.equal(await orderByOf(repo[fn], { sortBy, hoursSource: 'M' }), sortBy);
    assert.equal(await orderByOf(repo[fn], { sortBy }), sortBy);
    assert.equal(await orderByOf(repo[fn], { sortBy, hoursSource: 'garbage' }), sortBy);
  });
}

test('hoursSource=O leaves non-hours sort keys and invalid keys on the allow-list', async () => {
  assert.equal(await orderByOf(repo.getPMWiseUtilization, { sortBy: 'pm_name', hoursSource: 'O' }), 'pm_name');
  assert.equal(await orderByOf(repo.getPMWiseUtilization, { sortBy: 'x; DROP TABLE y', hoursSource: 'O' }), 'original_utilization_pct');
  assert.equal(await orderByOf(repo.getResourceWiseBench, { sortBy: 'full_name', hoursSource: 'O' }), 'full_name');
});
