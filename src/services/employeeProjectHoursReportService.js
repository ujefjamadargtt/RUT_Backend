'use strict';

const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const servicePOHierarchyDTO = require('../dtos/servicePOHierarchyDTO');
const employeeTimesheetService = require('./employeeTimesheetService');
const dateHelper = require('../helpers/dateHelper');
const logger = require('../utils/logger');

/**
 * Employee Project Hours Report — NEW report, separate from every other
 * Employee Timesheet/Report module. Shows the authenticated Employee how
 * many hours THEY have logged, grouped as:
 *   Project -> Service PO -> Parent -> Child
 * for a selected period (specific date | month | date range), optionally
 * narrowed to one mapped Service PO or Project.
 *
 * Reuses employeeTimesheetService.buildServicePOsForDate/groupHoursByServicePO
 * completely unchanged — those already build the exact Service PO -> Parent
 * -> Child hours tree this report needs (per-node hours are independent,
 * never double-counted; a Service PO's own `hours` is direct-to-PO plus
 * every node under it, via servicePOHierarchyDTO.sumHierarchyHours — see
 * that file's doc comments). This module only adds the Project grouping and
 * the flexible date/month/range period resolution on top; it does not read
 * or write `employee_work_logs`/`service_po_hierarchy` any differently than
 * the existing Daily/Monthly Summary views already do, and never touches
 * Work Log creation/update, hierarchy management, approval, or sync.
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

/**
 * Resolve the query's period filter into an inclusive [startDate, endDate]
 * range. Exactly one of {date} | {month & year} | {startDate & endDate}
 * must be given — mirroring employeeReportValidation.js's three existing
 * report endpoints (daily/monthly/range), none of which has a "no period
 * given" default; this report requires the period explicitly for the same
 * reason. The Joi schema (projectHoursReportQuerySchema) already enforces
 * "exactly one mode" before this ever runs — this is a defensive second
 * check, not the primary gate.
 *
 * @param {object} query - { date?, month?, year?, startDate?, endDate? }
 * @returns {{ startDate: string, endDate: string }}
 */
function resolvePeriod(query) {
  const { date, month, year, startDate, endDate } = query;
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
    const d = employeeTimesheetService.toDateString(date);
    return { startDate: d, endDate: d };
  }
  if (hasMonth) {
    return dateHelper.getMonthBounds(parseInt(month, 10), parseInt(year, 10));
  }
  return {
    startDate: employeeTimesheetService.toDateString(startDate),
    endDate: employeeTimesheetService.toDateString(endDate),
  };
}

/**
 * GET /api/v1/employee-reports/project-hours
 *
 * @param {number} employeeId - req.employeeId (authenticated user's own — never a request param)
 * @param {number} companyId
 * @param {object} query - { service_po_id?, project_id?, date?, month?, year?, startDate?, endDate? }
 * @returns {Promise<{ projects: object[], grand_total_hours: number }>}
 */
const getReport = async (employeeId, companyId, query) => {
  if (!employeeId) {
    throw forbiddenError('This report requires a linked Employee account.');
  }

  const { startDate, endDate } = resolvePeriod(query);

  // Only ever the caller's OWN mapped Service POs — never an arbitrary
  // company-wide list, and never narrowed further by Business Unit (matches
  // /employee-timesheets/daily's rule: the mapping alone decides visibility).
  // This is the sole access-control gate for this report.
  const mappings = await employeeServicePOMappingRepository.findAllByEmployeeWithProject(employeeId, 'active');
  let mappedPOs = mappings.map((m) => m.servicePO).filter(Boolean);

  if (query.service_po_id) {
    const servicePOId = parseInt(query.service_po_id, 10);
    const match = mappedPOs.find((po) => po.id === servicePOId);
    if (!match) {
      throw forbiddenError(`Service PO #${servicePOId} is not assigned to you.`);
    }
    mappedPOs = [match];
  } else if (query.project_id) {
    const projectId = parseInt(query.project_id, 10);
    const filtered = mappedPOs.filter((po) => po.project && po.project.id === projectId);
    if (filtered.length === 0) {
      throw forbiddenError(`Project #${projectId} has no Service PO assigned to you.`);
    }
    mappedPOs = filtered;
  }

  if (mappedPOs.length === 0) {
    return { projects: [], grand_total_hours: 0 };
  }

  // Two batched queries total, regardless of how many Service POs are in
  // scope — no per-node/per-PO query loop.
  const [hierarchyRows, hoursRows] = await Promise.all([
    servicePOHierarchyRepository.findByServicePOIds(mappedPOs.map((po) => po.id)),
    employeeWorkLogRepository.getHierarchyBreakdownForRange({ employeeId, startDate, endDate }),
  ]);

  const hierarchyRowsByPOId = new Map();
  for (const row of hierarchyRows) {
    const key = String(row.service_po_id);
    if (!hierarchyRowsByPOId.has(key)) hierarchyRowsByPOId.set(key, []);
    hierarchyRowsByPOId.get(key).push(row);
  }

  // hoursRows is already collapsed to one row per (service_po_id,
  // hierarchy_node_id) summed across the whole [startDate, endDate] span
  // (see getHierarchyBreakdownForRange's SQL GROUP BY) — safe to feed
  // straight into groupHoursByServicePO (which .set()s, not accumulates)
  // without employeeTimesheetService.collapseRowsAcrossDates first; that
  // helper is only needed when combining rows that were grouped per-date.
  const hoursByPOId = employeeTimesheetService.groupHoursByServicePO(hoursRows);

  // Builds, per Service PO: { service_po_id, service_po_name, hours (direct-only),
  // po_total_hrs (direct + every hierarchy node), children (Parent -> Child
  // tree, every mapped node present even at 0 hours) }.
  const built = employeeTimesheetService.buildServicePOsForDate(mappedPOs, hierarchyRowsByPOId, hoursByPOId);

  // Group by Project. A pre-existing Service PO with no project_id (created
  // before Project became mandatory) is bucketed under a synthetic
  // "Unassigned" group rather than silently dropped.
  const projectsByKey = new Map();
  for (let i = 0; i < mappedPOs.length; i++) {
    const po = mappedPOs[i];
    const builtPO = built[i];
    const projectId = po.project ? po.project.id : null;
    const projectName = po.project ? po.project.project_name : 'Unassigned';
    const key = String(projectId);

    if (!projectsByKey.has(key)) {
      projectsByKey.set(key, { project_id: projectId, project_name: projectName, service_pos: [], total_hours: 0 });
    }
    const bucket = projectsByKey.get(key);
    bucket.service_pos.push({
      service_po_id: builtPO.service_po_id,
      service_po_name: builtPO.service_po_name,
      hours: builtPO.po_total_hrs,
      children: builtPO.children,
    });
    bucket.total_hours = round2(bucket.total_hours + builtPO.po_total_hrs);
  }

  const projects = Array.from(projectsByKey.values());
  const grand_total_hours = round2(projects.reduce((sum, p) => sum + p.total_hours, 0));

  logger.info('Employee project hours report generated', {
    employeeId, companyId, startDate, endDate, projectCount: projects.length, servicePOCount: mappedPOs.length,
  });

  return { projects, grand_total_hours };
};

/**
 * GET /api/v1/employee-reports/project-hours/filter-tree
 *
 * The Service PO/Project filter's data source — the structural
 * Project -> Service PO -> Parent -> Child tree (no hours), scoped to only
 * the caller's own currently-mapped Service POs. Deliberately not the
 * hours-bearing tree getReport() builds: this is purely "what can I filter
 * by," reusing servicePOHierarchyDTO.toTree() (structure only) rather than
 * toHierarchyTreeWithHours() (which needs a period to compute hours for).
 *
 * @param {number} employeeId
 * @returns {Promise<object[]>}
 */
const getFilterTree = async (employeeId) => {
  if (!employeeId) {
    throw forbiddenError('This report requires a linked Employee account.');
  }

  const mappings = await employeeServicePOMappingRepository.findAllByEmployeeWithProject(employeeId, 'active');
  const mappedPOs = mappings.map((m) => m.servicePO).filter(Boolean);

  if (mappedPOs.length === 0) return [];

  const hierarchyRows = await servicePOHierarchyRepository.findByServicePOIds(mappedPOs.map((po) => po.id));
  const hierarchyRowsByPOId = new Map();
  for (const row of hierarchyRows) {
    const key = String(row.service_po_id);
    if (!hierarchyRowsByPOId.has(key)) hierarchyRowsByPOId.set(key, []);
    hierarchyRowsByPOId.get(key).push(row);
  }

  const projectsByKey = new Map();
  for (const po of mappedPOs) {
    const projectId = po.project ? po.project.id : null;
    const projectName = po.project ? po.project.project_name : 'Unassigned';
    const key = String(projectId);

    if (!projectsByKey.has(key)) {
      projectsByKey.set(key, { project_id: projectId, project_name: projectName, service_pos: [] });
    }
    projectsByKey.get(key).service_pos.push({
      service_po_id: po.id,
      service_po_name: po.service_po_name,
      children: servicePOHierarchyDTO.toTree(hierarchyRowsByPOId.get(String(po.id)) || []),
    });
  }

  return Array.from(projectsByKey.values());
};

module.exports = { getReport, getFilterTree };
