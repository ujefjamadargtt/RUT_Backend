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
 * A TENANT-level monthly insight (scope_type 'tenant', company_id NULL) covers every Business Unit of one
 * Admin's tenant, so it is visible only to a caller whose reach covers ALL of that tenant's active Business
 * Units / Sub-BUs (the Admin) — never to a BU-scoped caller, nor to an Admin who narrowed the view to one BU.
 * `idsSql` is the SQL for the caller's company ids: ':companyIds' (raw query) or an inline integer list.
 */
function tenantVisibleSql(idsSql) {
  return `(ai.scope_type = 'tenant' AND ai.tenant_admin_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM companies tc
        JOIN entities te ON te.id = tc.entity_id AND te.is_deleted = false
       WHERE te.created_by = ai.tenant_admin_id AND tc.is_deleted = false AND tc.status = 'active'
         AND tc.id NOT IN (${idsSql})))`;
}

// ORM where-fragment for "this insight is inside the caller's reach" (a Company insight, or a visible tenant one).
function scopeWhere(companyIds) {
  const inlineIds = companyIds.map((id) => Number(id)).filter(Number.isInteger).join(', ') || 'NULL';
  return {
    [Op.or]: [
      { company_id: { [Op.in]: companyIds } },
      sequelize.literal(tenantVisibleSql(inlineIds).replace(/\bai\./g, '')),
    ],
  };
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
    where: { id, ...scopeWhere(companyIds) },
    include: [
      { model: AiInsightJob, as: 'job', attributes: ['job_key', 'title', 'frequency'] },
      { model: Company, as: 'company', attributes: ['id', 'company_name', 'parent_business_unit_id'] },
    ],
  });
}

function buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd, periodStart, periodEnd }, replacements) {
  const conditions = [`(ai.company_id IN (:companyIds) OR ${tenantVisibleSql(':companyIds')})`];
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
    conditions.push(`((ai.period_month IS NOT NULL AND ai.period_month >= :periodStart AND ai.period_month < :periodEnd)
      OR (ai.period_month IS NULL AND ai.generated_at >= :monthStart AND ai.generated_at < :monthEnd))`);
    replacements.monthStart = monthStart;
    replacements.monthEnd = monthEnd;
    replacements.periodStart = periodStart;
    replacements.periodEnd = periodEnd;
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
async function findAll({ jobKey, severity, isRead, includeDismissed, limit, offset, companyIds, monthStart, monthEnd, periodStart, periodEnd } = {}) {
  if (isEmptyScope(companyIds)) return { rows: [], count: 0 };

  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd, periodStart, periodEnd }, replacements);
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
async function findByRoles(roles, { jobKey, severity, isRead, includeDismissed, limit, offset, companyIds, monthStart, monthEnd, periodStart, periodEnd } = {}) {
  if (isEmptyScope(companyIds) || !Array.isArray(roles) || roles.length === 0) return { rows: [], count: 0 };

  const replacements = { limit, offset };
  const conditions = buildBaseConditions({ jobKey, severity, isRead, includeDismissed, companyIds, monthStart, monthEnd, periodStart, periodEnd }, replacements);

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
  return AiInsight.update({ is_read: true }, { where: { id, ...scopeWhere(companyIds) } });
}

/**
 * Dismiss a single insight.
 * @param {number} id
 * @param {number[]} companyIds
 * @returns {Promise<[number]>}
 */
async function dismiss(id, companyIds) {
  if (isEmptyScope(companyIds)) return [0];
  return AiInsight.update({ is_dismissed: true }, { where: { id, ...scopeWhere(companyIds) } });
}

/**
 * The monthly report of one scope + month + job, if it exists ('bu' by company_id, 'tenant' by tenant_admin_id).
 * @param {{ scopeType: 'bu'|'tenant', companyId?: number, tenantAdminId?: number, periodMonth: string, jobKey: string }} key
 * @returns {Promise<AiInsight|null>}
 */
async function findMonthly({ scopeType, companyId, tenantAdminId, periodMonth, jobKey }) {
  return AiInsight.findOne({
    where: {
      scope_type: scopeType,
      period_month: periodMonth,
      job_key: jobKey,
      ...(scopeType === 'bu' ? { company_id: companyId } : { tenant_admin_id: tenantAdminId }),
    },
  });
}

/**
 * Create the monthly report, or — when one already exists for the same scope + month + job — REPLACE its
 * content in place (never a second row). A changed report is shown as new again (unread, not dismissed).
 * @param {{ scopeType: 'bu'|'tenant', companyId?: number, tenantAdminId?: number, periodMonth: string, jobKey: string }} key
 * @param {object} payload - AiInsight fields (title, severity, summary, findings, actions, ...)
 * @returns {Promise<AiInsight>}
 */
async function upsertMonthly(key, payload) {
  const identity = {
    scope_type: key.scopeType,
    period_month: key.periodMonth,
    job_key: key.jobKey,
    company_id: key.scopeType === 'bu' ? key.companyId : null,
    tenant_admin_id: key.scopeType === 'tenant' ? key.tenantAdminId : null,
  };
  const existing = await findMonthly(key);
  if (existing) {
    await existing.update({ ...payload, is_read: false, is_dismissed: false });
    return existing;
  }
  return AiInsight.create({ ...payload, ...identity });
}

/**
 * (tenant, month) pairs, among the candidate months, that still have a tenant report that is not complete —
 * the scheduler keeps retrying those until every BU / Sub-BU is synced.
 * @param {string[]} periodMonths - 'YYYY-MM-01'
 * @returns {Promise<{ tenantAdminId: number, periodMonth: string }[]>}
 */
async function findOpenTenantPeriods(periodMonths) {
  if (!periodMonths.length) return [];
  const rows = await AiInsight.findAll({
    where: { scope_type: 'tenant', period_month: { [Op.in]: periodMonths }, report_state: { [Op.ne]: 'complete' } },
    attributes: ['tenant_admin_id', 'period_month'],
    group: ['tenant_admin_id', 'period_month'],
    raw: true,
  });
  return rows.map((r) => ({ tenantAdminId: r.tenant_admin_id, periodMonth: r.period_month }));
}

/**
 * The (tenant, month) pairs a job has already finished for good (every unit synced and processed) — see
 * ai_insight_period_state. The scheduler skips them without touching any data.
 * @param {string} jobKey
 * @param {string[]} periodMonths - 'YYYY-MM-01'
 * @returns {Promise<Set<string>>} keys 'tenantAdminId|YYYY-MM-01'
 */
async function findDonePeriods(jobKey, periodMonths) {
  if (!periodMonths.length) return new Set();
  const rows = await sequelize.query(
    `SELECT tenant_admin_id, TO_CHAR(period_month, 'YYYY-MM-DD') AS period_month
       FROM ai_insight_period_state WHERE job_key = :jobKey AND period_month IN (:periodMonths)`,
    { replacements: { jobKey, periodMonths }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => `${r.tenant_admin_id}|${r.period_month}`));
}

/**
 * Record that a job is finished for a tenant + month (idempotent).
 */
async function markPeriodDone(jobKey, tenantAdminId, periodMonth) {
  await sequelize.query(
    `INSERT INTO ai_insight_period_state (tenant_admin_id, period_month, job_key)
     VALUES (:tenantAdminId, :periodMonth, :jobKey)
     ON CONFLICT (job_key, period_month, tenant_admin_id) DO NOTHING`,
    { replacements: { tenantAdminId, periodMonth, jobKey } }
  );
}

module.exports = {
  create,
  findById,
  findAll,
  findByRoles,
  markAsRead,
  dismiss,
  findMonthly,
  upsertMonthly,
  findOpenTenantPeriods,
  findDonePeriods,
  markPeriodDone,
};
