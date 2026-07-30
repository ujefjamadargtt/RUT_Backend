'use strict';

/**
 * Classifies a provider-call error as retryable (switch model/key/provider)
 * or not (abort and throw a meaningful error), per the AI Gateway's failover
 * policy.
 *
 * Retryable:     429, 500, 502, 503, 504, 529 (provider-overloaded), timeout,
 *                network error, rate limit / quota / overloaded wording.
 * Non-retryable: invalid request (400/422), auth errors (401/403), explicit
 *                json-parse / programming-error flags, anything unclassified.
 */

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_MESSAGE_PATTERN = /rate.?limit|quota|overloaded|too many requests/i;

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
