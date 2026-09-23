'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for a real user question: when two Managers race to
// bulk-approve overlapping Employee Work Log rows (e.g. a shared Centralised
// PO both Project Managers legitimately manage for the same Employee), the
// loser's call used to just see a bare `total_rows_approved: 0` — identical
// to a date/month that never had anything pending in the first place. This
// verifies the fix: approveByEmployeeAndDates()/approveByEmployeeAndMonths()
// now return a per-bucket breakdown that tells "someone already settled
// this" (already_settled: true) apart from "there was nothing here"
// (already_settled: false), and does so against the REAL DB (Postgres
// RETURNING + GROUP BY) rather than a mock, since that's exactly the part
// worth verifying end-to-end. Same style/conventions as
// test/employeeWorkLogRepository.findForSync.test.js.
const { Employee, ServicePO, EmployeeWorkLog } = require('../src/models');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');

const YEAR = 2031; // distinctive test period, unlikely to collide with real data

let employeeId;
let servicePOId;
const workLogIds = [];

test.before(async () => {
  const employee = await Employee.findOne({ raw: true });
  employeeId = employee.id;
  const servicePO = await ServicePO.findOne({ raw: true });
  servicePOId = servicePO.id;
});

test.after(async () => {
  if (workLogIds.length) {
    await EmployeeWorkLog.destroy({ where: { id: workLogIds }, force: true }).catch(() => {});
  }
});

async function createRow(workDate, status) {
  const row = await EmployeeWorkLog.create({
    employee_id: employeeId,
    service_po_id: servicePOId,
    work_date: workDate,
    hours: 1,
    description: 'race-condition regression test row',
    status,
  });
  workLogIds.push(row.id);
  return row;
}

test('approveByEmployeeAndDates: distinguishes "already settled" from "nothing pending" per date', async () => {
  const pendingDate = `${YEAR}-01-05`;
  const alreadyApprovedDate = `${YEAR}-01-06`; // simulates PM2 losing the race — PM1 already approved this one
  const emptyDate = `${YEAR}-01-07`; // employee never logged anything this date

  await createRow(pendingDate, 'pending');
  await createRow(alreadyApprovedDate, 'approved'); // pre-settled, as if another Manager just approved it

  const result = await employeeWorkLogRepository.approveByEmployeeAndDates(
    employeeId,
    [pendingDate, alreadyApprovedDate, emptyDate]
  );

  assert.equal(result.total_rows_approved, 1);

  const byDate = new Map(result.buckets.map((b) => [b.date, b]));
  assert.deepEqual(byDate.get(pendingDate), { date: pendingDate, rows_approved: 1, already_settled: false });
  assert.deepEqual(byDate.get(alreadyApprovedDate), { date: alreadyApprovedDate, rows_approved: 0, already_settled: true });
  assert.deepEqual(byDate.get(emptyDate), { date: emptyDate, rows_approved: 0, already_settled: false });
});

test('approveByEmployeeAndDates: a genuine concurrent race (two calls targeting the SAME pending row) — the loser sees already_settled: true, never a silent double-approve', async () => {
  const raceDate = `${YEAR}-02-10`;
  await createRow(raceDate, 'pending');

  // Simulate two "concurrent" bulk-approve calls by running them back to
  // back against the same row (the atomic status='pending' guard is what
  // actually protects a truly concurrent pair; this proves the SECOND call
  // correctly reports already_settled instead of a bare, unexplained 0).
  const first = await employeeWorkLogRepository.approveByEmployeeAndDates(employeeId, [raceDate]);
  const second = await employeeWorkLogRepository.approveByEmployeeAndDates(employeeId, [raceDate]);

  assert.deepEqual(first.buckets, [{ date: raceDate, rows_approved: 1, already_settled: false }]);
  assert.deepEqual(second.buckets, [{ date: raceDate, rows_approved: 0, already_settled: true }]);
  assert.equal(second.total_rows_approved, 0);
});

test('approveByEmployeeAndMonths: distinguishes "already settled" from "nothing pending" per month/year', async () => {
  const pendingMonth = { month: 3, year: YEAR };
  const settledMonth = { month: 4, year: YEAR };
  const emptyMonth = { month: 5, year: YEAR };

  await createRow(`${YEAR}-03-15`, 'pending');
  await createRow(`${YEAR}-04-15`, 'approved');

  const result = await employeeWorkLogRepository.approveByEmployeeAndMonths(
    employeeId,
    [pendingMonth, settledMonth, emptyMonth]
  );

  assert.equal(result.total_rows_approved, 1);

  const byKey = new Map(result.buckets.map((b) => [`${b.year}-${b.month}`, b]));
  assert.deepEqual(byKey.get(`${YEAR}-3`), { month: 3, year: YEAR, rows_approved: 1, already_settled: false });
  assert.deepEqual(byKey.get(`${YEAR}-4`), { month: 4, year: YEAR, rows_approved: 0, already_settled: true });
  assert.deepEqual(byKey.get(`${YEAR}-5`), { month: 5, year: YEAR, rows_approved: 0, already_settled: false });
});

test('approveByEmployeeAndDates: servicePoIds scoping still applies alongside the new per-bucket breakdown (Project Manager cross-PO isolation unaffected)', async () => {
  const date = `${YEAR}-06-01`;
  await createRow(date, 'pending');

  const result = await employeeWorkLogRepository.approveByEmployeeAndDates(employeeId, [date], null, [999999]); // a PO this row does NOT belong to

  assert.equal(result.total_rows_approved, 0);
  // Excluded by the servicePoIds filter, so the existence check (which is
  // also servicePoIds-scoped) correctly reports it as "nothing in MY scope",
  // not "already settled" — the row exists, just not under this PM's PO.
  assert.deepEqual(result.buckets, [{ date, rows_approved: 0, already_settled: false }]);
});
