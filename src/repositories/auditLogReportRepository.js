'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Audit Log screen — raw SQL over audit_logs, joined to WHO did it (employee, their role at that
 * time, the Business Unit / Sub-BU they belong to) and WHICH Business Unit the action belongs to.
 * Read-only.
 *
 * Business Unit is exposed as two INDEPENDENT dimensions, never merged:
 *   actor BU / Sub-BU  <- employee_business_units (where the person belongs)
 *   record BU          <- audit_logs.company_id (where the affected data belongs)
 * so "everything my BU's people did" and "everything done on my BU's data" are separate filters.
 */

// Employee -> the BUs / Sub-BUs they are ACTUALLY mapped to (active employee_business_units rows on
// live companies). Names come from the mapped rows themselves: a parent BU is listed only when it is
// itself mapped, never because one of its Sub-BUs is. A BU unmapped on the Role & BU Mapping screen
// (any employee_business_unit_role_exclusions row) is treated as unmapped, same as that screen. Reach ids (member_ids) stay separate: they are
// the visibility check, which rolls a Sub-BU mapping up to cover the parent.
const CTE_SQL = `
  WITH actor_bu AS (
    SELECT m.employee_id,
           ARRAY_AGG(DISTINCT c.id) AS member_ids,
           ARRAY_AGG(DISTINCT c.id) FILTER (WHERE c.parent_business_unit_id IS NULL) AS bu_ids,
           ARRAY_AGG(DISTINCT c.id) FILTER (WHERE c.parent_business_unit_id IS NOT NULL) AS sub_bu_ids,
           STRING_AGG(DISTINCT c.company_name, ', ') FILTER (WHERE c.parent_business_unit_id IS NULL) AS bu_names,
           STRING_AGG(DISTINCT c.company_name, ', ') FILTER (WHERE c.parent_business_unit_id IS NOT NULL) AS sub_bu_names
      FROM employee_business_units m
      JOIN companies c ON c.id = m.business_unit_id AND c.is_deleted = false
     WHERE m.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM employee_business_unit_role_exclusions x
          WHERE x.employee_id = m.employee_id AND x.business_unit_id = m.business_unit_id
       )
     GROUP BY m.employee_id
  )`;

const FROM_SQL = `
  FROM audit_logs a
  LEFT JOIN employees ae      ON ae.id = a.user_id
  LEFT JOIN actor_bu ab       ON ab.employee_id = a.user_id
  LEFT JOIN companies rc      ON rc.id = a.company_id
  LEFT JOIN companies rroot   ON rroot.id = COALESCE(rc.parent_business_unit_id, rc.id)
  LEFT JOIN service_pos l_sp  ON a.entity_type = 'service_pos' AND l_sp.id = a.entity_id
  LEFT JOIN clients l_cl      ON a.entity_type = 'clients' AND l_cl.id = a.entity_id
  LEFT JOIN projects l_pr     ON a.entity_type = 'projects' AND l_pr.id = a.entity_id
  LEFT JOIN companies l_co    ON a.entity_type = 'companies' AND l_co.id = a.entity_id
  LEFT JOIN employees l_em    ON a.entity_type = 'employees' AND l_em.id = a.entity_id
  LEFT JOIN employee_work_logs l_wl ON a.entity_type = 'employee_work_logs' AND l_wl.id = a.entity_id
  LEFT JOIN employees l_wle   ON l_wle.id = l_wl.employee_id
  LEFT JOIN service_pos l_wlp ON l_wlp.id = l_wl.service_po_id
  LEFT JOIN LATERAL (
    SELECT sess.ip_address, sess.user_agent
      FROM employee_login_sessions sess
     WHERE a.session_id IS NOT NULL AND sess.family_id = a.session_id
     ORDER BY sess.created_at ASC
     LIMIT 1
  ) ls ON true`;

// Not part of the audit screen: hours-logging activity (an Employee or Manager creating / editing /
// deleting / resubmitting work log entries) and reminders. Approving and rejecting hours still is.
const EXCLUDE_LOGGED_HOURS_SQL = "NOT (a.entity_type = 'employee_work_logs' AND a.action IN ('CREATE', 'UPDATE', 'DELETE', 'RESUBMIT')) AND COALESCE(a.action, '') NOT ILIKE '%REMIND%'";

// A readable name for the affected record: its own snapshot first (still true for a deleted row),
// then the live row, then "<type> #<id>".
const ENTITY_LABEL_SQL = `COALESCE(
  NULLIF(a.new_values->>'service_po_name', ''), NULLIF(a.old_values->>'service_po_name', ''),
  NULLIF(a.new_values->>'client_name', ''), NULLIF(a.old_values->>'client_name', ''),
  NULLIF(a.new_values->>'project_name', ''), NULLIF(a.old_values->>'project_name', ''),
  NULLIF(a.new_values->>'node_name', ''), NULLIF(a.old_values->>'node_name', ''),
  NULLIF(a.new_values->>'company_name', ''), NULLIF(a.old_values->>'company_name', ''),
  NULLIF(a.new_values->>'full_name', ''), NULLIF(a.old_values->>'full_name', ''),
  NULLIF(a.new_values->>'form_name', ''), NULLIF(a.old_values->>'form_name', ''),
  NULLIF(a.old_values->>'file_name', ''), NULLIF(a.new_values->>'file_name', ''),
  l_sp.service_po_name, l_cl.client_name, l_pr.project_name, l_co.company_name, l_em.full_name,
  CASE WHEN l_wl.id IS NOT NULL THEN l_wlp.service_po_name END)`;

const SORT_SQL = { newest: 'a.created_at DESC, a.id DESC', oldest: 'a.created_at ASC, a.id ASC' };

/**
 * @param {object} f
 * @param {{ kind: 'all' } | { kind: 'reach', reachIds: number[], selfId: number|null, includeSelf: boolean }} f.scope
 * @param {string} f.startDate
 * @param {string} f.endDate
 * @param {number[]|null} [f.actorIds]
 * @param {number[]|null} [f.actorBuIds]       - top-level BUs the actor is mapped to (no Sub-BU expansion)
 * @param {number[]|null} [f.actorSubBuIds]
 * @param {number[]|null} [f.recordBuIds]      - expanded to include Sub-BUs
 * @param {string[]|null} [f.actions]
 * @param {string[]|null} [f.entityTypes]
 * @param {string[]|null} [f.roles]
 * @param {string|null}   [f.search]
 * @param {string|null}   [f.deviceId]
 */
function buildWhere(f) {
  const replacements = { startDate: f.startDate, endDate: f.endDate };
  const conditions = ["a.created_at >= :startDate::date", "a.created_at < (:endDate::date + INTERVAL '1 day')", EXCLUDE_LOGGED_HOURS_SQL];

  // Visibility. A BU-scoped viewer sees what their BUs' PEOPLE did (wherever) and what was done on
  // their BUs' DATA (by anyone) — both directions of cross-BU work stay visible.
  if (f.scope.kind === 'reach') {
    replacements.reachIds = f.scope.reachIds;
    const parts = ['a.company_id IN (:reachIds)', 'ab.member_ids && ARRAY[:reachIds]::int[]'];
    if (f.scope.includeSelf && f.scope.selfId != null) {
      replacements.selfId = f.scope.selfId;
      parts.push('a.user_id = :selfId');
    }
    conditions.push(`(${parts.join(' OR ')})`);
  }

  const inList = (cond, key, values) => {
    if (values && values.length) { conditions.push(cond); replacements[key] = values; }
  };
  inList('a.user_id IN (:actorIds)', 'actorIds', f.actorIds);
  inList('ab.bu_ids && ARRAY[:actorBuIds]::int[]', 'actorBuIds', f.actorBuIds);
  inList('ab.sub_bu_ids && ARRAY[:actorSubBuIds]::int[]', 'actorSubBuIds', f.actorSubBuIds);
  inList('a.company_id IN (:recordBuIds)', 'recordBuIds', f.recordBuIds);
  inList('a.action IN (:actions)', 'actions', f.actions);
  inList('a.entity_type IN (:entityTypes)', 'entityTypes', f.entityTypes);
  inList('a.actor_role IN (:roles)', 'roles', f.roles);

  if (f.sessionId) {
    conditions.push('a.session_id = :sessionId');
    replacements.sessionId = f.sessionId;
  }
  if (f.newDeviceOnly) {
    conditions.push("a.action = 'LOGIN' AND a.new_values->>'new_device' = 'true'");
  }
  if (f.deviceId) {
    conditions.push('(a.device_id ILIKE :deviceId OR a.device_name ILIKE :deviceId)');
    replacements.deviceId = `%${f.deviceId}%`;
  }
  if (f.search) {
    conditions.push(`(ae.full_name ILIKE :search OR ae.employee_code ILIKE :search OR ${ENTITY_LABEL_SQL} ILIKE :search OR a.entity_type ILIKE :search)`);
    replacements.search = `%${f.search}%`;
  }

  return { whereSql: conditions.join(' AND '), replacements };
}

/** One page (or, with no limit, every row up to the caller's cap) of audit rows + total count. */
async function findRows(filters, { sort = 'newest', limit = null, offset = 0 } = {}) {
  const { whereSql, replacements } = buildWhere(filters);
  const paging = limit != null ? 'LIMIT :limit OFFSET :offset' : '';
  return sequelize.query(
    `${CTE_SQL}
     SELECT
       a.id,
       a.created_at,
       a.action,
       a.entity_type,
       a.entity_id,
       ${ENTITY_LABEL_SQL} AS entity_label,
       a.user_id AS actor_id,
       ae.employee_code AS actor_code,
       ae.full_name AS actor_name,
       a.actor_role,
       ab.bu_names AS actor_bu,
       ab.sub_bu_names AS actor_sub_bu,
       a.company_id AS record_bu_id,
       rroot.company_name AS record_bu,
       CASE WHEN rc.parent_business_unit_id IS NOT NULL THEN rc.company_name END AS record_sub_bu,
       a.device_id,
       a.device_name,
       a.session_id,
       ls.ip_address AS login_ip,
       ls.user_agent AS login_user_agent,
       a.old_values,
       a.new_values,
       COUNT(*) OVER() AS total_rows
     ${FROM_SQL}
     WHERE ${whereSql}
     ORDER BY ${SORT_SQL[sort] || SORT_SQL.newest}
     ${paging}`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

/** One row by id (same visibility rules), for the detail drawer. */
async function findById(id, scope) {
  const { whereSql, replacements } = buildWhere({
    scope, startDate: '1970-01-01', endDate: '2999-12-31',
  });
  const rows = await sequelize.query(
    `${CTE_SQL}
     SELECT
       a.id, a.created_at, a.action, a.entity_type, a.entity_id,
       ${ENTITY_LABEL_SQL} AS entity_label,
       a.user_id AS actor_id, ae.employee_code AS actor_code, ae.full_name AS actor_name, a.actor_role,
       ab.bu_names AS actor_bu, ab.sub_bu_names AS actor_sub_bu,
       a.company_id AS record_bu_id, rroot.company_name AS record_bu,
       CASE WHEN rc.parent_business_unit_id IS NOT NULL THEN rc.company_name END AS record_sub_bu,
       a.device_id, a.device_name, a.session_id, ls.ip_address AS login_ip, ls.user_agent AS login_user_agent, a.old_values, a.new_values
     ${FROM_SQL}
     WHERE ${whereSql} AND a.id = :id`,
    { replacements: { ...replacements, id }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

/** Summary cards for the whole filtered set: totals per action and per entity type, distinct actors. */
async function getSummary(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  const [totals] = await sequelize.query(
    `${CTE_SQL}
     SELECT
       COUNT(*)::int AS total_events,
       COUNT(DISTINCT a.user_id)::int AS distinct_users,
       COUNT(*) FILTER (WHERE a.action = 'CREATE')::int AS creates,
       COUNT(*) FILTER (WHERE a.action = 'UPDATE')::int AS updates,
       COUNT(*) FILTER (WHERE a.action = 'DELETE')::int AS deletes,
       COUNT(*) FILTER (WHERE a.action = 'LOGIN')::int AS logins
     ${FROM_SQL}
     WHERE ${whereSql}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return totals;
}

/** Distinct values that feed the filter dropdowns, inside the caller's visible scope. */
async function getFilterOptions(scope) {
  const { whereSql, replacements } = buildWhere({
    scope, startDate: '1970-01-01', endDate: '2999-12-31',
  });
  const [actions, entityTypes, roles] = await Promise.all([
    sequelize.query(`${CTE_SQL} SELECT DISTINCT a.action AS value ${FROM_SQL} WHERE ${whereSql} AND a.action IS NOT NULL ORDER BY 1`, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(`${CTE_SQL} SELECT DISTINCT a.entity_type AS value ${FROM_SQL} WHERE ${whereSql} AND a.entity_type IS NOT NULL ORDER BY 1`, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(`${CTE_SQL} SELECT DISTINCT a.actor_role AS value ${FROM_SQL} WHERE ${whereSql} AND a.actor_role IS NOT NULL ORDER BY 1`, { replacements, type: QueryTypes.SELECT }),
  ]);
  return {
    actions: actions.map((r) => r.value),
    entityTypes: entityTypes.map((r) => r.value),
    roles: roles.map((r) => r.value),
  };
}

/**
 * Login sessions — one row per sign-in (LOGIN audit row), with who, the device, the login IP + browser
 * (from the session), whether the device was new, and how much that session then did.
 */
async function findSessions(filters, { limit = null, offset = 0 } = {}) {
  const { whereSql, replacements } = buildWhere({ ...filters, actions: null });
  const paging = limit != null ? 'LIMIT :limit OFFSET :offset' : '';
  return sequelize.query(
    `${CTE_SQL}
     SELECT
       a.session_id,
       a.created_at AS login_at,
       a.user_id AS actor_id,
       ae.employee_code AS actor_code,
       ae.full_name AS actor_name,
       a.actor_role,
       ab.bu_names AS actor_bu,
       ab.sub_bu_names AS actor_sub_bu,
       a.device_id,
       a.device_name,
       ls.ip_address AS login_ip,
       ls.user_agent AS login_user_agent,
       (a.new_values->>'new_device') = 'true' AS new_device,
       act.actions_count,
       act.last_activity,
       COUNT(*) OVER() AS total_rows
     ${FROM_SQL}
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS actions_count, MAX(x.created_at) AS last_activity
         FROM audit_logs x
        WHERE x.session_id = a.session_id AND x.action <> 'LOGIN'
          AND NOT (x.entity_type = 'employee_work_logs' AND x.action IN ('CREATE', 'UPDATE', 'DELETE', 'RESUBMIT'))
          AND COALESCE(x.action, '') NOT ILIKE '%REMIND%'
     ) act ON true
     WHERE ${whereSql} AND a.action = 'LOGIN' AND a.session_id IS NOT NULL
     ORDER BY a.created_at DESC, a.id DESC
     ${paging}`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

/**
 * Devices — one row per (person, device) from user_devices, with how much that device did in the period.
 * A person is visible when they belong to the viewer's BUs (Platform Admin: everyone).
 */
async function findDevices(filters, { limit = null, offset = 0 } = {}) {
  const replacements = { startDate: filters.startDate, endDate: filters.endDate };
  const conditions = ['e.is_deleted = false'];
  if (filters.scope.kind === 'reach') {
    replacements.reachIds = filters.scope.reachIds;
    const parts = ['ab.member_ids && ARRAY[:reachIds]::int[]'];
    if (filters.scope.includeSelf && filters.scope.selfId != null) {
      replacements.selfId = filters.scope.selfId;
      parts.push('d.employee_id = :selfId');
    }
    conditions.push(`(${parts.join(' OR ')})`);
  }
  if (filters.actorIds && filters.actorIds.length) { conditions.push('d.employee_id IN (:actorIds)'); replacements.actorIds = filters.actorIds; }
  if (filters.actorBuIds && filters.actorBuIds.length) { conditions.push('ab.bu_ids && ARRAY[:actorBuIds]::int[]'); replacements.actorBuIds = filters.actorBuIds; }
  if (filters.actorSubBuIds && filters.actorSubBuIds.length) { conditions.push('ab.sub_bu_ids && ARRAY[:actorSubBuIds]::int[]'); replacements.actorSubBuIds = filters.actorSubBuIds; }
  if (filters.deviceId) { conditions.push('(d.device_id ILIKE :deviceId OR d.device_name ILIKE :deviceId)'); replacements.deviceId = `%${filters.deviceId}%`; }
  if (filters.search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR d.device_name ILIKE :search OR d.device_id ILIKE :search)');
    replacements.search = `%${filters.search}%`;
  }
  const paging = limit != null ? 'LIMIT :limit OFFSET :offset' : '';
  return sequelize.query(
    `${CTE_SQL}
     SELECT
       d.employee_id AS actor_id,
       e.employee_code AS actor_code,
       e.full_name AS actor_name,
       ab.bu_names AS actor_bu,
       ab.sub_bu_names AS actor_sub_bu,
       d.device_id,
       d.device_name,
       d.user_agent,
       d.first_seen_at,
       d.last_seen_at,
       d.login_count,
       d.last_ip,
       act.activity_count,
       act.sessions_count,
       (SELECT COUNT(*)::int FROM user_devices o WHERE o.employee_id = d.employee_id) AS person_devices,
       COUNT(*) OVER() AS total_rows
     FROM user_devices d
     JOIN employees e        ON e.id = d.employee_id
     LEFT JOIN actor_bu ab   ON ab.employee_id = d.employee_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS activity_count, COUNT(DISTINCT x.session_id)::int AS sessions_count
         FROM audit_logs x
        WHERE x.user_id = d.employee_id AND x.device_id = d.device_id
          AND x.created_at >= :startDate::date AND x.created_at < (:endDate::date + INTERVAL '1 day')
          AND NOT (x.entity_type = 'employee_work_logs' AND x.action IN ('CREATE', 'UPDATE', 'DELETE', 'RESUBMIT'))
          AND COALESCE(x.action, '') NOT ILIKE '%REMIND%'
     ) act ON true
     WHERE ${conditions.join(' AND ')}
     ORDER BY d.last_seen_at DESC, d.id DESC
     ${paging}`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

module.exports = { findRows, findById, getSummary, getFilterOptions, findSessions, findDevices, buildWhere };
