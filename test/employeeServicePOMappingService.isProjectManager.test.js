'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// PM redesign — Project Manager status is now an explicit, per-mapping flag
// (employee_servicepo_mapping.is_project_manager), never inferred merely
// from the employee holding the Project Manager role plus an active mapping
// row. Covers: assign() (Section 11.B — Service PO Master entry point),
// setMappingProjectManagerFlag() (Section 8 Case 1 — toggle PM status on an
// existing mapping without deleting it), and saveEmployeeServicePOMappings()
// (Section 11.A — Employee Master entry point's per-row PM checkbox).
// Same monkey-patch style as test/employeeServicePOMappingService.
// crossTenant.test.js / serviceOptions.test.js — every repository call
// stubbed, no real DB.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: employeeRepository.findById,
  findBusinessUnitsByEmployeeId: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
  poFindById: servicePORepository.findById,
  getEligibleForMapping: servicePORepository.getEligibleForMapping,
  mappingFindById: employeeServicePOMappingRepository.findById,
  mappingFindByIdUnscoped: employeeServicePOMappingRepository.findByIdUnscoped,
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  create: employeeServicePOMappingRepository.create,
  updateProjectManagerFlag: employeeServicePOMappingRepository.updateProjectManagerFlag,
  findByEmployee: employeeServicePOMappingRepository.findByEmployee,
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByEmployeeAndPOIds: employeeServicePOMappingRepository.findByEmployeeAndPOIds,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
  bulkUpdateStatus: employeeServicePOMappingRepository.bulkUpdateStatus,
  bulkSetProjectManagerFlag: employeeServicePOMappingRepository.bulkSetProjectManagerFlag,
};

function restore() {
  employeeRepository.findById = ORIGINAL.findById;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = ORIGINAL.findBusinessUnitsByEmployeeId;
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
  servicePORepository.findById = ORIGINAL.poFindById;
  servicePORepository.getEligibleForMapping = ORIGINAL.getEligibleForMapping;
  employeeServicePOMappingRepository.findById = ORIGINAL.mappingFindById;
  employeeServicePOMappingRepository.findByIdUnscoped = ORIGINAL.mappingFindByIdUnscoped;
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  employeeServicePOMappingRepository.create = ORIGINAL.create;
  employeeServicePOMappingRepository.updateProjectManagerFlag = ORIGINAL.updateProjectManagerFlag;
  employeeServicePOMappingRepository.findByEmployee = ORIGINAL.findByEmployee;
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = ORIGINAL.findByEmployeeAndPOIds;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeServicePOMappingRepository.bulkUpdateStatus = ORIGINAL.bulkUpdateStatus;
  employeeServicePOMappingRepository.bulkSetProjectManagerFlag = ORIGINAL.bulkSetProjectManagerFlag;
}

const AUTH_CONTEXT = { companyId: 10, hierarchyRank: 4, employeeId: 900 };

// === assign() — Section 11.B / 13 ==========================================

test('Test 1 — assign(): mapping an Employee normally (is_project_manager omitted) stores is_project_manager: false', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
    employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;
    let captured;
    employeeServicePOMappingRepository.create = async (data) => { captured = data; return { id: 1, ...data }; };

    await employeeServicePOMappingService.assign(101, 401, 1, 10);

    assert.equal(captured.is_project_manager, false);
  } finally {
    restore();
  }
});

test('Test 2 — assign(): is_project_manager=true, employee holds the Project Manager role -> mapping created as PM', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
    employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;
    employeeRoleRepository.findRolesByEmployeeId = async (employeeId) => {
      assert.equal(employeeId, 101);
      return [{ role_name: 'Project Manager' }];
    };
    let captured;
    employeeServicePOMappingRepository.create = async (data) => { captured = data; return { id: 1, ...data }; };

    await employeeServicePOMappingService.assign(101, 401, 1, 10, true);

    assert.equal(captured.is_project_manager, true);
  } finally {
    restore();
  }
});

test('Test 3 — assign(): is_project_manager=true rejected with 400 when the employee does NOT hold the Project Manager role, and nothing is written', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
    employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
    employeeServicePOMappingRepository.create = async () => {
      throw new Error('must not be reached — role validation must reject first');
    };

    await assert.rejects(
      () => employeeServicePOMappingService.assign(101, 401, 1, 10, true),
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('Test 4 — assign(): the Project Manager ROLE alone is never sufficient — a mapping created without is_project_manager stays a plain mapping even for a PM-role employee', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 101, company_id: 10, status: 'active' });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, status: 'in-progress' });
    employeeServicePOMappingRepository.findByEmployeeAndPO = async () => null;
    employeeRoleRepository.findRolesByEmployeeId = async () => {
      throw new Error('must not even check the role — is_project_manager was never requested');
    };
    let captured;
    employeeServicePOMappingRepository.create = async (data) => { captured = data; return { id: 1, ...data }; };

    await employeeServicePOMappingService.assign(101, 401, 1, 10); // isProjectManager omitted

    assert.equal(captured.is_project_manager, false);
  } finally {
    restore();
  }
});

// === setMappingProjectManagerFlag() — Section 8 Case 1 =====================

test('Test 5 — setMappingProjectManagerFlag(): false -> true succeeds when the mapping\'s employee holds the Project Manager role', async () => {
  try {
    let captured;
    employeeServicePOMappingRepository.findByIdUnscoped = async (id) => {
      assert.equal(id, 55);
      return {
        id: 55, employee_id: 101, service_po_id: 401, is_project_manager: false,
        async update(values) { captured = values; return { id: 55, ...values }; },
      };
    };
    servicePORepository.findById = async (poId, companyId) => {
      assert.equal(poId, 401);
      assert.equal(companyId, 10);
      return { id: 401, company_id: 10, is_centralised: false };
    };
    employeeRoleRepository.findRolesByEmployeeId = async (employeeId) => {
      assert.equal(employeeId, 101);
      return [{ role_name: 'Project Manager' }];
    };

    const result = await employeeServicePOMappingService.setMappingProjectManagerFlag(55, true, 1, 10);

    assert.deepEqual(captured, { is_project_manager: true, updated_by: 1 });
    assert.equal(result.is_project_manager, true);
  } finally {
    restore();
  }
});

test('Test 6 — setMappingProjectManagerFlag(): true -> false is always allowed, without any role check, and the mapping row is kept (not deleted)', async () => {
  try {
    let captured;
    employeeServicePOMappingRepository.findByIdUnscoped = async () => ({
      id: 55, employee_id: 101, service_po_id: 401, is_project_manager: true,
      async update(values) { captured = values; return { id: 55, ...values }; },
      async destroy() { throw new Error('must not delete the mapping row'); },
    });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, is_centralised: false });
    employeeRoleRepository.findRolesByEmployeeId = async () => {
      throw new Error('must not be called — turning PM OFF never requires a role check');
    };

    const result = await employeeServicePOMappingService.setMappingProjectManagerFlag(55, false, 1, 10);

    assert.deepEqual(captured, { is_project_manager: false, updated_by: 1 });
    assert.equal(result.is_project_manager, false);
  } finally {
    restore();
  }
});

test('Test 7 — setMappingProjectManagerFlag(): false -> true rejected with 400 when the mapping\'s employee does not hold the Project Manager role', async () => {
  try {
    employeeServicePOMappingRepository.findByIdUnscoped = async () => ({
      id: 55, employee_id: 101, service_po_id: 401, is_project_manager: false,
      async update() { throw new Error('must not be reached — role validation must reject first'); },
    });
    servicePORepository.findById = async () => ({ id: 401, company_id: 10, is_centralised: false });
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];

    await assert.rejects(
      () => employeeServicePOMappingService.setMappingProjectManagerFlag(55, true, 1, 10),
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('Test 8 — setMappingProjectManagerFlag(): 404s when the mapping does not exist (or falls outside the caller\'s scope)', async () => {
  try {
    employeeServicePOMappingRepository.findByIdUnscoped = async () => null;

    await assert.rejects(
      () => employeeServicePOMappingService.setMappingProjectManagerFlag(999, true, 1, 10),
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  } finally {
    restore();
  }
});

// === saveEmployeeServicePOMappings() — Section 11.A / 13 ===================

test('Test 9 — saveEmployeeServicePOMappings(): plain-number entries (original API contract) default every mapping to is_project_manager: false', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
    servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [];
    employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [];
    employeeServicePOMappingRepository.findByEmployee = async () => [];
    let created;
    employeeServicePOMappingRepository.bulkCreate = async (records) => { created = records; return records; };
    employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => ids.length;

    await employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1], 900, AUTH_CONTEXT);

    assert.equal(created[0].is_project_manager, false);
  } finally {
    restore();
  }
});

test('Test 10 — saveEmployeeServicePOMappings(): { service_po_id, is_project_manager: true } creates the row as PM when the employee holds the role', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
    servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [];
    employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [];
    employeeServicePOMappingRepository.findByEmployee = async () => [];
    let created;
    employeeServicePOMappingRepository.bulkCreate = async (records) => { created = records; return records; };
    employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => ids.length;

    await employeeServicePOMappingService.saveEmployeeServicePOMappings(
      1, [{ service_po_id: 1, is_project_manager: true }], 900, AUTH_CONTEXT
    );

    assert.equal(created[0].is_project_manager, true);
  } finally {
    restore();
  }
});

test('Test 11 — saveEmployeeServicePOMappings(): is_project_manager=true rejected with 400 when the employee does not hold the Project Manager role, and NOTHING is written', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
    servicePORepository.getEligibleForMapping = async () => {
      throw new Error('must not be reached — PM-role validation runs before eligibility is even fetched');
    };
    employeeServicePOMappingRepository.bulkCreate = async () => { throw new Error('must not write anything'); };

    await assert.rejects(
      () => employeeServicePOMappingService.saveEmployeeServicePOMappings(
        1, [{ service_po_id: 1, is_project_manager: true }], 900, AUTH_CONTEXT
      ),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /1/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('Test 12 — saveEmployeeServicePOMappings(): an existing ACTIVE mapping\'s PM flag flips false -> true, updating the SAME row (no status change, no create)', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
    servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [{ service_po_id: 1, status: 'active' }];
    employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
      { id: 11, service_po_id: 1, status: 'active', is_project_manager: false },
    ];
    employeeServicePOMappingRepository.findByEmployee = async () => [];
    employeeServicePOMappingRepository.bulkCreate = async () => { throw new Error('must not create — the row already exists'); };
    employeeServicePOMappingRepository.bulkUpdateStatus = async () => { throw new Error('must not touch status — it is already active'); };
    let setTrue = null;
    let setFalse = null;
    employeeServicePOMappingRepository.bulkSetProjectManagerFlag = async (ids, isProjectManager) => {
      if (isProjectManager) setTrue = ids; else setFalse = ids;
      return ids.length;
    };

    await employeeServicePOMappingService.saveEmployeeServicePOMappings(
      1, [{ service_po_id: 1, is_project_manager: true }], 900, AUTH_CONTEXT
    );

    assert.deepEqual(setTrue, [11]);
    assert.equal(setFalse, null);
  } finally {
    restore();
  }
});

test('Test 13 — saveEmployeeServicePOMappings(): an existing ACTIVE PM mapping flips true -> false, updating the SAME row (mapping stays, becomes a plain employee mapping)', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
    servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [{ service_po_id: 1, status: 'active' }];
    employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
      { id: 11, service_po_id: 1, status: 'active', is_project_manager: true },
    ];
    employeeServicePOMappingRepository.findByEmployee = async () => [];
    let setTrue = null;
    let setFalse = null;
    employeeServicePOMappingRepository.bulkSetProjectManagerFlag = async (ids, isProjectManager) => {
      if (isProjectManager) setTrue = ids; else setFalse = ids;
      return ids.length;
    };

    // Desired set still includes PO 1 (the mapping itself is kept) but with
    // is_project_manager: false — same plain-number semantics as the
    // original array contract for that one entry.
    await employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1], 900, AUTH_CONTEXT);

    assert.deepEqual(setFalse, [11]);
    assert.equal(setTrue, null);
  } finally {
    restore();
  }
});

test('Test 14 — saveEmployeeServicePOMappings(): resaving the identical PM state a second time is a no-op — no PM-flag update call at all', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
    servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [{ service_po_id: 1, status: 'active' }];
    employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
      { id: 11, service_po_id: 1, status: 'active', is_project_manager: true },
    ];
    employeeServicePOMappingRepository.findByEmployee = async () => [];
    employeeServicePOMappingRepository.bulkCreate = async () => { throw new Error('must not create'); };
    employeeServicePOMappingRepository.bulkUpdateStatus = async () => { throw new Error('must not touch status'); };
    employeeServicePOMappingRepository.bulkSetProjectManagerFlag = async () => {
      throw new Error('must not be called — is_project_manager is unchanged (already true)');
    };

    await employeeServicePOMappingService.saveEmployeeServicePOMappings(
      1, [{ service_po_id: 1, is_project_manager: true }], 900, AUTH_CONTEXT
    );
  } finally {
    restore();
  }
});

// === Existing mappings default to false — Section 15 (backward compat) ====

test('Test 15 — an existing mapping row from before this feature (no is_project_manager column value set client-side) is treated as a plain (non-PM) mapping', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
    servicePORepository.getEligibleForMapping = async () => [];
    employeeServicePOMappingRepository.findByEmployee = async () => [
      { service_po_id: 1, status: 'active', is_project_manager: false },
    ];

    const result = await employeeServicePOMappingService.getServicePOOptionsForEmployee(1, AUTH_CONTEXT);

    assert.deepEqual(result.mapped_service_po_ids, [1]);
    assert.deepEqual(result.project_manager_service_po_ids, []);
  } finally {
    restore();
  }
});

test('Test 16 — getServicePOOptionsForEmployee(): project_manager_service_po_ids reflects only the ACTIVE, PM-flagged mappings', async () => {
  try {
    employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
    servicePORepository.getEligibleForMapping = async () => [];
    employeeServicePOMappingRepository.findByEmployee = async () => [
      { service_po_id: 101, status: 'active', is_project_manager: true },
      { service_po_id: 102, status: 'active', is_project_manager: false },
      { service_po_id: 104, status: 'active', is_project_manager: true },
      { service_po_id: 105, status: 'inactive', is_project_manager: true }, // inactive -> excluded
    ];

    const result = await employeeServicePOMappingService.getServicePOOptionsForEmployee(1, AUTH_CONTEXT);

    assert.deepEqual(result.project_manager_service_po_ids.sort((a, b) => a - b), [101, 104]);
  } finally {
    restore();
  }
});
