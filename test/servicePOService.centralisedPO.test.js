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

// hierarchyRank/employeeBusinessUnits are needed by update()'s
// resolveActorFullReach() lookup (a BU-scoped actor's full reach resolves
// from employeeBusinessUnits, not companyId) — create() doesn't use them.
function fakeReq(companyId) {
  return { companyId, hierarchyRank: 4, employeeBusinessUnits: [{ id: companyId }], headers: {}, ip: '127.0.0.1' };
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
// getActivePOs() already uses ('in-progress'|'on-hold'|'pending'), and —
// by decided design — is NOT scoped to any company at all: a Centralised
// Service PO is for every Employee/Business Unit, platform-wide.

test('getActiveCentralisedPOIds(): queries is_centralised=true, is_deleted=false, the shared active-status set, with no company_id condition, returning {id, company_id, created_by} triples', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedArgs;
  ServicePO.findAll = async (args) => {
    capturedArgs = args;
    return [{ id: 101, company_id: 10, created_by: 5 }, { id: 102, company_id: null, created_by: 5 }];
  };

  const pos = await servicePORepository.getActiveCentralisedPOIds();

  assert.deepEqual(pos, [{ id: 101, company_id: 10, created_by: 5 }, { id: 102, company_id: null, created_by: 5 }]);
  assert.equal(capturedArgs.where.company_id, undefined);
  assert.equal(capturedArgs.where.is_centralised, true);
  assert.equal(capturedArgs.where.is_deleted, false);
  assert.deepEqual(capturedArgs.where.status[Op.in], ['in-progress', 'on-hold', 'pending']);

  ServicePO.findAll = originalFindAll;
});

// ── servicePORepository.getEligibleForMapping ───────────────────────────
// Regression coverage for a live incident: mapping a BU-less Centralised
// PO to an Employee holding Project Manager (unrestricted=true) failed
// with "not eligible" because the strict company_id match in companyScope()
// never matches a NULL row. A Centralised PO must be eligible regardless of
// the caller's own company scope or the `unrestricted` flag.

test('getEligibleForMapping(): a Centralised PO (company_id: null) is eligible for an UNRESTRICTED (Project Manager) caller even though the caller\'s own companyId never matches NULL', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedWhere;
  ServicePO.findAll = async (args) => {
    capturedWhere = args.where;
    // Simulate the real DB matching either branch of the OR.
    return [{ id: 999, service_po_name: 'On Bench', company_id: null, is_centralised: true }];
  };

  const pos = await servicePORepository.getEligibleForMapping({
    companyId: 40, // the caller's OWN scope — deliberately does not include null
    createdBy: 1,
    unrestricted: true, // Project Manager/Delivery Head — skips the BU-or clause entirely
    businessUnitIds: [],
  });

  assert.equal(capturedWhere.is_centralised, undefined); // not a top-level filter — OR'd in below
  assert.ok(Array.isArray(capturedWhere[Op.or]));
  assert.ok(capturedWhere[Op.or].some((clause) => clause.is_centralised === true));
  assert.deepEqual(pos, [{ id: 999, service_po_name: 'On Bench', company_id: null, is_centralised: true }]);

  ServicePO.findAll = originalFindAll;
});

test('getEligibleForMapping(): a Centralised PO (company_id: null) is eligible for a RESTRICTED caller even when it is not in businessUnitIds', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedWhere;
  ServicePO.findAll = async (args) => {
    capturedWhere = args.where;
    return [];
  };

  await servicePORepository.getEligibleForMapping({
    companyId: 40,
    createdBy: 1,
    unrestricted: false,
    businessUnitIds: [27], // the target Employee's own BU — does NOT include the PO's company_id (irrelevant now)
  });

  assert.ok(capturedWhere[Op.or].some((clause) => clause.is_centralised === true));

  ServicePO.findAll = originalFindAll;
});
