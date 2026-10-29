'use strict';

const logger = require('./logger');

/**
 * Sequelize renders a named replacement holding an EMPTY array as `()`, so
 * `col IN (:companyIds)` becomes `col IN ()` — a Postgres syntax error that
 * surfaced as a 500 ("syntax error at or near \")\"") for any actor whose
 * scope resolves to no Company/BU/Entity yet (e.g. a freshly created Admin
 * with nothing mapped). `= ANY(:ids)` breaks the same way (`ANY()`).
 *
 * An empty scope list must mean "matches nothing", never an error. This
 * wraps `sequelize.query` once so every raw-SQL call site is covered:
 *   - `IN (:name)`        -> `IN (NULL)`    (matches no row)
 *   - `= ANY(:name)`      -> `= ANY('{}')`  (matches no row, any element type)
 * `NOT IN (:name)` is left untouched on purpose: "not in an empty set" is TRUE
 * for every row, and there is no type-safe literal for it here.
 *
 * Anything still referencing an empty list after the rewrite (and so still
 * rendering `()`) is logged with the placeholder name and a SQL excerpt so
 * the failing endpoint is easy to spot.
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rewriteEmptyListReplacements(sql, replacements) {
  if (typeof sql !== 'string' || !replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
    return { sql, emptyKeys: [] };
  }
  const emptyKeys = Object.keys(replacements).filter((k) => Array.isArray(replacements[k]) && replacements[k].length === 0);
  let out = sql;
  for (const key of emptyKeys) {
    const name = escapeRegExp(key);
    out = out.replace(new RegExp(`(?<!NOT\\s)\\bIN\\s*\\(\\s*:${name}\\s*\\)`, 'gi'), 'IN (NULL)');
    out = out.replace(new RegExp(`\\bANY\\s*\\(\\s*:${name}\\s*\\)`, 'gi'), "ANY('{}')");
  }
  return { sql: out, emptyKeys };
}

function installEmptyListGuard(sequelize) {
  const originalQuery = sequelize.query.bind(sequelize);
  sequelize.query = function guardedQuery(sql, options) {
    const opts = options || (sql && typeof sql === 'object' ? sql : null);
    const text = typeof sql === 'string' ? sql : null;
    if (text && opts && opts.replacements) {
      const { sql: rewritten, emptyKeys } = rewriteEmptyListReplacements(text, opts.replacements);
      if (emptyKeys.length > 0) {
        const stillBroken = emptyKeys.filter((k) => new RegExp(`:${escapeRegExp(k)}\\b`).test(rewritten));
        if (stillBroken.length > 0) {
          logger.warn('Empty scope list used in a form the empty-list guard cannot rewrite (will render "()")', {
            placeholders: stillBroken,
            sql: rewritten.replace(/\s+/g, ' ').slice(0, 300),
          });
        }
        return originalQuery(rewritten, opts);
      }
    }
    return originalQuery(sql, options);
  };
  return sequelize;
}

module.exports = { installEmptyListGuard, rewriteEmptyListReplacements };
