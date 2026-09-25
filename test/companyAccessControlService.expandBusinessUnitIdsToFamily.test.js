'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Company } = require('../src/models');
const companyRepository = require('../src/repositories/companyRepository');
const {
  expandBusinessUnitIdsToFamily,
  resolveCreateCompanyIdForActor,
} = require('../src/services/companyAccessControlService');

/**
 * BU Hierarchy / Sub-BU support — expandBusinessUnitIdsToFamily() (a
 * Sub-BU expands to its whole Parent + Sub-BU family) and
 * resolveCreateCompanyIdForActor()'s use of it: a BU Admin mapped to only
 * one Sub-BU (e.g. "DAS") must be able to create a Client/Project/Service
 * PO under any of its siblings (e.g. "IBM") or their shared Parent, not
 * just their own literal mapping — matching what
 * companyService.getAllForEmployee()'s dropdown now offers them.
 */

const ORIGINAL = {
  companyFindAll: Company.findAll,
  findFamilyMembers: companyRepository.findFamilyMembers,
};

function restore() {
  Company.findAll = ORIGINAL.companyFindAll;
  companyRepository.findFamilyMembers = ORIGINAL.findFamilyMembers;
}

test('expandBusinessUnitIdsToFamily: a Sub-BU id expands to itself + its Parent + sibling Sub-BUs', async () => {
  try {
    Company.findAll = async () => [{ id: 42, parent_business_unit_id: 23 }];
    companyRepository.findFamilyMembers = async (rootIds) => {
      assert.deepEqual(rootIds, [23]);
      return [{ id: 23 }, { id: 42 }, { id: 43 }, { id: 44 }];
    };

    const result = await expandBusinessUnitIdsToFamily([42]);
    assert.deepEqual(result.sort((a, b) => a - b), [23, 42, 43, 44]);
  } finally {
    restore();
  }
});

test('expandBusinessUnitIdsToFamily: a childless, parent-less BU expands to itself only', async () => {
  try {
    Company.findAll = async () => [{ id: 10, parent_business_unit_id: null }];
    companyRepository.findFamilyMembers = async (rootIds) => {
      assert.deepEqual(rootIds, [10]);
      return [{ id: 10 }];
    };

    const result = await expandBusinessUnitIdsToFamily([10]);
    assert.deepEqual(result, [10]);
  } finally {
    restore();
  }
});

test('expandBusinessUnitIdsToFamily: empty/absent ids returns as-is, no DB call', async () => {
  assert.deepEqual(await expandBusinessUnitIdsToFamily([]), []);
  assert.deepEqual(await expandBusinessUnitIdsToFamily(undefined), []);
});

test('resolveCreateCompanyIdForActor(): a BU Admin mapped to only "DAS" (42) may create a record under sibling "IBM" (43)', async () => {
  try {
    Company.findAll = async () => [{ id: 42, parent_business_unit_id: 23 }];
    companyRepository.findFamilyMembers = async () => [{ id: 23 }, { id: 42 }, { id: 43 }, { id: 44 }];

    const req = { companyId: 42, employeeBusinessUnits: [{ id: 42 }], hierarchyRank: 4 };
    const result = await resolveCreateCompanyIdForActor(req, 43, { resourceLabel: 'a Client' });

    assert.equal(result, 43);
  } finally {
    restore();
  }
});

test('resolveCreateCompanyIdForActor(): rejects a BU entirely outside the actor\'s family, with 403', async () => {
  try {
    Company.findAll = async () => [{ id: 42, parent_business_unit_id: 23 }];
    companyRepository.findFamilyMembers = async () => [{ id: 23 }, { id: 42 }, { id: 43 }, { id: 44 }];

    const req = { companyId: 42, employeeBusinessUnits: [{ id: 42 }], hierarchyRank: 4 };

    await assert.rejects(
      () => resolveCreateCompanyIdForActor(req, 999, { resourceLabel: 'a Client' }),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  } finally {
    restore();
  }
});
