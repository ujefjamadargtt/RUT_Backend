'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Op } = require('sequelize');
const { Company } = require('../src/models');
const { intersectCompanyIdsWithEntity, intersectIds } = require('../src/services/companyAccessControlService');

/**
 * Multi-Value Entity/BU Filtering foundation — the two shared narrowing
 * helpers every converted List/Master and Report endpoint uses:
 * intersectCompanyIdsWithEntity() (extended here to accept an array of
 * Entity ids, not just one) and the new intersectIds() (plain array
 * intersection for the businessUnitIds filter — no DB lookup needed since
 * the reach array IS already the BU id set). Both must narrow, never widen,
 * and an id outside the caller's reach must silently disappear rather than
 * error.
 */

const originalFindAll = Company.findAll;
function restore() {
  Company.findAll = originalFindAll;
}

test('intersectCompanyIdsWithEntity: absent/null entityId returns companyIds unchanged (regression baseline)', async () => {
  const companyIds = [1, 2, 3];
  const result = await intersectCompanyIdsWithEntity(companyIds, null);
  assert.deepEqual(result, companyIds);
});

test('intersectCompanyIdsWithEntity: a single entityId (legacy scalar) still narrows exactly as before', async () => {
  try {
    let capturedWhere;
    Company.findAll = async ({ where }) => {
      capturedWhere = where;
      return [{ id: 1 }, { id: 2 }];
    };
    const result = await intersectCompanyIdsWithEntity([1, 2, 3], 5);
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [5] });
    assert.deepEqual(result.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('intersectCompanyIdsWithEntity: an array of entityIds narrows to the union of Companies under any of them', async () => {
  try {
    Company.findAll = async () => [{ id: 2 }, { id: 3 }, { id: 99 }];
    const result = await intersectCompanyIdsWithEntity([1, 2, 3, 4], [5, 6]);
    // 99 isn't in the caller's own reach ([1,2,3,4]) — must be dropped, never added.
    assert.deepEqual(result.sort(), [2, 3]);
  } finally {
    restore();
  }
});

test('intersectCompanyIdsWithEntity: an empty entityIds array is treated as "no filter", same as absent', async () => {
  const companyIds = [1, 2, 3];
  const result = await intersectCompanyIdsWithEntity(companyIds, []);
  assert.deepEqual(result, companyIds);
});

test('intersectCompanyIdsWithEntity: an entityId(s) outside the caller\'s reach yields [], never an error', async () => {
  try {
    Company.findAll = async () => [{ id: 500 }, { id: 501 }]; // real Companies, but not in caller's own reach
    const result = await intersectCompanyIdsWithEntity([1, 2, 3], [77]);
    assert.deepEqual(result, []);
  } finally {
    restore();
  }
});

test('intersectIds: absent requestedIds returns reachIds unchanged (regression baseline)', () => {
  assert.deepEqual(intersectIds([1, 2, 3], undefined), [1, 2, 3]);
  assert.deepEqual(intersectIds([1, 2, 3], null), [1, 2, 3]);
});

test('intersectIds: an empty requestedIds array is "no filter", not "match nothing"', () => {
  assert.deepEqual(intersectIds([1, 2, 3], []), [1, 2, 3]);
});

test('intersectIds: a single valid id narrows to just that id', () => {
  assert.deepEqual(intersectIds([1, 2, 3], [2]), [2]);
});

test('intersectIds: multiple valid ids narrow to exactly that subset', () => {
  assert.deepEqual(intersectIds([1, 2, 3, 4], [2, 4]).sort(), [2, 4]);
});

test('intersectIds: a mix of authorized and unauthorized ids silently drops the unauthorized ones, never errors', () => {
  assert.deepEqual(intersectIds([1, 2, 3], [2, 999]), [2]);
});

test('intersectIds: every requested id unauthorized resolves to [], never an error', () => {
  assert.deepEqual(intersectIds([1, 2, 3], [888, 999]), []);
});
