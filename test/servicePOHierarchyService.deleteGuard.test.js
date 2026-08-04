'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — servicePOHierarchyService.js holds a live reference to these
// SAME module-cached objects (it does `const x = require(...)` then calls
// `x.someFn(...)`, never destructures at import time), so mutating a
// property here is visible to the service's own calls. No mocking library
// needed, consistent with this repo's plain node:test setup.
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const servicePOHierarchyService = require('../src/services/servicePOHierarchyService');

const ORIGINAL = {
  findById: servicePOHierarchyRepository.findById,
  findChildren: servicePOHierarchyRepository.findChildren,
  deleteByIds: servicePOHierarchyRepository.deleteByIds,
  poFindById: servicePORepository.findById,
  existsForHierarchyNodes: employeeWorkLogRepository.existsForHierarchyNodes,
};

function restore() {
  servicePOHierarchyRepository.findById = ORIGINAL.findById;
  servicePOHierarchyRepository.findChildren = ORIGINAL.findChildren;
  servicePOHierarchyRepository.deleteByIds = ORIGINAL.deleteByIds;
  servicePORepository.findById = ORIGINAL.poFindById;
  employeeWorkLogRepository.existsForHierarchyNodes = ORIGINAL.existsForHierarchyNodes;
}

// ABC Service PO -> Parent 1 (id 1) -> Child 1 (id 2), Child 2 (id 3)
//                -> Parent 2 (id 4) -> Child 3 (id 5)
// matches the ticket's own hierarchy example.
const FAKE_PO = { id: 293, service_po_name: 'ABC Service PO' };
const NODES = {
  1: { id: 1, service_po_id: 293, node_type: 'PARENT', node_name: 'Parent 1' },
  2: { id: 2, service_po_id: 293, node_type: 'CHILD', node_name: 'Child 1', parent_hierarchy_id: 1 },
  3: { id: 3, service_po_id: 293, node_type: 'CHILD', node_name: 'Child 2', parent_hierarchy_id: 1 },
  4: { id: 4, service_po_id: 293, node_type: 'PARENT', node_name: 'Parent 2' },
  5: { id: 5, service_po_id: 293, node_type: 'CHILD', node_name: 'Child 3', parent_hierarchy_id: 4 },
};
const CHILDREN_OF = {
  1: [NODES[2], NODES[3]],
  4: [NODES[5]],
};

const EXPECTED_MESSAGE = 'This hierarchy node cannot be deleted because work log entries exist.';

function stubBase() {
  servicePORepository.findById = async () => FAKE_PO;
  servicePOHierarchyRepository.findChildren = async (parentId) => CHILDREN_OF[parentId] || [];
  servicePOHierarchyRepository.deleteByIds = async () => {
    throw new Error('deleteByIds should NOT be called when a work log exists');
  };
}

test('1. Deleting Child 1 (has work logs) is blocked — checks only that Child', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[2];
  // Only Child 1's own id (2) should be checked — no Parent/sibling ids.
  employeeWorkLogRepository.existsForHierarchyNodes = async (ids) => {
    assert.deepEqual(ids, [2]);
    return true;
  };

  await assert.rejects(
    () => servicePOHierarchyService.remove(2, 1, { companyId: 4, headers: {} }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );
  restore();
});

test('2. Deleting Parent 1 is blocked because Child 1 has work logs (Parent + all Children checked)', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[1];
  employeeWorkLogRepository.existsForHierarchyNodes = async (ids) => {
    assert.deepEqual(ids.sort(), [1, 2, 3]); // Parent 1 + Child 1 + Child 2
    return ids.includes(2); // Child 1 has the work log
  };

  await assert.rejects(
    () => servicePOHierarchyService.remove(1, 1, { companyId: 4, headers: {} }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );
  restore();
});

test('3. Deleting Parent 2 is blocked because Parent 2 ITSELF has work logs', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[4];
  employeeWorkLogRepository.existsForHierarchyNodes = async (ids) => {
    assert.deepEqual(ids.sort(), [4, 5]); // Parent 2 + Child 3
    return ids.includes(4); // Parent 2 itself has the work log
  };

  await assert.rejects(
    () => servicePOHierarchyService.remove(4, 1, { companyId: 4, headers: {} }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, EXPECTED_MESSAGE);
      return true;
    }
  );
  restore();
});

test('4. Deleting Child 3 (Parent with child work logs scenario, checked in isolation) is blocked', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[5];
  employeeWorkLogRepository.existsForHierarchyNodes = async (ids) => {
    assert.deepEqual(ids, [5]);
    return true;
  };

  await assert.rejects(() => servicePOHierarchyService.remove(5, 1, { companyId: 4, headers: {} }), { statusCode: 400 });
  restore();
});

test('5. No work logs anywhere -> deleting Parent 1 succeeds and removes it plus both Children', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[1];
  employeeWorkLogRepository.existsForHierarchyNodes = async () => false;

  let deletedIds = null;
  servicePOHierarchyRepository.deleteByIds = async (ids) => {
    deletedIds = ids;
  };

  await servicePOHierarchyService.remove(1, 1, { companyId: 4, headers: {} });

  assert.deepEqual(deletedIds.sort(), [1, 2, 3]);
  restore();
});

test('5b. No work logs -> deleting a Child in isolation succeeds', async () => {
  stubBase();
  servicePOHierarchyRepository.findById = async () => NODES[2];
  employeeWorkLogRepository.existsForHierarchyNodes = async (ids) => {
    assert.deepEqual(ids, [2]);
    return false;
  };

  let deletedIds = null;
  servicePOHierarchyRepository.deleteByIds = async (ids) => {
    deletedIds = ids;
  };

  await servicePOHierarchyService.remove(2, 1, { companyId: 4, headers: {} });

  assert.deepEqual(deletedIds, [2]);
  restore();
});
