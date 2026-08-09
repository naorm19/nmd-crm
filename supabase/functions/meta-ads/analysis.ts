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
  freshness_warning_days: 4,
  freshness_critical_days: 6,
  tranquilo_not_spending_ratio: 0.10
};

function mergeThresholds(base: typeof DEFAULT_THRESHOLDS, override: unknown) {
  return { ...base, ...(override && typeof override === 'object' ? override : {}) };
}

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
      explanation: `הוצאה בפועל מתחילת החודש (${evidence.spend_mtd}) כבר עברה את התקציב החודשי (${budget}).`,
      recommendation: 'לבדוק אם להוריד תקציב יומי או להשהות קמפיינים עד סוף החודש.',
      evidence_json: evidence
    });
  } else if (pct >= DEFAULT_THRESHOLDS.budget_forecast_critical_pct) {
    out.push({
      severity: 'critical', rule_type: 'budget_forecast', entity_level: 'account', entity_id: accountId,
      entity_name: client.business_name,
      title: `${client.business_name}: תחזית הוצאה חודשית ${evidence.forecast_pct_of_budget}% מהתקציב`,
      explanation: `בקצב הנוכחי (${evidence.spend_mtd} ב-${elapsed} ימים), ההוצאה תגיע ל-${evidence.forecast_month_end} עד סוף החודש, מול תקציב ${budget}.`,
      recommendation: 'להוריד תקציב יומי בקמפיינים הפעילים לפני שהחריגה תתממש.',
      evidence_json: evidence
    });
  } else if (pct >= DEFAULT_THRESHOLDS.budget_forecast_warning_pct) {
    out.push({
      severity: 'warning', rule_type: 'budget_forecast', entity_level: 'account', entity_id: accountId,
      entity_name: client.business_name,
      title: `${client.business_name}: תחזית הוצאה חודשית קרובה לתקציב (${evidence.forecast_pct_of_budget}%)`,
      explanation: `בקצב הנוכחי, ההוצאה החודשית צפויה להגיע ל-${evidence.forecast_month_end} מול תקציב ${budget}.`,
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

function ruleZeroResultBurn(client: any, accountId: string, campaignRows: any[], campaignId: string, campaignName: string, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('ad_zero_result_burn');

  const through = (campaignRows as any)._through;
  const last7 = campaignRows.filter(r => r.day >= isoDaysAgo(through, 6));
  const totalResults = last7.reduce((s, r) => s + (Number(r[fields.countField]) || 0), 0);
  const totalSpend = last7.reduce((s, r) => s + (Number(r.amount_spent) || 0), 0);
  if (totalResults < thresholds.min_results_for_avg || totalSpend <= 0) return [];

  const avgCost = totalSpend / totalResults;

  const byAd: Record<string, any> = {};
  for (const r of last7) {
    if (!r.ad_id) continue;
    byAd[r.ad_id] = byAd[r.ad_id] || { ad_name: r.ad_name, spend: 0, results: 0 };
    byAd[r.ad_id].spend += Number(r.amount_spent) || 0;
    byAd[r.ad_id].results += Number(r[fields.countField]) || 0;
  }

  const out = [];
  for (const [adId, d] of Object.entries(byAd)) {
    if ((d as any).results > 0 || (d as any).spend <= 0) continue;
    const ratio = (d as any).spend / avgCost;
    if (ratio >= thresholds.burning_critical_multiplier) {
      out.push(makeBurnAlert('critical', client, accountId, campaignId, campaignName, adId, d, avgCost, resultType));
    } else if (ratio >= thresholds.burning_warning_multiplier) {
      out.push(makeBurnAlert('warning', client, accountId, campaignId, campaignName, adId, d, avgCost, resultType));
    }
  }
  return out;
}

function makeBurnAlert(severity: string, client: any, accountId: string, campaignId: string, campaignName: string, adId: string, d: any, avgCost: number, resultType: string) {
  const label = ({ purchase: 'רכישות', message: 'שיחות', lead: 'לידים' } as Record<string, string>)[resultType] || 'תוצאות';
  return {
    severity, rule_type: 'ad_zero_result_burn', entity_level: 'ad', entity_id: adId,
    entity_name: d.ad_name,
    title: `${client.business_name} / ${d.ad_name}: הוצאה של ${d.spend.toFixed(0)} ללא ${label}`,
    explanation: `המודעה "${d.ad_name}" בקמפיין "${campaignName}" הוציאה ${d.spend.toFixed(0)} ב-7 הימים האחרונים ולא הביאה אף ${label.slice(0, -1)}, מול עלות ממוצעת בקמפיין של ${avgCost.toFixed(1)}.`,
    recommendation: severity === 'critical' ? 'לשקול השהיית המודעה ובדיקת הקריאייטיב/הטירגוט.' : 'לעקוב - אם ימשיך כך יומיים נוספים, לשקול השהיה.',
    evidence_json: { campaign_id: campaignId, campaign_name: campaignName, ad_spend_7d: Number(d.spend.toFixed(2)), avg_cost_per_result: Number(avgCost.toFixed(2)), result_type: resultType }
  };
}

function ruleCreativeGap(client: any, accountId: string, campaignRows: any[], campaignId: string, campaignName: string, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('creative_gap');

  const through = (campaignRows as any)._through;
  const last7 = campaignRows.filter(r => r.day >= isoDaysAgo(through, 6));
  const byAd: Record<string, any> = {};
  for (const r of last7) {
    if (!r.ad_id) continue;
    byAd[r.ad_id] = byAd[r.ad_id] || { ad_name: r.ad_name, spend: 0, results: 0 };
    byAd[r.ad_id].spend += Number(r.amount_spent) || 0;
    byAd[r.ad_id].results += Number(r[fields.countField]) || 0;
  }

  const withCost = Object.entries(byAd)
    .filter(([, d]) => (d as any).spend >= thresholds.creative_gap_min_spend && (d as any).results > 0)
    .map(([adId, d]) => ({ adId, ...(d as any), cost: (d as any).spend / (d as any).results }));
  if (withCost.length < 2) return [];

  withCost.sort((a, b) => a.cost - b.cost);
  const cheapest = withCost[0];
  const priciest = withCost[withCost.length - 1];
  const ratio = priciest.cost / cheapest.cost;
  if (ratio < thresholds.creative_gap_multiplier) return [];

  const label = ({ purchase: 'רכישה', message: 'שיחה', lead: 'ליד' } as Record<string, string>)[resultType] || 'תוצאה';
  return [{
    severity: 'warning', rule_type: 'creative_gap', entity_level: 'campaign', entity_id: campaignId, entity_name: campaignName,
    title: `${client.business_name} / ${campaignName}: פער קריאייטיב בין מודעות`,
    explanation: `המודעה "${priciest.ad_name}" עולה ${priciest.cost.toFixed(1)} ל${label} לעומת "${cheapest.ad_name}" ב-${cheapest.cost.toFixed(1)} - פער של פי ${ratio.toFixed(1)} (7 ימים אחרונים, שתי המודעות עם הוצאה משמעותית).`,
    recommendation: `לבדוק מה שונה בקריאייטיב/קהל של "${priciest.ad_name}" ולשקול הפניית תקציב ל"${cheapest.ad_name}".`,
    evidence_json: {
      campaign_id: campaignId, campaign_name: campaignName, result_type: resultType,
      cheaper_ad: { name: cheapest.ad_name, spend_7d: Number(cheapest.spend.toFixed(2)), cost_per_result: Number(cheapest.cost.toFixed(2)) },
      pricier_ad: { name: priciest.ad_name, spend_7d: Number(priciest.spend.toFixed(2)), cost_per_result: Number(priciest.cost.toFixed(2)) },
      ratio: Number(ratio.toFixed(2))
    }
  }];
}

function ruleAdBudgetConcentration(client: any, accountId: string, campaignRows: any[], campaignId: string, campaignName: string, resultType: string, thresholds: any, ruleTypes: Set<string>) {
  const fields = resultFieldFor(resultType);
  if (!fields) return [];
  ruleTypes.add('ad_budget_concentration');

  const through = (campaignRows as any)._through;
  const last7 = campaignRows.filter(r => r.day >= isoDaysAgo(through, 6));
  const byAd: Record<string, any> = {};
  let campaignSpend = 0, campaignResults = 0;
  for (const r of last7) {
    if (!r.ad_id) continue;
    byAd[r.ad_id] = byAd[r.ad_id] || { ad_name: r.ad_name, spend: 0, results: 0 };
    byAd[r.ad_id].spend += Number(r.amount_spent) || 0;
    byAd[r.ad_id].results += Number(r[fields.countField]) || 0;
    campaignSpend += Number(r.amount_spent) || 0;
    campaignResults += Number(r[fields.countField]) || 0;
  }
  if (campaignResults < thresholds.min_results_for_avg || campaignSpend <= 0) return [];
  const avgCost = campaignSpend / campaignResults;

  const withResults = Object.entries(byAd).filter(([, d]) => (d as any).results > 0);
  let bestAdId: string | null = null, bestCost = Infinity;
  for (const [adId, d] of withResults) {
    const cost = (d as any).spend / (d as any).results;
    if (cost < bestCost) { bestCost = cost; bestAdId = adId; }
  }

  const out = [];
  for (const [adId, d0] of Object.entries(byAd)) {
    const d = d0 as any;
    if (d.results === 0 || d.spend <= 0) continue;
    if (adId === bestAdId) continue;
    const budgetSharePct = (d.spend / campaignSpend) * 100;
    if (budgetSharePct <= thresholds.ad_concentration_budget_pct) continue;
    const adCost = d.spend / d.results;
    const underperformPct = ((adCost - avgCost) / avgCost) * 100;
    if (underperformPct < thresholds.ad_concentration_perf_gap_pct) continue;

    out.push({
      severity: 'warning', rule_type: 'ad_budget_concentration', entity_level: 'ad', entity_id: adId, entity_name: d.ad_name,
      title: `${client.business_name} / ${d.ad_name}: ריכוז תקציב במודעה חלשה`,
      explanation: `המודעה "${d.ad_name}" בקמפיין "${campaignName}" צרכה ${budgetSharePct.toFixed(0)}% מתקציב הקמפיין (7 ימים) ועלות התוצאה שלה (${adCost.toFixed(1)}) גרועה ב-${underperformPct.toFixed(0)}% מהממוצע בקמפיין (${avgCost.toFixed(1)}).`,
      recommendation: 'לשקול הקטנת תקציב למודעה זו לטובת מודעות עם עלות תוצאה טובה יותר.',
      evidence_json: {
        campaign_id: campaignId, campaign_name: campaignName, result_type: resultType,
        ad_spend_7d: Number(d.spend.toFixed(2)), budget_share_pct: Number(budgetSharePct.toFixed(1)),
        ad_cost_per_result: Number(adCost.toFixed(2)), campaign_avg_cost_per_result: Number(avgCost.toFixed(2)),
        underperform_pct: Number(underperformPct.toFixed(1))
      }
    });
  }
  return out;
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
        explanation: `המודעה "${d.ad_name}" פעילה אך הוציאה רק ${d.spend.toFixed(1)} ב-3 הימים האחרונים, מול חציון ${median.toFixed(1)} בקרב המודעות הפעילות בקמפיין "${campaignName}".`,
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

    const { data: rows, error: rErr } = await supabase
      .from('meta_ad_daily')
      .select('*')
      .eq('account_id', mapping.account_id)
      .gte('day', since)
      .lte('day', dataThrough);
    if (rErr || !rows || rows.length === 0) continue;
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

      if (['purchase', 'message', 'lead'].includes(resultType)) {
        candidates.push(...ruleZeroResultBurn(client, mapping.account_id, campaignRows, campaignId, campaignName, resultType, thresholds, ruleTypesEvaluated));
        candidates.push(...ruleCreativeGap(client, mapping.account_id, campaignRows, campaignId, campaignName, resultType, thresholds, ruleTypesEvaluated));
        candidates.push(...ruleAdBudgetConcentration(client, mapping.account_id, campaignRows, campaignId, campaignName, resultType, thresholds, ruleTypesEvaluated));
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
