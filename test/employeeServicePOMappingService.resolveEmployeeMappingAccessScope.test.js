'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

// resolveEmployeeMappingAccessScope() — regression coverage for the REAL
// "BU Admin sees 10 of 18" bug, root-caused against the live dev database:
// an Employee directly created by the owning Admin but never assigned to
// any Business Unit matches neither a plain companyId/employeeScope()
// check, only `created_by: adminId` — exactly what
// employeeAccessControlService.resolveEmployeeAccessWhere() already gives
// Admin/Entity Admin themselves, but which a BU Admin/Service PO Admin/
// Delivery Head's OLD scope resolution (companyId array only) silently
// dropped. This proves the fixed "found the owning Admin" branch actually
// builds the OR-fragment, not just via the coincidental "no admin
// resolved" fallback other tests exercise.
const employeeRepository = require('../src/repositories/employeeRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  employeeScope: employeeRepository.employeeScope,
  resolveAdminOwnershipForBusinessUnits: companyAccessControlService.resolveAdminOwnershipForBusinessUnits,
};

function restore() {
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = ORIGINAL.resolveAdminOwnershipForBusinessUnits;
}

test('when an owning Admin IS resolved, accessWhere includes { id: adminId } and { created_by: adminId } alongside the BU-membership scope', async () => {
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = async (ownBusinessUnitIds) => {
    assert.deepEqual(ownBusinessUnitIds, [89, 91]);
    return { adminIds: [594], companyIds: [89, 91, 92] };
  };
  employeeRepository.employeeScope = async (companyIds) => {
    assert.deepEqual(companyIds, [89, 91, 92]);
    return { [Op.or]: [{ company_id: { [Op.in]: [89, 91, 92] } }, { id: { [Op.in]: [610, 611, 612] } }] };
  };

  const result = await employeeServicePOMappingService.resolveEmployeeMappingAccessScope({
    hierarchyRank: 4,
    employeeId: 600,
    companyId: undefined,
    employeeBusinessUnits: [89, 91],
  });

  assert.equal(result.companyId, undefined);
  const orTerms = result.accessWhere[Op.or];
  assert.ok(orTerms.some((t) => t.id === 594), 'missing { id: 594 } (the resolved Admin themselves)');
  assert.ok(orTerms.some((t) => t.created_by === 594), 'missing { created_by: 594 } — the actual bug: an Admin-created, BU-less Employee would be dropped without this');
  assert.ok(orTerms.some((t) => t.company_id), 'missing the underlying BU-membership scope term');
  restore();
});

test('multiple resolved owning Admins each get their own { id }/{ created_by } pair', async () => {
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = async () => ({
    adminIds: [594, 700],
    companyIds: [89, 91, 92],
  });
  employeeRepository.employeeScope = async () => ({ company_id: { [Op.in]: [89, 91, 92] } });

  const result = await employeeServicePOMappingService.resolveEmployeeMappingAccessScope({
    hierarchyRank: 4, employeeId: 600, companyId: undefined, employeeBusinessUnits: [89, 91],
  });

  const orTerms = result.accessWhere[Op.or];
  assert.ok(orTerms.some((t) => t.id === 594));
  assert.ok(orTerms.some((t) => t.created_by === 594));
  assert.ok(orTerms.some((t) => t.id === 700));
  assert.ok(orTerms.some((t) => t.created_by === 700));
  restore();
});

test('when NO owning Admin can be resolved, falls back to a plain companyId array (defensive, matches resolveEmployeeMappingScope\'s own fallback)', async () => {
  companyAccessControlService.resolveAdminOwnershipForBusinessUnits = async () => ({ adminIds: [], companyIds: [89, 91] });

  const result = await employeeServicePOMappingService.resolveEmployeeMappingAccessScope({
    hierarchyRank: 4, employeeId: 600, companyId: undefined, employeeBusinessUnits: [89, 91],
  });

  assert.deepEqual(result.companyId, [89, 91]);
  assert.equal(result.accessWhere, undefined);
  restore();
});

test('an actor with no Business Units at all and no companyId returns an empty companyId array, never unrestricted', async () => {
  const result = await employeeServicePOMappingService.resolveEmployeeMappingAccessScope({
    hierarchyRank: 4, employeeId: 600, companyId: undefined, employeeBusinessUnits: [],
  });

  assert.deepEqual(result.companyId, []);
  assert.equal(result.accessWhere, undefined);
});
