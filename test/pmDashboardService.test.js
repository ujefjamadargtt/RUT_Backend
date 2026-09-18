'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePeriod,
  resolvePreviousPeriod,
  resolvePendingApprovalScope,
  computeRiskFlag,
  tallyProjectStatusBreakdown,
  sumHealthBuckets,
  DEFAULT_VARIANCE_THRESHOLD_PCT,
  AT_RISK_HEALTH_STATUSES,
  PREVIOUS_PERIOD_UNAVAILABLE_FIELDS,
} = require('../src/services/pmDashboardService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

// Timesheet Approval redesign: the PM Dashboard's "pending_approvals"
// KPI/list must follow the NEW Service-PO-based approval scope for a
// Project Manager (hierarchy_rank 6) caller, while every other tier
// (Admin/Entity Admin/BU Admin/Project Admin) keeps using the dashboard's
// existing, wider team_mappings-aware employeeIds — unchanged.
test('resolvePendingApprovalScope: Project Manager (rank 6) gets Service-PO-scoped, not the dashboard\'s wide employeeIds', async () => {
  const original = employeeServicePOMappingService.getProjectManagerServicePOIds;
  try {
    employeeServicePOMappingService.getProjectManagerServicePOIds = async (employeeId) => {
      assert.equal(employeeId, 501);
      return [201, 202];
    };

    const scope = await resolvePendingApprovalScope({ hierarchyRank: 6, employeeId: 501 }, [101, 102, 103]);

    assert.deepEqual(scope, { employeeIds: null, servicePoIds: [201, 202] });
  } finally {
    employeeServicePOMappingService.getProjectManagerServicePOIds = original;
  }
});

test('resolvePendingApprovalScope: every non-Project-Manager tier keeps the dashboard\'s existing wide employeeIds unchanged', async () => {
  for (const hierarchyRank of [1, 2, 3, 4, 5, 7, null]) {
    const scope = await resolvePendingApprovalScope({ hierarchyRank, employeeId: 999 }, [101, 102, 103]);
    assert.deepEqual(scope, { employeeIds: [101, 102, 103], servicePoIds: null }, `rank ${hierarchyRank} must be unaffected`);
  }
});

test('resolvePeriod defaults to the current server month/year when omitted', () => {
  const now = new Date();
  const { monthNum, yearNum } = resolvePeriod({});
  assert.equal(monthNum, now.getMonth() + 1);
  assert.equal(yearNum, now.getFullYear());
});

test('resolvePeriod uses the explicit month/year when given', () => {
  const { monthNum, yearNum } = resolvePeriod({ month: '3', year: '2026' });
  assert.equal(monthNum, 3);
  assert.equal(yearNum, 2026);
});

test('resolvePeriod rejects an out-of-range month', () => {
  assert.throws(() => resolvePeriod({ month: '13', year: '2026' }), /month must be between 1 and 12/);
});

test('computeRiskFlag: overdue Service PO alone flags the Project at risk', () => {
  const row = { overdue_po_count: 1, variance_pct: null };
  assert.equal(computeRiskFlag(row, DEFAULT_VARIANCE_THRESHOLD_PCT), true);
});

test('computeRiskFlag: variance at/above threshold flags the Project at risk', () => {
  const row = { overdue_po_count: 0, variance_pct: '-25.00' };
  assert.equal(computeRiskFlag(row, 20), true);
});

test('computeRiskFlag: variance below threshold and no overdue POs is not at risk', () => {
  const row = { overdue_po_count: 0, variance_pct: '5.00' };
  assert.equal(computeRiskFlag(row, 20), false);
});

test('computeRiskFlag: null variance (no planned hours) and no overdue POs is not at risk', () => {
  const row = { overdue_po_count: 0, variance_pct: null };
  assert.equal(computeRiskFlag(row, 20), false);
});

test('resolvePreviousPeriod: rolls back within the same year', () => {
  const { prevMonthNum, prevYearNum, prevAsOfDate } = resolvePreviousPeriod(9, 2026);
  assert.equal(prevMonthNum, 8);
  assert.equal(prevYearNum, 2026);
  // Last calendar day of August 2026.
  assert.equal(prevAsOfDate.getFullYear(), 2026);
  assert.equal(prevAsOfDate.getMonth(), 7); // 0-indexed August
  assert.equal(prevAsOfDate.getDate(), 31);
});

test('resolvePreviousPeriod: January rolls back into December of the prior year', () => {
  const { prevMonthNum, prevYearNum, prevAsOfDate } = resolvePreviousPeriod(1, 2026);
  assert.equal(prevMonthNum, 12);
  assert.equal(prevYearNum, 2025);
  assert.equal(prevAsOfDate.getFullYear(), 2025);
  assert.equal(prevAsOfDate.getMonth(), 11); // 0-indexed December
  assert.equal(prevAsOfDate.getDate(), 31);
});

test('tallyProjectStatusBreakdown: returns all 4 buckets, zero-filled, for an empty portfolio', () => {
  const breakdown = tallyProjectStatusBreakdown([]);
  assert.deepEqual(breakdown, [
    { status: 'on_track', count: 0 },
    { status: 'at_risk', count: 0 },
    { status: 'delayed', count: 0 },
    { status: 'inactive', count: 0 },
  ]);
});

test('tallyProjectStatusBreakdown: counts each row into its own bucket', () => {
  const rows = [
    { health_status: 'on_track' },
    { health_status: 'on_track' },
    { health_status: 'at_risk' },
    { health_status: 'delayed' },
    { health_status: 'inactive' },
  ];
  const breakdown = tallyProjectStatusBreakdown(rows);
  const asMap = Object.fromEntries(breakdown.map((b) => [b.status, b.count]));
  assert.deepEqual(asMap, { on_track: 2, at_risk: 1, delayed: 1, inactive: 1 });
});

test('tallyProjectStatusBreakdown: an unrecognized health_status falls back to on_track rather than being dropped', () => {
  const breakdown = tallyProjectStatusBreakdown([{ health_status: 'something_unexpected' }]);
  const asMap = Object.fromEntries(breakdown.map((b) => [b.status, b.count]));
  assert.equal(asMap.on_track, 1);
});

test('sumHealthBuckets: at_risk_projects sums exactly the at_risk + delayed buckets', () => {
  const breakdown = [
    { status: 'on_track', count: 5 },
    { status: 'at_risk', count: 2 },
    { status: 'delayed', count: 3 },
    { status: 'inactive', count: 1 },
  ];
  assert.equal(sumHealthBuckets(breakdown, AT_RISK_HEALTH_STATUSES), 5);
});

test('PREVIOUS_PERIOD_UNAVAILABLE_FIELDS documents exactly team_size and active_projects', () => {
  assert.deepEqual(PREVIOUS_PERIOD_UNAVAILABLE_FIELDS, ['team_size', 'active_projects']);
});
