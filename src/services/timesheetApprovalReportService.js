'use strict';

const { Employee, ServicePO, Project } = require('../models');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const dateHelper = require('../helpers/dateHelper');
const logger = require('../utils/logger');

/**
 * Timesheet Approval Status Report — NEW report, separate from
 * managerSelfServiceService.getApprovalSummary (which it deliberately does
 * not modify). Answers "how many hours, and what's their approval status"
 * together, with the full Project -> Service PO -> Parent -> Child
 * hierarchy as first-class report content (not a detail drawer).
 *
 * The approval UNIT stays exactly what it already is elsewhere in this app:
 * Employee + Date (daily) or Employee + Month + Year (monthly) — see
 * employeeWorkLogRepository.approveByEmployeeAndDates/AndMonths. Hierarchy
 * nodes shown here are informational only; this report has no approve
 * action of its own; it points at the existing
 * /my-team/timesheets/approve(-bulk) endpoints for that.
 *
 * Reads employee_work_logs (via a new, additive repository function,
 * findForApprovalSummaryByEmployees) and service_po_hierarchy (via the
 * existing, unmodified servicePOHierarchyRepository.findByServicePOIds) —
 * never writes to either. Never touches timesheets, Work Log creation/
 * update, hierarchy management, mapping, import, sync, or the existing
 * approval workflow.
 */

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Priority order for combining several rows'/nodes' statuses into one —
// "pending" wins over "approved" wins over "synced", i.e. the unit/node is
// only as settled as its least-settled underlying row. Uses exactly the
// three statuses the employee_work_logs.status column actually allows (see
// EmployeeWorkLog.js) — no new statuses invented.
const STATUS_PRIORITY = ['pending', 'approved', 'synced'];

function combineStatuses(statuses) {
  if (!statuses || statuses.length === 0) return null;
  const present = new Set(statuses);
  for (const s of STATUS_PRIORITY) {
    if (present.has(s)) return s;
  }
  return statuses[0];
}

/**
 * Resolve the query's period into an inclusive [startDate, endDate] range
 * plus the aggregation grain (logType). Exactly one of {date} |
 * {month & year} | {startDate & endDate} is required — same "no default,
 * period is explicit" convention as employeeReportValidation.js's existing
 * daily/monthly/range schemas and the Employee Project Hours report.
 *
 * For the plain range mode, `log_type` (daily|monthly, default daily)
 * decides whether the range is reported as one bucket per date (default)
 * or aggregated into Employee+Month+Year buckets spanning the range —
 * mirrors managerSelfServiceService.getApprovalSummary's own log_type flag.
 *
 * @param {object} query
 * @returns {{ startDate: string, endDate: string, logType: 'daily'|'monthly' }}
 */
function resolvePeriod(query) {
  const { date, month, year, startDate, endDate, log_type: logTypeParam } = query;
  const hasDate = !!date;
  const hasMonth = !!month && !!year;
  const hasRange = !!startDate && !!endDate;

  const modesGiven = [hasDate, hasMonth, hasRange].filter(Boolean).length;
  if (modesGiven === 0) {
    throw badRequestError('Provide one of: date, month & year, or startDate & endDate.');
  }
  if (modesGiven > 1) {
    throw badRequestError('Provide only one of: date, month & year, or startDate & endDate — not more than one.');
  }

  if (hasDate) {
    const d = dateHelper.formatDate(date);
    return { startDate: d, endDate: d, logType: 'daily' };
  }
  if (hasMonth) {
    const { startDate: s, endDate: e } = dateHelper.getMonthBounds(parseInt(month, 10), parseInt(year, 10));
    return { startDate: s, endDate: e, logType: 'monthly' };
  }
  return {
    startDate: dateHelper.formatDate(startDate),
    endDate: dateHelper.formatDate(endDate),
    logType: logTypeParam === 'monthly' ? 'monthly' : 'daily',
  };
}

/**
 * Employee scope — data-driven, not role-name-driven (same principle
 * assertOwnEmployee() already uses elsewhere): whoever is calling gets the
 * "Manager" view automatically if manager_employee_mappings actually maps
 * ANY employee to them, regardless of their role name. This is additive to,
 * never a replacement for, their own Employee record — a caller who is
 * BOTH an Employee and a (Primary/Secondary) Manager of someone else (e.g.
 * a Secondary Manager mapping layered on top of their own Employee record)
 * must still see their own timesheet, not just their managed team's. Any
 * employee_id requested outside this combined scope is rejected rather
 * than trusted — "Do NOT accept arbitrary employee_id from frontend unless
 * required by an existing authorized admin/manager report."
 *
 * @param {number} userId - req.userId (authenticated caller)
 * @param {number|null} ownEmployeeId - req.employeeId (may be null)
 * @param {number|undefined} requestedEmployeeId - query.employee_id, honored only within the caller's own scope
 * @param {number} companyId
 * @returns {Promise<number[]>} employee ids in scope
 */
async function resolveEmployeeScope(userId, ownEmployeeId, requestedEmployeeId, companyId) {
  const managedMappings = await managerEmployeeMappingRepository.findByManager(userId, companyId);
  const managedEmployeeIds = managedMappings.map((m) => m.employee_id);

  const scopeEmployeeIds = ownEmployeeId && !managedEmployeeIds.includes(ownEmployeeId)
    ? [...managedEmployeeIds, ownEmployeeId]
    : managedEmployeeIds;

  if (scopeEmployeeIds.length === 0) {
    throw forbiddenError('This report requires a linked Employee account.');
  }

  if (requestedEmployeeId) {
    if (!scopeEmployeeIds.includes(requestedEmployeeId)) {
      throw forbiddenError(`Employee #${requestedEmployeeId} is not mapped to you.`);
    }
    return [requestedEmployeeId];
  }

  // No employee_id given -> everyone in scope: own record plus, if the
  // caller is also a Manager, their whole mapped team.
  return scopeEmployeeIds;
}

/**
 * Group raw employee_work_logs rows into one bucket per (employee, period)
 * — the approval unit. logType='daily' buckets by exact work_date;
 * logType='monthly' buckets by (year, month), matching
 * managerSelfServiceService.getApprovalSummary's identical grouping.
 */
function groupRowsIntoBuckets(rows, logType) {
  const bucketsByKey = new Map();
  for (const row of rows) {
    const workDate = row.work_date;
    const periodKey = logType === 'monthly' ? workDate.slice(0, 7) : workDate;
    const key = `${row.employee_id}|${periodKey}`;

    if (!bucketsByKey.has(key)) {
      bucketsByKey.set(key, {
        employee_id: row.employee_id,
        period: logType === 'monthly'
          ? { month: parseInt(workDate.slice(5, 7), 10), year: parseInt(workDate.slice(0, 4), 10) }
          : { date: workDate },
        rows: [],
      });
    }
    bucketsByKey.get(key).rows.push(row);
  }
  return Array.from(bucketsByKey.values());
}

/**
 * Group one bucket's rows by (service_po_id, hierarchy_node_id — 'po' for
 * hours logged directly against the Service PO itself), summing hours and
 * collecting every row's status per node — the per-node status the
 * hierarchy tree needs, not just per-node hours.
 */
function groupBucketRowsByPOAndNode(rows) {
  const byPO = new Map();
  for (const row of rows) {
    const poId = String(row.service_po_id);
    const nodeKey = row.hierarchy_node_id ? String(row.hierarchy_node_id) : 'po';

    if (!byPO.has(poId)) byPO.set(poId, new Map());
    const nodeMap = byPO.get(poId);
    if (!nodeMap.has(nodeKey)) nodeMap.set(nodeKey, { hours: 0, statuses: [] });

    const entry = nodeMap.get(nodeKey);
    entry.hours += parseFloat(row.hours) || 0;
    entry.statuses.push(row.status);
  }
  return byPO;
}

/**
 * Build the Parent/Child hierarchy tree for ONE Service PO, with both
 * `hours` and `approval_status` per node — the status/hours-bearing analog
 * of servicePOHierarchyDTO.toHierarchyTreeWithHours (that helper only
 * carries hours, so it isn't reused here as-is; it's the same nesting logic
 * though). Every mapped node is always present, even with zero activity —
 * `approval_status` is null for a node nothing was logged against in this
 * bucket (there is no row to derive a status from), distinct from an actual
 * pending/approved/synced entry.
 *
 * @param {ServicePOHierarchy[]} hierarchyRows - every node under this Service PO
 * @param {Map<string, { hours: number, statuses: string[] }>} nodeDataByKey
 * @returns {object[]}
 */
function buildHierarchyTreeWithStatus(hierarchyRows, nodeDataByKey) {
  const nodeById = new Map();
  const parents = [];

  for (const row of hierarchyRows) {
    if (row.node_type !== 'PARENT') continue;
    const data = nodeDataByKey.get(String(row.id));
    const node = {
      hierarchy_id: row.id,
      name: row.node_name,
      type: row.node_type,
      hours: round2(data ? data.hours : 0),
      approval_status: data ? combineStatuses(data.statuses) : null,
      children: [],
    };
    nodeById.set(String(row.id), node);
    parents.push(node);
  }

  for (const row of hierarchyRows) {
    if (row.node_type !== 'CHILD') continue;
    const data = nodeDataByKey.get(String(row.id));
    const childNode = {
      hierarchy_id: row.id,
      name: row.node_name,
      type: row.node_type,
      hours: round2(data ? data.hours : 0),
      approval_status: data ? combineStatuses(data.statuses) : null,
    };
    const parentNode = nodeById.get(String(row.parent_hierarchy_id));
    if (parentNode) {
      parentNode.children.push(childNode);
    } else {
      // Shouldn't happen — FK-enforced — but defensive rather than dropping data.
      parents.push(childNode);
    }
  }

  return parents;
}

/**
 * GET /api/v1/employee-reports/timesheet-approval-status
 *
 * @param {number} userId - req.userId (authenticated caller — for the manager-scope check)
 * @param {number|null} ownEmployeeId - req.employeeId
 * @param {number} companyId
 * @param {object} query - { employee_id?, date?, month?, year?, startDate?, endDate?, log_type? }
 * @returns {Promise<{ data: object[] }>}
 */
const getReport = async (userId, ownEmployeeId, companyId, query) => {
  const { startDate, endDate, logType } = resolvePeriod(query);
  const requestedEmployeeId = query.employee_id ? parseInt(query.employee_id, 10) : undefined;

  const employeeIds = await resolveEmployeeScope(userId, ownEmployeeId, requestedEmployeeId, companyId);

  const rows = await employeeWorkLogRepository.findForApprovalSummaryByEmployees({
    employeeIds, companyId, startDate, endDate,
  });

  if (rows.length === 0) {
    return { data: [] };
  }

  // Batch-fetch everything the buckets need, ONCE, regardless of how many
  // buckets/employees/Service POs are involved — no N+1.
  const distinctEmployeeIds = [...new Set(rows.map((r) => r.employee_id))];
  const distinctPOIds = [...new Set(rows.map((r) => r.service_po_id))];

  const [employees, servicePOs, hierarchyRows] = await Promise.all([
    Employee.findAll({
      where: { id: distinctEmployeeIds },
      attributes: ['id', 'full_name', 'is_timesheet_approval_required'],
    }),
    ServicePO.findAll({
      where: { id: distinctPOIds },
      attributes: ['id', 'service_po_code', 'service_po_name', 'project_id'],
      include: [{ model: Project, as: 'project', attributes: ['id', 'project_code', 'project_name'], required: false }],
    }),
    servicePOHierarchyRepository.findByServicePOIds(distinctPOIds),
  ]);

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const servicePOById = new Map(servicePOs.map((po) => [po.id, po]));
  const hierarchyRowsByPOId = new Map();
  for (const row of hierarchyRows) {
    const key = String(row.service_po_id);
    if (!hierarchyRowsByPOId.has(key)) hierarchyRowsByPOId.set(key, []);
    hierarchyRowsByPOId.get(key).push(row);
  }

  const buckets = groupRowsIntoBuckets(rows, logType);

  const data = buckets.map((bucket) => {
    const employee = employeeById.get(bucket.employee_id);
    const totalHours = round2(bucket.rows.reduce((sum, r) => sum + (parseFloat(r.hours) || 0), 0));
    const bucketStatus = combineStatuses(bucket.rows.map((r) => r.status));

    const byPO = groupBucketRowsByPOAndNode(bucket.rows);
    const projectsByKey = new Map();

    for (const [poId, nodeMap] of byPO) {
      const po = servicePOById.get(parseInt(poId, 10));
      const poName = po ? po.service_po_name : `Service PO #${poId}`;
      const poDirectAndHierarchyStatuses = [];
      for (const { statuses } of nodeMap.values()) poDirectAndHierarchyStatuses.push(...statuses);

      const poTotalHours = round2(Array.from(nodeMap.values()).reduce((sum, n) => sum + n.hours, 0));

      const nodeDataByKey = new Map();
      for (const [nodeKey, data] of nodeMap) {
        if (nodeKey !== 'po') nodeDataByKey.set(nodeKey, data);
      }
      const children = buildHierarchyTreeWithStatus(hierarchyRowsByPOId.get(String(poId)) || [], nodeDataByKey);

      const servicePOEntry = {
        service_po_id: parseInt(poId, 10),
        service_po_name: poName,
        po_total_hours: poTotalHours,
        approval_status: combineStatuses(poDirectAndHierarchyStatuses),
        children,
      };

      const projectId = po && po.project ? po.project.id : null;
      const projectName = po && po.project ? po.project.project_name : 'Unassigned';
      const projectKey = String(projectId);
      if (!projectsByKey.has(projectKey)) {
        projectsByKey.set(projectKey, { project_id: projectId, project_name: projectName, service_pos: [] });
      }
      projectsByKey.get(projectKey).service_pos.push(servicePOEntry);
    }

    return {
      employee_id: bucket.employee_id,
      employee_name: employee ? employee.full_name : null,
      log_type: logType,
      ...bucket.period,
      total_hours: totalHours,
      approval_required: employee ? employee.is_timesheet_approval_required : null,
      approval_status: bucketStatus,
      projects: Array.from(projectsByKey.values()),
    };
  });

  data.sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || '')
    || (a.date || `${a.year}-${a.month}`).localeCompare(b.date || `${b.year}-${b.month}`));

  logger.info('Timesheet approval status report generated', {
    userId, companyId, startDate, endDate, logType, bucketCount: data.length, employeeCount: employeeIds.length,
  });

  return { data };
};

module.exports = {
  getReport,
  // Exported for reuse by workLogTimeReportService.js — same data-driven
  // Manager-team scoping (manager_employee_mappings), so the two reports
  // never diverge on "who can see whose work logs."
  resolveEmployeeScope,
};
