'use strict';

const { postJson } = require('../httpClient');

/**
 * Groq, OpenAI, and OpenRouter all speak the same OpenAI-compatible chat
 * completions wire format — this is the one place that request/response
 * shape is implemented, so groq.provider.js / openai.provider.js /
 * openrouter.provider.js stay thin and provider-specific (base URL, key,
 * optional headers) without duplicating the same JSON shape three times.
 *
 * @param {string} providerName - used only for error messages/logging
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens, extraHeaders }
 * @returns {Promise<string>} raw text content of the model's reply
 */
async function generateChatCompletion(providerName, prompt, opts) {
  const { apiKey, model, baseUrl, timeoutMs, maxTokens, extraHeaders } = opts;

  if (!apiKey) {
    const err = new Error(`${providerName}: no API key provided for this attempt.`);
    err.statusCode = 401;
    throw err;
  }

  const data = await postJson(baseUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
    },
    timeoutMs,
  });

  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error(`${providerName} model "${model}" returned no message content.`);
    err.statusCode = 502;
    throw err;
  }
  return text;
}

module.exports = { generateChatCompletion };
