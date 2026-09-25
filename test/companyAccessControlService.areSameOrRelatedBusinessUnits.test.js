'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Company } = require('../src/models');
const { areSameOrRelatedBusinessUnits } = require('../src/services/companyAccessControlService');

/**
 * BU Hierarchy / Sub-BU support — areSameOrRelatedBusinessUnits(): whether
 * two Business Unit ids are "the same tenant" for cross-reference purposes
 * (e.g. creating a Service PO/Project under Sub-BU "DAS" that references a
 * Client already owned by its Parent BU "DATA + AI"). Depth-1 only.
 */

const originalFindOne = Company.findOne;
function restore() {
  Company.findOne = originalFindOne;
}

test('the same id is always related (trivially true, no DB call)', async () => {
  assert.equal(await areSameOrRelatedBusinessUnits(5, 5), true);
});

test('either id being null/undefined is never related', async () => {
  assert.equal(await areSameOrRelatedBusinessUnits(null, 5), false);
  assert.equal(await areSameOrRelatedBusinessUnits(5, null), false);
  assert.equal(await areSameOrRelatedBusinessUnits(undefined, 5), false);
});

test('a Sub-BU (A) referencing a record owned by its own Parent BU (B) is related', async () => {
  try {
    Company.findOne = async ({ where }) => {
      if (where.id === 42) return { id: 42, parent_business_unit_id: 40 }; // A: Sub-BU "DAS", parent 40
      if (where.id === 40) return { id: 40, parent_business_unit_id: null }; // B: Parent BU "DATA + AI"
      return null;
    };
    assert.equal(await areSameOrRelatedBusinessUnits(42, 40), true);
  } finally {
    restore();
  }
});

test('a Parent BU (A) referencing a record owned by one of its own Sub-BUs (B) is related (mirror direction)', async () => {
  try {
    Company.findOne = async ({ where }) => {
      if (where.id === 40) return { id: 40, parent_business_unit_id: null };
      if (where.id === 42) return { id: 42, parent_business_unit_id: 40 };
      return null;
    };
    assert.equal(await areSameOrRelatedBusinessUnits(40, 42), true);
  } finally {
    restore();
  }
});

test('two unrelated top-level Parent BUs are not related', async () => {
  try {
    Company.findOne = async ({ where }) => ({ id: where.id, parent_business_unit_id: null });
    assert.equal(await areSameOrRelatedBusinessUnits(40, 50), false);
  } finally {
    restore();
  }
});

test('two Sub-BUs under DIFFERENT parents are not related (siblings-of-different-parents)', async () => {
  try {
    Company.findOne = async ({ where }) => {
      if (where.id === 42) return { id: 42, parent_business_unit_id: 40 };
      if (where.id === 52) return { id: 52, parent_business_unit_id: 50 };
      return null;
    };
    assert.equal(await areSameOrRelatedBusinessUnits(42, 52), false);
  } finally {
    restore();
  }
});

test('two Sub-BUs under the SAME parent (siblings) are not related to each other', async () => {
  try {
    Company.findOne = async ({ where }) => {
      if (where.id === 42) return { id: 42, parent_business_unit_id: 40 };
      if (where.id === 43) return { id: 43, parent_business_unit_id: 40 };
      return null;
    };
    assert.equal(await areSameOrRelatedBusinessUnits(42, 43), false);
  } finally {
    restore();
  }
});

test('a deleted/nonexistent Company id is never related', async () => {
  try {
    Company.findOne = async () => null;
    assert.equal(await areSameOrRelatedBusinessUnits(42, 999), false);
  } finally {
    restore();
  }
});
