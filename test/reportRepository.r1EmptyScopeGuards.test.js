'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const reportRepository = require('../src/repositories/reportRepository');

/**
 * R1 batch — an empty companyIds array (every entityIds/businessUnitIds id
 * turned out to be outside the caller's reach) must short-circuit BEFORE
 * building any raw-SQL `IN (:companyIds)` clause, never reach
 * sequelize.query at all. See reportRepository.isEmptyCompanyScope()'s own
 * doc comment for why: unlike the ORM's Op.in, the raw-SQL replacement
 * idiom turns an empty array into a literal `IN ()`, a Postgres syntax
 * error, not a zero-row result.
 */

const originalQuery = sequelize.query;
function restore() {
  sequelize.query = originalQuery;
}

test('getMonthlyResourceUtilization: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await reportRepository.getMonthlyResourceUtilization({ month: 8, year: 2026, companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result.rows, []);
    assert.equal(result.count, 0);
    assert.ok(result.summary);
  } finally {
    restore();
  }
});

test('getEmployeeUtilizationSummary: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await reportRepository.getEmployeeUtilizationSummary({ month: 8, year: 2026, companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result.rows, []);
    assert.equal(result.count, 0);
    assert.deepEqual(result.summary, {
      billable_total: 0, non_billable_total: 0, internal_support_hours: 0,
      team_management_hours: 0, leaves_hours: 0, lnd_hours: 0, others_hours: 0,
    });
  } finally {
    restore();
  }
});

test('getResourceAllocation: empty companyIds short-circuits without querying', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await reportRepository.getResourceAllocation({ companyIds: [] });

    assert.equal(queried, false);
    assert.deepEqual(result, { rows: [], count: 0 });
  } finally {
    restore();
  }
});

test('getResourceUtilizationTrend (buildTrendFilters): empty companyIds queries with a safe 1=0 clause instead of IN ()', async () => {
  try {
    let capturedSql;
    sequelize.query = async (sql) => { capturedSql = sql; return []; };

    await reportRepository.getResourceUtilizationTrend({ companyIds: [], startDate: '2026-08-01', endDate: '2026-08-31' });

    assert.match(capturedSql, /1=0/);
    assert.doesNotMatch(capturedSql, /IN \(:companyIds\)/);
  } finally {
    restore();
  }
});

test('getResourceUtilizationTrend (buildTrendFilters): a non-empty companyIds still queries with the real IN clause (unchanged)', async () => {
  try {
    let capturedSql;
    let capturedReplacements;
    sequelize.query = async (sql, options) => { capturedSql = sql; capturedReplacements = options.replacements; return []; };

    await reportRepository.getResourceUtilizationTrend({ companyIds: [1, 2], startDate: '2026-08-01', endDate: '2026-08-31' });

    assert.match(capturedSql, /IN \(:companyIds\)/);
    assert.deepEqual(capturedReplacements.companyIds, [1, 2]);
  } finally {
    restore();
  }
});
