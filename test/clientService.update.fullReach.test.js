'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for a real bug report: PUT /clients/:id returned
// "Client not found" for an existing Client — both a plain rename AND a
// Business Unit change failed identically. Root cause: clientService.update()/
// deleteClient() resolved their existence-check scope via
// resolveActorRecordAccessScope({ companyId: req.companyId, ... }), which for
// a BU-scoped actor is just their single CURRENTLY ACTIVE Business Unit
// (X-Company-Id) — but GET /clients (which the Edit form's list is populated
// from) already spans every Business Unit the caller manages
// (authenticateReadMultiBU + resolveActorFullReach, see getClientById's own
// fix). Opening/editing any Client from a DIFFERENT BU than whichever one
// happened to be currently selected 404'd on Save, before any field-level
// logic ever ran. Fixed by switching update()/deleteClient() to
// resolveActorFullReach() too, matching getClientById().
//
// Also covers the accompanying feature this bug report asked for: Business
// Unit reassignment via PUT (company_id in the body), authorized the same
// way create() already authorizes it.
const clientRepository = require('../src/repositories/clientRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const clientService = require('../src/services/clientService');

const ORIGINAL = {
  findById: clientRepository.findById,
  findByCode: clientRepository.findByCode,
  findByName: clientRepository.findByName,
  update: clientRepository.update,
  softDelete: clientRepository.softDelete,
  countActivePOsByClient: clientRepository.countActivePOsByClient,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
};

function restore() {
  clientRepository.findById = ORIGINAL.findById;
  clientRepository.findByCode = ORIGINAL.findByCode;
  clientRepository.findByName = ORIGINAL.findByName;
  clientRepository.update = ORIGINAL.update;
  clientRepository.softDelete = ORIGINAL.softDelete;
  clientRepository.countActivePOsByClient = ORIGINAL.countActivePOsByClient;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
}

// A BU Admin mapped to BUs 3 and 7, currently active on BU 3 — the exact
// "Global BU selector on a different BU than the target record" scenario
// this bug report hit. The Client being edited lives in BU 7.
const MULTI_BU_REQ = {
  companyId: 3,
  hierarchyRank: 4,
  employeeId: 900,
  employeeBusinessUnits: [{ id: 3 }, { id: 7 }],
  headers: {},
};

test('update(): a Client in the caller\'s OTHER managed BU (7, not the active companyId 3) is found and updated — THE BUG FIX', async () => {
  try {
    let capturedFindByIdScope;
    clientRepository.findById = async (id, scope) => {
      capturedFindByIdScope = scope;
      return { id: 3, client_code: 'ABC', client_name: 'Old Name', industry: 'IT', status: 'active', company_id: 7 };
    };
    clientRepository.findByName = async () => null;
    let updatedPayload;
    clientRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };

    const updated = await clientService.update(3, { client_name: 'New Name' }, 900, MULTI_BU_REQ);

    assert.deepEqual(capturedFindByIdScope.slice().sort(), [3, 7]); // full reach, not just active BU 3
    assert.equal(updatedPayload.client_name, 'New Name');
    assert.equal(updated.client_name, 'New Name');
  } finally {
    restore();
  }
});

test('update(): a rename that previously would 404 for a Client outside the active BU now succeeds as a no-op-scope rename', async () => {
  try {
    clientRepository.findById = async () => ({ id: 3, client_code: 'ABC', client_name: 'Old Name', industry: 'IT', status: 'active', company_id: 7 });
    clientRepository.findByName = async () => null;
    clientRepository.update = async (id, payload) => ({ id, ...payload });

    const updated = await clientService.update(3, { client_name: 'Renamed Co' }, 900, MULTI_BU_REQ);

    assert.equal(updated.client_name, 'Renamed Co');
    assert.equal(updated.company_id, 7); // BU untouched — client_name-only edit
  } finally {
    restore();
  }
});

test('update(): reassigning company_id to a BU the caller IS mapped to succeeds, and uniqueness checks run against the DESTINATION BU', async () => {
  try {
    clientRepository.findById = async () => ({ id: 3, client_code: 'ABC', client_name: 'Acme', industry: 'IT', status: 'active', company_id: 7 });
    let capturedNameScope;
    clientRepository.findByName = async (name, scope) => { capturedNameScope = scope; return null; };
    let updatedPayload;
    clientRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };

    const updated = await clientService.update(3, { company_id: 3 }, 900, MULTI_BU_REQ);

    assert.equal(updatedPayload.company_id, 3);
    assert.equal(updated.company_id, 3);
  } finally {
    restore();
  }
});

test('update(): reassigning company_id to a BU the caller is NOT mapped to is rejected with 403, and nothing is written', async () => {
  try {
    clientRepository.findById = async () => ({ id: 3, client_code: 'ABC', client_name: 'Acme', industry: 'IT', status: 'active', company_id: 7 });
    let wroteAnything = false;
    clientRepository.update = async () => { wroteAnything = true; };

    await assert.rejects(
      () => clientService.update(3, { company_id: 99 }, 900, MULTI_BU_REQ),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(wroteAnything, false);
  } finally {
    restore();
  }
});

test('update(): a company-less actor (Admin) reassigning company_id validates against their OWN owned Companies, not employeeBusinessUnits', async () => {
  try {
    clientRepository.findById = async () => ({ id: 3, client_code: 'ABC', client_name: 'Acme', industry: 'IT', status: 'active', company_id: 5 });
    clientRepository.findByName = async () => null;
    let updatedPayload;
    clientRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };
    companyAccessControlService.resolveOwnedCompanyIds = async () => [5, 6, 7];

    const adminReq = { companyId: null, hierarchyRank: 2, employeeId: 1, employeeBusinessUnits: [], headers: {} };
    const updated = await clientService.update(3, { company_id: 6 }, 1, adminReq);

    assert.equal(updatedPayload.company_id, 6);
    assert.equal(updated.company_id, 6);
  } finally {
    restore();
  }
});

test('deleteClient(): a Client in the caller\'s OTHER managed BU (7, not the active companyId 3) is found and deleted', async () => {
  try {
    let capturedFindByIdScope;
    clientRepository.findById = async (id, scope) => {
      capturedFindByIdScope = scope;
      return { id: 3, client_name: 'Acme', status: 'active', company_id: 7 };
    };
    clientRepository.countActivePOsByClient = async () => 0;
    let softDeleted = false;
    clientRepository.softDelete = async () => { softDeleted = true; return true; };

    await clientService.deleteClient(3, 900, MULTI_BU_REQ);

    assert.deepEqual(capturedFindByIdScope.slice().sort(), [3, 7]);
    assert.equal(softDeleted, true);
  } finally {
    restore();
  }
});
