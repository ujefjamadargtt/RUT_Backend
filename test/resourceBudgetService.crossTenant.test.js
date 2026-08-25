'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression tests for the Resource Budget cross-tenant fix, and its
// follow-up policy change: create()/bulkUpsert() used to read req.companyId
// directly (undefined for a company-less Admin/Entity Admin, crashing every
// call). They now resolve the caller's scope and derive the Service PO's
// own concrete company_id, which every budget row is stamped/scoped with.
//
// The Employee existence check itself is deliberately NOT scoped to that
// company: cross-BU staffing (mapping an Employee to a Service PO in a
// company other than the Employee's own) is a supported, common pattern
// (employeeServicePOMappingService.assign()), and an earlier version of
// this check rejected such employees with a false "not found" — confirmed
// live on two separate Service POs/employees. Authorization for budgeting
// against a specific PO comes from assertEmployeeMappedToServicePO() (the
// mapping row's own company_id, always stamped from the PO at assign time)
// — not from a second, redundant Employee-BU-match check.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const resourceBudgetRepository = require('../src/repositories/resourceBudgetRepository');
const entityRepository = require('../src/repositories/entityRepository');
const { Company } = require('../src/models');
const resourceBudgetService = require('../src/services/resourceBudgetService');

const ORIGINAL = {
  poFindById: servicePORepository.findById,
  empFindById: employeeRepository.findById,
  isMapped: resourceBudgetRepository.isEmployeeMappedToServicePO,
  findOne: resourceBudgetRepository.findOne,
  sumActive: resourceBudgetRepository.sumActiveHoursForEmployeeMonth,
  create: resourceBudgetRepository.create,
  findById: resourceBudgetRepository.findById,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePORepository.findById = ORIGINAL.poFindById;
  employeeRepository.findById = ORIGINAL.empFindById;
  resourceBudgetRepository.isEmployeeMappedToServicePO = ORIGINAL.isMapped;
  resourceBudgetRepository.findOne = ORIGINAL.findOne;
  resourceBudgetRepository.sumActiveHoursForEmployeeMonth = ORIGINAL.sumActive;
  resourceBudgetRepository.create = ORIGINAL.create;
  resourceBudgetRepository.findById = ORIGINAL.findById;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
  Company.findAll = ORIGINAL.companyFindAll;
}

// Admin (rank 2) owning Companies 10 and 20 — no single req.companyId.
function fakeAdminReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 900, headers: {}, ip: '127.0.0.1' };
}

// resolveActorCompanyScope() -> resolveOwnedCompanyIds() (a local closure
// reference inside companyAccessControlService.js, not monkey-patchable
// directly) -> entityRepository.findIdsOwnedByAdmin() + Company.findAll(),
// both real property-accessed calls. Stub at that layer so this admin
// resolves to owning Companies 10 and 20.
function stubAdminOwnsCompanies10And20() {
  entityRepository.findIdsOwnedByAdmin = async () => [6, 7];
  Company.findAll = async () => [{ id: 10 }, { id: 20 }];
}

test('create(): resolves the Service PO within the caller\'s full owned-company scope and stamps the budget with the PO\'s OWN company_id', async () => {
  stubAdminOwnsCompanies10And20();

  servicePORepository.findById = async (id, scope) => {
    assert.deepEqual(scope, [10, 20]); // the resolved owned-company scope
    return { id: 401, company_id: 10 };
  };
  let capturedEmployeeLookupScope;
  employeeRepository.findById = async (id, scope) => {
    capturedEmployeeLookupScope = scope;
    return { id: 101, company_id: 10, status: 'active' };
  };
  resourceBudgetRepository.isEmployeeMappedToServicePO = async () => true;
  resourceBudgetRepository.findOne = async () => null;
  resourceBudgetRepository.sumActiveHoursForEmployeeMonth = async () => 0;

  let capturedPayload;
  resourceBudgetRepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };
  resourceBudgetRepository.findById = async (id, scope) => ({
    id, emp_id: 101, service_po_id: 401, month: 8, year: 2026, hours: 40, status: 'active',
    toJSON() { return { ...this, toJSON: undefined }; },
  });

  await resourceBudgetService.create(
    { emp_id: 101, service_po_id: 401, month: '2026-08', hours: 40 },
    1,
    fakeAdminReq()
  );

  assert.equal(capturedEmployeeLookupScope, null); // existence check is unscoped, not narrowed to the PO's company
  assert.equal(capturedPayload.company_id, 10);
  restore();
});

test('create(): SUCCEEDS for a cross-BU-mapped Employee whose own company differs from the Service PO\'s company', async () => {
  stubAdminOwnsCompanies10And20();

  // Service PO lives in Company 10; the Employee's own company is 20 —
  // legitimately mapped across BUs, same as the live Rajkumar/PO1 case.
  servicePORepository.findById = async () => ({ id: 401, company_id: 10 });
  employeeRepository.findById = async () => ({ id: 101, company_id: 20, status: 'active' });
  resourceBudgetRepository.isEmployeeMappedToServicePO = async (empId, servicePOId, companyId) => {
    assert.equal(companyId, 10); // mapping authorization still checked against the PO's own company
    return true; // an active employee_servicepo_mapping row exists for this pairing
  };
  resourceBudgetRepository.findOne = async () => null;
  resourceBudgetRepository.sumActiveHoursForEmployeeMonth = async () => 0;
  resourceBudgetRepository.create = async (payload) => ({ id: 1, ...payload });
  resourceBudgetRepository.findById = async (id) => ({
    id, emp_id: 101, service_po_id: 401, month: 8, year: 2026, hours: 40, status: 'active',
    toJSON() { return { ...this, toJSON: undefined }; },
  });

  const result = await resourceBudgetService.create(
    { emp_id: 101, service_po_id: 401, month: '2026-08', hours: 40 },
    1,
    fakeAdminReq()
  );

  assert.equal(result.emp_id, 101);
  restore();
});

test('create(): 404s when the Employee record does not exist at all, regardless of mapping', async () => {
  stubAdminOwnsCompanies10And20();

  servicePORepository.findById = async () => ({ id: 401, company_id: 10 });
  employeeRepository.findById = async () => null;
  resourceBudgetRepository.isEmployeeMappedToServicePO = async () => {
    throw new Error('must not be reached — employee existence check must 404 first');
  };

  await assert.rejects(
    () => resourceBudgetService.create(
      { emp_id: 999, service_po_id: 401, month: '2026-08', hours: 40 },
      1,
      fakeAdminReq()
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /not found/);
      return true;
    }
  );
  restore();
});

test('create(): 400s when the Employee exists but has no active mapping to this Service PO', async () => {
  stubAdminOwnsCompanies10And20();

  servicePORepository.findById = async () => ({ id: 401, company_id: 10 });
  employeeRepository.findById = async () => ({ id: 101, company_id: 20, status: 'active' });
  resourceBudgetRepository.isEmployeeMappedToServicePO = async () => false;

  await assert.rejects(
    () => resourceBudgetService.create(
      { emp_id: 101, service_po_id: 401, month: '2026-08', hours: 40 },
      1,
      fakeAdminReq()
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /not mapped/);
      return true;
    }
  );
  restore();
});
