'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, Employee } = require('../src/models');
const aiGateway = require('../src/providers/gateway.provider');
const dashboardService = require('../src/services/dashboardService');
const aiCopilotService = require('../src/services/aiCopilotService');
const aiCopilotController = require('../src/controllers/aiCopilot.controller');

/**
 * AI Copilot company scope. The route now resolves the caller's reach (req.companyIds, an array)
 * like the analytics dashboard it reads from. Bug fixed: Admin / Entity Admin have no single
 * req.companyId, so every data question died with
 * 'Named replacement ":companyId" has no entry in the replacement map.'
 */

const ORIGINAL = {
  query: sequelize.query,
  employeeFindAll: Employee.findAll,
  generateInsight: aiGateway.generateInsight,
  getAnalyticsDashboard: dashboardService.getAnalyticsDashboard,
  answerQuestion: aiCopilotService.answerQuestion,
};

function restore() {
  sequelize.query = ORIGINAL.query;
  Employee.findAll = ORIGINAL.employeeFindAll;
  aiGateway.generateInsight = ORIGINAL.generateInsight;
  dashboardService.getAnalyticsDashboard = ORIGINAL.getAnalyticsDashboard;
  aiCopilotService.answerQuestion = ORIGINAL.answerQuestion;
}

const STUB_ANSWER = { title: 'stub', severity: 'info', summary: 'stub', findings: [], actions: [], audience_roles: [] };

test('route: POST /ai/query resolves the multi-BU reach (req.companyIds) instead of the single-company authenticate', () => {
  const router = require('../src/routes/aiCopilot.routes');
  const layer = router.stack.find((l) => l.route && l.route.path === '/query' && l.route.methods.post);
  assert.ok(layer, 'POST /query is registered');

  const handlerNames = layer.route.stack.map((s) => s.handle.name);
  assert.ok(handlerNames.includes('authenticateIdentity'), 'identity only, not the full authenticate()');
  assert.ok(handlerNames.includes('resolveReportCompanyScope'), 'reach is resolved into req.companyIds');
  assert.ok(handlerNames.indexOf('authenticateIdentity') < handlerNames.indexOf('resolveReportCompanyScope'));
});

test('controller: the resolved reach (req.companyIds) is what reaches the service', async () => {
  try {
    let received;
    aiCopilotService.answerQuestion = async (args) => { received = args; return { ok: true }; };
    const res = { status() { return this; }, json() { return this; } };

    await aiCopilotController.query(
      { body: { question: 'which employee is on bench', roleId: 5, hoursSource: 'M' }, companyIds: [11, 12], userRoles: ['Admin'], userId: 3 },
      res,
      () => {}
    );

    assert.deepEqual(received.companyId, [11, 12]);
    assert.deepEqual(received.audienceRoles, ['Admin']);
  } finally {
    restore();
  }
});

test('timesheet question: the missing-timesheet query is bound to the whole reach (IN, array replacement)', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    const calls = [];
    sequelize.query = async (sql, opts) => { calls.push({ sql, replacements: opts.replacements }); return []; };

    const result = await aiCopilotService.answerQuestion({ question: 'who has not filled their timesheet', companyId: [24, 25, 26] });

    assert.deepEqual(result.intents_detected, ['timesheet']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /e\.company_id IN \(:companyIds\)/);
    assert.match(calls[0].sql, /ebu\.business_unit_id IN \(:companyIds\)/);
    assert.doesNotMatch(calls[0].sql, /= :companyId\b/);
    assert.deepEqual(calls[0].replacements.companyIds, [24, 25, 26]);
  } finally {
    restore();
  }
});

test('timesheet question with a single id (BU-scoped caller) still works', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    let replacements;
    sequelize.query = async (_sql, opts) => { replacements = opts.replacements; return []; };

    await aiCopilotService.answerQuestion({ question: 'who has not filled their timesheet', companyId: 7 });

    assert.deepEqual(replacements.companyIds, [7]);
  } finally {
    restore();
  }
});

test('employee-name lookup is scoped to the whole reach', async () => {
  try {
    aiGateway.generateInsight = async () => STUB_ANSWER;
    dashboardService.getAnalyticsDashboard = async () => ({ charts: { hours_by_employee: [], employee_bench_pct: [], hours_by_client: [] } });
    let where;
    Employee.findAll = async (opts) => { where = opts.where; return []; };

    await aiCopilotService.answerQuestion({ question: 'show hours of employee Asha Rao', companyId: [3, 4] });

    assert.ok(where, 'the employee lookup ran');
    assert.deepEqual(where[Op.or][0].company_id[Op.in], [3, 4]);
    assert.deepEqual(where[Op.or][1]['$businessUnits.id$'][Op.in], [3, 4]);
  } finally {
    restore();
  }
});

test('no Business Unit in reach (empty or missing scope): a clear answer, no query, no AI call', async () => {
  try {
    let touched = false;
    sequelize.query = async () => { touched = true; return []; };
    Employee.findAll = async () => { touched = true; return []; };
    dashboardService.getAnalyticsDashboard = async () => { touched = true; return {}; };
    aiGateway.generateInsight = async () => { touched = true; return STUB_ANSWER; };

    for (const companyId of [[], undefined, null]) {
      const result = await aiCopilotService.answerQuestion({ question: 'which employee is on bench give me list', companyId });
      assert.equal(result.data, null);
      assert.match(result.answer.summary, /No Business Unit is available/);
      assert.equal(result.answer.priority, 'info');
    }
    assert.equal(touched, false);
  } finally {
    restore();
  }
});
