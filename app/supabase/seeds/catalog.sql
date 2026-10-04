-- =============================================================================
-- catalog.sql — EL CATÁLOGO MÍNIMO DE ORABELLA
-- =============================================================================
--
-- QUÉ ES ESTE ARCHIVO
--   El catálogo que una instalación necesita para ser usable: las filas de
--   lista cerrada y de configuración por omisión que el historial sembraba y que
--   ninguna otra parte del bootstrap siembra.  Son 30 filas en 7 tablas:
--   4 roles, 1 sede, 1 caja, 11 denominaciones, 6 métodos de pago, 2 impuestos
--   y 5 ajustes de la instalación.
--
-- POR QUÉ EXISTE
--   `app/supabase/migrations/001_orabella_schema.sql` es un `pg_dump
--   --schema-only`: describe el ESQUEMA y no lleva datos.  No es un defecto del
--   volcado —un volcado de esquema no lleva filas— es la consecuencia de haber
--   sustituido el historial por un archivo único.  El historial sí sembraba
--   esas filas de nivel superior, y al desaparecer dejó de sembrarlas: una base
--   creada aplicando solo el esquema quedaba con `public.roles` VACÍA, sin
--   fila de sede, sin caja y sin ajustes, y `public.user_roles` no aterrizaba
--   porque el seed de aceptación une contra `roles` y no encuentra a quién
--   asignarle el rol.  Este archivo es el que devuelve ese mínimo.
--
-- DE DÓNDE SALEN LOS VALORES
--   De las sentencias del historial, con los MISMOS códigos, descripciones,
--   nombres y valores:
--
--     002_auth.sql:55                    → 3 roles (admin, empleado, caja)
--     069_superadmin_role.sql:63         → + el rol superadmin
--     003_admin.sql:38                   → la sede
--     006_cash.sql:80                    → la caja
--     010_cash_denominations.sql:23      → las denominaciones
--     003_admin.sql:157 (bloque DO)      → los métodos de pago
--     003_admin.sql:172 (bloque DO)      → los impuestos
--     019_card_fee.sql:24                → el recargo del 5% de la tarjeta
--     072_system_settings.sql:209 y :226 → los 5 ajustes
--
--   Los métodos de pago y los impuestos NO salen de un `INSERT` de nivel
--   superior, sino de un bloque `DO` de la 003 —por eso un barrido de
--   `^INSERT INTO public.` no los encuentra— y el 5% de la tarjeta viene de un
--   `UPDATE` de la 019.  Están aquí por la misma razón que las siete sentencias
--   de nivel superior: sin ellos la instalación no puede cobrar.
--
-- ADAPTADO AL ESQUEMA MONO-SEDE
--   El historial sembraba esas filas por sede (`SELECT ... FROM public.sedes
--   s`); la 077 borró `sede_id` de `cash_registers` y `cash_denominations`, y en
--   las tablas donde la unicidad ya no incluye la sede el `ON CONFLICT` cambia
--   de columnas.  El VALOR sembrado es el mismo; lo que cambia es la forma de
--   escribirlo.  `sede_id` sobrevive únicamente en `public.users`.
--
-- QUÉ NO ES
--   No es dato de negocio ni dato de prueba.  No hay facturas, empleados,
--   clientes, turnos ni inventario: eso es `app/supabase/seeds/acceptance.sql`,
--   con nombres ficticios, y es otro archivo.  Aquí solo hay catálogo: filas de
--   lista cerrada y valores por omisión que el sistema consulta para funcionar.
--
-- ORDEN DE APLICACIÓN
--   1. `app/supabase/migrations/001_orabella_schema.sql` — el esquema.
--   2. ESTE archivo — el catálogo.
--   3. `app/supabase/seeds/acceptance.sql` — los datos de prueba.
--
--   El orden importa: el seed de aceptación inserta usuarios y les asigna
--   roles uniéndose contra `public.roles` por `code`, así que sin el paso 2
--   sus cuatro `INSERT ... SELECT` no encuentran la fila del rol y
--   `user_roles` queda en cero.
--
-- IDEMPOTENTE
--   Se aplica después del esquema y puede reejecutarse: toda sentencia lleva
--   `ON CONFLICT ... DO NOTHING` o `WHERE NOT EXISTS`, ninguna pisa lo que ya
--   está vigente.  Los `DO NOTHING` de aquí y los `DO UPDATE` del seed de
--   aceptación no se contradicen: la aceptación actualiza lo que encuentra, y
--   sobre una base recién creada lo encuentra.
-- =============================================================================

-- --------------------------------------------------------------- roles (4) ---
-- 002_auth.sql:55 (los tres de la sede) + 069_superadmin_role.sql:63 (el de la
-- plataforma).  `roles.code` es UNIQUE desde la 002: el `ON CONFLICT` es lo que
-- hace re-ejecutable este bloque, que el historial no necesitaba.
INSERT INTO public.roles (code, description) VALUES
  ('admin', 'Administración total de su sede (AUTH-07).'),
  ('empleado', 'Operación asignada de su sede (AUTH-07).'),
  ('caja', 'Facturación y caja de su sede (AUTH-07).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.roles (code, description) VALUES (
  'superadmin',
  'G1: administración de la plataforma (sedes, módulos por sede y sus administradores). NO es un rol de sede: no se otorga ni se quita desde la administración de una sede.'
)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------- sede (1, mono-sede) ---
-- 003_admin.sql:38 sembraba la sede inicial del MVP.  Sin `address` ni
-- `phone`: la 003 solo escribía el nombre.
--
-- La unicidad de `sedes.name` es un índice de expresión sobre
-- `lower(btrim(name))` (070 y 074), y un `ON CONFLICT` no puede nombrar un
-- índice de expresión: por eso el `WHERE NOT EXISTS` compara igual que él.
INSERT INTO public.sedes (name)
SELECT 'Sede principal'
WHERE NOT EXISTS (
  SELECT 1 FROM public.sedes WHERE lower(btrim(name)) = lower(btrim('Sede principal'))
);

-- ------------------------------------------------------ caja (1, mono-sede) ---
-- 006_cash.sql:80: una caja por sede, con la base por omisión que el módulo de
-- caja usa para el primer turno (CAJ-04).  Sin `sede_id`: la 077 lo borró.
INSERT INTO public.cash_registers (name, base_configurada) VALUES
  ('Caja única', 200000)
ON CONFLICT (name) DO NOTHING;

-- ------------------------------------------------- denominaciones (11, COP) ---
-- 010_cash_denominations.sql:23: billetes y monedas vigentes para el conteo por
-- denominación.  El historial sembraba una tanda por sede y resolvía el
-- conflicto con `ON CONFLICT (sede_id, value)`; desde la 074 la unicidad es
-- `UNIQUE (value)`, así que el conflicto se resuelve por la columna que queda.
INSERT INTO public.cash_denominations (kind, value) VALUES
  ('billete', 100000), ('billete', 50000), ('billete', 20000),
  ('billete', 10000), ('billete', 5000), ('billete', 2000),
  ('moneda', 1000), ('moneda', 500), ('moneda', 200),
  ('moneda', 100), ('moneda', 50)
ON CONFLICT (value) DO NOTHING;

-- ------------------------------------------- métodos de pago (6, el 5% de la 019) ---
-- 003_admin.sql:157 sembraba los seis métodos en su bloque `DO`, y la
-- 019_card_fee.sql:24 puso el recargo del 5% en la tarjeta (el resto en 0).
-- Los dos efectos van en una sola sentencia porque el resultado es una sola
-- fila por método: `is_active` en true, como los sembró la 003.
INSERT INTO public.payment_methods (code, name, is_active, fee_percent) VALUES
  ('efectivo', 'Efectivo', true, 0),
  ('transferencia_normal', 'Transferencia / PSE', true, 0),
  ('nequi', 'Nequi', true, 0),
  ('daviplata', 'Daviplata', true, 0),
  ('bre-b', 'Bre-B', true, 0),
  ('tarjeta', 'Tarjeta', true, 5)
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------- impuestos (2) ---
-- 003_admin.sql:172 sembraba los dos tipos de la lista cerrada: IVA al 19% e
-- ICA al 0%, ambos INACTIVOS.  Que el IVA nazca inactivo es lo que hace la
-- 003: activarlo es una decisión de la sede, no un valor por omisión.
INSERT INTO public.tax_configs (code, name, percent, is_active) VALUES
  ('IVA', 'IVA general', 19, false),
  ('ICA', 'ICA', 0, false)
ON CONFLICT (code, name) DO NOTHING;

-- ------------------------------------------ ajustes de la instalación (5) ---
-- 072_system_settings.sql:209 y :226 movió los datos de `invoice_sequences` y
-- `voucher_settings` a `system_settings`.  Con las tablas viejas vacías —una
-- instalación nueva no tiene facturas ni topes configurados— esas dos
-- sentencias producían exactamente estos cinco valores, que son los DEFAULT
-- documentados en la sección 3 de la propia 072.  Se escriben literales y no
-- como agregados sobre las tablas viejas porque eso es lo que queda en disco:
-- la fila del contador arranca en 0 (el primer número emitido es el 1) y los
-- topes se leen como ausentes, no como cero.
--
-- `key` es la PRIMARY KEY de la tabla: el `ON CONFLICT` no pisa un ajuste que
-- el dueño ya haya configurado.
INSERT INTO public.system_settings (key, value) VALUES
  ('invoice_sequence', jsonb_build_object('last_number', 0)),
  ('voucher_max_per_day', jsonb_build_object('amount', NULL)),
  ('voucher_max_per_week', jsonb_build_object('amount', NULL)),
  ('voucher_per_day_limits', jsonb_build_object('limits', '{}'::jsonb)),
  ('voucher_allowed_days', jsonb_build_object('days', '{1,2,3,4,5,6,7}'::smallint[]))
ON CONFLICT (key) DO NOTHING;