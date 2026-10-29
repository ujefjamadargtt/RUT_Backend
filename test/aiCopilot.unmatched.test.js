'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const aiGateway = require('../src/providers/gateway.provider');
const aiCopilotService = require('../src/services/aiCopilotService');
const unmatchedRepo = require('../src/repositories/aiCopilotUnmatchedQuestionRepository');
const { classifyIntent, SUGGESTED_QUESTIONS } = require('../src/utils/aiCopilotIntent');

/**
 * AI Copilot: a question it cannot answer gets a helpful reply (example questions to click) and is
 * remembered, so the team can see what people really ask and add the most requested topics.
 */

const ORIGINAL = {
  record: unmatchedRepo.record,
  generateInsight: aiGateway.generateInsight,
  query: sequelize.query,
};

function restore() {
  unmatchedRepo.record = ORIGINAL.record;
  aiGateway.generateInsight = ORIGINAL.generateInsight;
  sequelize.query = ORIGINAL.query;
}

test('every suggested question is answerable: it matches a supported topic and nothing unsupported', () => {
  assert.ok(SUGGESTED_QUESTIONS.length >= 5);
  for (const question of SUGGESTED_QUESTIONS) {
    const { matchedIntents, unsupportedIntents } = classifyIntent(question);
    assert.ok(matchedIntents.length > 0, `matched: ${question}`);
    assert.deepEqual(unsupportedIntents, [], `no unsupported topic: ${question}`);
  }
});

test('unmatched question: friendly reply with suggested questions, no data, no AI call; the question is saved', async () => {
  try {
    const saved = [];
    unmatchedRepo.record = async (entry) => { saved.push(entry); };
    let aiCalled = false;
    aiGateway.generateInsight = async () => { aiCalled = true; return {}; };

    const result = await aiCopilotService.answerQuestion({
      question: 'show hours by designation',
      companyId: [24, 25],
      employeeId: 3,
    });

    assert.equal(result.data, null);
    assert.deepEqual(result.intents_detected, []);
    assert.deepEqual(result.suggested_questions, SUGGESTED_QUESTIONS);
    assert.match(result.answer.summary, /couldn't match that question/);
    assert.match(result.answer.summary, /suggested questions/);
    assert.equal(aiCalled, false);

    assert.deepEqual(saved, [{ question: 'show hours by designation', reason: 'unmatched', employeeId: 3, companyIds: [24, 25] }]);
  } finally {
    restore();
  }
});

test('unsupported topic (forecast etc.): same helpful reply, saved with reason "unsupported"', async () => {
  try {
    const saved = [];
    unmatchedRepo.record = async (entry) => { saved.push(entry); };

    const result = await aiCopilotService.answerQuestion({ question: 'forecast next quarter', companyId: [1], employeeId: 9 });

    assert.deepEqual(result.unsupported_intents_detected, ['forecast']);
    assert.deepEqual(result.suggested_questions, SUGGESTED_QUESTIONS);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reason, 'unsupported');
  } finally {
    restore();
  }
});

test('a question that IS answered is not saved and carries no suggestions', async () => {
  try {
    let recorded = false;
    unmatchedRepo.record = async () => { recorded = true; };
    aiGateway.generateInsight = async () => ({ title: 't', severity: 'info', summary: 's', findings: [], actions: [], audience_roles: [] });
    sequelize.query = async () => [];

    const result = await aiCopilotService.answerQuestion({ question: 'who has not filled their timesheet', companyId: [1], employeeId: 3 });

    assert.equal(recorded, false);
    assert.equal(result.suggested_questions, undefined);
  } finally {
    restore();
  }
});

test('failing to save the question never breaks the reply', async () => {
  try {
    unmatchedRepo.record = async () => { throw new Error('db down'); };

    const result = await aiCopilotService.answerQuestion({ question: 'show hours by designation', companyId: [1], employeeId: 3 });
    await new Promise((resolve) => setImmediate(resolve)); // let the swallowed rejection settle

    assert.match(result.answer.summary, /couldn't match/);
  } finally {
    restore();
  }
});

test('repository: normalises the question for grouping and binds every value', async () => {
  assert.equal(unmatchedRepo.normalizeQuestion('  Who IS  on Leave?? '), 'who is on leave');
  assert.equal(unmatchedRepo.normalizeQuestion('Show hours by designation.'), 'show hours by designation');
  assert.equal(unmatchedRepo.normalizeQuestion(null), '');
  assert.equal(unmatchedRepo.normalizeQuestion('x'.repeat(900)).length, 500);

  try {
    let call;
    sequelize.query = async (sql, opts) => { call = { sql, replacements: opts.replacements }; return [[], 1]; };

    await unmatchedRepo.record({ question: 'Who IS on leave?', reason: 'unmatched', employeeId: 3, companyIds: [1, 2] });

    assert.match(call.sql, /INSERT INTO ai_copilot_unmatched_questions/);
    assert.deepEqual(call.replacements, {
      question: 'Who IS on leave?',
      normalized: 'who is on leave',
      reason: 'unmatched',
      employeeId: 3,
      companyIds: '[1,2]',
    });

    await unmatchedRepo.record({ question: 'q', reason: 'unsupported', employeeId: undefined, companyIds: undefined });
    assert.equal(call.replacements.employeeId, null);
    assert.equal(call.replacements.companyIds, '[]');
  } finally {
    restore();
  }
});
