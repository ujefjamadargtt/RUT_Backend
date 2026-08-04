'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateRangeRowsByServicePO } = require('../src/services/employeeReportService');

// Minimal work-log fixture — only the fields aggregateRangeRowsByServicePO reads.
function workLog(overrides) {
  return {
    work_date: '2026-08-04',
    service_po_id: 293,
    hierarchy_node_id: null,
    hours: '0.00',
    description: '',
    status: 'pending',
    servicePO: { service_po_name: 'rut portal', service_po_code: 'PO-20260804-NR93' },
    ...overrides,
  };
}

test('ticket example: PO=2hrs + Parent=3hrs + Child=4hrs collapses to ONE row totalling 9hrs, with description/status kept', () => {
  const rows = [
    workLog({ hierarchy_node_id: null, hours: '2.00', description: 'rut portal', status: 'pending' }),
    workLog({ hierarchy_node_id: 1, hours: '3.00', description: 'Parent 1 work', status: 'pending' }),
    workLog({ hierarchy_node_id: 2, hours: '4.00', description: 'Child 1 work', status: 'pending' }),
  ];

  const result = aggregateRangeRowsByServicePO(rows);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    date: '2026-08-04',
    project: 'rut portal',
    servicePO: 'PO-20260804-NR93',
    hours: 9,
    description: 'rut portal',
    status: 'pending',
  });
});

test('description/status come from the DIRECT (no hierarchy_node_id) entry, never concatenated', () => {
  const rows = [
    workLog({ hierarchy_node_id: 1, hours: '1.00', description: 'Parent description', status: 'synced' }),
    workLog({ hierarchy_node_id: null, hours: '2.00', description: 'Main PO description', status: 'pending' }),
    workLog({ hierarchy_node_id: 2, hours: '1.00', description: 'Child description', status: 'synced' }),
  ];

  const result = aggregateRangeRowsByServicePO(rows);

  assert.equal(result.length, 1);
  assert.equal(result[0].description, 'Main PO description');
  assert.equal(result[0].status, 'pending');
  assert.equal(result[0].hours, 4);
});

test('no direct PO-level entry exists -> falls back to the first entry in the group', () => {
  const rows = [
    workLog({ hierarchy_node_id: 1, hours: '3.00', description: 'Parent 1 desc', status: 'synced' }),
    workLog({ hierarchy_node_id: 2, hours: '4.00', description: 'Child 1 desc', status: 'pending' }),
  ];

  const result = aggregateRangeRowsByServicePO(rows);

  assert.equal(result.length, 1);
  assert.equal(result[0].description, 'Parent 1 desc');
  assert.equal(result[0].status, 'synced');
  assert.equal(result[0].hours, 7);
});

test('multiple days: same Service PO aggregated independently per date, never merged (ticket example)', () => {
  const rows = [
    // 04-Aug: 2 + 3 + 1 = 6 hrs
    workLog({ work_date: '2026-08-04', hierarchy_node_id: null, hours: '2.00' }),
    workLog({ work_date: '2026-08-04', hierarchy_node_id: 1, hours: '3.00' }),
    workLog({ work_date: '2026-08-04', hierarchy_node_id: 2, hours: '1.00' }),
    // 05-Aug: 4 + 2 = 6 hrs
    workLog({ work_date: '2026-08-05', hierarchy_node_id: null, hours: '4.00' }),
    workLog({ work_date: '2026-08-05', hierarchy_node_id: 1, hours: '2.00' }),
  ];

  const result = aggregateRangeRowsByServicePO(rows);

  assert.equal(result.length, 2);
  assert.equal(result.find((r) => r.date === '2026-08-04').hours, 6);
  assert.equal(result.find((r) => r.date === '2026-08-05').hours, 6);
});

test('a second, unrelated Service PO on the same date stays a SEPARATE row', () => {
  const rows = [
    workLog({ service_po_id: 293, hierarchy_node_id: null, hours: '2.00' }),
    workLog({ service_po_id: 293, hierarchy_node_id: 1, hours: '3.00' }),
    workLog({
      service_po_id: 310,
      hierarchy_node_id: null,
      hours: '1.00',
      description: 'other PO',
      status: 'synced',
      servicePO: { service_po_name: 'Other Project', service_po_code: 'PO-OTHER' },
    }),
  ];

  const result = aggregateRangeRowsByServicePO(rows);

  assert.equal(result.length, 2);
  const po293 = result.find((r) => r.servicePO === 'PO-20260804-NR93');
  const po310 = result.find((r) => r.servicePO === 'PO-OTHER');
  assert.equal(po293.hours, 5);
  assert.equal(po310.hours, 1);
  assert.equal(po310.status, 'synced');
});

test('no double-counting: total across aggregated rows equals the sum of all raw hours', () => {
  const rows = [
    workLog({ work_date: '2026-08-04', service_po_id: 293, hierarchy_node_id: null, hours: '2.00' }),
    workLog({ work_date: '2026-08-04', service_po_id: 293, hierarchy_node_id: 1, hours: '3.00' }),
    workLog({ work_date: '2026-08-05', service_po_id: 293, hierarchy_node_id: null, hours: '4.00' }),
    workLog({
      work_date: '2026-08-05',
      service_po_id: 310,
      hierarchy_node_id: null,
      hours: '1.50',
      servicePO: { service_po_name: 'Other', service_po_code: 'PO-OTHER' },
    }),
  ];

  const rawTotal = rows.reduce((sum, r) => sum + parseFloat(r.hours), 0);
  const result = aggregateRangeRowsByServicePO(rows);
  const aggregatedTotal = result.reduce((sum, r) => sum + r.hours, 0);

  assert.equal(aggregatedTotal, rawTotal);
});

test('empty input -> empty output', () => {
  assert.deepEqual(aggregateRangeRowsByServicePO([]), []);
});
