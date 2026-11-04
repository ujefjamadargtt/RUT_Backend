'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/teamLeadEmployeePoHoursReportRepository');
const service = require('../src/services/teamLeadEmployeePoHoursReportService');

// Same monkey-patch style as the other service tests: the service holds a live reference to this
// module-cached repository object.
const ORIGINAL = { ...repository };
const restore = () => Object.assign(repository, ORIGINAL);

const EMPLOYEES = [
  { employee_id: 1, employee_code: 'E1', full_name: 'Om', mapping_type: 'PRIMARY' },
  { employee_id: 2, employee_code: 'E2', full_name: 'Prath', mapping_type: 'PRIMARY, SECONDARY' },
];
const PO = (id, name, extra = {}) => ({
  service_po_id: id, service_po_code: `C${id}`, service_po_name: name, is_centralised: false,
  client_id: 1, client_name: 'Client', project_id: 1, project_name: 'Project',
  bu_id: 10, bu_name: 'BU', sub_bu_id: null, sub_bu_name: null, ...extra,
});

function stubRepo({ mapped = [], original = [], adjusted = [], sync = true, pos = [] } = {}) {
  const calls = {};
  repository.findMappedEmployees = async (a) => { calls.employees = a; return EMPLOYEES; };
  repository.findMappedPos = async (ids, f) => { calls.mapped = { ids, f }; return mapped; };
  repository.findOriginalHours = async (ids, p, f) => { calls.original = { ids, p, f }; return original; };
  repository.findAdjustedHours = async (ids, p, f) => { calls.adjusted = { ids, p, f }; return adjusted; };
  repository.hasSyncedData = async () => sync;
  repository.findPoColumns = async (ids) => { calls.columnIds = ids; return pos.filter((p) => ids.includes(p.service_po_id)); };
  return calls;
}

test('matrix: a PO mapped to only one employee is still a column for everyone, shared POs appear once', async () => {
  const calls = stubRepo({
    mapped: [
      { employee_id: 1, service_po_id: 100 }, { employee_id: 1, service_po_id: 300 }, // Om: ABC, PQR
      { employee_id: 2, service_po_id: 200 }, { employee_id: 2, service_po_id: 100 }, // Prath: XYZ (+ shared ABC)
    ],
    original: [{ employee_id: 1, service_po_id: 100, hours: '4.00' }, { employee_id: 1, service_po_id: 300, hours: '2.00' }, { employee_id: 2, service_po_id: 200, hours: '8.00' }],
    pos: [PO(100, 'ABC'), PO(200, 'XYZ'), PO(300, 'PQR')],
  });
  const res = await service.getReport({ month: 9, year: 2026 }, 7);

  assert.equal(calls.employees.managerEmployeeId, 7);
  assert.deepEqual(calls.columnIds.slice().sort(), [100, 200, 300]);
  assert.deepEqual(res.columns.map((c) => c.service_po_name), ['ABC', 'XYZ', 'PQR']);
  const om = res.data.find((r) => r.employee_name === 'Om');
  assert.deepEqual(om.hours, { 100: 4, 200: 0, 300: 2 });
  assert.deepEqual(om.mapped_po_ids.sort(), [100, 300]);
  const prath = res.data.find((r) => r.employee_name === 'Prath');
  assert.deepEqual(prath.hours, { 100: 0, 200: 8, 300: 0 });
  assert.equal(res.totals.by_po[100], 4);
  assert.equal(res.totals.grand_total, 14);
  assert.equal(res.hours_basis, 'original');
  assert.equal(res.message, null);
  restore();
});

test('Cross-BU / Centralised POs with hours but no mapping still become columns', async () => {
  stubRepo({
    original: [{ employee_id: 1, service_po_id: 500, hours: '3.50' }, { employee_id: 1, service_po_id: 600, hours: '1.00' }],
    pos: [PO(500, 'Other BU PO', { bu_id: 99, bu_name: 'Other BU' }), PO(600, 'Leave', { is_centralised: true, bu_id: null, bu_name: null })],
  });
  const res = await service.getReport({ month: 9, year: 2026 }, 7);
  assert.deepEqual(res.columns.map((c) => [c.service_po_name, c.is_centralised]), [['Other BU PO', false], ['Leave', true]]);
  assert.equal(res.data.find((r) => r.employee_name === 'Om').total_hours, 4.5);
  restore();
});

test('adjusted with no synced timesheets returns the message and zero hours (employees/columns still listed)', async () => {
  const calls = stubRepo({ sync: false, mapped: [{ employee_id: 1, service_po_id: 100 }], pos: [PO(100, 'ABC')] });
  const res = await service.getReport({ month: 9, year: 2026, hoursBasis: 'adjusted' }, 7);
  assert.equal(res.sync_available, false);
  assert.equal(res.message, service.NO_SYNC_MESSAGE);
  assert.equal(calls.adjusted, undefined, 'must not query adjusted hours when nothing is synced');
  assert.equal(res.totals.grand_total, 0);
  assert.equal(res.columns.length, 1);
  restore();
});

test('adjusted with synced data reads the adjusted hours, not the original ones', async () => {
  stubRepo({
    sync: true,
    original: [{ employee_id: 1, service_po_id: 100, hours: '10.00' }],
    adjusted: [{ employee_id: 1, service_po_id: 100, hours: '8.00' }],
    pos: [PO(100, 'ABC')],
  });
  const res = await service.getReport({ month: 9, year: 2026, hoursBasis: 'adjusted' }, 7);
  assert.equal(res.sync_available, true);
  assert.equal(res.message, null);
  assert.equal(res.data.find((r) => r.employee_name === 'Om').hours[100], 8);
  restore();
});

test('filters are parsed and forwarded; a PO-level filter drops employees unrelated to every in-scope PO', async () => {
  const calls = stubRepo({ mapped: [{ employee_id: 1, service_po_id: 100 }], pos: [PO(100, 'ABC')] });
  const res = await service.getReport({
    month: 9, year: 2026, employeeIds: '1,2', clientIds: '5', projectIds: '6,7', servicePoIds: '100',
    entityIds: '3', buIds: '10', subBuIds: '11', search: 'om',
  }, 7);
  assert.deepEqual(calls.employees.employeeIds, [1, 2]);
  assert.equal(calls.employees.search, 'om');
  assert.deepEqual(calls.mapped.f, {
    employeeIds: [1, 2], clientIds: [5], projectIds: [6, 7], servicePoIds: [100],
    entityIds: [3], buIds: [10], subBuIds: [11], search: 'om',
  });
  assert.deepEqual(res.data.map((r) => r.employee_name), ['Om'], 'Prath has no in-scope PO');
  restore();
});

test('no PO-level filter keeps employees that have no POs (zero row)', async () => {
  stubRepo({ mapped: [{ employee_id: 1, service_po_id: 100 }], pos: [PO(100, 'ABC')] });
  const res = await service.getReport({ month: 9, year: 2026 }, 7);
  assert.deepEqual(res.data.map((r) => r.employee_name), ['Om', 'Prath']);
  restore();
});

test('period defaults to the current month and honours month+year and a start/end range', async () => {
  const calls = stubRepo();
  await service.getReport({ month: 2, year: 2026 }, 7);
  assert.deepEqual(calls.original.p, { startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.deepEqual(service.resolvePeriod({ month: 2, year: 2026 }), { startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.deepEqual(service.resolvePeriod({ startDate: '2026-03-05', endDate: '2026-03-09' }), { startDate: '2026-03-05', endDate: '2026-03-09' });
  const cur = service.resolvePeriod({});
  assert.match(cur.startDate, /^\d{4}-\d{2}-01$/);
  restore();
});
