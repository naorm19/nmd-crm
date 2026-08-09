-- ============================================================
--  Meta Ads Ingestion & Analysis - Migration
--  Idempotent: safe to re-run. Does NOT touch clients/campaigns/
--  daily_insights or anything used by the existing Google Ads sync.
-- ============================================================

-- ── ENUMS (idempotent) ──────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE meta_import_status AS ENUM ('processing', 'success', 'partial', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meta_alert_severity AS ENUM ('critical', 'warning', 'info');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meta_alert_status AS ENUM ('open', 'acknowledged', 'snoozed', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meta_entity_level AS ENUM ('ad', 'adset', 'campaign', 'account');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meta_result_type AS ENUM ('purchase', 'message', 'lead', 'traffic', 'video', 'none');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meta_config_status AS ENUM ('auto_matched', 'manual', 'needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. meta_imports (created first: meta_ad_daily references it) ──
CREATE TABLE IF NOT EXISTS meta_imports (
  id                SERIAL PRIMARY KEY,
  source_file_name  TEXT NOT NULL,
  imported_at       TIMESTAMPTZ DEFAULT NOW(),
  period_start      DATE,
  data_through      DATE NOT NULL,
  row_count         INT NOT NULL,
  inserted_count    INT DEFAULT 0,
  updated_count     INT DEFAULT 0,
  status            meta_import_status DEFAULT 'processing',
  error_message     TEXT,
  checksum          TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. meta_account_mappings ─────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_account_mappings (
  id            SERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL UNIQUE,
  account_name  TEXT NOT NULL,
  client_id     INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. meta_ad_daily (39 source columns + management columns) ──
CREATE TABLE IF NOT EXISTS meta_ad_daily (
  id                                  SERIAL PRIMARY KEY,
  client_id                           INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id                          TEXT NOT NULL,
  account_name                        TEXT,
  day                                 DATE NOT NULL,
  campaign_name                       TEXT,
  campaign_id                         TEXT,
  campaign_delivery                   TEXT,
  campaign_budget                     NUMERIC NULL,
  campaign_budget_raw                 TEXT NULL,
  campaign_budget_type                TEXT,
  adset_name                          TEXT,
  adset_id                            TEXT,
  adset_delivery                      TEXT,
  adset_budget                        NUMERIC NULL,
  adset_budget_raw                    TEXT NULL,
  adset_budget_type                   TEXT,
  ad_name                             TEXT,
  ad_id                               TEXT NOT NULL,
  ad_delivery                         TEXT,
  objective                           TEXT,
  currency                            TEXT,
  amount_spent                        NUMERIC(12,2),
  frequency                           NUMERIC(8,2),
  leads                               INT,
  messaging_conversations_started     INT,
  purchases                           INT,
  cpm                                 NUMERIC(10,2),
  cost_per_messaging_conversation     NUMERIC(10,2),
  cost_per_purchase                   NUMERIC(10,2),
  post_engagements                    INT,
  cost_per_post_engagement            NUMERIC(10,2),
  post_reactions                      INT,
  post_comments                       INT,
  post_shares                         INT,
  video_plays_3_seconds               INT,
  video_plays_25_percent              INT,
  video_plays_50_percent              INT,
  video_plays_75_percent              INT,
  video_plays_95_percent              INT,
  video_plays_100_percent             INT,
  reporting_starts                    DATE,
  reporting_ends                      DATE,
  -- SET NULL, not CASCADE: deleting an import record must never delete ad data
  source_import_id                    INT NULL REFERENCES meta_imports(id) ON DELETE SET NULL,
  created_at                          TIMESTAMPTZ DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, day, ad_id)
);

-- ── 4. meta_analysis_config ──────────────────────────────────
-- No monthly_budget field here: budget truth lives in clients.monthly_budget.
CREATE TABLE IF NOT EXISTS meta_analysis_config (
  id                      SERIAL PRIMARY KEY,
  client_id               INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id              TEXT NOT NULL,
  campaign_id             TEXT NOT NULL,
  campaign_name           TEXT,
  result_type             meta_result_type NOT NULL,
  expected_active         BOOLEAN DEFAULT TRUE,
  thresholds              JSONB DEFAULT '{}'::JSONB,
  configuration_status    meta_config_status DEFAULT 'needs_review',
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, campaign_id)
);

-- ── 5. meta_alerts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_alerts (
  id                  SERIAL PRIMARY KEY,
  client_id           INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL,
  severity            meta_alert_severity NOT NULL,
  rule_type           TEXT NOT NULL,
  entity_level        meta_entity_level NOT NULL,
  entity_id           TEXT,
  entity_name         TEXT,
  title               TEXT NOT NULL,
  explanation         TEXT,
  evidence_json       JSONB,
  recommendation      TEXT,
  data_through        DATE,
  fingerprint         TEXT NOT NULL,
  status              meta_alert_status DEFAULT 'open',
  first_detected_at   TIMESTAMPTZ DEFAULT NOW(),
  last_detected_at    TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at     TIMESTAMPTZ,
  snoozed_until       TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_client_day    ON meta_ad_daily(client_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_account_day   ON meta_ad_daily(account_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_campaign_day  ON meta_ad_daily(campaign_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_ad_day        ON meta_ad_daily(ad_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_meta_alerts_client_status    ON meta_alerts(client_id, status);
-- meta_account_mappings.account_id already has an implicit unique index (UNIQUE constraint) - no extra index needed.

-- Partial unique index: same problem (client+fingerprint) cannot have two
-- simultaneously-active alerts, but CAN re-open after a previous one resolved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_alerts_active_fingerprint
  ON meta_alerts(client_id, fingerprint)
  WHERE status IN ('open', 'acknowledged', 'snoozed');

-- ============================================================
--  TRIGGERS: updated_at
--  Namespaced function (meta_set_updated_at) so this migration
--  never collides with any generic updated_at trigger function
--  that may already exist elsewhere in this Supabase project.
-- ============================================================
CREATE OR REPLACE FUNCTION public.meta_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meta_imports_updated_at ON meta_imports;
CREATE TRIGGER trg_meta_imports_updated_at BEFORE UPDATE ON meta_imports
FOR EACH ROW EXECUTE FUNCTION public.meta_set_updated_at();

DROP TRIGGER IF EXISTS trg_meta_account_mappings_updated_at ON meta_account_mappings;
CREATE TRIGGER trg_meta_account_mappings_updated_at BEFORE UPDATE ON meta_account_mappings
FOR EACH ROW EXECUTE FUNCTION public.meta_set_updated_at();

DROP TRIGGER IF EXISTS trg_meta_ad_daily_updated_at ON meta_ad_daily;
CREATE TRIGGER trg_meta_ad_daily_updated_at BEFORE UPDATE ON meta_ad_daily
FOR EACH ROW EXECUTE FUNCTION public.meta_set_updated_at();

DROP TRIGGER IF EXISTS trg_meta_analysis_config_updated_at ON meta_analysis_config;
CREATE TRIGGER trg_meta_analysis_config_updated_at BEFORE UPDATE ON meta_analysis_config
FOR EACH ROW EXECUTE FUNCTION public.meta_set_updated_at();

DROP TRIGGER IF EXISTS trg_meta_alerts_updated_at ON meta_alerts;
CREATE TRIGGER trg_meta_alerts_updated_at BEFORE UPDATE ON meta_alerts
FOR EACH ROW EXECUTE FUNCTION public.meta_set_updated_at();

-- ============================================================
--  RPC #1: import_meta_daily_atomic
--
--  All-or-nothing:
--   - creates the meta_imports row FIRST (always, so there is an
--     audit trail even for a rejected batch)
--   - then validates: required fields, no duplicate keys inside the
--     batch, no unmapped account_ids
--   - any failure -> meta_imports marked 'failed' with error_message,
--     ZERO rows touched in meta_ad_daily (the nested block uses an
--     implicit savepoint, so only work after the initial import
--     insert is rolled back)
--   - insert/update counts are computed explicitly BEFORE the
--     upsert by counting which keys already exist - not by reading
--     xmax after the fact
-- ============================================================
CREATE OR REPLACE FUNCTION public.import_meta_daily_atomic(
  p_source_file_name TEXT,
  p_period_start DATE,
  p_data_through DATE,
  p_rows JSONB
)
RETURNS TABLE(
  import_id       INT,
  inserted_count  INT,
  updated_count   INT,
  row_count       INT,
  status          TEXT,
  error_message   TEXT
) AS $$
DECLARE
  v_import_id        INT;
  v_total             INT;
  v_missing_accounts  TEXT;
  v_invalid_rows      INT;
  v_distinct_keys     INT;
  v_existing          INT;
  v_inserted          INT;
  v_updated           INT;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN QUERY SELECT NULL::INT, 0, 0, 0, 'failed'::TEXT, 'No rows provided'::TEXT;
    RETURN;
  END IF;

  v_total := jsonb_array_length(p_rows);

  -- Always create the import record first, outside the exception block,
  -- so a validation failure still leaves an auditable 'failed' row.
  INSERT INTO meta_imports(source_file_name, period_start, data_through, row_count, status)
  VALUES (p_source_file_name, p_period_start, p_data_through, v_total, 'processing')
  RETURNING id INTO v_import_id;

  BEGIN
    CREATE TEMP TABLE _meta_stage ON COMMIT DROP AS
    SELECT
      NULLIF(elem->>'account_id', '')                           AS account_id,
      NULLIF(elem->>'account_name', '')                         AS account_name,
      NULLIF(elem->>'day', '')::DATE                            AS day,
      NULLIF(elem->>'campaign_name', '')                        AS campaign_name,
      NULLIF(elem->>'campaign_id', '')                          AS campaign_id,
      NULLIF(elem->>'campaign_delivery', '')                    AS campaign_delivery,
      NULLIF(elem->>'campaign_budget', '')::NUMERIC              AS campaign_budget,
      NULLIF(elem->>'campaign_budget_raw', '')                  AS campaign_budget_raw,
      NULLIF(elem->>'campaign_budget_type', '')                 AS campaign_budget_type,
      NULLIF(elem->>'adset_name', '')                           AS adset_name,
      NULLIF(elem->>'adset_id', '')                             AS adset_id,
      NULLIF(elem->>'adset_delivery', '')                       AS adset_delivery,
      NULLIF(elem->>'adset_budget', '')::NUMERIC                 AS adset_budget,
      NULLIF(elem->>'adset_budget_raw', '')                     AS adset_budget_raw,
      NULLIF(elem->>'adset_budget_type', '')                    AS adset_budget_type,
      NULLIF(elem->>'ad_name', '')                              AS ad_name,
      NULLIF(elem->>'ad_id', '')                                AS ad_id,
      NULLIF(elem->>'ad_delivery', '')                          AS ad_delivery,
      NULLIF(elem->>'objective', '')                            AS objective,
      NULLIF(elem->>'currency', '')                             AS currency,
      NULLIF(elem->>'amount_spent', '')::NUMERIC                 AS amount_spent,
      NULLIF(elem->>'frequency', '')::NUMERIC                    AS frequency,
      NULLIF(elem->>'leads', '')::INT                            AS leads,
      NULLIF(elem->>'messaging_conversations_started', '')::INT  AS messaging_conversations_started,
      NULLIF(elem->>'purchases', '')::INT                        AS purchases,
      NULLIF(elem->>'cpm', '')::NUMERIC                          AS cpm,
      NULLIF(elem->>'cost_per_messaging_conversation', '')::NUMERIC AS cost_per_messaging_conversation,
      NULLIF(elem->>'cost_per_purchase', '')::NUMERIC            AS cost_per_purchase,
      NULLIF(elem->>'post_engagements', '')::INT                 AS post_engagements,
      NULLIF(elem->>'cost_per_post_engagement', '')::NUMERIC     AS cost_per_post_engagement,
      NULLIF(elem->>'post_reactions', '')::INT                   AS post_reactions,
      NULLIF(elem->>'post_comments', '')::INT                    AS post_comments,
      NULLIF(elem->>'post_shares', '')::INT                      AS post_shares,
      NULLIF(elem->>'video_plays_3_seconds', '')::INT            AS video_plays_3_seconds,
      NULLIF(elem->>'video_plays_25_percent', '')::INT           AS video_plays_25_percent,
      NULLIF(elem->>'video_plays_50_percent', '')::INT           AS video_plays_50_percent,
      NULLIF(elem->>'video_plays_75_percent', '')::INT           AS video_plays_75_percent,
      NULLIF(elem->>'video_plays_95_percent', '')::INT           AS video_plays_95_percent,
      NULLIF(elem->>'video_plays_100_percent', '')::INT          AS video_plays_100_percent,
      NULLIF(elem->>'reporting_starts', '')::DATE                AS reporting_starts,
      NULLIF(elem->>'reporting_ends', '')::DATE                  AS reporting_ends
    FROM jsonb_array_elements(p_rows) AS elem;

    -- Required fields
    SELECT COUNT(*) INTO v_invalid_rows
    FROM _meta_stage
    WHERE account_id IS NULL OR day IS NULL OR ad_id IS NULL;

    IF v_invalid_rows > 0 THEN
      RAISE EXCEPTION 'Missing required field(s) account_id/day/ad_id in % row(s)', v_invalid_rows;
    END IF;

    -- Duplicate keys within the same batch
    SELECT COUNT(*) INTO v_distinct_keys FROM (
      SELECT DISTINCT account_id, day, ad_id FROM _meta_stage
    ) x;

    IF v_distinct_keys <> v_total THEN
      RAISE EXCEPTION 'Duplicate account_id+day+ad_id combinations in batch: % distinct out of % rows',
        v_distinct_keys, v_total;
    END IF;

    -- Unmapped / inactive accounts
    SELECT string_agg(DISTINCT s.account_id, ', ') INTO v_missing_accounts
    FROM _meta_stage s
    LEFT JOIN meta_account_mappings m ON m.account_id = s.account_id AND m.active = TRUE
    WHERE m.account_id IS NULL;

    IF v_missing_accounts IS NOT NULL THEN
      RAISE EXCEPTION 'Unmapped or inactive account_id(s): %', v_missing_accounts;
    END IF;

    -- Explicit pre-count: how many of these keys already exist
    SELECT COUNT(*) INTO v_existing
    FROM meta_ad_daily d
    JOIN _meta_stage s
      ON d.account_id = s.account_id AND d.day = s.day AND d.ad_id = s.ad_id;

    v_updated  := v_existing;
    v_inserted := v_distinct_keys - v_existing;

    -- Upsert (full column refresh on conflict - the latest monthly
    -- export is the source of truth even for previously-seen rows)
    INSERT INTO meta_ad_daily (
      client_id, account_id, account_name, day, campaign_name, campaign_id, campaign_delivery,
      campaign_budget, campaign_budget_raw, campaign_budget_type, adset_name, adset_id, adset_delivery,
      adset_budget, adset_budget_raw, adset_budget_type, ad_name, ad_id, ad_delivery, objective, currency,
      amount_spent, frequency, leads, messaging_conversations_started, purchases, cpm,
      cost_per_messaging_conversation, cost_per_purchase, post_engagements, cost_per_post_engagement,
      post_reactions, post_comments, post_shares, video_plays_3_seconds, video_plays_25_percent,
      video_plays_50_percent, video_plays_75_percent, video_plays_95_percent, video_plays_100_percent,
      reporting_starts, reporting_ends, source_import_id
    )
    SELECT
      m.client_id, s.account_id, s.account_name, s.day, s.campaign_name, s.campaign_id, s.campaign_delivery,
      s.campaign_budget, s.campaign_budget_raw, s.campaign_budget_type, s.adset_name, s.adset_id, s.adset_delivery,
      s.adset_budget, s.adset_budget_raw, s.adset_budget_type, s.ad_name, s.ad_id, s.ad_delivery, s.objective, s.currency,
      s.amount_spent, s.frequency, s.leads, s.messaging_conversations_started, s.purchases, s.cpm,
      s.cost_per_messaging_conversation, s.cost_per_purchase, s.post_engagements, s.cost_per_post_engagement,
      s.post_reactions, s.post_comments, s.post_shares, s.video_plays_3_seconds, s.video_plays_25_percent,
      s.video_plays_50_percent, s.video_plays_75_percent, s.video_plays_95_percent, s.video_plays_100_percent,
      s.reporting_starts, s.reporting_ends, v_import_id
    FROM _meta_stage s
    JOIN meta_account_mappings m ON m.account_id = s.account_id AND m.active = TRUE
    ON CONFLICT (account_id, day, ad_id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      account_name = EXCLUDED.account_name,
      campaign_name = EXCLUDED.campaign_name,
      campaign_id = EXCLUDED.campaign_id,
      campaign_delivery = EXCLUDED.campaign_delivery,
      campaign_budget = EXCLUDED.campaign_budget,
      campaign_budget_raw = EXCLUDED.campaign_budget_raw,
      campaign_budget_type = EXCLUDED.campaign_budget_type,
      adset_name = EXCLUDED.adset_name,
      adset_id = EXCLUDED.adset_id,
      adset_delivery = EXCLUDED.adset_delivery,
      adset_budget = EXCLUDED.adset_budget,
      adset_budget_raw = EXCLUDED.adset_budget_raw,
      adset_budget_type = EXCLUDED.adset_budget_type,
      ad_name = EXCLUDED.ad_name,
      ad_delivery = EXCLUDED.ad_delivery,
      objective = EXCLUDED.objective,
      currency = EXCLUDED.currency,
      amount_spent = EXCLUDED.amount_spent,
      frequency = EXCLUDED.frequency,
      leads = EXCLUDED.leads,
      messaging_conversations_started = EXCLUDED.messaging_conversations_started,
      purchases = EXCLUDED.purchases,
      cpm = EXCLUDED.cpm,
      cost_per_messaging_conversation = EXCLUDED.cost_per_messaging_conversation,
      cost_per_purchase = EXCLUDED.cost_per_purchase,
      post_engagements = EXCLUDED.post_engagements,
      cost_per_post_engagement = EXCLUDED.cost_per_post_engagement,
      post_reactions = EXCLUDED.post_reactions,
      post_comments = EXCLUDED.post_comments,
      post_shares = EXCLUDED.post_shares,
      video_plays_3_seconds = EXCLUDED.video_plays_3_seconds,
      video_plays_25_percent = EXCLUDED.video_plays_25_percent,
      video_plays_50_percent = EXCLUDED.video_plays_50_percent,
      video_plays_75_percent = EXCLUDED.video_plays_75_percent,
      video_plays_95_percent = EXCLUDED.video_plays_95_percent,
      video_plays_100_percent = EXCLUDED.video_plays_100_percent,
      reporting_starts = EXCLUDED.reporting_starts,
      reporting_ends = EXCLUDED.reporting_ends,
      source_import_id = EXCLUDED.source_import_id;

    UPDATE meta_imports SET
      inserted_count = v_inserted,
      updated_count = v_updated,
      status = 'success'
    WHERE id = v_import_id;

    RETURN QUERY SELECT v_import_id, v_inserted, v_updated, v_total, 'success'::TEXT, NULL::TEXT;

  EXCEPTION WHEN OTHERS THEN
    -- Savepoint rollback: undoes the temp table + any partial work done
    -- inside this block, but the 'processing' meta_imports row from
    -- before the block survives so there is always an audit trail.
    UPDATE meta_imports SET status = 'failed', error_message = SQLERRM
    WHERE id = v_import_id;

    RETURN QUERY SELECT v_import_id, 0, 0, v_total, 'failed'::TEXT, SQLERRM;
  END;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
--  Lock down RPC execution: backend/service_role only.
--  Never callable from the dashboard's anon key.
-- ============================================================
REVOKE ALL ON FUNCTION public.import_meta_daily_atomic(TEXT, DATE, DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_meta_daily_atomic(TEXT, DATE, DATE, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.import_meta_daily_atomic(TEXT, DATE, DATE, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.import_meta_daily_atomic(TEXT, DATE, DATE, JSONB) TO service_role;

-- ============================================================
--  Row Level Security
--
--  CORRECTED: the previous version of this migration granted
--  anon SELECT on meta_ad_daily/meta_alerts/meta_imports on the
--  reasoning that it "matches how the dashboard already reads
--  everything else." That reasoning was wrong to extend to new
--  tables: the dashboard's shared NMD123 localStorage flag is not
--  authentication - it doesn't gate who holds the anon key, it
--  only gates one static password prompt in the browser. The
--  anon key itself is embedded in nmd-dashboard's page source,
--  so anon SELECT = world-readable client ad spend and Meta
--  performance data to anyone who views source. Existing tables
--  already have this exposure; this migration must not add MORE
--  data to it.
--
--  So: every meta_* table is service_role-only, full stop. No
--  anon/authenticated policy, no anon/authenticated GRANT, on any
--  of the five tables. RLS enabled with zero permissive policies
--  denies anon/authenticated even though PostgREST exposes the
--  table.
--
--  CONSEQUENCE (see open blockers in the review reply): the
--  dashboard cannot read meta_imports/meta_ad_daily/meta_alerts
--  directly via its current anon-key setup. The "last sync
--  status" and "alert banner" UI need a protected server-side
--  endpoint (e.g. an Express route in files1/ using
--  SUPABASE_SERVICE_ROLE_KEY, called from the browser instead of
--  PostgREST directly) - not built in this migration.
-- ============================================================
ALTER TABLE meta_ad_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_alerts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_imports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_analysis_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_account_mappings ENABLE ROW LEVEL SECURITY;

-- Explicitly drop any policy that may exist from a prior run of an
-- earlier version of this migration - re-running this file must
-- leave zero anon/authenticated policies on these tables.
DROP POLICY IF EXISTS meta_ad_daily_anon_select ON meta_ad_daily;
DROP POLICY IF EXISTS meta_alerts_anon_select ON meta_alerts;
DROP POLICY IF EXISTS meta_imports_anon_select ON meta_imports;

-- No CREATE POLICY for anon/authenticated on any meta_* table.
-- RLS enabled + zero policies = denied for every role except
-- service_role (which bypasses RLS by definition in Supabase).

-- Revoke in case a prior run of an earlier version of this file
-- already granted these (re-running this migration must converge
-- to service_role-only regardless of starting state).
REVOKE ALL ON meta_ad_daily, meta_alerts, meta_imports, meta_analysis_config, meta_account_mappings
  FROM anon, authenticated;

GRANT ALL ON meta_ad_daily, meta_alerts, meta_imports, meta_analysis_config, meta_account_mappings TO service_role;
-- Scoped to only the sequences this migration created (not a blanket
-- grant on every sequence in the schema).
GRANT USAGE, SELECT ON
  meta_imports_id_seq, meta_account_mappings_id_seq, meta_ad_daily_id_seq,
  meta_analysis_config_id_seq, meta_alerts_id_seq
  TO service_role;

-- ============================================================
--  VERIFICATION QUERIES - run these after applying the migration
-- ============================================================
-- Tables:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name LIKE 'meta_%';
--
-- RPC:
--   SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public' AND routine_name = 'import_meta_daily_atomic';
--
-- Indexes:
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename LIKE 'meta_%';
--
-- RLS enabled:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND tablename LIKE 'meta_%';
--
-- Policies (expect ZERO rows - no anon/authenticated policy on any meta_* table):
--   SELECT tablename, policyname, roles, cmd FROM pg_policies
--   WHERE schemaname = 'public' AND tablename LIKE 'meta_%';
--
-- anon/authenticated have NO table privileges on meta_* (expect ZERO rows):
--   SELECT table_name, grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name LIKE 'meta_%'
--     AND grantee IN ('anon', 'authenticated');
--
-- Triggers:
--   SELECT trigger_name FROM information_schema.triggers
--   WHERE trigger_schema = 'public' AND trigger_name LIKE 'trg_meta%';
--
-- Enums (parenthesized OR so the schema filter actually applies):
--   SELECT typname FROM pg_type
--   WHERE typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
--     AND (typname LIKE 'meta_%status%' OR typname LIKE 'meta_%severity%'
--          OR typname LIKE 'meta_%level%' OR typname LIKE 'meta_%type%');
--
-- RPC is NOT callable by anon/authenticated:
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'import_meta_daily_atomic';
--   -- expect only service_role (and definer/owner) listed
