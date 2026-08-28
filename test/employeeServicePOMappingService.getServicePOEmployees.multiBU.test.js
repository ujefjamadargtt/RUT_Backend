'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the "X-Company-Id header is required" bug on
// GET /employee-servicepo-mapping/service-po/:servicePOId: a multi-BU BU
// Admin/Service PO Admin/Delivery Head must be able to open ANY Service PO
// within their own managed BU set WITHOUT first selecting that exact BU —
// getServicePOEmployees() now resolves scope from authContext.
// employeeBusinessUnits (resolveEmployeeMappingScope), not the single
// currently-active companyId. Same monkey-patch style as
// test/employeeServicePOMappingService.getServicePOEmployees.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: servicePORepository.findById,
  findByServicePO: employeeServicePOMappingRepository.findByServicePO,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
};

function restore() {
  servicePORepository.findById = ORIGINAL.findById;
  employeeServicePOMappingRepository.findByServicePO = ORIGINAL.findByServicePO;
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
}

// Identity passthrough — resolveAdminScopeForBusinessUnits' own widening
// logic is tested directly in test/companyAccessControlService.
// resolveAdminScopeForBusinessUnits.test.js; these tests only verify that
// getServicePOEmployees() authorizes the PO against whatever scope it
// resolves to, without needing X-Company-Id. Called at the START of each
// test (not once at module scope) since restore() resets it afterward.
function stubScopePassthrough() {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async (ownBusinessUnitIds) => ownBusinessUnitIds;
}

test('a BU Admin mapped to multiple BUs (3 and 7) can open a Service PO in BU 7 with NO X-Company-Id / currently-selected companyId at all', async () => {
  stubScopePassthrough();
  let capturedScope;
  servicePORepository.findById = async (id, scope) => {
    capturedScope = scope;
    return { id: 388, company_id: 7 };
  };
  employeeServicePOMappingRepository.findByServicePO = async () => [{ id: 1, employee_id: 595, service_po_id: 388 }];

  // companyId: undefined — exactly what authenticateIdentity (no
  // resolveCompany) leaves it as; the fix must not depend on it at all.
  const authContext = {
    companyId: undefined,
    hierarchyRank: 4,
    employeeId: 900,
    employeeBusinessUnits: [3, 7],
  };

  const mappings = await employeeServicePOMappingService.getServicePOEmployees(388, authContext, 'active');

  assert.deepEqual(capturedScope, [3, 7]);
  assert.equal(mappings.length, 1);
  restore();
});

test('a Service PO Admin mapped to multiple BUs gets the same header-free access', async () => {
  stubScopePassthrough();
  let capturedScope;
  servicePORepository.findById = async (id, scope) => {
    capturedScope = scope;
    return { id: 200, company_id: 3 };
  };
  employeeServicePOMappingRepository.findByServicePO = async () => [];

  await employeeServicePOMappingService.getServicePOEmployees(200, {
    companyId: undefined, hierarchyRank: 6, employeeId: 901, employeeBusinessUnits: [3, 7],
  }, 'active');

  assert.deepEqual(capturedScope, [3, 7]);
  restore();
});

test('a PO belonging to a company OUTSIDE the caller\'s own managed BU set still 404s — no security regression', async () => {
  stubScopePassthrough();
  servicePORepository.findById = async () => null;

  await assert.rejects(
    () => employeeServicePOMappingService.getServicePOEmployees(999, {
      companyId: undefined, hierarchyRank: 4, employeeId: 900, employeeBusinessUnits: [3, 7],
    }, 'active'),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('a single-BU actor is unaffected — resolves to their one BU wrapped as [companyId], same practical scope as before', async () => {
  stubScopePassthrough();
  let capturedScope;
  servicePORepository.findById = async (id, scope) => {
    capturedScope = scope;
    return { id: 50, company_id: 3 };
  };
  employeeServicePOMappingRepository.findByServicePO = async () => [];

  await employeeServicePOMappingService.getServicePOEmployees(50, {
    companyId: undefined, hierarchyRank: 4, employeeId: 900, employeeBusinessUnits: [3],
  }, 'active');

  assert.deepEqual(capturedScope, [3]);
  restore();
});
