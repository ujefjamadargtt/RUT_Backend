'use strict';

const { postJson } = require('./httpClient');

/**
 * Google Gemini provider — Generative Language API.
 * The API key is passed as a query parameter (Google's documented auth
 * method for this API), not a header.
 *
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens }
 * @returns {Promise<string>} raw text output
 */
async function generate(prompt, opts) {
  const { apiKey, model, baseUrl, timeoutMs, maxTokens } = opts;

  if (!apiKey) {
    const err = new Error('gemini: no API key provided for this attempt.');
    err.statusCode = 401;
    throw err;
  }

  const url = `${baseUrl}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await postJson(url, {
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    timeoutMs,
  });

  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    const err = new Error(
      `gemini model "${model}" returned no text content${finishReason ? ` (finishReason: ${finishReason})` : ''}.`
    );
    err.statusCode = 502;
    throw err;
  }
  return text;
}

module.exports = { name: 'gemini', generate };
