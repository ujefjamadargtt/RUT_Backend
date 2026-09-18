'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

/**
 * Timesheet Approval redesign — the two functions that derive a Project
 * Manager's Service PO relationship, REUSING the existing
 * employee_servicepo_mapping table (no new PM<->PO table):
 *   - getProjectManagerServicePOIds(pmEmployeeId): PM -> their mapped PO ids
 *   - getProjectManagersForServicePOs(servicePoIds): PO ids -> the active,
 *     Project-Manager-role-holding employees mapped to any of them, deduped
 *
 * Both EXCLUDE Centralised Service POs (Leaves, On Bench, Training &
 * Upskilling, HR and Admin Activity, etc.) — a real bug report: a
 * Centralised PO is auto-mapped to EVERY employee, so an
 * employee_servicepo_mapping row against one is never a genuine PM
 * assignment. Confirmed live: a Project Manager mapped to Ambulance Tracker
 * (a real project, 5 people) was ALSO auto-mapped to 4 Centralised POs
 * (Leaves/On Bench/Training/HR Admin), which — before this fix — pulled
 * ~90 unrelated employees into their "My Employees" approval scope.
 */

const ORIGINAL = {
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByServicePOs: employeeServicePOMappingRepository.findByServicePOs,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
  findCentralisedIdsAmong: servicePORepository.findCentralisedIdsAmong,
};

function restore() {
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  employeeServicePOMappingRepository.findByServicePOs = ORIGINAL.findByServicePOs;
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
  servicePORepository.findCentralisedIdsAmong = ORIGINAL.findCentralisedIdsAmong;
}

function stubNoCentralisedPOs() {
  servicePORepository.findCentralisedIdsAmong = async () => [];
}

test('getProjectManagerServicePOIds: returns the Service PO ids from this employee\'s active employee_servicepo_mapping rows', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status) => {
      assert.equal(employeeId, 501);
      assert.equal(status, 'active');
      return [{ service_po_id: 201 }, { service_po_id: 202 }];
    };

    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(501);

    assert.deepEqual(poIds, [201, 202]);
  } finally {
    restore();
  }
});

test('getProjectManagerServicePOIds: EXCLUDES Centralised Service POs (Leaves/On Bench/etc.) even though the employee is actively mapped to them', async () => {
  try {
    // PM mapped to one real project (201, Ambulance-like) plus 2 Centralised
    // utility POs (202 = Leaves, 203 = On Bench) via auto-mapping.
    employeeServicePOMappingRepository.findAllByEmployee = async () => [
      { service_po_id: 201 },
      { service_po_id: 202 },
      { service_po_id: 203 },
    ];
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids, [201, 202, 203]);
      return [202, 203];
    };

    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(501);

    assert.deepEqual(poIds, [201]);
  } finally {
    restore();
  }
});

test('getProjectManagerServicePOIds: no mappings at all short-circuits without checking is_centralised', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async () => [];
    servicePORepository.findCentralisedIdsAmong = async () => {
      throw new Error('must not be called when there are no mappings to check');
    };

    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(501);

    assert.deepEqual(poIds, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: PO with multiple Project Managers returns all of them', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async (servicePoIds, status) => {
      assert.deepEqual(servicePoIds, [201]);
      assert.equal(status, 'active');
      return [
        { employee: { id: 5, full_name: 'PM ABC', email: 'abc@example.com', status: 'active' } },
        { employee: { id: 6, full_name: 'PM XYZ', email: 'xyz@example.com', status: 'active' } },
        { employee: { id: 7, full_name: 'PM PQR', email: 'pqr@example.com', status: 'active' } },
      ];
    };
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201]);

    assert.deepEqual(managers.map((m) => m.id).sort(), [5, 6, 7]);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: a Project Manager mapped to MULTIPLE of the given POs is returned exactly once (deduplicated)', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async (servicePoIds) => {
      assert.deepEqual(servicePoIds, [201, 202]);
      return [
        { employee: { id: 5, full_name: 'PM Both', email: 'both@example.com', status: 'active' } }, // mapped to PO1
        { employee: { id: 5, full_name: 'PM Both', email: 'both@example.com', status: 'active' } }, // mapped to PO2 too
      ];
    };
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201, 202]);

    assert.equal(managers.length, 1);
    assert.equal(managers[0].id, 5);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: excludes a mapped employee who does not hold the Project Manager role', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async () => [
      { employee: { id: 5, full_name: 'Regular Employee', email: 'reg@example.com', status: 'active' } },
    ];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201]);

    assert.deepEqual(managers, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: excludes an inactive Project Manager', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async () => [
      { employee: { id: 5, full_name: 'Inactive PM', email: 'inactive@example.com', status: 'inactive' } },
    ];
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201]);

    assert.deepEqual(managers, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: a pending Service PO that IS Centralised (e.g. Leaves) never floods every Project Manager in the company', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids, [999]);
      return [999]; // 999 = "Leaves", Centralised
    };
    employeeServicePOMappingRepository.findByServicePOs = async () => {
      throw new Error('must not query mappings for a Centralised PO at all — it is filtered out before this point');
    };

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([999]);

    assert.deepEqual(managers, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: a mix of one real PO and one Centralised PO only resolves Project Managers for the real one', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids, [201, 999]);
      return [999];
    };
    employeeServicePOMappingRepository.findByServicePOs = async (servicePoIds) => {
      assert.deepEqual(servicePoIds, [201]);
      return [{ employee: { id: 5, full_name: 'Real PM', email: 'real@example.com', status: 'active' } }];
    };
    employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201, 999]);

    assert.deepEqual(managers.map((m) => m.id), [5]);
  } finally {
    restore();
  }
});

test('resolveApprovalRoutingServicePOIds: non-Centralised pending POs pass through unchanged, no Employee-mapping lookup needed', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids, [201, 202]);
      return [];
    };
    employeeServicePOMappingRepository.findAllByEmployee = async () => {
      throw new Error('must not resolve the employee\'s own real POs when nothing pending is Centralised');
    };

    const routed = await employeeServicePOMappingService.resolveApprovalRoutingServicePOIds(101, [201, 202]);

    assert.deepEqual(routed.slice().sort((a, b) => a - b), [201, 202]);
  } finally {
    restore();
  }
});

test('resolveApprovalRoutingServicePOIds: a pending Centralised PO (Leaves) is replaced by the employee\'s OWN real project PO(s)', async () => {
  try {
    // findCentralisedIdsAmong is called twice here — once for the raw
    // pending set, once again (inside getProjectManagerServicePOIds) to
    // filter the employee's own resolved mappings — so this must behave
    // like a real "which of these are Centralised" filter, not assert one
    // fixed input.
    const CENTRALISED = new Set([999]);
    servicePORepository.findCentralisedIdsAmong = async (ids) => ids.filter((id) => CENTRALISED.has(id));
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status) => {
      assert.equal(employeeId, 101);
      assert.equal(status, 'active');
      return [{ service_po_id: 201 }]; // this employee's own real project
    };

    const routed = await employeeServicePOMappingService.resolveApprovalRoutingServicePOIds(101, [999]);

    assert.deepEqual(routed, [201]);
  } finally {
    restore();
  }
});

test('resolveApprovalRoutingServicePOIds: a mix of one real pending PO and one Centralised PO keeps the real one AND adds the employee\'s own real PO(s)', async () => {
  try {
    const CENTRALISED = new Set([999]);
    servicePORepository.findCentralisedIdsAmong = async (ids) => ids.filter((id) => CENTRALISED.has(id));
    employeeServicePOMappingRepository.findAllByEmployee = async () => [{ service_po_id: 201 }, { service_po_id: 300 }];

    const routed = await employeeServicePOMappingService.resolveApprovalRoutingServicePOIds(101, [201, 999]);

    assert.deepEqual(routed.slice().sort((a, b) => a - b), [201, 300]);
  } finally {
    restore();
  }
});

test('resolveApprovalRoutingServicePOIds: an employee with ONLY Centralised pending work and no real project at all resolves to an empty set', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async () => [999];
    employeeServicePOMappingRepository.findAllByEmployee = async () => [];

    const routed = await employeeServicePOMappingService.resolveApprovalRoutingServicePOIds(101, [999]);

    assert.deepEqual(routed, []);
  } finally {
    restore();
  }
});

test('resolveApprovalRoutingServicePOIds: empty input short-circuits without querying anything', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async () => {
      throw new Error('must not be called for an empty pendingServicePOIds array');
    };

    const routed = await employeeServicePOMappingService.resolveApprovalRoutingServicePOIds(101, []);

    assert.deepEqual(routed, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: empty input short-circuits without querying anything', async () => {
  try {
    servicePORepository.findCentralisedIdsAmong = async () => {
      throw new Error('must not be called for an empty servicePoIds array');
    };
    employeeServicePOMappingRepository.findByServicePOs = async () => {
      throw new Error('must not be called for an empty servicePoIds array');
    };

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([]);

    assert.deepEqual(managers, []);
  } finally {
    restore();
  }
});
