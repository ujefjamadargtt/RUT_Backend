'use strict';

const { generateChatCompletion } = require('./shared/openAiCompatible');

/**
 * Groq provider — OpenAI-compatible chat completions API.
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens }
 * @returns {Promise<string>} raw text output
 */
async function generate(prompt, opts) {
  return generateChatCompletion('groq', prompt, opts);
}

module.exports = { name: 'groq', generate };
