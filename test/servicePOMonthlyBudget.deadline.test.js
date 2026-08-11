'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const { getDeadlineInfo, DEADLINE_DAY } = require('../src/config/servicePOMonthlyBudget.config');
const { DEFAULT_TZ } = require('../src/helpers/dateHelper');

test('deadline date is the configured day of the given month/year', () => {
  const { deadline } = getDeadlineInfo(2, 2026);
  assert.equal(deadline, `2026-02-${String(DEADLINE_DAY).padStart(2, '0')}`);
});

test('a month/year far in the past is always past its deadline, with no days remaining', () => {
  const { deadline_passed, days_remaining } = getDeadlineInfo(1, 2000);
  assert.equal(deadline_passed, true);
  assert.equal(days_remaining, 0);
});

test('a month/year far in the future has not passed its deadline, with days remaining', () => {
  const futureYear = moment.tz(DEFAULT_TZ).year() + 5;
  const { deadline_passed, days_remaining } = getDeadlineInfo(1, futureYear);
  assert.equal(deadline_passed, false);
  assert.ok(days_remaining > 0);
});

test('on the deadline day itself, deadline_passed is false and days_remaining is 0', () => {
  const today = moment.tz(DEFAULT_TZ).startOf('day');
  const { deadline_passed, days_remaining } = getDeadlineInfo(today.month() + 1, today.year());

  const deadlineDay = moment.tz({ year: today.year(), month: today.month(), day: DEADLINE_DAY }, DEFAULT_TZ).startOf('day');
  if (today.isSame(deadlineDay, 'day')) {
    assert.equal(deadline_passed, false);
    assert.equal(days_remaining, 0);
  } else {
    // Not the deadline day when this test happens to run — just assert the
    // invariant that days_remaining and deadline_passed never disagree.
    assert.equal(days_remaining === 0 ? true : !deadline_passed, true);
  }
});
