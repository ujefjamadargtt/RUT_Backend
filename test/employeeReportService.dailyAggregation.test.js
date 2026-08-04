'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateRowsByServicePO, DAILY_REPORT_COLUMNS } = require('../src/services/employeeReportService');

// Minimal work-log fixture — only the fields aggregateRowsByServicePO reads.
function workLog(overrides) {
  return {
    work_date: '2026-08-04',
    service_po_id: 293,
    hierarchy_node_id: null,
    hours: '0.00',
    description: 'irrelevant — not returned by the Daily report',
    status: 'pending',
    servicePO: { service_po_name: 'rut portal', service_po_code: 'PO-20260804-NR93' },
    ...overrides,
  };
}

test('ticket example: PO=2hrs + Parent=3hrs + Child=4hrs collapses to ONE row totalling 9hrs', () => {
  const rows = [
    workLog({ hierarchy_node_id: null, hours: '2.00' }),
    workLog({ hierarchy_node_id: 1, hours: '3.00' }),
    workLog({ hierarchy_node_id: 2, hours: '4.00' }),
  ];

  const result = aggregateRowsByServicePO(rows);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    date: '2026-08-04',
    project: 'rut portal',
    servicePO: 'PO-20260804-NR93',
    hours: 9,
  });
});

test('response rows never include description or status', () => {
  const rows = [workLog({ hierarchy_node_id: null, hours: '2.00' })];
  const result = aggregateRowsByServicePO(rows);

  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]).sort(), ['date', 'hours', 'project', 'servicePO']);
  assert.equal('description' in result[0], false);
  assert.equal('status' in result[0], false);
});

test('DAILY_REPORT_COLUMNS (used for Excel/CSV/PDF export headers) has no description/status column', () => {
  const keys = DAILY_REPORT_COLUMNS.map((c) => c.key);
  assert.deepEqual(keys, ['date', 'project', 'servicePO', 'hours']);
});

test('a second, unrelated Service PO on the same date stays a SEPARATE row (grouped by service_po_id, not just date)', () => {
  const rows = [
    workLog({ service_po_id: 293, hierarchy_node_id: null, hours: '2.00' }),
    workLog({ service_po_id: 293, hierarchy_node_id: 1, hours: '3.00' }),
    workLog({
      service_po_id: 310,
      hierarchy_node_id: null,
      hours: '1.00',
      servicePO: { service_po_name: 'Other Project', service_po_code: 'PO-OTHER' },
    }),
  ];

  const result = aggregateRowsByServicePO(rows);

  assert.equal(result.length, 2);
  const po293 = result.find((r) => r.servicePO === 'PO-20260804-NR93');
  const po310 = result.find((r) => r.servicePO === 'PO-OTHER');
  assert.equal(po293.hours, 5);
  assert.equal(po310.hours, 1);
});

test('the same Service PO on a DIFFERENT date is a separate row, not merged', () => {
  const rows = [
    workLog({ work_date: '2026-08-04', hierarchy_node_id: null, hours: '2.00' }),
    workLog({ work_date: '2026-08-05', hierarchy_node_id: null, hours: '5.00' }),
  ];

  const result = aggregateRowsByServicePO(rows);

  assert.equal(result.length, 2);
  assert.equal(result.find((r) => r.date === '2026-08-04').hours, 2);
  assert.equal(result.find((r) => r.date === '2026-08-05').hours, 5);
});

test('no double-counting: total across aggregated rows equals the sum of all raw hours', () => {
  const rows = [
    workLog({ service_po_id: 293, hierarchy_node_id: null, hours: '2.00' }),
    workLog({ service_po_id: 293, hierarchy_node_id: 1, hours: '3.00' }),
    workLog({ service_po_id: 293, hierarchy_node_id: 2, hours: '4.00' }),
    workLog({
      service_po_id: 310,
      hierarchy_node_id: null,
      hours: '1.50',
      servicePO: { service_po_name: 'Other', service_po_code: 'PO-OTHER' },
    }),
  ];

  const rawTotal = rows.reduce((sum, r) => sum + parseFloat(r.hours), 0);
  const result = aggregateRowsByServicePO(rows);
  const aggregatedTotal = result.reduce((sum, r) => sum + r.hours, 0);

  assert.equal(aggregatedTotal, rawTotal);
});

test('empty input -> empty output', () => {
  assert.deepEqual(aggregateRowsByServicePO([]), []);
});
