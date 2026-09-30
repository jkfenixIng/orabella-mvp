-- migraciones_faltantes.sql — DIAGNÓSTICO de SOLO LECTURA.
--
-- NO es una migración: no crea, altera ni borra nada. No lo levanta ningún
-- runner. Se corre a mano y devuelve una fila por migración con `presente`
-- verdadero o falso, para saber QUÉ FALTA en un entorno antes de aplicar nada
-- a ciegas.
--
-- POR QUÉ EXISTE: producción tiraba
--   "column invoices.closed_at does not exist" (migración 025)
-- y un PayrollError en Administración (024/026 sobre voucher_settings).
-- O sea: el esquema estaba ATRASADO respecto del código, y el síntoma aparecía
-- como un error genérico de render, que no dice nada. Esto lo dice.
--
-- POR QUÉ MARCADORES Y NO EL REGISTRO DE MIGRACIONES: `supabase_migrations.
-- schema_migrations` sólo se llena si se aplican con la CLI. Si se pegaron a
-- mano en el SQL Editor, el registro no las ve y miente por omisión. Lo que
-- importa es si el OBJETO existe.
--
-- ALCANCE: cubre desde la 015. Las 001–014 son la base (si faltara alguna, la
-- app no arrancaría en absoluto) y 013/014/017/018 son datos y hardening sin
-- objeto verificable; no rompen la app si faltan.

WITH esperado (version, tipo, tabla, objeto, para_que) AS (
  VALUES
    ('015', 'column',   'employees',        'full_name',                  'nombre del empleado en los listados'),
    ('016', 'table',    'commission_rules', NULL,                         'reglas de comision por item y empleado'),
    ('019', 'column',   'payment_methods',  'fee_percent',                'recargo de tarjeta por metodo'),
    ('020', 'column',   'invoice_items',    'commission_value',           'comision fija del item'),
    ('021', 'nullable', 'invoices',         'client_name',                'cliente opcional (nombre nulo)'),
    ('022', 'column',   'invoices',         'closed_by',                  'quien cerro la factura'),
    ('023', 'column',   'invoice_payments', 'cash_shift_id',              'turno del cobro'),
    ('024', 'column',   'voucher_settings', 'allowed_days',               'dias habilitados para vales'),
    ('025', 'column',   'invoices',         'closed_at',                  'fecha de cierre de la factura'),
    ('026', 'column',   'voucher_settings', 'per_day_limits',             'topes por dia de vales'),
    ('027', 'column',   'products',         'commission_value',           'comision del producto'),
    ('028', 'column',   'voucher_requests', 'method_code',                'metodo arqueable del vale'),
    ('029', 'column',   'voucher_requests', 'created_by',                 'quien creo el vale'),
    ('030', 'column',   'invoice_items',    'commission_mode',            'modo de comision de la linea'),
    ('031', 'function', NULL,               'check_invoice_payments_cap', 'tope de sobrepago de factura'),
    ('033', 'table',    'cash_shift_recounts', NULL,                      'reconteo del cierre de caja'),
    ('034', 'column',   'commission_payouts', 'earned_immediate',         'tope del pago inmediato de comision'),
    ('035', 'constraint', 'payroll_periods', 'ex_payroll_periods_no_overlap', 'los dias no se nominan dos veces'),
    ('036', 'table',    'payroll_extras',   NULL,                         'pagos extraordinarios de nomina'),
    ('037', 'table',    'payroll_period_corrections', NULL,               'correcciones de periodo cerrado'),
    ('038', 'column',   'invoices',         'edit_version',               'candado de ediciones simultaneas'),
    ('039', 'function', NULL,               'replace_user_roles',         'reemplazo atomico de roles'),
    ('040', 'function', NULL,               'ensure_user_has_role',       'red de seguridad de roles, atomica')
)
SELECT
  e.version,
  e.tipo,
  coalesce(e.tabla || '.' || e.objeto, e.objeto, e.tabla) AS objeto,
  CASE
    WHEN e.tipo = 'table' THEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = coalesce(e.objeto, e.tabla))
    WHEN e.tipo = 'column' THEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = e.tabla AND column_name = e.objeto)
    WHEN e.tipo = 'nullable' THEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = e.tabla
        AND column_name = e.objeto AND is_nullable = 'YES')
    WHEN e.tipo = 'function' THEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = e.objeto)
    WHEN e.tipo = 'constraint' THEN EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = e.tabla AND c.conname = e.objeto)
  END AS presente,
  e.para_que
FROM esperado e
ORDER BY e.version;
