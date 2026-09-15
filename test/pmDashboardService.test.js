'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePeriod,
  computeRiskFlag,
  DEFAULT_VARIANCE_THRESHOLD_PCT,
} = require('../src/services/pmDashboardService');

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
