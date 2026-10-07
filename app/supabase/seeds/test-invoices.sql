-- test-invoices.sql — Facturas de prueba PAGADAS dentro del ÚLTIMO ciclo de nómina CERRADO.
--
-- QUÉ ES: un seed ADITIVO sobre `catalog.sql` + `acceptance.sql` + `smoke.sql`.
-- Deja TRES facturas `Pagada` con sus líneas de SERVICIO atribuidas a empleados,
-- fechadas (`created_at`) dentro de los últimos días del ÚLTIMO ciclo de nómina
-- YA COMPLETADO, para que el dueño pueda liquidar ese ciclo desde la UI el mismo
-- día y ver números reales de `fijo`, `porcentaje` y `mixto`.
--
-- QUÉ NO HACE (leer antes de juzgarlo):
--   · NO escribe turnos de caja (`cash_shifts`) ni `payments`. Las facturas
--     llevan `cash_shift_id = NULL` en `invoices` y en `invoice_payments`; el
--     NULL es un estado legítimo y documentado (`001:5351`
--     `COMMENT ON COLUMN public.invoice_payments.cash_shift_id`: "NULL = la
--     migración 031 no pudo atribuirlo (factura sin turno): legacy residual").
--     Un turno se abre por UI; sembrarlo sería escribir el hecho que el smoke
--     test quiere que el dueño produzca.
--   · NO escribe movimientos de inventario ni productos: sólo SERVICIOS, así
--     que no toca la cadena `trg_inventory_apply_stock` (`001:7247`) ni
--     `inventory_movements`. Una venta de servicios no mueve stock, y la propia
--     emisión lo declara (`001:2631`: "El grupo vacío es legal y no se llama").
--   · NO escribe `payroll_periods`, `payroll_items`, `payroll_payments`,
--     `commissions` ni `voucher_requests`. El PERÍODO lo abre el dueño en el
--     diálogo «Abrir período» y lo liquida: eso ES la prueba.
--   · NO escribe `sedes.payroll_start_date` (columna que ya nadie lee ni
--     escribe; ver el encabezado de `smoke.sql`).
--   · NO escribe `audit_logs`. La emisión real deja una fila de auditoría
--     FUERA de la transacción (`billing/service.ts:1381` `writeAudit`), pero es
--     bookkeeping, no estado de negocio; este seed no la falsifica.
--   · NO fija las CADENCIAS de nómina: eso lo hace `smoke.sql`. Sin ellas el
--     selector de ciclo no ofrece a los empleados
--     (`payroll/schemas.ts:1631` `pendingPayrollSettlements`, regla 1), así que
--     el orden de aplicación importa (ver «ORDEN» abajo).
--
-- POR QUÉ ESTE ARCHIVO Y NO `acceptance.sql`: el encabezado de `acceptance.sql`
-- declara que "los turnos, facturas, periodos y vales se crean por UI/flujos".
-- Editarlo cambiaría el contrato del criterio §11 y haría que la aceptación
-- dependiera de datos de humo. Este archivo vive aparte, se aplica después y no
-- modifica una sola línea del fixture ni de `smoke.sql`.
--
-- INTERLOCK — SÓLO PRUEBAS. Se copian las DOS condiciones de `smoke.sql:51-77`
-- y la PRIMERA sentencia aborta ANTES de escribir:
--   1. identidad de la conexión (`current_user`), porque el pooler mapea el rol
--      con sufijo de proyecto al rol `postgres` de la base y dentro de la sesión
--      PRUEBAS `current_user` es `postgres` y NUNCA `postgres.<ref>`; el
--      predicado acepta las DOS formas y rechaza cualquier otro rol.
--   2. huella de datos del fixture (`users.email LIKE '%@ejemplo.co'`), porque
--      `postgres` no distingue un proyecto de otro.
-- El guardia importa ACÁ AL MENOS TANTO COMO EN `smoke.sql`: `smoke.sql` sólo
-- escribe la cadencia acordada de diez empleados ficticios, mientras que este
-- archivo escribe DATOS DE NEGOCIO —facturas, líneas de comisión y porciones de
-- cobro, cada una con su consecutivo, que la nómina y la caja van a sumar como
-- dinero real—. Sobre una base de producción esta sentencia inventaría ventas
-- cobradas y pagaría comisiones que nadie ganó, y el daño no es reversible con
-- un `UPDATE`: la liquidación ya habría movido la nómina. Por eso el mismo
-- guardia, y por eso ANTES de reservar un solo consecutivo.
--
-- LA FECHA DEL CICLO SE DERIVA, NUNCA SE ESCRIBE A MANO. Una factura nueva no
-- tiene fecha editable: el servidor la pone con `DEFAULT now()`
-- (`001:5444` `invoices.created_at DEFAULT now()`) y la nómina filtra por ESE
-- instante (`payroll/service.ts:1814-1815`: `.eq("status","Pagada")` +
-- `.gte/.lte("created_at", invoiceRange)` con `invoiceRange =
-- rangeBounds(period.start_date, period.end_date)`, `payroll/service.ts:1799`).
-- Es decir: una factura emitida hoy por la UI cae en el ciclo que todavía está
-- ABIERTO, y ese ciclo NO lo ofrece el diálogo (sólo ofrece cerrados,
-- `pendingPayrollSettlements`, regla 2). Por eso este seed escribe
-- `created_at` EXPLÍCITAMENTE dentro del último ciclo cerrado.
--
--   Regla espejo, literal de `payroll/schemas.ts:1116-1124`
--   (`lastCompletedCycleEndDate`): "Un ciclo se completa cuando ya pasó su
--   sábado, así que el cierre es el sábado ANTERIOR a la referencia", es decir
--   `saturdayOnOrBefore(day - 1 día)`.
--
--   En SQL: `ref - (EXTRACT(DOW FROM ref)::int + 1)` con
--   `ref = (now() AT TIME ZONE 'America/Bogota')::date`. `DOW` es 0=domingo …
--   6=sábado, así que el desplazamiento es 1 el domingo (ayer), 2 el lunes, … y
--   7 el sábado (la semana anterior). La referencia se toma en hora de Bogotá
--   —no en UTC— para que el cálculo no se corra alrededor de la medianoche
--   (a las 19:00 de Bogotá ya es el día siguiente en UTC y el sábado calculado
--   sería otro). Caso concreto del pedido: para 2026-10-06 (martes) el último
--   sábado cerrado es 2026-10-03; `2026-10-06 − 3 días = 2026-10-03`.
--
--   Y el ciclo que el dueño abrirá es el de SU cadencia
--   (`payrollCycleRange`, `payroll/schemas.ts:1094-1115`): rango que termina en
--   ese mismo sábado y mide 7, 14 o 28 días CONTANDO LOS DOS EXTREMOS. Las
--   facturas se siembran a −5, −3 y −1 días del cierre: los tres días caen
--   dentro del ciclo semanal (7 d, arranca en −6), del quincenal (14 d, −13) y
--   del mensual (28 d, −27), así que CUALQUIERA de las tres cadencias que el
--   dueño liquide tiene algo que mostrar.
--
-- FIDELIDAD. Las filas son las que la APP habría escrito, columna por columna:
-- la emisión pasa por `invoice_create_atomic` (`001:2250`, y su envoltura
-- TypeScript `billing/service.ts:1172` `createInvoice`):
--   · `invoices`: la función escribe EXACTAMENTE
--     `consecutive_number, idempotency_key, client_name, client_document,
--     subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id,
--     closed_by, closed_at` (`001:2488-2504`) y el servicio computa el cierre
--     con el estado: `closed_by`/`closed_at` sólo cuando `status = 'Pagada'`
--     (`billing/service.ts:1308-1309`) y `status = portions.length > 0 ?
--     'Pagada' : 'Emitida'` (`billing/service.ts:1255`). Los cinco montos los
--     computa `computeInvoiceTotals` (`billing/schemas.ts:613-631`):
--     `base = subtotal − discount`, `tax = Σ(snapshot de impuestos activos)`,
--     `total = base + tax + surcharge`.
--   · `invoice_items`: `item_type, product_id, service_id, custom_name,
--     employee_id, qty, unit_price, discount, no_commission, commission_value,
--     commission_mode, commission_percent_override, subtotal` (`001:2536-2550`).
--     La línea de SERVICIO de la UI sale SIEMPRE con
--     `commission_mode = 'porcentaje'`, `no_commission = false`,
--     `commission_value = NULL`, `commission_percent_override = NULL`
--     (`invoices-client.tsx:174-183` `normalizeDraftCommission`: "si el ítem es
--     servicio, el modo es porcentaje"; y el override sólo existe para `custom`
--     con empleado de pago fijo), y `unit_price` es el precio del catálogo
--     (`invoices-client.tsx:467-477` `autofillDraftPrice`).
--   · `invoice_taxes`: snapshot de los impuestos ACTIVOS (`billing/service.ts:791-806`
--     `loadRefs` filtra `is_active`, y `snapshotInvoiceTaxes`
--     `billing/schemas.ts:554-561` redondea `base × percent / 100` a peso
--     entero). Este seed NO hardcodea impuestos: los lee de `tax_configs` con la
--     MISMA regla, así que con el fixture de PRUEBAS (IVA 19% activo,
--     `acceptance.sql:176-184`) escribe una fila de IVA por factura y, si los
--     impuestos estuvieran inactivos, no escribe ninguna y `tax = 0`.
--   · `invoice_payments`: `method_id, method_code, amount, fee_percent,
--     fee_amount, cash_shift_id` (`001:2607-2618`). `amount` es el BRUTO de la
--     porción (`billing/service.ts:1334-1340` `fee.gross`), `fee_percent` es el
--     del método y `fee_amount` el recargo, ambos de `computeCardFees`
--     (`billing/schemas.ts:591-604`). Con una sola porción que cubre el neto,
--     `bruto = neto + recargo = invoices.total`, y el tope de cobro de
--     `check_invoice_payments_cap` (`001:7268`) cuadra EXACTO:
--     `paid_net + (amount − fee_amount) − round(total − surcharge) = 0`.
--     `idempotency_key` de la porción queda NULL: la emisión NO la escribe
--     (`001:2607`, la función no lista esa columna) y sólo el cobro dividido
--     posterior la informa (`billing/service.ts:2391`).
-- Los números que produce con el fixture (IVA 19% activo; `tarjeta` al 5%,
-- `acceptance.sql:187-195`), todos en pesos enteros:
--   · inv 1 · subtotal 105.000 → IVA 19.950 → total 124.950 (efectivo, sin recargo)
--   · inv 2 · subtotal 240.000 → IVA 45.600 → total 285.600 (efectivo, sin recargo)
--   · inv 3 · subtotal 110.000 → IVA 20.900 → recargo 6.545 → total 137.445 (tarjeta)
--
-- IDEMPOTENTE. Cada factura lleva un `idempotency_key` FIJO con forma de uuid
-- (el índice único parcial es `uq_invoices_sede_idempotency_key`, `001:7149`:
-- `UNIQUE (idempotency_key) WHERE idempotency_key IS NOT NULL`) y el INSERT
-- lleva `ON CONFLICT ... DO NOTHING`. Las líneas, impuestos y porciones se
-- insertan sólo para una factura que AÚN NO TIENE hijas (`NOT EXISTS`), así que
-- una segunda corrida no duplica nada. El contador del consecutivo se sube al
-- final, nunca se baja.
--
-- PARA APLICAR (PRUEBAS; la credencial NUNCA va en la línea de comandos, sale
-- del archivo de conexión y se lee en la sesión):
--
--   psql "$(cat ~/orabella-db/pruebas.conninfo)" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seeds/test-invoices.sql
--
-- ORDEN: migraciones → `catalog.sql` → `acceptance.sql` → `smoke.sql` → este
-- archivo. `smoke.sql` es PRERREQUISITO: sin las cadencias, el ciclo no se
-- puede ofrecer ni liquidar.
--
-- PARA BORRAR EXACTAMENTE ESTAS FILAS (las hijas caen por FK `ON DELETE CASCADE`,
-- `001:7519`, `001:7551`, `001:7567`):
--
--   DELETE FROM public.invoices WHERE client_name LIKE 'SEED-NOMINA%';
--
-- El DELETE NO baja `system_settings.invoice_sequence.last_number`: los números
-- se dejan reservados a propósito. Bajarlos podría repartir de nuevo un
-- consecutivo que una factura real ya emitió después del seed, y eso es
-- exactamente el choque que el paso 6 evita.

-- ============================================================ 1. INTERLOCK ===
DO $$
BEGIN
  -- Condición 1 · identidad de la conexión (idéntica a `smoke.sql:57`).
  IF current_user <> ALL (ARRAY['postgres', 'postgres.vmnyxhoqnpqwumynlbun']) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = format(
        'Este seed es SÓLO de la base de PRUEBAS (proyecto vmnyxhoqnpqwumynlbun) y esta sesión se conectó como "%". No se escribió nada. Conéctese con el pooler de pruebas: psql "$(cat ~/orabella-db/pruebas.conninfo)" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seeds/test-invoices.sql',
        current_user
      );
  END IF;

  -- Condición 2 · huella de la instalación de pruebas (idéntica a `smoke.sql:71`).
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE email LIKE '%@ejemplo.co') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Este seed es SÓLO de la base de PRUEBAS: esta instalación no tiene el fixture de aceptación (usuarios ficticios @ejemplo.co). No se escribió nada.';
  END IF;
END
$$;

-- ================================= 2. LAS TRES FACTURAS PAGADAS (la cabecera) ===
-- Plan (una factura por día del cierre: −5, −3 y −1, con su método de cobro):
--   inv 1 · cierre −5 · efectivo
--   inv 2 · cierre −3 · efectivo
--   inv 3 · cierre −1 · tarjeta (5%: ejercita `surcharge`/`fee_percent`/`fee_amount`)
-- Líneas (empleado por `id_number` del fixture; servicio por NOMBRE, nunca por
-- uuid, para que no dependa del orden de inserción):
--   inv 1 · Lucía Herrera (10000005, semanal, fijo)      · Corte de cabello ×2
--   inv 1 · Marco Ospina  (10000006, quincenal, fijo)     · Corte de cabello ×1
--   inv 2 · Andrés Quintero (10000004, semanal, porcentaje) · Tinte completo ×1
--   inv 2 · Diego Mejía   (10000002, quincenal, porcentaje) · Tinte completo ×1
--   inv 3 · Paola Cifuentes (10000003, quincenal, mixto)   · Manicura ×2
--   inv 3 · Lucía Herrera (10000005, semanal, fijo)       · Peinado fiesta ×1
-- Así la liquidación SEMANAL muestra `fijo` (Lucía) y `porcentaje` (Andrés) y la
-- QUINCENAL muestra los TRES (`fijo` Marco, `porcentaje` Diego, `mixto` Paola).
-- El `mixto` NO puede aparecer en la semanal: en el fixture ningún empleado
-- `mixto` tiene cadencia semanal (`smoke.sql:103-118`), y la nómina lo excluye
-- a propósito (`periodExcludesEmployeeByCadence`, `payroll/schemas.ts:927`).
WITH bogota AS (
  -- La referencia en hora de Bogotá (no UTC): el cierre no se corre de día.
  SELECT (now() AT TIME ZONE 'America/Bogota')::date AS ref
),
cyc AS (
  -- Espejo de `lastCompletedCycleEndDate` (`payroll/schemas.ts:1116-1124`):
  -- el sábado ANTERIOR a la referencia. Los `::int` normalizan `DOW`.
  SELECT (ref - (EXTRACT(DOW FROM ref)::int + 1)) AS cycle_end FROM bogota
),
seq AS (
  -- El contador VIGENTE. `coalesce` con subconsulta escalar: la fila existe
  -- (`catalog.sql:158`) pero la lectura no depende de que exista.
  SELECT coalesce(
           (SELECT (s.value ->> 'last_number')::int
              FROM public.system_settings s WHERE s.key = 'invoice_sequence'),
           0
         ) AS last_number
),
heads(seed_no, days_before, client_name, method_code) AS (VALUES
  (1, 5, 'SEED-NOMINA 1 · Lucía Herrera',   'efectivo'),
  (2, 3, 'SEED-NOMINA 2 · Andrés Quintero', 'efectivo'),
  (3, 1, 'SEED-NOMINA 3 · Paola Cifuentes', 'tarjeta')
),
lines(seed_no, id_number, service_name, qty) AS (VALUES
  (1, '10000005', 'Corte de cabello', 2),
  (1, '10000006', 'Corte de cabello', 1),
  (2, '10000004', 'Tinte completo',   1),
  (2, '10000002', 'Tinte completo',   1),
  (3, '10000003', 'Manicura',         2),
  (3, '10000005', 'Peinado fiesta',   1)
),
lines_resolved AS (
  -- MISMOS joins que la sección 3: si un empleado o un servicio faltara, el
  -- total no incluiría una línea que la sección 3 tampoco escribiría.
  SELECT l.seed_no, (l.qty * s.price)::numeric(12,2) AS line_subtotal
  FROM lines l
  JOIN public.users u ON u.id_number = l.id_number
  JOIN public.employees e ON e.user_id = u.id AND e.is_active
  JOIN public.services s ON s.name = l.service_name AND s.is_active
),
subtotals AS (
  SELECT seed_no, sum(line_subtotal)::numeric(12,2) AS subtotal
  FROM lines_resolved
  GROUP BY seed_no
),
tax_calc AS (
  -- Espejo de `snapshotInvoiceTaxes` (`billing/schemas.ts:554-561`): Σ sobre los
  -- impuestos ACTIVOS de `round(base × percent / 100)`, con `base = subtotal
  -- − discount` (acá discount = 0). Sin impuestos activos: 0, y la sección 4 no
  -- escribe ninguna fila.
  SELECT st.seed_no,
         (SELECT coalesce(sum(round((st.subtotal * tc.percent) / 100)), 0)
            FROM public.tax_configs tc WHERE tc.is_active)::numeric(12,2) AS tax
  FROM subtotals st
),
fee_calc AS (
  -- Espejo de `computeCardFees` (`billing/schemas.ts:591-604`): una sola porción
  -- que cubre el NETO, `fee = round(neto × fee_percent / 100)`,
  -- `bruto = neto + fee`. El join por `code` (el fixture garantiza los seis
  -- métodos, `acceptance.sql:186-195`) mantiene la porción obligatoria: sin la
  -- fila del método no se emite la factura, en vez de emitirla sin cobro.
  SELECT st.seed_no,
         round(((st.subtotal + tc.tax) * pm.fee_percent) / 100)::numeric(12,2) AS fee
  FROM subtotals st
  JOIN tax_calc tc ON tc.seed_no = st.seed_no
  JOIN heads h2 ON h2.seed_no = st.seed_no
  JOIN public.payment_methods pm ON pm.code = h2.method_code
)
INSERT INTO public.invoices (
  consecutive_number, idempotency_key, client_name, client_document,
  subtotal, discount, tax, surcharge, total, status,
  user_id, cash_shift_id, closed_by, closed_at, created_at, updated_at
)
SELECT
  seq.last_number + h.seed_no,
  '5eed0001-0000-4000-8000-00000000000' || h.seed_no,
  h.client_name,
  NULL,
  tot.subtotal,
  0,
  tx.tax,
  fe.fee,
  tot.subtotal + tx.tax + fe.fee,
  'Pagada',
  issuer.id,
  NULL,
  issuer.id,
  ins.instant,
  ins.instant,
  ins.instant
FROM heads h
JOIN subtotals tot ON tot.seed_no = h.seed_no
JOIN tax_calc tx ON tx.seed_no = h.seed_no
JOIN fee_calc fe ON fe.seed_no = h.seed_no
CROSS JOIN seq
CROSS JOIN cyc c
CROSS JOIN (
  -- Emisor: la admin del fixture (Carolina Rojas, `10000001`), que es el rol con
  -- el que la app emite (`billing/service.ts:108` `requireBillingWriter`).
  SELECT u.id FROM public.users u WHERE u.id_number = '10000001' LIMIT 1
) issuer
CROSS JOIN LATERAL (
  -- Instante de emisión: mediodía de Bogotá del día del plan, dentro de
  -- `rangeBounds(start_date, end_date)` (`shared/lib/dates.ts:29-36`:
  -- `T00:00:00-05:00` … `T23:59:59.999-05:00`).
  SELECT ((c.cycle_end - h.days_before) + time '12:00') AT TIME ZONE 'America/Bogota' AS instant
) ins
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- ================================================ 3. LAS LÍNEAS DE SERVICIO ===
-- MISMAS líneas que la sección 2 (misma lista `VALUES`; si se cambia una, se
-- cambia la otra). Columna por columna, la línea de SERVICIO que escribe la UI:
--   item_type = 'servicio', service_id = el del catálogo, product_id y
--   custom_name NULL (`invoice_items_check`, `001:5294`), employee_id NOT NULL
--   (`001:5281`), discount = 0, subtotal = qty × unit_price redondeado
--   (`computeLineSubtotal`, `billing/schemas.ts:529-533`), y la comisión
--   `porcentaje`/sin valor/sin override de `normalizeDraftCommission`
--   (`invoices-client.tsx:174-183`).
-- `created_at`/`updated_at` = el instante de la factura: la emisión escribe sus
-- líneas en la MISMA transacción (`001:2536`), así que no pueden ser posteriores.
WITH lines(seed_no, id_number, service_name, qty) AS (VALUES
  (1, '10000005', 'Corte de cabello', 2),
  (1, '10000006', 'Corte de cabello', 1),
  (2, '10000004', 'Tinte completo',   1),
  (2, '10000002', 'Tinte completo',   1),
  (3, '10000003', 'Manicura',         2),
  (3, '10000005', 'Peinado fiesta',   1)
)
INSERT INTO public.invoice_items (
  invoice_id, item_type, product_id, service_id, custom_name, employee_id,
  qty, unit_price, discount, no_commission, commission_value, commission_mode,
  commission_percent_override, subtotal, created_at, updated_at
)
SELECT
  i.id,
  'servicio',
  NULL,
  s.id,
  NULL,
  e.id,
  l.qty,
  s.price,
  0,
  false,
  NULL,
  'porcentaje',
  NULL,
  (l.qty * s.price)::numeric(12,2),
  i.created_at,
  i.created_at
FROM lines l
JOIN public.invoices i
  ON i.idempotency_key = '5eed0001-0000-4000-8000-00000000000' || l.seed_no
JOIN public.users u ON u.id_number = l.id_number
JOIN public.employees e ON e.user_id = u.id AND e.is_active
JOIN public.services s ON s.name = l.service_name AND s.is_active
WHERE NOT EXISTS (
  SELECT 1 FROM public.invoice_items x WHERE x.invoice_id = i.id
);

-- ============================== 4. EL SNAPSHOT DE IMPUESTOS (uno por factura) ===
-- Un renglón por impuesto ACTIVO, por factura: es lo que hace
-- `snapshotInvoiceTaxes` al emitir (`billing/schemas.ts:554-561`), y lo que
-- `invoice_create_atomic` escribe verbatim (`001:2573-2582`). Con el fixture
-- (IVA 19% activo) es UNA fila por factura; con los impuestos inactivos, CERO
-- filas —el grupo vacío es legal, `001:2564` "`0 = 0` es legal"— y `tax = 0`.
-- `base` es `subtotal − discount` y acá `discount = 0` (misma expresión que la
-- sección 2, así que `invoices.tax` y la suma de estas filas coinciden).
INSERT INTO public.invoice_taxes (
  invoice_id, tax_code, tax_name, percent, amount, created_at
)
SELECT
  i.id,
  tc.code,
  tc.name,
  tc.percent,
  round(i.subtotal * tc.percent / 100)::numeric(12,2),
  i.created_at
FROM public.invoices i
JOIN public.tax_configs tc ON tc.is_active
WHERE i.idempotency_key IN (
        '5eed0001-0000-4000-8000-000000000001',
        '5eed0001-0000-4000-8000-000000000002',
        '5eed0001-0000-4000-8000-000000000003'
      )
  AND NOT EXISTS (
    SELECT 1 FROM public.invoice_taxes x WHERE x.invoice_id = i.id
  );

-- ========================================= 5. LAS PORCIONES DEL COBRO (pago) ===
-- Una porción por factura, por el método del plan (sección 2). `amount` es el
-- BRUTO (= `invoices.total`), `fee_percent` el del método y `fee_amount` el
-- recargo ya sumado en `invoices.surcharge`: con eso el tope de cobro
-- (`001:7268` `check_invoice_payments_cap`) cuadra exacto en el límite, porque
-- `amount − fee_amount = total − surcharge = neto`. `method_id` se resuelve por
-- código (la emisión manda `method_id` o NULL, `001:2611`). `cash_shift_id` NULL
-- y `idempotency_key` NULL: ver «QUÉ NO HACE» y «FIDELIDAD» en el encabezado.
WITH methods(seed_no, method_code) AS (VALUES
  (1, 'efectivo'),
  (2, 'efectivo'),
  (3, 'tarjeta')
)
INSERT INTO public.invoice_payments (
  invoice_id, method_id, method_code, amount, fee_percent, fee_amount,
  cash_shift_id, created_at
)
SELECT
  i.id,
  pm.id,
  m.method_code,
  i.total,
  pm.fee_percent,
  i.surcharge,
  NULL,
  i.created_at
FROM methods m
JOIN public.invoices i
  ON i.idempotency_key = '5eed0001-0000-4000-8000-00000000000' || m.seed_no
JOIN public.payment_methods pm ON pm.code = m.method_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.invoice_payments x WHERE x.invoice_id = i.id
);

-- ======================================== 6. EL CONTADOR DEL CONSECUTIVO ===
-- Sin esto, la próxima factura real del dueño volvería a pedir
-- `next_invoice_number()` (`001:3806`), que lee y bloquea la fila
-- `system_settings` de clave `invoice_sequence`, y chocaría contra el UNIQUE
-- `invoices_consecutive_number_key` (`001:6503`).
--
-- La autoridad es `system_settings`, NO la tabla legacy `invoice_sequences`
-- (`001:5397`): desde la 072 el contador vive en el ajuste
-- `invoice_sequence` → `{"last_number": n}` y `next_invoice_number` no lee la
-- tabla vieja (ver su comentario, `001:3848`, y el de la tabla,
-- `001:6131`: "Sustituye a `invoice_sequences` (005)"). Actualizar la tabla
-- legacy sería escribir un valor que nadie consume y dejar el que SÍ se
-- consume intacto, es decir el choque que esta sección evita.
--
-- `GREATEST` con el valor vigente: la corrida idempotente no baja ni repite
-- nada, y el `WHERE` evita incluso el `UPDATE` cuando ya está por encima.
INSERT INTO public.system_settings AS ss (key, value)
VALUES (
  'invoice_sequence',
  jsonb_build_object(
    'last_number',
    coalesce(
      (SELECT max(i.consecutive_number) FROM public.invoices i
        WHERE i.idempotency_key IN (
                '5eed0001-0000-4000-8000-000000000001',
                '5eed0001-0000-4000-8000-000000000002',
                '5eed0001-0000-4000-8000-000000000003'
              )),
      0
    )
  )
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_set(
      ss.value,
      '{last_number}',
      to_jsonb(
        GREATEST(
          coalesce((ss.value ->> 'last_number')::int, 0),
          coalesce(
            (SELECT max(i.consecutive_number) FROM public.invoices i
              WHERE i.idempotency_key IN (
                      '5eed0001-0000-4000-8000-000000000001',
                      '5eed0001-0000-4000-8000-000000000002',
                      '5eed0001-0000-4000-8000-000000000003'
                    )),
            0
          )
        )
      ),
      true
    )
WHERE coalesce((ss.value ->> 'last_number')::int, 0) < coalesce(
        (SELECT max(i.consecutive_number) FROM public.invoices i
          WHERE i.idempotency_key IN (
                  '5eed0001-0000-4000-8000-000000000001',
                  '5eed0001-0000-4000-8000-000000000002',
                  '5eed0001-0000-4000-8000-000000000003'
                )),
        0
      );
