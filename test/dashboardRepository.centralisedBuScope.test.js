'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: /dashboard/analytics tiles.active_employees/active_clients/
// active_service_pos ignored a narrowed businessUnitIds (72 employees for a
// 5-person Sub-BU) because the timesheet BU filter had a bare
// `OR sp.company_id IS NULL`, pulling in every Centralised-PO row (Leaves,
// On Bench, ...) from every BU. Such rows must now only count when the
// employee belongs to the scoped BUs.
const { sequelize } = require('../src/models');
const dashboardRepository = require('../src/repositories/dashboardRepository');

test('getAnalyticsTiles(): Centralised-PO rows are scoped by the employee\'s BU membership, never a bare IS NULL', async () => {
  const originalQuery = sequelize.query;
  const captured = [];
  sequelize.query = async (sql, opts) => {
    captured.push({ sql, replacements: opts && opts.replacements });
    return [{}];
  };

  try {
    await dashboardRepository.getAnalyticsTiles({
      startDate: '2026-04-01', endDate: '2027-03-31', companyId: [42], hoursSource: 'M',
    });

    const tilesSql = captured[0].sql.replace(/\s+/g, ' ');
    assert.match(tilesSql, /sp\.company_id IS NULL AND EXISTS \( SELECT 1 FROM employee_business_units ebu_scope/);
    assert.match(tilesSql, /ebu_scope\.business_unit_id IN \(:companyId\)/);
    assert.doesNotMatch(tilesSql, /OR sp\.company_id IS NULL\)/);
    assert.deepEqual(captured[0].replacements.companyId, [42]);
  } finally {
    sequelize.query = originalQuery;
  }
});
