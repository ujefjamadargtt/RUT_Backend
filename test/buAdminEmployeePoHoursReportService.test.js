'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tlRepository = require('../src/repositories/teamLeadEmployeePoHoursReportRepository');
const scopeRepository = require('../src/repositories/poHoursEmployeeScopeRepository');
const service = require('../src/services/buAdminEmployeePoHoursReportService');
const { NO_SYNC_MESSAGE } = require('../src/services/teamLeadEmployeePoHoursReportService');

const TL_ORIGINAL = { ...tlRepository };
const SCOPE_ORIGINAL = { ...scopeRepository };
const restore = () => { Object.assign(tlRepository, TL_ORIGINAL); Object.assign(scopeRepository, SCOPE_ORIGINAL); };

const EMPLOYEES = [
  { employee_id: 1, employee_code: 'E1', full_name: 'Om', employee_bu_names: ['Tech'] },
  { employee_id: 2, employee_code: 'E2', full_name: 'Prath', employee_bu_names: ['Tech', 'Tech Sub'] },
];
const PO = (id, name, extra = {}) => ({
  service_po_id: id, service_po_code: `C${id}`, service_po_name: name, is_centralised: false,
  client_id: 1, client_name: 'Client', project_id: 1, project_name: 'Project',
  bu_id: 10, bu_name: 'Tech', sub_bu_id: null, sub_bu_name: null, ...extra,
});

function stub({ mapped = [], original = [], adjusted = [], sync = true, pos = [] } = {}) {
  const calls = {};
  scopeRepository.findBuScopeEmployees = async (a) => { calls.scope = a; return EMPLOYEES; };
  tlRepository.findMappedPos = async (ids, f) => { calls.mapped = { ids, f }; return mapped; };
  tlRepository.findOriginalHours = async () => original;
  tlRepository.findAdjustedHours = async () => adjusted;
  tlRepository.hasSyncedData = async () => sync;
  tlRepository.findPoColumns = async (ids) => pos.filter((p) => ids.includes(p.service_po_id));
  return calls;
}

test('rows come from the BU scope (companyIds), columns carry is_cross_bu, rows carry employee_bu_names', async () => {
  const calls = stub({
    mapped: [{ employee_id: 1, service_po_id: 100 }],
    original: [
      { employee_id: 1, service_po_id: 100, hours: '4.00' },
      { employee_id: 2, service_po_id: 200, hours: '2.50' },
      { employee_id: 2, service_po_id: 300, hours: '1.00' },
      { employee_id: 2, service_po_id: 400, hours: '1.00' },
      { employee_id: 2, service_po_id: 500, hours: '1.00' },
    ],
    pos: [
      PO(100, 'Own BU PO'),
      PO(200, 'Other BU PO', { bu_id: 99, bu_name: 'Other' }),
      PO(300, 'Leave', { is_centralised: true, bu_id: null, bu_name: null }),
      PO(400, 'Sub-BU of scope', { bu_id: 10, sub_bu_id: 11, sub_bu_name: 'Tech Sub' }),
      PO(500, 'No BU', { bu_id: null, bu_name: null }),
    ],
  });
  const res = await service.getReport({ month: 9, year: 2026 }, [10, 11]);

  assert.deepEqual(calls.scope.companyIds, [10, 11]);
  assert.deepEqual(res.columns.map((c) => [c.service_po_name, c.is_cross_bu]), [
    ['Own BU PO', false], ['Other BU PO', true], ['Leave', false], ['Sub-BU of scope', false], ['No BU', false],
  ]);
  assert.deepEqual(res.data.map((r) => r.employee_bu_names), [['Tech'], ['Tech', 'Tech Sub']]);
  assert.equal(res.data[0].mapping_type, null);
  assert.equal(res.totals.employee_count, 2);
  assert.equal(res.totals.grand_total, 9.5);
  restore();
});

test('a PO on a Sub-BU of a BU in scope is not cross even when only the parent is in scope', async () => {
  stub({
    original: [{ employee_id: 1, service_po_id: 1, hours: '1' }, { employee_id: 1, service_po_id: 2, hours: '1' }],
    pos: [PO(1, 'Sub PO', { bu_id: 10, sub_bu_id: 11 }), PO(2, 'Foreign sub', { bu_id: 50, sub_bu_id: 51 })],
  });
  const res = await service.getReport({ month: 9, year: 2026 }, [10]);
  assert.deepEqual(res.columns.map((c) => c.is_cross_bu), [false, true]);
  restore();
});

test('adjusted basis without sync returns NO_SYNC_MESSAGE and zero hours', async () => {
  stub({ sync: false, pos: [PO(100, 'A')], mapped: [{ employee_id: 1, service_po_id: 100 }] });
  const res = await service.getReport({ month: 9, year: 2026, hoursBasis: 'adjusted' }, [10]);
  assert.equal(res.sync_available, false);
  assert.equal(res.message, NO_SYNC_MESSAGE);
  assert.equal(res.totals.grand_total, 0);
  restore();
});

test('employeeIds / search narrow the roster query; filter-options flags servicePos', async () => {
  const calls = stub({
    mapped: [{ employee_id: 1, service_po_id: 200 }],
    pos: [PO(200, 'Other', { bu_id: 99, bu_name: 'Other' })],
  });
  await service.getReport({ month: 9, year: 2026, employeeIds: '1,2', search: 'om' }, [10]);
  assert.deepEqual(calls.scope.employeeIds, [1, 2]);
  assert.equal(calls.scope.search, 'om');
  const opts = await service.getFilterOptions({ month: 9, year: 2026 }, [10]);
  assert.equal(opts.servicePos[0].is_cross_bu, true);
  assert.equal(opts.employees.length, 2);
  restore();
});

test('export builds one column per PO and a Business Unit column', async () => {
  stub({
    original: [{ employee_id: 1, service_po_id: 200, hours: '3' }],
    pos: [PO(200, 'Other', { bu_id: 99, bu_name: 'Other' })],
  });
  const out = await service.getExport({ month: 9, year: 2026 }, [10]);
  assert.equal(out.columns[1].key, 'business_unit');
  assert.match(out.columns[2].label, /Cross-BU/);
  assert.equal(out.rows[0].po_200, 3);
  restore();
});
