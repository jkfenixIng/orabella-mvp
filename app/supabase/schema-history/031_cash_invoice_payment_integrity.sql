-- 031_cash_invoice_payment_integrity.sql — T0-a: integridad del dinero de
-- factura (doble conteo del arqueo + tope de cobro en BD).
--
-- Dos defectos se cierran aquí:
--
-- C1 — el cierre/vista del día/historial sumaban DOS VECES los cobros de
--      factura hechos por el módulo de caja: `registerPayment` escribía la
--      fila espejo en `invoice_payments` SIN `cash_shift_id` (código previo,
--      ver src/features/cash/service.ts), y `fetchInvoicePaymentsByShift`
--      atribuía toda fila con `cash_shift_id IS NULL` al turno que EMITIÓ la
--      factura. Como esa misma plata también estaba en `payments` (con
--      `invoice_id`), el arqueo la contaba en los dos ledgers. El arreglo de
--      código (la fila espejo lleva `cash_shift_id` y los tres lectores suman
--      `payments` solo con `invoice_id IS NULL`) deja este archivo una tarea:
--      materializar la atribución de las filas históricas.
--
-- C2 — `invoice_payments` solo tenía `CHECK (amount > 0)`: el tope de cobro
--      era una validación de servicio (leer-y-escribir, corre contra
--      concurrencia). La nómina ya tiene barrera en BD
--      (`trg_payroll_payments_cap`, 007_payroll.sql): se replica. El tope es
--      el NETO FACTURADO (`invoices.total − invoices.surcharge`), no `total`:
--      comparar contra `total` deja un hueco del tamaño del recargo emitido
--      (aritmética completa en la sección 2).
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. Backfill de datos (solo `UPDATE` sobre filas que cumplen un predicado
--      de NULL). Correr primero deja la atribución lista antes de que exista
--      cualquier barrera nueva, tal como se pidió ("data repair, then guards")
--      y hace que un re-run del archivo sea un no-op.
--   2. Trigger de tope (`BEFORE INSERT`, no valida filas existentes: no puede
--      fallar por datos viejos; se crea después por convención).
--   3. Nota de la barrera de conteos de cierre (ver el final: no se crea el
--      índice único `(shift_id, phase)` por incompatibilidad con el modelo).
--   4. Nota operativa del backfill (solo comentario): consecuencias de
--      RE-ATRIBUIR filas históricas. LEER ANTES DE APLICAR (sección 4).
--
-- CONSECUENCIA OPERATIVA (resumen; detalle y consulta de turnos afectados en
-- la sección 4): el backfill re-atribuye cobros históricos al turno que COBRÓ.
-- Un turno pasado que EMITIÓ una factura cobrada en un turno POSTERIOR pierde
-- ese dinero de su `esperado`/`ventas` recalculados, mientras su
-- `cash_shifts.expected_cash` (snapshot del cierre) no cambia: los turnos ya
-- cerrados empiezan a mostrar `diferencias` y los totales del día dejan de
-- cuadrar con el cierre guardado, sin asiento compensatorio. Es esperado.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: los backfills sólo tocan filas con
-- `cash_shift_id IS NULL` (una vez atribuidas, un re-run no las ve); el
-- trigger usa `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`;
-- ninguna sentencia borra filas. El runner de Supabase aplica el archivo en
-- una transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Backfill de invoice_payments.cash_shift_id
-- ===================================================================== ---

-- 1.a Atribución al turno que COBRÓ, cuando la evidencia es inequívoca.
-- El espejo de caja (registerPayment) insertó una fila en `payments` con el
-- MISMO `invoice_id`, `method_code` y `amount` (mismos campos, mismo valor;
-- la caja no los redondea distinto) y con `cash_shift_id` = turno que cobró.
-- Solo se aplica cuando TODOS los pagos candidatos de esa clave apuntan al
-- MISMO turno: `HAVING count(DISTINCT cash_shift_id) = 1` elimina la
-- ambigüedad, de modo que la migración nunca adivina. (`array_agg(DISTINCT …)[1]`
-- en vez de `min(uuid)`, que no existe como agregado en PostgreSQL.)
UPDATE public.invoice_payments AS pay
SET cash_shift_id = matched.shift_id
FROM (
  SELECT
    invoice_id,
    method_code,
    amount,
    (array_agg(DISTINCT cash_shift_id))[1] AS shift_id
  FROM public.payments
  WHERE invoice_id IS NOT NULL
    AND cash_shift_id IS NOT NULL
  GROUP BY invoice_id, method_code, amount
  HAVING count(DISTINCT cash_shift_id) = 1
) AS matched
WHERE pay.cash_shift_id IS NULL
  AND pay.invoice_id = matched.invoice_id
  AND pay.method_code = matched.method_code
  AND pay.amount = matched.amount;

-- 1.b Fallback determinista: turno de EMISIÓN de la factura (misma regla que
-- 023_payment_shift.sql, que es exactamente lo que calculaba la rama "legacy"
-- de fetchInvoicePaymentsByShift). Sin él, las filas sin par en `payments`
-- (cobros históricos hechos con caja cerrada, o cualquier clave ambigua)
-- perderían su atribución al dejar de contar su fila de `payments`.
-- Las filas cuya factura tampoco tiene turno quedan NULL (nadie puede
-- atribuirlas; la rama legacy tampoco las contaba).
UPDATE public.invoice_payments AS pay
SET cash_shift_id = inv.cash_shift_id
FROM public.invoices AS inv
WHERE pay.cash_shift_id IS NULL
  AND pay.invoice_id = inv.id
  AND inv.cash_shift_id IS NOT NULL;

COMMENT ON COLUMN public.invoice_payments.cash_shift_id IS
'Turno abierto al momento del cobro (dueño del dinero en caja). NULL = la migración 031 no pudo atribuirlo (factura sin turno): legacy residual.';

-- ===================================================================== ---
-- 2. Tope de cobro por factura en BD (C2)
-- ===================================================================== ---
-- Réplica de trg_payroll_payments_cap (007_payroll.sql): lock de la fila
-- padre (aquí `invoices`, que da la serialización por factura), suma de lo ya
-- cobrado y rechazo con RAISE EXCEPTION plano → SQLSTATE P0001, el mismo
-- código que traduce payroll/service.ts a OVERPAID (422) y que ahora traducen
-- también cash/service.ts y billing/service.ts.
--
-- QUÉ SE SUMA Y CONTRA QUÉ. `invoice_payments.amount` guarda el BRUTO
-- (neto + recargo por método, ver 019_card_fee.sql), `fee_amount` el recargo,
-- y `invoices.total = neto facturado + invoices.surcharge` (el recargo de las
-- porciones emitidas, 019). El tope correcto es el NETO FACTURADO:
--
--     sum(amount - fee_amount) <= total - surcharge
--
-- Las otras dos comparaciones están mal y se descartan con aritmética:
--
--   a) `sum(amount) <= total` (bruto contra total) RECHAZA un cobro legítimo:
--      factura de 100000 emitida SIN cobro (surcharge 0, total 100000); el
--      cliente paga después con tarjeta: splitPayment exige que el NETO de las
--      porciones iguale el saldo (100000) e inserta el BRUTO 105000 con
--      fee_amount 5000. 105000 > 100000 → rechazo indebido. El recargo de un
--      cobro posterior NO se suma al total (diseño de 019): el bruto puede
--      superar el total y es correcto.
--
--   b) `sum(amount - fee_amount) <= total` (neto contra total, la versión
--      anterior de este trigger) deja un hueco del tamaño del recargo:
--      factura de 100000 con una porción de tarjeta de neto 96000 (fee 4800,
--      surcharge 4800, total 104800, saldo 4000). Dos splitPayment
--      concurrentes de {efectivo, 4000} leen el mismo saldo 4000:
--        1º: neto cobrado 96000 + 4000 = 100000 ≤ 104800  → pasa
--        2º: neto cobrado 100000 + 4000 = 104000 ≤ 104800 → pasa
--      Resultado: Σnet 104000 > 100000 (neto facturado) y Σbruto 108800 >
--      104800 (total): se cobra de más exactamente el recargo. Con el tope
--      contra `total - surcharge` el 2º se rechaza (104000 > 100000).
--
--   c) `sum(amount - fee_amount) <= total - surcharge` SIN el round() (la
--      versión anterior a este ajuste) rechaza la liquidación legítima de una
--      factura legacy con centavos: factura emitida con neto 9999,99
--      (surcharge 0). El datafono no acepta centavos, así que el cliente
--      entregó 10000 y esa es la única porción entera posible. El tope ve
--      10000 − 9999,99 = 0,01 > 0,009 → RECHAZA; y 9999 queda 0,99 corto, así
--      que ninguna porción entera pasa y la factura queda Emitida e impagable.
--      Con `round(total - surcharge)` = 10000 el cobro entra exacto. La
--      tolerancia se mantiene en 0,009: el round() no la reemplaza, la
--      complementa (el redondeo define el TOPE; la tolerancia absorbe el ruido
--      de las sumas `numeric` históricas).
--
-- NOTA DE DESPLIEGUE: esta corrección se hizo sobre el archivo 031 SIN
-- aplicarlo a ninguna base (el archivo no se había ejecutado en ningún
-- entorno; ver el encabezado). Si 031 ya estuviera aplicada en una base real,
-- habría que cambiarlo en una migración NUEVA en vez de editar 031.
--
-- Igual que el trigger de nómina, las filas hermanas de un mismo INSERT
-- multi-fila no son visibles para el SUM (mismo snapshot): el tope protege
-- contra carreras entre sentencias, y las sumas exactas siguen validándose en
-- el servicio (que exige que el NETO de las porciones iguale el saldo al
-- cobrar después, o que el bruto no supere el total al registrar desde caja).
CREATE OR REPLACE FUNCTION public.check_invoice_payments_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_total numeric(12, 2);
  v_surcharge numeric(12, 2);
  v_paid_net numeric(12, 2);
  v_new_net numeric(12, 2);
BEGIN
  -- Lock de la factura: serializa dos cobros concurrentes de la misma factura.
  SELECT total, surcharge INTO v_total, v_surcharge
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id;
  END IF;

  v_new_net := coalesce(NEW.amount, 0) - coalesce(NEW.fee_amount, 0);

  SELECT coalesce(sum(amount - fee_amount), 0) INTO v_paid_net
  FROM public.invoice_payments
  WHERE invoice_id = NEW.invoice_id;

  -- Tope = NETO FACTURADO COBRABLE, en la unidad del cobro (peso entero):
  -- `round(total − surcharge)` — el recargo emitido ya viene sumado en el
  -- bruto de cada fila y no es saldo cobrable; y el datafono no acepta
  -- centavos, así que el monto cobrable es el neto redondeado a peso entero
  -- (misma regla que `invoiceNetBalance`, billing/service.ts). Sin el
  -- `round()`, una factura legacy con centavos rechaza su liquidación
  -- legítima: neto 9999,99 y el cliente entregó 10000 en el terminal; ese
  -- cobro exacto queda 0,01 por encima del tope y ninguna otra porción entera
  -- cuadra (9999 queda 0,99 corta), así que la factura queda impagable. La
  -- diferencia es de a lo sumo un peso y la corrección de datos de centavos
  -- históricos la elimina. Misma tolerancia de centavo que nómina (0.009).
  IF v_paid_net + v_new_net - round(v_total - coalesce(v_surcharge, 0)) > 0.009 THEN
    RAISE EXCEPTION
      'El cobro supera el neto facturado de la factura (total %, recargo %, cobrado neto %, nuevo neto %)',
      v_total, coalesce(v_surcharge, 0), v_paid_net, v_new_net;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_invoice_payments_cap() IS
'T0-a (C2): la suma NETA de invoice_payments por factura nunca excede el neto facturado COBRABLE (round(invoices.total − invoices.surcharge), peso entero: el datafono no acepta centavos). El recargo emitido ya viene sumado en el bruto de cada fila, así que comparar contra total dejaba un hueco del tamaño del recargo; y sin el round() una factura legacy con centavos rechazaba su liquidación legítima en pesos enteros. Barrera en BD ante carreras; el servicio valida el cobro exacto. RAISE EXCEPTION plano = P0001 (el servicio lo traduce a OVERPAID).';

DROP TRIGGER IF EXISTS trg_invoice_payments_cap ON public.invoice_payments;

CREATE TRIGGER trg_invoice_payments_cap
  BEFORE INSERT ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.check_invoice_payments_cap();

-- ===================================================================== ---
-- 3. Conteos de cierre: NO se crea el índice único (shift_id, phase)
-- ===================================================================== ---
-- Se pidió "un índice único en cash_shift_counts (shift_id, phase) para que un
-- doble cierre no duplique los conteos". Ese índice es INCOMPATIBLE con el
-- modelo: `insertCounts` (cash/service.ts) inserta UNA FILA POR MÉTODO Y
-- DENOMINACIÓN por fase (efectivo por denominación + un total por digital), y
-- `fetchCountTotals` las agrega. Es decir, un cierre normal escribe N filas
-- con el mismo (shift_id, phase): el índice rechazaría la segunda y rompería
-- toda apertura/cierre con más de una línea. No se crea.
--
-- El doble cierre ya queda cerrado en el código: el UPDATE de cierre ahora
-- lleva `status = 'abierto'`, así que el segundo cierre afecta 0 filas y no
-- llega a `insertCounts`. Si se quiere además una barrera en BD, la clave
-- correcta es por LÍNEA —por ejemplo
--   create unique index uq_cash_shift_count_line
--     on public.cash_shift_counts (shift_id, phase, method_code, coalesce(denomination, -1));
-- y antes hay que verificar que no existan duplicados históricos (hoy son
-- posibles: hasta esta migración el cierre era leer-y-escribir) porque, si los
-- hay, la creación del índice falla y aborta el archivo completo. Queda como
-- decisión explícita del dueño, no se asume aquí.

-- ===================================================================== ---
-- 4. CONSECUENCIA OPERATIVA DEL BACKFILL (LEER ANTES DE APLICAR)
-- ===================================================================== ---
-- Solo comentario: no ejecuta nada. Es la advertencia que debe leer quien
-- aplique este archivo.
--
-- El backfill de la sección 1 RE-ATRIBUYE filas históricas de
-- `invoice_payments`: las que estaban sin turno pasan al turno que COBRÓ
-- (1.a) o, en su defecto, al turno de EMISIÓN de la factura (1.b). Antes de
-- 031, la rama "legacy" de `fetchInvoicePaymentsByShift` atribuía TODA fila
-- con `cash_shift_id IS NULL` al turno de EMISIÓN de su factura. Por eso un
-- turno que EMITIÓ una factura cuyo cobro se hizo en un turno POSTERIOR
-- aparecía cobrando ese dinero. Después de 031, ese dinero pertenece al turno
-- que lo cobró, que es lo correcto.
--
-- Consecuencia, SIN asiento compensatorio:
--   * `cash_shifts.expected_cash` es un SNAPSHOT escrito al cerrar y NO se
--     recalcula: el turno de emisión conserva su cierre guardado.
--   * `getDayView`/`getHistory` SÍ recalculan en vivo (suman `payments` con
--     `invoice_id IS NULL` + `invoice_payments` del turno). Para los turnos ya
--     cerrados cuyo cobro se re-atribuyó, el `esperado`/`ventas` recalculado
--     BAJA y aparecen `diferencias` que no existían al cerrar; los totales del
--     día dejan de cuadrar con el cierre guardado.
--   * El turno que cobró SUBE en la misma medida: ese dinero ya estaba en
--     `invoice_payments`; solo cambia de dueño la atribución.
--   * Los turnos ABIERTOS no se ven afectados: todavía no tienen cierre
--     guardado que contradiga el recálculo.
--
-- Turnos afectados: turnos que EMITIERON una factura cuyo cobro pertenece a
-- otro turno. La consulta es de solo lectura; correrla ANTES y DESPUÉS de
-- aplicar y comparar (después del backfill las dos columnas siguen siendo las
-- mismas: lo que cambia es a quién le suma el dinero).
--
--   SELECT inv.cash_shift_id             AS turno_emisor,
--          ip.cash_shift_id              AS turno_cobrador,
--          count(*)                      AS filas,
--          sum(ip.amount)                AS bruto,
--          sum(ip.amount - ip.fee_amount) AS neto
--   FROM public.invoice_payments ip
--   JOIN public.invoices inv ON inv.id = ip.invoice_id
--   WHERE inv.cash_shift_id IS NOT NULL
--     AND ip.cash_shift_id IS NOT NULL
--     AND ip.cash_shift_id <> inv.cash_shift_id
--   GROUP BY 1, 2
--   ORDER BY 1, 2;
--
-- Listado por turno con su cierre guardado, para decidir si se re-cuadra el
-- `expected_cash` histórico o se documenta la diferencia:
--
--   SELECT s.id, s.status, s.expected_cash, s.closed_at
--   FROM public.cash_shifts s
--   WHERE s.id IN (
--     SELECT DISTINCT inv.cash_shift_id
--     FROM public.invoice_payments ip
--     JOIN public.invoices inv ON inv.id = ip.invoice_id
--     WHERE inv.cash_shift_id IS NOT NULL
--       AND ip.cash_shift_id IS NOT NULL
--       AND ip.cash_shift_id <> inv.cash_shift_id
--   )
--   ORDER BY s.closed_at;
--
-- Este archivo NO reescribe `expected_cash`: es decisión del dueño (¿re-cuadrar
-- cierres históricos o aceptar la diferencia documentada?). Si se decide
-- re-cuadrar, hacerlo en una migración aparte y con el listado de arriba como
-- evidencia.
