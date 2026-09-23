'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const managementReportService = require('../src/services/managementReportService');
const managementReportController = require('../src/controllers/managementReportController');

const ORIGINAL = managementReportService.exportResourceCostUtilization;
function restore() {
  managementReportService.exportResourceCostUtilization = ORIGINAL;
}

function makeRes() {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    send(buffer) { this.sentBuffer = buffer; return this; },
  };
  return res;
}

test('exportResourceCostUtilization: same-year range groups columns as plain APR/MAY/JUN (no year suffix)', async () => {
  try {
    managementReportService.exportResourceCostUtilization = async () => ({
      data: [{
        employeeCode: 'EMP001', employeeName: 'Ravichandran', monthlyCtc: 4167, buName: 'IBM',
        projectManagers: ['Balaji', 'Suresh'], client: 'LIC', project: 'Capital-M', spo: 'Capital-M',
        months: [
          { monthNumber: 4, year: 2026, cappedHours: 176, loggedHours: 88, projectionPercentage: 73.86, actualPercentage: 50, contribution: 2083.5 },
          { monthNumber: 5, year: 2026, cappedHours: 176, loggedHours: 42, projectionPercentage: 56.82, actualPercentage: 23.86, contribution: 1073.86 },
        ],
      }],
      period: { startMonth: 4, startYear: 2026, endMonth: 5, endYear: 2026 },
    });

    const req = { query: {}, body: {}, companyIds: [1] };
    const res = makeRes();
    await managementReportController.exportResourceCostUtilization(req, res, (err) => { throw err; });

    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="resource-cost-utilization-APR2026-MAY2026.xlsx"');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sentBuffer);
    const sheet = workbook.worksheets[0];

    // Static columns span both header rows via a vertical merge — ExcelJS
    // returns the master cell's value for every cell in the merge on
    // read-back, so row 2's cell reads the same "Emp Code" rather than blank.
    assert.equal(sheet.getCell(1, 1).value, 'Emp Code');
    assert.equal(sheet.getCell(2, 1).value, 'Emp Code');
    assert.equal(sheet.getCell(2, 1).master.address, sheet.getCell(1, 1).address);

    // Month group headers: plain APR / MAY, no year suffix (same-year range).
    const empColCount = 10; // Emp Code..SPO
    assert.equal(sheet.getCell(1, empColCount + 1).value, 'APR');
    assert.equal(sheet.getCell(2, empColCount + 1).value, 'Hours');
    assert.equal(sheet.getCell(2, empColCount + 2).value, 'Logged Hrs');
    assert.equal(sheet.getCell(2, empColCount + 3).value, 'Utilization % - Projection');
    assert.equal(sheet.getCell(2, empColCount + 4).value, 'Utilization % - Actual');
    assert.equal(sheet.getCell(2, empColCount + 5).value, 'Contribution');
    assert.equal(sheet.getCell(1, empColCount + 6).value, 'MAY');

    // Data row: Expected CTC / Billed Status blank; hours/contribution populated.
    const dataRow = sheet.getRow(3);
    assert.equal(dataRow.getCell(1).value, 'EMP001');
    assert.equal(dataRow.getCell(3).value, null); // Expected CTC blank
    assert.equal(dataRow.getCell(6).value, null); // Billed Status blank
    assert.equal(dataRow.getCell(7).value, 'Balaji, Suresh'); // merged PMs, one cell
    assert.equal(dataRow.getCell(empColCount + 1).value, 176);
    assert.equal(dataRow.getCell(empColCount + 2).value, 88);
    assert.equal(dataRow.getCell(empColCount + 5).value, 2083.5);
  } finally {
    restore();
  }
});

test('exportResourceCostUtilization: a year-crossing range (Nov->Feb) suffixes month groups with the 2-digit year and preserves chronological order', async () => {
  try {
    managementReportService.exportResourceCostUtilization = async () => ({
      data: [],
      period: { startMonth: 11, startYear: 2026, endMonth: 2, endYear: 2027 },
    });

    const req = { query: {}, body: {}, companyIds: [1] };
    const res = makeRes();
    await managementReportController.exportResourceCostUtilization(req, res, (err) => { throw err; });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sentBuffer);
    const sheet = workbook.worksheets[0];

    const empColCount = 10;
    assert.equal(sheet.getCell(1, empColCount + 1).value, 'NOV-26');
    assert.equal(sheet.getCell(1, empColCount + 6).value, 'DEC-26');
    assert.equal(sheet.getCell(1, empColCount + 11).value, 'JAN-27');
    assert.equal(sheet.getCell(1, empColCount + 16).value, 'FEB-27');
  } finally {
    restore();
  }
});

test('exportResourceCostUtilization: a roster row missing a month in range still gets a 176 capped-hours placeholder, never a gap', async () => {
  try {
    managementReportService.exportResourceCostUtilization = async () => ({
      data: [{
        employeeCode: 'EMP002', employeeName: 'No Data This Month', monthlyCtc: 0, buName: null,
        projectManagers: [], client: 'X', project: 'Y', spo: 'Z',
        months: [
          { monthNumber: 4, year: 2026, cappedHours: 176, loggedHours: 0, projectionPercentage: 0, actualPercentage: 0, contribution: 0 },
          // May entry entirely absent from this employee's months[] (e.g. mapping created mid-range)
        ],
      }],
      period: { startMonth: 4, startYear: 2026, endMonth: 5, endYear: 2026 },
    });

    const req = { query: {}, body: {}, companyIds: [1] };
    const res = makeRes();
    await managementReportController.exportResourceCostUtilization(req, res, (err) => { throw err; });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sentBuffer);
    const sheet = workbook.worksheets[0];
    const empColCount = 10;
    const dataRow = sheet.getRow(3);
    assert.equal(dataRow.getCell(empColCount + 6).value, 176); // May Hours still 176, not blank
    assert.equal(dataRow.getCell(empColCount + 7).value, 0);   // May Logged Hrs defaults to 0
  } finally {
    restore();
  }
});
