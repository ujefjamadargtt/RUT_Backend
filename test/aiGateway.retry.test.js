'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/aiProviders.config');
const groq = require('../src/providers/groq.provider');
const claude = require('../src/providers/claude.provider');
const gemini = require('../src/providers/gemini.provider');
const gateway = require('../src/providers/gateway.provider');
const httpClient = require('../src/providers/httpClient');

/**
 * Gateway resilience, on the SAME provider only (it never switches provider):
 *   - a transient failure (503 "high demand", a short per-minute rate limit) is retried on the same model;
 *   - a reply that is not valid JSON is asked for again;
 *   - Gemini is asked for JSON directly.
 * Seen in a real run: gemini returned `"findings": [ ... }` (array closed with a brace) and a 503, and each
 * of those lost a whole insight.
 */

const GOOD = JSON.stringify({ title: 'T', severity: 'info', summary: 'S', findings: [], actions: [], audience_roles: [] });
const BAD_JSON = '```json\n{ "title": "T", "findings": [ "a", "b" },\n "actions": [] }\n```'; // the slip from the real run

const ORIGINAL = {
  priority: config.providerPriority,
  failover: config.failoverAcrossProviders,
  sameModelRetries: config.sameModelRetries,
  retryBaseDelayMs: config.retryBaseDelayMs,
  retryMaxWaitMs: config.retryMaxWaitMs,
  invalidJsonRetries: config.invalidJsonRetries,
  groqCfg: config.providers.groq,
  claudeCfg: config.providers.claude,
  geminiCfg: config.providers.gemini,
  groqGenerate: groq.generate,
  claudeGenerate: claude.generate,
  postJson: httpClient.postJson,
};

function restore() {
  config.providerPriority = ORIGINAL.priority;
  config.failoverAcrossProviders = ORIGINAL.failover;
  config.sameModelRetries = ORIGINAL.sameModelRetries;
  config.retryBaseDelayMs = ORIGINAL.retryBaseDelayMs;
  config.retryMaxWaitMs = ORIGINAL.retryMaxWaitMs;
  config.invalidJsonRetries = ORIGINAL.invalidJsonRetries;
  config.providers.groq = ORIGINAL.groqCfg;
  config.providers.claude = ORIGINAL.claudeCfg;
  config.providers.gemini = ORIGINAL.geminiCfg;
  groq.generate = ORIGINAL.groqGenerate;
  claude.generate = ORIGINAL.claudeGenerate;
}

function setup({ models = ['m1', 'm2'], failover = false } = {}) {
  config.providerPriority = ['groq', 'claude'];
  config.failoverAcrossProviders = failover;
  config.sameModelRetries = 2;
  config.retryBaseDelayMs = 1; // no real waiting in tests
  config.retryMaxWaitMs = 8000;
  config.invalidJsonRetries = 2;
  config.providers.groq = { ...ORIGINAL.groqCfg, apiKeys: ['k1'], models };
  config.providers.claude = { ...ORIGINAL.claudeCfg, apiKeys: ['c1'], models: ['c-model'] };
}

function httpError(status, message) {
  const err = new Error(`HTTP ${status}: ${message}`);
  err.statusCode = status;
  return err;
}

// ── transient failures: ask the same model again ────────────────────────────

test('503 "high demand": the same model is asked again and the second answer is used', async () => {
  try {
    setup();
    const calls = [];
    groq.generate = async (_p, opts) => {
      calls.push(opts.model);
      if (calls.length === 1) throw httpError(503, 'This model is currently experiencing high demand.');
      return GOOD;
    };

    const result = await gateway.generateInsight('weekly_resource_digest', 'prompt');

    assert.deepEqual(calls, ['m1', 'm1']); // same model twice, the next model never needed
    assert.equal(result.title, 'T');
  } finally {
    restore();
  }
});

test('a short per-minute rate limit ("try again in 674ms") is waited for; a long one ("5m55s") is not', async () => {
  try {
    setup();
    const calls = [];
    groq.generate = async (_p, opts) => {
      calls.push(opts.model);
      if (calls.length === 1) throw httpError(429, 'Rate limit reached on tokens per minute (TPM): Limit 8000. Please try again in 12ms.');
      return GOOD;
    };
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(calls, ['m1', 'm1']);

    // a daily limit says minutes: no point waiting, go straight to the next model
    calls.length = 0;
    groq.generate = async (_p, opts) => {
      calls.push(opts.model);
      if (opts.model === 'm1') throw httpError(429, 'Rate limit reached on tokens per day (TPD). Please try again in 5m55.536s.');
      return GOOD;
    };
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(calls, ['m1', 'm2']);

    // a wait above the cap is not waited for either
    config.retryMaxWaitMs = 1000;
    calls.length = 0;
    groq.generate = async (_p, opts) => {
      calls.push(opts.model);
      if (opts.model === 'm1') throw httpError(429, 'Please try again in 3.5s.');
      return GOOD;
    };
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(calls, ['m1', 'm2']);
  } finally {
    restore();
  }
});

test('retries are limited: after AI_SAME_MODEL_RETRIES the next model is tried; with 0 it moves on at once', async () => {
  try {
    setup();
    const calls = [];
    groq.generate = async (_p, opts) => {
      calls.push(opts.model);
      if (opts.model === 'm1') throw httpError(503, 'overloaded');
      return GOOD;
    };
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(calls, ['m1', 'm1', 'm1', 'm2']); // 1 try + 2 retries, then the next model

    config.sameModelRetries = 0;
    calls.length = 0;
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(calls, ['m1', 'm2']);
  } finally {
    restore();
  }
});

test('non-transient errors are not retried on the same model (auth / bad request abort; a timeout moves on)', async () => {
  try {
    setup();
    let calls = 0;
    groq.generate = async () => { calls += 1; throw httpError(401, 'bad key'); };
    await assert.rejects(() => gateway.generateInsight('weekly_resource_digest', 'prompt'), /HTTP 401/);
    assert.equal(calls, 1);

    const seen = [];
    groq.generate = async (_p, opts) => {
      seen.push(opts.model);
      if (opts.model === 'm1') { const e = new Error('Request timed out after 60000ms'); e.isTimeout = true; throw e; }
      return GOOD;
    };
    await gateway.generateInsight('weekly_resource_digest', 'prompt');
    assert.deepEqual(seen, ['m1', 'm2']); // a timeout already cost the whole timeout: not repeated
  } finally {
    restore();
  }
});

test('retrying never leaves the provider: with failover off the next provider is not called even when retries run out', async () => {
  try {
    setup({ models: ['m1'] });
    let claudeCalled = false;
    groq.generate = async () => { throw httpError(503, 'overloaded'); };
    claude.generate = async () => { claudeCalled = true; return GOOD; };

    await assert.rejects(
      () => gateway.generateInsight('weekly_resource_digest', 'prompt'),
      (err) => err.statusCode === 503 && /AI_PROVIDER_FAILOVER is off/.test(err.message)
    );
    assert.equal(claudeCalled, false);
  } finally {
    restore();
  }
});

// ── invalid JSON: ask again ─────────────────────────────────────────────────

test('invalid JSON (the real "array closed with a brace" slip) is asked for again and the valid reply is used', async () => {
  try {
    setup();
    const replies = [BAD_JSON, GOOD];
    let calls = 0;
    groq.generate = async () => { calls += 1; return replies.shift(); };

    const result = await gateway.generateInsight('utilization_anomaly', 'prompt');

    assert.equal(calls, 2);
    assert.equal(result.title, 'T');
  } finally {
    restore();
  }
});

test('invalid JSON every time: stops after the configured retries with a clear 502 (provider and model on the error)', async () => {
  try {
    setup();
    let calls = 0;
    groq.generate = async () => { calls += 1; return BAD_JSON; };

    await assert.rejects(
      () => gateway.generateInsight('utilization_anomaly', 'prompt'),
      (err) => err.statusCode === 502 && err.provider === 'groq' && /did not return valid JSON/.test(err.message)
    );
    assert.equal(calls, 3); // 1 + invalidJsonRetries (2)

    config.invalidJsonRetries = 0;
    calls = 0;
    await assert.rejects(() => gateway.generateInsight('utilization_anomaly', 'prompt'), /did not return valid JSON/);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('invalid JSON retries stay on the same provider (failover off: the other provider is never asked)', async () => {
  try {
    setup();
    let claudeCalled = false;
    groq.generate = async () => BAD_JSON;
    claude.generate = async () => { claudeCalled = true; return GOOD; };

    await assert.rejects(() => gateway.generateInsight('utilization_anomaly', 'prompt'), /valid JSON/);
    assert.equal(claudeCalled, false);
  } finally {
    restore();
  }
});

// ── Gemini JSON mode ────────────────────────────────────────────────────────

test('gemini: the request asks for JSON directly (responseMimeType)', async () => {
  try {
    let body;
    httpClient.postJson = async (_url, opts) => {
      body = opts.body;
      return { candidates: [{ content: { parts: [{ text: GOOD }] } }] };
    };
    // gemini.provider holds its own reference to postJson, so go through a fresh load with the stub in place
    delete require.cache[require.resolve('../src/providers/gemini.provider')];
    const freshGemini = require('../src/providers/gemini.provider');

    const text = await freshGemini.generate('hello', { apiKey: 'k', model: 'gemini-2.5-flash', baseUrl: 'https://example.test/models', timeoutMs: 1000, maxTokens: 123 });

    assert.equal(text, GOOD);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 123);
  } finally {
    httpClient.postJson = ORIGINAL.postJson;
    delete require.cache[require.resolve('../src/providers/gemini.provider')];
    require('../src/providers/gemini.provider');
  }
});
