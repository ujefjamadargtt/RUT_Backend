'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiGateway = require('../src/providers/gateway.provider');
const reportService = require('../src/services/reportService');
const aiCopilotService = require('../src/services/aiCopilotService');
const { classifyIntent, isPoHoursQuestion } = require('../src/utils/aiCopilotIntent');

/**
 * AI Copilot: "in september which service PO filled logs".
 * Bug fixed: the question went to the generic "project" intent, whose Service PO summary only has
 * `hours_delivered_before_month` (cumulative hours BEFORE the month). The AI reported those as September
 * hours (e.g. 835 h for a PO that logged nothing in September). It is now answered from the hours logged
 * IN the month per Service PO.
 */

const ORIGINAL = {
  generateInsight: aiGateway.generateInsight,
  getServicePOHoursBudgetReport: reportService.getServicePOHoursBudgetReport,
  getServicePOSummary: reportService.getServicePOSummary,
};

function restore() {
  aiGateway.generateInsight = ORIGINAL.generateInsight;
  reportService.getServicePOHoursBudgetReport = ORIGINAL.getServicePOHoursBudgetReport;
  reportService.getServicePOSummary = ORIGINAL.getServicePOSummary;
}

const STUB_ANSWER = { title: 't', severity: 'info', summary: 's', findings: [], actions: [], audience_roles: [] };

// ── classification ──────────────────────────────────────────────────────────

test('the question from the screen is a Service PO hours question, not a project-summary question', () => {
  const result = classifyIntent('in september which service PO omm filled logs');

  assert.deepEqual(result.matchedIntents, ['po_hours']);
  assert.equal(result.period.month, 9);
  assert.equal(result.period.explicit, true);
});

test('Service PO / project questions without an hours word keep their old route', () => {
  for (const question of ['Which projects are over budget?', 'which service po status is open', 'show purchase order status']) {
    assert.deepEqual(classifyIntent(question).matchedIntents, ['project'], question);
    assert.equal(isPoHoursQuestion(question), false, question);
  }
});

test('hours / logging wording around a PO all route to po_hours', () => {
  for (const question of [
    'which service PO logged hours in september',
    'hours by service po last month',
    'po wise hours for august',
    'which projects had hours filled in august',
    'service pos that booked hours this month',
  ]) {
    assert.deepEqual(classifyIntent(question).matchedIntents, ['po_hours'], question);
  }
});

test('a number in a PO hours question applies to the POs, not to employees', () => {
  const result = classifyIntent('service pos with more than 100 hours in august');

  assert.deepEqual(result.matchedIntents, ['po_hours']); // not hours_filled
  assert.deepEqual(result.hoursThreshold, { operator: 'gt', hours: 100 });
});

test('employee-hours and other questions are unchanged', () => {
  assert.deepEqual(classifyIntent('employees who filled less than 178 hours last month').matchedIntents, ['hours_filled']);
  assert.deepEqual(classifyIntent('who has not filled their timesheet').matchedIntents, ['timesheet']);
  assert.deepEqual(classifyIntent('which employee is on bench give me list').matchedIntents, ['bench', 'employee']);
});

// ── collection ──────────────────────────────────────────────────────────────

function po(id, name, hours, client = 'Client') {
  // as the report returns them: numbers already rounded, a PO with only a budget has 0 hours
  return { service_po_id: id, service_po_code: `PO-${id}`, service_po_name: name, client_name: client, total_hours: hours, cost_budget: 0 };
}

function stubPoReport(pages) {
  const calls = [];
  reportService.getServicePOHoursBudgetReport = async (query, companyIds) => {
    calls.push({ query, companyIds });
    return { data: pages[query.page - 1] || [], meta: { totalPages: pages.length } };
  };
  return calls;
}

test('po_hours: lists only POs that logged hours IN the month, most hours first, with the month total', async () => {
  try {
    let prompt;
    aiGateway.generateInsight = async (_k, p) => { prompt = p; return STUB_ANSWER; };
    const calls = stubPoReport([[po(1, 'Small', 8), po(2, 'No hours (budget only)', 0), po(3, 'Big', 120.5), po(4, 'Mid', 57.25)]]);

    const result = await aiCopilotService.answerQuestion({
      question: 'in september which service PO filled logs',
      companyId: [24, 25],
      employeeId: 3,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].companyIds, [24, 25]);
    assert.equal(calls[0].query.month, 9);
    assert.equal(calls[0].query.limit, 100);

    const d = result.data.po_hours;
    assert.deepEqual(d.service_pos.map((p) => [p.service_po_name, p.hours_logged_in_month]), [['Big', 120.5], ['Mid', 57.25], ['Small', 8]]);
    assert.equal(d.po_count_with_hours, 3);
    assert.equal(d.total_hours, 185.75);
    assert.equal(d.truncated, false);
    assert.equal(d.threshold, undefined);

    // the model is told what the numbers mean, and never sees the "before the month" column for this question
    assert.match(prompt, /DURING the stated month/);
    assert.doesNotMatch(prompt, /hours_delivered_before_month/);
    assert.equal(result.data.project, undefined);
  } finally {
    restore();
  }
});

test('po_hours: reads every page, applies an hours condition, and cuts a long list for the model', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    const many = Array.from({ length: 150 }, (_, i) => po(i + 1, `PO ${i + 1}`, i + 1));
    const calls = stubPoReport([many.slice(0, 100), many.slice(100)]);

    const all = await aiCopilotService.answerQuestion({ question: 'which service po logged hours in august 2026', companyId: [1] });
    assert.deepEqual(calls.map((c) => c.query.page), [1, 2]);
    assert.equal(all.data.po_hours.po_count_with_hours, 150);
    assert.equal(all.data.po_hours.shown_count, 60);
    assert.equal(all.data.po_hours.truncated, true);
    assert.equal(all.data.po_hours.service_pos[0].hours_logged_in_month, 150); // most hours first

    stubPoReport([many.slice(0, 100), many.slice(100)]);
    const over = await aiCopilotService.answerQuestion({ question: 'service pos with more than 140 hours in august 2026', companyId: [1] });
    assert.deepEqual(over.data.po_hours.threshold, { operator: 'gt', hours: 140 });
    assert.equal(over.data.po_hours.po_count_with_hours, 10); // 141..150

    stubPoReport([many.slice(0, 100), many.slice(100)]);
    const under = await aiCopilotService.answerQuestion({ question: 'service pos with less than 4 hours in august 2026', companyId: [1] });
    assert.deepEqual(under.data.po_hours.service_pos.map((p) => p.hours_logged_in_month), [1, 2, 3]); // fewest first
  } finally {
    restore();
  }
});

test('po_hours: no PO logged anything -> an empty list with a zero count, not an error', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    stubPoReport([[po(1, 'Budget only', 0)]]);

    const result = await aiCopilotService.answerQuestion({ question: 'which service po logged hours in august 2026', companyId: [1] });

    assert.equal(result.data.po_hours.po_count_with_hours, 0);
    assert.equal(result.data.po_hours.total_hours, 0);
    assert.deepEqual(result.data.po_hours.service_pos, []);
  } finally {
    restore();
  }
});

test('project summary: the prompt now says hours_delivered_before_month is history, not the month\'s hours', async () => {
  try {
    let prompt;
    aiGateway.generateInsight = async (_k, p) => { prompt = p; return STUB_ANSWER; };
    reportService.getServicePOSummary = async () => ({
      data: [{ service_po_id: 1, service_po_name: 'A', client_name: 'C', po_value: 100, hours_delivered_before_month: 835, monthly_billable_amount: 0 }],
      meta: {},
      summary: {},
    });

    await aiCopilotService.answerQuestion({ question: 'which projects are over budget in september', companyId: [1] });

    assert.match(prompt, /BEFORE the first day of the stated month/);
    assert.match(prompt, /NOT the hours logged during the stated month/);
  } finally {
    restore();
  }
});
