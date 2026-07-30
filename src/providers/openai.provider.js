'use strict';

const { generateChatCompletion } = require('./shared/openAiCompatible');

/**
 * OpenAI provider — chat completions API.
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens }
 * @returns {Promise<string>} raw text output
 */
async function generate(prompt, opts) {
  return generateChatCompletion('openai', prompt, opts);
}

module.exports = { name: 'openai', generate };
