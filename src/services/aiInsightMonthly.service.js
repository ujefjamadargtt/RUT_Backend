'use strict';

const crypto = require('crypto');
const moment = require('moment-timezone');
const aiInsightRepo = require('../repositories/aiInsightRepository');
const aiInsightJobRepo = require('../repositories/aiInsightJobRepository');
const dataRepo = require('../repositories/aiInsightMonthlyDataRepository');
const companyRepository = require('../repositories/companyRepository');
const aiGateway = require('../providers/gateway.provider');
const promptBuilder = require('../utils/promptBuilder');
const logger = require('../utils/logger');
const { MONTHLY_JOBS } = require('./aiInsightMonthlyJobs');

/**
 * Monthly, sync-gated AI Insights.
 *
 * Every day the scheduler runs each monthly job for the month that just ended (plus up to two earlier months
 * that still have an unfinished tenant report). A report is only built from timesheets that have been synced:
 *
 *   - BU jobs run per Business Unit / Sub-BU as soon as THAT unit is synced for the month.
 *   - Tenant jobs run per Admin tenant. Some build from the units synced so far and name the pending ones
 *     (partial); some wait until every unit is synced (all).
 *   - A later run for the same (scope, month, job) REPLACES the earlier report — never a second one — and does
 *     not call the AI again when the data behind it has not changed (same signature).
 *   - Once every unit is synced and the report is built, nothing more is generated for that month.
 *
 * "Synced" = a completed timesheet import for the unit and month (see aiInsightMonthlyDataRepository.js).
 */

const INSIGHT_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const OPEN_MONTH_LOOKBACK = 2; // besides the month that just ended, retry this many earlier months while unfinished

function toPeriod(m) {
  const start = m.clone().startOf('month');
  return {
    start: start.format('YYYY-MM-DD'),
    end: start.clone().endOf('month').format('YYYY-MM-DD'),
    month: start.month() + 1,
    year: start.year(),
    label: start.format('MMM-YYYY'),
    periodMonth: start.format('YYYY-MM-DD'),
  };
}

/** The calendar month that just ended, in the business timezone. */
function previousMonthPeriod(now) {
  return toPeriod(moment.tz(now || new Date(), INSIGHT_TZ).subtract(1, 'month'));
}

function shiftPeriod(period, months) {
  return toPeriod(moment.tz(period.start, 'YYYY-MM-DD', INSIGHT_TZ).add(months, 'month'));
}

const isQuarterEndMonth = (period) => period.month % 3 === 0;

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

const idName = (u) => ({ id: u.id, name: u.name });

function buildSyncStatus(units, syncedIds) {
  const synced = units.filter((u) => syncedIds.has(u.id));
  const pending = units.filter((u) => !syncedIds.has(u.id));
  return { synced_count: synced.length, total_count: units.length, synced: synced.map(idName), pending: pending.map(idName) };
}

/** Plain-language note put at the top of a report that does not cover every unit yet. */
function pendingNote(period, syncStatus, scope) {
  const names = syncStatus.pending.map((u) => u.name).join(', ');
  if (scope === 'bu') {
    return `Timesheet sync for ${period.label} is still pending for ${names}, so this report does not include its synced data yet. It will update automatically after the sync.`;
  }
  return `Sync pending for ${period.label}: ${names} (${syncStatus.synced_count} of ${syncStatus.total_count} synced). Their data is not included in this report; it will update automatically as they are synced.`;
}

function isAiGatewayFailure(err) {
  return Boolean(err && (err.attempts || err.provider));
}

function isMonthlyJob(jobKey) {
  return Object.prototype.hasOwnProperty.call(MONTHLY_JOBS, jobKey);
}

/** Per-run memo so one job tick never queries the same unit + month twice. */
function makeSnapshotLoader() {
  const memo = new Map();
  return (unit, period) => {
    const key = `${unit.id}:${period.periodMonth}`;
    if (!memo.has(key)) memo.set(key, dataRepo.getBuMonthSnapshot(unit.id, period));
    return memo.get(key);
  };
}

function baseContext(period, snapshotFor) {
  const prevPeriod = shiftPeriod(period, -1);
  return { period, prevPeriod, shiftPeriod, snapshotFor };
}

/** The saved row's content for a "waiting for sync" message (no AI call). */
function placeholderPayload(job, period, syncStatus, scope, now) {
  const names = syncStatus.pending.map((u) => u.name).join(', ');
  return {
    job_id: job.id,
    job_key: job.job_key,
    period_month: period.periodMonth,
    title: `${job.title} — waiting for ${period.label} sync`,
    severity: 'info',
    summary: scope === 'bu'
      ? `The ${period.label} timesheets of ${names} are not synced yet, so no report could be built. It will be generated automatically after the sync.`
      : `${job.title} for ${period.label} needs every Business Unit synced. Pending: ${names} (${syncStatus.synced_count} of ${syncStatus.total_count} synced). It will be generated automatically after the sync.`,
    findings: [pendingNote(period, syncStatus, scope)],
    actions: [`Complete the ${period.label} timesheet sync for ${names}.`],
    audience_roles: job.audience_roles,
    ai_response: null,
    generated_at: now,
    status: 'completed',
    report_state: 'pending_sync',
    sync_status: syncStatus,
  };
}

/**
 * Save a report (placeholder or AI) unless an identical one is already stored.
 * @returns {Promise<object|null>} the saved row, or null when nothing changed
 */
async function saveIfChanged(key, payload, signature, existing) {
  if (existing && existing.data_signature === signature && existing.report_state === payload.report_state) return null;
  return aiInsightRepo.upsertMonthly(key, { ...payload, data_signature: signature });
}

async function generateAndSave({ job, key, period, data, syncStatus, state, scope, existing, now }) {
  const signature = signatureOf({ data, state, sync: syncStatus.pending.map((u) => u.id) });
  if (existing && existing.data_signature === signature && existing.report_state === state) return null;

  const aiInput = state === 'complete' ? data : { ...data, data_coverage: { included_units: syncStatus.synced.map((u) => u.name), pending_sync_units: syncStatus.pending.map((u) => u.name) } };
  const prompt = promptBuilder.buildPrompt(job.job_key, aiInput, job.audience_roles);
  const aiResponse = await aiGateway.generateInsight(job.job_key, prompt);
  // lazy: aiInsight.service requires this module (manual runs), so it cannot be required at load time
  const normalized = require('./aiInsight.service').normalizeAiResponse(job.job_key, job, aiResponse);

  const findings = state === 'complete' ? normalized.findings : [pendingNote(period, syncStatus, scope), ...normalized.findings];
  return saveIfChanged(key, {
    job_id: job.id,
    job_key: job.job_key,
    period_month: period.periodMonth,
    title: normalized.title,
    severity: normalized.severity,
    summary: normalized.summary,
    findings,
    actions: normalized.actions,
    audience_roles: normalized.audience_roles,
    ai_response: aiResponse,
    generated_at: now,
    status: 'completed',
    report_state: state,
    sync_status: syncStatus,
  }, signature, existing);
}

async function processBuUnit({ job, spec, unit, period, syncedIds, snapshotFor, now }) {
  const isSynced = syncedIds.has(unit.id);
  const syncStatus = buildSyncStatus([unit], syncedIds);
  const key = { scopeType: 'bu', companyId: unit.id, periodMonth: period.periodMonth, jobKey: job.job_key };
  const existing = await aiInsightRepo.findMonthly(key);

  if (spec.sync === 'required' && !isSynced) {
    if (!spec.placeholder) return null;
    const payload = placeholderPayload(job, period, syncStatus, 'bu', now);
    return saveIfChanged(key, payload, signatureOf({ placeholder: true, pending: [unit.id] }), existing);
  }

  const ctx = {
    ...baseContext(period, snapshotFor), unit, units: [unit], syncedUnits: isSynced ? [unit] : [],
    snapshot: () => snapshotFor(unit, period),
    prevSnapshot: () => snapshotFor(unit, shiftPeriod(period, -1)),
  };
  const data = await spec.build(ctx);
  if (data === null || data === undefined) return null;
  return generateAndSave({ job, key, period, data, syncStatus, state: isSynced ? 'complete' : 'partial', scope: 'bu', existing, now });
}

async function processTenant({ job, spec, tenantAdminId, units, period, syncedIds, snapshotFor, now }) {
  const syncStatus = buildSyncStatus(units, syncedIds);
  const syncedUnits = units.filter((u) => syncedIds.has(u.id));
  const allSynced = syncStatus.pending.length === 0;
  const key = { scopeType: 'tenant', tenantAdminId, periodMonth: period.periodMonth, jobKey: job.job_key };

  if (spec.sync === 'quarter' && !isQuarterEndMonth(period)) return null;
  if (spec.sync === 'partial' && syncedUnits.length === 0) return null; // the sync health report explains it
  const existing = await aiInsightRepo.findMonthly(key);

  if ((spec.sync === 'all' || spec.sync === 'quarter') && !allSynced) {
    if (spec.sync === 'quarter') return null;
    const payload = placeholderPayload(job, period, syncStatus, 'tenant', now);
    return saveIfChanged(key, payload, signatureOf({ placeholder: true, pending: syncStatus.pending.map((u) => u.id) }), existing);
  }

  const ctx = { ...baseContext(period, snapshotFor), units, syncedUnits };
  const data = await spec.build(ctx);
  if (data === null || data === undefined) return null;
  return generateAndSave({ job, key, period, data, syncStatus, state: allSynced ? 'complete' : 'partial', scope: 'tenant', existing, now });
}

/**
 * Run one monthly job for every tenant (or only the tenant / unit of `companyId` for a manual run).
 *
 * @param {object} job - the ai_insight_jobs row
 * @param {{ companyId?: number|null, now?: Date }} [options]
 * @returns {Promise<{ insights: object[], failed: number }>} rows created or replaced in this run
 */
async function runMonthlyJob(job, { companyId = null, now = new Date() } = {}) {
  const spec = MONTHLY_JOBS[job.job_key];
  const runAt = new Date();
  const insights = [];
  let failed = 0;

  const mainPeriod = previousMonthPeriod(now);
  const openMonths = [];
  for (let back = 1; back <= OPEN_MONTH_LOOKBACK; back += 1) openMonths.push(shiftPeriod(mainPeriod, -back));
  const monthKeys = [mainPeriod, ...openMonths].map((p) => p.periodMonth);

  // A scheduled run first asks ONE small question — is everything already finished? — and, when it is, ends
  // here: no unit / data queries and no AI. (A manual run, with a companyId, always goes through.)
  const scheduled = companyId == null;
  const done = scheduled ? await aiInsightRepo.findDonePeriods(job.job_key, monthKeys) : new Set();
  const openPairs = scheduled ? await aiInsightRepo.findOpenTenantPeriods(monthKeys.slice(1)) : [];
  if (scheduled) {
    const mainDone = [...done].filter((k) => k.endsWith(`|${mainPeriod.periodMonth}`)).length;
    const olderOpen = openPairs.some((p) => !done.has(`${p.tenantAdminId}|${p.periodMonth}`));
    if (!olderOpen && mainDone >= await dataRepo.countTenants()) {
      logger.info('Monthly AI Insight: already complete for every tenant — nothing to do', { jobKey: job.job_key, period: mainPeriod.label });
      return { insights, failed, skipped: true };
    }
  }

  const leafIds = await companyRepository.findInsightLeafCompanyIds();
  const allUnits = await dataRepo.getUnits(leafIds);
  const tenants = new Map();
  allUnits.forEach((u) => {
    if (!tenants.has(u.tenantAdminId)) tenants.set(u.tenantAdminId, []);
    tenants.get(u.tenantAdminId).push(u);
  });

  const snapshotFor = makeSnapshotLoader();

  try {
    for (const [tenantAdminId, units] of tenants) {
      if (companyId != null && !units.some((u) => u.id === companyId)) continue;

      const open = new Set(openPairs.filter((p) => p.tenantAdminId === tenantAdminId).map((p) => p.periodMonth));
      const periods = [mainPeriod, ...openMonths.filter((p) => open.has(p.periodMonth))];

      for (const period of periods) {
        if (scheduled && done.has(`${tenantAdminId}|${period.periodMonth}`)) continue;
        let periodFailed = false;
        const syncedIds = await dataRepo.getSyncedCompanyIds(units.map((u) => u.id), period);
        const targets = spec.scope === 'bu' ? units.filter((u) => companyId == null || u.id === companyId) : [null];

        for (const unit of targets) {
          try {
            const saved = spec.scope === 'bu'
              ? await processBuUnit({ job, spec, unit, period, syncedIds, snapshotFor, now: runAt })
              : await processTenant({ job, spec, tenantAdminId, units, period, syncedIds, snapshotFor, now: runAt });
            if (saved) insights.push(saved);
          } catch (err) {
            failed += 1;
            periodFailed = true;
            logger.error('Monthly AI Insight failed', { jobKey: job.job_key, tenantAdminId, companyId: unit ? unit.id : null, period: period.label, error: err.message });
            if (isAiGatewayFailure(err)) {
              logger.warn('Monthly AI Insight: AI gateway failure — stopping this run, it is retried on the next daily run', { jobKey: job.job_key });
              throw err;
            }
          }
        }

        // every unit synced and this job handled them all: finished for good — never looked at again
        if (scheduled && !periodFailed && units.every((u) => syncedIds.has(u.id))) {
          await aiInsightRepo.markPeriodDone(job.job_key, tenantAdminId, period.periodMonth);
        }
      }
    }
  } catch (err) {
    if (!isAiGatewayFailure(err)) throw err;
  }

  await aiInsightJobRepo.recordRunResult(job.job_key, { status: failed ? 'failed' : 'success', error: failed ? `${failed} unit(s) failed — see logs` : undefined, runAt });
  logger.info('Monthly AI Insight run finished', { jobKey: job.job_key, saved: insights.length, failed });
  return { insights, failed, skipped: false };
}

module.exports = {
  isMonthlyJob,
  runMonthlyJob,
  previousMonthPeriod,
  shiftPeriod,
  buildSyncStatus,
  pendingNote,
  signatureOf,
  isQuarterEndMonth,
};
