'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiGateway = require('../src/providers/gateway.provider');
const reportService = require('../src/services/reportService');
const aiCopilotService = require('../src/services/aiCopilotService');
const { classifyIntent, extractHoursThreshold } = require('../src/utils/aiCopilotIntent');

/**
 * AI Copilot: "employees who filled less than 178 hours last month".
 * The question used to come back as "couldn't match that question to a supported topic" (the only
 * keyword, "employee", was misspelled, and nothing knew about hours or a limit).
 */

const ORIGINAL = {
  generateInsight: aiGateway.generateInsight,
  getEmployeeUtilizationSummary: reportService.getEmployeeUtilizationSummary,
};

function restore() {
  aiGateway.generateInsight = ORIGINAL.generateInsight;
  reportService.getEmployeeUtilizationSummary = ORIGINAL.getEmployeeUtilizationSummary;
}

const STUB_ANSWER = { title: 'stub', severity: 'info', summary: 'stub', findings: [], actions: [], audience_roles: [] };

// ── classification ──────────────────────────────────────────────────────────

test('threshold: every comparison phrase maps to the right operator and number', () => {
  const cases = [
    ['for last month give me eployee list who filled less than 178 hours', 'lt', 178],
    ['who filled fewer than 100 hrs', 'lt', 100],
    ['employees below 160 hours', 'lt', 160],
    ['who logged under 120 hours', 'lt', 120],
    ['hours filled < 178', 'lt', 178],
    ['who filled at most 150 hours', 'lte', 150],
    ['no more than 100 hours filled', 'lte', 100],
    ['who worked 120 hours or less', 'lte', 120],
    ['who filled more than 200 hours', 'gt', 200],
    ['employees above 176 hrs logged', 'gt', 176],
    ['who logged over 180.5 hours', 'gt', 180.5],
    ['who filled at least 160 hours', 'gte', 160],
    ['minimum 170 hours filled', 'gte', 170],
    ['who worked 176 hours or more', 'gte', 176],
    ['who filled less than 178', 'lt', 178], // no unit, but the question is about filled hours
  ];
  for (const [question, operator, hours] of cases) {
    assert.deepEqual(extractHoursThreshold(question), { operator, hours }, question);
  }
});

test('threshold: questions that are not about hours are not picked up', () => {
  for (const question of [
    'cost below 5000',
    'which employee has more than 3 projects',
    'employees under utilization',
    'who is on bench',
    'which clients are above average',
    'filled hours',
    '',
  ]) {
    assert.equal(extractHoursThreshold(question), null, JSON.stringify(question));
  }
});

test('classifyIntent: the question from the screen is matched (typo included) and reads "last month"', () => {
  const result = classifyIntent('for last month give me eployee list who filled less than 178 hours');

  assert.deepEqual(result.matchedIntents, ['hours_filled']);
  assert.deepEqual(result.hoursThreshold, { operator: 'lt', hours: 178 });
  assert.equal(result.period.explicit, true);
  assert.deepEqual(result.unsupportedIntents, []);
});

test('classifyIntent: the generic "employee" intent is dropped when hours_filled matches, other intents are kept', () => {
  const both = classifyIntent('employees who filled less than 178 hours');
  assert.deepEqual(both.matchedIntents, ['hours_filled']);

  const withCost = classifyIntent('employees who filled less than 178 hours and the cost');
  assert.deepEqual([...withCost.matchedIntents].sort(), ['cost', 'hours_filled']);

  // unchanged behaviour for everything else
  assert.deepEqual(classifyIntent('which employee is on bench give me list').matchedIntents, ['bench', 'employee']);
  assert.equal(classifyIntent('which employee is on bench').hoursThreshold, null);
});

test('classifyIntent: common misspellings of "employee" no longer make a question unmatched', () => {
  for (const word of ['eployee', 'emplyee', 'empolyee', 'emploee']) {
    assert.ok(classifyIntent(`give me ${word} list`).matchedIntents.includes('employee'), word);
  }
});

// ── collection ──────────────────────────────────────────────────────────────

function row(id, name, billable, nonBillable, leaves = 0) {
  // numbers arrive as strings from Postgres numeric columns
  return { employee_id: id, full_name: name, billable_total: String(billable), non_billable_total: String(nonBillable), leaves_hours: String(leaves) };
}

function stubReport(pages) {
  const calls = [];
  reportService.getEmployeeUtilizationSummary = async (query, companyId) => {
    calls.push({ query, companyId });
    const data = pages[query.page - 1] || [];
    return { data, meta: { total: pages.flat().length, page: query.page, limit: query.limit, totalPages: pages.length }, summary: {} };
  };
  return calls;
}

test('hours_filled: reads every page of the report for the stated month, in the caller reach', async () => {
  try {
    let prompt;
    aiGateway.generateInsight = async (_k, p) => { prompt = p; return STUB_ANSWER; };
    const calls = stubReport([
      [row(1, 'Asha', 100, 20), row(2, 'Bala', 150, 40)],
      [row(3, 'Chitra', 0, 0), row(4, 'Dev', 170, 8)],
      [row(5, 'Esha', 90, 10)],
    ]);

    const result = await aiCopilotService.answerQuestion({
      question: 'employees who filled less than 178 hours in august 2026',
      companyId: [24, 25],
    });

    assert.deepEqual(calls.map((c) => c.query.page), [1, 2, 3]);
    assert.ok(calls.every((c) => c.query.limit === 100 && c.query.month === 8 && c.query.year === 2026));
    assert.ok(calls.every((c) => Array.isArray(c.companyId) && c.companyId.join() === '24,25'));

    const d = result.data.hours_filled;
    assert.equal(d.employees_checked, 5);
    assert.equal(d.matching_count, 3); // Asha 120, Chitra 0, Esha 100; Bala (190) and Dev (exactly 178) are not below 178
    assert.match(prompt, /hours_filled/);
  } finally {
    restore();
  }
});

test('hours_filled: total = billable + non-billable (leaves included), zero-hour employees are listed, fewest hours first', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    stubReport([[row(1, 'Asha', 100, 20, 8), row(2, 'Bala', 0, 0), row(3, 'Chitra', 60.5, 10.25), row(4, 'Dev', 200, 0)]]);

    const result = await aiCopilotService.answerQuestion({ question: 'who filled less than 178 hours in august 2026', companyId: [1] });
    const d = result.data.hours_filled;

    assert.deepEqual(d.threshold, { operator: 'lt', hours: 178 });
    assert.deepEqual(d.employees.map((e) => [e.full_name, e.total_hours]), [['Bala', 0], ['Chitra', 70.75], ['Asha', 120]]);
    assert.equal(d.employees[2].leaves_hours, 8);
    assert.equal(d.truncated, false);
  } finally {
    restore();
  }
});

test('hours_filled: the boundary is exact — "less than" excludes it, "at most" and "at least" include it', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    const pages = [[row(1, 'Exactly', 150, 28), row(2, 'Below', 100, 0), row(3, 'Above', 200, 0)]];
    const names = async (question) => {
      stubReport(pages);
      const r = await aiCopilotService.answerQuestion({ question: `${question} in august 2026`, companyId: [1] });
      return r.data.hours_filled.employees.map((e) => e.full_name);
    };

    assert.deepEqual(await names('who filled less than 178 hours'), ['Below']);
    assert.deepEqual(await names('who filled at most 178 hours'), ['Below', 'Exactly']);
    assert.deepEqual(await names('who filled more than 178 hours'), ['Above']);
    assert.deepEqual(await names('who filled at least 178 hours'), ['Above', 'Exactly']); // most hours first
  } finally {
    restore();
  }
});

test('hours_filled: a long list is cut to 100 rows for the model, with the real count and a truncated flag', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    const many = Array.from({ length: 150 }, (_, i) => row(i + 1, `Employee ${String(i + 1).padStart(3, '0')}`, i % 100, 0));
    stubReport([many.slice(0, 100), many.slice(100)]);

    const result = await aiCopilotService.answerQuestion({ question: 'who filled less than 178 hours in august 2026', companyId: [1] });
    const d = result.data.hours_filled;

    assert.equal(d.employees_checked, 150);
    assert.equal(d.matching_count, 150);
    assert.equal(d.shown_count, 100);
    assert.equal(d.employees.length, 100);
    assert.equal(d.truncated, true);
  } finally {
    restore();
  }
});

test('hours_filled: nobody matches -> an empty list with a zero count (the model says so), not an error', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    stubReport([[row(1, 'Asha', 150, 40)]]);

    const result = await aiCopilotService.answerQuestion({ question: 'who filled less than 10 hours in august 2026', companyId: [1] });

    assert.equal(result.data.hours_filled.matching_count, 0);
    assert.deepEqual(result.data.hours_filled.employees, []);
  } finally {
    restore();
  }
});
