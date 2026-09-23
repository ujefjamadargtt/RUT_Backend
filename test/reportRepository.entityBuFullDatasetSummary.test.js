'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const reportRepository = require('../src/repositories/reportRepository');

/**
 * Multi-Value Entity/BU Filtering + Aggregation — pilot report repo
 * functions (reportRepository.getMonthlyCostSummary/getResourceMonthlyUtilization).
 * Covers two things the plan called out explicitly:
 *
 * 1. Full-dataset (not per-page) totals/summary — a NEW unpaginated query
 *    alongside the existing paginated dataQuery/countQuery, same
 *    WHERE/replacements, minus LIMIT/OFFSET.
 * 2. The empty-companyIds guard: unlike the ORM's Op.in (which safely
 *    degrades an empty array to `IN (NULL)`), this file's raw
 *    sequelize.query() + named `IN (:companyIds)` replacement turns an
 *    empty array into a literal `IN ()` — a Postgres syntax error. Every
 *    caller reachable with an all-unauthorized entityIds/businessUnitIds
 *    filter (intersectIds/intersectCompanyIdsWithEntity intersecting down
 *    to []) must short-circuit before ever building that SQL.
 */

const originalQuery = sequelize.query;
function restore() {
  sequelize.query = originalQuery;
}

test('getMonthlyCostSummary: an empty companyIds array short-circuits to zero rows/totals WITHOUT ever calling sequelize.query (avoids the "IN ()" syntax error)', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await reportRepository.getMonthlyCostSummary({ companyIds: [], limit: 20, offset: 0 });

    assert.equal(queried, false);
    assert.deepEqual(result, {
      rows: [],
      count: 0,
      totals: { total_salary_cost: 0, total_ops_cost: 0, total_cost: 0, total_billable_cost: 0 },
    });
  } finally {
    restore();
  }
});

test('getMonthlyCostSummary: runs a THIRD unpaginated totals query (same WHERE, no GROUP BY/LIMIT/OFFSET) alongside dataQuery/countQuery', async () => {
  try {
    const sql = [];
    sequelize.query = async (statement, options) => {
      sql.push({ statement, replacements: options.replacements });
      if (sql.length === 3) {
        return [{ employee_count: '5', total_salary_cost: '1000.50', total_ops_cost: '200.25', total_cost: '1200.75', total_billable_cost: '900.00' }];
      }
      if (statement.includes('COUNT(*) AS total')) return [{ total: '2' }];
      return [{ month_year: '2026-08' }];
    };

    const result = await reportRepository.getMonthlyCostSummary({ companyIds: [1, 2], limit: 20, offset: 0 });

    assert.equal(sql.length, 3);
    // Every query shares the same company scope replacement.
    for (const { replacements } of sql) {
      assert.deepEqual(replacements.companyIds, [1, 2]);
    }
    // The totals query must not paginate or group — it's a full-dataset aggregate.
    const totalsSql = sql[2].statement;
    assert.doesNotMatch(totalsSql, /GROUP BY/);
    assert.doesNotMatch(totalsSql, /LIMIT/);
    assert.match(totalsSql, /SUM\(mc\.salary_cost\)/);

    assert.deepEqual(result.totals, {
      total_salary_cost: 1000.5,
      total_ops_cost: 200.25,
      total_cost: 1200.75,
      total_billable_cost: 900,
    });
  } finally {
    restore();
  }
});

test('getResourceMonthlyUtilization: an empty companyIds array short-circuits to an empty result WITHOUT ever calling sequelize.query', async () => {
  try {
    let queried = false;
    sequelize.query = async () => { queried = true; return []; };

    const result = await reportRepository.getResourceMonthlyUtilization({
      month: 8, year: 2026, companyIds: [], limit: 20, offset: 0,
    });

    assert.equal(queried, false);
    assert.deepEqual(result.columns, []);
    assert.deepEqual(result.rows, []);
    assert.equal(result.count, 0);
    assert.deepEqual(result.summary, {
      billable_total: 0, non_billable_total: 0, total_hours: 0, leaves_hours: 0, total_utilization: 0, employee_count: 0,
    });
  } finally {
    restore();
  }
});

test('getResourceMonthlyUtilization: runs a FOURTH unpaginated summary query classifying billable/leave hours the same way buildPivotResponse does, and the summary is not scoped to the emp_page CTE\'s LIMIT/OFFSET', async () => {
  try {
    const sql = [];
    sequelize.query = async (statement, options) => {
      sql.push({ statement, replacements: options.replacements });
      if (statement.includes('SELECT DISTINCT') && statement.includes('category_id')) return []; // columnsQuery
      if (statement.includes('COUNT(DISTINCT t.employee_id) AS total')) return [{ total: '1' }]; // countQuery
      if (statement.includes('WITH emp_page')) return []; // dataQuery (page)
      // summaryQuery — the full-dataset aggregate.
      return [{ employee_count: '10', billable_total: '1500.0000', non_billable_total: '260.0000', leaves_hours: '40.0000' }];
    };

    const result = await reportRepository.getResourceMonthlyUtilization({
      month: 8, year: 2026, companyIds: [1], limit: 1, offset: 0,
    });

    const summaryCall = sql.find((s) => s.statement.includes('employee_count') && !s.statement.includes('WITH emp_page'));
    assert.ok(summaryCall, 'expected a dedicated summary query');
    assert.doesNotMatch(summaryCall.statement, /LIMIT :limit/);
    assert.match(summaryCall.statement, /billable_total/);

    assert.deepEqual(result.summary, {
      billable_total: 1500,
      non_billable_total: 260,
      total_hours: 1760,
      leaves_hours: 40,
      total_utilization: 1720,
      employee_count: 10,
    });
  } finally {
    restore();
  }
});
