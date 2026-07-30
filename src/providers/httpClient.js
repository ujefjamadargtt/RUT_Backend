'use strict';

/**
 * Shared HTTP helper for every AI provider — a thin wrapper over the native
 * fetch API that adds a timeout and normalizes failures into a single Error
 * shape (statusCode / isTimeout / isNetworkError) that errorClassifier.js
 * knows how to read.
 *
 * @param {string} url
 * @param {object} opts
 * @param {object} [opts.headers]
 * @param {object} opts.body   - JSON-serializable request body
 * @param {number} opts.timeoutMs
 * @returns {Promise<object>} parsed JSON response body
 * @throws {Error} statusCode set for non-2xx responses; isTimeout/isNetworkError for transport failures
 */
async function postJson(url, { headers = {}, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err.name === 'AbortError';
    const wrapped = new Error(
      isAbort ? `Request timed out after ${timeoutMs}ms` : `Network error: ${err.message}`
    );
    wrapped.isTimeout = isAbort;
    wrapped.isNetworkError = !isAbort;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || text || res.statusText;
    const err = new Error(`HTTP ${res.status}: ${message}`);
    err.statusCode = res.status;
    err.responseBody = data;
    throw err;
  }

  return data;
}

module.exports = { postJson };
