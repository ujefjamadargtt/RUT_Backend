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
 *   Only ONE provider is used unless AI_PROVIDER_FAILOVER=true: the first provider in
 *   AI_PROVIDER_PRIORITY that has a key and a model configured. If it fails, the call fails —
 *   no other provider is tried, so a broken/unfunded provider further down the list can never
 *   cause an error. With AI_PROVIDER_FAILOVER=true the flow below continues across providers:
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Failures that usually clear in a moment: waiting briefly and asking the same model again is cheaper (and
// keeps the answer on the same provider) than giving the model up. A timeout is not retried: it already cost
// the full timeout and would only multiply it.
const TRANSIENT_REASONS = new Set(['http_500', 'http_502', 'http_503', 'http_504', 'http_529', 'network_error']);

/**
 * How long to wait before asking the same model again, or null to move on to the next model.
 * @param {Error} err
 * @param {string} reason - from errorClassifier.classify()
 * @param {number} attempt - 0 for the first retry
 * @returns {number|null} milliseconds
 */
function getRetryDelayMs(err, reason, attempt) {
  if (TRANSIENT_REASONS.has(reason)) return config.retryBaseDelayMs * 2 ** attempt;

  if (reason === 'http_429' || reason === 'rate_limit_or_quota') {
    // "Please try again in 674.999999ms" / "in 3.87s" — a per-minute limit that clears almost at once.
    // A per-day limit says minutes ("in 5m55s"), which is far above the cap, so it is never waited for.
    const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(err.message || '');
    if (match) {
      const waitMs = parseFloat(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
      if (Number.isFinite(waitMs) && waitMs <= config.retryMaxWaitMs) return Math.ceil(waitMs) + 250;
    }
  }
  return null;
}

/**
 * Try every configured model, in order, for a single (provider, key) pair.
 * @throws the last retryable error if every model failed, or immediately
 *   re-throws a non-retryable error.
 */
async function tryModelsForKey({ providerName, providerModule, providerConfig, apiKey, keyIndex, prompt, attempts }) {
  let lastErr = null;

  for (const model of providerConfig.models) {
    for (let attempt = 0; ; attempt += 1) {
      logger.info(`AI Gateway: trying ${providerName} — model "${model}" (key #${keyIndex + 1})${attempt > 0 ? ` — retry ${attempt}` : ''}`);

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

        const delayMs = attempt < config.sameModelRetries ? getRetryDelayMs(err, reason, attempt) : null;
        if (delayMs !== null) {
          logger.warn(
            `AI Gateway: ${providerName} model "${model}" (key #${keyIndex + 1}) failed (${reason}) — asking the same model again in ${delayMs}ms`,
            { error: err.message }
          );
          await sleep(delayMs);
          continue;
        }

        logger.warn(
          `AI Gateway: ${providerName} model "${model}" (key #${keyIndex + 1}) failed (${reason}) — switching model`,
          { error: err.message }
        );
        lastErr = err;
        break; // next model
      }
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
 * The providers this call may use, in order: just the first usable one (a provider that is known,
 * has an API key and a model) unless cross-provider failover is on, in which case the whole
 * priority list.
 * @returns {string[]}
 */
function providersToUse() {
  if (config.failoverAcrossProviders) return config.providerPriority;

  const first = config.providerPriority.find((name) => {
    const providerConfig = config.providers[name];
    return providerConfig && providerModules[name] && providerConfig.apiKeys.length > 0 && providerConfig.models.length > 0;
  });
  return first ? [first] : [];
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

  const candidates = providersToUse();

  for (const providerName of candidates) {
    let result;
    let parsed = null;
    let providerSkipped = false;
    let providerFailed = false;

    for (let jsonAttempt = 0; ; jsonAttempt += 1) {
      try {
        result = await tryProvider({ providerName, prompt, attempts });
      } catch (err) {
        const { retryable } = classify(err);
        if (!retryable) throw err; // invalid request / auth config / programming error — fail fast, no fallback
        lastErr = err;
        providerFailed = true; // retryable — move to next provider in priority order
        break;
      }

      if (!result) {
        providerSkipped = true; // provider skipped (not configured)
        break;
      }

      parsed = extractJson(result.text);
      if (parsed) break;

      // The reply came back but is not valid JSON (a one-character slip is enough). Ask the same provider again
      // a couple of times — a fresh reply is almost always valid — before giving up.
      attempts.push({ provider: providerName, model: result.model, keyIndex: 0, outcome: 'failed', reason: 'invalid_json' });
      if (jsonAttempt >= config.invalidJsonRetries) {
        const err = new Error(`${providerName} model "${result.model}" did not return valid JSON.`);
        err.statusCode = 502;
        err.provider = providerName;
        err.model = result.model;
        logger.error('AI Gateway: JSON parse error — retries used up, aborting', {
          provider: providerName,
          model: result.model,
          attempts: jsonAttempt + 1,
        });
        throw err;
      }
      logger.warn(`AI Gateway: ${providerName} model "${result.model}" did not return valid JSON — asking again`, {
        retry: jsonAttempt + 1,
        of: config.invalidJsonRetries,
      });
    }

    if (providerFailed || providerSkipped) continue;

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
  const finalErr = new Error(
    config.failoverAcrossProviders
      ? `All configured AI providers failed. Attempts: ${summary || 'none configured'}.`
      : `AI provider "${candidates[0] || 'none configured'}" failed (other providers are not tried — AI_PROVIDER_FAILOVER is off). Attempts: ${summary || 'none configured'}.`
  );
  finalErr.statusCode = 503;
  finalErr.attempts = attempts;
  if (lastErr) finalErr.cause = lastErr;
  logger.error('AI Gateway: all providers exhausted', { attempts });
  throw finalErr;
}

module.exports = { generateInsight };
