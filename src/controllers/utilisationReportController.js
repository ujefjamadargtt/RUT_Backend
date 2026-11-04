'use strict';

const service = require('../services/utilisationReportService');
const { sendPaginated, sendError } = require('../utils/response');
const { toMultiSheetExcelBuffer } = require('../utils/reportExporter');
const logger = require('../utils/logger');

const PCT_FMT = '0.00"%"';
const HRS_FMT = '#,##0.00';

const BU_COLUMNS = [
  { key: 'buName', label: 'BU Name', width: 30 },
  { key: 'subBuName', label: 'Sub BU Name', width: 30 },
  { key: 'totalEmployees', label: 'Total Employees', width: 16 },
  { key: 'expectedHours', label: 'Expected Hrs', width: 16, numFmt: HRS_FMT },
  { key: 'billableHours', label: 'Billable Hrs', width: 16, numFmt: HRS_FMT },
  { key: 'nonBillableHours', label: 'Non-Billable Hrs', width: 18, numFmt: HRS_FMT },
  { key: 'customerNonBillableHours', label: 'Customer Non-Billable Hrs', width: 26, numFmt: HRS_FMT },
  { key: 'totalLoggedHours', label: 'Total Logged Hrs', width: 18, numFmt: HRS_FMT },
  { key: 'utilizationPercentage', label: 'Utilisation %', width: 14, numFmt: PCT_FMT },
  { key: 'notLoggedHours', label: 'Not Logged Hrs', width: 16, numFmt: HRS_FMT },
  { key: 'originalBillableHours', label: 'Original Billable Hrs', width: 20, numFmt: HRS_FMT },
  { key: 'originalNonBillableHours', label: 'Original Non-Billable Hrs', width: 24, numFmt: HRS_FMT },
  { key: 'originalCustomerNonBillableHours', label: 'Original Customer Non-Billable Hrs', width: 32, numFmt: HRS_FMT },
  { key: 'originalTotalLoggedHours', label: 'Original Total Logged Hrs', width: 24, numFmt: HRS_FMT },
  { key: 'originalUtilizationPercentage', label: 'Original Utilisation %', width: 20, numFmt: PCT_FMT },
];

// Employee Code is not its own column: it sits under the name in the (merged) Employee Name cell,
// like the table in the UI.
// Hours basis switch (?hoursSource): the API already puts the SELECTED basis in the normal fields (Original for
// 'O', Adjusted otherwise), so the export carries only that one set of columns — never the other basis next to it.
// The separate "Original ..." columns would only repeat the figures (for 'O') or add the basis that was not chosen.
const NOT_BASIS_DEPENDENT = new Set(['buName', 'subBuName', 'totalEmployees', 'expectedHours']);
const buColumnsFor = (query) => {
  const basis = query.hoursSource === 'O' ? 'Original' : 'Adjusted';
  return BU_COLUMNS
    .filter((c) => !c.key.startsWith('original'))
    .map((c) => (NOT_BASIS_DEPENDENT.has(c.key) ? c : { ...c, label: `${c.label} (${basis})` }));
};

// Employee x Project export: ONE hours column and ONE utilisation % column, for the basis chosen with
// ?hoursSource (Original for 'O', Adjusted / after-sync otherwise) — never both side by side.
const EMP_PROJECT_COLUMNS_ADJUSTED = [
  { key: 'employeeName', label: 'Employee Name', width: 28 },
  { key: 'projectName', label: 'Project Name', width: 32 },
  { key: 'clientName', label: 'Client', width: 24 },
  { key: 'adjustedHours', label: 'Adjusted Hrs (After Sync)', width: 24, numFmt: HRS_FMT },
  { key: 'totalUtilizationPercentage', label: 'Total Util % (After Sync)', width: 24, numFmt: PCT_FMT },
];
const EMP_PROJECT_COLUMNS_ORIGINAL = [
  { key: 'employeeName', label: 'Employee Name', width: 28 },
  { key: 'projectName', label: 'Project Name', width: 32 },
  { key: 'clientName', label: 'Client', width: 24 },
  { key: 'loggedHours', label: 'Logged Hrs (Original)', width: 22, numFmt: HRS_FMT },
  { key: 'originalUtilizationPercentage', label: 'Util % (Original)', width: 18, numFmt: PCT_FMT },
];
const empProjectColumnsFor = (query) => (
  query.hoursSource === 'O' ? EMP_PROJECT_COLUMNS_ORIGINAL : EMP_PROJECT_COLUMNS_ADJUSTED
);
const empProjectMergeGroupsFor = (query) => ({
  by: 'employeeId',
  columns: ['employeeName', query.hoursSource === 'O' ? 'originalUtilizationPercentage' : 'totalUtilizationPercentage'],
  nameCell: { name: 'employeeName', nameKey: 'employeeName', codeKey: 'employeeCode' },
});

const periodSuffix = (period) => (
  [period.startDate, period.endDate].filter(Boolean).join('_to_')
);

/**
 * Puts every row of the same `key` next to each other, keeping the order in which each key first
 * appears (and the order of rows within it). A sort on e.g. Logged Hrs can interleave one
 * employee's rows with another's, which would otherwise leave nothing consecutive to merge.
 */
const groupConsecutive = (rows, key) => {
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r[key])) groups.set(r[key], []);
    groups.get(r[key]).push(r);
  });
  return [...groups.values()].flat();
};

/**
 * Shared handler: format=json (default) -> one page; format=excel -> every
 * row matching the same filters (page/limit ignored), with a Total row.
 */
// Hierarchy layout (?groupBy=hierarchy): a BU row, then its Sub-BU rows right below it (BU name left
// blank, Sub BU Name filled, "(BU level)" for the BU's own employees/hours). Rows without `subBus`
// (the flat layouts) pass through untouched.
const flattenSubBus = (rows) => rows.flatMap((row) => {
  const { subBus, ...bu } = row;
  const children = (subBus || []).map((c) => ({
    ...c,
    buName: '',
    subBuName: c.isDirect ? '(BU level)' : c.subBuName,
  }));
  return [bu, ...children];
});

const handle = ({ label, fn, message, columns, sheetName, filePrefix, totalRow, mergeGroups, groupRowsBy, flatten }) => async (req, res, next) => {
  try {
    const query = { ...req.body, ...req.query };

    if (query.format === 'excel') {
      const { data, summary, period } = await fn(query, req.companyIds, { exportAll: true });
      const tableRows = groupRowsBy ? groupConsecutive(data, groupRowsBy) : data;
      const rows = [...(flatten ? flatten(tableRows) : tableRows), totalRow(summary)];
      const sheetColumns = typeof columns === 'function' ? columns(query) : columns;
      const sheetMergeGroups = typeof mergeGroups === 'function' ? mergeGroups(query) : mergeGroups;
      const buffer = await toMultiSheetExcelBuffer([{ name: sheetName, columns: sheetColumns, rows, mergeGroups: sheetMergeGroups }]);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_${periodSuffix(period)}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    const { data, meta, summary, period } = await fn(query, req.companyIds);
    return sendPaginated(res, { records: data, summary, period }, meta, message);
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error(`${label} error`, { error: err.message, stack: err.stack });
    return next(err);
  }
};

/** GET /api/v1/reports/bu-wise-utilisation  (?format=excel exports every matching row) */
const getBuWiseUtilisation = handle({
  label: 'getBuWiseUtilisation',
  fn: service.getBuWiseUtilisationReport,
  message: 'BU-wise utilisation report fetched successfully.',
  columns: buColumnsFor,
  flatten: flattenSubBus,
  sheetName: 'BU-wise Utilisation',
  filePrefix: 'BU_wise_Utilisation',
  totalRow: (s) => ({
    buName: 'Total',
    totalEmployees: s.totalEmployees,
    expectedHours: s.expectedHours,
    billableHours: s.billableHours,
    nonBillableHours: s.nonBillableHours,
    customerNonBillableHours: s.customerNonBillableHours,
    totalLoggedHours: s.totalLoggedHours,
    utilizationPercentage: s.utilizationPercentage,
    notLoggedHours: s.notLoggedHours,
    originalBillableHours: s.originalBillableHours,
    originalNonBillableHours: s.originalNonBillableHours,
    originalCustomerNonBillableHours: s.originalCustomerNonBillableHours,
    originalTotalLoggedHours: s.originalTotalLoggedHours,
    originalUtilizationPercentage: s.originalUtilizationPercentage,
  }),
});

/** GET /api/v1/reports/employee-project-utilisation  (?format=excel exports every matching row) */
const getEmployeeProjectUtilisation = handle({
  label: 'getEmployeeProjectUtilisation',
  fn: service.getEmployeeProjectUtilisationReport,
  message: 'Employee project utilisation report fetched successfully.',
  columns: empProjectColumnsFor,
  sheetName: 'Employee Project Utilisation',
  filePrefix: 'Employee_Project_Utilisation',
  // One employee = a block of consecutive project rows; their name and the per-employee %
  // column are merged across the block (as in the UI). Project / client / hours stay per row.
  groupRowsBy: 'employeeId',
  mergeGroups: empProjectMergeGroupsFor,
  // The % columns are per-employee totals — meaningless summed/averaged, so left blank.
  totalRow: (s) => ({
    employeeName: 'Total',
    loggedHours: s.loggedHours,
    adjustedHours: s.adjustedHours,
  }),
});

module.exports = {
  getBuWiseUtilisation,
  getEmployeeProjectUtilisation,
  buColumnsFor,
  empProjectColumnsFor,
  empProjectMergeGroupsFor,
};
