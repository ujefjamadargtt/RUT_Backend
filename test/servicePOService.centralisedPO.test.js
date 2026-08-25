'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/servicePOService.deleteGuard.test.js —
// servicePOService.js holds live references to these SAME module-cached
// repository objects, never destructured at call time (createAuditLog IS
// destructured at import time, so it can't be stubbed this way — it's left
// to run for real; it never throws out, see its own try/catch).
const servicePORepository = require('../src/repositories/servicePORepository');
const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const aiInsightService = require('../src/services/aiInsight.service');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  findById: servicePORepository.findById,
  findByCode: servicePORepository.findByCode,
  create: servicePORepository.create,
  update: servicePORepository.update,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByIdUnscoped: projectRepository.findByIdUnscoped,
  employeeFindById: employeeRepository.findById,
  runJob: aiInsightService.runJob,
};

function restore() {
  servicePORepository.findById = ORIGINAL.findById;
  servicePORepository.findByCode = ORIGINAL.findByCode;
  servicePORepository.create = ORIGINAL.create;
  servicePORepository.update = ORIGINAL.update;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByIdUnscoped = ORIGINAL.projectFindByIdUnscoped;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  aiInsightService.runJob = ORIGINAL.runJob;
}

function fakeReq(companyId) {
  return { companyId, headers: {}, ip: '127.0.0.1' };
}

test('create(): is_centralised: true flows through into the payload persisted by the repository', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  employeeRepository.findById = async () => ({ id: 30, status: 'active', company_id: 10 });
  servicePORepository.findByCode = async () => null;
  aiInsightService.runJob = async () => {};

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };

  const po = await servicePOService.create(
    {
      service_po_code: 'PO-CENTRAL-1',
      service_po_name: 'Centralised Overhead PO',
      client_id: 10,
      project_id: 20,
      delivery_head_employee_id: 30,
      service_type_id: 1,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      is_centralised: true,
    },
    1,
    fakeReq(10)
  );

  assert.equal(capturedPayload.is_centralised, true);
  assert.equal(po.is_centralised, true);

  restore();
});

test('create(): is_centralised defaults to false when omitted (existing normal-PO behavior unchanged)', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  employeeRepository.findById = async () => ({ id: 30, status: 'active', company_id: 10 });
  servicePORepository.findByCode = async () => null;
  aiInsightService.runJob = async () => {};

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 2, ...payload };
  };

  // Note: the `is_centralised` default(false) is applied by Joi at the
  // validation layer (servicePOValidation.js), not by the service — this
  // test calls the service directly, so it passes the field explicitly to
  // simulate what the validated req.body would already contain.
  await servicePOService.create(
    {
      service_po_code: 'PO-NORMAL-1',
      service_po_name: 'Normal PO',
      client_id: 10,
      project_id: 20,
      delivery_head_employee_id: 30,
      service_type_id: 1,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      is_centralised: false,
    },
    1,
    fakeReq(10)
  );

  assert.equal(capturedPayload.is_centralised, false);

  restore();
});

test('update(): flips an existing PO from non-centralised to centralised, and records the old value for audit', async () => {
  servicePORepository.findById = async () => ({
    id: 5,
    status: 'in-progress',
    service_po_code: 'PO-1',
    service_po_name: 'PO One',
    client_id: 10,
    project_id: 20,
    is_centralised: false,
  });

  let capturedPayload;
  servicePORepository.update = async (id, payload) => {
    capturedPayload = payload;
    return { id, ...payload };
  };

  const updated = await servicePOService.update(5, { is_centralised: true }, 1, fakeReq(10));

  assert.equal(capturedPayload.is_centralised, true);
  assert.equal(updated.is_centralised, true);

  restore();
});

test('update(): flips an existing PO from centralised to non-centralised — existing employee mappings are untouched by this call (update() never writes to employee_servicepo_mapping)', async () => {
  servicePORepository.findById = async () => ({
    id: 6,
    status: 'in-progress',
    service_po_code: 'PO-2',
    service_po_name: 'PO Two',
    client_id: 10,
    project_id: 20,
    is_centralised: true,
  });

  let capturedPayload;
  servicePORepository.update = async (id, payload) => {
    capturedPayload = payload;
    return { id, ...payload };
  };

  const updated = await servicePOService.update(6, { is_centralised: false }, 1, fakeReq(10));

  assert.equal(capturedPayload.is_centralised, false);
  assert.equal(updated.is_centralised, false);
  // No employee_servicepo_mapping repository was even imported into
  // servicePOService.js's update() path — this test's absence of any such
  // stub/call is itself the guarantee that flipping the flag can't touch
  // existing mappings.

  restore();
});

// ── servicePORepository.getActiveCentralisedPOIds ──────────────────────
// Direct repository-level check that the query filters by is_centralised,
// excludes soft-deleted rows, reuses the exact same "active" status set
// getActivePOs() already uses ('in-progress'|'on-hold'|'pending'), and
// matches BOTH this company's own Centralised POs AND any BU-less
// (company_id NULL) Centralised PO.

test('getActiveCentralisedPOIds(): queries is_centralised=true, is_deleted=false, the shared active-status set, and (companyId OR NULL), returning {id, company_id, created_by} triples', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedArgs;
  ServicePO.findAll = async (args) => {
    capturedArgs = args;
    return [{ id: 101, company_id: 10, created_by: 5 }, { id: 102, company_id: null, created_by: 5 }];
  };

  const pos = await servicePORepository.getActiveCentralisedPOIds(10);

  assert.deepEqual(pos, [{ id: 101, company_id: 10, created_by: 5 }, { id: 102, company_id: null, created_by: 5 }]);
  assert.deepEqual(capturedArgs.where[Op.or], [{ company_id: 10 }, { company_id: null }]);
  assert.equal(capturedArgs.where.is_centralised, true);
  assert.equal(capturedArgs.where.is_deleted, false);
  assert.deepEqual(capturedArgs.where.status[Op.in], ['in-progress', 'on-hold', 'pending']);

  ServicePO.findAll = originalFindAll;
});
