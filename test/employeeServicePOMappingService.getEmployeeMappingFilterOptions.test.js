'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// getEmployeeMappingFilterOptions() — the Service PO -> Map Employees
// screen's Entity → Business Unit filter dropdowns. Deliberately NOT backed
// by GET /entities or GET /companies (both 403 a BU Admin/Service PO Admin/
// Delivery Head, and GET /companies ignores entity_id for a BU Admin and
// returns only their own directly-mapped BUs) — instead reuses
// resolveEmployeeMappingScope(), the same plain company/BU id list already
// used to authorize the PO lookup in getEmployeeOptionsForServicePO().
const companyRepository = require('../src/repositories/companyRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findByIdsWithEntity: companyRepository.findByIdsWithEntity,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
};

function restore() {
  companyRepository.findByIdsWithEntity = ORIGINAL.findByIdsWithEntity;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
}

function stubCompanies(companies) {
  let capturedIds;
  companyRepository.findByIdsWithEntity = async (ids) => {
    capturedIds = ids;
    return companies;
  };
  return { getCapturedIds: () => capturedIds };
}

const BU_ADMIN_MULTI_BU = {
  companyId: 1,
  hierarchyRank: 4,
  employeeId: 900,
  roleNames: ['BU Admin'],
  employeeBusinessUnits: [1, 2],
};

test('rejects a caller with no Service PO mapping authority with 403', async () => {
  await assert.rejects(
    () => employeeServicePOMappingService.getEmployeeMappingFilterOptions({
      companyId: 1, hierarchyRank: 8, employeeId: 900, roleNames: ['Employee'], employeeBusinessUnits: [1],
    }),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
  restore();
});

test('BU Admin: resolves the owning Admin\'s full Business Unit scope (not just their own directly-mapped BUs), and groups them by Entity', async () => {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async () => [1, 2, 3];
  const { getCapturedIds } = stubCompanies([
    { id: 1, company_name: 'Alpha BU', entity_id: 10, entity: { entity_id: 10, entity_name: 'Alpha Entity' } },
    { id: 2, company_name: 'Beta BU', entity_id: 10, entity: { entity_id: 10, entity_name: 'Alpha Entity' } },
    { id: 3, company_name: 'Gamma BU', entity_id: 20, entity: { entity_id: 20, entity_name: 'Gamma Entity' } },
  ]);

  const result = await employeeServicePOMappingService.getEmployeeMappingFilterOptions(BU_ADMIN_MULTI_BU);

  assert.deepEqual(getCapturedIds(), [1, 2, 3]);
  assert.equal(result.business_units.length, 3);
  assert.deepEqual(result.entities, [
    { id: 10, entity_name: 'Alpha Entity' },
    { id: 20, entity_name: 'Gamma Entity' },
  ]);
  restore();
});

test('Admin (hierarchyRank 2): scope comes from resolveOwnedCompanyIds, not the BU-ownership path', async () => {
  companyAccessControlService.resolveOwnedCompanyIds = async () => [10, 20];
  const { getCapturedIds } = stubCompanies([]);

  await employeeServicePOMappingService.getEmployeeMappingFilterOptions({
    companyId: null, hierarchyRank: 2, employeeId: 1, roleNames: [], employeeBusinessUnits: [],
  });

  assert.deepEqual(getCapturedIds(), [10, 20]);
  restore();
});

test('a Business Unit with no Entity association is included in business_units but contributes nothing to entities', async () => {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async () => [1];
  stubCompanies([{ id: 1, company_name: 'Orphan BU', entity_id: null, entity: null }]);

  const result = await employeeServicePOMappingService.getEmployeeMappingFilterOptions(BU_ADMIN_MULTI_BU);

  assert.equal(result.business_units.length, 1);
  assert.deepEqual(result.entities, []);
  restore();
});

test('Service PO Admin / Delivery Head get the same treatment as BU Admin (authorized via role name, not hierarchyRank)', async () => {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async () => [5];
  stubCompanies([{ id: 5, company_name: 'Delta BU', entity_id: 30, entity: { entity_id: 30, entity_name: 'Delta Entity' } }]);

  const result = await employeeServicePOMappingService.getEmployeeMappingFilterOptions({
    companyId: 1, hierarchyRank: 6, employeeId: 900, roleNames: ['Service PO Admin'], employeeBusinessUnits: [5],
  });

  assert.equal(result.business_units.length, 1);
  assert.equal(result.entities.length, 1);
  restore();
});
