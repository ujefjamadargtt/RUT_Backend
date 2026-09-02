'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const repository = require('../src/repositories/employeeWorkLogHoursSummaryRepository');

const originalQuery = sequelize.query;

test('summary aggregates parent work-log hours in SQL and never joins time-entry rows', async () => {
  const sql = [];
  sequelize.query = async (statement) => {
    sql.push(statement);
    return sql.length === 1 ? [] : [{ count: 0 }];
  };

  await repository.getSummary({
    employeeIds: [1], startDate: '2026-08-01', endDate: '2026-08-31',
    sortBy: 'total_hours', sortOrder: 'DESC', limit: 10, offset: 0,
  });

  assert.match(sql[0], /SUM\(wl\.hours\)/);
  assert.doesNotMatch(sql[0], /employee_work_log_time_entries/);
  sequelize.query = originalQuery;
});

test('detail total is calculated from parent work-log rows, not expanded time-entry rows', async () => {
  const sql = [];
  sequelize.query = async (statement) => {
    sql.push(statement);
    if (sql.length === 1) return [];
    if (sql.length === 2) return [{ work_log_count: 1, total_hours: '2.50' }];
    return [{ count: 1 }];
  };

  await repository.getDetails({ employeeId: 1, startDate: '2026-08-28', endDate: '2026-08-28', limit: 20, offset: 0 });

  assert.match(sql[1], /SUM\(hours\)/);
  assert.doesNotMatch(sql[1], /employee_work_log_time_entries/);
  sequelize.query = originalQuery;
});
