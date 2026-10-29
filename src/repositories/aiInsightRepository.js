'use strict';

const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { AiInsight, AiInsightJob, Company } = require('../models');

/**
 * AiInsight Repository
 * Basic CRUD (create/findById/markAsRead/dismiss) uses the Sequelize ORM,
 * matching notificationRepository.js's convention. Role-filtered listing
 * needs a JSONB array-overlap check (audience_roles ?| roles) that the ORM
 * query builder can't express directly, so that one query is raw SQL —
 * same dual convention as the rest of this codebase (ORM for simple CRUD,
 * raw SQL for anything the ORM can't cleanly express).
 *
 * Every read/write below is scoped by `companyIds` — the caller's already
 * authorized Business Unit / Sub-BU reach (req.companyIds, resolved by
 * resolveReportCompanyScope). An empty array means "reaches nothing" and
 * never touches the database; a row with company_id NULL is never matched.
 */

// A raw-SQL replacement turns an empty array into a literal `IN ()` (a
// Postgres syntax error), so every query short-circuits on an empty scope.
function isEmptyScope(companyIds) {
  return !Array.isArray(companyIds) || companyIds.length === 0;
}

/**
 * @param {object} payload - Matches the AiInsight model fields
 * @returns {Promise<AiInsight>}
 */
async function create(payload) {
  return AiInsight.create(payload);
}

/**
 * @param {number} id
 * @param {number[]} companyIds - scoped so a caller can never fetch an insight outside their own reach by ID
 * @returns {Promise<AiInsight|null>}
 */
async function findById(id, companyIds) {
  if (isEmptyScope(companyIds)) return null;
  return AiInsight.findOne({
    where: { id, company_id: { [Op.in]: companyIds } },
    include: [
      { model: AiInsightJob, as: 'job', attributes: ['job_key', 'title', 'frequency'] },
      { model: Company, as: 'company', attributes: ['id', 'company_name', 'parent_business_unit_id'] },
    ],
  });
}

function buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd }, replacements) {
  const conditions = ['ai.company_id IN (:companyIds)'];
  replacements.companyIds = companyIds;

  if (jobKey) {
    conditions.push('ai.job_key = :jobKey');
    replacements.jobKey = jobKey;
  }
  if (severity) {
    conditions.push('ai.severity = :severity');
    replacements.severity = severity;
  }
  if (typeof isRead === 'boolean') {
    conditions.push('ai.is_read = :isRead');
    replacements.isRead = isRead;
  }
  if (monthStart && monthEnd) {
    conditions.push('ai.generated_at >= :monthStart AND ai.generated_at < :monthEnd');
    replacements.monthStart = monthStart;
    replacements.monthEnd = monthEnd;
  }
  if (!includeDismissed) {
    conditions.push('ai.is_dismissed = false');
  }

  return conditions;
}

// An insight belongs to ONE Company: a Business Unit without Sub-BUs, or a
// Sub-BU. bu_name/sub_bu_name let the UI group a Sub-BU's insights under its
// Parent BU (sub_bu_name is NULL for a plain BU).
const LIST_SELECT = `SELECT ai.*,
       c.company_name AS company_name,
       c.parent_business_unit_id AS parent_business_unit_id,
       COALESCE(p.company_name, c.company_name) AS bu_name,
       CASE WHEN c.parent_business_unit_id IS NOT NULL THEN c.company_name END AS sub_bu_name
     FROM ai_insights ai
     LEFT JOIN companies c ON c.id = ai.company_id
     LEFT JOIN companies p ON p.id = c.parent_business_unit_id`;

async function runList(conditions, replacements) {
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(
      `${LIST_SELECT} ${whereClause} ORDER BY ai.generated_at DESC LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total FROM ai_insights ai ${whereClause}`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Paginated list of all insights (no role filter) — used by admin/all-roles
 * views. Excludes dismissed insights unless includeDismissed is true.
 *
 * @param {object} filters - { jobKey, severity, isRead, includeDismissed, limit, offset, companyIds }
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function findAll({ jobKey, severity, isRead, includeDismissed, limit, offset, companyIds, monthStart, monthEnd } = {}) {
  if (isEmptyScope(companyIds)) return { rows: [], count: 0 };

  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd }, replacements);
  return runList(conditions, replacements);
}

/**
 * Paginated list of insights whose audience_roles overlaps with any of the
 * given roles. Excludes dismissed insights unless includeDismissed is true.
 *
 * @param {string[]} roles - The logged-in user's role names
 * @param {object} filters - { jobKey, severity, isRead, includeDismissed, limit, offset, companyIds }
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function findByRoles(roles, { jobKey, severity, isRead, includeDismissed, limit, offset, companyIds, monthStart, monthEnd } = {}) {
  if (isEmptyScope(companyIds) || !Array.isArray(roles) || roles.length === 0) return { rows: [], count: 0 };

  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd }, replacements);

  const roleParams = roles.map((_, i) => `:role${i}`).join(', ');
  roles.forEach((role, i) => {
    replacements[`role${i}`] = role;
  });
  conditions.push(`ai.audience_roles ?| ARRAY[${roleParams}]::text[]`);

  return runList(conditions, replacements);
}

/**
 * Mark a single insight as read.
 * @param {number} id
 * @param {number[]} companyIds
 * @returns {Promise<[number]>}
 */
async function markAsRead(id, companyIds) {
  if (isEmptyScope(companyIds)) return [0];
  return AiInsight.update({ is_read: true }, { where: { id, company_id: { [Op.in]: companyIds } } });
}

/**
 * Dismiss a single insight.
 * @param {number} id
 * @param {number[]} companyIds
 * @returns {Promise<[number]>}
 */
async function dismiss(id, companyIds) {
  if (isEmptyScope(companyIds)) return [0];
  return AiInsight.update({ is_dismissed: true }, { where: { id, company_id: { [Op.in]: companyIds } } });
}

module.exports = {
  create,
  findById,
  findAll,
  findByRoles,
  markAsRead,
  dismiss,
};
