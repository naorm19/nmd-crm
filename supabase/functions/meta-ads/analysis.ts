// ============================================================
//  Meta Ads Analysis Engine
//  Ported from files1/meta-analysis.js - same rules, thresholds and
//  fingerprint/lifecycle logic (see .claude/rules/meta-ads.md for
//  the spec). Runs inside the Edge Function right after a successful
//  import, using the same request-scoped Supabase client (service
//  role - meta_* tables are service_role-only).
// ============================================================

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

const ACCOUNT_RESULT_TYPE_OVERRIDE: Record<string, string> = {
  '478741898863002': 'message',   // Sahar
  '423153664178647': 'message',   // Studio Sol
  '2885542151561931': 'video',    // Tranquilo
  '652805331965328': 'purchase'   // Asif-Market
};

function classifyByObjective(objective: string, campaignName: string): string | null {
  const obj = String(objective || '').toUpperCase().replace(/[^A-Z_]/g, '_');
  const name = String(campaignName || '').toLowerCase();

  if (obj.includes('LEAD')) return 'lead';
  if (obj.includes('SALE') || obj.includes('PURCHASE') || obj.includes('CONVERSION')) return 'purchase';
  if (obj.includes('MESSAGE') || obj.includes('ENGAGEMENT')) {
    if (obj.includes('MESSAGE') || /whatsapp|וואטסאפ|message|צ'אט|chat/.test(name)) return 'message';
    return null;
  }
  if (obj.includes('TRAFFIC')) return 'traffic';
  if (obj.includes('VIDEO') || obj.includes('AWARENESS') || obj.includes('REACH')) return 'video';
  return null;
}

function classifyCampaign(accountId: string, campaignName: string, objective: string) {
  if (ACCOUNT_RESULT_TYPE_OVERRIDE[accountId]) {
    return { result_type: ACCOUNT_RESULT_TYPE_OVERRIDE[accountId], status: 'auto_matched' };
  }
  const guess = classifyByObjective(objective, campaignName);
  if (guess) return { result_type: guess, status: 'auto_matched' };
  return { result_type: 'none', status: 'needs_review' };
}

const DEFAULT_THRESHOLDS = {
  budget_forecast_warning_pct: 100,
  budget_forecast_critical_pct: 110,
  min_results_for_avg: 5,
  burning_warning_multiplier: 1.0,
  burning_critical_multiplier: 1.5,
  trend_warning_pct: 35,
  trend_critical_pct: 60,
  min_spend_for_trend: 200,
  creative_gap_multiplier: 2.0,
  creative_gap_min_spend: 100,
  ad_concentration_budget_pct: 40,
  ad_concentration_perf_gap_pct: 25,
  winning_ad_min_spend: 100,       // same floor as creative_gap - below this, "cheap" is just noise
  winning_ad_outperform_pct: 25,   // ad must beat the campaign's own average cost per result by this much
  freshness_warning_days: 4,
  freshness_critical_days: 6,
  tranquilo_not_spending_ratio: 0.10,
  min_spend_no_result: 150 // an ad/campaign must spend at least this much with zero results before it's worth flagging
};

function mergeThresholds(base: typeof DEFAULT_THRESHOLDS, override: unknown) {
  return { ...base, ...(override && typeof override === 'object' ? override : {}) };
}

// Which evidence_json field represents "how bad is this" for the rule types
// that have one clean spend number - used to detect a materially larger
// problem behind a re-matching fingerprint after it was resolved. Rule types
// not listed here (ratio/percentage-based: creative_gap, cpm_spike,
// frequency_spike) only re-arm on a new reporting month, never mid-month.
const RESOLVED_MATERIALITY_SPEND_FIELD: Record<string, string> = {
  ad_zero_result_burn: 'ad_spend_7d',
  budget_forecast: 'spend_mtd',
  tranquilo_ad_not_spending: 'ad_spend_3d',
  ad_budget_concentration: 'ad_spend_7d'
};

function isoDaysAgo(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function monthStart(dateStr: string) { return dateStr.slice(0, 7) + '-01'; }
function daysInMonth(dateStr: string) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function dayOfMonth(dateStr: string) { return Number(dateStr.split('-')[2]); }
function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}

function fingerprintOf(ruleType: string, entityLevel: string, entityId: string | null) {
  return `${ruleType}:${entityLevel}:${entityId || 'none'}`;
}

async function ensureCampaignConfigs(supabase: SupabaseClient, mapping: any, rows: any[]) {
  const seen = new Map<string, { campaign_name: string; objective: string }>();
  for (const r of rows) {
    if (r.campaign_id && !seen.has(r.campaign_id)) {
      seen.set(r.campaign_id, { campaign_name: r.campaign_name, objective: r.objective });
    }
  }
  if (seen.size === 0) return;

  const { data: existing } = await supabase
    .from('meta_analysis_config')
    .select('campaign_id')
    .eq('account_id', mapping.account_id);
  const existingIds = new Set((existing || []).map((e: any) => e.campaign_id));

  const toInsert = [];
  for (const [campaignId, meta] of seen.entries()) {
    if (existingIds.has(campaignId)) continue;
    const { result_type, status } = classifyCampaign(mapping.account_id, meta.campaign_name, meta.objective);
    toInsert.push({
      client_id: mapping.client_id,
      account_id: mapping.account_id,
      campaign_id: campaignId,
      campaign_name: meta.campaign_name,
      result_type,
      configuration_status: status,
      notes: status === 'needs_review'
        ? `Objective="${meta.objective}" did not match a known pattern - set result_type manually.`
        : null
    });
  }
  if (toInsert.length > 0) {
    await supabase.from('meta_analysis_config').upsert(toInsert, { onConflict: 'account_id,campaign_id' });
  }
}

async function upsertAlert(supabase: SupabaseClient, clientId: number, accountId: string, candidate: any, dataThrough: string) {
  const fingerprint = fingerprintOf(candidate.rule_type, candidate.entity_level, candidate.entity_id);

  const { data: existingRows } = await supabase
    .from('meta_alerts')
    .select('id, status')
    .eq('client_id', clientId)
    .eq('fingerprint', fingerprint)
    .in('status', ['open', 'acknowledged', 'snoozed'])
    .limit(1);

  const existing = existingRows && existingRows[0];

  if (!existing) {
    // Don't recreate an alert the user resolved while the same condition
    // still holds - a re-sync with unchanged (or trivially different) data
    // must never silently reopen it. This is NOT time-based (elapsed days or
    // "one more sync" must never be the trigger on their own) - it only
    // reopens on a genuinely new occurrence: a new reporting month, or a
    // materially larger number behind the same problem (e.g. meaningfully
    // more wasted spend than when it was resolved).
    const { data: lastResolvedRows } = await supabase
      .from('meta_alerts')
      .select('id, data_through, evidence_json')
      .eq('client_id', clientId)
      .eq('fingerprint', fingerprint)
      .eq('status', 'resolved')
      .order('resolved_at', { ascending: false })
      .limit(1);
    const lastResolved = lastResolvedRows && lastResolvedRows[0];
    if (lastResolved) {
      const newPeriod = !lastResolved.data_through || monthStart(dataThrough) !== monthStart(lastResolved.data_through);
      const spendField = RESOLVED_MATERIALITY_SPEND_FIELD[candidate.rule_type];
      let materialIncrease = false;
      if (spendField && candidate.evidence_json && lastResolved.evidence_json) {
        const newVal = Number(candidate.evidence_json[spendField]) || 0;
        const oldVal = Number(lastResolved.evidence_json[spendField]) || 0;
        const delta = newVal - oldVal;
        // "significant additional spend": at least another min_spend_no_result
        // worth, or at least 50% more than what was there when resolved.
        materialIncrease = delta >= DEFAULT_THRESHOLDS.min_spend_no_result || (oldVal > 0 && delta / oldVal >= 0.5);
      }
      if (!newPeriod && !materialIncrease) return fingerprint; // same problem, same period - stays resolved
    }
  }

  if (existing) {
    await supabase.from('meta_alerts').update({
      severity: candidate.severity,
      title: candidate.title,
      explanation: candidate.explanation,
      evidence_json: candidate.evidence_json,
      recommendation: candidate.recommendation,
      entity_name: candidate.entity_name,
      data_through: dataThrough,
      last_detected_at: new Date().toISOString()
    }).eq('id', existing.id);
  } else {
    await supabase.from('meta_alerts').insert({
      client_id: clientId,
      account_id: accountId,
      severity: candidate.severity,
      rule_type: candidate.rule_type,
      entity_level: candidate.entity_level,
      entity_id: candidate.entity_id,
      entity_name: candidate.entity_name,
      title: candidate.title,
      explanation: candidate.explanation,
      evidence_json: candidate.evidence_json,
      recommendation: candidate.recommendation,
      data_through: dataThrough,
      fingerprint,
      status: 'open'
    });
  }

  return fingerprint;
}

async function resolveStaleAlerts(supabase: SupabaseClient, clientId: number, ruleTypesEvaluated: Set<string>, keepFingerprints: Set<string>) {
  if (ruleTypesEvaluated.size === 0) return;
  const { data: openAlerts } = await supabase
    .from('meta_alerts')
    .select('id, fingerprint, rule_type')
    .eq('client_id', clientId)
    .in('status', ['open', 'acknowledged', 'snoozed']);

  for (const a of openAlerts || []) {
    if (ruleTypesEvaluated.has(a.rule_type) && !keepFingerprints.has(a.fingerprint)) {
      await supabase.from('meta_alerts').update({
        status: 'resolved',
        resolved_at: new Date().toISOString()
      }).eq('id', a.id);
    }
  }
}

function ruleBudgetPacing(client: any, accountId: string, rows: any[], dataThrough: string, ruleTypes: Set<string>) {
  const budget = client.monthly_budget_meta;
  if (!budget || budget <= 0) return [];
  ruleTypes.add('budget_forecast');

  const mStart = monthStart(dataThrough);
  const mtdRows = rows.filter(r => r.day >= mStart && r.day <= dataThrough);
  const spendMtd = mtdRows.reduce((s, r) => s + (Number(r.amount_spent) || 0), 0);
  const elapsed = dayOfMonth(dataThrough);
  const totalDays = daysInMonth(dataThrough);
  const forecast = elapsed > 0 ? (spendMtd / elapsed) * totalDays : 0;
  const pct = budget > 0 ? (forecast / budget) * 100 : 0;

  const evidence = {
    spend_mtd: Number(spendMtd.toFixed(2)),
    monthly_budget: budget,
    days_elapsed: elapsed,
    days_in_month: totalDays,
    forecast_month_end: Number(forecast.toFixed(2)),
    forecast_pct_of_budget: Number(pct.toFixed(1)),
    note: 'Includes latest imported day, which may be partial if it is today.'
  };

  const out = [];
  if (spendMtd > budget) {
    out.push({
      severity: 'critical', rule_type: 'budget_forecast', entity_level: 'account', entity_id: accountId,
      entity_name: client.business_name,
      title: `${client.business_name}: חריגה מהתקציב החודשי`,
      explanation: `הוצאה בפועל מתחילת החודש (${evidence.spend_mtd}₪) כבר עברה את התקציב החודשי (${budget}₪).`,
      recommendation: 'לבדוק אם להוריד תקציב יומי או להשהות קמפיינים עד סוף החודש.',
      evidence_json: evidence
    });
  } else if (pct >= DEFAULT_THRESHOLDS.budget_forecast_critical_pct) {
    out.push({
      severity: 'critical', rule_type: 'budget_forecast', entity_level: 'account', entity_id: accountId,
      entity_name: client.business_name,
      title: `${client.business_name}: תחזית הוצאה חודשית ${evidence.forecast_pct_of_budget}% מהתקציב`,
      explanation: `בקצב הנוכחי (${evidence.spend_mtd}₪ ב-${elapsed} ימים), ההוצאה תגיע ל-${evidence.forecast_month_end}₪ עד סוף החודש, מול תקציב ${budget}₪.`,
      recommendation: 'להוריד תקציב יומי בקמפיינים הפעילים לפני שהחריגה תתממש.',
      evidence_json: evidence
    });
  } else if (pct >= DEFAULT_THRESHOLDS.budget_forecast_warning_pct) {
    out.push({
      severity: 'warning', rule_type: 'budget_forecast', entity_level: 'account', entity_id: accountId,
      entity_name: client.business_name,
      title: `${client.business_name}: תחזית הוצאה חודשית קרובה לתקציב (${evidence.forecast_pct_of_budget}%)`,
      explanation: `בקצב הנוכחי, ההוצאה החודשית צפויה להגיע ל-${evidence.forecast_month_end}₪ מול תקציב ${budget}₪.`,
      recommendation: 'לעקוב בימים הקרובים ולשקול התאמת תקציב יומי.',
      evidence_json: evidence
    });
  }
  return out;
}

function resultFieldFor(resultType: string) {
  if (resultType === 'purchase') return { countField: 'purchases', costField: 'cost_per_purchase' };
  if (resultType === 'message') return { countField: 'messaging_conversations_started', costField: 'cost_per_messaging_conversation' };
  if (resultType === 'lead') return { countField: 'leads', costField: null };
  return null;
}

// ── Multi-window analysis (Naor, 2026-09-02) ─────────────────
// Ad-level rules are evaluated over 7, 14 and 30 days rather than 7 alone,
// so an alert can say whether a problem is a trend or just a bad week.
// The 7-day window still decides whether an alert fires; the longer two
// decide how loud it is, and are always attached as evidence.
const ANALYSIS_WINDOWS = [7, 14, 30];

function windowRows(rows: any[], through: string, days: number) {
  const from = isoDaysAgo(through, days - 1);
  return rows.filter(r => r.day >= from && r.day <= through);
}

function aggregate(rows: any[], countField: string) {
  let spend = 0, results = 0;
  for (const r of rows) {
    spend += Number(r.amount_spent) || 0;
    results += Number(r[countField]) || 0;
  }
  return { spend, results, cost: results > 0 ? spend / results : null };
}

function byAdIn(rows: any[], countField: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of rows) {
    if (!r.ad_id) continue;
    out[r.ad_id] = out[r.ad_id] || { ad_name: r.ad_name, spend: 0, results: 0 };
    out[r.ad_id].spend += Number(r.amount_spent) || 0;
    out[r.ad_id].results += Number(r[countField]) || 0;
  }
  return out;
}

// Naor's question, in his words, is whether something is מגמתי. Answer it
// explicitly rather than leaving three numbers for a human to compare.
function trendVerdict(holds: Record<number, boolean>) {
  const n = ANALYSIS_WINDOWS.filter(w => holds[w]).length;
  if (n >= 3) return { level: 'trend', label: 'מגמתי - נמשך ב-7, 14 ו-30 יום' };
  if (n === 2) return { level: 'building', label: 'מתחזק - נמשך בשניים מתוך שלושה חלונות' };
  return { level: 'oneoff', label: 'חד פעמי - מופיע רק בשבוע האחרון' };
}

// A 7-day finding the longer windows do not support is downgraded, never
// dropped: it stays visible as something to watch.
function applyTrend(severity: string, verdict: any) {
  if (verdict.level === 'trend') return severity;
  if (verdict.level === 'building') return severity === 'critical' ? 'critical' : 'warning';
  return severity === 'critical' ? 'warning' : 'info';
}

function windowEvidence(scopeRows: any[], through: string, countField: string, adId?: string) {
  const ev: Record<string, any> = {};
  for (const w of ANALYSIS_WINDOWS) {
    const rows = windowRows(scopeRows, through, w);
    const scope = aggregate(rows, countField);
    const entry: Record<string, any> = {
      scope_spend: Number(scope.spend.toFixed(2)),
      scope_results: scope.results,
      scope_cost_per_result: scope.cost == null ? null : Number(scope.cost.toFixed(2))
    };
    if (adId) {
      const ad = byAdIn(rows, countField)[adId];
      entry.ad_spend = ad ? Number(ad.spend.toFixed(2)) : 0;
      entry.ad_results = ad ? ad.results : 0;
      entry.ad_cost_per_result = ad && ad.results > 0 ? Number((ad.spend / ad.results).toFixed(2)) : null;
    }
    ev['d' + w] = entry;
  }
  return ev;
}

// Scope note, 2026-09-02: these four rules used to baseline on the whole
// campaign. Naor: ad sets inside one campaign target different audiences,
// so a campaign average compares things that were never comparable.
// Measured on Asif the same day, campaign 1 held two ad sets at 13 and 198
// per purchase on near-identical spend, blending to a meaningless 23.78.
// They now take ad set rows and an ad set baseline. Campaign level
// survives only for pacing, and for CPM/frequency where a finer slice
// would destroy the signal.

function ruleZeroResultBurn(client: any, accountId: string, adsetRows: any[], scope: any, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('ad_zero_result_burn');

  const through = scope.through;
  const last7 = windowRows(adsetRows, through, 7);
  const base7 = aggregate(last7, fields.countField);
  if (base7.results < thresholds.min_results_for_avg || base7.spend <= 0) return [];
  const avgCost = base7.cost as number;

  const out: any[] = [];
  for (const [adId, d0] of Object.entries(byAdIn(last7, fields.countField))) {
    const d = d0 as any;
    if (d.results > 0 || d.spend <= 0) continue;
    const ratio = d.spend / avgCost;
    let severity: string | null = null;
    if (ratio >= thresholds.burning_critical_multiplier) severity = 'critical';
    else if (ratio >= thresholds.burning_warning_multiplier) severity = 'warning';
    if (!severity) continue;

    const holds: Record<number, boolean> = {};
    for (const w of ANALYSIS_WINDOWS) {
      const ad = byAdIn(windowRows(adsetRows, through, w), fields.countField)[adId];
      holds[w] = !ad || ad.results === 0;
    }
    const verdict = trendVerdict(holds);
    const windows = windowEvidence(adsetRows, through, fields.countField, adId);
    const label = ({ purchase: 'רכישות', message: 'שיחות', lead: 'לידים' } as Record<string, string>)[resultType] || 'תוצאות';
    const d30 = windows.d30 || {};
    out.push({
      severity: applyTrend(severity, verdict),
      rule_type: 'ad_zero_result_burn', entity_level: 'ad', entity_id: adId, entity_name: d.ad_name,
      title: `${client.business_name} / ${d.ad_name}: הוצאה של ${d.spend.toFixed(0)} ללא ${label}`,
      explanation: `המודעה "${d.ad_name}" באד סט "${scope.adsetName}" (קמפיין "${scope.campaignName}") הוציאה ${d.spend.toFixed(0)} ב-7 הימים האחרונים ללא אף תוצאה, מול עלות ממוצעת באד סט של ${avgCost.toFixed(1)}. ב-30 יום: הוצאה ${Number(d30.ad_spend || 0).toFixed(0)} מול ${d30.ad_results || 0} ${label}. ${verdict.label}.`,
      recommendation: verdict.level === 'trend'
        ? 'הבעיה נמשכת בכל שלושת החלונות. לשקול השהיית המודעה.'
        : 'עדיין לא מגמה מלאה. להמשיך מעקב לפני השהיה.',
      evidence_json: {
        campaign_id: scope.campaignId, campaign_name: scope.campaignName,
        adset_id: scope.adsetId, adset_name: scope.adsetName,
        baseline_level: 'adset', result_type: resultType,
        adset_avg_cost_per_result: Number(avgCost.toFixed(2)),
        trend: verdict.level, trend_label: verdict.label, windows
      }
    });
  }
  return out;
}

function ruleCreativeGap(client: any, accountId: string, adsetRows: any[], scope: any, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('creative_gap');
  const through = scope.through;

  const gapIn = (days: number) => {
    const rows = windowRows(adsetRows, through, days);
    const withCost = Object.entries(byAdIn(rows, fields.countField))
      .map(([adId, d0]) => { const d = d0 as any; return { adId, ad_name: d.ad_name, spend: d.spend, results: d.results, cost: d.results > 0 ? d.spend / d.results : Infinity }; })
      .filter(x => x.spend >= thresholds.creative_gap_min_spend && x.results > 0)
      .sort((x, y) => x.cost - y.cost);
    if (withCost.length < 2) return null;
    const cheapest = withCost[0];
    const priciest = withCost[withCost.length - 1];
    return { cheapest, priciest, ratio: priciest.cost / cheapest.cost };
  };

  const g7 = gapIn(7);
  if (!g7 || g7.ratio < thresholds.creative_gap_multiplier) return [];

  const holds: Record<number, boolean> = {};
  const ratios: Record<string, number | null> = {};
  for (const w of ANALYSIS_WINDOWS) {
    const g = gapIn(w);
    holds[w] = !!g && g.ratio >= thresholds.creative_gap_multiplier;
    ratios['d' + w] = g ? Number(g.ratio.toFixed(2)) : null;
  }
  const verdict = trendVerdict(holds);
  const label = ({ purchase: 'רכישה', message: 'שיחה', lead: 'ליד' } as Record<string, string>)[resultType] || 'תוצאה';
  const say = (v: any) => (v == null ? 'אין נתון' : String(v));

  return [{
    severity: applyTrend('warning', verdict),
    rule_type: 'creative_gap', entity_level: 'adset', entity_id: scope.adsetId, entity_name: scope.adsetName,
    title: `${client.business_name} / ${scope.adsetName}: פער קריאייטיב בין מודעות`,
    explanation: `באד סט "${scope.adsetName}" (קמפיין "${scope.campaignName}") המודעה "${g7.priciest.ad_name}" עולה ${g7.priciest.cost.toFixed(1)} ל${label} לעומת "${g7.cheapest.ad_name}" ב-${g7.cheapest.cost.toFixed(1)}, פער של פי ${g7.ratio.toFixed(1)} ב-7 ימים. פי ${say(ratios.d14)} ב-14 יום ופי ${say(ratios.d30)} ב-30 יום. ${verdict.label}.`,
    recommendation: verdict.level === 'trend'
      ? `הפער עקבי בכל שלושת החלונות. לשקול הפניית תקציב ל"${g7.cheapest.ad_name}".`
      : 'הפער עדיין לא עקבי לאורך זמן. לבדוק שוב לפני הזזת תקציב.',
    evidence_json: {
      campaign_id: scope.campaignId, campaign_name: scope.campaignName,
      adset_id: scope.adsetId, adset_name: scope.adsetName,
      baseline_level: 'adset', result_type: resultType,
      cheaper_ad: { name: g7.cheapest.ad_name, spend_7d: Number(g7.cheapest.spend.toFixed(2)), cost_per_result: Number(g7.cheapest.cost.toFixed(2)) },
      pricier_ad: { name: g7.priciest.ad_name, spend_7d: Number(g7.priciest.spend.toFixed(2)), cost_per_result: Number(g7.priciest.cost.toFixed(2)) },
      ratio_by_window: ratios, trend: verdict.level, trend_label: verdict.label
    }
  }];
}

function ruleAdBudgetConcentration(client: any, accountId: string, adsetRows: any[], scope: any, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('ad_budget_concentration');
  const through = scope.through;

  const last7 = windowRows(adsetRows, through, 7);
  const base7 = aggregate(last7, fields.countField);
  if (base7.results < thresholds.min_results_for_avg || base7.spend <= 0) return [];
  const avgCost = base7.cost as number;
  const byAd = byAdIn(last7, fields.countField);

  let bestAdId: string | null = null, bestCost = Infinity;
  for (const [adId, d0] of Object.entries(byAd)) {
    const d = d0 as any;
    if (d.results <= 0) continue;
    const cost = d.spend / d.results;
    if (cost < bestCost) { bestCost = cost; bestAdId = adId; }
  }

  const holdsFor = (adId: string, w: number) => {
    const rows = windowRows(adsetRows, through, w);
    const base = aggregate(rows, fields.countField);
    const ad = byAdIn(rows, fields.countField)[adId];
    if (!ad || ad.results <= 0 || base.cost == null || base.spend <= 0) return false;
    const share = (ad.spend / base.spend) * 100;
    const gap = (((ad.spend / ad.results) - base.cost) / base.cost) * 100;
    return share > thresholds.ad_concentration_budget_pct && gap >= thresholds.ad_concentration_perf_gap_pct;
  };

  const out: any[] = [];
  for (const [adId, d0] of Object.entries(byAd)) {
    const d = d0 as any;
    if (d.results === 0 || d.spend <= 0) continue;
    if (adId === bestAdId) continue;
    const budgetSharePct = (d.spend / base7.spend) * 100;
    if (budgetSharePct <= thresholds.ad_concentration_budget_pct) continue;
    const adCost = d.spend / d.results;
    const underperformPct = ((adCost - avgCost) / avgCost) * 100;
    if (underperformPct < thresholds.ad_concentration_perf_gap_pct) continue;

    const holds: Record<number, boolean> = {};
    for (const w of ANALYSIS_WINDOWS) holds[w] = holdsFor(adId, w);
    const verdict = trendVerdict(holds);

    out.push({
      severity: applyTrend('warning', verdict),
      rule_type: 'ad_budget_concentration', entity_level: 'ad', entity_id: adId, entity_name: d.ad_name,
      title: `${client.business_name} / ${d.ad_name}: ריכוז תקציב במודעה חלשה`,
      explanation: `המודעה "${d.ad_name}" צרכה ${budgetSharePct.toFixed(0)}% מתקציב האד סט "${scope.adsetName}" ב-7 ימים, ועלות התוצאה שלה (${adCost.toFixed(1)}) גרועה ב-${underperformPct.toFixed(0)}% מהממוצע באד סט (${avgCost.toFixed(1)}). ${verdict.label}.`,
      recommendation: verdict.level === 'trend'
        ? 'הדפוס חוזר בכל שלושת החלונות. לשקול הקטנת תקציב למודעה זו.'
        : 'עדיין לא דפוס יציב. לעקוב לפני שינוי תקציב.',
      evidence_json: {
        campaign_id: scope.campaignId, campaign_name: scope.campaignName,
        adset_id: scope.adsetId, adset_name: scope.adsetName,
        baseline_level: 'adset', result_type: resultType,
        ad_spend_7d: Number(d.spend.toFixed(2)), budget_share_pct: Number(budgetSharePct.toFixed(1)),
        ad_cost_per_result: Number(adCost.toFixed(2)), adset_avg_cost_per_result: Number(avgCost.toFixed(2)),
        underperform_pct: Number(underperformPct.toFixed(1)),
        trend: verdict.level, trend_label: verdict.label,
        windows: windowEvidence(adsetRows, through, fields.countField, adId)
      }
    });
  }
  return out;
}

// A winning ad is only meaningfully 'winning' against the other ads shown
// to the SAME audience, so this baselines on the ad set too.
function ruleWinningAd(client: any, accountId: string, adsetRows: any[], scope: any, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('winning_ad');
  const through = scope.through;

  const last7 = windowRows(adsetRows, through, 7);
  const base7 = aggregate(last7, fields.countField);
  if (base7.results < thresholds.min_results_for_avg || base7.spend <= 0) return [];
  const avgCost = base7.cost as number;
  const byAd = byAdIn(last7, fields.countField);

  let bestAdId: string | null = null, bestCost = Infinity;
  for (const [adId, d0] of Object.entries(byAd)) {
    const d = d0 as any;
    if (d.results === 0 || d.spend < thresholds.winning_ad_min_spend) continue;
    const cost = d.spend / d.results;
    if (cost < bestCost) { bestCost = cost; bestAdId = adId; }
  }
  if (!bestAdId) return [];

  const d = byAd[bestAdId];
  const outperformPct = ((avgCost - bestCost) / avgCost) * 100;
  if (outperformPct < thresholds.winning_ad_outperform_pct) return [];

  // Is it consistently the cheapest, or did it just have a good week?
  const holds: Record<number, boolean> = {};
  for (const w of ANALYSIS_WINDOWS) {
    const rows = windowRows(adsetRows, through, w);
    const base = aggregate(rows, fields.countField);
    const ad = byAdIn(rows, fields.countField)[bestAdId];
    holds[w] = !!ad && ad.results > 0 && base.cost != null
      && ((((base.cost as number) - (ad.spend / ad.results)) / (base.cost as number)) * 100) >= thresholds.winning_ad_outperform_pct;
  }
  const verdict = trendVerdict(holds);
  const label = ({ purchase: 'רכישה', message: 'שיחה', lead: 'ליד' } as Record<string, string>)[resultType] || 'תוצאה';

  return [{
    severity: 'info', rule_type: 'winning_ad', entity_level: 'ad', entity_id: bestAdId, entity_name: d.ad_name,
    title: `${client.business_name} / ${d.ad_name}: מודעה מנצחת`,
    explanation: `המודעה "${d.ad_name}" באד סט "${scope.adsetName}" (קמפיין "${scope.campaignName}") עלתה ${bestCost.toFixed(1)} ל${label} ב-7 הימים האחרונים, זול ב-${outperformPct.toFixed(0)}% מהממוצע באד סט (${avgCost.toFixed(1)}), עם הוצאה של ${d.spend.toFixed(0)}. ${verdict.label}.`,
    recommendation: verdict.level === 'trend'
      ? 'מנצחת עקבית בכל שלושת החלונות. זו המודעה להגדיל לה תקציב.'
      : 'שבוע טוב, עדיין לא מגמה. לוודא שהיא מחזיקה לפני הגדלת תקציב.',
    evidence_json: {
      campaign_id: scope.campaignId, campaign_name: scope.campaignName,
      adset_id: scope.adsetId, adset_name: scope.adsetName,
      baseline_level: 'adset', result_type: resultType,
      ad_spend_7d: Number(d.spend.toFixed(2)), ad_cost_per_result: Number(bestCost.toFixed(2)),
      adset_avg_cost_per_result: Number(avgCost.toFixed(2)), outperform_pct: Number(outperformPct.toFixed(1)),
      trend: verdict.level, trend_label: verdict.label,
      windows: windowEvidence(adsetRows, through, fields.countField, bestAdId)
    }
  }];
}

function ruleTrendSpike(client: any, accountId: string, campaignRows: any[], campaignId: string, campaignName: string, field: string, ruleType: string, label: string, thresholds: any, ruleTypes: Set<string>) {
  ruleTypes.add(ruleType);
  const through = (campaignRows as any)._through;
  const last3 = campaignRows.filter(r => r.day > isoDaysAgo(through, 3) && r.day <= through);
  const prev7 = campaignRows.filter(r => r.day > isoDaysAgo(through, 10) && r.day <= isoDaysAgo(through, 3));

  const spendLast3 = last3.reduce((s, r) => s + (Number(r.amount_spent) || 0), 0);
  const spendPrev7 = prev7.reduce((s, r) => s + (Number(r.amount_spent) || 0), 0);
  if (spendLast3 < thresholds.min_spend_for_trend || spendPrev7 < thresholds.min_spend_for_trend) return [];

  const wavg = (list: any[]) => {
    const totalSpend = list.reduce((s, r) => s + (Number(r.amount_spent) || 0), 0);
    if (totalSpend <= 0) return null;
    const weighted = list.reduce((s, r) => s + ((Number(r[field]) || 0) * (Number(r.amount_spent) || 0)), 0);
    return weighted / totalSpend;
  };

  const avgLast3 = wavg(last3);
  const avgPrev7 = wavg(prev7);
  if (avgLast3 == null || avgPrev7 == null || avgPrev7 <= 0) return [];

  const pctChange = ((avgLast3 - avgPrev7) / avgPrev7) * 100;
  if (pctChange < thresholds.trend_warning_pct) return [];

  const severity = pctChange >= thresholds.trend_critical_pct ? 'critical' : 'warning';
  const evidence = {
    campaign_id: campaignId, campaign_name: campaignName,
    avg_last_3_days: Number(avgLast3.toFixed(2)), avg_prev_7_days: Number(avgPrev7.toFixed(2)),
    pct_change: Number(pctChange.toFixed(1))
  };
  return [{
    severity, rule_type: ruleType, entity_level: 'campaign', entity_id: campaignId, entity_name: campaignName,
    title: `${client.business_name} / ${campaignName}: ${label} עלה ${evidence.pct_change}%`,
    explanation: `${label} הממוצע ב-3 הימים האחרונים (${evidence.avg_last_3_days}) עלה ב-${evidence.pct_change}% לעומת 7 הימים שקדמו להם (${evidence.avg_prev_7_days}).`,
    recommendation: 'לבדוק שינויים במכרז/קהל/קריאייטיב שיכולים להסביר את העלייה.',
    evidence_json: evidence
  }];
}

function ruleFreshness(client: any, accountId: string, dataThrough: string, todayStr: string, thresholds: any, ruleTypes: Set<string>) {
  ruleTypes.add('data_stale');
  const staleDays = daysBetween(dataThrough, todayStr);
  const evidence = { data_through: dataThrough, today: todayStr, days_stale: staleDays };
  if (staleDays >= thresholds.freshness_critical_days) {
    return [{
      severity: 'critical', rule_type: 'data_stale', entity_level: 'account', entity_id: accountId, entity_name: client.business_name,
      title: `${client.business_name}: נתוני Meta לא עודכנו ${staleDays} ימים`,
      explanation: `הנתונים האחרונים שנקלטו הם מתאריך ${dataThrough}, לפני ${staleDays} ימים.`,
      recommendation: 'לייצא דוח חדש מ-Meta Ads Manager ולהריץ סנכרון.',
      evidence_json: evidence
    }];
  }
  if (staleDays >= thresholds.freshness_warning_days) {
    return [{
      severity: 'warning', rule_type: 'data_stale', entity_level: 'account', entity_id: accountId, entity_name: client.business_name,
      title: `${client.business_name}: נתוני Meta לא עודכנו ${staleDays} ימים`,
      explanation: `הנתונים האחרונים שנקלטו הם מתאריך ${dataThrough}.`,
      recommendation: 'מומלץ לתזמן ייצוא וסנכרון בקרוב.',
      evidence_json: evidence
    }];
  }
  return [];
}

function ruleTranquiloNotSpending(client: any, accountId: string, campaignRows: any[], campaignId: string, campaignName: string, thresholds: any, ruleTypes: Set<string>) {
  ruleTypes.add('tranquilo_ad_not_spending');
  const through = (campaignRows as any)._through;
  const last3 = campaignRows.filter(r => r.day > isoDaysAgo(through, 3) && r.day <= through);

  const byAd: Record<string, any> = {};
  for (const r of last3) {
    if (!r.ad_id) continue;
    byAd[r.ad_id] = byAd[r.ad_id] || { ad_name: r.ad_name, spend: 0, delivery: r.ad_delivery };
    byAd[r.ad_id].spend += Number(r.amount_spent) || 0;
    byAd[r.ad_id].delivery = r.ad_delivery || byAd[r.ad_id].delivery;
  }

  const active = Object.entries(byAd).filter(([, d]) => /active|פעיל/i.test((d as any).delivery || ''));
  if (active.length < 2) return [];

  const spends = active.map(([, d]) => (d as any).spend).sort((a, b) => a - b);
  const median = spends[Math.floor(spends.length / 2)];
  if (median <= 0) return [];

  const out = [];
  for (const [adId, d0] of active) {
    const d = d0 as any;
    if (d.spend < median * thresholds.tranquilo_not_spending_ratio) {
      out.push({
        severity: 'critical', rule_type: 'tranquilo_ad_not_spending', entity_level: 'ad', entity_id: adId, entity_name: d.ad_name,
        title: `${client.business_name} / ${d.ad_name}: מודעה פעילה כמעט לא מוציאה`,
        explanation: `המודעה "${d.ad_name}" פעילה אך הוציאה רק ${d.spend.toFixed(1)}₪ ב-3 הימים האחרונים, מול חציון ${median.toFixed(1)}₪ בקרב המודעות הפעילות בקמפיין "${campaignName}".`,
        recommendation: 'לבדוק אישור/דחיית המודעה ב-Meta, או בעיית משלוח (delivery).',
        evidence_json: { campaign_id: campaignId, campaign_name: campaignName, ad_spend_3d: Number(d.spend.toFixed(2)), sibling_median_3d: Number(median.toFixed(2)) }
      });
    }
  }
  return out;
}

export async function runAnalysis(supabase: SupabaseClient, dataThrough: string) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: mappings, error: mErr } = await supabase
    .from('meta_account_mappings')
    .select('account_id, account_name, client_id, active')
    .eq('active', true);
  if (mErr) throw new Error(`Failed to load meta_account_mappings: ${mErr.message}`);
  if (!mappings || mappings.length === 0) {
    return { accounts_analyzed: 0, alerts_active: 0 };
  }

  const clientIds = [...new Set(mappings.map((m: any) => m.client_id))];
  const { data: clients, error: cErr } = await supabase
    .from('clients')
    .select('id, business_name, monthly_budget_meta')
    .in('id', clientIds);
  if (cErr) throw new Error(`Failed to load clients: ${cErr.message}`);
  const clientById = Object.fromEntries((clients || []).map((c: any) => [c.id, c]));

  const since = isoDaysAgo(dataThrough, 40);
  let accountsAnalyzed = 0, totalAlerts = 0;

  for (const mapping of mappings) {
    const client = clientById[mapping.client_id];
    if (!client) continue;

    // Paged deliberately. PostgREST caps an unbounded select at 1000 rows,
    // and Asif alone has ~2,240 rows in this 40-day window, so the engine
    // had been silently analysing under half of the biggest account.
    // Found 2026-09-02. Never collapse this back into a single select.
    const rows: any[] = [];
    let rErr: any = null;
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from('meta_ad_daily')
        .select('*')
        .eq('account_id', mapping.account_id)
        .gte('day', since)
        .lte('day', dataThrough)
        .order('day', { ascending: true })
        .range(from, from + 999);
      if (error) { rErr = error; break; }
      rows.push(...((page || []) as any[]));
      if (!page || page.length < 1000) break;
    }
    if (rErr || rows.length === 0) continue;
    (rows as any)._through = dataThrough;
    accountsAnalyzed++;

    await ensureCampaignConfigs(supabase, mapping, rows);

    const { data: configs } = await supabase
      .from('meta_analysis_config')
      .select('campaign_id, result_type, thresholds')
      .eq('account_id', mapping.account_id);
    const configByCampaign = Object.fromEntries((configs || []).map((c: any) => [c.campaign_id, c]));

    const ruleTypesEvaluated = new Set<string>();
    const candidates: any[] = [];

    candidates.push(...ruleBudgetPacing(client, mapping.account_id, rows, dataThrough, ruleTypesEvaluated));
    candidates.push(...ruleFreshness(client, mapping.account_id, dataThrough, todayStr, DEFAULT_THRESHOLDS, ruleTypesEvaluated));

    const byCampaign: Record<string, any[]> = {};
    for (const r of rows) {
      if (!r.campaign_id) continue;
      byCampaign[r.campaign_id] = byCampaign[r.campaign_id] || [];
      byCampaign[r.campaign_id].push(r);
    }

    for (const [campaignId, campaignRows] of Object.entries(byCampaign)) {
      (campaignRows as any)._through = dataThrough;
      const campaignName = campaignRows[0].campaign_name;
      const cfg = configByCampaign[campaignId];
      const resultType = cfg ? cfg.result_type : 'none';
      const thresholds = mergeThresholds(DEFAULT_THRESHOLDS, cfg && cfg.thresholds);

      // Ad-level rules run per AD SET, not per campaign (Naor, 2026-09-02).
      // Two ad sets in one campaign are two different audiences, so a
      // campaign average is not a baseline any ad should be judged against.
      if (['purchase', 'message', 'lead'].includes(resultType)) {
        const byAdset: Record<string, any[]> = {};
        for (const r of campaignRows) {
          const key = r.adset_id || '(no-adset)';
          byAdset[key] = byAdset[key] || [];
          byAdset[key].push(r);
        }
        for (const [adsetId, adsetRows] of Object.entries(byAdset)) {
          const scope = {
            campaignId, campaignName, adsetId,
            adsetName: (adsetRows.find((r: any) => r.adset_name) || {}).adset_name || 'אד סט ללא שם',
            through: dataThrough
          };
          candidates.push(...ruleZeroResultBurn(client, mapping.account_id, adsetRows, scope, resultType, thresholds, ruleTypesEvaluated));
          candidates.push(...ruleCreativeGap(client, mapping.account_id, adsetRows, scope, resultType, thresholds, ruleTypesEvaluated));
          candidates.push(...ruleAdBudgetConcentration(client, mapping.account_id, adsetRows, scope, resultType, thresholds, ruleTypesEvaluated));
          candidates.push(...ruleWinningAd(client, mapping.account_id, adsetRows, scope, resultType, thresholds, ruleTypesEvaluated));
        }
      }

      candidates.push(...ruleTrendSpike(client, mapping.account_id, campaignRows, campaignId, campaignName, 'cpm', 'cpm_spike', 'CPM', thresholds, ruleTypesEvaluated));
      candidates.push(...ruleTrendSpike(client, mapping.account_id, campaignRows, campaignId, campaignName, 'frequency', 'frequency_spike', 'Frequency', thresholds, ruleTypesEvaluated));

      if (resultType === 'video' && mapping.account_id === '2885542151561931') {
        candidates.push(...ruleTranquiloNotSpending(client, mapping.account_id, campaignRows, campaignId, campaignName, thresholds, ruleTypesEvaluated));
      }
    }

    const keepFingerprints = new Set<string>();
    for (const c of candidates) {
      const fp = await upsertAlert(supabase, client.id, mapping.account_id, c, dataThrough);
      keepFingerprints.add(fp);
    }
    await resolveStaleAlerts(supabase, client.id, ruleTypesEvaluated, keepFingerprints);
    totalAlerts += candidates.length;
  }

  return { accounts_analyzed: accountsAnalyzed, alerts_active: totalAlerts };
}
