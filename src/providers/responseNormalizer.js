'use strict';

/**
 * Response Normalizer
 *
 * Every provider (Groq, Claude, Gemini, OpenAI, OpenRouter) returns JSON in
 * its own shape, and models sometimes drop or misname a field even when the
 * prompt asks for an exact schema. This is the single place that guarantees
 * every caller of the AI Gateway — scheduler, controllers, APIs — always
 * receives exactly the same object shape, with sensible defaults for
 * anything missing. Never returns null, never omits a field, never renames one.
 */

const ALLOWED_SEVERITIES = ['critical', 'warning', 'info'];

/**
 * @param {string} jobKey  - fallback if the AI response omits job_key
 * @param {object} raw     - parsed JSON from the AI provider (already run through jsonExtractor)
 * @returns {{
 *   job_key: string, title: string, severity: 'critical'|'warning'|'info',
 *   summary: string, findings: string[], actions: string[],
 *   audience_roles: string[], generated_at: string
 * }}
 */
function normalize(jobKey, raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    job_key: typeof r.job_key === 'string' && r.job_key.trim() ? r.job_key : jobKey,
    title: typeof r.title === 'string' ? r.title : '',
    severity: ALLOWED_SEVERITIES.includes(r.severity) ? r.severity : 'info',
    summary: typeof r.summary === 'string' ? r.summary : '',
    findings: Array.isArray(r.findings) ? r.findings : [],
    actions: Array.isArray(r.actions) ? r.actions : [],
    audience_roles: Array.isArray(r.audience_roles) ? r.audience_roles : [],
    generated_at: new Date().toISOString(),
  };
}

module.exports = { normalize, ALLOWED_SEVERITIES };
