'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * AI Copilot — questions it could not answer (table ai_copilot_unmatched_questions).
 * Kept so the team can see what people really ask and add the most requested topics.
 * Raw SQL, same convention as the other small append-only repositories.
 */

const MAX_QUESTION_LENGTH = 2000;
const MAX_NORMALIZED_LENGTH = 500;

/**
 * Lower-case, single-spaced, without trailing punctuation — so "Who is on leave?" and
 * "who is  on leave" count as the same question when grouped.
 * @param {string} question
 * @returns {string}
 */
function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?.!,;:]+$/, '')
    .trim()
    .slice(0, MAX_NORMALIZED_LENGTH);
}

/**
 * @param {object} params
 * @param {string} params.question
 * @param {'unmatched'|'unsupported'} params.reason
 * @param {number|null} [params.employeeId]
 * @param {number[]} [params.companyIds] - the Business Units in the asker's reach
 * @returns {Promise<void>}
 */
async function record({ question, reason, employeeId = null, companyIds = [] }) {
  await sequelize.query(
    `INSERT INTO ai_copilot_unmatched_questions (question, question_normalized, reason, employee_id, company_ids)
     VALUES (:question, :normalized, :reason, :employeeId, CAST(:companyIds AS JSONB))`,
    {
      replacements: {
        question: String(question || '').slice(0, MAX_QUESTION_LENGTH),
        normalized: normalizeQuestion(question),
        reason,
        employeeId: Number.isInteger(employeeId) ? employeeId : null,
        companyIds: JSON.stringify(Array.isArray(companyIds) ? companyIds : []),
      },
      type: QueryTypes.INSERT,
    }
  );
}

module.exports = { record, normalizeQuestion };
