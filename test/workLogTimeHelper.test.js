'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateHoursFromTimes,
  assertNoOverlappingEntries,
  sumHours,
  formatHoursAsHrMin,
} = require('../src/helpers/workLogTimeHelper');

// Ticket example: Module A logged as 09:30-10:20 (50 min) and 14:00-15:00
// (60 min) on the same date -> combined total 110 min = "1 hr 50 mins".
test('calculateHoursFromTimes: ticket example segments compute the expected per-entry hours', () => {
  assert.equal(calculateHoursFromTimes('09:30', '10:20'), 0.83);
  assert.equal(calculateHoursFromTimes('14:00', '15:00'), 1);
});

test('sumHours + formatHoursAsHrMin: ticket example combines to 1 hr 50 mins', () => {
  const total = sumHours([0.83, 1]);
  assert.equal(total, 1.83);
  assert.equal(formatHoursAsHrMin(total), '1 hr 50 mins');
});

test('formatHoursAsHrMin: whole hours only omits the minutes part', () => {
  assert.equal(formatHoursAsHrMin(2), '2 hrs');
  assert.equal(formatHoursAsHrMin(1), '1 hr');
});

test('formatHoursAsHrMin: under an hour shows minutes only', () => {
  assert.equal(formatHoursAsHrMin(0.5), '30 mins');
});

test('calculateHoursFromTimes: end_time not after start_time is rejected', () => {
  assert.throws(() => calculateHoursFromTimes('10:00', '10:00'), { statusCode: 400 });
  assert.throws(() => calculateHoursFromTimes('10:00', '09:00'), { statusCode: 400 });
});

test('assertNoOverlappingEntries: non-overlapping segments (any order) pass', () => {
  assert.doesNotThrow(() => assertNoOverlappingEntries([
    { start_time: '14:00', end_time: '15:00' },
    { start_time: '09:30', end_time: '10:20' },
  ]));
});

test('assertNoOverlappingEntries: overlapping segments are rejected with a 400', () => {
  assert.throws(
    () => assertNoOverlappingEntries([
      { start_time: '09:00', end_time: '10:00' },
      { start_time: '09:30', end_time: '11:00' },
    ]),
    { statusCode: 400 }
  );
});

test('assertNoOverlappingEntries: back-to-back segments (end === next start) do not count as overlapping', () => {
  assert.doesNotThrow(() => assertNoOverlappingEntries([
    { start_time: '09:00', end_time: '10:00' },
    { start_time: '10:00', end_time: '11:00' },
  ]));
});

test('assertNoOverlappingEntries: a single entry never overlaps', () => {
  assert.doesNotThrow(() => assertNoOverlappingEntries([{ start_time: '09:00', end_time: '10:00' }]));
});
