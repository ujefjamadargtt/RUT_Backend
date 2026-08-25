'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression test for the reported bug: an Admin (rank 2, no single
// req.companyId) picks a Service PO from a company OTHER than whichever one
// an X-Company-Id header happened to name (this module has no Service PO
// dropdown of its own — the PO picker is fed by a broader, array-scoped
// listing elsewhere), then create() 404s with "Service PO not found." even
// though the PO is legitimately one of the Admin's own. Fix: create()/
// update()/deactivate()/list()/listByServicePO() now resolve the caller's
// full owned-Company-id scope (companyAccessControlService.
// resolveActorCompanyScope) and derive the concrete company_id from the
// Service PO itself, exactly like resourceBudgetService.js already does —
// never from a pre-selected single BU.
const servicePORepository = require('../src/repositories/servicePORepository');
const costBudgetRepository = require('../src/repositories/costBudgetRepository');
const entityRepository = require('../src/repositories/entityRepository');
const { Company } = require('../src/models');
const costBudgetService = require('../src/services/costBudgetService');

const ORIGINAL = {
  poFindById: servicePORepository.findById,
  findOne: costBudgetRepository.findOne,
  create: costBudgetRepository.create,
  findById: costBudgetRepository.findById,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePORepository.findById = ORIGINAL.poFindById;
  costBudgetRepository.findOne = ORIGINAL.findOne;
  costBudgetRepository.create = ORIGINAL.create;
  costBudgetRepository.findById = ORIGINAL.findById;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
  Company.findAll = ORIGINAL.companyFindAll;
}

// Admin (rank 2) owning Companies 10 and 20 — no single req.companyId, and
// (the bug scenario) no X-Company-Id header sent either, since the create
// flow was never meant to require pre-selecting one BU.
function fakeAdminReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 900, headers: {}, ip: '127.0.0.1' };
}

function stubAdminOwnsCompanies10And20() {
  entityRepository.findIdsOwnedByAdmin = async () => [6, 7];
  Company.findAll = async () => [{ id: 10 }, { id: 20 }];
}

test('create(): a Service PO belonging to the SECOND of the Admin\'s two owned Companies is found and stamped with ITS OWN company_id, not rejected', async () => {
  stubAdminOwnsCompanies10And20();

  servicePORepository.findById = async (id, scope) => {
    assert.deepEqual(scope, [10, 20]); // the resolved owned-company scope, not a single pre-selected BU
    return { id: 401, company_id: 20 }; // this PO lives in Company 20
  };
  costBudgetRepository.findOne = async () => null;

  let capturedPayload;
  costBudgetRepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };
  costBudgetRepository.findById = async (id, companyId) => {
    assert.equal(companyId, 20);
    return {
      id, service_po_id: 401, month: 8, year: 2026, invoice_amount: 5000, description: null, status: 'active',
      toJSON() { return { ...this, toJSON: undefined }; },
    };
  };

  const result = await costBudgetService.create(
    { service_po_id: 401, month: '2026-08', invoice_amount: 5000 },
    1,
    fakeAdminReq()
  );

  assert.equal(capturedPayload.company_id, 20);
  assert.equal(result.service_po_id, 401);
  restore();
});

test('create(): a Service PO outside EITHER of the Admin\'s owned Companies still 404s "Service PO not found."', async () => {
  stubAdminOwnsCompanies10And20();

  servicePORepository.findById = async () => null; // not in [10, 20]

  await assert.rejects(
    () => costBudgetService.create(
      { service_po_id: 999, month: '2026-08', invoice_amount: 5000 },
      1,
      fakeAdminReq()
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /Service PO not found/);
      return true;
    }
  );
  restore();
});
