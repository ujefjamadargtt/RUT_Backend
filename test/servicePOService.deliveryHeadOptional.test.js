'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/servicePOService.centralisedPO.test.js —
// servicePOService.js holds live references to these SAME module-cached
// repository objects, never destructured at call time.
const servicePORepository = require('../src/repositories/servicePORepository');
const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const aiInsightService = require('../src/services/aiInsight.service');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  findByCode: servicePORepository.findByCode,
  findByName: servicePORepository.findByName,
  create: servicePORepository.create,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByIdUnscoped: projectRepository.findByIdUnscoped,
  employeeFindById: employeeRepository.findById,
  runJob: aiInsightService.runJob,
};

function restore() {
  servicePORepository.findByCode = ORIGINAL.findByCode;
  servicePORepository.findByName = ORIGINAL.findByName;
  servicePORepository.create = ORIGINAL.create;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByIdUnscoped = ORIGINAL.projectFindByIdUnscoped;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  aiInsightService.runJob = ORIGINAL.runJob;
}

function fakeReq(companyId) {
  return { companyId, headers: {}, ip: '127.0.0.1' };
}

function basePayload(overrides = {}) {
  return {
    service_po_code: 'PO-DH-1',
    service_po_name: 'Delivery Head Test PO',
    client_id: 10,
    project_id: 20,
    service_type_id: 1,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    ...overrides,
  };
}

test('create(): succeeds without delivery_head_employee_id and persists NULL explicitly', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};

  let calledEmployeeFindById = false;
  employeeRepository.findById = async () => {
    calledEmployeeFindById = true;
    return null;
  };

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };

  const po = await servicePOService.create(basePayload(), 1, fakeReq(10));

  assert.equal(capturedPayload.delivery_head_employee_id, null);
  assert.equal(po.delivery_head_employee_id, null);
  // No Delivery Head supplied -> assertValidDeliveryHead() must never run.
  assert.equal(calledEmployeeFindById, false);

  restore();
});

test('create(): still validates delivery_head_employee_id when one IS supplied', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  employeeRepository.findById = async () => ({ id: 30, status: 'active', company_id: 10 });

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 2, ...payload };
  };

  await servicePOService.create(
    basePayload({ service_po_code: 'PO-DH-2', delivery_head_employee_id: 30 }),
    1,
    fakeReq(10)
  );

  assert.equal(capturedPayload.delivery_head_employee_id, 30);

  restore();
});

test('create(): a company-less actor (Admin) MUST supply company_id — Business Unit stays mandatory for Service PO', async () => {
  await assert.rejects(
    () => servicePOService.create(basePayload(), 1, { companyId: undefined, hierarchyRank: 2, employeeId: 1, headers: {}, ip: '127.0.0.1' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Business Unit/i);
      return true;
    }
  );

  restore();
});

test('create(): a BU-scoped actor never needs to supply company_id — their own req.companyId is used', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 3, ...payload };
  };

  // No company_id in the body at all — mirrors a BU-scoped actor's real
  // request payload, which has never included one.
  await servicePOService.create(basePayload({ service_po_code: 'PO-DH-3' }), 1, fakeReq(10));

  assert.equal(capturedPayload.company_id, 10);

  restore();
});
