'use strict';

const { postJson } = require('./httpClient');

/**
 * Anthropic Claude provider — Messages API (raw HTTP, no SDK dependency).
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens, apiVersion }
 * @returns {Promise<string>} raw text output
 */
async function generate(prompt, opts) {
  const { apiKey, model, baseUrl, timeoutMs, maxTokens, apiVersion } = opts;

  if (!apiKey) {
    const err = new Error('claude: no API key provided for this attempt.');
    err.statusCode = 401;
    throw err;
  }

  const data = await postJson(baseUrl, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': apiVersion || '2023-06-01',
    },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
    timeoutMs,
  });

  if (data.stop_reason === 'refusal') {
    const err = new Error('claude declined to generate this response (safety refusal).');
    err.statusCode = 422; // invalid-request-class — non-retryable, will not succeed on retry
    throw err;
  }

  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text) {
    const err = new Error(`claude model "${model}" returned no text content.`);
    err.statusCode = 502;
    throw err;
  }
  return text;
}

module.exports = { name: 'claude', generate };
