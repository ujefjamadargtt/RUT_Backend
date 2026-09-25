'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: PUT /employee-servicepo-mapping/:id/deactivate (and activate/
// remove/PM flag) 404'd "Mapping not found." for every Centralised Service
// PO mapping (On Bench, Leaves, ...) — those rows carry company_id NULL, and
// the old lookup filtered `company_id IN (:scope)`, which never matches NULL.
// Now authorized through the mapping's Service PO (loadAuthorizedMapping).
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findByIdUnscoped: employeeServicePOMappingRepository.findByIdUnscoped,
  poFindById: servicePORepository.findById,
  findByIdWithEmail: employeeRepository.findByIdWithEmail,
  employeeScope: employeeRepository.employeeScope,
  resolveAdminOwnership: companyAccessControlService.resolveAdminOwnershipForBusinessUnits,
};

function restore() {
  employeeServicePOMappingRepository.findByIdUnscoped = ORIGINAL.findByIdUnscoped;
  servicePORepository.findById = ORIGINAL.poFindById;
  employeeRepository.findByIdWithEmail = ORIGINAL.findByIdWithEmail;
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = ORIGINAL.resolveAdminOwnership;
}

// BU Admin (rank 4) mapped to BU 23.
const AUTH = { companyId: 23, hierarchyRank: 4, employeeId: 9, employeeBusinessUnits: [23] };

function centralisedMapping(onUpdate) {
  return {
    id: 1592, employee_id: 333, service_po_id: 52, company_id: null, status: 'active',
    async update(values) { onUpdate(values); return { ...this, ...values }; },
  };
}

function stubEmployeeScope() {
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = async () => ({ adminIds: [3], companyIds: [23] });
  employeeRepository.employeeScope = async () => ({ company_id: [23] });
}

test('deactivateMapping(): a Centralised PO mapping (company_id NULL) is found and deactivated', async () => {
  let updated;
  employeeServicePOMappingRepository.findByIdUnscoped = async () => centralisedMapping((v) => { updated = v; });
  servicePORepository.findById = async (poId, scope, createdBy, _c, _m, centralisedTenant) => {
    assert.equal(poId, 52);
    // Tenant-bounded Centralised widening (never a blanket `true`): the
    // caller's own Admin tenant, incl. the caller as a BU-less owner.
    assert.ok(centralisedTenant && Array.isArray(centralisedTenant.companyIds));
    assert.ok(centralisedTenant.ownerIds.includes(9));
    return { id: 52, company_id: null, is_centralised: true };
  };
  stubEmployeeScope();
  employeeRepository.findByIdWithEmail = async (id) => (id === 333 ? { id: 333 } : null);

  try {
    const result = await employeeServicePOMappingService.deactivateMapping(1592, 9, [23], AUTH);
    assert.deepEqual(updated, { status: 'inactive', updated_by: 9 });
    assert.equal(result.status, 'inactive');
  } finally {
    restore();
  }
});

test('deactivateMapping(): a Centralised PO mapping for an Employee OUTSIDE the caller\'s scope still 404s', async () => {
  employeeServicePOMappingRepository.findByIdUnscoped = async () => centralisedMapping(() => assert.fail('must not update'));
  servicePORepository.findById = async () => ({ id: 52, company_id: null, is_centralised: true });
  stubEmployeeScope();
  employeeRepository.findByIdWithEmail = async () => null;

  try {
    await assert.rejects(
      employeeServicePOMappingService.deactivateMapping(1592, 9, [23], AUTH),
      (err) => err.statusCode === 404
    );
  } finally {
    restore();
  }
});

test('activateMapping(): a normal PO outside the caller\'s scope 404s (PO check), no Employee check needed', async () => {
  employeeServicePOMappingRepository.findByIdUnscoped = async () => ({
    id: 7, employee_id: 4, service_po_id: 900, company_id: 99,
    async update() { assert.fail('must not update'); },
  });
  servicePORepository.findById = async () => null;
  employeeRepository.findByIdWithEmail = async () => assert.fail('employee check is only for Centralised POs');

  try {
    await assert.rejects(
      employeeServicePOMappingService.activateMapping(7, 9, [23], AUTH),
      (err) => err.statusCode === 404
    );
  } finally {
    restore();
  }
});

test('removeMapping(): unknown mapping id 404s', async () => {
  employeeServicePOMappingRepository.findByIdUnscoped = async () => null;
  try {
    await assert.rejects(
      employeeServicePOMappingService.removeMapping(123456, [23], AUTH),
      (err) => err.statusCode === 404
    );
  } finally {
    restore();
  }
});
