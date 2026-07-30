'use strict';

const aiInsightRepo = require('../repositories/aiInsightRepository');
const aiInsightJobRepo = require('../repositories/aiInsightJobRepository');
const aiInsightDataRepo = require('../repositories/aiInsightDataRepository');
const aiGateway = require('../providers/gateway.provider');
const promptBuilder = require('../utils/promptBuilder');
const logger = require('../utils/logger');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

/**
 * AI Insight Service
 *
 * Engine flow: collect summarized data -> build prompt -> call the AI Gateway
 * (providers/gateway.provider.js, which transparently fails over across
 * providers/keys/models) -> parse structured JSON -> store insight. runJob()
 * is the single place this flow happens; both the scheduler
 * (scheduler/aiInsight.scheduler.js) and the on-demand API endpoints
 * (POST /run/:jobKey, POST /run-all) call it, so there is exactly one
 * execution path per job.
 */

const ALLOWED_SEVERITIES = ['critical', 'warning', 'info'];

/**
 * Maps each job_key to its data collector. new_po_staffing_suggestion is
 * the only one that needs a context (the newly-created PO's id).
 */
const DATA_COLLECTORS = {
  weekly_resource_digest: (context, companyId) => aiInsightDataRepo.getWeeklyResourceDigestData(companyId),
  po_ending_alerts: (context, companyId) => aiInsightDataRepo.getPoEndingAlertsData(companyId),
  bench_escalation: (context, companyId) => aiInsightDataRepo.getBenchEscalationData(companyId),
  sole_contributor_risk: (context, companyId) => aiInsightDataRepo.getSoleContributorRiskData(companyId),
  timesheet_compliance: (context, companyId) => aiInsightDataRepo.getTimesheetComplianceData(companyId),
  monthly_cost_commentary: (context, companyId) => aiInsightDataRepo.getMonthlyCostCommentaryData(companyId),
  client_concentration: (context, companyId) => aiInsightDataRepo.getClientConcentrationData(companyId),
  utilization_anomaly: (context, companyId) => aiInsightDataRepo.getUtilizationAnomalyData(companyId),
  quarter_end_review: (context, companyId) => aiInsightDataRepo.getQuarterEndReviewData(companyId),
  new_po_staffing_suggestion: (context, companyId) => aiInsightDataRepo.getNewPoStaffingSuggestionData(context.referenceId, companyId),
};

/**
 * Coerce the AI Gateway's normalized response into the shape ai_insights
 * expects, falling back to safe defaults for any missing/invalid field
 * rather than rejecting the whole insight over a minor formatting slip.
 */
function normalizeAiResponse(jobKey, job, aiResponse) {
  const severity = ALLOWED_SEVERITIES.includes(aiResponse?.severity) ? aiResponse.severity : 'info';
  const audienceRoles = Array.isArray(aiResponse?.audience_roles) && aiResponse.audience_roles.length > 0
    ? aiResponse.audience_roles
    : job.audience_roles;

  return {
    title: aiResponse?.title || job.title,
    severity,
    summary: typeof aiResponse?.summary === 'string' ? aiResponse.summary : '',
    findings: Array.isArray(aiResponse?.findings) ? aiResponse.findings : [],
    actions: Array.isArray(aiResponse?.actions) ? aiResponse.actions : [],
    audience_roles: audienceRoles,
  };
}

/**
 * Run a single AI Insight job end-to-end: collect data -> build prompt ->
 * call Claude -> store the insight. Records the outcome on the job
 * configuration row regardless of success/failure.
 *
 * @param {string} jobKey
 * @param {object} [context] - { referenceId } — required for new_po_staffing_suggestion
 * @param {number} companyId - the company this run is scoped to (req.companyId)
 * @returns {Promise<object|null>} the created insight row, or null if the
 *   job had nothing to report on (e.g. the referenced PO no longer exists)
 */
async function runJob(jobKey, context = {}, companyId) {
  const job = await aiInsightJobRepo.findByKey(jobKey);
  if (!job) {
    const err = new Error(`Unknown AI insight job_key "${jobKey}".`);
    err.statusCode = 404;
    throw err;
  }

  const collector = DATA_COLLECTORS[jobKey];
  if (!collector) {
    const err = new Error(`No data collector registered for job_key "${jobKey}".`);
    err.statusCode = 500;
    throw err;
  }

  if (jobKey === 'new_po_staffing_suggestion' && !context.referenceId) {
    const err = new Error('new_po_staffing_suggestion requires a referenceId (service_po_id).');
    err.statusCode = 422;
    throw err;
  }

  const runAt = new Date();
  logger.info('AI Insight job started', { jobKey, context, companyId });

  try {
    const data = await collector(context, companyId);

    if (data === null || data === undefined) {
      logger.warn('AI Insight job produced no data — skipping generation', { jobKey, context, companyId });
      await aiInsightJobRepo.recordRunResult(jobKey, { status: 'success', runAt });
      return null;
    }

    const prompt = promptBuilder.buildPrompt(jobKey, data, job.audience_roles);
    const aiResponse = await aiGateway.generateInsight(jobKey, prompt);
    const normalized = normalizeAiResponse(jobKey, job, aiResponse);

    const insight = await aiInsightRepo.create({
      company_id: companyId,
      job_id: job.id,
      job_key: jobKey,
      reference_id: context.referenceId || null,
      title: normalized.title,
      severity: normalized.severity,
      summary: normalized.summary,
      findings: normalized.findings,
      actions: normalized.actions,
      audience_roles: normalized.audience_roles,
      ai_response: aiResponse,
      generated_at: runAt,
      status: 'completed',
    });

    await aiInsightJobRepo.recordRunResult(jobKey, { status: 'success', runAt });
    logger.info('AI Insight generated', { jobKey, insightId: insight.id, severity: normalized.severity, companyId });
    return insight;
  } catch (err) {
    await aiInsightJobRepo.recordRunResult(jobKey, { status: 'failed', error: err.message, runAt });
    logger.error('AI Insight job failed', { jobKey, error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Run every non-event-driven job once, regardless of its schedule. Used by
 * POST /ai-insights/run-all. Event-driven jobs (new_po_staffing_suggestion)
 * are excluded since they require a specific reference (a PO id) that
 * doesn't exist outside their triggering event.
 *
 * @param {number} companyId
 * @returns {Promise<{ job_key: string, status: 'success'|'failed'|'skipped', error?: string }[]>}
 */
async function runAllJobs(companyId) {
  const jobs = await aiInsightJobRepo.findAll();
  const runnable = jobs.filter((job) => job.frequency !== 'event');

  const settled = await Promise.allSettled(runnable.map((job) => runJob(job.job_key, {}, companyId)));

  return runnable.map((job, i) => {
    const result = settled[i];
    if (result.status === 'rejected') {
      return { job_key: job.job_key, status: 'failed', error: result.reason.message };
    }
    return { job_key: job.job_key, status: result.value === null ? 'skipped' : 'success' };
  });
}

function parseBoolQueryParam(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function buildListFilters(query) {
  return {
    jobKey: query.job_key || undefined,
    severity: query.severity || undefined,
    isRead: parseBoolQueryParam(query.is_read),
    includeDismissed: query.include_dismissed === 'true',
  };
}

/**
 * @param {object} query - req.query
 * @param {number} companyId
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getAllInsights(query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const { rows, count } = await aiInsightRepo.findAll({ ...buildListFilters(query), limit, offset, companyId });
  return { data: rows, meta: getPaginationMeta(count, page, limit) };
}

/**
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<object>}
 */
async function getInsightById(id, companyId) {
  const insight = await aiInsightRepo.findById(id, companyId);
  if (!insight) {
    const err = new Error('Insight not found.');
    err.statusCode = 404;
    throw err;
  }
  return insight;
}

/**
 * @param {string[]} roles - the logged-in user's role names
 * @param {object} query - req.query
 * @param {number} companyId
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getInsightsByRoles(roles, query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const { rows, count } = await aiInsightRepo.findByRoles(roles, { ...buildListFilters(query), limit, offset, companyId });
  return { data: rows, meta: getPaginationMeta(count, page, limit) };
}

/**
 * @param {string[]} roles - the logged-in user's role names
 * @param {object} query - req.query
 * @param {number} companyId
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getUnreadInsights(roles, query, companyId) {
  const { page, limit, offset } = getPaginationParams(query);
  const filters = { ...buildListFilters(query), isRead: false, limit, offset, companyId };
  const { rows, count } = await aiInsightRepo.findByRoles(roles, filters);
  return { data: rows, meta: getPaginationMeta(count, page, limit) };
}

/**
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<object>}
 */
async function markAsRead(id, companyId) {
  const insight = await getInsightById(id, companyId);
  if (!insight.is_read) {
    await aiInsightRepo.markAsRead(id, companyId);
  }
  return getInsightById(id, companyId);
}

/**
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<object>}
 */
async function dismissInsight(id, companyId) {
  await getInsightById(id, companyId);
  await aiInsightRepo.dismiss(id, companyId);
  return getInsightById(id, companyId);
}

module.exports = {
  runJob,
  runAllJobs,
  getAllInsights,
  getInsightById,
  getInsightsByRoles,
  getUnreadInsights,
  markAsRead,
  dismissInsight,
};
