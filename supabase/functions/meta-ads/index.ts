// ============================================================
//  Meta Ads Edge Function
//  Actions: auth-check | overview | sync | resolve-alert
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

  const [monthRows, { data: lastImport }, { data: activeAlerts }, { data: resolvedAlerts }, { data: configs }] = await Promise.all([
    fetchAllRows(supabase, accountIds, monthStart, today),
    supabase.from('meta_imports')
      .select('status, data_through, imported_at, row_count, inserted_count, updated_count, error_message')
      .order('imported_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Full active list - the panel renders these as a checkable task list,
    // not just a 3-item preview (that cap is applied client-side, only for
    // the top-of-page critical banner).
    supabase.from('meta_alerts')
      .select('id, severity, title, explanation, recommendation, entity_name, data_through, last_detected_at, status')
      .eq('client_id', clientId)
      .in('status', ['open', 'acknowledged', 'snoozed'])
      .order('severity', { ascending: true })
      .order('last_detected_at', { ascending: false }),
    // Collapsed "show resolved" section - capped, most recent first.
    supabase.from('meta_alerts')
      .select('id, severity, title, explanation, recommendation, entity_name, data_through, resolved_at, status')
      .eq('client_id', clientId)
      .eq('status', 'resolved')
      .order('resolved_at', { ascending: false })
      .limit(20),
    supabase.from('meta_analysis_config')
      .select('campaign_id, result_type')
      .in('account_id', accountIds)
  ]);

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
    alerts: activeAlerts || [],
    resolved_alerts: resolvedAlerts || []
  };
}

async function handleResolveAlert(supabase: any, alertId: number, resolved: boolean) {
  const patch = resolved
    ? { status: 'resolved', resolved_at: new Date().toISOString() }
    : { status: 'open', resolved_at: null };
  const { data, error } = await supabase
    .from('meta_alerts')
    .update(patch)
    .eq('id', alertId)
    .select('id, status')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Alert not found');
  return { ok: true, id: data.id, status: data.status };
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
      const data = await handleResolveAlert(supabase, alertId, !!body.resolved);
      return json(data, 200, origin);
    }

    return json({ error: 'Unknown or missing action. Use auth-check | overview | sync | resolve-alert.' }, 400, origin);
  } catch (e) {
    console.error('[meta-ads]', e instanceof Error ? e.message : String(e));
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500, origin);
  }
});
