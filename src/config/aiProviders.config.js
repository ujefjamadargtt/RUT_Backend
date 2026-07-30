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
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
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

module.exports = {
  providerPriority: parsePriority('AI_PROVIDER_PRIORITY', DEFAULT_PROVIDER_PRIORITY),
  providers,
  maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 4096,
  timeoutMs: parseInt(process.env.AI_TIMEOUT_MS, 10) || 60000,
};
