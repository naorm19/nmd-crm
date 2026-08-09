-- ============================================================
--  MIGRATION: meta_account_mappings (+ 2 client-record corrections)
--
--  All 7 account -> client mappings below are CONFIRMED by Naor
--  directly (not inferred), including the two that only matched
--  softly on the first pass:
--    - ASBIT (368269533): confirmed same business as client_id 9.
--      That row's meta_ad_account_id was NULL before this migration -
--      corrected below.
--    - Sahar (478741898863002): confirmed "שחר מעצב שיער" IS
--      "שחר אהרוני", client_id 7. No client-row change needed,
--      the meta_ad_account_id already matched exactly.
--  Studio Sol (423153664178647) had NO existing client row at
--  all. Naor confirmed it is a new client and gave the exact
--  business name to use: "מעיין בוסון - סטודיו סול". Created
--  below with only the minimum required fields - no invented
--  monthly budget, no invented contact/business info (left NULL
--  / column default).
--
--  Idempotent: safe to re-run.
--   - The Studio Sol client is only inserted if no client row
--     with that meta_ad_account_id already exists (checked
--     explicitly - the live `clients` table has no UNIQUE
--     constraint on meta_ad_account_id to rely on instead).
--   - The ASBIT update sets the same value whether run once or
--     many times.
--   - The mapping upsert uses DO UPDATE, safe to re-run.
--
--  Reminder: files1/schema.sql is stale for this table (it shows
--  a NOT NULL `ad_account_id` column that does not exist live -
--  the real, nullable column is `meta_ad_account_id`). Confirmed
--  via a read-only SELECT against the live table.
-- ============================================================

-- ── 1. ASBIT: attach the confirmed Meta account to the existing client ──
UPDATE clients
SET meta_ad_account_id = '368269533'
WHERE id = 9;

-- ── 2. Studio Sol: create the client only if it doesn't exist yet ──
DO $$
DECLARE
  v_client_id INT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE meta_ad_account_id = '423153664178647';

  IF v_client_id IS NULL THEN
    INSERT INTO clients (business_name, meta_ad_account_id, is_active)
    VALUES ('מעיין בוסון - סטודיו סול', '423153664178647', TRUE)
    RETURNING id INTO v_client_id;
  END IF;

  -- ── 3. All 7 account -> client mappings (uses v_client_id for Studio Sol) ──
  INSERT INTO meta_account_mappings (account_id, account_name, client_id, active)
  VALUES
    ('652805331965328',  'Asif-Market',                     4,           TRUE),
    ('315478689772228',  'Burekas Ima',                      6,           TRUE),
    ('3675939476064234', 'Casa Clinic',                      8,           TRUE),
    ('2885542151561931', 'Tranquilo',                       12,           TRUE),
    ('368269533',        'ASBIT',                            9,           TRUE),
    ('478741898863002',  'Sahar Hair Designer',              7,           TRUE),
    ('423153664178647',  'Studio Sol (Maayan Boson Cohen)',  v_client_id, TRUE)
  ON CONFLICT (account_id) DO UPDATE SET
    account_name = EXCLUDED.account_name,
    client_id    = EXCLUDED.client_id,
    active       = EXCLUDED.active;
END $$;

-- Verification:
--   SELECT m.account_id, m.account_name, m.client_id, c.business_name, c.meta_ad_account_id, m.active
--   FROM meta_account_mappings m
--   JOIN clients c ON c.id = m.client_id
--   ORDER BY m.account_name;
--   -- expect 7 rows, each account_name lining up with the correct business_name,
--   -- and c.meta_ad_account_id matching m.account_id on every row.
