'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const managerServicePOMappingRepository = require('../src/repositories/managerServicePOMappingRepository');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');

const originals = {
  findByManager: managerServicePOMappingRepository.findByManager,
};

function restore() {
  managerServicePOMappingRepository.findByManager = originals.findByManager;
}

// Regression test for a real bug report: GET /my-team/service-pos crashed
// for a cross-BU login (Admin/Entity Admin/Platform Admin, hierarchy_rank
// 1-3) with "WHERE parameter \"company_id\" has invalid \"undefined\" value".
// Those roles carry no company_id on their own account (see
// resolveCompany.js's early-return for ranks 1-3), so falling through to the
// manager_servicepo_mappings-scoped query with an undefined companyId blew
// up. This is a "my own self-service grants" list, which doesn't apply to a
// cross-BU role at all — it must short-circuit to an empty list without
// touching company_id.
for (const hierarchyRank of [1, 2, 3]) {
  test(`getMyGrantedServicePOs returns an empty list for Admin tier (rank ${hierarchyRank}) without resolving company_id`, async () => {
    try {
      managerServicePOMappingRepository.findByManager = async () => {
        throw new Error('Admin tier must not query manager_servicepo_mappings with an undefined company_id');
      };

      const pos = await managerSelfServiceService.getMyGrantedServicePOs(99, undefined, hierarchyRank, []);

      assert.deepEqual(pos, []);
    } finally {
      restore();
    }
  });
}

test('getMyGrantedServicePOs still queries manager_servicepo_mappings for a BU-scoped Manager (unchanged behavior)', async () => {
  try {
    let calledWith;
    managerServicePOMappingRepository.findByManager = async (managerId, companyId) => {
      calledWith = { managerId, companyId };
      return [];
    };

    const pos = await managerSelfServiceService.getMyGrantedServicePOs(99, 5, null, []);

    assert.deepEqual(calledWith, { managerId: 99, companyId: 5 });
    assert.deepEqual(pos, []);
  } finally {
    restore();
  }
});
