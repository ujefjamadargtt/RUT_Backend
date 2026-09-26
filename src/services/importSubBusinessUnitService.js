'use strict';

const { Op } = require('sequelize');
const { Company } = require('../models');

/**
 * Shared "Sub BU" column handling for the Client / Project / Service PO /
 * Employee Excel imports (BU Hierarchy / Sub-BU support).
 *
 * Rule, identical for every import:
 * - The row's Business Unit HAS Sub-BUs -> the "Sub BU" column is MANDATORY
 *   and must name one of THAT Business Unit's own Sub-BUs (matched by name,
 *   case-insensitive, only among its children — so two Sub-BUs with the same
 *   name under different parents never collide).
 * - The row's Business Unit has NO Sub-BUs -> the column is optional and must
 *   be left blank (a value there is an error rather than silently ignored).
 *
 * Mirrors the manual create forms, which force a Sub-BU pick once the chosen
 * Business Unit has any, so an import can never create a record directly
 * under a Parent BU that the UI would not allow.
 */

// Header variants for the new column. Callers normalise headers to
// lower-case with collapsed spaces before looking them up.
const SUB_BU_HEADERS = [
  'sub bu',
  'sub bu name',
  'sub-bu',
  'sub-bu name',
  'sub business unit',
  'sub business unit name',
  'sub_bu',
  'sub_bu_name',
  'sub_business_unit',
  'sub_business_unit_name',
];

// Optional disambiguator for imports that resolve a Business Unit by NAME
// (Service PO "BU Name", Employee "Business Units") — Business Unit names are
// only unique per Entity, so the same name can exist under two Entities.
const ENTITY_HEADERS = ['entity', 'entity name', 'entity_name'];

function normaliseName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Load the Sub-BUs of the given Business Units in one query.
 *
 * @param {number[]} parentIds
 * @returns {Promise<Map<number, { id: number, company_name: string }[]>>} parent id -> its Sub-BUs
 */
async function loadSubBusinessUnits(parentIds) {
  const ids = [...new Set((parentIds || []).filter((id) => id != null))];
  const childrenByParent = new Map();
  if (ids.length === 0) return childrenByParent;

  const children = await Company.findAll({
    where: { parent_business_unit_id: { [Op.in]: ids }, is_deleted: false },
    attributes: ['id', 'company_name', 'parent_business_unit_id'],
    order: [['company_name', 'ASC'], ['id', 'ASC']],
    raw: true,
  });
  for (const child of children) {
    if (!childrenByParent.has(child.parent_business_unit_id)) childrenByParent.set(child.parent_business_unit_id, []);
    childrenByParent.get(child.parent_business_unit_id).push({ id: child.id, company_name: child.company_name });
  }
  return childrenByParent;
}

/**
 * Resolve ONE row's target Business Unit from its (already resolved) Business
 * Unit plus the raw "Sub BU" cell.
 *
 * @param {{ id: number, company_name: string }|null} businessUnit - the row's BU, or null for a BU-less row
 * @param {*} subBuRaw - the raw "Sub BU" cell value
 * @param {Map<number, { id: number, company_name: string }[]>} childrenByParent - from loadSubBusinessUnits()
 * @returns {{ companyId: number|null, error: string|null }} companyId = the Sub-BU when one applies, else the BU itself
 */
function resolveRowSubBusinessUnit(businessUnit, subBuRaw, childrenByParent) {
  const subBuName = String(subBuRaw == null ? '' : subBuRaw).trim();

  if (!businessUnit) {
    return subBuName
      ? { companyId: null, error: `Sub BU "${subBuName}" needs a Business Unit — select one first.` }
      : { companyId: null, error: null };
  }

  const children = childrenByParent.get(businessUnit.id) || [];
  if (children.length === 0) {
    return subBuName
      ? { companyId: null, error: `Business Unit "${businessUnit.company_name}" has no Sub-BUs — leave "Sub BU" blank.` }
      : { companyId: businessUnit.id, error: null };
  }

  const validNames = children.map((c) => c.company_name).join(', ');
  if (!subBuName) {
    return { companyId: null, error: `Business Unit "${businessUnit.company_name}" has Sub-BUs — "Sub BU" is required (one of: ${validNames}).` };
  }

  const matches = children.filter((c) => normaliseName(c.company_name) === normaliseName(subBuName));
  if (matches.length === 0) {
    return { companyId: null, error: `Sub BU "${subBuName}" not found under Business Unit "${businessUnit.company_name}" (valid: ${validNames}).` };
  }
  if (matches.length > 1) {
    return { companyId: null, error: `Sub BU "${subBuName}" matches more than one Sub-BU under "${businessUnit.company_name}" — rename one of them in Business Unit Master.` };
  }
  return { companyId: matches[0].id, error: null };
}

/**
 * Build the per-row "BU Name" lookup for a company-less actor (Admin /
 * Entity Admin): every Company they own, grouped by normalised name — BU
 * names are only unique per Entity, so a name keeps EVERY match — plus all of
 * those Companies' Sub-BUs.
 *
 * @param {number[]} ownedCompanyIds - resolveOwnedCompanyIds() result
 * @returns {Promise<{ companiesByName: Map<string, object[]>, childrenByParent: Map<number, object[]> }>}
 */
async function buildOwnedBusinessUnitLookup(ownedCompanyIds) {
  const { Entity } = require('../models');
  const owned = ownedCompanyIds && ownedCompanyIds.length
    ? await Company.findAll({
      where: { id: { [Op.in]: ownedCompanyIds }, is_deleted: false },
      attributes: ['id', 'company_name', 'entity_id'],
      include: [{ model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false }],
    })
    : [];
  const companiesByName = new Map();
  for (const c of owned) {
    const key = normaliseName(c.company_name);
    if (!companiesByName.has(key)) companiesByName.set(key, []);
    companiesByName.get(key).push({ id: c.id, company_name: c.company_name, entity_name: c.entity ? c.entity.entity_name : null });
  }
  const childrenByParent = await loadSubBusinessUnits(owned.map((c) => c.id));
  return { companiesByName, childrenByParent };
}

/**
 * Per-row "BU Name" lookup for ANY importing actor — the Business Units a
 * row of theirs may name:
 * - Company-less actor (Admin / Entity Admin): every Company they own.
 * - BU-scoped actor (BU Admin, PM, ...): every Business Unit they are
 *   actively mapped to (req.employeeBusinessUnits — not just the one active
 *   in the Global BU selector) plus those BUs' Sub-BUs, the same reach the
 *   manual create / BU-assignment screens give them.
 * Same-named Business Units (e.g. one per Entity) are all kept, so a row
 * must add "Entity Name" to pick one — see resolveOwnedBusinessUnitByName().
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ companiesByName: Map<string, object[]>, childrenByParent: Map<number, object[]> }>}
 */
async function buildActorBusinessUnitLookup(req) {
  if (req.companyId == null) {
    const { resolveOwnedCompanyIds } = require('./companyAccessControlService');
    return buildOwnedBusinessUnitLookup((await resolveOwnedCompanyIds(req.hierarchyRank, req.employeeId)) || []);
  }

  // BU-scoped actor: their active mappings (auth.js's req.employeeBusinessUnits
  // — the source of truth for which BUs they hold) plus those BUs' Sub-BUs.
  const { Entity } = require('../models');
  const mapped = (req.employeeBusinessUnits || []).map((bu) => ({
    id: bu.id,
    company_name: bu.company_name,
    entity_id: bu.entity_id != null ? bu.entity_id : null,
    entity_name: bu.entity ? bu.entity.entity_name : null,
  })).filter((bu) => bu.id != null && bu.company_name);

  // auth.js's Business Unit objects don't carry the Entity — reload the
  // mapped BUs (by id only, so this never widens the set) with their Entity.
  if (mapped.length) {
    const rows = await Company.findAll({
      where: { id: { [Op.in]: mapped.map((bu) => bu.id) }, is_deleted: false },
      attributes: ['id', 'company_name', 'entity_id'],
      include: [{ model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false }],
    });
    const byId = new Map(rows.filter((r) => r && r.id != null).map((r) => [r.id, r]));
    mapped.forEach((bu) => {
      const row = byId.get(bu.id);
      if (row && row.entity && !bu.entity_name) bu.entity_name = row.entity.entity_name;
    });
  }

  const childrenByParent = await loadSubBusinessUnits(mapped.map((bu) => bu.id));
  const entityNameById = new Map(mapped.map((bu) => [bu.id, bu.entity_name]));
  const all = [...mapped];
  const seen = new Set(mapped.map((bu) => bu.id));
  for (const [parentId, children] of childrenByParent) {
    for (const child of children) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        // A Sub-BU always shares its Parent's Entity.
        all.push({ id: child.id, company_name: child.company_name, entity_name: entityNameById.get(parentId) || null });
      }
    }
  }

  const companiesByName = new Map();
  for (const c of all) {
    const key = normaliseName(c.company_name);
    if (!companiesByName.has(key)) companiesByName.set(key, []);
    companiesByName.get(key).push({ id: c.id, company_name: c.company_name, entity_name: c.entity_name });
  }
  return { companiesByName, childrenByParent };
}

/**
 * A blank "BU Name" for a BU-scoped actor (BU Admin, PM, ...) may only fall
 * back to their Business Unit when they have exactly ONE mapping — with
 * several, the sheet must say which one; the Global BU selector is never
 * used as a silent default.
 *
 * @param {import('express').Request} req
 * @returns {string|null} the row error to report for a blank "BU Name", or null when blank is fine
 */
function blankBuNameError(req) {
  if (req.companyId == null) return null; // company-less actor: each import has its own blank rule
  const mapped = [...new Map((req.employeeBusinessUnits || []).filter((bu) => bu && bu.id != null).map((bu) => [bu.id, bu])).values()];
  if (mapped.length <= 1) return null;
  const names = mapped.map((bu) => bu.company_name).filter(Boolean).join(', ');
  return `BU Name is required — you are mapped to more than one Business Unit${names ? ` (${names})` : ''}.`;
}

/**
 * Resolve a row's "BU Name" (+ optional "Entity Name") to ONE of the
 * importing actor's own Business Units.
 *
 * @param {*} buNameRaw
 * @param {*} entityNameRaw
 * @param {Map<string, object[]>} companiesByName - from buildOwnedBusinessUnitLookup()
 * @returns {{ businessUnit: { id: number, company_name: string }|null, error: string|null }}
 */
function resolveOwnedBusinessUnitByName(buNameRaw, entityNameRaw, companiesByName) {
  const buName = String(buNameRaw == null ? '' : buNameRaw).trim();
  const entityName = String(entityNameRaw == null ? '' : entityNameRaw).trim();
  let matches = companiesByName.get(normaliseName(buName)) || [];
  if (entityName) matches = matches.filter((c) => normaliseName(c.entity_name) === normaliseName(entityName));
  if (matches.length === 0) {
    // Common sheet mistake: an Entity name typed into "BU Name" (and/or the
    // BU typed into "Entity Name") — say so instead of a bare "not found".
    const isEntityName = (name) => [...companiesByName.values()].flat()
      .some((c) => c.entity_name && normaliseName(c.entity_name) === normaliseName(name));
    const swapped = entityName
      && (companiesByName.get(normaliseName(entityName)) || []).some((c) => normaliseName(c.entity_name) === normaliseName(buName));
    let hint = '';
    if (swapped) {
      hint = ` "BU Name" and "Entity Name" look swapped — put "${entityName}" in BU Name and "${buName}" in Entity Name.`;
    } else if (isEntityName(buName)) {
      hint = ` "${buName}" is an Entity — put the Business Unit name in "BU Name" and "${buName}" in "Entity Name".`;
    }
    return { businessUnit: null, error: `BU "${buName}" not found${entityName ? ` under Entity "${entityName}"` : ''}.${hint}` };
  }
  if (matches.length > 1) {
    const entities = matches.map((c) => c.entity_name || 'no Entity').join(', ');
    return { businessUnit: null, error: `BU "${buName}" exists under more than one Entity (${entities}) — fill the "Entity Name" column to pick one.` };
  }
  return { businessUnit: matches[0], error: null };
}

/**
 * Split a comma-separated "Sub BU" cell (Employee import allows several).
 * @param {*} raw
 * @returns {string[]}
 */
function splitNames(raw) {
  return String(raw == null ? '' : raw).split(',').map((n) => n.trim()).filter(Boolean);
}

// "BU Name" column header variants (Client / Project / Service PO imports).
const BU_NAME_HEADERS = ['bu name', 'bu_name', 'business unit', 'business_unit', 'business unit name'];

module.exports = {
  SUB_BU_HEADERS,
  ENTITY_HEADERS,
  BU_NAME_HEADERS,
  normaliseName,
  loadSubBusinessUnits,
  resolveRowSubBusinessUnit,
  buildOwnedBusinessUnitLookup,
  buildActorBusinessUnitLookup,
  resolveOwnedBusinessUnitByName,
  blankBuNameError,
  splitNames,
};
