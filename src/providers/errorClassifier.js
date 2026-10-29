'use strict';

/**
 * Classifies a provider-call error as retryable (switch model/key/provider)
 * or not (abort and throw a meaningful error), per the AI Gateway's failover
 * policy.
 *
 * Retryable:     429, 500, 502, 503, 504, 529 (provider-overloaded), timeout, 404 model-not-found,
 *                network error, rate limit / quota / overloaded wording.
 * Non-retryable: invalid request (400/422), auth errors (401/403), explicit
 *                json-parse / programming-error flags, anything unclassified.
 */

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_MESSAGE_PATTERN = /rate.?limit|quota|overloaded|too many requests/i;
// Groq/OpenAI: "The model `x` does not exist or you do not have access to it."
// Gemini: "models/x is not found for API version ...". Anthropic: "model: x".
const MODEL_UNAVAILABLE_PATTERN = /(model|models\/).*(does not exist|not found|no access|not available|unavailable|decommissioned|deprecated)|do(es)? not have access to it|HTTP 404: model:/i;

/**
 * @param {Error} err
 * @returns {{ retryable: boolean, reason: string }}
 */
function classify(err) {
  // Explicit flags always win — lets a provider/gateway module force a
  // classification regardless of whatever statusCode happens to be set.
  if (err.nonRetryable === true) {
    return { retryable: false, reason: err.nonRetryableReason || 'explicit_non_retryable' };
  }
  if (err.forceRetryable === true) {
    return { retryable: true, reason: err.retryableReason || 'explicit_retryable' };
  }

  if (err.isTimeout) return { retryable: true, reason: 'timeout' };
  if (err.isNetworkError) return { retryable: true, reason: 'network_error' };

  const status = err.statusCode;

  // A model that doesn't exist / isn't accessible on this key is a problem with THAT
  // model only — move on to the next model/key/provider instead of aborting the whole
  // call. A bare 404 (wrong URL/endpoint) stays non-retryable below.
  if (status === 404 && MODEL_UNAVAILABLE_PATTERN.test(err.message || '')) {
    return { retryable: true, reason: 'model_unavailable' };
  }

  if (status === 401 || status === 403) return { retryable: false, reason: 'auth_error' };
  if (status === 400 || status === 422) return { retryable: false, reason: 'invalid_request' };
  if (RETRYABLE_STATUS_CODES.has(status)) return { retryable: true, reason: `http_${status}` };

  if (RETRYABLE_MESSAGE_PATTERN.test(err.message || '')) {
    return { retryable: true, reason: 'rate_limit_or_quota' };
  }

  // Unknown/unclassified errors (e.g. a programming error thrown before any
  // HTTP call was made) default to non-retryable — a bug will not fix itself
  // by switching providers, so fail fast with a meaningful error instead of
  // silently burning through every configured key/model/provider.
  return { retryable: false, reason: 'unclassified' };
}

module.exports = { classify, RETRYABLE_STATUS_CODES };
