'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');
const { AiInsight, AiInsightJob } = require('../models');

/**
 * AiInsight Repository
 * Basic CRUD (create/findById/markAsRead/dismiss) uses the Sequelize ORM,
 * matching notificationRepository.js's convention. Role-filtered listing
 * needs a JSONB array-overlap check (audience_roles ?| roles) that the ORM
 * query builder can't express directly, so that one query is raw SQL —
 * same dual convention as the rest of this codebase (ORM for simple CRUD,
 * raw SQL for anything the ORM can't cleanly express).
 */

/**
 * @param {object} payload - Matches the AiInsight model fields
 * @returns {Promise<AiInsight>}
 */
async function create(payload) {
  return AiInsight.create(payload);
}

/**
 * @param {number} id
 * @param {number} companyId - scoped so one company can never fetch another's insight by ID
 * @returns {Promise<AiInsight|null>}
 */
async function findById(id, companyId) {
  return AiInsight.findOne({
    where: { id, company_id: companyId },
    include: [{ model: AiInsightJob, as: 'job', attributes: ['job_key', 'title', 'frequency'] }],
  });
}

function buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyId }, replacements) {
  const conditions = ['company_id = :companyId'];
  replacements.companyId = companyId;

  if (jobKey) {
    conditions.push('job_key = :jobKey');
    replacements.jobKey = jobKey;
  }
  if (severity) {
    conditions.push('severity = :severity');
    replacements.severity = severity;
  }
  if (typeof isRead === 'boolean') {
    conditions.push('is_read = :isRead');
    replacements.isRead = isRead;
  }
  if (!includeDismissed) {
    conditions.push('is_dismissed = false');
  }

  return conditions;
}

/**
 * Paginated list of all insights (no role filter) — used by admin/all-roles
 * views. Excludes dismissed insights unless includeDismissed is true.
 *
 * @param {object} filters - { jobKey, severity, isRead, includeDismissed, limit, offset }
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function findAll({ jobKey, severity, isRead, includeDismissed, limit, offset, companyId } = {}) {
  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyId }, replacements);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(
      `SELECT * FROM ai_insights ${whereClause} ORDER BY generated_at DESC LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total FROM ai_insights ${whereClause}`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Paginated list of insights whose audience_roles overlaps with any of the
 * given roles. Excludes dismissed insights unless includeDismissed is true.
 *
 * @param {string[]} roles - The logged-in user's role names
 * @param {object} filters - { jobKey, severity, isRead, includeDismissed, limit, offset }
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function findByRoles(roles, { jobKey, severity, isRead, includeDismissed, limit, offset, companyId } = {}) {
  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyId }, replacements);

  const roleParams = roles.map((_, i) => `:role${i}`).join(', ');
  roles.forEach((role, i) => {
    replacements[`role${i}`] = role;
  });
  conditions.push(`audience_roles ?| ARRAY[${roleParams}]::text[]`);

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(
      `SELECT * FROM ai_insights ${whereClause} ORDER BY generated_at DESC LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total FROM ai_insights ${whereClause}`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Mark a single insight as read.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<[number]>}
 */
async function markAsRead(id, companyId) {
  return AiInsight.update({ is_read: true }, { where: { id, company_id: companyId } });
}

/**
 * Dismiss a single insight.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<[number]>}
 */
async function dismiss(id, companyId) {
  return AiInsight.update({ is_dismissed: true }, { where: { id, company_id: companyId } });
}

module.exports = {
  create,
  findById,
  findAll,
  findByRoles,
  markAsRead,
  dismiss,
};
