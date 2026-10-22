'use strict';

const moment = require('moment-timezone');
const repository = require('../repositories/auditLogReportRepository');
const deviceName = require('../utils/deviceName');
const { expandBusinessUnitIdsWithDescendants } = require('./companyAccessControlService');
const { parseIdList } = require('../utils/idListParser');
const { getPaginationMeta } = require('../utils/pagination');

/**
 * Audit Log — "who did what, when, as which role, from which BU, on which BU's data".
 *
 * Visibility (existing RBAC, no new permission):
 *  - Platform Admin: everything.
 *  - Admin / Entity Admin / BU Admin: rows on THEIR BUs' data (record BU) OR done by people who
 *    belong to their BUs (actor BU). Admin / Entity Admin also see their own actions.
 *  - Every other role: no access (403).
 */

const PLATFORM_ADMIN_RANK = 1;
const BU_SCOPED_MAX_RANK = 4;
const ADMIN_TIER_MAX_RANK = 3;
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 366;
const MAX_EXPORT_ROWS = 50000;

// audit_logs.entity_type is a table name; these are the labels a person recognises.
const ENTITY_LABELS = {
  employee_work_logs: 'Work Log',
  timesheets: 'Timesheet',
  timesheet_import_history: 'Monthly Sheet',
  service_pos: 'Service PO',
  service_po_hierarchy: 'Service PO Activity',
  employees: 'Employee',
  clients: 'Client',
  projects: 'Project',
  companies: 'Business Unit',
  entities: 'Entity',
  categories: 'Category',
  form_master: 'Form (Menu)',
  role_form_mapping: 'Role Form Mapping',
  roles: 'Role',
  resource_budget_master: 'Resource Budget',
  cost_budget_master: 'Cost Budget',
  system_settings: 'System Setting',
};

const ACTION_LABELS = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  RESUBMIT: 'Resubmitted',
  LOGIN: 'Logged in',
  LOGIN_FAILED: 'Failed login',
  ACCESS_DENIED: 'Access denied',
  IMPORT: 'Imported',
  RESYNC: 'Re-synced',
  REIMPORT: 'Re-imported',
};

// Never worth showing in a change summary.
const NOISE_KEYS = new Set(['updated_by', 'updated_at', 'created_by', 'created_at', 'password']);

function forbidden(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (month, year) => (month && year ? `${MONTH_SHORT[Number(month) - 1] || month} ${year}` : null);
const SHEET_SOURCE = { pms: 'Synced from work logs', excel: 'Excel import' };
const datePart = (value) => (value ? String(value).slice(0, 10) : null);
const joinParts = (parts) => parts.filter(Boolean).join(' · ');

const entityLabel = (type) => ENTITY_LABELS[type] || (type ? type.replace(/_/g, ' ') : '');
const actionLabel = (action) => ACTION_LABELS[action] || (action ? action.charAt(0) + action.slice(1).toLowerCase() : '');

const show = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** Field-by-field changes between the two snapshots (top-level keys only; arrays summarised). */
function diffValues(oldValues, newValues) {
  const before = oldValues && typeof oldValues === 'object' ? oldValues : {};
  const after = newValues && typeof newValues === 'object' ? newValues : {};
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOISE_KEYS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      const total = (rows) => (Array.isArray(rows) ? rows.reduce((sum, r) => sum + (Number(r && r.hours) || 0), 0) : 0);
      const count = (rows) => (Array.isArray(rows) ? rows.length : 0);
      changes.push({ field: key, from: `${count(a)} entries / ${total(a)}h`, to: `${count(b)} entries / ${total(b)}h` });
    } else {
      changes.push({ field: key, from: show(a), to: show(b) });
    }
  }
  return changes;
}

/** One readable sentence for the table's "What happened" column. */
function buildSummary(row, changes) {
  const what = `${entityLabel(row.entity_type)}${row.entity_label ? ` "${row.entity_label}"` : (row.entity_id ? ` #${row.entity_id}` : '')}`;
  switch (row.action) {
    case 'LOGIN': return `Signed in${row.new_values && row.new_values.new_device ? ' from a NEW device' : ''}`;
    case 'DELETE': {
      const o = row.old_values || {};
      if (row.entity_type === 'timesheet_import_history') {
        const detail = joinParts([monthYear(o.month, o.year), SHEET_SOURCE[o.source] || o.source, o.timesheet_rows != null ? `${o.timesheet_rows} rows` : null]);
        return `Deleted monthly sheet${o.file_name ? ` "${o.file_name}"` : (o.import_id ? ` #${o.import_id}` : '')}${detail ? ` — ${detail}` : ''}`;
      }
      if (row.entity_type === 'timesheets' && (o.employee_name || o.timesheet_date)) {
        const detail = joinParts([o.employee_name, o.service_po_name, datePart(o.timesheet_date), o.hours_logged != null ? `${o.hours_logged}h` : null]);
        return `Deleted timesheet${detail ? ` — ${detail}` : (row.entity_id ? ` #${row.entity_id}` : '')}`;
      }
      return `Deleted ${what}`;
    }
    case 'IMPORT':
    case 'RESYNC':
    case 'REIMPORT': {
      const n = row.new_values || {};
      const verb = { IMPORT: 'Imported', RESYNC: 'Re-synced', REIMPORT: 'Re-imported' }[row.action];
      if (n.month && n.year) {
        const detail = joinParts([
          monthYear(n.month, n.year), SHEET_SOURCE[n.source] || n.source, n.insertedRows != null ? `${n.insertedRows} rows` : null,
          n.replaced_rows != null ? `replaced ${n.replaced_rows} existing rows` : null, n.file_name,
        ]);
        return `${verb} monthly sheet — ${detail}`;
      }
      return `${verb} ${what}`;
    }
    case 'LOGIN_FAILED': {
      const v = row.new_values || {};
      return `${v.attempts || 3} failed login attempts in ${v.window_minutes || 15} minutes — ${v.reason || 'invalid credentials'}`;
    }
    case 'ACCESS_DENIED': {
      const v = row.new_values || {};
      return `Tried to open ${v.form_name ? `"${v.form_name}"` : (v.path || 'a page')} without access (${v.attempts || 2} attempts)`;
    }
    case 'CREATE': return `Created ${what}`;
    case 'APPROVE': return `Approved ${what}`;
    case 'REJECT': return `Rejected ${what}${row.new_values && row.new_values.remark ? ` — ${row.new_values.remark}` : ''}`;
    case 'RESUBMIT': return `Resubmitted ${what}`;
    default: {
      if (changes.length === 0) return `${actionLabel(row.action)} ${what}`;
      const shown = changes.slice(0, 3).map((c) => `${c.field}: ${c.from} → ${c.to}`).join('; ');
      return `Updated ${what} — ${shown}${changes.length > 3 ? ` (+${changes.length - 3} more)` : ''}`;
    }
  }
}

function toRecord(row, { includeValues = false } = {}) {
  const changes = diffValues(row.old_values, row.new_values);
  return {
    id: row.id,
    when: row.created_at,
    action: row.action,
    action_label: actionLabel(row.action),
    entity_type: row.entity_type,
    entity_type_label: entityLabel(row.entity_type),
    entity_id: row.entity_id,
    entity_name: row.entity_label || null,
    summary: buildSummary(row, changes),
    changes,
    actor_id: row.actor_id,
    actor_code: row.actor_code,
    actor_name: row.actor_name
      || (row.actor_id ? `Former user #${row.actor_id}` : (row.action === 'LOGIN_FAILED' ? `Unknown user${row.new_values && row.new_values.email ? ` (${row.new_values.email})` : ''}` : 'System')),
    actor_role: row.actor_role,
    actor_bu: row.actor_bu,
    actor_sub_bu: row.actor_sub_bu,
    record_bu_id: row.record_bu_id,
    record_bu: row.record_bu,
    record_sub_bu: row.record_sub_bu,
    device_id: row.device_id,
    device_name: row.device_name,
    // The login session this action belongs to, and that session's login IP + browser (kept on the
    // session, not on every audit row).
    session_id: row.session_id || null,
    login_ip: row.login_ip || null,
    login_browser: deviceName.fromUserAgent(row.login_user_agent),
    new_device: row.action === 'LOGIN' ? !!(row.new_values && row.new_values.new_device) : null,
    ...(includeValues ? { old_values: row.old_values, new_values: row.new_values } : {}),
  };
}

/** The hard visibility scope, or throws 403 for a role with no access to audit logs. */
async function resolveScope(authContext, companyIds) {
  const rank = authContext.hierarchyRank;
  if (rank === PLATFORM_ADMIN_RANK) return { kind: 'all' };
  if (rank == null || rank > BU_SCOPED_MAX_RANK) {
    throw forbidden('You do not have access to the audit log.');
  }
  const reachIds = await expandBusinessUnitIdsWithDescendants(companyIds || []);
  return {
    kind: 'reach',
    // [-1] keeps the SQL valid (and matching nothing) for a caller with no BU at all.
    reachIds: reachIds.length ? reachIds : [-1],
    selfId: authContext.employeeId ?? null,
    includeSelf: rank <= ADMIN_TIER_MAX_RANK,
  };
}

const parseStrList = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
  return list.length ? list : null;
};

function resolvePeriod(query) {
  const end = query.end_date || moment().format('YYYY-MM-DD');
  const start = query.start_date || moment(end).subtract(DEFAULT_RANGE_DAYS - 1, 'days').format('YYYY-MM-DD');
  if (start > end) throw badRequest('start_date must be on or before end_date.');
  if (moment(end).diff(moment(start), 'days') + 1 > MAX_RANGE_DAYS) {
    throw badRequest(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { start_date: start, end_date: end };
}

async function buildFilters(query, authContext, companyIds) {
  const scope = await resolveScope(authContext, companyIds);
  const period = resolvePeriod(query);
  const actorBuIds = parseIdList(query.actor_bu_ids);
  const recordBuIds = parseIdList(query.record_bu_ids);
  return {
    period,
    filters: {
      scope,
      startDate: period.start_date,
      endDate: period.end_date,
      actorIds: parseIdList(query.actor_ids),
      actorBuIds: actorBuIds,
      actorSubBuIds: parseIdList(query.actor_sub_bu_ids),
      recordBuIds: recordBuIds ? await expandBusinessUnitIdsWithDescendants(recordBuIds) : null,
      actions: parseStrList(query.actions),
      entityTypes: parseStrList(query.entity_types),
      roles: parseStrList(query.roles),
      search: query.search || null,
      deviceId: query.device_id || null,
      sessionId: query.session_id || null,
      newDeviceOnly: query.new_device_only === true || query.new_device_only === 'true',
    },
  };
}

async function getLogs(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const page = query.page || 1;
  const limit = query.limit || 50;
  const [rows, summary] = await Promise.all([
    repository.findRows(filters, { sort: query.sort || 'newest', limit, offset: (page - 1) * limit }),
    repository.getSummary(filters),
  ]);
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    period,
    summary: {
      total_events: summary.total_events,
      distinct_users: summary.distinct_users,
      creates: summary.creates,
      updates: summary.updates,
      deletes: summary.deletes,
      logins: summary.logins,
    },
    records: rows.map((row) => toRecord(row)),
    meta: getPaginationMeta(total, page, limit),
  };
}

/** Login sessions: who signed in, from which device / IP / browser, was the device new, and what the session did. */
async function getSessions(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const page = query.page || 1;
  const limit = query.limit || 50;
  const rows = await repository.findSessions(filters, { limit, offset: (page - 1) * limit });
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    period,
    records: rows.map((row) => ({
      session_id: row.session_id,
      login_at: row.login_at,
      actor_id: row.actor_id,
      actor_code: row.actor_code,
      actor_name: row.actor_name || (row.actor_id ? `Former user #${row.actor_id}` : 'Unknown'),
      actor_role: row.actor_role,
      actor_bu: row.actor_bu,
      actor_sub_bu: row.actor_sub_bu,
      device_id: row.device_id,
      device_name: row.device_name,
      login_ip: row.login_ip,
      login_browser: deviceName.fromUserAgent(row.login_user_agent),
      new_device: !!row.new_device,
      actions_count: row.actions_count || 0,
      last_activity: row.last_activity,
    })),
    meta: getPaginationMeta(total, page, limit),
  };
}

/** A person's devices: first/last seen, logins, last login IP, and how much each did in the period. */
async function getDevices(query, authContext, companyIds) {
  const scope = await resolveScope(authContext, companyIds);
  const period = resolvePeriod(query);
  const actorBuIds = parseIdList(query.actor_bu_ids);
  const page = query.page || 1;
  const limit = query.limit || 50;
  const rows = await repository.findDevices({
    scope,
    startDate: period.start_date,
    endDate: period.end_date,
    actorIds: parseIdList(query.actor_ids),
    actorBuIds: actorBuIds,
    actorSubBuIds: parseIdList(query.actor_sub_bu_ids),
    deviceId: query.device_id || null,
    search: query.search || null,
  }, { limit, offset: (page - 1) * limit });
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    period,
    records: rows.map((row) => ({
      actor_id: row.actor_id,
      actor_code: row.actor_code,
      actor_name: row.actor_name,
      actor_bu: row.actor_bu,
      actor_sub_bu: row.actor_sub_bu,
      device_id: row.device_id,
      device_name: row.device_name,
      browser: deviceName.fromUserAgent(row.user_agent),
      first_seen: row.first_seen_at,
      last_seen: row.last_seen_at,
      login_count: row.login_count,
      last_login_ip: row.last_ip,
      activity_count: row.activity_count || 0,
      sessions_count: row.sessions_count || 0,
      person_devices: row.person_devices,
    })),
    meta: getPaginationMeta(total, page, limit),
  };
}

async function getLog(id, authContext, companyIds) {
  const scope = await resolveScope(authContext, companyIds);
  const row = await repository.findById(id, scope);
  if (!row) {
    const err = new Error('Audit log entry not found.');
    err.statusCode = 404;
    throw err;
  }
  return toRecord(row, { includeValues: true });
}

async function getFilterOptions(authContext, companyIds) {
  const scope = await resolveScope(authContext, companyIds);
  const options = await repository.getFilterOptions(scope);
  return {
    actions: options.actions.map((value) => ({ value, label: actionLabel(value) })),
    entity_types: options.entityTypes.map((value) => ({ value, label: entityLabel(value) })),
    roles: options.roles.map((value) => ({ value, label: value })),
  };
}

const EXPORT_COLUMNS = [
  { key: 'when', label: 'When', width: 20 },
  { key: 'actor_name', label: 'User', width: 26 },
  { key: 'actor_code', label: 'Employee Code', width: 14 },
  { key: 'actor_role', label: 'Role', width: 18 },
  { key: 'actor_bu', label: 'User BU', width: 22 },
  { key: 'actor_sub_bu', label: 'User Sub-BU', width: 22 },
  { key: 'action_label', label: 'Action', width: 12 },
  { key: 'entity_type_label', label: 'On', width: 20 },
  { key: 'entity_name', label: 'Record', width: 30 },
  { key: 'record_bu', label: 'Record BU', width: 22 },
  { key: 'record_sub_bu', label: 'Record Sub-BU', width: 22 },
  { key: 'summary', label: 'What happened', width: 70 },
  { key: 'device_name', label: 'Device Name', width: 24 },
  { key: 'device_id', label: 'Device ID', width: 40 },
];

async function getExport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const summary = await repository.getSummary(filters);
  if (summary.total_events > MAX_EXPORT_ROWS) {
    throw badRequest(`This download would contain ${summary.total_events} rows (maximum ${MAX_EXPORT_ROWS}). Narrow the dates or filters.`);
  }
  const rows = await repository.findRows(filters, { sort: query.sort || 'newest' });
  return {
    period,
    sheets: [{
      name: 'Audit Log',
      columns: EXPORT_COLUMNS,
      rows: rows.map((row) => {
        const record = toRecord(row);
        return { ...record, when: moment(record.when).format('YYYY-MM-DD HH:mm:ss') };
      }),
    }],
  };
}

module.exports = {
  getLogs, getLog, getFilterOptions, getExport, getSessions, getDevices, resolveScope, resolvePeriod, diffValues, buildSummary, toRecord,
};
