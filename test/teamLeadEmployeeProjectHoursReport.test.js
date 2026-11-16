'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Team Lead Employee Project Hours Report — access rule + query construction
// (captured SQL, no DB), service shaping and validation.
const { sequelize } = require('../src/models');
const repository = require('../src/repositories/teamLeadEmployeeProjectHoursReportRepository');
const service = require('../src/services/teamLeadEmployeeProjectHoursReportService');
const { teamLeadEmployeeProjectHoursQuerySchema: schema } = require('../src/validations/teamLeadEmployeeProjectHoursReportValidation');

function capture(rows = [], total = rows.length, totalHours = 0) {
  const original = sequelize.query;
  const calls = [];
  sequelize.query = async (sql, opts) => {
    calls.push({ sql: sql.replace(/\s+/g, ' '), replacements: opts.replacements });
    return /COUNT\(\*\)::int AS total/.test(sql) ? [{ total, total_hours: totalHours }] : rows;
  };
  return { calls, restore: () => { sequelize.query = original; } };
}

const base = { managerEmployeeId: 15, limit: 20, offset: 0 };

test('access = ONLY the caller\'s active PRIMARY/SECONDARY manager mappings (never PM / BU / SPO membership)', async () => {
  const cap = capture();
  try {
    await repository.getTeamLeadEmployeeProjectHours(base);
    const { sql, replacements } = cap.calls[0];
    assert.match(sql, /FROM manager_employee_mappings mem WHERE mem\.manager_employee_id = :managerEmployeeId AND mem\.status = 'active' AND mem\.mapping_type IN \('PRIMARY', 'SECONDARY'\) AND mem\.employee_id <> :managerEmployeeId/);
    assert.match(sql, /INNER JOIN my_employees me ON me\.employee_id = wl\.employee_id/);
    assert.doesNotMatch(sql, /employee_servicepo_mapping/); // Project Manager relationship never used
    assert.doesNotMatch(sql, /employee_business_units/);    // BU membership never used
    assert.doesNotMatch(sql, /:companyIds/);
    assert.equal(replacements.managerEmployeeId, 15);
  } finally {
    cap.restore();
  }
});

test('source is employee_work_logs: hours, description, status; BU/Sub-BU from the SPO (entry\'s BU for Centralised POs)', async () => {
  const cap = capture();
  try {
    await repository.getTeamLeadEmployeeProjectHours(base);
    const { sql } = cap.calls[0];
    assert.match(sql, /FROM \(SELECT \* FROM employee_work_logs WHERE deleted_at IS NULL\) wl/);
    assert.match(sql, /wl\.hours AS logged_hours, wl\.description, wl\.status/);
    assert.match(sql, /LEFT JOIN companies bu_unit ON bu_unit\.id = COALESCE\(sp\.company_id, wl\.company_id\)/);
    assert.match(sql, /COALESCE\(bu_parent\.company_name, bu_unit\.company_name\) AS bu_name/);
    assert.match(sql, /CASE WHEN bu_parent\.id IS NOT NULL THEN bu_unit\.company_name END AS sub_bu_name/);
    assert.match(sql, /hp\.node_name \|\| ' > ' \|\| hn\.node_name/); // hours_name = Parent > Child node
  } finally {
    cap.restore();
  }
});

test('every filter is applied in SQL and combines with AND', async () => {
  const cap = capture();
  try {
    await repository.getTeamLeadEmployeeProjectHours({
      ...base, startDate: '2026-09-01', endDate: '2026-09-30', employeeIds: [3], clientIds: [4], projectIds: [5],
      servicePoIds: [6], buIds: [23], subBuIds: [42], statuses: ['pending', 'approved'], search: ' api ',
    });
    const { sql, replacements } = cap.calls[0];
    for (const fragment of [
      'wl.work_date >= :startDate', 'wl.work_date <= :endDate', 'wl.employee_id IN (:employeeIds)',
      'sp.client_id IN (:clientIds)', 'sp.project_id IN (:projectIds)', 'wl.service_po_id IN (:servicePoIds)',
      'COALESCE(bu_parent.id, bu_unit.id) IN (:buIds)', 'bu_parent.id IS NOT NULL AND bu_unit.id IN (:subBuIds)',
      'wl.status IN (:statuses)', '(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR wl.description ILIKE :search)',
    ]) {
      assert.ok(sql.includes(fragment), `missing: ${fragment}`);
    }
    assert.equal(replacements.search, '%api%');
    assert.deepEqual(replacements.statuses, ['pending', 'approved']);
  } finally {
    cap.restore();
  }
});

test('sorting is whitelisted with stable tie-breakers; unknown sortBy falls back to date', async () => {
  const cap = capture();
  try {
    await repository.getTeamLeadEmployeeProjectHours({ ...base, sortBy: 'hours', sortOrder: 'asc' });
    assert.match(cap.calls[0].sql, /ORDER BY logged_hours ASC NULLS LAST, work_date DESC, employee_name ASC, work_log_id ASC LIMIT :limit OFFSET :offset/);
    await repository.getTeamLeadEmployeeProjectHours({ ...base, sortBy: 'drop table x' });
    assert.match(cap.calls[2].sql, /ORDER BY work_date DESC NULLS LAST/);
  } finally {
    cap.restore();
  }
});

test('service: month+year -> that month\'s date range; caller id always comes from the argument, never the query', async () => {
  const cap = capture([{ work_log_id: 1, work_date: '2026-09-16', employee_id: 3, logged_hours: '7.50', status: 'approved' }], 41, '310.25');
  try {
    const { data, meta, summary } = await service.getReport(
      { month: 2, year: 2028, page: 3, limit: 20, managerEmployeeId: 999, teamLeadId: 999 }, 15
    );
    const r = cap.calls[0].replacements;
    assert.equal(r.managerEmployeeId, 15);
    assert.equal(r.startDate, '2028-02-01');
    assert.equal(r.endDate, '2028-02-29'); // leap year
    assert.equal(r.offset, 40);
    assert.equal(data[0].logged_hours, 7.5);
    assert.equal(data[0].work_date, '2026-09-16');
    assert.equal(meta.total, 41);
    assert.equal(summary.total_logged_hours, 310.25);
  } finally {
    cap.restore();
  }
});

test('validation: no team-lead id param exists; month needs year; month XOR startDate; statuses whitelisted', () => {
  const opts = { stripUnknown: true };
  assert.equal(schema.validate({ teamLeadId: 15 }, opts).value.teamLeadId, undefined);
  assert.ok(schema.validate({ month: 9 }).error);
  assert.ok(schema.validate({ month: 9, year: 2026, startDate: '2026-09-01' }).error);
  assert.ok(schema.validate({ status: 'approved,deleted' }).error);
  assert.ok(schema.validate({ limit: 500 }).error);
  assert.equal(schema.validate({ month: 9, year: 2026, status: 'pending,synced', buIds: '23,24' }).error, undefined);
});

// ---- Export (GET /reports/team-lead-employee-project-hours/export) ----

const ExcelJS = require('exceljs');
const { toMultiSheetExcelBuffer } = require('../src/utils/reportExporter');
const { teamLeadEmployeeProjectHoursExportQuerySchema: exportSchema } = require('../src/validations/teamLeadEmployeeProjectHoursReportValidation');

const EXPORT_ROW = {
  work_log_id: 1, work_date: '2026-09-03', employee_id: 7, employee_code: 'E007', employee_name: 'Asha Rao',
  mapping_type: 'PRIMARY', client_id: 2, client_name: 'Acme', project_id: 3, project_name: 'Portal',
  service_po_id: 4, service_po_code: 'SPO-04', spo_name: 'Portal Build', hours_name: 'Module A > Task 1',
  bu_id: 23, bu_name: 'Delivery', sub_bu_id: 31, sub_bu_name: 'Delivery - West',
  logged_hours: '7.50', description: 'API work', status: 'approved',
};

test('export: same caller-only scoping + filters as the report, but NO LIMIT/OFFSET and no count query', async () => {
  const cap = capture([EXPORT_ROW]);
  try {
    await service.getExport({ month: 9, year: 2026, clientIds: '2', status: 'approved', managerEmployeeId: 999 }, 15);
    assert.equal(cap.calls.length, 1);
    const { sql, replacements } = cap.calls[0];
    assert.match(sql, /mem\.manager_employee_id = :managerEmployeeId/);
    assert.doesNotMatch(sql, /LIMIT|OFFSET|COUNT\(\*\)/);
    assert.equal(replacements.managerEmployeeId, 15); // never the query value
    assert.deepEqual(replacements.clientIds, [2]);
    assert.deepEqual(replacements.statuses, ['approved']);
    assert.equal(replacements.startDate, '2026-09-01');
    assert.equal(replacements.endDate, '2026-09-30');
  } finally {
    cap.restore();
  }
});

test('export: the 11 requested columns, name+code combined, hours numeric, status capitalised', async () => {
  const cap = capture([EXPORT_ROW]);
  try {
    const { rows, columns, period } = await service.getExport({ month: 9, year: 2026 }, 15);
    assert.deepEqual(columns.map((c) => c.label), [
      'Employee', 'Client', 'Project', 'SPO', 'Module / Task', 'BU', 'Sub-BU', 'Logged Hours', 'Date', 'Description', 'Status',
    ]);
    assert.deepEqual(rows[0], {
      employee: 'Asha Rao (E007)', client_name: 'Acme', project_name: 'Portal', spo: 'Portal Build (SPO-04)',
      hours_name: 'Module A > Task 1', bu_name: 'Delivery', sub_bu_name: 'Delivery - West', logged_hours: 7.5,
      work_date: '2026-09-03', description: 'API work', status: 'Approved',
    });
    assert.deepEqual(period, { startDate: '2026-09-01', endDate: '2026-09-30' });

    // And it really builds a readable .xlsx.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await toMultiSheetExcelBuffer([{ name: 'Team Lead Project Hours', columns, rows }]));
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getRow(1).getCell(1).value, 'Employee');
    assert.equal(sheet.getRow(2).getCell(8).value, 7.5);
  } finally {
    cap.restore();
  }
});

test('export validation: same filter rules as the report; page/limit/sort are stripped, not applied', () => {
  const opts = { stripUnknown: true };
  assert.ok(exportSchema.validate({ month: 9 }).error);
  assert.ok(exportSchema.validate({ month: 9, year: 2026, startDate: '2026-09-01' }).error);
  assert.ok(exportSchema.validate({ format: 'csv' }).error);
  const { value, error } = exportSchema.validate({ month: 9, year: 2026, limit: 500, page: 3, sortBy: 'hours' }, opts);
  assert.equal(error, undefined);
  assert.equal(value.format, 'excel');
  assert.equal(value.limit, undefined);
  assert.equal(value.sortBy, undefined);
});
