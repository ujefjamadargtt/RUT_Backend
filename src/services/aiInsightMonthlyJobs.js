'use strict';

const dataRepo = require('../repositories/aiInsightMonthlyDataRepository');

/**
 * The monthly AI Insight jobs: what each one reports and when it may run.
 *
 *   scope  'bu'     one leaf Business Unit / Sub-BU per report (audience: BU Admin)
 *          'tenant' one report for the whole Admin tenant (audience: Admin)
 *   sync   'required'  the BU must be synced for the month (BU jobs)
 *          'none'      runs without a sync (timesheet compliance, sync health)
 *          'partial'   tenant job: builds from the BUs synced so far, notes the pending ones, and is
 *                      replaced as more BUs sync
 *          'all'       tenant job: only when EVERY BU is synced; until then a "waiting for sync" message
 *          'quarter'   like 'all', and only for the last month of a quarter
 *   placeholder  show a "waiting for sync" message while the BU is not synced (one per BU, not per job)
 *
 * build(ctx) returns the summarized data the AI sees (hours only — never cost), or null when there is
 * nothing to report. ctx: { period, unit, units, syncedUnits, snapshot(), prevSnapshot(), snapshotFor(unit, period), prevPeriod, shiftPeriod }.
 */

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : 0);
const top = (list, n) => list.slice(0, n);

function combineTotals(list) {
  const sum = (key) => list.reduce((s, t) => s + (t[key] || 0), 0);
  const capacity = sum('capacity_hours');
  const logged = sum('logged_hours');
  const billable = sum('billable_hours');
  return {
    headcount: sum('headcount'),
    capacity_hours: r1(capacity),
    logged_hours: r1(logged),
    billable_hours: r1(billable),
    non_billable_hours: r1(sum('non_billable_hours')),
    bench_hours: r1(sum('bench_hours')),
    utilization_pct: pct(logged, capacity),
    billable_utilization_pct: pct(billable, capacity),
  };
}

function aggregateClients(snapshots) {
  const byClient = new Map();
  snapshots.forEach((snap, i) => {
    snap.pos.forEach((po) => {
      const row = byClient.get(po.client_name) || { client: po.client_name, hours: 0, units: new Set() };
      row.hours += po.hours;
      if (po.hours > 0) row.units.add(i);
      byClient.set(po.client_name, row);
    });
  });
  return [...byClient.values()].sort((a, b) => b.hours - a.hours);
}

const unitLabel = (unit) => unit.name;

// ── BU-level jobs ───────────────────────────────────────────────────────────

async function buUtilizationSummary(ctx) {
  const snap = await ctx.snapshot();
  const prev = await ctx.prevSnapshot();
  const t = snap.totals;
  if (t.headcount === 0) return null;
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    monthly_cap_hours_per_employee: snap.cap_hours,
    ...t,
    previous_month: prev && prev.totals.headcount > 0 ? { period: ctx.prevPeriod.label, ...prev.totals } : null,
    change_vs_previous_month: prev && prev.totals.headcount > 0 ? {
      utilization_pct_points: r1(t.utilization_pct - prev.totals.utilization_pct),
      billable_utilization_pct_points: r1(t.billable_utilization_pct - prev.totals.billable_utilization_pct),
      logged_hours: r1(t.logged_hours - prev.totals.logged_hours),
      headcount: t.headcount - prev.totals.headcount,
    } : null,
  };
}

async function buUnderUtilised(ctx) {
  const snap = await ctx.snapshot();
  const under = snap.employees.filter((e) => e.utilization_pct < 60).sort((a, b) => a.utilization_pct - b.utilization_pct);
  if (under.length === 0) return null;
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    monthly_cap_hours_per_employee: snap.cap_hours,
    threshold_pct: 60,
    headcount: snap.totals.headcount,
    under_utilised_count: under.length,
    zero_hours_count: under.filter((e) => e.logged_hours === 0).length,
    employees: top(under, 15).map((e) => ({ name: e.name, designation: e.designation, logged_hours: e.logged_hours, utilization_pct: e.utilization_pct })),
  };
}

async function buOverCap(ctx) {
  const snap = await ctx.snapshot();
  const prev = await ctx.prevSnapshot();
  const high = snap.employees.filter((e) => e.utilization_pct >= 90).sort((a, b) => b.utilization_pct - a.utilization_pct);
  if (high.length === 0) return null;
  const prevHigh = new Set((prev ? prev.employees : []).filter((e) => e.utilization_pct >= 90).map((e) => e.employee_id));
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    monthly_cap_hours_per_employee: snap.cap_hours,
    threshold_pct: 90,
    headcount: snap.totals.headcount,
    at_or_above_90_pct_count: high.length,
    above_cap_count: high.filter((e) => e.utilization_pct > 100).length,
    employees: top(high, 15).map((e) => ({
      name: e.name,
      logged_hours: e.logged_hours,
      utilization_pct: e.utilization_pct,
      hours_above_cap: Math.max(0, r1(e.logged_hours - snap.cap_hours)),
      also_at_or_above_90_pct_previous_month: prevHigh.has(e.employee_id),
    })),
  };
}

async function buBenchNonBillable(ctx) {
  const snap = await ctx.snapshot();
  const prev = await ctx.prevSnapshot();
  const t = snap.totals;
  if (t.bench_hours + t.non_billable_hours === 0) return null;
  const prevT = prev && prev.totals.logged_hours > 0 ? prev.totals : null;
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    logged_hours: t.logged_hours,
    bench_hours: t.bench_hours,
    bench_share_of_logged_pct: pct(t.bench_hours, t.logged_hours),
    non_billable_hours: t.non_billable_hours,
    non_billable_share_of_logged_pct: pct(t.non_billable_hours, t.logged_hours),
    previous_month: prevT ? {
      bench_share_of_logged_pct: pct(prevT.bench_hours, prevT.logged_hours),
      non_billable_share_of_logged_pct: pct(prevT.non_billable_hours, prevT.logged_hours),
    } : null,
    top_bench_employees: top(snap.employees.filter((e) => e.bench_hours > 0).sort((a, b) => b.bench_hours - a.bench_hours), 10)
      .map((e) => ({ name: e.name, bench_hours: e.bench_hours, share_of_their_hours_pct: pct(e.bench_hours, e.logged_hours) })),
    top_non_billable_pos: top(snap.pos.filter((p) => !p.is_billable).sort((a, b) => b.hours - a.hours), 5)
      .map((p) => ({ po_name: p.po_name, hours: p.hours })),
  };
}

async function buPoConcentration(ctx) {
  const snap = await ctx.snapshot();
  if (snap.pos.length === 0) return null;
  const totalHours = snap.pos.reduce((s, p) => s + p.hours, 0);
  const risks = await dataRepo.getSoleContributorRiskRows(ctx.period.start, ctx.period.end, ctx.unit.id);
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    total_po_hours: r1(totalHours),
    top_pos: top([...snap.pos].sort((a, b) => b.hours - a.hours), 5)
      .map((p) => ({ po_name: p.po_name, client: p.client_name, hours: p.hours, share_pct: pct(p.hours, totalHours), contributors: p.contributors })),
    sole_contributor_risks: top(risks, 10).map((r) => ({
      po_name: r.service_po_name, client: r.client_name, employee: r.full_name, contribution_pct: r.contribution_pct, po_hours: r.po_total_hours,
    })),
  };
}

async function buClientHours(ctx) {
  const snap = await ctx.snapshot();
  const prev = await ctx.prevSnapshot();
  const clients = aggregateClients([snap]);
  if (clients.length === 0) return null;
  const total = clients.reduce((s, c) => s + c.hours, 0);
  const prevHours = new Map(aggregateClients(prev ? [prev] : []).map((c) => [c.client, c.hours]));
  const rows = top(clients, 5).map((c) => ({
    client: c.client,
    hours: r1(c.hours),
    share_pct: pct(c.hours, total),
    previous_month_hours: prevHours.has(c.client) ? r1(prevHours.get(c.client)) : null,
    change_hours: prevHours.has(c.client) ? r1(c.hours - prevHours.get(c.client)) : null,
  }));
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    total_client_hours: r1(total),
    top_clients: rows,
    top_3_share_pct: r1(rows.slice(0, 3).reduce((s, c) => s + c.share_pct, 0)),
  };
}

async function buTimesheetCompliance(ctx) {
  const data = await dataRepo.getComplianceData(ctx.unit.id, ctx.period);
  if (Object.keys(data.work_logs_by_status).length === 0 && data.employees_without_any_log_count === 0) return null;
  return { period: ctx.period.label, business_unit: unitLabel(ctx.unit), ...data };
}

async function buPoTimelineRisk(ctx) {
  const rows = await dataRepo.getPoTimelineRows(ctx.unit.id, ctx.period);
  if (rows.length === 0) return null;
  const snap = await ctx.snapshot();
  const hoursByPo = new Map(snap.pos.map((p) => [p.service_po_id, p.hours]));
  const shape = (r) => ({
    po_name: r.po_name,
    client: r.client_name,
    end_date: r.end_date,
    hours_logged_in_month: hoursByPo.get(r.service_po_id) || 0,
  });
  const overdue = rows.filter((r) => Number(r.days_past_month_end) >= 0);
  const ending = rows.filter((r) => Number(r.days_past_month_end) < 0);
  return {
    period: ctx.period.label,
    business_unit: unitLabel(ctx.unit),
    measured_at: ctx.period.end,
    overdue_in_progress_pos: top(overdue, 15).map((r) => ({ ...shape(r), days_overdue_at_month_end: Number(r.days_past_month_end) })),
    overdue_count: overdue.length,
    ending_within_30_days_after_month_end: top(ending, 15).map((r) => ({ ...shape(r), days_left_at_month_end: -Number(r.days_past_month_end) })),
    ending_soon_count: ending.length,
  };
}

// ── Tenant-level jobs ───────────────────────────────────────────────────────

async function snapshotsOf(ctx, units, period) {
  return Promise.all(units.map(async (u) => ({ unit: u, snap: await ctx.snapshotFor(u, period) })));
}

async function tenantSummary(ctx) {
  const current = await snapshotsOf(ctx, ctx.syncedUnits, ctx.period);
  const previous = await snapshotsOf(ctx, ctx.syncedUnits, ctx.prevPeriod);
  const totals = combineTotals(current.map((c) => c.snap.totals));
  if (totals.headcount === 0) return null;
  const prevTotals = combineTotals(previous.map((c) => c.snap.totals));
  return {
    period: ctx.period.label,
    ...totals,
    previous_month: prevTotals.headcount > 0 ? { period: ctx.prevPeriod.label, ...prevTotals } : null,
    change_vs_previous_month: prevTotals.headcount > 0 ? {
      utilization_pct_points: r1(totals.utilization_pct - prevTotals.utilization_pct),
      logged_hours: r1(totals.logged_hours - prevTotals.logged_hours),
    } : null,
    business_units: current
      .map((c) => ({ name: c.unit.name, headcount: c.snap.totals.headcount, logged_hours: c.snap.totals.logged_hours, utilization_pct: c.snap.totals.utilization_pct, billable_utilization_pct: c.snap.totals.billable_utilization_pct }))
      .sort((a, b) => b.utilization_pct - a.utilization_pct),
  };
}

async function tenantBuComparison(ctx) {
  const current = await snapshotsOf(ctx, ctx.syncedUnits, ctx.period);
  const rows = current.filter((c) => c.snap.totals.headcount > 0).map((c) => {
    const t = c.snap.totals;
    const cap = c.snap.cap_hours;
    return {
      name: c.unit.name,
      headcount: t.headcount,
      utilization_pct: t.utilization_pct,
      billable_utilization_pct: t.billable_utilization_pct,
      non_billable_share_pct: pct(t.non_billable_hours, t.logged_hours),
      bench_share_pct: pct(t.bench_hours, t.logged_hours),
      under_utilised_employees: c.snap.employees.filter((e) => e.utilization_pct < 60).length,
      employees_at_or_above_90_pct: c.snap.employees.filter((e) => e.utilization_pct >= 90).length,
      spare_capacity_hours: r1(Math.max(0, t.capacity_hours - t.logged_hours)),
      hours_above_cap: r1(c.snap.employees.reduce((s, e) => s + Math.max(0, e.logged_hours - cap), 0)),
    };
  });
  if (rows.length === 0) return null;
  const ranked = [...rows].sort((a, b) => b.utilization_pct - a.utilization_pct);
  return {
    period: ctx.period.label,
    ranking_by_utilization: ranked,
    bus_with_spare_capacity: ranked.filter((r) => r.utilization_pct < 70).map((r) => ({ name: r.name, spare_capacity_hours: r.spare_capacity_hours, under_utilised_employees: r.under_utilised_employees })),
    bus_over_capacity: ranked.filter((r) => r.employees_at_or_above_90_pct > 0).map((r) => ({ name: r.name, employees_at_or_above_90_pct: r.employees_at_or_above_90_pct, hours_above_cap: r.hours_above_cap })),
  };
}

async function tenantClientConcentration(ctx) {
  const current = await snapshotsOf(ctx, ctx.syncedUnits, ctx.period);
  const clients = aggregateClients(current.map((c) => c.snap));
  const total = clients.reduce((s, c) => s + c.hours, 0);
  if (total === 0) return null;
  const previous = await snapshotsOf(ctx, ctx.syncedUnits, ctx.prevPeriod);
  const prevHours = new Map(aggregateClients(previous.map((c) => c.snap)).map((c) => [c.client, c.hours]));
  const rows = top(clients, 5).map((c) => ({
    client: c.client,
    hours: r1(c.hours),
    share_pct: pct(c.hours, total),
    business_units_serving: c.units.size,
    previous_month_hours: prevHours.has(c.client) ? r1(prevHours.get(c.client)) : null,
  }));
  return {
    period: ctx.period.label,
    total_client_hours: r1(total),
    top_clients: rows,
    top_3_share_pct: r1(rows.slice(0, 3).reduce((s, c) => s + c.share_pct, 0)),
  };
}

async function tenantOvertime(ctx) {
  const current = await snapshotsOf(ctx, ctx.syncedUnits, ctx.period);
  const previous = await snapshotsOf(ctx, ctx.syncedUnits, ctx.prevPeriod);
  const prevHigh = new Set(previous.flatMap((c) => c.snap.employees.filter((e) => e.utilization_pct >= 90).map((e) => e.employee_id)));
  const high = current.flatMap((c) => c.snap.employees
    .filter((e) => e.utilization_pct >= 90)
    .map((e) => ({ ...e, bu: c.unit.name, cap: c.snap.cap_hours })));
  if (high.length === 0) return null;
  return {
    period: ctx.period.label,
    employees_at_or_above_90_pct: high.length,
    employees_above_cap: high.filter((e) => e.utilization_pct > 100).length,
    repeat_high_both_months: high.filter((e) => prevHigh.has(e.employee_id)).length,
    by_business_unit: current
      .map((c) => ({ name: c.unit.name, at_or_above_90_pct: c.snap.employees.filter((e) => e.utilization_pct >= 90).length, above_cap: c.snap.employees.filter((e) => e.utilization_pct > 100).length }))
      .filter((b) => b.at_or_above_90_pct > 0)
      .sort((a, b) => b.at_or_above_90_pct - a.at_or_above_90_pct),
    top_employees: top(high.sort((a, b) => b.utilization_pct - a.utilization_pct), 10)
      .map((e) => ({ name: e.name, business_unit: e.bu, logged_hours: e.logged_hours, utilization_pct: e.utilization_pct, also_high_previous_month: prevHigh.has(e.employee_id) })),
  };
}

async function tenantLeakage(ctx) {
  const current = await snapshotsOf(ctx, ctx.syncedUnits, ctx.period);
  const totals = combineTotals(current.map((c) => c.snap.totals));
  if (totals.logged_hours === 0) return null;
  return {
    period: ctx.period.label,
    logged_hours: totals.logged_hours,
    non_billable_hours: totals.non_billable_hours,
    non_billable_share_pct: pct(totals.non_billable_hours, totals.logged_hours),
    bench_hours: totals.bench_hours,
    bench_share_pct: pct(totals.bench_hours, totals.logged_hours),
    by_business_unit: current
      .filter((c) => c.snap.totals.logged_hours > 0)
      .map((c) => ({
        name: c.unit.name,
        non_billable_hours: c.snap.totals.non_billable_hours,
        non_billable_share_pct: pct(c.snap.totals.non_billable_hours, c.snap.totals.logged_hours),
        bench_hours: c.snap.totals.bench_hours,
        bench_share_pct: pct(c.snap.totals.bench_hours, c.snap.totals.logged_hours),
      }))
      .sort((a, b) => b.non_billable_hours - a.non_billable_hours),
  };
}

async function tenantSyncHealth(ctx) {
  const syncedIds = new Set(ctx.syncedUnits.map((u) => u.id));
  const rows = [];
  for (const unit of ctx.units) {
    rows.push({
      name: unit.name,
      timesheet_sync: syncedIds.has(unit.id) ? 'synced' : 'pending',
      pending_approval_logs: await dataRepo.getPendingApprovalCount(unit.id, ctx.period),
    });
  }
  return {
    period: ctx.period.label,
    business_units_total: rows.length,
    synced_count: rows.filter((r) => r.timesheet_sync === 'synced').length,
    pending_sync_count: rows.filter((r) => r.timesheet_sync === 'pending').length,
    business_units: rows.sort((a, b) => (a.timesheet_sync === b.timesheet_sync ? b.pending_approval_logs - a.pending_approval_logs : a.timesheet_sync === 'pending' ? -1 : 1)),
  };
}

async function tenantQuarterBrief(ctx) {
  const months = [ctx.shiftPeriod(ctx.period, -2), ctx.shiftPeriod(ctx.period, -1), ctx.period];
  const perMonth = [];
  const quarterByUnit = new Map(ctx.syncedUnits.map((u) => [u.id, { name: u.name, logged: 0, capacity: 0, billable: 0 }]));
  for (const month of months) {
    const snaps = await snapshotsOf(ctx, ctx.syncedUnits, month);
    perMonth.push({ period: month.label, ...combineTotals(snaps.map((s) => s.snap.totals)) });
    snaps.forEach((s) => {
      const q = quarterByUnit.get(s.unit.id);
      q.logged += s.snap.totals.logged_hours;
      q.capacity += s.snap.totals.capacity_hours;
      q.billable += s.snap.totals.billable_hours;
    });
  }
  const quarter = combineTotals(perMonth);
  if (quarter.headcount === 0) return null;
  return {
    quarter_months: months.map((m) => m.label),
    quarter_totals: { logged_hours: quarter.logged_hours, billable_hours: quarter.billable_hours, utilization_pct: quarter.utilization_pct, billable_utilization_pct: quarter.billable_utilization_pct },
    per_month: perMonth.map((m) => ({ period: m.period, headcount: m.headcount, logged_hours: m.logged_hours, utilization_pct: m.utilization_pct, billable_utilization_pct: m.billable_utilization_pct, bench_hours: m.bench_hours })),
    business_units: [...quarterByUnit.values()]
      .map((q) => ({ name: q.name, logged_hours: r1(q.logged), utilization_pct: pct(q.logged, q.capacity), billable_utilization_pct: pct(q.billable, q.capacity) }))
      .sort((a, b) => b.utilization_pct - a.utilization_pct),
  };
}

const MONTHLY_JOBS = {
  bu_utilization_summary:   { scope: 'bu', sync: 'required', placeholder: true, build: buUtilizationSummary },
  bu_underutilised_employees: { scope: 'bu', sync: 'required', build: buUnderUtilised },
  bu_overtime_overcap:      { scope: 'bu', sync: 'required', build: buOverCap },
  bu_bench_nonbillable:     { scope: 'bu', sync: 'required', build: buBenchNonBillable },
  bu_po_concentration:      { scope: 'bu', sync: 'required', build: buPoConcentration },
  bu_client_hours:          { scope: 'bu', sync: 'required', build: buClientHours },
  bu_timesheet_compliance:  { scope: 'bu', sync: 'none', build: buTimesheetCompliance },
  bu_po_timeline_risk:      { scope: 'bu', sync: 'required', build: buPoTimelineRisk },
  tenant_monthly_summary:   { scope: 'tenant', sync: 'partial', build: tenantSummary },
  tenant_bu_comparison:     { scope: 'tenant', sync: 'all', build: tenantBuComparison },
  tenant_client_concentration: { scope: 'tenant', sync: 'partial', build: tenantClientConcentration },
  tenant_overtime_burnout:  { scope: 'tenant', sync: 'partial', build: tenantOvertime },
  tenant_nonbillable_leakage: { scope: 'tenant', sync: 'partial', build: tenantLeakage },
  tenant_sync_compliance_health: { scope: 'tenant', sync: 'none', build: tenantSyncHealth },
  tenant_quarter_end_brief: { scope: 'tenant', sync: 'quarter', build: tenantQuarterBrief },
};

module.exports = { MONTHLY_JOBS, combineTotals };
