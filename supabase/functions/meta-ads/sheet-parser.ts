// ============================================================
//  Meta Ads Sheet parsing + authenticated Google Sheets API v4 read.
//  Ported from files1/meta-sheets-sync.js - same logic, Deno runtime
//  (Deno.env.get instead of process.env, global fetch instead of
//  node-fetch, no CLI runner block - this module only exports
//  building blocks used by index.ts's action=sync handler).
//
//  PRIVATE-SHEET ACCESS: the Sheet stays fully private - no "Anyone
//  with the link" sharing. Authenticates as a real Google user via
//  OAuth2 (GOOGLE_CLIENT_ID/SECRET + a dedicated GOOGLE_SHEETS_
//  REFRESH_TOKEN, scope spreadsheets.readonly only - kept separate
//  from the Google Ads refresh token used elsewhere in this repo).
// ============================================================

// Verified 2026-08-09 via a direct read-only fetch of the real "META_RAW"
// tab's header row (A1:AO1). The export no longer has the two duplicated
// "Campaign name" / "Ad name" columns that an earlier version of this
// sheet had (39 columns now, not 41) - every header appears exactly once,
// in the same relative order as before minus those two duplicates.
export const EXPECTED_HEADERS = [
  'Account name', 'Campaign name', 'Ad name', 'Account ID', 'Day', 'Frequency',
  'Currency', 'Amount spent (ILS)', 'Leads', 'Messaging conversations started',
  'Reporting starts', 'Campaign ID', 'Ad set name', 'Ad set ID', 'Ad ID',
  'Ad Delivery', 'Ad set delivery', 'Campaign Delivery',
  'Objective', 'Ad Set Budget', 'Ad Set Budget Type', 'Campaign Budget',
  'Campaign Budget Type', 'CPM (cost per 1,000 impressions)',
  'Cost per messaging conversation started', 'Purchases', 'Cost per purchase',
  'Post engagements', 'Cost per post engagement', 'Post reactions',
  'Post comments', 'Post shares', 'Video plays at 25%', 'Video plays at 50%',
  'Video plays at 75%', 'Video plays at 95%', 'Video plays at 100%',
  '3-second video plays', 'Reporting ends'
];

const FIELD_BY_HEADER_TEXT: Record<string, string> = {
  'Account name': 'account_name',
  'Campaign name': 'campaign_name',
  'Ad name': 'ad_name',
  'Account ID': 'account_id',
  'Day': 'day',
  'Frequency': 'frequency',
  'Currency': 'currency',
  'Amount spent (ILS)': 'amount_spent',
  'Leads': 'leads',
  'Messaging conversations started': 'messaging_conversations_started',
  'Reporting starts': 'reporting_starts',
  'Campaign ID': 'campaign_id',
  'Ad set name': 'adset_name',
  'Ad set ID': 'adset_id',
  'Ad ID': 'ad_id',
  'Ad Delivery': 'ad_delivery',
  'Ad set delivery': 'adset_delivery',
  'Campaign Delivery': 'campaign_delivery',
  'Objective': 'objective',
  'Ad Set Budget': 'adset_budget',
  'Ad Set Budget Type': 'adset_budget_type',
  'Campaign Budget': 'campaign_budget',
  'Campaign Budget Type': 'campaign_budget_type',
  'CPM (cost per 1,000 impressions)': 'cpm',
  'Cost per messaging conversation started': 'cost_per_messaging_conversation',
  'Purchases': 'purchases',
  'Cost per purchase': 'cost_per_purchase',
  'Post engagements': 'post_engagements',
  'Cost per post engagement': 'cost_per_post_engagement',
  'Post reactions': 'post_reactions',
  'Post comments': 'post_comments',
  'Post shares': 'post_shares',
  'Video plays at 25%': 'video_plays_25_percent',
  'Video plays at 50%': 'video_plays_50_percent',
  'Video plays at 75%': 'video_plays_75_percent',
  'Video plays at 95%': 'video_plays_95_percent',
  'Video plays at 100%': 'video_plays_100_percent',
  '3-second video plays': 'video_plays_3_seconds',
  'Reporting ends': 'reporting_ends'
};

// No duplicated headers in the real export anymore - kept as an empty,
// still-wired-up mechanism (not deleted) so it costs nothing to re-populate
// if Meta's export format reintroduces a duplicate column later.
export const DUPLICATE_FIELDS: { headerText: string; field: string }[] = [];

export function normalizePlaceholder(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (s === '') return '';
  if (s === '-' || s === '--') return '';
  if (s.toLowerCase() === 'n/a') return '';
  return s;
}

export function validateHeaderRow(headerRow: unknown[]) {
  const actual = headerRow.map(h => String(h ?? '').trim());

  if (actual.length !== EXPECTED_HEADERS.length) {
    throw new Error(
      `Header row has ${actual.length} column(s), expected ${EXPECTED_HEADERS.length}. ` +
      `Got: [${actual.join(' | ')}]`
    );
  }

  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    if (actual[i] !== EXPECTED_HEADERS[i]) {
      throw new Error(
        `Header mismatch at column ${i + 1}: expected "${EXPECTED_HEADERS[i]}", got "${actual[i]}". ` +
        `The sheet layout changed - update EXPECTED_HEADERS after confirming the new layout with Naor.`
      );
    }
  }

  const indicesByHeaderText: Record<string, number[]> = {};
  actual.forEach((h, idx) => {
    if (!indicesByHeaderText[h]) indicesByHeaderText[h] = [];
    indicesByHeaderText[h].push(idx);
  });

  return { indicesByHeaderText };
}

export function detectSummaryRow(firstDataRow: unknown[], indicesByHeaderText: Record<string, number[]>) {
  const campaignIdIdx = indicesByHeaderText['Campaign ID'][0];
  const adIdIdx = indicesByHeaderText['Ad ID'][0];
  const campaignId = normalizePlaceholder(firstDataRow[campaignIdIdx]);
  const adId = normalizePlaceholder(firstDataRow[adIdIdx]);
  return campaignId === '' && adId === '';
}

function padRow(row: unknown[], width: number): unknown[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

function parseDateFlexible(raw: unknown): string | null {
  const v = normalizePlaceholder(raw);
  if (!v) return null;
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

function splitBudget(raw: unknown): { numeric: string; raw: string } {
  const v = normalizePlaceholder(raw);
  if (v === '') return { numeric: '', raw: '' };
  const cleaned = v.replace(/,/g, '').trim();
  const n = Number(cleaned);
  return { numeric: Number.isFinite(n) && cleaned !== '' ? String(n) : '', raw: v };
}

function numericCell(raw: unknown): string {
  const v = normalizePlaceholder(raw);
  return v === '' ? '' : v.replace(/,/g, '');
}

export interface BuildResult {
  jsonRows: Record<string, string | null>[];
  minDay: string | null;
  maxDay: string | null;
  summarySkipped: boolean;
  rowCount: number;
}

// Core row-building pipeline (pure - no network/DB, unit-testable).
// Takes raw Sheets API rows (header + data, ragged arrays), returns
// { jsonRows, minDay, maxDay, summarySkipped, rowCount }. Throws on
// structural problems (bad header, conflicting duplicate-header values).
export function buildRowsFromSheetRows(rawRows: unknown[][]): BuildResult {
  if (rawRows.length < 1) throw new Error('Sheet has no rows at all (not even a header)');

  const rows = rawRows.map(r => padRow(r, EXPECTED_HEADERS.length));

  const { indicesByHeaderText } = validateHeaderRow(rows[0]);
  let dataRows = rows.slice(1).filter(r => r.some(c => String(c ?? '').trim() !== ''));

  let summarySkipped = false;
  if (dataRows.length > 0 && detectSummaryRow(dataRows[0], indicesByHeaderText)) {
    dataRows = dataRows.slice(1);
    summarySkipped = true;
  }

  const idxFor: Record<string, number> = {};
  for (const [headerText, field] of Object.entries(FIELD_BY_HEADER_TEXT)) {
    idxFor[field] = indicesByHeaderText[headerText][0];
  }
  const dupIdx: Record<string, { canonical: number; check: number }> = {};
  for (const { headerText, field } of DUPLICATE_FIELDS) {
    const occurrences = indicesByHeaderText[headerText];
    dupIdx[field] = { canonical: occurrences[occurrences.length - 1], check: occurrences[0] };
  }

  const dupMismatches: string[] = [];
  dataRows.forEach((row, i) => {
    for (const { field } of DUPLICATE_FIELDS) {
      const a = normalizePlaceholder(row[dupIdx[field].canonical]);
      const b = normalizePlaceholder(row[dupIdx[field].check]);
      if (a !== b) {
        dupMismatches.push(`Row ${i + 1}: "${field}" differs between columns - "${a}" vs "${b}"`);
      }
    }
  });
  if (dupMismatches.length > 0) {
    throw new Error(
      `${dupMismatches.length} row(s) have conflicting values between the duplicated header columns. ` +
      `Aborting - refusing to guess which one is correct.\n${dupMismatches.join('\n')}`
    );
  }

  let minDay: string | null = null, maxDay: string | null = null;

  const jsonRows = dataRows.map(row => {
    const day = parseDateFlexible(row[idxFor.day]);
    if (day) {
      if (!maxDay || day > maxDay) maxDay = day;
      if (!minDay || day < minDay) minDay = day;
    }

    const campaignBudget = splitBudget(row[idxFor.campaign_budget]);
    const adsetBudget = splitBudget(row[idxFor.adset_budget]);

    return {
      account_id: normalizePlaceholder(row[idxFor.account_id]),
      account_name: normalizePlaceholder(row[idxFor.account_name]),
      day,
      campaign_name: normalizePlaceholder(row[idxFor.campaign_name]),
      campaign_id: normalizePlaceholder(row[idxFor.campaign_id]),
      campaign_delivery: normalizePlaceholder(row[idxFor.campaign_delivery]),
      campaign_budget: campaignBudget.numeric,
      campaign_budget_raw: campaignBudget.raw,
      campaign_budget_type: normalizePlaceholder(row[idxFor.campaign_budget_type]),
      adset_name: normalizePlaceholder(row[idxFor.adset_name]),
      adset_id: normalizePlaceholder(row[idxFor.adset_id]),
      adset_delivery: normalizePlaceholder(row[idxFor.adset_delivery]),
      adset_budget: adsetBudget.numeric,
      adset_budget_raw: adsetBudget.raw,
      adset_budget_type: normalizePlaceholder(row[idxFor.adset_budget_type]),
      ad_name: normalizePlaceholder(row[idxFor.ad_name]),
      ad_id: normalizePlaceholder(row[idxFor.ad_id]),
      ad_delivery: normalizePlaceholder(row[idxFor.ad_delivery]),
      objective: normalizePlaceholder(row[idxFor.objective]),
      currency: normalizePlaceholder(row[idxFor.currency]),
      amount_spent: numericCell(row[idxFor.amount_spent]),
      frequency: numericCell(row[idxFor.frequency]),
      leads: numericCell(row[idxFor.leads]),
      messaging_conversations_started: numericCell(row[idxFor.messaging_conversations_started]),
      purchases: numericCell(row[idxFor.purchases]),
      cpm: numericCell(row[idxFor.cpm]),
      cost_per_messaging_conversation: numericCell(row[idxFor.cost_per_messaging_conversation]),
      cost_per_purchase: numericCell(row[idxFor.cost_per_purchase]),
      post_engagements: numericCell(row[idxFor.post_engagements]),
      cost_per_post_engagement: numericCell(row[idxFor.cost_per_post_engagement]),
      post_reactions: numericCell(row[idxFor.post_reactions]),
      post_comments: numericCell(row[idxFor.post_comments]),
      post_shares: numericCell(row[idxFor.post_shares]),
      video_plays_3_seconds: numericCell(row[idxFor.video_plays_3_seconds]),
      video_plays_25_percent: numericCell(row[idxFor.video_plays_25_percent]),
      video_plays_50_percent: numericCell(row[idxFor.video_plays_50_percent]),
      video_plays_75_percent: numericCell(row[idxFor.video_plays_75_percent]),
      video_plays_95_percent: numericCell(row[idxFor.video_plays_95_percent]),
      video_plays_100_percent: numericCell(row[idxFor.video_plays_100_percent]),
      reporting_starts: parseDateFlexible(row[idxFor.reporting_starts]) || '',
      reporting_ends: parseDateFlexible(row[idxFor.reporting_ends]) || ''
    };
  });

  return { jsonRows, minDay, maxDay, summarySkipped, rowCount: dataRows.length };
}

// ── Network layer: Google OAuth + Sheets API v4 (raw fetch, no googleapis) ──

async function getSheetsAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_SHEETS_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_SHEETS_REFRESH_TOKEN secret.');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Google Sheets token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

async function resolveTab(sheetId: string, sheetTab: string | undefined, accessToken: string): Promise<string> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Could not read spreadsheet metadata (status ${res.status}): ${JSON.stringify(data)}`);
  }

  const realTabs: string[] = (data.sheets || []).map((s: any) => s.properties.title);

  if (!sheetTab) {
    throw new Error(
      `META_SHEET_TAB is not set. Real tabs in this spreadsheet: [${realTabs.join(', ')}]. ` +
      `Set META_SHEET_TAB to the exact tab name to import from - this function will not guess.`
    );
  }
  if (!realTabs.includes(sheetTab)) {
    throw new Error(
      `META_SHEET_TAB="${sheetTab}" does not match any real tab in this spreadsheet. ` +
      `Real tabs: [${realTabs.join(', ')}]. Update the META_SHEET_TAB secret.`
    );
  }
  return sheetTab;
}

export async function fetchSheetRows(): Promise<unknown[][]> {
  const sheetId = Deno.env.get('META_SHEET_ID');
  const sheetTab = Deno.env.get('META_SHEET_TAB');
  if (!sheetId) throw new Error('META_SHEET_ID secret is not set.');

  const accessToken = await getSheetsAccessToken();
  const tab = await resolveTab(sheetId, sheetTab, accessToken);

  const range = `${tab}!A1:AM10000`; // 39 real columns (A..AM); generous row cap, actual sheet size may vary
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Could not read "${tab}" (status ${res.status}): ${JSON.stringify(data)}`);
  }

  const rows = data.values || [];
  if (rows.length < 2) throw new Error(`"${tab}" has no data rows`);
  return rows;
}
