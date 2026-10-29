'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/aiProviders.config');
const groq = require('../src/providers/groq.provider');
const claude = require('../src/providers/claude.provider');
const gateway = require('../src/providers/gateway.provider');
const companyRepository = require('../src/repositories/companyRepository');
const aiInsightService = require('../src/services/aiInsight.service');
const scheduler = require('../src/scheduler/aiInsight.scheduler');

/**
 * The AI gateway tries providers/keys/models strictly ONE AT A TIME and stops at
 * the first success; the scheduler runs companies one at a time too and stops
 * early when the AI side itself is failing.
 */

const GOOD_JSON = JSON.stringify({ title: 'T', severity: 'info', summary: 'S', findings: [], actions: [], audience_roles: [] });

const ORIGINAL = {
  priority: config.providerPriority,
  failover: config.failoverAcrossProviders,
  sameModelRetries: config.sameModelRetries,
  invalidJsonRetries: config.invalidJsonRetries,
  groqCfg: config.providers.groq,
  claudeCfg: config.providers.claude,
  groqGenerate: groq.generate,
  claudeGenerate: claude.generate,
  findLeaf: companyRepository.findInsightLeafCompanyIds,
  runJob: aiInsightService.runJob,
};

function restore() {
  config.providerPriority = ORIGINAL.priority;
  config.failoverAcrossProviders = ORIGINAL.failover;
  config.sameModelRetries = ORIGINAL.sameModelRetries;
  config.invalidJsonRetries = ORIGINAL.invalidJsonRetries;
  config.providers.groq = ORIGINAL.groqCfg;
  config.providers.claude = ORIGINAL.claudeCfg;
  groq.generate = ORIGINAL.groqGenerate;
  claude.generate = ORIGINAL.claudeGenerate;
  companyRepository.findInsightLeafCompanyIds = ORIGINAL.findLeaf;
  aiInsightService.runJob = ORIGINAL.runJob;
}

function configure({ groqModels = ['g1', 'g2'], claudeModels = ['c1'], failover = true } = {}) {
  config.providerPriority = ['groq', 'claude'];
  config.failoverAcrossProviders = failover;
  // these tests are about the order of providers / keys / models; same-model retries have their own tests
  config.sameModelRetries = 0;
  config.invalidJsonRetries = 0;
  config.providers.groq = { ...ORIGINAL.groqCfg, apiKeys: ['gk1', 'gk2'], models: groqModels };
  config.providers.claude = { ...ORIGINAL.claudeCfg, apiKeys: ['ck1'], models: claudeModels };
}

function retryableError(status = 429) {
  const err = new Error(`HTTP ${status}: rate limited`);
  err.statusCode = status;
  return err;
}

// ── gateway ─────────────────────────────────────────────────────────────────

test('gateway: first model of the first provider succeeds -> exactly ONE call, no other model/key/provider is touched', async () => {
  try {
    configure();
    const calls = [];
    groq.generate = async (_prompt, opts) => { calls.push(`groq:${opts.model}:${opts.apiKey}`); return GOOD_JSON; };
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };

    const result = await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['groq:g1:gk1']);
    assert.equal(result.title, 'T');
  } finally {
    restore();
  }
});

test('gateway: a retryable failure moves on ONE step at a time, and stops at the first success (never concurrent)', async () => {
  try {
    configure({ groqModels: ['g1'] });
    const calls = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async (label, fn) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(label);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fn();
    };
    groq.generate = (_prompt, opts) => track(`groq:${opts.apiKey}`, () => { throw retryableError(429); });
    claude.generate = (_prompt, opts) => track(`claude:${opts.apiKey}`, () => GOOD_JSON);

    const result = await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['groq:gk1', 'groq:gk2', 'claude:ck1']); // groq key 1 -> groq key 2 -> claude, in order
    assert.equal(maxInFlight, 1, 'only one provider call is ever in flight');
    assert.equal(result.title, 'T');
  } finally {
    restore();
  }
});

test('gateway: a later provider is never called once an earlier one has succeeded', async () => {
  try {
    configure({ groqModels: ['g1', 'g2'] });
    const calls = [];
    groq.generate = async (_prompt, opts) => {
      calls.push(`groq:${opts.model}`);
      if (opts.model === 'g1') throw retryableError(503);
      return GOOD_JSON; // second model works
    };
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };

    await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['groq:g1', 'groq:g2']);
  } finally {
    restore();
  }
});

// ── scheduler ───────────────────────────────────────────────────────────────

function gatewayError() {
  const err = new Error('All configured AI providers failed.');
  err.statusCode = 503;
  err.attempts = [{ provider: 'groq' }];
  return err;
}

test('scheduler: companies run one at a time, in order (no parallel burst of AI calls)', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [11, 12, 13, 14];
    const order = [];
    let inFlight = 0;
    let maxInFlight = 0;
    aiInsightService.runJob = async (_jobKey, _ctx, companyId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(companyId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    };

    await scheduler.runForAllCompanies({ job_key: 'bench_escalation' });

    assert.deepEqual(order, [11, 12, 13, 14]);
    assert.equal(maxInFlight, 1);
  } finally {
    restore();
  }
});

test('scheduler: a company-specific failure (e.g. a data error) does not stop the other companies', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [1, 2, 3];
    const ran = [];
    aiInsightService.runJob = async (_jobKey, _ctx, companyId) => {
      ran.push(companyId);
      if (companyId === 2) throw new Error('relation does not exist'); // no provider/attempts -> company-specific
      return null;
    };

    await scheduler.runForAllCompanies({ job_key: 'bench_escalation' });

    assert.deepEqual(ran, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('scheduler: an AI-gateway failure ends the run early — the remaining companies are NOT called', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [1, 2, 3, 4, 5];
    const ran = [];
    aiInsightService.runJob = async (_jobKey, _ctx, companyId) => {
      ran.push(companyId);
      if (companyId === 2) throw gatewayError(); // every provider exhausted
      return null;
    };

    await scheduler.runForAllCompanies({ job_key: 'bench_escalation' });
    assert.deepEqual(ran, [1, 2]);

    // a non-retryable provider error (e.g. bad model / auth) carries `provider`
    ran.length = 0;
    aiInsightService.runJob = async (_jobKey, _ctx, companyId) => {
      ran.push(companyId);
      const err = new Error('HTTP 404: The model does not exist');
      err.provider = 'groq';
      throw err;
    };
    await scheduler.runForAllCompanies({ job_key: 'bench_escalation' });
    assert.deepEqual(ran, [1]);
  } finally {
    restore();
  }
});

// ── model-not-found (404) must fail over, not abort ─────────────────────────

const { classify } = require('../src/providers/errorClassifier');
const aiInsightJobRepo = require('../src/repositories/aiInsightJobRepository');
const { AiInsightJob } = require('../src/models');

function httpError(status, message) {
  const err = new Error(`HTTP ${status}: ${message}`);
  err.statusCode = status;
  return err;
}

test('classifier: a 404 "model does not exist / no access" is retryable; a bare 404 and auth errors are not', () => {
  assert.deepEqual(
    classify(httpError(404, 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.')),
    { retryable: true, reason: 'model_unavailable' }
  );
  assert.equal(classify(httpError(404, 'models/gemini-x is not found for API version v1beta')).retryable, true);
  assert.equal(classify(httpError(404, 'model: claude-old')).retryable, true);

  assert.equal(classify(httpError(404, 'Not Found')).retryable, false); // wrong endpoint, not a model problem
  assert.equal(classify(httpError(401, 'invalid api key')).retryable, false);
  assert.equal(classify(httpError(400, 'bad request')).retryable, false);
  assert.equal(classify(httpError(429, 'rate limit')).retryable, true);
});

test('gateway: a missing model (404) moves on to the next model instead of aborting the whole call', async () => {
  try {
    configure({ groqModels: ['g1', 'gone', 'g3'] });
    const calls = [];
    groq.generate = async (_prompt, opts) => {
      calls.push(opts.model);
      if (opts.model === 'g1') throw httpError(429, 'Rate limit reached for model `g1` on tokens per day');
      if (opts.model === 'gone') throw httpError(404, 'The model `gone` does not exist or you do not have access to it.');
      return GOOD_JSON;
    };
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };

    const result = await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['g1', 'gone', 'g3']); // the exact log scenario — it used to stop at 'gone'
    assert.equal(result.title, 'T');
  } finally {
    restore();
  }
});

// ── event jobs are never scheduled; scheduler queue ─────────────────────────

test('findActiveCronJobs: an event-driven job is never scheduled, even if it was given a schedule by mistake', async () => {
  const original = AiInsightJob.findAll;
  try {
    AiInsightJob.findAll = async () => [
      { job_key: 'bench_escalation', frequency: 'daily', schedule_type: 'DL', cron_expression: null },
      { job_key: 'new_po_staffing_suggestion', frequency: 'event', schedule_type: 'MI', cron_expression: null },
      { job_key: 'legacy_cron', frequency: 'weekly', schedule_type: null, cron_expression: '0 9 * * 1' },
      { job_key: 'no_schedule', frequency: 'daily', schedule_type: null, cron_expression: null },
    ];
    const jobs = await aiInsightJobRepo.findActiveCronJobs();
    assert.deepEqual(jobs.map((j) => j.job_key), ['bench_escalation', 'legacy_cron']);
  } finally {
    AiInsightJob.findAll = original;
  }
});

test('scheduler queue: jobs triggered at the same time run ONE AFTER ANOTHER, never together', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [1, 2];
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    aiInsightService.runJob = async (jobKey, _ctx, companyId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`${jobKey}:${companyId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    };

    await Promise.all(['job_a', 'job_b', 'job_c'].map((job_key) => scheduler.runExclusively({ job_key })));

    assert.equal(maxInFlight, 1);
    assert.deepEqual(order, ['job_a:1', 'job_a:2', 'job_b:1', 'job_b:2', 'job_c:1', 'job_c:2']);
  } finally {
    restore();
  }
});

test('scheduler queue: a job still queued/running is not queued again; a failed run does not break the queue', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [1];
    const ran = [];
    aiInsightService.runJob = async (jobKey) => {
      ran.push(jobKey);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    };

    const first = scheduler.runExclusively({ job_key: 'slow_job' });
    const secondWhileRunning = scheduler.runExclusively({ job_key: 'slow_job' }); // trigger fires again — skipped
    await Promise.all([first, secondWhileRunning]);
    assert.deepEqual(ran, ['slow_job']);

    // finished -> it can run again
    await scheduler.runExclusively({ job_key: 'slow_job' });
    assert.deepEqual(ran, ['slow_job', 'slow_job']);

    // the leaf lookup itself failing rejects that run, but the next job still runs
    companyRepository.findInsightLeafCompanyIds = async () => { throw new Error('db down'); };
    await assert.rejects(() => scheduler.runExclusively({ job_key: 'broken' }), /db down/);
    companyRepository.findInsightLeafCompanyIds = async () => [1];
    await scheduler.runExclusively({ job_key: 'after_failure' });
    assert.equal(ran.at(-1), 'after_failure');
  } finally {
    restore();
  }
});

// ── single provider (AI_PROVIDER_FAILOVER off — the default) ────────────────

test('single provider: the default config does not fail over across providers', () => {
  assert.equal(ORIGINAL.failover, false);
});

test('single provider: success on the first provider -> one call, nothing else touched', async () => {
  try {
    configure({ failover: false });
    const calls = [];
    groq.generate = async (_prompt, opts) => { calls.push(`groq:${opts.model}`); return GOOD_JSON; };
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };

    await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['groq:g1']);
  } finally {
    restore();
  }
});

test('single provider: if the provider fails (even on every key/model) the next provider is NEVER called', async () => {
  try {
    configure({ failover: false });
    const calls = [];
    groq.generate = async (_prompt, opts) => { calls.push(`groq:${opts.model}:${opts.apiKey}`); throw retryableError(429); };
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };

    await assert.rejects(
      () => gateway.generateInsight('weekly_resource_digest', 'prompt'),
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.ok(Array.isArray(err.attempts)); // the scheduler treats this as an AI failure and stops the run
        assert.match(err.message, /AI_PROVIDER_FAILOVER is off/);
        assert.ok(err.attempts.every((a) => a.provider === 'groq'));
        return true;
      }
    );

    assert.equal(calls.includes('claude'), false);
    assert.deepEqual(calls, ['groq:g1:gk1', 'groq:g2:gk1', 'groq:g1:gk2', 'groq:g2:gk2']); // same provider: keys/models still tried
  } finally {
    restore();
  }
});

test('single provider: a non-retryable error from the provider is thrown as-is, the next provider is not called', async () => {
  try {
    configure({ failover: false });
    let claudeCalled = false;
    groq.generate = async () => { throw httpError(400, 'bad request'); };
    claude.generate = async () => { claudeCalled = true; return GOOD_JSON; };

    await assert.rejects(() => gateway.generateInsight('weekly_resource_digest', 'prompt'), /HTTP 400/);
    assert.equal(claudeCalled, false);
  } finally {
    restore();
  }
});

test('single provider: uses the first provider that is actually configured (skips one without a key)', async () => {
  try {
    configure({ failover: false });
    config.providers.groq = { ...config.providers.groq, apiKeys: [] }; // groq has no key
    const calls = [];
    claude.generate = async () => { calls.push('claude'); return GOOD_JSON; };
    groq.generate = async () => { calls.push('groq'); return GOOD_JSON; };

    await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['claude']);
  } finally {
    restore();
  }
});

test('single provider: no provider configured at all -> a clear 503, no calls', async () => {
  try {
    configure({ failover: false });
    config.providers.groq = { ...config.providers.groq, apiKeys: [] };
    config.providers.claude = { ...config.providers.claude, apiKeys: [] };

    await assert.rejects(
      () => gateway.generateInsight('weekly_resource_digest', 'prompt'),
      (err) => err.statusCode === 503 && /none configured/.test(err.message)
    );
  } finally {
    restore();
  }
});
