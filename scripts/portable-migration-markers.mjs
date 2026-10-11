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
});
