'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — servicePOService.js holds a live reference to these SAME
// module-cached objects (it does `const x = require(...)` then calls
// `x.someFn(...)`, never destructures at import time), so mutating a
// property here is visible to the service's own calls. No mocking library
// needed, consistent with this repo's plain node:test setup.
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const timesheetRepository = require('../src/repositories/timesheetRepository');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  findByServicePO: servicePOHierarchyRepository.findByServicePO,
  existsForServicePO: timesheetRepository.existsForServicePO,
  existsForServicePOOrHierarchy: employeeWorkLogRepository.existsForServicePOOrHierarchy,
  findById: servicePORepository.findById,
  softDelete: servicePORepository.softDelete,
};

function restore() {
  servicePOHierarchyRepository.findByServicePO = ORIGINAL.findByServicePO;
  timesheetRepository.existsForServicePO = ORIGINAL.existsForServicePO;
  employeeWorkLogRepository.existsForServicePOOrHierarchy = ORIGINAL.existsForServicePOOrHierarchy;
  servicePORepository.findById = ORIGINAL.findById;
  servicePORepository.softDelete = ORIGINAL.softDelete;
}

// ABC Service PO -> Parent 1 (-> Child 1, Child 2), Parent 2 (-> Child 3) —
// matches the ticket's own hierarchy example.
const FAKE_PO = { id: 293, service_po_name: 'ABC Service PO' };
const HIERARCHY_NODES = [
  { id: 1, node_type: 'PARENT' },
  { id: 2, node_type: 'CHILD' },
  { id: 3, node_type: 'CHILD' },
  { id: 4, node_type: 'PARENT' },
  { id: 5, node_type: 'CHILD' },
];

const EXPECTED_MESSAGE = 'This Service PO cannot be deleted because work log entries exist for this Service PO or its hierarchy.';

test('1. Work log exists on the Main Service PO (official timesheets table) -> delete blocked', async () => {
  servicePORepository.findById = async () => FAKE_PO;
  servicePOHierarchyRepository.findByServicePO = async () => HIERARCHY_NODES;
  timesheetRepository.existsForServicePO = async () => true; // Main PO has a timesheet row
  employeeWorkLogRepository.existsForServicePOOrHierarchy = async () => false;
  servicePORepository.softDelete = async () => {
    throw new Error('softDelete must NOT be called when a work log exists');
  };

  await assert.rejects(
    () => servicePOService.delete(293, 1, 4),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );

  restore();
});

test('2. Work log exists on a Parent hierarchy node (employee_work_logs) -> delete blocked', async () => {
  servicePORepository.findById = async () => FAKE_PO;
  servicePOHierarchyRepository.findByServicePO = async () => HIERARCHY_NODES;
  timesheetRepository.existsForServicePO = async () => false;
  // Simulates a row with hierarchy_node_id = 1 (Parent 1) matched via the
  // hierarchyNodeIds IN (...) branch of existsForServicePOOrHierarchy.
  employeeWorkLogRepository.existsForServicePOOrHierarchy = async (servicePOId, hierarchyNodeIds) => {
    return hierarchyNodeIds.includes(1);
  };
  servicePORepository.softDelete = async () => {
    throw new Error('softDelete must NOT be called when a work log exists');
  };

  await assert.rejects(
    () => servicePOService.delete(293, 1, 4),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );

  restore();
});

test('3. Work log exists on a Child hierarchy node (employee_work_logs) -> delete blocked', async () => {
  servicePORepository.findById = async () => FAKE_PO;
  servicePOHierarchyRepository.findByServicePO = async () => HIERARCHY_NODES;
  timesheetRepository.existsForServicePO = async () => false;
  // Simulates a row with hierarchy_node_id = 5 (Child 3, under Parent 2).
  employeeWorkLogRepository.existsForServicePOOrHierarchy = async (servicePOId, hierarchyNodeIds) => {
    return hierarchyNodeIds.includes(5);
  };
  servicePORepository.softDelete = async () => {
    throw new Error('softDelete must NOT be called when a work log exists');
  };

  await assert.rejects(
    () => servicePOService.delete(293, 1, 4),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );

  restore();
});

test('4. No work logs anywhere in the hierarchy -> delete succeeds', async () => {
  let softDeleteCalledWith = null;

  servicePORepository.findById = async () => FAKE_PO;
  servicePOHierarchyRepository.findByServicePO = async () => HIERARCHY_NODES;
  timesheetRepository.existsForServicePO = async () => false;
  employeeWorkLogRepository.existsForServicePOOrHierarchy = async () => false;
  servicePORepository.softDelete = async (id, userId, companyId) => {
    softDeleteCalledWith = { id, userId, companyId };
  };

  await servicePOService.delete(293, 1, 4);

  assert.deepEqual(softDeleteCalledWith, { id: 293, userId: 1, companyId: 4 });

  restore();
});

test('Service PO not found -> 404, never reaches the work-log check', async () => {
  let hierarchyLookupCalled = false;
  servicePORepository.findById = async () => null;
  servicePOHierarchyRepository.findByServicePO = async () => {
    hierarchyLookupCalled = true;
    return [];
  };

  await assert.rejects(
    () => servicePOService.delete(999, 1, 4),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  assert.equal(hierarchyLookupCalled, false);

  restore();
});
