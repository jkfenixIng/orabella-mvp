-- 034_commission_payout_cap.sql — U9: el tope del pago inmediato de comisión
-- vive en la base (último hallazgo de la auditoría cruzada, sección 4).
--
-- MOTIVO
--
-- `payCommissionNow` (src/features/commissions/service.ts) lee lo ya pagado del
-- par (factura, empleado) en `immediatePaidTotal` (~:304, llamada ~:387) e
-- inserta después (~:426). Es una lectura-y-escritura sin lock y sin barrera en
-- la base: dos pagos concurrentes del mismo par leen el mismo pendiente y cada
-- uno inserta el total. El empleado cobra dos veces, y el arqueo registra las
-- dos filas fielmente, así que el descuadre cae en el cajón. Necesita carrera:
-- es justo el tipo de defecto que una validación de servicio no puede cerrar.
--
-- Sus dos hermanas ya tienen su barrera en la base:
-- `trg_payroll_payments_cap` (007_payroll.sql) y `trg_invoice_payments_cap`
-- (031_cash_invoice_payment_integrity.sql). `commission_payouts` no tenía
-- ninguna: ni trigger, ni CHECK (imposible: el tope depende de otras filas), ni
-- UNIQUE(factura, empleado) (imposible también: los pagos parciales son
-- legales y deliberados, ver 016_commissions.sql).
--
-- EL PROBLEMA DE DISEÑO, Y POR QUÉ LA APP ENTREGA EL NÚMERO
--
-- Esta tabla NO tiene una cifra "ganada" guardada contra la cual comparar,
-- como sí la tienen `payroll_items.net_pay` e `invoices.total`. El ganado se
-- calcula en TypeScript (líneas de la factura × reglas ítem×empleado × tasa del
-- empleado) y la tabla solo guarda el PAGO. Por eso el trigger no puede
-- recalcular el tope: una segunda implementación de una regla de dinero en
-- otro lenguaje es en sí un defecto — las dos versiones divergen y nadie sabe
-- cuál manda.
--
-- La solución es la misma división de responsabilidades que ya usa la nómina,
-- cuyo número también lo calcula la aplicación: el servicio ESCRIBE el ganado
-- y la base solo lo COMPARA. Acá el ganado pagable de inmediato viaja en la
-- fila del pago (`earned_immediate`), que es exactamente el valor que el
-- servicio ya calcula (`earned.immediateEarned` — comisión por ítem; el
-- porcentaje del empleado se acumula y se paga en nómina) y contra el que ya
-- valida el pendiente. El trigger no suma porcentajes ni busca reglas: lee el
-- número que la aplicación entrega y lo compara contra la suma de lo pagado.
--
-- La columna es NULL a propósito en las filas HISTÓRICAS: el ganado que existía
-- cuando se pagaron no está en la base y reconstruirlo sería adivinar cuánto se
-- le debía al empleado. Por eso no hay backfill (statement 4) y por eso el
-- trigger EXIGE el número en cada fila nueva: sin él no hay contra qué comparar.
-- El tope no se rompe por esas filas: la suma incluye TODOS los pagos del par
-- (tengan o no el ganado anotado) y el número que la app entrega ya descuenta
-- todo lo pagado.
--
-- LOS PAGOS PARCIALES SIGUEN SIENDO LEGALES. El tope es ACUMULADO
-- (Σamount + nuevo ≤ ganado), no una fila única: nada de UNIQUE(factura,
-- empleado). El servicio conserva su validación exacta del pendiente y su
-- tolerancia de centavo (0,009); el trigger usa la MISMA tolerancia. Lo que se
-- rechaza es pasarse del ganado, nunca pagar en porciones.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La columna (`ADD COLUMN IF NOT EXISTS`). Va PRIMERO porque es el insumo
--      del tope: sin ella el trigger no tendría qué leer. Nullable, sin DEFAULT
--      y sin backfill.
--   2. El comentario de la columna: qué es el número y por qué las filas
--      históricas quedan NULL.
--   3. La función del tope (`CREATE OR REPLACE`). Va después de la columna y
--      antes del trigger, de modo que un re-run sobre un entorno ya migrado
--      vuelva a dejar la misma definición sin depender del orden de aplicación.
--   4. Nota de alcance (solo comentario): por qué NO hay backfill y qué queda
--      fuera de esta barrera.
--   5. El trigger (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`), BEFORE INSERT
--      y solo INSERT. Va al final, igual que en 031: validar filas existentes
--      haría fallar el archivo por datos viejos, y las filas de dinero no se
--      actualizan en este flujo (si algún día se corrigen, la barrera hay que
--      replantearla, no copiarla).
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`,
-- `CREATE OR REPLACE FUNCTION` y `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`.
-- Ninguna sentencia borra filas, ninguna reescribe datos y ninguna crea una
-- restricción que pueda fallar por filas históricas (por eso la columna es
-- nullable y por eso no hay UNIQUE). El runner de Supabase aplica el archivo en
-- una transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. El ganado inmediato que calcula la aplicación, en la fila del pago
-- ===================================================================== ---

-- Nullable a propósito: `numeric(12, 2) NULL` y SIN DEFAULT. Un NOT NULL
-- obligaría a backfillear filas históricas cuyo ganado no se puede conocer
-- (sería inventar plata). El trigger exige el valor en cada INSERT nuevo.
ALTER TABLE public.commission_payouts
  ADD COLUMN IF NOT EXISTS earned_immediate numeric(12, 2) NULL;

-- ===================================================================== ---
-- 2. Qué es este número
-- ===================================================================== ---

COMMENT ON COLUMN public.commission_payouts.earned_immediate IS
'U9 (034): ganado pagable DE INMEDIATO del par (factura, empleado) tal como lo calculó la aplicación al momento del pago (`earned.immediateEarned`): solo la comisión por ítem; el porcentaje del empleado se acumula y va en nómina. Es el TOPE contra el que el trigger compara Σamount, no una regla: la base no recalcula comisión. NULL = fila histórica (anterior a 034), su ganado no está en la base y no se reconstruye.';

-- ===================================================================== ---
-- 3. Tope del pago inmediato de comisión por (factura, empleado)
-- ===================================================================== ---
-- Mismo mecanismo que `trg_invoice_payments_cap` (031), que es la versión con
-- lock de la barrera de nómina: lock de la fila padre para serializar dos pagos
-- concurrentes del mismo par, suma de lo ya pagado y RAISE EXCEPTION plano →
-- SQLSTATE P0001, el mismo código que `payroll/service.ts`, `cash/service.ts` y
-- `billing/service.ts` traducen a una salida de negocio; acá el servicio lo
-- traduce a `COMMISSION_OVERPAID`.
--
-- Sin el lock, dos INSERT concurrentes leerían la misma suma y los dos
-- entrarían: el lock ES la barrera. La comparación es EXACTAMENTE la del
-- servicio: `Σ + nuevo − ganado > 0,009`. El servicio valida primero para poder
-- dar el mensaje exacto del pendiente; el trigger es lo que sobrevive a la
-- carrera.
CREATE OR REPLACE FUNCTION public.check_commission_payouts_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_invoice_id uuid;
  v_earned numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  -- Lock de la factura: serializa dos pagos concurrentes del mismo par.
  -- Misma forma que `check_invoice_payments_cap` (031), donde la fila padre
  -- es también la que se bloquea.
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id;
  END IF;

  v_earned := NEW.earned_immediate;

  -- Sin el ganado que entrega la aplicación no hay tope posible. Es mejor
  -- rechazar la fila que dejar pasar un pago sin comparación: la aplicación
  -- siempre lo entrega, así que una fila sin él es una escritura que no pasó
  -- por el servicio.
  IF v_earned IS NULL THEN
    RAISE EXCEPTION
      'El pago inmediato no trae el ganado de la comisión (earned_immediate): sin ese valor la base no puede aplicar el tope';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.commission_payouts
  WHERE invoice_id = NEW.invoice_id
    AND employee_id = NEW.employee_id;

  -- Tolerancia de centavo (0,009), la misma del servicio: el tope es acumulado
  -- y una porción igual al pendiente entra exacta.
  IF v_paid + coalesce(NEW.amount, 0) - v_earned > 0.009 THEN
    RAISE EXCEPTION
      'El pago supera la comisión ganada del par (factura %, empleado %): ganado %, pagado %, nuevo %',
      NEW.invoice_id, NEW.employee_id, v_earned, v_paid, NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_commission_payouts_cap() IS
'U9 (034): la suma de `commission_payouts` por (factura, empleado) nunca excede el ganado inmediato que la aplicación entrega en `earned_immediate`, con la tolerancia de centavo del servicio (0,009). Barrera en BD ante carreras; el servicio sigue validando el pendiente exacto. El trigger NO recalcula la comisión: compara un número que la app entrega contra la suma de lo pagado — la misma división que `payroll_items.net_pay` (servicio) + `trg_payroll_payments_cap` (base). RAISE EXCEPTION plano = P0001, que el servicio traduce a COMMISSION_OVERPAID. Los pagos PARCIALES siguen siendo legales: el tope es acumulado, no una fila única.';

-- ===================================================================== ---
-- 4. Alcance: qué NO hace este archivo
-- ===================================================================== ---
-- Solo comentario: no ejecuta nada.
--
--   * NO hay backfill. Las filas históricas quedan con `earned_immediate` NULL
--     porque el ganado que existía cuando se pagaron no está en la base;
--     reconstruirlo exige decidir cuánto se le debía a cada empleado, y eso es
--     decisión del dueño (por eso se deja NULL y no se inventa). No cambia el
--     tope: la suma incluye esos pagos y el próximo `earned_immediate` que
--     entregue la aplicación ya los descuenta.
--   * NO borra ni reescribe ninguna fila existente.
--   * NO cierra los otros hallazgos de la auditoría cruzada (el candado de
--     nómina sobre facturas ya pagadas y la anulación de una factura ya
--     pagada): son otro archivo y otra decisión.
--   * NO crea índices nuevos: `idx_commission_payouts_invoice_employee`
--     (016_commissions.sql) ya sirve la búsqueda del par que hace este tope.
--   * ACOPLA EL DESPLIEGUE: la aplicación tiene que mandar `earned_immediate`
--     en el mismo momento en que esta columna existe. Si 034 se aplica ANTES
--     de desplegar el servicio nuevo, el servicio viejo insertaría sin ese
--     campo y el trigger rechazaría TODOS los pagos inmediatos (P0001). Si el
--     servicio nuevo va antes que la columna, PostgREST responde 204 (columna
--     inexistente) y también falla. Van JUNTOS: aplicar 034 y desplegar la
--     aplicación en la misma ventana. (Las dos hermanas no tienen este
--     acoplamiento porque su tope lo leen de la fila padre, no de la nueva.)

-- ===================================================================== ---
-- 5. El trigger
-- ===================================================================== ---

DROP TRIGGER IF EXISTS trg_commission_payouts_cap ON public.commission_payouts;

CREATE TRIGGER trg_commission_payouts_cap
  BEFORE INSERT ON public.commission_payouts
  FOR EACH ROW EXECUTE FUNCTION public.check_commission_payouts_cap();
