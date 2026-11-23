'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Entity-wise "work-log description is mandatory" rule (entities.is_log_desc_mandatory).
 *
 * An employee is mapped to one or more Business Units, each of which belongs to an Entity. The rule is ON for
 * the employee when ANY of their active BUs' Entities has the flag on (all off -> off; all on -> on; mixed -> on).
 */

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * @param {number} employeeId
 * @returns {Promise<boolean>}
 */
const isLogDescriptionMandatory = async (employeeId) => {
  if (!employeeId) return false;
  const rows = await sequelize.query(
    `SELECT 1
       FROM employee_business_units ebu
       JOIN companies c ON c.id = ebu.business_unit_id
       JOIN entities e ON e.id = c.entity_id
      WHERE ebu.employee_id = :employeeId
        AND ebu.status = 'active'
        AND e.is_log_desc_mandatory = TRUE
        AND e.is_deleted = FALSE
      LIMIT 1`,
    { replacements: { employeeId }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
};

/**
 * A log line has a description when its own description is filled, or — for a time-based line — every one of its
 * time slots carries one.
 * @param {{ description?: string, segmentDescriptions?: string[] }} item
 */
const itemHasDescription = (item) => {
  if (hasText(item.description)) return true;
  const segments = item.segmentDescriptions || [];
  return segments.length > 0 && segments.every(hasText);
};

/**
 * Throws 400 when the rule is on for this employee and any given line has no description.
 * @param {number} employeeId
 * @param {Array<{ description?: string, segmentDescriptions?: string[], label?: string }>} items
 */
const assertDescriptionsProvided = async (employeeId, items) => {
  if (!items || items.length === 0) return;
  if (!(await isLogDescriptionMandatory(employeeId))) return;
  const missing = items.find((item) => !itemHasDescription(item));
  if (!missing) return;
  const err = new Error(
    `Description is mandatory for every log entry${missing.label ? ` (${missing.label})` : ''}.`
  );
  err.statusCode = 400;
  throw err;
};

module.exports = { isLogDescriptionMandatory, assertDescriptionsProvided };
