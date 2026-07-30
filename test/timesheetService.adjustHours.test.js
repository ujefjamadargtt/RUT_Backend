'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adjustHoursTo176 } = require('../src/services/timesheetService');

// Minimal row fixtures — only the fields adjustHoursTo176 actually reads.
function row(overrides) {
  return {
    employeeId: 1,
    rowNumber: 1,
    projectLabel: 'Some Project',
    servicePOName: 'Some Project',
    isWorking: true,
    hours: 0,
    ...overrides,
  };
}

function leaveRow(hours, overrides = {}) {
  return row({ projectLabel: 'Leave', servicePOName: 'Leave', hours, ...overrides });
}

function sum(rows) {
  return rows.reduce((s, r) => s + r.hours, 0);
}

function byLabel(rows, label) {
  return rows.find((r) => (r.projectLabel || r.servicePOName) === label);
}

test('total hours <= 176: nothing is adjusted (edge case 1)', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 100 }),
    row({ projectLabel: 'P2', hours: 76 }),
  ];
  const result = adjustHoursTo176(input);
  assert.equal(sum(result), 176);
  assert.equal(byLabel(result, 'P1').hours, 100);
  assert.equal(byLabel(result, 'P2').hours, 76);
});

test('total hours == 176 exactly: nothing is adjusted', () => {
  const input = [row({ projectLabel: 'P1', hours: 176 })];
  const result = adjustHoursTo176(input);
  assert.equal(result[0].hours, 176);
});

test('worked example from spec: P1=62, P2=60, P3=50, Leave=8 (total=180)', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 62 }),
    row({ projectLabel: 'P2', hours: 60 }),
    row({ projectLabel: 'P3', hours: 50 }),
    leaveRow(8),
  ];
  const result = adjustHoursTo176(input);

  // Leave must be untouched.
  assert.equal(byLabel(result, 'Leave').hours, 8);

  // ratio = (176-8)/(180-8) = 168/172 = 0.976744186...
  assert.equal(byLabel(result, 'P1').hours, 60.56); // 62 * ratio, rounded
  assert.equal(byLabel(result, 'P2').hours, 58.60); // 60 * ratio, rounded
  assert.equal(byLabel(result, 'P3').hours, 48.84); // 50 * ratio, rounded (remainder distribution)

  // Grand total must be EXACTLY 176, not 175.99 / 176.01.
  assert.equal(sum(result), 176);
});

test('edge case 2: Leave = 0 -> ratio = 176 / totalWorkingHours', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 100 }),
    row({ projectLabel: 'P2', hours: 100 }),
  ];
  const result = adjustHoursTo176(input);
  // ratio = 176/200 = 0.88
  assert.equal(byLabel(result, 'P1').hours, 88);
  assert.equal(byLabel(result, 'P2').hours, 88);
  assert.equal(sum(result), 176);
});

test('edge case 3: all non-Leave hours are 0 -> no adjustment (Leave alone exceeds 176)', () => {
  const input = [
    leaveRow(180),
    row({ projectLabel: 'P1', hours: 0 }),
  ];
  const result = adjustHoursTo176(input);
  assert.equal(byLabel(result, 'Leave').hours, 180);
  assert.equal(byLabel(result, 'P1').hours, 0);
});

test('a PO with 0 hours is never assigned an adjusted value, even when siblings are scaled', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 150 }),
    row({ projectLabel: 'P2', hours: 0 }),
    leaveRow(30),
  ];
  const result = adjustHoursTo176(input);
  // total = 180 > 176; leaveHours = 30 (Leave) — P2's 0 hours are excluded too,
  // but contribute nothing to leaveHours/workingHours either way.
  // allowedWorkingHours = 176-30 = 146; workingHours = 180-30 = 150; ratio = 146/150
  assert.equal(byLabel(result, 'P2').hours, 0, 'zero-hour PO must remain exactly 0');
  assert.equal(byLabel(result, 'Leave').hours, 30, 'Leave must remain unchanged');
  assert.equal(sum(result), 176);
});

test('"Is Working = false" bypass still leaves the whole employee untouched', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 200, isWorking: false }),
    leaveRow(10, { isWorking: false }),
  ];
  const result = adjustHoursTo176(input);
  assert.equal(byLabel(result, 'P1').hours, 200);
  assert.equal(byLabel(result, 'Leave').hours, 10);
});

test('multiple employees are adjusted independently', () => {
  const input = [
    row({ employeeId: 1, projectLabel: 'P1', hours: 200 }),
    row({ employeeId: 2, projectLabel: 'P1', hours: 100 }), // <= 176, untouched
  ];
  const result = adjustHoursTo176(input);
  const emp1 = result.find((r) => r.employeeId === 1);
  const emp2 = result.find((r) => r.employeeId === 2);
  assert.equal(emp1.hours, 176);
  assert.equal(emp2.hours, 100);
});

test('largest-remainder distribution guarantees an exact 176 total even with repeating decimals', () => {
  // 59+59+59 = 177 (1 hour over). ratio = 176/177 = 0.9943502824...
  // Naive per-row rounding of 58.6666... three ways would land on 175.98 or
  // 176.01 depending on rounding direction — this must land on exactly 176.
  const input = [
    row({ projectLabel: 'P1', hours: 59 }),
    row({ projectLabel: 'P2', hours: 59 }),
    row({ projectLabel: 'P3', hours: 59 }),
  ];
  const result = adjustHoursTo176(input);
  assert.equal(sum(result), 176);
  // Each row should be within a rounding cent of the true ratio value.
  for (const r of result) {
    assert.ok(Math.abs(r.hours - 59 * (176 / 177)) < 0.01);
  }
});

test('relative distribution is preserved (larger original hours stay proportionally larger)', () => {
  const input = [
    row({ projectLabel: 'P1', hours: 100 }),
    row({ projectLabel: 'P2', hours: 50 }),
    row({ projectLabel: 'P3', hours: 30 }),
  ];
  const result = adjustHoursTo176(input);
  const p1 = byLabel(result, 'P1').hours;
  const p2 = byLabel(result, 'P2').hours;
  const p3 = byLabel(result, 'P3').hours;
  assert.ok(p1 > p2 && p2 > p3, 'ordering by magnitude must be preserved');
  // p1/p2 ratio should still be ~100/50 = 2
  assert.ok(Math.abs(p1 / p2 - 2) < 0.01);
  assert.equal(sum(result), 176);
});
