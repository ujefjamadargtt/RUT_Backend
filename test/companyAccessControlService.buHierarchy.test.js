'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Op } = require('sequelize');
const { Company } = require('../src/models');
const {
  expandBusinessUnitIdsWithDescendants,
  intersectIdsWithBuHierarchy,
} = require('../src/services/companyAccessControlService');

/**
 * BU Hierarchy / Sub-BU support — expandBusinessUnitIdsWithDescendants()
 * (the single chokepoint every hierarchy-aware BU filter funnels through,
 * via companyRepository.findChildIds()) and intersectIdsWithBuHierarchy()
 * (its hierarchy-aware drop-in for intersectIds(), used by every Reports/
 * List `businessUnitIds` filter). Depth-1 only — a Sub-BU never has
 * children of its own, matching the hierarchy's 2-level cap.
 */

const originalFindAll = Company.findAll;
function restore() {
  Company.findAll = originalFindAll;
}

test('expandBusinessUnitIdsWithDescendants: empty/absent ids returns as-is, no DB call', async () => {
  assert.deepEqual(await expandBusinessUnitIdsWithDescendants([]), []);
  assert.deepEqual(await expandBusinessUnitIdsWithDescendants(undefined), []);
  assert.deepEqual(await expandBusinessUnitIdsWithDescendants(null), []);
});

test('expandBusinessUnitIdsWithDescendants: a leaf id (no children) expands to itself unchanged', async () => {
  try {
    Company.findAll = async () => [];
    const result = await expandBusinessUnitIdsWithDescendants([5]);
    assert.deepEqual(result, [5]);
  } finally {
    restore();
  }
});

test('expandBusinessUnitIdsWithDescendants: a parent id expands to itself + its children (single indexed query)', async () => {
  try {
    let capturedWhere;
    Company.findAll = async ({ where }) => {
      capturedWhere = where;
      return [{ id: 2 }, { id: 3 }];
    };
    const result = await expandBusinessUnitIdsWithDescendants([1]);
    assert.deepEqual(capturedWhere.parent_business_unit_id, { [Op.in]: [1] });
    assert.deepEqual(result.sort(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('expandBusinessUnitIdsWithDescendants: mixed parent + leaf ids expand only the parent, never duplicate ids', async () => {
  try {
    Company.findAll = async () => [{ id: 2 }, { id: 3 }];
    const result = await expandBusinessUnitIdsWithDescendants([1, 9]);
    assert.deepEqual(result.sort(), [1, 2, 3, 9]);
  } finally {
    restore();
  }
});

test('intersectIdsWithBuHierarchy: absent/empty requestedIds returns reachIds unchanged (no filter)', async () => {
  assert.deepEqual(await intersectIdsWithBuHierarchy([1, 2, 3], undefined), [1, 2, 3]);
  assert.deepEqual(await intersectIdsWithBuHierarchy([1, 2, 3], []), [1, 2, 3]);
});

test('intersectIdsWithBuHierarchy: selecting a parent BU returns the parent + its reachable children', async () => {
  try {
    Company.findAll = async () => [{ id: 2 }, { id: 3 }, { id: 4 }];
    // Reach only includes 1,2,3 — child 4 is a real Sub-BU but outside this
    // caller's own reach (e.g. unmapped) and must stay excluded.
    const result = await intersectIdsWithBuHierarchy([1, 2, 3], [1]);
    assert.deepEqual(result.sort(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('intersectIdsWithBuHierarchy: selecting a leaf Sub-BU directly returns only that Sub-BU, not its siblings', async () => {
  try {
    Company.findAll = async () => []; // id 2 has no children of its own
    const result = await intersectIdsWithBuHierarchy([1, 2, 3, 4], [2]);
    assert.deepEqual(result, [2]);
  } finally {
    restore();
  }
});

test('intersectIdsWithBuHierarchy: multiple requested Sub-BUs narrow to exactly that subset', async () => {
  try {
    Company.findAll = async () => [];
    const result = await intersectIdsWithBuHierarchy([1, 2, 3, 4], [2, 3]);
    assert.deepEqual(result.sort(), [2, 3]);
  } finally {
    restore();
  }
});

test('intersectIdsWithBuHierarchy: a requested id outside reach is silently dropped, never an error', async () => {
  try {
    Company.findAll = async () => [];
    const result = await intersectIdsWithBuHierarchy([1, 2, 3], [999]);
    assert.deepEqual(result, []);
  } finally {
    restore();
  }
});
