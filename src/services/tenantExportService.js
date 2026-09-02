'use strict';

const companyAccessControlService = require('./companyAccessControlService');
const { resolveEmployeeAccessWhere } = require('./employeeAccessControlService');
const tenantExportRepository = require('../repositories/tenantExportRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const dateHelper = require('../helpers/dateHelper');
const { formatTimeForDisplay } = require('../helpers/workLogTimeHelper');

/**
 * Tenant Data Export (Admin / Entity Admin only).
 *
 * "Tenant" = every Business Unit (Company) the caller owns —
 * companyAccessControlService.resolveOwnedCompanyIds(hierarchyRank,
 * employeeId), the SAME scope Client/Project/Service PO already use for a
 * company-less actor (an Admin can legitimately own more than one Entity;
 * this exports across all of them, not just one — see that function's own
 * doc comment). Never trusts a company_id/tenantId/buId from the caller;
 * everything here is resolved from the authenticated req.hierarchyRank /
 * req.employeeId set by requireEntityAdminOrAdmin + authenticate.
 *
 * The 5 sheets, and where each one's rows come from:
 *   1. All BUs              - tenantExportRepository.findBusinessUnits
 *   2. Service POs BU-wise  - tenantExportRepository.findServicePOs
 *   3. BU-wise Employees    - tenantExportRepository.findTenantEmployees +
 *                             findActiveBUMappings (one row per mapping;
 *                             an Employee with none still gets one row
 *                             with a blank BU)
 *   4. Employee Work Logs   - employeeWorkLogRepository.getWorkLogTimeReportRows
 *                             (the same query/include shape the existing
 *                             Work Log Time Report already uses — reused
 *                             directly here rather than re-built, deliberately
 *                             called WITHOUT workLogTimeReportService's own
 *                             Manager-team scoping, since a tenant export
 *                             needs every tenant Employee, not just the
 *                             caller's own team)
 *   5. Not Filled Timesheet - tenant Employees absent from sheet 4's
 *                             employee_id set for the period
 *
 * "Filled" definition (documented decision — no prior report in this
 * codebase defines this; see resolveFilledEmployeeIds() below for why):
 * an Employee counts as having filled the period if at least one
 * employee_work_logs row exists for them with work_date inside
 * [startDate, endDate], REGARDLESS of its status (pending/approved/
 * rejected/synced all count as "submitted something for that date") — the
 * same no-status-filter existence rule
 * employeeWorkLogRepository.findForApprovalSummaryByEmployees() already
 * uses to decide whether a day has any activity at all.
 */

const SHEET_NAMES = {
  BUS: 'All BUs',
  SERVICE_POS: 'Service POs BU Wise',
  EMPLOYEES: 'BU Wise Employees',
  WORK_LOGS: 'Employee Work Logs',
  NOT_FILLED: 'Employees Not Filled Timesheet',
};

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * DATEONLY columns (work_date, start_date, end_date) come back from
 * Sequelize as plain 'YYYY-MM-DD' strings, not Date instances — ExcelJS
 * only applies a cell's `numFmt` to an actual Date/number value, so a raw
 * string would render as unformatted text despite the numFmt set on these
 * columns below. Converting here (not in the exporter) keeps
 * toMultiSheetExcelBuffer() a generic, DB-agnostic sheet writer.
 * @param {string|null} dateStr
 * @returns {Date|null}
 */
function toExcelDate(dateStr) {
  return dateStr ? new Date(dateStr) : null;
}

/**
 * Resolve the entry type label the same way the rest of the codebase
 * infers it (no literal `entry_type` column exists anywhere — see
 * EmployeeWorkLog/EmployeeWorkLogTimeEntry): TIME_BASED when the work log
 * has any detailed time-entry children, else MONTHLY/HOURLY from its own
 * `log_type` ('monthly' vs 'daily').
 * @param {import('../models').EmployeeWorkLog} log
 * @returns {'TIME_BASED'|'MONTHLY'|'HOURLY'}
 */
function resolveEntryType(log) {
  if ((log.timeEntries || []).length > 0) return 'TIME_BASED';
  return log.log_type === 'monthly' ? 'MONTHLY' : 'HOURLY';
}

/**
 * Module = the tagged hierarchy node's own name, or its PARENT's name when
 * the tagged node is a CHILD (matches workLogTimeReportService.
 * resolveModuleName's existing convention for the same PO -> Parent ->
 * Child hierarchy). Task/Hierarchy = the CHILD-level name only, left blank
 * when the tag is a top-level PARENT node or absent entirely, so Module
 * and Task/Hierarchy never just duplicate each other.
 * @param {import('../models').ServicePOHierarchy|null} node
 */
function resolveModuleAndTask(node) {
  if (!node) return { module: null, task: null };
  if (node.node_type === 'CHILD') {
    return { module: node.parentNode ? node.parentNode.node_name : null, task: node.node_name };
  }
  return { module: node.node_name, task: null };
}

/**
 * One employee_work_logs row expands into one export row per detailed
 * time entry (TIME_BASED), or exactly one row otherwise (HOURLY/MONTHLY) —
 * never converted/collapsed, per the export's explicit requirement to
 * preserve the original entry type and its own start/end times.
 * @param {import('../models').EmployeeWorkLog} log
 * @param {Map<number, import('../models').Employee>} employeeById - for email, absent from getWorkLogTimeReportRows' own employee include
 */
function expandWorkLogRows(log, employeeById) {
  const entryType = resolveEntryType(log);
  const { module, task } = resolveModuleAndTask(log.hierarchyNode);
  const employee = employeeById.get(log.employee_id);

  const base = {
    employee_id: log.employee_id,
    employee_code: log.employee ? log.employee.employee_code : null,
    employee_name: log.employee ? log.employee.full_name : null,
    email: employee ? employee.email : null,
    date: toExcelDate(log.work_date),
    service_po: log.servicePO ? log.servicePO.service_po_name : null,
    project: log.servicePO && log.servicePO.project ? log.servicePO.project.project_name : null,
    module,
    task,
    entry_type: entryType,
    status: log.status,
  };

  if (entryType !== 'TIME_BASED') {
    return [{
      ...base,
      start_time: null,
      end_time: null,
      hours: parseFloat(log.hours) || 0,
      description: log.description,
    }];
  }

  return log.timeEntries.map((entry) => ({
    ...base,
    start_time: formatTimeForDisplay(entry.start_time),
    end_time: formatTimeForDisplay(entry.end_time),
    hours: parseFloat(entry.duration_hours) || 0,
    description: entry.description || log.description,
  }));
}

/**
 * Build all 5 sheets for one Admin/Entity Admin caller and one reporting
 * month.
 * @param {{ hierarchyRank: number, employeeId: number, userId: number, roleNames: string[] }} authContext
 * @param {{ month: number, year: number }} period
 * @returns {Promise<{ sheets: Array<{ name: string, columns: object[], rows: object[] }> }>}
 */
const buildExport = async ({ hierarchyRank, employeeId, userId, roleNames }, { month, year }) => {
  if (hierarchyRank !== 2 && hierarchyRank !== 3) {
    const err = new Error('Access denied. This export is restricted to Admin or Entity Admin.');
    err.statusCode = 403;
    throw err;
  }
  if (!month || !year) {
    throw badRequestError('month and year are required.');
  }

  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);

  const companyIds = await companyAccessControlService.resolveOwnedCompanyIds(hierarchyRank, employeeId);
  const accessWhere = await resolveEmployeeAccessWhere({
    userId, employeeId, companyId: null, hierarchyRank, roleNames: roleNames || [],
  });

  const [businessUnits, servicePOs, tenantEmployees] = await Promise.all([
    tenantExportRepository.findBusinessUnits(companyIds),
    tenantExportRepository.findServicePOs(companyIds),
    tenantExportRepository.findTenantEmployees(accessWhere),
  ]);

  const employeeIds = tenantEmployees.map((e) => e.id);
  const employeeById = new Map(tenantEmployees.map((e) => [e.id, e]));

  const [buMappings, workLogs] = await Promise.all([
    tenantExportRepository.findActiveBUMappings(employeeIds),
    employeeIds.length > 0
      ? employeeWorkLogRepository.getWorkLogTimeReportRows({ employeeIds, startDate, endDate })
      : [],
  ]);

  // ── Sheet 1 ──────────────────────────────────────────────────────────
  const buSheetRows = businessUnits.map((bu) => ({
    bu_id: bu.id,
    bu_name: bu.company_name,
    status: bu.status,
  }));

  // ── Sheet 2 ──────────────────────────────────────────────────────────
  const poSheetRows = servicePOs.map((po) => ({
    po_id: po.id,
    po_number: po.service_po_code,
    po_name: po.service_po_name,
    bu_id: po.company_id,
    bu_name: po.company ? po.company.company_name : null,
    client: po.client ? po.client.client_name : null,
    project: po.project ? po.project.project_name : null,
    po_value: po.po_value != null ? parseFloat(po.po_value) : null,
    start_date: toExcelDate(po.start_date),
    end_date: toExcelDate(po.end_date),
    status: po.status,
  }));

  // ── Sheet 3 ──────────────────────────────────────────────────────────
  const mappingsByEmployee = new Map();
  buMappings.forEach((m) => {
    const list = mappingsByEmployee.get(m.employee_id) || [];
    list.push(m.businessUnit);
    mappingsByEmployee.set(m.employee_id, list);
  });

  const employeeSheetRows = [];
  tenantEmployees.forEach((emp) => {
    const bus = mappingsByEmployee.get(emp.id) || [];
    if (bus.length === 0) {
      employeeSheetRows.push({
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.full_name,
        email: emp.email,
        bu_id: null,
        bu_name: null,
      });
      return;
    }
    bus.forEach((bu) => {
      employeeSheetRows.push({
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.full_name,
        email: emp.email,
        bu_id: bu ? bu.id : null,
        bu_name: bu ? bu.company_name : null,
      });
    });
  });

  // ── Sheet 4 ──────────────────────────────────────────────────────────
  const workLogSheetRows = workLogs.flatMap((log) => expandWorkLogRows(log, employeeById));

  // ── Sheet 5 (derived from sheet 4's own employee_id set — same query,
  // same period, no separate "filled" definition to drift out of sync) ──
  const filledEmployeeIds = new Set(workLogs.map((log) => log.employee_id));
  const notFilledSheetRows = tenantEmployees
    .filter((emp) => !filledEmployeeIds.has(emp.id))
    .map((emp) => {
      const bus = mappingsByEmployee.get(emp.id) || [];
      return {
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.full_name,
        email: emp.email,
        bu: bus.map((bu) => (bu ? bu.company_name : null)).filter(Boolean).join(', ') || null,
      };
    });

  return {
    sheets: [
      {
        name: SHEET_NAMES.BUS,
        columns: [
          { key: 'bu_id', label: 'BU ID', width: 10 },
          { key: 'bu_name', label: 'BU Name', width: 30 },
          { key: 'status', label: 'Status', width: 14 },
        ],
        rows: buSheetRows,
      },
      {
        name: SHEET_NAMES.SERVICE_POS,
        columns: [
          { key: 'po_id', label: 'PO ID', width: 10 },
          { key: 'po_number', label: 'PO Number', width: 18 },
          { key: 'po_name', label: 'PO Name', width: 26 },
          { key: 'bu_id', label: 'BU ID', width: 10 },
          { key: 'bu_name', label: 'BU Name', width: 24 },
          { key: 'client', label: 'Client', width: 24 },
          { key: 'project', label: 'Project', width: 24 },
          { key: 'po_value', label: 'PO Value', width: 16, numFmt: '#,##0.00' },
          { key: 'start_date', label: 'Start Date', width: 14, numFmt: 'yyyy-mm-dd' },
          { key: 'end_date', label: 'End Date', width: 14, numFmt: 'yyyy-mm-dd' },
          { key: 'status', label: 'Status', width: 14 },
        ],
        rows: poSheetRows,
      },
      {
        name: SHEET_NAMES.EMPLOYEES,
        columns: [
          { key: 'employee_id', label: 'Employee ID', width: 12 },
          { key: 'employee_code', label: 'Employee Code', width: 18 },
          { key: 'employee_name', label: 'Employee Name', width: 26 },
          { key: 'email', label: 'Email', width: 30 },
          { key: 'bu_id', label: 'BU ID', width: 10 },
          { key: 'bu_name', label: 'BU Name', width: 24 },
        ],
        rows: employeeSheetRows,
      },
      {
        name: SHEET_NAMES.WORK_LOGS,
        columns: [
          { key: 'employee_id', label: 'Employee ID', width: 12 },
          { key: 'employee_code', label: 'Employee Code', width: 18 },
          { key: 'employee_name', label: 'Employee Name', width: 26 },
          { key: 'email', label: 'Email', width: 30 },
          { key: 'date', label: 'Date', width: 14, numFmt: 'yyyy-mm-dd' },
          { key: 'service_po', label: 'Service PO', width: 24 },
          { key: 'project', label: 'Project', width: 24 },
          { key: 'module', label: 'Module', width: 20 },
          { key: 'task', label: 'Task / Hierarchy', width: 20 },
          { key: 'entry_type', label: 'Entry Type', width: 14 },
          { key: 'start_time', label: 'Start Time', width: 14 },
          { key: 'end_time', label: 'End Time', width: 14 },
          { key: 'hours', label: 'Hours', width: 10, numFmt: '0.00' },
          { key: 'description', label: 'Description', width: 34 },
          { key: 'status', label: 'Status', width: 14 },
        ],
        rows: workLogSheetRows,
      },
      {
        name: SHEET_NAMES.NOT_FILLED,
        columns: [
          { key: 'employee_id', label: 'Employee ID', width: 12 },
          { key: 'employee_code', label: 'Employee Code', width: 18 },
          { key: 'employee_name', label: 'Employee Name', width: 26 },
          { key: 'email', label: 'Email', width: 30 },
          { key: 'bu', label: 'BU', width: 30 },
        ],
        rows: notFilledSheetRows,
      },
    ],
  };
};

module.exports = { buildExport, SHEET_NAMES };
