// Versioned, read-only schema-marker contracts for portable migrations.
//
// Every discovered migration 002+ MUST have exactly one entry here. Each query
// runs inside a READ ONLY transaction and must return one row with one boolean
// column named `present`. A new migration without a reviewed contract makes the
// planner, apply, reconcile and verify commands fail; never guess a marker.
// Changing a contract changes `markerContractsSha256` in every generated plan.
export const MARKER_CONTRACT_VERSION = 1;

export const MIGRATION_MARKERS = Object.freeze({
  // 002: current_sede_id() reads request.jwt.claims directly instead of auth.jwt().
  "002_portable_platform.sql": Object.freeze({
    sql: `SELECT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'current_sede_id'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
     AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%request.jwt.claims%'
     AND pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%auth.jwt()%'
) AS present`,
  }),
  // 003: per-method opening balances and explicit payment-method arqueo mode.
  "003_payment_method_arqueo.sql": Object.freeze({
    sql: `SELECT pg_catalog.to_regclass('public.cash_shift_method_balances') IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_methods'
        AND column_name = 'arqueo_mode'
   ) AS present`,
  }),
  // 004: literal, case-insensitive inventory search RPC.
  "004_inventory_literal_search.sql": Object.freeze({
    sql: `SELECT pg_catalog.to_regprocedure('public.search_products_literal(text,integer,integer)') IS NOT NULL AS present`,
  }),
  // 005: whole-peso guard function, its trigger and the legacy-cents audit view.
  "005_cop_whole_peso.sql": Object.freeze({
    sql: `SELECT pg_catalog.to_regprocedure('public.assert_cop_whole_peso()') IS NOT NULL
   AND pg_catalog.to_regclass('public.cop_legacy_cents_audit') IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND t.tgname = 'trg_cop_whole_peso'
   ) AS present`,
  }),
  // 006: singleton owner table and the DB-operator-only provision/recovery boundary.
  "006_installation_owner.sql": Object.freeze({
    sql: `SELECT pg_catalog.to_regclass('public.installation_owner') IS NOT NULL
   AND pg_catalog.to_regprocedure('public.provision_installation_owner(uuid)') IS NOT NULL
   AND pg_catalog.to_regprocedure('public.break_glass_transfer_installation_owner(uuid,text)') IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'installation_owner' AND t.tgname = 'trg_installation_owner_immutable'
   )
   AND EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'user_roles' AND t.tgname = 'trg_superadmin_owner'
   ) AS present`,
  }),
  // 007: the five cap/minimum functions contain 007's exact whole-peso round() comparisons
  // (001/003 already used round() with other operands, so the expression itself is the marker).
  "007_money_cap_policy.sql": Object.freeze({
    sql: `SELECT count(*) = 5 AS present
  FROM (VALUES
    ('check_commission_payouts_cap', '', 'round(v_paid + coalesce(NEW.amount, 0)) > round(v_earned)'),
    ('check_invoice_payments_cap', '', 'round(v_paid_net + v_new_net) > round(v_total - coalesce(v_surcharge, 0))'),
    ('check_payroll_payments_cap', '', 'round(v_paid + NEW.amount) > round(v_net)'),
    ('enforce_cash_method_minimum', 'p_shift_id uuid, p_method_code text, p_amount numeric, p_old_amount numeric', 'round(v_expected) - round(p_amount) < round(round(v_opening) * 0.5)'),
    ('enforce_collection_move_minimum', '', '< round(round(v_pair.opening_base) * 0.5)')
  ) AS expected(proname, args, fragment)
  JOIN pg_catalog.pg_proc p ON p.proname = expected.proname
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE pg_catalog.pg_get_function_identity_arguments(p.oid) = expected.args
   AND pg_catalog.strpos(p.prosrc, expected.fragment) > 0`,
  }),
});
