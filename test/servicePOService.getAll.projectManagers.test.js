'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GET /service-pos "Project Manager" column: every row gets
// `project_managers` — all Employees with an ACTIVE mapping row flagged
// is_project_manager = true for that PO (same rule as the Consolidated
// Monthly Report's projectManagers), [] when none, resolved in ONE batched
// query for exactly the page getAll() already fetched. Same repository
// monkey-patch style as servicePOService.getAll.buScope.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  findAll: servicePORepository.findAll,
  findByServicePOs: employeeServicePOMappingRepository.findByServicePOs,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
};

function restore() {
  servicePORepository.findAll = ORIGINAL.findAll;
  employeeServicePOMappingRepository.findByServicePOs = ORIGINAL.findByServicePOs;
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
}

// BU Admin (not a mapped-PO-only role), plain companyId — no extra scope lookups.
const AUTH = { companyId: 10, hierarchyRank: 4, employeeId: 900, roleNames: ['BU Admin'] };

// Page of 3 POs as a Sequelize instance would present them.
function poRow(plain) {
  return { ...plain, get: () => ({ ...plain }) };
}
const PAGE = [
  poRow({ id: 101, service_po_name: 'One PM', client: { id: 1 }, project: { id: 2 }, deliveryHead: null, creator: { id: 3, full_name: 'superadmin' } }),
  poRow({ id: 102, service_po_name: 'Two PMs', client: { id: 1 }, project: { id: 2 }, deliveryHead: null, creator: null }),
  poRow({ id: 103, service_po_name: 'No PM', client: { id: 1 }, project: { id: 2 }, deliveryHead: null, creator: null }),
];

function employee(id, fullName, extra = {}) {
  return { id, employee_code: `E${id}`, full_name: fullName, email: `${id}@x`, status: 'active', is_deleted: false, ...extra };
}

function stubPage({ count = 3 } = {}) {
  let capturedPagination;
  servicePORepository.findAll = async (filters, pagination) => {
    capturedPagination = pagination;
    return { rows: PAGE, count };
  };
  return () => capturedPagination;
}

function stubPMs(mappings) {
  const calls = [];
  employeeServicePOMappingRepository.findByServicePOs = async (ids, status, options) => {
    calls.push({ ids, status, options });
    return mappings;
  };
  return calls;
}

test('one PM, multiple PMs (all, name-sorted) and no PM ([] — never null/omitted)', async () => {
  stubPage();
  stubPMs([
    { service_po_id: 101, employee: employee(45, 'Priya Sharma') },
    { service_po_id: 102, employee: employee(88, 'Ravi Kumar') },
    { service_po_id: 102, employee: employee(46, 'Anita Rao') },
  ]);
  try {
    const { data } = await servicePOService.getAll({}, AUTH);
    const byId = Object.fromEntries(data.map((po) => [po.id, po.project_managers]));

    assert.deepEqual(byId[101], [{ id: 45, employee_code: 'E45', full_name: 'Priya Sharma' }]);
    assert.deepEqual(byId[102].map((pm) => pm.full_name), ['Anita Rao', 'Ravi Kumar']);
    assert.deepEqual(byId[103], []);
    assert.ok(data.every((po) => Array.isArray(po.project_managers)));
  } finally {
    restore();
  }
});

test('PM flag: queries only ACTIVE rows with is_project_manager = true; soft-deleted Employees and duplicates are dropped', async () => {
  stubPage();
  const calls = stubPMs([
    { service_po_id: 101, employee: employee(45, 'Priya Sharma') },
    { service_po_id: 101, employee: employee(45, 'Priya Sharma') }, // duplicate row
    { service_po_id: 101, employee: employee(77, 'Gone Person', { is_deleted: true }) },
  ]);
  try {
    const { data } = await servicePOService.getAll({}, AUTH);

    assert.equal(calls[0].status, 'active');
    assert.deepEqual(calls[0].options, { onlyProjectManager: true });
    assert.deepEqual(data.find((po) => po.id === 101).project_managers.map((pm) => pm.id), [45]);
  } finally {
    restore();
  }
});

test('existing fields unchanged — project_managers is purely additive', async () => {
  stubPage();
  stubPMs([]);
  try {
    const { data } = await servicePOService.getAll({}, AUTH);
    const po = data.find((row) => row.id === 101);
    const { project_managers: pms, ...rest } = po;

    assert.deepEqual(rest, PAGE[0].get());
    assert.deepEqual(pms, []);
  } finally {
    restore();
  }
});

test('scope + pagination + no N+1: exactly ONE PM query, for exactly the ids of the page already fetched', async () => {
  const getPagination = stubPage({ count: 57 });
  const calls = stubPMs([]);
  try {
    const { data, meta } = await servicePOService.getAll({ page: 2, limit: 3 }, AUTH);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ids, [101, 102, 103]); // only POs the scoped query returned
    assert.equal(data.length, 3);
    assert.equal(getPagination().offset, 3);
    assert.equal(meta.total, 57);
  } finally {
    restore();
  }
});

test('empty page: no PM query at all', async () => {
  servicePORepository.findAll = async () => ({ rows: [], count: 0 });
  const calls = stubPMs([]);
  try {
    const { data } = await servicePOService.getAll({}, AUTH);
    assert.deepEqual(data, []);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});
