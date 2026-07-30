'use strict';

const { generateChatCompletion } = require('./shared/openAiCompatible');

/**
 * OpenRouter provider — OpenAI-compatible chat completions API.
 * OpenRouter recommends (not required) identifying the calling app via
 * HTTP-Referer / X-Title headers, both configurable without a code change.
 *
 * @param {string} prompt
 * @param {object} opts - { apiKey, model, baseUrl, timeoutMs, maxTokens }
 * @returns {Promise<string>} raw text output
 */
async function generate(prompt, opts) {
  return generateChatCompletion('openrouter', prompt, {
    ...opts,
    extraHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://rut-portal.internal',
      'X-Title': process.env.OPENROUTER_SITE_NAME || 'RUT Portal AI Insights',
    },
  });
}

module.exports = { name: 'openrouter', generate };
