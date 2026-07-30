'use strict';

const moment = require('moment');

/**
 * Generate a datestamp + random-suffix code.
 *
 * Format: PREFIX-YYYYMMDD-XXXX  (XXXX = 4 uppercase alphanumeric chars)
 *
 * @param {string} prefix - e.g. 'EMP', 'CLT', 'PO', 'SP'
 * @returns {string}
 */
function generateCode(prefix) {
  const datePart = moment().format('YYYYMMDD');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${datePart}-${suffix}`;
}

/**
 * Generate an employee code.
 * Format: EMP-YYYYMMDD-XXXX
 *
 * @returns {string}  e.g. "EMP-20240615-A3K9"
 */
function generateEmployeeCode() {
  return generateCode('EMP');
}

/**
 * Generate a client code.
 * Format: CLT-YYYYMMDD-XXXX
 *
 * @returns {string}  e.g. "CLT-20240615-B7M2"
 */
function generateClientCode() {
  return generateCode('CLT');
}

/**
 * Generate a Purchase Order code.
 * Format: PO-YYYYMMDD-XXXX
 *
 * @returns {string}  e.g. "PO-20240615-ZQ18"
 */
function generatePOCode() {
  return generateCode('PO');
}

/**
 * Generate a Sub-Project code.
 * Format: SP-YYYYMMDD-XXXX
 *
 * @returns {string}  e.g. "SP-20240615-T5NR"
 */
function generateSubProjectCode() {
  return generateCode('SP');
}

/**
 * Verify a code matches the expected format for a given prefix.
 *
 * @param {string} code
 * @param {string} prefix
 * @returns {boolean}
 */
function isValidCode(code, prefix) {
  if (!code || typeof code !== 'string') return false;
  const pattern = new RegExp(`^${prefix}-\\d{8}-[A-Z0-9]{4}$`);
  return pattern.test(code);
}

module.exports = {
  generateEmployeeCode,
  generateClientCode,
  generatePOCode,
  generateSubProjectCode,
  isValidCode,
};
