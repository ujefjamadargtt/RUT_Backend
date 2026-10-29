'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteEmptyListReplacements } = require('../src/utils/emptyListGuard');

test('empty array in IN (:ids) becomes IN (NULL) — matches nothing instead of a syntax error', () => {
  const { sql, emptyKeys } = rewriteEmptyListReplacements(
    'SELECT 1 FROM t WHERE a IN (:ids) AND b IN ( :other ) OR c = ANY(:ids)',
    { ids: [], other: [1, 2] }
  );
  assert.deepEqual(emptyKeys, ['ids']);
  assert.equal(sql, "SELECT 1 FROM t WHERE a IN (NULL) AND b IN ( :other ) OR c = ANY('{}')");
});

test('NOT IN (:ids) is left untouched (an empty set excludes nothing)', () => {
  const { sql } = rewriteEmptyListReplacements('SELECT 1 WHERE a NOT IN (:ids)', { ids: [] });
  assert.equal(sql, 'SELECT 1 WHERE a NOT IN (:ids)');
});

test('non-empty lists, scalars and positional replacements are not touched', () => {
  assert.equal(rewriteEmptyListReplacements('x IN (:ids)', { ids: [1] }).sql, 'x IN (:ids)');
  assert.equal(rewriteEmptyListReplacements('x IN (?)', [[]]).sql, 'x IN (?)');
  assert.deepEqual(rewriteEmptyListReplacements('x = :id', { id: 5 }).emptyKeys, []);
});
