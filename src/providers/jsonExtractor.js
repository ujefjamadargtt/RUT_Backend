'use strict';

/**
 * Pulls the JSON object out of a model's raw text reply. Prompts already ask
 * for JSON only (see utils/promptBuilder.js), but this defensively strips
 * markdown code fences in case a model wraps its output anyway.
 *
 * @param {string} text
 * @returns {object|null} null if no valid JSON object could be found
 */
function extractJson(text) {
  if (!text) return null;

  let candidate = String(text).trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidate = fenced[1].trim();
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

module.exports = { extractJson };
