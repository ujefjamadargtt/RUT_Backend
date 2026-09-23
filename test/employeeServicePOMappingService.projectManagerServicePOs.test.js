'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

/**
 * PM redesign — the two functions that derive a Project Manager's Service PO
 * relationship for approval routing, REUSING the existing
 * employee_servicepo_mapping table (no new PM<->PO table):
 *   - getProjectManagerServicePOIds(pmEmployeeId): PM -> the Service PO ids
 *     they are EXPLICITLY assigned as PM for (is_project_manager = true)
 *   - getProjectManagersForServicePOs(servicePoIds): PO ids -> the active
 *     employees EXPLICITLY assigned as PM (is_project_manager = true) for
 *     any of them, deduped
 *
 * PM DETERMINATION — OLD vs NEW: previously, ANY active
 * employee_servicepo_mapping row for an employee holding the Project
 * Manager role was treated as a PM assignment — so an Employee merely
 * mapped to a Service PO as an ordinary team member (not its PM) was
 * incorrectly treated as its approver. Now both functions filter the
 * repository query itself by `is_project_manager = true`
 * (onlyProjectManager) — a plain mapping (is_project_manager = false) never
 * counts, regardless of the employee's role. Neither function re-checks the
 * employee's role live anymore (getProjectManagersForServicePOs used to,
 * via employeeRoleRepository) — that invariant is instead maintained at
 * WRITE time (assign()/saveEmployeeServicePOMappings()/
 * setMappingProjectManagerFlag() require the role before allowing
 * is_project_manager = true, and employeeService.js's role-removal cascade
 * reverts it to false the moment the role is removed), so is_project_manager
 * = true is trusted as sufficient on its own here.
 *
 * Both still EXCLUDE Centralised Service POs (Leaves, On Bench, Training &
 * Upskilling, HR and Admin Activity, etc.) as defense in depth — a
 * Centralised PO is auto-mapped to EVERY employee with is_project_manager
 * defaulting false, so this should already be a no-op in practice.
 */

const ORIGINAL = {
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByServicePOs: employeeServicePOMappingRepository.findByServicePOs,
  findCentralisedIdsAmong: servicePORepository.findCentralisedIdsAmong,
};

function restore() {
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  employeeServicePOMappingRepository.findByServicePOs = ORIGINAL.findByServicePOs;
  servicePORepository.findCentralisedIdsAmong = ORIGINAL.findCentralisedIdsAmong;
}

function stubNoCentralisedPOs() {
  servicePORepository.findCentralisedIdsAmong = async () => [];
}

// --- getProjectManagerServicePOIds() ---------------------------------------

test('getProjectManagerServicePOIds: queries the repository with onlyProjectManager:true and returns the Service PO ids from the (already PM-filtered) rows', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status, options) => {
      assert.equal(employeeId, 501);
      assert.equal(status, 'active');
      assert.deepEqual(options, { onlyProjectManager: true });
      return [{ service_po_id: 201 }, { service_po_id: 202 }];
    };

    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(501);

    assert.deepEqual(poIds, [201, 202]);
  } finally {
    restore();
  }
});

test('getProjectManagerServicePOIds: a Service PO this employee is merely MAPPED to (is_project_manager=false) never appears — the repository query itself excludes it', async () => {
  try {
    stubNoCentralisedPOs();
    // Simulates the real query: only the is_project_manager=true row (201)
    // is ever returned by the repository for this options flag; PO 202
    // (a plain mapping) is never in this result set at all.
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status, options) => {
      assert.deepEqual(options, { onlyProjectManager: true });
      return [{ service_po_id: 201 }];
    };

    const poIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(501);

    assert.deepEqual(poIds, [201]);
  } finally {
    restore();
  }
});

test('getProjectManagerServicePOIds: EXCLUDES Centralised Service POs (Leaves/On Bench/etc.) even if somehow PM-flagged', async () => {
  try {
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

test('getProjectManagerServicePOIds: no PM-flagged mappings at all short-circuits without checking is_centralised', async () => {
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

// --- getEmployeeRealProjectServicePOIds() ----------------------------------
// A DIFFERENT question from the above: "which real (non-Centralised)
// project(s) is this ARBITRARY employee mapped to at all" — regardless of
// is_project_manager, since this employee is typically NOT a PM themselves.
// Used only by resolveApprovalRoutingServicePOIds() to route a stray
// Centralised-PO (Leave/Bench) reminder to that project's actual PM.

test('getEmployeeRealProjectServicePOIds: returns every active mapping\'s Service PO id, regardless of is_project_manager', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status, options) => {
      assert.equal(employeeId, 101);
      assert.equal(status, 'active');
      assert.equal(options, undefined); // NOT filtered by onlyProjectManager
      return [{ service_po_id: 201 }];
    };

    const poIds = await employeeServicePOMappingService.getEmployeeRealProjectServicePOIds(101);

    assert.deepEqual(poIds, [201]);
  } finally {
    restore();
  }
});

test('getEmployeeRealProjectServicePOIds: EXCLUDES Centralised Service POs', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async () => [
      { service_po_id: 201 },
      { service_po_id: 999 },
    ];
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids, [201, 999]);
      return [999];
    };

    const poIds = await employeeServicePOMappingService.getEmployeeRealProjectServicePOIds(101);

    assert.deepEqual(poIds, [201]);
  } finally {
    restore();
  }
});

// --- getProjectManagersForServicePOs() -------------------------------------

test('getProjectManagersForServicePOs: queries the repository with onlyProjectManager:true; a PO with multiple PM-flagged mappings returns all of them', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async (servicePoIds, status, options) => {
      assert.deepEqual(servicePoIds, [201]);
      assert.equal(status, 'active');
      assert.deepEqual(options, { onlyProjectManager: true });
      return [
        { employee: { id: 5, full_name: 'PM ABC', email: 'abc@example.com', status: 'active' } },
        { employee: { id: 6, full_name: 'PM XYZ', email: 'xyz@example.com', status: 'active' } },
        { employee: { id: 7, full_name: 'PM PQR', email: 'pqr@example.com', status: 'active' } },
      ];
    };

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

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201, 202]);

    assert.equal(managers.length, 1);
    assert.equal(managers[0].id, 5);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: a mapped employee whose row has is_project_manager=false never reaches this function at all — the repository query already excluded it, so no live role check is performed here', async () => {
  try {
    stubNoCentralisedPOs();
    // Simulates the real (PM-filtered) query result: a plain mapping never
    // appears here in the first place, regardless of the employee's role.
    employeeServicePOMappingRepository.findByServicePOs = async () => [];

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201]);

    assert.deepEqual(managers, []);
  } finally {
    restore();
  }
});

test('getProjectManagersForServicePOs: excludes an inactive employee even though their mapping row is PM-flagged', async () => {
  try {
    stubNoCentralisedPOs();
    employeeServicePOMappingRepository.findByServicePOs = async () => [
      { employee: { id: 5, full_name: 'Inactive PM', email: 'inactive@example.com', status: 'inactive' } },
    ];

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

    const managers = await employeeServicePOMappingService.getProjectManagersForServicePOs([201, 999]);

    assert.deepEqual(managers.map((m) => m.id), [5]);
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

// --- resolveApprovalRoutingServicePOIds() ----------------------------------
// Unaffected by the PM redesign at this function's own level — it routes
// through getEmployeeRealProjectServicePOIds() (any active mapping,
// unfiltered), not getProjectManagerServicePOIds(), since the REPORTING
// employee here is an ordinary team member, not necessarily a PM.

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

test('resolveApprovalRoutingServicePOIds: a pending Centralised PO (Leaves) is replaced by the employee\'s OWN real project PO(s), regardless of is_project_manager', async () => {
  try {
    const CENTRALISED = new Set([999]);
    servicePORepository.findCentralisedIdsAmong = async (ids) => ids.filter((id) => CENTRALISED.has(id));
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status, options) => {
      assert.equal(employeeId, 101);
      assert.equal(status, 'active');
      assert.equal(options, undefined); // an ordinary employee's own real project, not PM-filtered
      return [{ service_po_id: 201 }];
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
