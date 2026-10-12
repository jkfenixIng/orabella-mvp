// Versioned, read-only schema-marker contracts for portable migrations.
//
// Every discovered migration 002+ MUST have exactly one entry here. Each query
// runs inside a READ ONLY transaction and must return one row with one boolean
// column named `present`. A new migration without a reviewed contract makes the
// planner, apply, reconcile and verify commands fail; never guess a marker.
// Changing a contract changes `markerContractsSha256` in every generated plan.
export const MARKER_CONTRACT_VERSION = 1;

// 006 ACL subjects: only roles present in pg_roles are checked, so a role absent
// from plain PostgreSQL or Supabase is treated as holding no privilege.
const APP_ROLES = `SELECT oid FROM pg_catalog.pg_roles
 WHERE rolname IN ('anon', 'authenticated', 'service_role', 'orabella_app')`;
const OPERATOR_RPCS = `SELECT oid, prosecdef, proconfig, proacl, proowner FROM pg_catalog.pg_proc
 WHERE oid IN (
   pg_catalog.to_regprocedure('public.provision_installation_owner(uuid)'),
   pg_catalog.to_regprocedure('public.break_glass_transfer_installation_owner(uuid,text)')
 )`;
// 009 ACL subjects: the invoker wrapper and the legacy function it calls.
const CASH_OPENERS = `SELECT oid, proacl, proowner FROM pg_catalog.pg_proc
 WHERE oid IN (
   pg_catalog.to_regprocedure('public.cash_open_shift_atomic(uuid,uuid,numeric,jsonb)'),
   pg_catalog.to_regprocedure('public.cash_open_shift_atomic_legacy(uuid,uuid,numeric,jsonb)')
 )`;

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
  // Beyond existence, the ACL must match 006's REVOKEs: PUBLIC and every app/API
  // role that exists (missing roles hold no privilege) cannot touch the table or
  // execute the two SECURITY DEFINER operator RPCs (pinned search_path).
  "006_installation_owner.sql": Object.freeze({
    sql: `SELECT pg_catalog.to_regclass('public.installation_owner') IS NOT NULL
   AND (SELECT count(*) FROM (${OPERATOR_RPCS}) AS rpc) = 2
   AND NOT EXISTS (
     SELECT 1 FROM (${OPERATOR_RPCS}) AS rpc
      WHERE NOT prosecdef
         OR proconfig IS NULL
         OR NOT ('search_path=pg_catalog, public' = ANY (proconfig))
   )
   AND NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_class c,
            pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid = pg_catalog.to_regclass('public.installation_owner')
        AND a.grantee = 0
        AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
   )
   AND NOT EXISTS (
     SELECT 1 FROM (${APP_ROLES}) AS r, pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('public.installation_owner')
        AND pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
   )
   AND NOT EXISTS (
     SELECT 1
       FROM (${OPERATOR_RPCS}) AS p,
            pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   )
   AND NOT EXISTS (
     SELECT 1 FROM (${APP_ROLES}) AS r, (${OPERATOR_RPCS}) AS p
      WHERE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
   )
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
  // 008: inactive methods are forced to no arqueo by the 003 trigger and the
  // coherence CHECK keeps that invariant when triggers are bypassed.
  "008_inactive_payment_method_arqueo.sql": Object.freeze({
    sql: `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = pg_catalog.to_regclass('public.payment_methods')
     AND c.conname = 'payment_methods_arqueo_coherent_check'
     AND pg_catalog.strpos(pg_catalog.pg_get_constraintdef(c.oid), 'is_active') > 0
) AND EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'payment_method_code_immutable'
     AND pg_catalog.strpos(p.prosrc, 'IF NEW.is_active IS NOT TRUE THEN') > 0
) AS present`,
  }),
  // 009: the public opening wrapper enforces C between the effective last
  // base_left (recount wins) and the register's configured base; only the
  // service role may execute the invoker wrapper or its legacy callee.
  "009_cash_opening_bounds.sql": Object.freeze({
    sql: `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.oid = pg_catalog.to_regprocedure('public.cash_open_shift_atomic(uuid,uuid,numeric,jsonb)')
     AND pg_catalog.strpos(p.prosrc, 'OPENING_ABOVE_BASE') > 0
     AND pg_catalog.strpos(p.prosrc, 'OPENING_BELOW_PREVIOUS_CLOSE') > 0
     AND pg_catalog.strpos(p.prosrc, 'OPENING_BASE_CONFLICT') > 0
     AND pg_catalog.strpos(p.prosrc, 'cash_shift_recounts') > 0
     AND pg_catalog.strpos(p.prosrc, 'FOR UPDATE OF s') > 0
) AND (SELECT count(*) FROM (${CASH_OPENERS}) AS f) = 2
  AND NOT EXISTS (
  SELECT 1
    FROM (${CASH_OPENERS}) AS f,
         pg_catalog.aclexplode(coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
) AND NOT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_roles r, (${CASH_OPENERS}) AS f
   WHERE r.rolname IN ('anon', 'authenticated')
     AND pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')
) AND (
  SELECT count(*)
    FROM pg_catalog.pg_roles r, (${CASH_OPENERS}) AS f
   WHERE r.rolname = 'service_role'
     AND pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')
) = 2 AS present`,
  }),
  // 010: server-side inventory catalog filtering, page and total.
  "010_inventory_catalog_page.sql": Object.freeze({
    sql: `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.oid = pg_catalog.to_regprocedure('public.inventory_catalog_page(text,text,integer,integer)')
     AND pg_catalog.strpos(p.prosrc, 'INVALID_STOCK_FILTER') > 0
     AND pg_catalog.strpos(p.prosrc, 'total_count') > 0
     AND pg_catalog.strpos(p.prosrc, 'count(*) OVER ()') > 0
     AND pg_catalog.strpos(p.prosrc, 'p.stock_qty > 0 AND p.stock_qty <= p.min_stock') > 0
) AS present`,
  }),
});
