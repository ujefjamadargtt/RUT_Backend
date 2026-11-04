'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tlRepository = require('../src/repositories/teamLeadEmployeePoHoursReportRepository');
const scopeRepository = require('../src/repositories/poHoursEmployeeScopeRepository');
const mappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const mappingService = require('../src/services/employeeServicePOMappingService');
const service = require('../src/services/projectManagerEmployeePoHoursReportService');

const SAVED = [tlRepository, scopeRepository, mappingRepository, mappingService].map((m) => [m, { ...m }]);
const restore = () => SAVED.forEach(([m, orig]) => Object.assign(m, orig));

const PO = (id, name, extra = {}) => ({
  service_po_id: id, service_po_code: `C${id}`, service_po_name: name, is_centralised: false,
  client_id: 1, client_name: 'Client', project_id: 1, project_name: 'Project',
  bu_id: 10, bu_name: 'Tech', sub_bu_id: null, sub_bu_name: null, ...extra,
});

function stub({ flagged = [100, 200], roster = [1, 2], mapped = [], original = [], pos = [] } = {}) {
  const calls = {};
  mappingService.getProjectManagerServicePOIds = async (id) => { calls.pm = id; return flagged; };
  mappingRepository.findEmployeeIdsOnProjectManagerPOs = async () => roster;
  scopeRepository.findActiveEmployeesByIds = async (a) => {
    calls.scope = a;
    return a.ids.map((id) => ({ employee_id: id, employee_code: `E${id}`, full_name: `Emp${id}`, employee_bu_names: ['Tech'] }));
  };
  tlRepository.findMappedPos = async (ids, f) => { calls.mappedFilters = f; return mapped; };
  tlRepository.findOriginalHours = async (ids, p, f) => { calls.hoursFilters = f; return original; };
  tlRepository.hasSyncedData = async () => true;
  tlRepository.findPoColumns = async (ids) => pos.filter((p) => ids.includes(p.service_po_id));
  return calls;
}

test('rows = PM roster, hours/columns restricted to the PM flagged POs, caller is the PM', async () => {
  const calls = stub({
    mapped: [{ employee_id: 1, service_po_id: 100 }, { employee_id: 2, service_po_id: 200 }],
    original: [{ employee_id: 1, service_po_id: 100, hours: '5' }, { employee_id: 2, service_po_id: 200, hours: '3' }],
    pos: [PO(100, 'Own'), PO(200, 'Foreign', { bu_id: 99 })],
  });
  const res = await service.getReport({ month: 9, year: 2026 }, 7, [10]);
  assert.equal(calls.pm, 7);
  assert.deepEqual(calls.scope.ids, [1, 2]);
  assert.deepEqual(calls.hoursFilters.servicePoIds, [100, 200]);
  assert.deepEqual(res.columns.map((c) => [c.service_po_id, c.is_cross_bu]), [[100, false], [200, true]]);
  assert.equal(res.totals.employee_count, 2);
  assert.equal(res.totals.grand_total, 8);
  assert.equal(res.data[0].mapping_type, null);
  assert.deepEqual(res.data[0].employee_bu_names, ['Tech']);
  restore();
});

test('a user servicePoIds filter only narrows within the flagged POs', async () => {
  const calls = stub({ flagged: [100, 200] });
  await service.getReport({ month: 9, year: 2026, servicePoIds: '200,999' }, 7, [10]);
  assert.deepEqual(calls.hoursFilters.servicePoIds, [200]);
  restore();
});

test('no flagged POs gives an empty matrix and no hour lookups', async () => {
  const calls = stub({ flagged: [], roster: [] });
  const res = await service.getReport({ month: 9, year: 2026 }, 7, [10]);
  assert.deepEqual(res.columns, []);
  assert.deepEqual(res.data, []);
  assert.equal(calls.hoursFilters, undefined);
  assert.equal(res.totals.po_count, 0);
  restore();
});

test('filter-options is limited to flagged POs', async () => {
  const calls = stub({ mapped: [{ employee_id: 1, service_po_id: 100 }], pos: [PO(100, 'Own')] });
  const opts = await service.getFilterOptions({ month: 9, year: 2026 }, 7, [10]);
  assert.deepEqual(calls.mappedFilters.servicePoIds, [100, 200]);
  assert.equal(opts.servicePos[0].is_cross_bu, false);
  restore();
});
