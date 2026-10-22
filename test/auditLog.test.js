'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AuditLog } = require('../src/models');
const { createAuditLog } = require('../src/middlewares/auditLog');
const requestContext = require('../src/utils/requestContext');
const repository = require('../src/repositories/auditLogReportRepository');
const service = require('../src/services/auditLogReportService');
const { auditLogQuerySchema } = require('../src/validations/auditLogValidation');

/**
 * Audit Log: what gets recorded (who / role / BU / IP) and how it is read back (BU visibility,
 * independent actor-BU vs record-BU filters, plain-English summary). DB-free.
 */

async function captureCreate(run) {
  const original = AuditLog.create;
  let row = null;
  try {
    AuditLog.create = async (values) => { row = values; return values; };
    await run();
  } finally {
    AuditLog.create = original;
  }
  return row;
}

// ── writing ──────────────────────────────────────────────────────────────────

test('createAuditLog: BU comes from the change snapshot (company_id) first', async () => {
  const row = await captureCreate(() => createAuditLog(7, 'create', 'service_pos', 12, null, { company_id: 23, service_po_name: 'X' }, '1.2.3.4'));
  assert.equal(row.company_id, 23);
  assert.equal(row.action, 'CREATE');
  assert.equal(row.ip_address, null); // the IP address is no longer stored
});

test('createAuditLog: a Business Unit change belongs to that BU; an explicit option wins over everything', async () => {
  const own = await captureCreate(() => createAuditLog(7, 'UPDATE', 'companies', 40, { a: 1 }, { a: 2 }));
  assert.equal(own.company_id, 40);
  const explicit = await captureCreate(() => createAuditLog(7, 'UPDATE', 'service_pos', 1, null, { company_id: 23 }, null, { companyId: 99, actorRole: 'BU Admin' }));
  assert.equal(explicit.company_id, 99);
  assert.equal(explicit.actor_role, 'BU Admin');
});

test('createAuditLog: with no snapshot BU it falls back to the BU + role + DEVICE of the current request', async () => {
  const req = {
    employeeId: 376, companyId: 68, userRoleName: 'Employee', ip: '10.0.0.9',
    headers: { 'x-device-id': 'b7e2c1de-5a4f-4c1e-9a77-1f0d2c3b4a55' }, connection: {},
  };
  const row = await captureCreate(async () => {
    requestContext.enter(req);
    await createAuditLog(null, 'DELETE', 'employee_work_logs', 5, { hours: 4 }, null);
  });
  assert.equal(row.user_id, 376);          // actor taken from the request when not passed
  assert.equal(row.company_id, 68);        // the BU the actor was acting under
  assert.equal(row.actor_role, 'Employee');
  assert.equal(row.device_id, 'b7e2c1de-5a4f-4c1e-9a77-1f0d2c3b4a55');
  assert.equal(row.ip_address, null);
});

test('device id: only a plausible id is stored; a missing or junk header gives null', async () => {
  const withHeader = (value) => captureCreate(async () => {
    requestContext.enter({ employeeId: 1, headers: value === undefined ? {} : { 'x-device-id': value }, connection: {} });
    await createAuditLog(1, 'UPDATE', 'clients', 1);
  });
  assert.equal((await withHeader('abc')).device_id, null);                 // too short
  assert.equal((await withHeader('<script>alert(1)</script>')).device_id, null);
  assert.equal((await withHeader(undefined)).device_id, null);
  assert.equal((await withHeader('device-1234567890')).device_id, 'device-1234567890');
  const explicit = await captureCreate(() => createAuditLog(1, 'LOGIN', 'employees', 1, null, null, null, { deviceId: 'login-device-0001' }));
  assert.equal(explicit.device_id, 'login-device-0001');
});

test('createAuditLog: never throws and never stores a non-BU company_id', async () => {
  const row = await captureCreate(() => createAuditLog(1, 'UPDATE', 'service_pos', 1, null, { company_id: 'abc' }));
  assert.equal(row.company_id, null);
  const original = AuditLog.create;
  try {
    AuditLog.create = async () => { throw new Error('db down'); };
    await assert.doesNotReject(() => createAuditLog(1, 'UPDATE', 'x', 1));
  } finally {
    AuditLog.create = original;
  }
});

// ── reading ──────────────────────────────────────────────────────────────────

test('visibility: a BU-scoped viewer sees their BU\'s DATA or their BU\'s PEOPLE; Platform Admin sees everything', () => {
  const bu = repository.buildWhere({ scope: { kind: 'reach', reachIds: [23], selfId: 5, includeSelf: false }, startDate: '2026-10-01', endDate: '2026-10-08' });
  assert.match(bu.whereSql, /a\.company_id IN \(:reachIds\) OR ab\.member_ids && ARRAY\[:reachIds\]::int\[\]/);
  assert.doesNotMatch(bu.whereSql, /a\.user_id = :selfId/);
  const admin = repository.buildWhere({ scope: { kind: 'reach', reachIds: [23], selfId: 5, includeSelf: true }, startDate: '2026-10-01', endDate: '2026-10-08' });
  assert.match(admin.whereSql, /a\.user_id = :selfId/);
  const platform = repository.buildWhere({ scope: { kind: 'all' }, startDate: '2026-10-01', endDate: '2026-10-08' });
  assert.doesNotMatch(platform.whereSql, /reachIds/);
});

test('actor BU and record BU are independent filters', () => {
  const base = { scope: { kind: 'all' }, startDate: '2026-10-01', endDate: '2026-10-08' };
  const actor = repository.buildWhere({ ...base, actorBuIds: [68] });
  assert.match(actor.whereSql, /ab\.bu_ids && ARRAY\[:actorBuIds\]::int\[\]/);
  assert.doesNotMatch(actor.whereSql, /:recordBuIds/);
  const record = repository.buildWhere({ ...base, recordBuIds: [69] });
  assert.match(record.whereSql, /a\.company_id IN \(:recordBuIds\)/);
  assert.doesNotMatch(record.whereSql, /:actorBuIds/);
  const sub = repository.buildWhere({ ...base, actorSubBuIds: [42] });
  assert.match(sub.whereSql, /ab\.sub_bu_ids && ARRAY\[:actorSubBuIds\]::int\[\]/);
});

test('roles without access (Team Lead, Employee, ...) are refused; a BU-less admin sees nothing, not everything', async () => {
  await assert.rejects(service.resolveScope({ hierarchyRank: 7, employeeId: 1 }, [1]), (e) => e.statusCode === 403);
  await assert.rejects(service.resolveScope({ hierarchyRank: null, employeeId: 1 }, [1]), (e) => e.statusCode === 403);
  assert.deepEqual(await service.resolveScope({ hierarchyRank: 1, employeeId: 1 }, []), { kind: 'all' });
  const noBu = await service.resolveScope({ hierarchyRank: 4, employeeId: 1 }, []);
  assert.deepEqual(noBu.reachIds, [-1]);
  assert.equal((await service.resolveScope({ hierarchyRank: 2, employeeId: 1 }, [])).includeSelf, true);
  assert.equal((await service.resolveScope({ hierarchyRank: 4, employeeId: 1 }, [])).includeSelf, false);
});

test('summary reads like a sentence and a change shows from → to (noise fields hidden)', () => {
  const row = {
    action: 'UPDATE', entity_type: 'service_pos', entity_id: 152, entity_label: 'PO One Five Two',
    old_values: { status: 'in-progress', updated_by: 1 }, new_values: { status: 'on-hold', updated_by: 2 },
  };
  const changes = service.diffValues(row.old_values, row.new_values);
  assert.deepEqual(changes, [{ field: 'status', from: 'in-progress', to: 'on-hold' }]);
  assert.equal(service.buildSummary(row, changes), 'Updated Service PO "PO One Five Two" — status: in-progress → on-hold');
  assert.equal(service.buildSummary({ action: 'LOGIN', entity_type: 'employees' }, []), 'Signed in');
  assert.equal(service.buildSummary({ action: 'DELETE', entity_type: 'employee_work_logs', entity_id: 9 }, []), 'Deleted Work Log #9');
});

test('a day\'s work-log save is summarised as entries/hours before → after', () => {
  const changes = service.diffValues(
    { date: '2026-10-05', entries: [{ hours: 8 }] },
    { date: '2026-10-05', entries: [{ hours: 4 }, { hours: 4.5 }] }
  );
  assert.deepEqual(changes, [{ field: 'entries', from: '1 entries / 8h', to: '2 entries / 8.5h' }]);
});

test('a record keeps who/role/BU/Sub-BU and falls back to "Former user" for a legacy actor id', () => {
  const rec = service.toRecord({
    id: 1, created_at: new Date('2026-10-08T05:00:00Z'), action: 'CREATE', entity_type: 'clients', entity_id: 3, entity_label: 'Acme',
    actor_id: 999, actor_name: null, actor_role: 'BU Admin', actor_bu: 'Alpha', actor_sub_bu: 'Alpha Sub',
    record_bu_id: 2, record_bu: 'Beta', record_sub_bu: null, device_id: 'device-1234567890', old_values: null, new_values: { client_name: 'Acme' },
  });
  assert.equal(rec.actor_name, 'Former user #999');
  assert.equal(rec.actor_bu, 'Alpha');
  assert.equal(rec.record_bu, 'Beta');
  assert.equal(rec.action_label, 'Created');
  assert.equal(rec.device_id, 'device-1234567890');
  assert.equal('ip_address' in rec, false);   // no IP address in the audit screen
  assert.equal('new_values' in rec, false); // raw JSON only on the detail call
});

test('period defaults to the last 7 days; an over-long or inverted range is rejected', () => {
  const p = service.resolvePeriod({});
  assert.ok(p.start_date <= p.end_date);
  assert.throws(() => service.resolvePeriod({ start_date: '2024-01-01', end_date: '2026-01-01' }), (e) => e.statusCode === 400);
  assert.throws(() => service.resolvePeriod({ start_date: '2026-10-08', end_date: '2026-10-01' }), (e) => e.statusCode === 400);
});

test('query validation accepts the documented filters and rejects junk', () => {
  const ok = auditLogQuerySchema.validate({ actor_bu_ids: '1,2', record_bu_ids: '3', actions: 'CREATE,DELETE', entity_types: 'clients', limit: '25' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.limit, 25);
  assert.ok(auditLogQuerySchema.validate({ actor_bu_ids: 'x' }).error);
  assert.equal(auditLogQuerySchema.validate({ device_id: 'device-1234567890' }).error, undefined);
  assert.ok(auditLogQuerySchema.validate({ limit: 1000 }).error);
});

// ── logged hours are not part of the audit screen ──────────────────────────────

test('hours-logging activity (work log create/update/delete/resubmit) is excluded; approve/reject stay', () => {
  const { whereSql } = repository.buildWhere({ scope: { kind: 'all' }, startDate: '2026-10-01', endDate: '2026-10-08' });
  assert.match(whereSql, /NOT \(a\.entity_type = 'employee_work_logs' AND a\.action IN \('CREATE', 'UPDATE', 'DELETE', 'RESUBMIT'\)\)/);
  assert.doesNotMatch(whereSql, /'APPROVE'|'REJECT'/);
});

test('reminders are never audited: not written, and hidden from the screen', async () => {
  const written = await captureCreate(() => createAuditLog(1, 'APPROVAL_REMINDER', 'employee_work_logs', null, null, { to: 'manager' }));
  assert.equal(written, null);
  assert.equal(await captureCreate(() => createAuditLog(1, 'remind', 'employees', 1)), null);
  const { whereSql } = repository.buildWhere({ scope: { kind: 'all' }, startDate: '2026-10-01', endDate: '2026-10-08' });
  assert.match(whereSql, /NOT ILIKE '%REMIND%'/);
});

test('the employee timesheet services no longer write audit rows for logged hours', async () => {
  const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
  const employeeTimesheetService = require('../src/services/employeeTimesheetService');
  const originalFind = employeeWorkLogRepository.findByIdForEmployee;
  const originalDelete = employeeWorkLogRepository.deleteById;
  const row = await captureCreate(async () => {
    try {
      employeeWorkLogRepository.findByIdForEmployee = async () => ({ id: 6676, status: 'pending', company_id: 69 });
      employeeWorkLogRepository.deleteById = async () => 1;
      await employeeTimesheetService.deleteEntry(376, 68, 6676);
    } finally {
      employeeWorkLogRepository.findByIdForEmployee = originalFind;
      employeeWorkLogRepository.deleteById = originalDelete;
    }
  });
  assert.equal(row, null);
});

// ── deleting timesheets / monthly sheets: the audit row says WHICH one, of which month and BU ──────

test('deleting monthly sheets writes one audit row PER sheet with its month, year, source, rows and BU', async () => {
  const timesheetService = require('../src/services/timesheetService');
  const timesheetController = require('../src/controllers/timesheetController');
  const original = timesheetService.deleteImports;
  const rows = [];
  const originalCreate = AuditLog.create;
  try {
    AuditLog.create = async (values) => { rows.push(values); return values; };
    timesheetService.deleteImports = async () => ({
      deletedImportCount: 2, deletedTimesheetRows: 6, deletedErrorRows: 0, revertedWorkLogs: 5, removedFiles: [], failedFiles: [],
      deletedImports: [
        { import_id: 62, file_name: 'Sep.xlsx', source: 'pms', month: 9, year: 2026, timesheet_rows: 4, company_id: 68 },
        { import_id: 60, file_name: 'Aug.xlsx', source: 'excel', month: 8, year: 2026, timesheet_rows: 2, company_id: 69 },
      ],
    });
    let body = null;
    const res = { status() { return this; }, json(b) { body = b; return this; } };
    await timesheetController.deleteImports({ body: { ids: [62, 60] }, userId: 3, employeeId: 3, hierarchyRank: 1, employeeBusinessUnits: [], headers: {}, ip: '1.1.1.1' }, res, (e) => { throw e; });

    // let the non-blocking audit writes settle
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.company_id).sort(), [68, 69]);   // each sheet keeps its OWN BU
    assert.deepEqual(rows.map((r) => r.entity_id).sort(), [60, 62]);
    const sep = rows.find((r) => r.entity_id === 62);
    assert.equal(sep.action, 'DELETE');
    assert.equal(sep.old_values.month, 9);
    assert.equal(sep.old_values.year, 2026);
    assert.equal(sep.old_values.file_name, 'Sep.xlsx');
    assert.ok(body && !('deletedImports' in (body.data || {})), 'the extra detail is not leaked into the API response');
  } finally {
    timesheetService.deleteImports = original;
    AuditLog.create = originalCreate;
  }
});

test('the audit screen words a deleted monthly sheet, a deleted timesheet and a sync/import in plain English', () => {
  const sheet = service.toRecord({
    id: 1, created_at: new Date(), action: 'DELETE', entity_type: 'timesheet_import_history', entity_id: 62, entity_label: 'Sep.xlsx',
    actor_id: 3, actor_name: 'Admin',
    old_values: { import_id: 62, file_name: 'Sep.xlsx', source: 'pms', month: 9, year: 2026, timesheet_rows: 4 }, new_values: null,
  });
  assert.equal(sheet.summary, 'Deleted monthly sheet "Sep.xlsx" — Sep 2026 · Synced from work logs · 4 rows');
  assert.equal(sheet.entity_type_label, 'Monthly Sheet');

  const timesheet = service.toRecord({
    id: 2, created_at: new Date(), action: 'DELETE', entity_type: 'timesheets', entity_id: 9,
    actor_id: 3, actor_name: 'Admin',
    old_values: { employee_name: 'Virat kohli', service_po_name: 'non-Parent sPO', timesheet_date: '2026-09-14', hours_logged: 8 }, new_values: null,
  });
  assert.equal(timesheet.summary, 'Deleted timesheet — Virat kohli · non-Parent sPO · 2026-09-14 · 8h');

  const imported = service.toRecord({
    id: 3, created_at: new Date(), action: 'IMPORT', entity_type: 'timesheets', entity_id: 65,
    actor_id: 3, actor_name: 'Admin', old_values: null,
    new_values: { importId: 65, insertedRows: 12, month: 9, year: 2026, source: 'excel', file_name: 'Sep.xlsx' },
  });
  assert.equal(imported.summary, 'Imported monthly sheet — Sep 2026 · Excel import · 12 rows · Sep.xlsx');
});

test('deleting a timesheet hands back WHICH one (employee, PO, date, hours, BU) for the audit row', async () => {
  const timesheetService = require('../src/services/timesheetService');
  const timesheetRepository = require('../src/repositories/timesheetRepository');
  const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
  const { sequelize } = require('../src/models');
  const originals = {
    findById: timesheetRepository.findById,
    deleteById: timesheetRepository.deleteById,
    revert: employeeWorkLogRepository.revertSyncStatusByTuple,
    transaction: sequelize.transaction,
  };
  try {
    timesheetRepository.findById = async () => ({
      get: () => ({
        id: 9, employee_id: 376, service_po_id: 191, timesheet_date: '2026-09-14', hours_logged: '8.00', modified_hours: '8.00',
        timesheet_import_id: 65, company_id: 69,
        employee: { full_name: 'Virat kohli', employee_code: 'E376' },
        servicePO: { service_po_name: 'non-Parent sPO', client: { client_name: 'Acme' } },
      }),
      company_id: 69, employee_id: 376, service_po_id: 191, timesheet_date: '2026-09-14',
    });
    timesheetRepository.deleteById = async () => 1;
    employeeWorkLogRepository.revertSyncStatusByTuple = async () => 1;
    sequelize.transaction = async () => ({ commit: async () => {}, rollback: async () => {} });

    const deleted = await timesheetService.deleteTimesheet(9, [69]);

    assert.equal(deleted.employee_name, 'Virat kohli');
    assert.equal(deleted.service_po_name, 'non-Parent sPO');
    assert.equal(deleted.client_name, 'Acme');
    assert.equal(deleted.timesheet_date, '2026-09-14');
    assert.equal(deleted.hours_logged, 8);
    assert.equal(deleted.company_id, 69);
  } finally {
    timesheetRepository.findById = originals.findById;
    timesheetRepository.deleteById = originals.deleteById;
    employeeWorkLogRepository.revertSyncStatusByTuple = originals.revert;
    sequelize.transaction = originals.transaction;
  }
});
