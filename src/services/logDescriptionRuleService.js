'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Entity-wise "work-log description is mandatory" rule (entities.is_log_desc_mandatory).
 *
 * The rule is applied PER SERVICE PO: a Service PO belongs to a Business Unit (service_pos.company_id), which
 * belongs to an Entity (companies.entity_id). A log line needs a description only when ITS Service PO's Entity
 * has the flag on. An employee mapped across several Entities therefore gets mandatory descriptions on the POs
 * of the "on" Entities and optional descriptions on the POs of the "off" ones.
 */

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

const toIdList = (ids) => [...new Set((ids || []).map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0))];

/**
 * Of the given Service PO ids, the ones whose Entity has the rule on.
 * @param {Array<number|string>} servicePOIds
 * @returns {Promise<Set<number>>}
 */
const getMandatoryServicePOIds = async (servicePOIds) => {
  const ids = toIdList(servicePOIds);
  if (ids.length === 0) return new Set();
  const rows = await sequelize.query(
    `SELECT sp.id
       FROM service_pos sp
       JOIN companies c ON c.id = sp.company_id
       JOIN entities e ON e.id = c.entity_id
      WHERE sp.id IN (:ids)
        AND e.is_log_desc_mandatory = TRUE
        AND e.is_deleted = FALSE`,
    { replacements: { ids }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((row) => Number(row.id)));
};

/**
 * The employee's actively-mapped Service POs that require a description.
 * @param {number} employeeId
 * @returns {Promise<number[]>}
 */
const getMandatoryServicePOIdsForEmployee = async (employeeId) => {
  if (!employeeId) return [];
  const rows = await sequelize.query(
    `SELECT DISTINCT sp.id
       FROM employee_servicepo_mapping m
       JOIN service_pos sp ON sp.id = m.service_po_id
       JOIN companies c ON c.id = sp.company_id
       JOIN entities e ON e.id = c.entity_id
      WHERE m.employee_id = :employeeId
        AND m.status = 'active'
        AND e.is_log_desc_mandatory = TRUE
        AND e.is_deleted = FALSE
      ORDER BY sp.id`,
    { replacements: { employeeId }, type: QueryTypes.SELECT }
  );
  return rows.map((row) => Number(row.id));
};

/**
 * Response fields describing the rule for this employee:
 *  - is_log_desc_mandatory: true when at least one mapped Service PO requires a description
 *  - log_desc_mandatory_service_po_ids: exactly which Service POs require it
 * @param {number} employeeId
 */
const getLogDescRule = async (employeeId) => {
  const ids = await getMandatoryServicePOIdsForEmployee(employeeId);
  return { is_log_desc_mandatory: ids.length > 0, log_desc_mandatory_service_po_ids: ids };
};

/**
 * @param {number} employeeId
 * @returns {Promise<boolean>} true when ANY of the employee's mapped Service POs requires a description
 */
const isLogDescriptionMandatory = async (employeeId) => (await getMandatoryServicePOIdsForEmployee(employeeId)).length > 0;

/**
 * Adds `is_log_desc_mandatory` to every Service PO object of a daily/monthly `service_pos` array.
 * @param {Array<object>} servicePOs
 * @param {number[]} mandatoryIds
 */
const annotateServicePOs = (servicePOs, mandatoryIds) => {
  const set = new Set(mandatoryIds);
  return (servicePOs || []).map((po) => ({
    ...po,
    is_log_desc_mandatory: set.has(Number(po.service_po_id ?? po.id)),
  }));
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
 * Throws 400 when any given line is on a Service PO whose Entity has the rule on and has no description.
 * Lines on Service POs of Entities with the rule off are never checked.
 * @param {number} employeeId - kept for call-site compatibility / logging
 * @param {Array<{ servicePOId: number, description?: string, segmentDescriptions?: string[], label?: string }>} items
 */
// eslint-disable-next-line no-unused-vars
const assertDescriptionsProvided = async (employeeId, items) => {
  if (!items || items.length === 0) return;
  const mandatory = await getMandatoryServicePOIds(items.map((item) => item.servicePOId));
  if (mandatory.size === 0) return;
  const missing = items.find((item) => mandatory.has(Number(item.servicePOId)) && !itemHasDescription(item));
  if (!missing) return;
  const err = new Error(
    `Description is mandatory for every log entry${missing.label ? ` (${missing.label})` : ''}.`
  );
  err.statusCode = 400;
  throw err;
};

module.exports = {
  isLogDescriptionMandatory,
  getMandatoryServicePOIds,
  getMandatoryServicePOIdsForEmployee,
  getLogDescRule,
  annotateServicePOs,
  assertDescriptionsProvided,
};
