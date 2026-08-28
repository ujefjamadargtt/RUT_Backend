'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Company } = require('../src/models');
const { resolveActorCompanyScopeForSelectedBU } = require('../src/services/companyAccessControlService');

const ORIGINAL = {
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubOwnedCompanies(ids) {
  Entity.findAll = async () => [{ id: 6 }];
  Company.findAll = async () => ids.map((id) => ({ id }));
}

test('BU-scoped actor (companyId already set) is returned unchanged, ignoring any header', async () => {
  const scope = await resolveActorCompanyScopeForSelectedBU(
    { companyId: 54, hierarchyRank: 4, employeeId: 120 },
    99
  );
  assert.equal(scope, 54);
});

test('company-less actor with NO header falls back to the full owned-Company-id array (existing, unrestricted behavior)', async () => {
  stubOwnedCompanies([46, 47]);
  const scope = await resolveActorCompanyScopeForSelectedBU(
    { companyId: null, hierarchyRank: 2, employeeId: 1 },
    null
  );
  assert.deepEqual(scope, [46, 47]);
  restore();
});

test('company-less actor with a header naming an OWNED Company narrows to just that ONE Business Unit', async () => {
  stubOwnedCompanies([46, 47]);
  const scope = await resolveActorCompanyScopeForSelectedBU(
    { companyId: null, hierarchyRank: 2, employeeId: 1 },
    47
  );
  assert.deepEqual(scope, [47]);
  restore();
});

test('company-less actor with a header naming a Company NOT in their owned set is rejected with 403, never silently widened or ignored', async () => {
  stubOwnedCompanies([46, 47]);
  await assert.rejects(
    () => resolveActorCompanyScopeForSelectedBU({ companyId: null, hierarchyRank: 3, employeeId: 50 }, 999),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
  restore();
});

test('company-less actor owning zero Companies with no header returns an empty array (matches nothing, never unrestricted)', async () => {
  stubOwnedCompanies([]);
  const scope = await resolveActorCompanyScopeForSelectedBU(
    { companyId: null, hierarchyRank: 3, employeeId: 999 },
    null
  );
  assert.deepEqual(scope, []);
  restore();
});
