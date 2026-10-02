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
-- ALCANCE: cubre de la 001 a la 059. Quedan fuera la 013, la 014 y la 018
-- (sólo backfill de datos, `UPDATE` de auditoría y ajuste de permisos
-- `search_path`; no crean ni cambian un objeto consultable) y la 032 (no
-- existe). Las 001–012 son la base (si faltara alguna, la app no arrancaría);
-- se incluyen igual para que el listado sea completo.
--
-- CÓMO LEE LAS FUNCIONES: una `CREATE OR REPLACE FUNCTION` sobre una firma que
-- ya existía NO deja objeto nuevo. Por eso:
--   * las funciones se buscan por nombre Y por firma
--     (`pg_get_function_identity_arguments`), para no confundir una sobrecarga
--     con otra (por ejemplo `cash_invoice_payment_atomic` de 053 vs 056);
--   * la 055 (reescribe `check_payroll_payments_cap`, de la 007) y la 059
--     (reescribe la misma firma de cierre que la 058) se verifican además por
--     un marcador en el cuerpo (`pg_get_functiondef`), porque el nombre y la
--     firma por sí solos no distinguen la versión.
--
-- LECTURA: `presente = false` significa que esa migración no está aplicada en
-- el entorno donde se corre. Se pega el bloque entero de una sola vez.

WITH esperado (version, tipo, tabla, objeto, firma, marcador, para_que) AS (
  VALUES
    ('001', 'function',    NULL,                       'set_updated_at',                NULL, NULL,                 'disparador updated_at de la base'),
    ('002', 'table',       'users',                    NULL,                            NULL, NULL,                 'autenticacion y usuarios'),
    ('003', 'table',       'sedes',                    NULL,                            NULL, NULL,                 'sedes del negocio'),
    ('004', 'table',       'products',                 NULL,                            NULL, NULL,                 'catalogo de productos'),
    ('005', 'table',       'invoices',                 NULL,                            NULL, NULL,                 'facturas'),
    ('006', 'table',       'cash_shifts',              NULL,                            NULL, NULL,                 'turnos de caja'),
    ('007', 'table',       'payroll_periods',          NULL,                            NULL, NULL,                 'periodos de nomina'),
    ('008', 'table',       'audit_logs',               NULL,                            NULL, NULL,                 'bitacora de auditoria'),
    ('009', 'table',       'cash_shift_counts',        NULL,                            NULL, NULL,                 'conteos de cierre de turno'),
    ('010', 'table',       'cash_denominations',       NULL,                            NULL, NULL,                 'denominaciones de caja'),
    ('011', 'column',      'audit_logs',               'is_read',                       NULL, NULL,                 'bandeja de alertas: leida'),
    ('012', 'column',      'audit_logs',               'review_note',                   NULL, NULL,                 'bandeja de alertas: nota de revision'),
    ('015', 'column',      'employees',                'full_name',                     NULL, NULL,                 'nombre del empleado en los listados'),
    ('016', 'table',       'commission_rules',         NULL,                            NULL, NULL,                 'reglas de comision por item y empleado'),
    ('017', 'constraint',  'employees',                'chk_employees_payout_mode',     NULL, NULL,                 'payout_mode admite no_aplica'),
    ('019', 'column',      'payment_methods',          'fee_percent',                   NULL, NULL,                 'recargo de tarjeta por metodo'),
    ('020', 'column',      'invoice_items',            'commission_value',              NULL, NULL,                 'comision fija del item'),
    ('021', 'nullable',    'invoices',                 'client_name',                   NULL, NULL,                 'cliente opcional (nombre nulo)'),
    ('022', 'column',      'invoices',                 'closed_by',                     NULL, NULL,                 'quien cerro la factura'),
    ('023', 'column',      'invoice_payments',         'cash_shift_id',                 NULL, NULL,                 'turno del cobro'),
    ('024', 'column',      'voucher_settings',         'allowed_days',                  NULL, NULL,                 'dias habilitados para vales'),
    ('025', 'column',      'invoices',                 'closed_at',                     NULL, NULL,                 'fecha de cierre de la factura'),
    ('026', 'column',      'voucher_settings',         'per_day_limits',                NULL, NULL,                 'topes por dia de vales'),
    ('027', 'column',      'products',                 'commission_value',              NULL, NULL,                 'comision del producto'),
    ('028', 'column',      'voucher_requests',         'method_code',                   NULL, NULL,                 'metodo arqueable del vale'),
    ('029', 'column',      'voucher_requests',         'created_by',                    NULL, NULL,                 'quien creo el vale'),
    ('030', 'column',      'invoice_items',            'commission_mode',               NULL, NULL,                 'modo de comision de la linea'),
    ('031', 'function',    NULL,                       'check_invoice_payments_cap',    NULL, NULL,                 'tope de sobrepago de factura'),
    ('033', 'table',       'cash_shift_recounts',      NULL,                            NULL, NULL,                 'reconteo del cierre de caja'),
    ('034', 'column',      'commission_payouts',       'earned_immediate',              NULL, NULL,                 'tope del pago inmediato de comision'),
    ('035', 'constraint',  'payroll_periods',          'ex_payroll_periods_no_overlap', NULL, NULL,                 'los dias no se nominan dos veces'),
    ('036', 'table',       'payroll_extras',           NULL,                            NULL, NULL,                 'pagos extraordinarios de nomina'),
    ('037', 'table',       'payroll_period_corrections', NULL,                          NULL, NULL,                 'correcciones de periodo cerrado'),
    ('038', 'column',      'invoices',                 'edit_version',                  NULL, NULL,                 'candado de ediciones simultaneas'),
    ('039', 'function',    NULL,                       'replace_user_roles',            'uuid, text[]', NULL,       'reemplazo atomico de roles'),
    ('040', 'function',    NULL,                       'ensure_user_has_role',          'uuid, text', NULL,         'red de seguridad de roles, atomica'),
    ('041', 'column',      'invoices',                 'idempotency_key',               NULL, NULL,                 'clave de idempotencia de la emision'),
    ('042', 'column',      'invoice_payments',         'idempotency_key',               NULL, NULL,                 'clave de idempotencia del cobro'),
    ('043', 'column',      'payments',                 'idempotency_key',               NULL, NULL,                 'clave de idempotencia del pago en caja'),
    ('044', 'column',      'payroll_extras',           'idempotency_key',               NULL, NULL,                 'clave de idempotencia del pago extraordinario'),
    ('045', 'column',      'inventory_movements',      'idempotency_key',               NULL, NULL,                 'clave de idempotencia del movimiento'),
    ('046', 'function',    NULL,                       'deduct_stock_atomic',           'uuid, uuid, text, jsonb', NULL, 'descuento de stock atomico'),
    ('047', 'function',    NULL,                       'payroll_apply_atomic',          'uuid, jsonb, uuid[]', NULL,   'aplicacion de nomina atomica'),
    ('048', 'function',    NULL,                       'payroll_delete_period_atomic',  'uuid, uuid, uuid[], uuid[]', NULL, 'borrado de periodo atomico'),
    ('049', 'function',    NULL,                       'cash_close_shift_atomic',       'uuid, uuid, uuid, timestamptz, jsonb, jsonb', NULL, 'cierre de turno atomico'),
    ('050', 'function',    NULL,                       'invoice_annul_atomic',          'uuid, uuid, uuid, timestamptz, text, text, jsonb', NULL, 'anulacion de factura atomica'),
    ('051', 'function',    NULL,                       'invoice_edit_items_atomic',     'uuid, uuid, uuid, integer, text, jsonb', NULL, 'edicion de items de factura atomica'),
    ('052', 'function',    NULL,                       'invoice_create_atomic',         'uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb', NULL, 'emision de factura atomica'),
    ('053', 'function',    NULL,                       'cash_invoice_payment_atomic',   'uuid, uuid, uuid, uuid, boolean, boolean, jsonb', NULL, 'cobro de factura en caja atomico'),
    ('054', 'function',    NULL,                       'upsert_employee_atomic',        'jsonb, uuid, jsonb, text', NULL, 'alta y edicion de empleado atomica'),
    ('055', 'functiondef', NULL,                       'check_payroll_payments_cap',    NULL, 'FOR UPDATE',          'tope de nomina con lock del item'),
    ('056', 'function',    NULL,                       'cash_invoice_payment_atomic',   'uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb', NULL, 'cobro de factura que cierra la factura'),
    ('057', 'function',    NULL,                       'change_user_password',          'uuid, text, text, text', NULL, 'cambio de contrasena con CAS'),
    ('058', 'function',    NULL,                       'cash_close_shift_atomic',       'uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb', NULL, 'cierre con consistencia de arqueo'),
    ('059', 'functiondef', NULL,                       'cash_close_shift_atomic',       'uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb', 'v_commission_payouts', 'cierre que resta las salidas del arqueo')
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
    WHEN e.tipo IN ('function', 'functiondef') THEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = e.objeto
        AND (e.firma IS NULL
             OR pg_get_function_identity_arguments(p.oid) = e.firma)
        AND (e.tipo = 'function'
             OR pg_get_functiondef(p.oid) LIKE '%' || e.marcador || '%'))
    WHEN e.tipo = 'constraint' THEN EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = e.tabla AND c.conname = e.objeto)
  END AS presente,
  e.para_que
FROM esperado e
ORDER BY e.version;
