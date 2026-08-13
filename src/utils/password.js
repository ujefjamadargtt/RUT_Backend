'use strict';

const crypto = require('crypto');

/**
 * Generate a random password satisfying the app's complexity policy
 * (upper+lower+digit+special, 16 chars) — used whenever a User account is
 * created without an explicit password (e.g. Employee creation, bulk
 * import). Returned to the caller exactly once; never persisted in
 * plaintext (the User model's beforeCreate hook hashes it).
 * @returns {string}
 */
function generateTemporaryPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(special)];
  const rest = Array.from({ length: 12 }, () => pick(all));

  return [...required, ...rest].sort(() => crypto.randomInt(3) - 1).join('');
}

module.exports = { generateTemporaryPassword };
