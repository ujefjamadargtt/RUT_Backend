'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseIdList } = require('../src/utils/idListParser');

test('parseIdList: undefined/null/empty string all return undefined (no filter)', () => {
  assert.equal(parseIdList(undefined), undefined);
  assert.equal(parseIdList(null), undefined);
  assert.equal(parseIdList(''), undefined);
});

test('parseIdList: a single numeric string parses to a one-element array', () => {
  assert.deepEqual(parseIdList('175'), [175]);
});

test('parseIdList: a comma-separated string parses to an array, trimming whitespace', () => {
  assert.deepEqual(parseIdList('1, 4,  7'), [1, 4, 7]);
});

test('parseIdList: an actual array (repeated query keys) passes through parsed', () => {
  assert.deepEqual(parseIdList(['1', '4']), [1, 4]);
});

test('parseIdList: a bare number is accepted', () => {
  assert.deepEqual(parseIdList(5), [5]);
});

test('parseIdList: non-numeric entries are filtered out; an all-non-numeric input returns undefined', () => {
  assert.deepEqual(parseIdList('1,abc,3'), [1, 3]);
  assert.equal(parseIdList('abc,def'), undefined);
});
