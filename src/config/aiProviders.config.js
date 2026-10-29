'use strict';

/**
 * Multi-Provider AI Gateway configuration.
 *
 * Nothing here is hardcoded — provider priority, model priority, API keys,
 * and endpoints are all read from environment variables with sane defaults.
 *
 * API keys — numbered so each provider supports multiple keys for failover:
 *   GROQ_API_KEY_1, GROQ_API_KEY_2, GROQ_API_KEY_3, ...
 *   CLAUDE_API_KEY_1, CLAUDE_API_KEY_2, ...
 *   GEMINI_API_KEY_1, ...
 *   OPENAI_API_KEY_1, ...
 *   OPENROUTER_API_KEY_1, ...
 * A bare, unnumbered var (e.g. GROQ_API_KEY) is also accepted and treated as
 * an additional key appended after the numbered ones.
 *
 * Provider order:    AI_PROVIDER_PRIORITY=groq,claude,gemini,openai,openrouter
 * Model overrides:   GROQ_MODELS / CLAUDE_MODELS / GEMINI_MODELS / OPENAI_MODELS / OPENROUTER_MODELS
 *                    — comma-separated, tried in order.
 */

/**
 * Collect every `${prefix}_1`, `${prefix}_2`, ... `${prefix}_20` env var that
 * is set, in order, plus a trailing bare `${prefix}` if present.
 * @param {string} prefix
 * @returns {string[]}
 */
function collectApiKeys(prefix) {
  const keys = [];
  for (let i = 1; i <= 20; i += 1) {
    const value = process.env[`${prefix}_${i}`];
    if (value) keys.push(value);
  }
  const bare = process.env[prefix];
  if (bare) keys.push(bare);
  return keys;
}

/**
 * @param {string} envVar - comma-separated override
 * @param {string[]} defaults - used when envVar is not set
 * @returns {string[]}
 */
function collectModels(envVar, defaults) {
  const raw = process.env[envVar];
  if (!raw) return defaults;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : defaults;
}

function parsePriority(envVar, defaults) {
  const raw = process.env[envVar];
  if (!raw) return defaults;
  const parsed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parsed.length > 0 ? parsed : defaults;
}

const DEFAULT_PROVIDER_PRIORITY = ['groq', 'claude', 'gemini', 'openai', 'openrouter'];

const providers = {
  groq: {
    name: 'groq',
    apiKeys: collectApiKeys('GROQ_API_KEY'),
    models: collectModels('GROQ_MODELS', [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ]),
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions',
  },
  claude: {
    name: 'claude',
    apiKeys: collectApiKeys('CLAUDE_API_KEY'),
    models: collectModels('CLAUDE_MODELS', [process.env.CLAUDE_MODEL || 'claude-opus-4-8']),
    baseUrl: process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com/v1/messages',
    apiVersion: process.env.CLAUDE_API_VERSION || '2023-06-01',
  },
  gemini: {
    name: 'gemini',
    apiKeys: collectApiKeys('GEMINI_API_KEY'),
    models: collectModels('GEMINI_MODELS', [process.env.GEMINI_MODEL || 'gemini-2.5-flash']),
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
  },
  openai: {
    name: 'openai',
    apiKeys: collectApiKeys('OPENAI_API_KEY'),
    models: collectModels('OPENAI_MODELS', [process.env.OPENAI_MODEL || 'gpt-4o']),
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
  },
  openrouter: {
    name: 'openrouter',
    apiKeys: collectApiKeys('OPENROUTER_API_KEY'),
    models: collectModels('OPENROUTER_MODELS', [process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini']),
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
  },
};

function parseNonNegativeInt(envVar, defaultValue) {
  const value = parseInt(process.env[envVar], 10);
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}

function parseBoolean(envVar, defaultValue) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
  providerPriority: parsePriority('AI_PROVIDER_PRIORITY', DEFAULT_PROVIDER_PRIORITY),
  // false (default): ONE provider only — the first one in AI_PROVIDER_PRIORITY that has a key and a
  // model configured. If it fails, the call fails; no other provider is tried (keys/models of that
  // same provider are still tried). true: on failure, move on to the next provider in the list.
  // A transient failure (provider overloaded 502/503/504/529, a network error, or a rate limit that says
  // "try again in a few seconds") is retried on the SAME model after a short wait, up to this many times,
  // before moving on to the next model / key. Never switches provider.
  sameModelRetries: parseNonNegativeInt('AI_SAME_MODEL_RETRIES', 2),
  retryBaseDelayMs: parseNonNegativeInt('AI_RETRY_BASE_DELAY_MS', 1500), // 1.5s, then 3s for 5xx / network errors
  retryMaxWaitMs: parseNonNegativeInt('AI_RETRY_MAX_WAIT_MS', 8000), // a rate-limit wait longer than this is not waited for
  // A reply that is not valid JSON is asked for again (same provider/model) this many extra times.
  invalidJsonRetries: parseNonNegativeInt('AI_INVALID_JSON_RETRIES', 2),
  failoverAcrossProviders: parseBoolean('AI_PROVIDER_FAILOVER', false),
  providers,
  maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 4096,
  timeoutMs: parseInt(process.env.AI_TIMEOUT_MS, 10) || 60000,
};
