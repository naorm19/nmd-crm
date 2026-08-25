// ============================================================
//  Meta Ads Edge Function
//  Actions: auth-check | overview | sync | resolve-alert | chat
//
//  This is the ONLY way the public dashboard (GitHub Pages,
//  static HTML with an anon key baked into the page source)
//  touches meta_* data. Those tables are service_role-only (see
//  supabase/migrations/20260809120000_meta_ads_schema.sql) - this
//  function holds SUPABASE_SERVICE_ROLE_KEY (auto-injected by
//  Supabase, never a manual secret) and never returns it, logs it,
//  or otherwise lets it reach the client.
//
//  Auth model: META_DASHBOARD_TOKEN (Edge Function secret) doubles
//  as the dashboard's login password. The browser sends whatever
//  was typed into the EXISTING login field to action=auth-check;
//  on success the browser stores that same value in sessionStorage
//  and echoes it back as X-Dashboard-Token on every later request.
//  This function is the actual gate - CORS below only affects
//  which origins a BROWSER will let read the response, it is not a
//  substitute for the token check (a non-browser caller can ignore
//  CORS entirely), so every action below checks the token itself.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchSheetRows, buildRowsFromSheetRows } from './sheet-parser.ts';
import { runAnalysis } from './analysis.ts';

const ALLOWED_ORIGIN = 'https://naorm19.github.io';

function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Token',
    'Vary': 'Origin'
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

// Constant-time-ish string compare - avoids a trivial timing side channel
// on the password/token check (same spirit as the HMAC compare already
// used in files1/webhook-server.js for Meta signature verification).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

const META_RESULT_LABELS: Record<string, string> = { purchase: 'רכישות', message: 'שיחות', lead: 'לידים' };

function israelDateString(offsetDays = 0): string {
  const now = new Date();
  const israelMs = now.getTime() + (3 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000);
  return new Date(israelMs).toISOString().split('T')[0];
}

// PostgREST caps a single .select() at 1000 rows by default. A client with
// enough ads (Asif-Market: 1250+ rows for a 20-day window) silently got a
// truncated, undercounted spend_month from a single unpaginated query - loop
// with .range() until a page comes back short.
async function fetchAllRows(supabase: any, accountIds: string[], monthStart: string, today: string) {
  const pageSize = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('meta_ad_daily')
      .select('day, amount_spent, campaign_id, purchases, messaging_conversations_started, leads')
      .in('account_id', accountIds)
      .gte('day', monthStart)
      .lte('day', today)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function handleOverview(supabase: any, clientId: number) {
  const { data: mappings, error: mErr } = await supabase
    .from('meta_account_mappings')
    .select('account_id, account_name')
    .eq('client_id', clientId)
    .eq('active', true);
  if (mErr) throw new Error(mErr.message);
  if (!mappings || mappings.length === 0) {
    return { mapped: false, message: 'No active Meta account mapped to this client.' };
  }
  const accountIds = mappings.map((m: any) => m.account_id);

  const today = israelDateString(0);
  const monthStart = today.slice(0, 7) + '-01';

  const ALERT_FIELDS = 'id, severity, title, explanation, recommendation, entity_level, entity_id, entity_name, evidence_json, data_through, last_detected_at, acknowledged_at, resolved_at, snoozed_until, status';

  const [monthRows, { data: lastImport }, { data: openOrSnoozed }, { data: closedAlerts }, { data: configs }] = await Promise.all([
    fetchAllRows(supabase, accountIds, monthStart, today),
    supabase.from('meta_imports')
      .select('status, data_through, imported_at, row_count, inserted_count, updated_count, error_message')
      .order('imported_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // 'open' alerts plus every 'snoozed' one (split into active-again vs
    // still-waiting below, by comparing snoozed_until to now here in code -
    // simpler and more portable than a compound .or() filter).
    supabase.from('meta_alerts')
      .select(ALERT_FIELDS)
      .eq('client_id', clientId)
      .in('status', ['open', 'snoozed'])
      .order('severity', { ascending: true })
      .order('last_detected_at', { ascending: false }),
    // Collapsed "show handled" section (resolved + not-relevant) - capped,
    // most recent first.
    supabase.from('meta_alerts')
      .select(ALERT_FIELDS)
      .eq('client_id', clientId)
      .in('status', ['resolved', 'acknowledged'])
      .order('last_detected_at', { ascending: false })
      .limit(30),
    supabase.from('meta_analysis_config')
      .select('campaign_id, result_type')
      .in('account_id', accountIds)
  ]);

  // Split 'snoozed' by whether the reminder date has actually arrived yet.
  // A resurfaced one gets a trend badge if we captured a comparable metric
  // when it was snoozed (see evidence_json.snoozed_snapshot, set by the
  // 'snooze' action below) - never fabricated when the shape isn't there.
  const nowIso = new Date().toISOString();
  const activeAlerts: any[] = [];
  const stillSnoozed: any[] = [];
  for (const a of (openOrSnoozed || [])) {
    if (a.status === 'snoozed' && a.snoozed_until && a.snoozed_until > nowIso) {
      stillSnoozed.push(a);
      continue;
    }
    const snap = a.evidence_json?.snoozed_snapshot;
    if (a.status === 'snoozed' && snap && typeof snap.primary_metric === 'number' && typeof a.evidence_json?.primary_metric === 'number') {
      const now = a.evidence_json.primary_metric;
      const before = snap.primary_metric;
      const lowerIsBetter = snap.lower_is_better !== false; // default true (most metrics here are costs)
      const delta = now - before;
      a.trend = Math.abs(delta) < 1e-9 ? 'unchanged' : (lowerIsBetter ? delta < 0 : delta > 0) ? 'improved' : 'worsened';
      a.trend_from = before;
      a.trend_to = now;
      a.trend_label = snap.primary_metric_label || null;
    }
    activeAlerts.push(a);
  }
  const resolvedAlerts = closedAlerts || [];

  const resultTypeByCampaign = Object.fromEntries((configs || []).map((c: any) => [c.campaign_id, c.result_type]));

  const spendToday = (monthRows || []).filter((r: any) => r.day === today).reduce((s: number, r: any) => s + (Number(r.amount_spent) || 0), 0);
  const spendMonth = (monthRows || []).reduce((s: number, r: any) => s + (Number(r.amount_spent) || 0), 0);

  const byType: Record<string, { spend: number; count: number }> = {};
  let unclassifiedSpend = 0;
  for (const r of (monthRows || [])) {
    const type = resultTypeByCampaign[r.campaign_id];
    if (!type || type === 'none') { unclassifiedSpend += Number(r.amount_spent) || 0; continue; }
    byType[type] = byType[type] || { spend: 0, count: 0 };
    byType[type].spend += Number(r.amount_spent) || 0;
    if (type === 'purchase') byType[type].count += Number(r.purchases) || 0;
    else if (type === 'message') byType[type].count += Number(r.messaging_conversations_started) || 0;
    else if (type === 'lead') byType[type].count += Number(r.leads) || 0;
  }
  const primaryResults = Object.entries(byType).map(([type, d]) => ({
    result_type: type,
    label: META_RESULT_LABELS[type] || type,
    count: ['purchase', 'message', 'lead'].includes(type) ? d.count : null,
    spend_mtd: Number(d.spend.toFixed(2)),
    cost_per_result: ['purchase', 'message', 'lead'].includes(type) && d.count > 0
      ? Number((d.spend / d.count).toFixed(2))
      : null
  }));

  return {
    mapped: true,
    account_ids: accountIds,
    spend_today: Number(spendToday.toFixed(2)),
    spend_month: Number(spendMonth.toFixed(2)),
    unclassified_spend_mtd: Number(unclassifiedSpend.toFixed(2)),
    primary_results: primaryResults,
    last_import: lastImport || null,
    alerts: activeAlerts,
    snoozed_alerts: stillSnoozed,
    resolved_alerts: resolvedAlerts
  };
}

// action: 'resolve' (טופל) | 'not_relevant' (לא רלוונטי) | 'snooze' (המשך
// מעקב, requires snooze_days) | 'reopen' (undo any of the above, back to
// the active task list).
const VALID_ALERT_ACTIONS = new Set(['resolve', 'not_relevant', 'snooze', 'reopen']);

async function handleUpdateAlertStatus(supabase: any, alertId: number, action: string, snoozeDays: number | null) {
  if (!VALID_ALERT_ACTIONS.has(action)) throw new Error(`Invalid action: ${action}`);

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;

  if (action === 'resolve') {
    patch = { status: 'resolved', resolved_at: now, acknowledged_at: null, snoozed_until: null };
  } else if (action === 'not_relevant') {
    patch = { status: 'acknowledged', acknowledged_at: now, resolved_at: null, snoozed_until: null };
  } else if (action === 'reopen') {
    patch = { status: 'open', resolved_at: null, acknowledged_at: null, snoozed_until: null };
  } else {
    // 'snooze' - capture the current evidence_json as a comparison snapshot
    // BEFORE overwriting anything, so "trend since snooze" has something to
    // diff against once the reminder fires. Never fabricated: only stored
    // when evidence_json.primary_metric already exists on this alert.
    if (!snoozeDays || snoozeDays <= 0) throw new Error('snooze_days must be a positive number');
    const { data: current, error: readErr } = await supabase
      .from('meta_alerts').select('evidence_json').eq('id', alertId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const evidence = current?.evidence_json || {};
    const nextEvidence = typeof evidence.primary_metric === 'number'
      ? { ...evidence, snoozed_snapshot: { primary_metric: evidence.primary_metric, primary_metric_label: evidence.primary_metric_label || null, lower_is_better: evidence.lower_is_better !== false, snoozed_at: now } }
      : evidence;
    const until = new Date(Date.now() + snoozeDays * 86400000).toISOString();
    patch = { status: 'snoozed', snoozed_until: until, resolved_at: null, acknowledged_at: null, evidence_json: nextEvidence };
  }

  const { data, error } = await supabase
    .from('meta_alerts')
    .update(patch)
    .eq('id', alertId)
    .select('id, status, snoozed_until')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Alert not found');
  return { ok: true, id: data.id, status: data.status, snoozed_until: data.snoozed_until };
}

// ── Meta Ads chat (Groq/Llama, Meta data only) ────────────────────────
// Runs from the Edge Function (not files1/sync-server.js) on purpose -
// sync-server.js only runs on Naor's PC, and the whole point of moving
// Meta endpoints to an Edge Function (see file header) was to stop the
// dashboard depending on that. Requires a GROQ_API_KEY secret on this
// function (separate manual step - not auto-injected like the service
// role key).
async function buildMetaChatContext(supabase: any, clientId: number) {
  const { data: client } = await supabase.from('clients').select('id, business_name').eq('id', clientId).single();
  const { data: mappings } = await supabase.from('meta_account_mappings').select('account_id').eq('client_id', clientId).eq('active', true);
  const accountIds = (mappings || []).map((m: any) => m.account_id);
  if (accountIds.length === 0) return { client, campaigns: [], alerts: [] };

  const today = israelDateString(0);
  const from30 = israelDateString(-30);
  const rows = await fetchAllRows(supabase, accountIds, from30, today) as any[];
  // fetchAllRows only selects the columns the budget/spend math needs -
  // campaign_name/purchases aren't in there, so pull those directly here
  // instead of widening that shared helper for one caller.
  const { data: detailRows } = await supabase.from('meta_ad_daily')
    .select('campaign_name, amount_spent, purchases, leads, messaging_conversations_started')
    .in('account_id', accountIds).gte('day', from30).lte('day', today);

  const byCampaign: Record<string, { spend: number; purchases: number; leads: number; messages: number }> = {};
  for (const r of (detailRows || [])) {
    const name = r.campaign_name || 'לא ידוע';
    byCampaign[name] = byCampaign[name] || { spend: 0, purchases: 0, leads: 0, messages: 0 };
    byCampaign[name].spend += Number(r.amount_spent) || 0;
    byCampaign[name].purchases += Number(r.purchases) || 0;
    byCampaign[name].leads += Number(r.leads) || 0;
    byCampaign[name].messages += Number(r.messaging_conversations_started) || 0;
  }
  const campaigns = Object.entries(byCampaign)
    .map(([name, d]) => ({
      name, spend: Number(d.spend.toFixed(2)), purchases: d.purchases, leads: d.leads, messages: d.messages,
      cost_per_purchase: d.purchases > 0 ? Number((d.spend / d.purchases).toFixed(2)) : null
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 15);

  const { data: alerts } = await supabase.from('meta_alerts')
    .select('severity, title, explanation, recommendation, entity_name, status')
    .eq('client_id', clientId)
    .in('status', ['open', 'snoozed'])
    .order('severity', { ascending: true })
    .limit(15);

  return { client, campaigns, alerts: alerts || [] };
}

async function handleMetaChat(supabase: any, clientId: number, message: string, history: Array<{ role: string; content: string }>) {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey) throw new Error('GROQ_API_KEY not configured on this Edge Function');

  const ctx = await buildMetaChatContext(supabase, clientId);
  if (!ctx.client) throw new Error('לקוח לא נמצא');

  const compact = {
    לקוח: ctx.client.business_name,
    חלון: '30 יום אחרונים',
    קמפיינים: ctx.campaigns.map(c => ({
      שם: c.name, הוצאה: c.spend, רכישות: c.purchases,
      ...(c.cost_per_purchase !== null ? { עלות_לרכישה: c.cost_per_purchase } : {}),
      ...(c.leads ? { לידים: c.leads } : {}), ...(c.messages ? { שיחות: c.messages } : {})
    })),
    התראות_פתוחות: ctx.alerts.map(a => ({ חומרה: a.severity, כותרת: a.title, ישות: a.entity_name, המלצה: a.recommendation }))
  };

  const systemPrompt = `אתה עוזר לניתוח Meta Ads של "${ctx.client.business_name}" (30 יום אחרונים). ענה בעברית, קצר וממוקד, על סמך הנתונים בלבד - אל תמציא מספרים שלא מופיעים כאן. אם נשאלת על משהו שלא קיים בנתונים, תגיד שאין מספיק מידע.
נתונים: ${JSON.stringify(compact)}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-oss-120b', max_tokens: 700, messages })
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status}`);
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Groq returned no reply');
  return { reply };
}

async function handleSync(supabase: any) {
  const rows = await fetchSheetRows();
  const { jsonRows, minDay, maxDay, summarySkipped, rowCount } = buildRowsFromSheetRows(rows);

  const { data, error } = await supabase.rpc('import_meta_daily_atomic', {
    p_source_file_name: `${Deno.env.get('META_SHEET_TAB') || 'Meta export'} (manual export)`,
    p_period_start: minDay,
    p_data_through: maxDay,
    p_rows: jsonRows
  });
  if (error) throw new Error(`Import RPC failed: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;

  if (result.status === 'failed') {
    return {
      ok: false,
      summary_skipped: summarySkipped,
      parsed_row_count: rowCount,
      import: result
    };
  }

  const analysis = await runAnalysis(supabase, maxDay);

  return {
    ok: true,
    summary_skipped: summarySkipped,
    parsed_row_count: rowCount,
    import: result,
    analysis
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Defense in depth: CORS above only stops a browser from reading a
  // cross-origin response, it does not stop the request from being made.
  // Any request that DOES carry an Origin header must match exactly.
  if (origin && origin !== ALLOWED_ORIGIN) {
    return json({ error: 'Origin not allowed' }, 403, origin);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const dashboardToken = Deno.env.get('META_DASHBOARD_TOKEN');

  if (!dashboardToken) {
    return json({ error: 'Server misconfigured: META_DASHBOARD_TOKEN not set.' }, 500, origin);
  }

  try {
    if (action === 'auth-check') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      const body = await req.json().catch(() => ({}));
      const ok = typeof body.password === 'string' && safeEqual(body.password, dashboardToken);
      return json({ ok }, ok ? 200 : 401, origin);
    }

    // Every action below requires a valid token - this is the real gate,
    // independent of CORS/Origin.
    const suppliedToken = req.headers.get('X-Dashboard-Token') || '';
    if (!safeEqual(suppliedToken, dashboardToken)) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }

    const supabase = getSupabase();

    if (action === 'overview') {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin);
      const clientId = parseInt(url.searchParams.get('client_id') || '', 10);
      if (!Number.isInteger(clientId)) return json({ error: 'Invalid client_id' }, 400, origin);
      const data = await handleOverview(supabase, clientId);
      return json(data, 200, origin);
    }

    if (action === 'sync') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      const data = await handleSync(supabase);
      return json(data, data.ok === false ? 502 : 200, origin);
    }

    if (action === 'resolve-alert') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      const body = await req.json().catch(() => ({}));
      const alertId = parseInt(body.alert_id, 10);
      if (!Number.isInteger(alertId)) return json({ error: 'Invalid alert_id' }, 400, origin);
      // action defaults to 'resolve' for backward compatibility with the old
      // { resolved: true/false } shape (resolved:false === 'reopen').
      const alertAction = typeof body.action === 'string' ? body.action : (body.resolved === false ? 'reopen' : 'resolve');
      const snoozeDays = Number.isFinite(body.snooze_days) ? Number(body.snooze_days) : null;
      const data = await handleUpdateAlertStatus(supabase, alertId, alertAction, snoozeDays);
      return json(data, 200, origin);
    }

    if (action === 'chat') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      const body = await req.json().catch(() => ({}));
      const clientId = parseInt(body.client_id, 10);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const history = Array.isArray(body.history) ? body.history : [];
      if (!Number.isInteger(clientId)) return json({ error: 'Invalid client_id' }, 400, origin);
      if (!message) return json({ error: 'Empty message' }, 400, origin);
      const data = await handleMetaChat(supabase, clientId, message, history);
      return json(data, 200, origin);
    }

    return json({ error: 'Unknown or missing action. Use auth-check | overview | sync | resolve-alert | chat.' }, 400, origin);
  } catch (e) {
    console.error('[meta-ads]', e instanceof Error ? e.message : String(e));
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500, origin);
  }
});
