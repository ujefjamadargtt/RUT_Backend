'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression tests for the Employee<->Service PO mapping cross-tenant
// vulnerability: assign() used to look up the Employee with an unscoped
// query when companyId was undefined (company-less Admin/Entity Admin). It
// must receive an already-resolved scope (number or array) and use it for
// BOTH lookups, so a caller can never reach an Employee or Service PO
// outside their authorized scope by guessing an id. Cross-company mapping
// BETWEEN an in-scope Employee and an in-scope Service PO (different
// companies from each other) is intentionally allowed — see the "cross-
// company mapping" test below — the mapping row is simply recorded under
// the Service PO's own company_id.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: employeeRepository.findById,
  poFindById: servicePORepository.findById,
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  create: employeeServicePOMappingRepository.create,
  findBusinessUnitsByEmployeeId: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId,
  exists: employeeBusinessUnitRepository.exists,
};

function restore() {
  employeeRepository.findById = ORIGINAL.findById;
  servicePORepository.findById = ORIGINAL.poFindById;
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  employeeServicePOMappingRepository.create = ORIGINAL.create;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = ORIGINAL.findBusinessUnitsByEmployeeId;
  employeeBusinessUnitRepository.exists = ORIGINAL.exists;
}

test('assign() allows mapping an Employee to a Service PO in a DIFFERENT company, as long as each is independently within the caller\'s owned scope, and records the mapping under the Service PO\'s company', async () => {
  // Admin owns Companies 10 and 20 — Employee 101 lives in Company 10,
  // Service PO 401 lives in Company 20. Cross-company resourcing is
  // intentional (an Employee can be resourced onto a Service PO belonging
  // to a different company than their own) — both lookups must still be
  // scoped to the caller's owned companies, but no equality is required
  // between the two resolved rows.
  employeeRepository.findById = async (id, scope) => {
    assert.deepEqual(scope, [10, 20]);
    return { id: 101, company_id: 10, status: 'active' };
  };
  servicePORepository.findById = async (id, scope) => {
    assert.deepEqual(scope, [10, 20]);
    return { id: 401, company_id: 20, status: 'in-progress' };
  };
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;

  let capturedPayload;
  employeeServicePOMappingRepository.create = async (data) => {
    capturedPayload = data;
    return { id: 1, ...data };
  };

  await employeeServicePOMappingService.assign(101, 401, 1, [10, 20]);

  assert.equal(capturedPayload.company_id, 20); // the Service PO's own company
  assert.equal(capturedPayload.employee_id, 101);
  assert.equal(capturedPayload.service_po_id, 401);
  restore();
});

test('assign() 404s (not unscoped-succeeds) when the Employee falls outside the caller\'s resolved scope', async () => {
  // Simulates Admin A1 (owns Company 10 only) guessing an Employee id that
  // belongs to Admin A2's Company 20 — the resolved scope [10] can never
  // match Company 20's row. The unassigned-Employee fallback (see next
  // test) then does an unscoped lookup, which reveals this Employee DOES
  // have a real company_id (20) — so it's correctly treated as "belongs to
  // someone else's company", not "unassigned", and still 404s.
  employeeRepository.findById = async (id, scope) => {
    if (scope === null) return { id: 999, company_id: 20, status: 'active' };
    assert.deepEqual(scope, [10]);
    return null; // out of scope
  };
  servicePORepository.findById = async () => {
    throw new Error('must not be reached — the Employee scope check must 404 first');
  };

  await assert.rejects(
    () => employeeServicePOMappingService.assign(999, 401, 1, [10]),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('assign() allows a genuinely unassigned Employee (no company_id, no Business Unit at all) to be mapped directly, without requiring a BU first', async () => {
  employeeRepository.findById = async (id, scope) => {
    if (scope === null) return { id: 500, company_id: null, status: 'active' };
    return null; // not found under the caller's scope — has no BU yet
  };
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [];
  servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;

  let capturedPayload;
  employeeServicePOMappingRepository.create = async (data) => {
    capturedPayload = data;
    return { id: 1, ...data };
  };

  await employeeServicePOMappingService.assign(500, 401, 1, [10]);

  assert.equal(capturedPayload.company_id, 10);
  assert.equal(capturedPayload.employee_id, 500);
  restore();
});

test('assign() passes the caller\'s own id as createdBy to servicePORepository.findById, so a BU-less Centralised PO (company_id NULL) the caller owns can be found', async () => {
  // Regression: assign() used to call servicePORepository.findById(id, scope)
  // with only 2 args, unlike every other lookup in this module
  // (getServicePOEmployees/getEmployeeOptionsForServicePO), which all pass
  // authContext.employeeId as createdBy. Without it, companyScope()'s
  // { company_id: null, created_by: createdBy } fallback branch is
  // unreachable, so a genuinely BU-less Centralised PO the caller just
  // created always 404'd here even though it was correctly visible on the
  // mapping screens.
  employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
  servicePORepository.findById = async (id, scope, createdBy) => {
    assert.equal(createdBy, 1); // the caller's userId, forwarded through
    return { id: 401, company_id: null, status: 'in-progress' };
  };
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;

  let capturedPayload;
  employeeServicePOMappingRepository.create = async (data) => {
    capturedPayload = data;
    return { id: 1, ...data };
  };

  await employeeServicePOMappingService.assign(101, 401, 1, [10, 20]);

  assert.equal(capturedPayload.company_id, null);
  restore();
});

test('assign() happy path: Employee and Service PO in the SAME company -> mapping created with that concrete company_id, not the caller\'s broader scope array', async () => {
  employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
  servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;

  let capturedPayload;
  employeeServicePOMappingRepository.create = async (data) => {
    capturedPayload = data;
    return { id: 1, ...data };
  };

  await employeeServicePOMappingService.assign(101, 401, 1, [10, 20]);

  assert.equal(capturedPayload.company_id, 10); // concrete, verified value — never the array
  assert.equal(capturedPayload.employee_id, 101);
  assert.equal(capturedPayload.service_po_id, 401);
  restore();
});
