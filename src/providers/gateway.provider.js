'use strict';

const config = require('../config/aiProviders.config');
const { normalize } = require('./responseNormalizer');
const { classify } = require('./errorClassifier');
const { extractJson } = require('./jsonExtractor');
const logger = require('../utils/logger');

const providerModules = {
  groq: require('./groq.provider'),
  claude: require('./claude.provider'),
  gemini: require('./gemini.provider'),
  openai: require('./openai.provider'),
  openrouter: require('./openrouter.provider'),
};

/**
 * AI Gateway
 *
 * The single entry point the scheduler and business logic use to reach any
 * AI provider: generateInsight(jobKey, prompt) always resolves to the same
 * normalized shape (see responseNormalizer.js) regardless of which provider,
 * model, or API key actually served the request.
 *
 * Failover flow (exactly as specified):
 *   for each provider in priority order:
 *     for each API key configured for that provider:
 *       for each model configured for that provider:
 *         try it — on a retryable failure, move to the next model;
 *         after all models fail, move to the next key;
 *         after all keys fail, move to the next provider.
 *   A non-retryable failure (invalid prompt, malformed request, programming
 *   error, JSON parse error, auth configuration mistake) aborts immediately
 *   with a meaningful error instead of cycling through the rest.
 */

/**
 * Try every configured model, in order, for a single (provider, key) pair.
 * @throws the last retryable error if every model failed, or immediately
 *   re-throws a non-retryable error.
 */
async function tryModelsForKey({ providerName, providerModule, providerConfig, apiKey, keyIndex, prompt, attempts }) {
  let lastErr = null;

  for (const model of providerConfig.models) {
    logger.info(`AI Gateway: trying ${providerName} — model "${model}" (key #${keyIndex + 1})`);

    try {
      const text = await providerModule.generate(prompt, {
        apiKey,
        model,
        baseUrl: providerConfig.baseUrl,
        apiVersion: providerConfig.apiVersion,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
      });
      attempts.push({ provider: providerName, model, keyIndex, outcome: 'success' });
      return { text, model };
    } catch (err) {
      const { retryable, reason } = classify(err);
      attempts.push({ provider: providerName, model, keyIndex, outcome: 'failed', reason, message: err.message });

      if (!retryable) {
        logger.error(
          `AI Gateway: non-retryable error from ${providerName} model "${model}" (key #${keyIndex + 1}) — aborting (${reason})`,
          { error: err.message }
        );
        err.provider = providerName;
        err.model = model;
        err.keyIndex = keyIndex;
        err.nonRetryableReason = reason;
        throw err;
      }

      logger.warn(
        `AI Gateway: ${providerName} model "${model}" (key #${keyIndex + 1}) failed (${reason}) — switching model`,
        { error: err.message }
      );
      lastErr = err;
    }
  }

  logger.warn(`AI Gateway: all models exhausted for ${providerName} key #${keyIndex + 1} — switching API key`);
  throw lastErr;
}

/**
 * Try every configured API key (each cycling through all models) for one provider.
 * @returns {Promise<{text, model}|null>} null means the provider was skipped
 *   (not configured) rather than attempted and failed.
 */
async function tryProvider({ providerName, prompt, attempts }) {
  const providerConfig = config.providers[providerName];
  const providerModule = providerModules[providerName];

  if (!providerConfig || !providerModule) {
    logger.warn(`AI Gateway: unknown provider "${providerName}" in priority list — skipping`);
    return null;
  }
  if (!providerConfig.apiKeys.length) {
    logger.warn(`AI Gateway: ${providerName} has no configured API key(s) — skipping provider`);
    return null;
  }
  if (!providerConfig.models.length) {
    logger.warn(`AI Gateway: ${providerName} has no configured model(s) — skipping provider`);
    return null;
  }

  logger.info(`AI Gateway: trying provider "${providerName}"`);

  let lastErr = null;
  for (let keyIndex = 0; keyIndex < providerConfig.apiKeys.length; keyIndex += 1) {
    const apiKey = providerConfig.apiKeys[keyIndex];
    try {
      return await tryModelsForKey({ providerName, providerModule, providerConfig, apiKey, keyIndex, prompt, attempts });
    } catch (err) {
      const { retryable } = classify(err);
      if (!retryable) throw err; // non-retryable — propagate all the way up, abort the whole call
      lastErr = err;
    }
  }

  logger.warn(`AI Gateway: all API keys exhausted for provider "${providerName}" — switching provider`);
  throw lastErr;
}

/**
 * @param {string} jobKey - identifies the insight job (e.g. "weekly_resource_digest")
 * @param {string} prompt - fully-built prompt (see utils/promptBuilder.js) — unchanged by this layer
 * @returns {Promise<object>} normalized insight object — always the same shape, never null
 * @throws {Error} with a statusCode: 422 for invalid input, otherwise whatever
 *   the terminating provider/aggregate failure carries (401/403/502/503/etc.)
 */
async function generateInsight(jobKey, prompt) {
  if (!jobKey || typeof jobKey !== 'string') {
    const err = new Error('A non-empty jobKey string is required.');
    err.statusCode = 422;
    throw err;
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    const err = new Error('A non-empty prompt string is required.');
    err.statusCode = 422;
    throw err;
  }

  const attempts = [];
  let lastErr = null;

  for (const providerName of config.providerPriority) {
    let result;
    try {
      result = await tryProvider({ providerName, prompt, attempts });
    } catch (err) {
      const { retryable } = classify(err);
      if (!retryable) throw err; // invalid request / auth config / programming error — fail fast, no fallback
      lastErr = err;
      continue; // retryable — move to next provider in priority order
    }

    if (!result) continue; // provider skipped (not configured)

    const parsed = extractJson(result.text);
    if (!parsed) {
      const err = new Error(`${providerName} model "${result.model}" did not return valid JSON.`);
      err.statusCode = 502;
      err.provider = providerName;
      err.model = result.model;
      logger.error('AI Gateway: JSON parse error — aborting (non-retryable per policy)', {
        provider: providerName,
        model: result.model,
      });
      throw err; // JSON parsing errors are non-retryable — abort immediately, no fallback
    }

    logger.info(`AI Gateway: success via ${providerName} model "${result.model}"`, {
      provider: providerName,
      model: result.model,
      totalAttempts: attempts.length,
    });
    return normalize(jobKey, parsed);
  }

  const summary = attempts
    .map((a) => `${a.provider}:${a.model} key#${a.keyIndex + 1} -> ${a.outcome}${a.reason ? ` (${a.reason})` : ''}`)
    .join('; ');
  const finalErr = new Error(`All configured AI providers failed. Attempts: ${summary || 'none configured'}.`);
  finalErr.statusCode = 503;
  finalErr.attempts = attempts;
  if (lastErr) finalErr.cause = lastErr;
  logger.error('AI Gateway: all providers exhausted', { attempts });
  throw finalErr;
}

module.exports = { generateInsight };
