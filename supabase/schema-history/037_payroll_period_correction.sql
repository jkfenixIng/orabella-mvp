-- 037_payroll_period_correction.sql — PA-2b: un período de nómina CERRADO y
-- equivocado se puede corregir, y la corrección conserva las DOS versiones.
--
-- MOTIVO DEL ARCHIVO
--
-- Hoy un período cerrado con la liquidación mal NO TIENE SALIDA:
--   * borrarlo no se puede: `assertDeletablePeriod` (schemas.ts) exige
--     `borrador` y el servicio responde PERIOD_NOT_DRAFT;
--   * recalcularlo no se puede: `assertDraftPeriod` exige `borrador` y
--     responde PERIOD_CLOSED;
--   * volver a nominar sus días no se puede: la restricción de exclusión
--     `ex_payroll_periods_no_overlap` (035) cubre TODOS los estados.
-- Antes de 035 el camino existía y ESE camino era el defecto: abrir un segundo
-- período sobre los mismos días, que los pagaba dos veces. 035 cerró el agujero
-- y lo dijo explícitamente: "corregir un período cerrado es un procedimiento
-- propio y auditable (como el reconteo de turno de 033), no un segundo rango
-- encima". Este archivo implementa ese procedimiento para la nómina.
--
-- LA DECISIÓN DEL DUEÑO (ya tomada; este archivo la implementa, no la discute):
--   * la corrección es un REGISTRO; el período firmado NO se reabre ni se pisa;
--   * las DOS versiones quedan guardadas (la anterior congelada y la corregida),
--     con quién, cuándo y por qué;
--   * el sistema MUESTRA la diferencia y NO mueve plata por sí solo. Saldarla
--     es un acto HUMANO, con el pago extraordinario que ya existe
--     (`payroll_extras`, migración 036) y un motivo que diga que es el ajuste
--     por la corrección del período. Este archivo NO implementa claw-back, ni
--     arrastre al período siguiente, ni línea de ajuste automática.
--
-- MECANISMO
--
--   * `payroll_periods` y `payroll_items` conservan SIEMPRE la liquidación
--     firmada original. `correctPayrollPeriod` (service.ts) sólo INSERTA en las
--     dos tablas de acá: nunca hace UPDATE ni DELETE sobre el período ni sobre
--     sus ítems.
--   * La versión corregida vive en `payroll_period_corrections` (una fila por
--     período: totales de las dos versiones, motivo, actor y momento) y en
--     `payroll_period_correction_items` (una fila por empleado, con los montos
--     de las DOS versiones y lo pagado). Las filas son autocontenidas: las dos
--     versiones se leen de un solo lugar y no dependen de que nadie haya
--     respetado la inmutabilidad del período.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No toca `payroll_payments`: la corrección no paga ni descuenta. Un
--     período cerrado no se puede pagar desde el sistema (`payPayrollItem`
--     exige un borrador), así que aplicar los montos corregidos al registro
--     cambia lo que el registro dice que se DEBÍA, no lo que se pagó.
--   * No toca `payroll_extras`: el pago extraordinario es la herramienta
--     HUMANA de liquidación, no algo que la corrección dispare.
--   * No toca `voucher_requests`: el recálculo vuelve a descontar del neto los
--     vales que este período ya descontó, pero no marca ni revierte ninguno.
--   * No toca `payroll_periods` ni `payroll_items`.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. `payroll_period_corrections` (CREATE TABLE IF NOT EXISTS): la cabecera,
--      con el motivo obligatorio y las dos versiones de los totales. Va
--      PRIMERO: es la forma a la que apunta la FK de las filas.
--   2. Índice único por período. Es la barrera de la inmutabilidad de la
--      corrección: un período se corrige UNA vez y la corrección también queda
--      firmada. Un segundo intento (o una carrera) choca contra `23505` y el
--      servicio lo traduce a ALREADY_CORRECTED en vez de encadenar otra
--      corrección encima.
--   3. `payroll_period_correction_items`: las dos versiones por empleado. Va
--      después de la cabecera porque la referencia.
--   4. Índice único por (corrección, empleado): una fila por empleado y
--      corrección, para que la comparación no pueda duplicar a nadie.
--   5. Comentarios de tabla y columnas, y el índice de lectura por corrección.
--   6. RLS (defensa en profundidad, mismo criterio que 007 y 036).
--   7. La consulta de solo lectura para ver las dos versiones.
--
-- NO HAY BACKFILL: las dos tablas nacen vacías (ninguna corrección anterior
-- existió por esta vía). Ninguna fila existente cambia de valor. Este archivo
-- NUNCA borra filas: no hay DELETE, TRUNCATE ni DROP TABLE.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: CREATE TABLE IF NOT EXISTS, CREATE UNIQUE INDEX
-- IF NOT EXISTS y DROP POLICY IF EXISTS + CREATE POLICY dejan el esquema
-- idéntico en cada corrida. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- CONSECUENCIA OPERATIVA (leer antes de aplicar): a partir de este archivo, un
-- período corregido tiene DOS versiones legibles: la firmada (en
-- `payroll_periods` + `payroll_items`, que no cambia) y la corregida (en estas
-- dos tablas). La que GOBIERNA lo que se muestra como "lo que debía pagarse" es
-- la corregida; lo PAGADO no cambia en ningún caso. Toda cifra que cambie de
-- significado se señaliza en la pantalla como corregida, y la pantalla dice
-- explícitamente que la diferencia NO queda saldada por la corrección.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Cabecera de la corrección: las dos versiones, con quién, cuándo y por qué
-- ===================================================================== ---

CREATE TABLE IF NOT EXISTS public.payroll_period_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El período cerrado corregido. ON DELETE CASCADE: si algún día se borra el
  -- período (hoy no ocurre: sólo se borra un borrador y la corrección es de un
  -- período cerrado), su corrección no queda huérfana.
  period_id uuid NOT NULL REFERENCES public.payroll_periods (id) ON DELETE CASCADE,

  -- Versión ANTERIOR congelada: los totales firmados del período tal como
  -- estaban al corregir. Es la copia que hace la fila autocontenida.
  previous_net_total numeric(12, 2) NOT NULL CHECK (previous_net_total >= 0),
  previous_paid_total numeric(12, 2) NOT NULL CHECK (previous_paid_total >= 0),
  previous_item_count integer NOT NULL CHECK (previous_item_count >= 0),

  -- Versión NUEVA (corregida): los totales que dicen las reglas VIGENTES
  -- (misma aritmética que `calculatePayroll`, incluida la prorata del fijo).
  corrected_net_total numeric(12, 2) NOT NULL CHECK (corrected_net_total >= 0),
  corrected_item_count integer NOT NULL CHECK (corrected_item_count >= 0),

  -- Motivo OBLIGATORIO: no se firma una corrección sin decir por qué. El CHECK
  -- exige texto no vacío más allá de los espacios (no confía sólo en el schema
  -- del servicio, que también lo valida).
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  -- Quién corrigió y cuándo. FK a users: una corrección siempre tiene
  -- responsable.
  corrected_by uuid NOT NULL REFERENCES public.users (id),
  corrected_at timestamptz NOT NULL DEFAULT now()
);

-- ===================================================================== ---
-- 2. A lo sumo una corrección por período (inmutabilidad de la corrección)
-- ===================================================================== ---

-- La corrección también queda firmada: no se apila una segunda encima, porque
-- eso volvería a dejar la última versión editable en el lugar (el mismo defecto
-- un nivel más abajo). Un intento posterior choca contra este índice (código
-- 23505) y el servicio responde ALREADY_CORRECTED.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_corrections_period
  ON public.payroll_period_corrections (period_id);

-- ===================================================================== ---
-- 3. Las dos versiones por empleado (una fila por empleado y corrección)
-- ===================================================================== ---

CREATE TABLE IF NOT EXISTS public.payroll_period_correction_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_id uuid NOT NULL REFERENCES public.payroll_period_corrections (id) ON DELETE CASCADE,
  -- El empleado liquidado. Sin ON DELETE: igual que `payroll_items` (007), un
  -- empleado con historia de nómina no se borra.
  employee_id uuid NOT NULL REFERENCES public.employees (id),

  -- Versión ANTERIOR: los montos firmados de este empleado, con lo pagado.
  previous_base_fixed numeric(12, 2) NOT NULL CHECK (previous_base_fixed >= 0),
  previous_commissions numeric(12, 2) NOT NULL CHECK (previous_commissions >= 0),
  previous_bonuses numeric(12, 2) NOT NULL CHECK (previous_bonuses >= 0),
  previous_deductions_vales numeric(12, 2) NOT NULL CHECK (previous_deductions_vales >= 0),
  previous_other_discounts numeric(12, 2) NOT NULL CHECK (previous_other_discounts >= 0),
  previous_net_pay numeric(12, 2) NOT NULL CHECK (previous_net_pay >= 0),
  -- Lo PAGADO de este empleado en este período (suma de `payroll_payments`).
  -- Se congela porque la comparación tiene que ser reproducible sin depender de
  -- que los pagos sigan ahí.
  previous_paid numeric(12, 2) NOT NULL CHECK (previous_paid >= 0),

  -- Versión CORREGIDA: los mismos montos recalculados con las reglas vigentes.
  corrected_base_fixed numeric(12, 2) NOT NULL CHECK (corrected_base_fixed >= 0),
  corrected_commissions numeric(12, 2) NOT NULL CHECK (corrected_commissions >= 0),
  corrected_bonuses numeric(12, 2) NOT NULL CHECK (corrected_bonuses >= 0),
  corrected_deductions_vales numeric(12, 2) NOT NULL CHECK (corrected_deductions_vales >= 0),
  corrected_other_discounts numeric(12, 2) NOT NULL CHECK (corrected_other_discounts >= 0),
  corrected_net_pay numeric(12, 2) NOT NULL CHECK (corrected_net_pay >= 0)
);

-- Una fila por empleado y corrección: la comparación no puede duplicar a nadie
-- (dos filas del mismo empleado serían dos veces la misma plata en la vista).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_correction_items_employee
  ON public.payroll_period_correction_items (correction_id, employee_id);

-- ===================================================================== ---
-- 4. Comentarios: qué es el registro y qué significa cada versión
-- ===================================================================== ---

COMMENT ON TABLE public.payroll_period_corrections IS
  'PA-2b: corrección de un período CERRADO. Guarda los totales de las DOS versiones (anterior congelada y corregida), el motivo, quién y cuándo. El período firmado sigue en payroll_periods/payroll_items; esta tabla es la versión que gobierna cuando existe. NO mueve plata: la diferencia se muestra y se salda a mano con un pago extraordinario (payroll_extras).';

COMMENT ON COLUMN public.payroll_period_corrections.period_id IS
  'PA-2b: período cerrado corregido. A lo sumo una corrección por período (índice único).';

COMMENT ON COLUMN public.payroll_period_corrections.previous_net_total IS
  'PA-2b: total neto de la liquidación firmada antes de corregir (versión anterior, congelada).';

COMMENT ON COLUMN public.payroll_period_corrections.previous_paid_total IS
  'PA-2b: total pagado del período al momento de corregir. La corrección NO lo cambia.';

COMMENT ON COLUMN public.payroll_period_corrections.corrected_net_total IS
  'PA-2b: total neto recalculado con las reglas vigentes. Es lo que el registro dice que DEBÍA pagarse; no es plata que se mueva.';

COMMENT ON COLUMN public.payroll_period_corrections.reason IS
  'PA-2b: motivo de la corrección. Obligatorio y no vacío (CHECK btrim(reason) <> ''''). Es la explicación de por qué cambió un número ya firmado.';

COMMENT ON TABLE public.payroll_period_correction_items IS
  'PA-2b: las dos versiones por empleado de una corrección (anterior congelada y corregida) más lo pagado. La diferencia (pagado − neto corregido) NO se guarda: se deriva, para que no pueda contradecir a los montos.';

COMMENT ON COLUMN public.payroll_period_correction_items.previous_paid IS
  'PA-2b: pagado a este empleado en este período (suma de payroll_payments) al corregir. Congelado para que la comparación sea reproducible.';

COMMENT ON COLUMN public.payroll_period_correction_items.corrected_net_pay IS
  'PA-2b: neto recalculado con las reglas vigentes para este empleado. La diferencia que el sistema MUESTRA es previous_paid − corrected_net_pay; saldarla es un acto humano.';

-- Lectura real: los ítems de una corrección, en orden determinista.
CREATE INDEX IF NOT EXISTS idx_payroll_period_correction_items_correction
  ON public.payroll_period_correction_items (correction_id, employee_id);

-- ===================================================================== ---
-- 5. RLS (defensa en profundidad; la segregación real la aplica el servicio)
-- ===================================================================== ---

-- Deny-by-default, igual que las tablas de 007 y 036: sin política, ningún rol
-- alcanza la tabla. La política es permisiva hoy por el mismo TODO de 007: las
-- sesiones del MVP son tokens opacos propios (no JWT de Supabase Auth), así que
-- no hay claim de sede que filtrar; la capa servidor (service_role +
-- requireSedeRole) aplica la segregación por sede. La corrección no tiene
-- `sede_id` propio: la sede se resuelve por el período (el servicio la verifica
-- antes de escribir).
ALTER TABLE public.payroll_period_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_payroll_period_corrections_sede_isolation
  ON public.payroll_period_corrections;

-- TODO(seguridad-T7): endurecer a la sede del período cuando exista el claim
-- de sede en el JWT.
-- Nota §9.4: corregir un período cerrado es solo admin en su sede.
CREATE POLICY pol_payroll_period_corrections_sede_isolation
  ON public.payroll_period_corrections
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.payroll_period_correction_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_payroll_period_correction_items_sede_isolation
  ON public.payroll_period_correction_items;

CREATE POLICY pol_payroll_period_correction_items_sede_isolation
  ON public.payroll_period_correction_items
  FOR ALL USING (true) WITH CHECK (true);

-- ===================================================================== ---
-- 6. Cómo leer las dos versiones (consulta de solo lectura)
-- ===================================================================== ---

-- La liquidación firmada sale de `payroll_items` y la corrección de las dos
-- tablas de este archivo. Sin corrección, c.previous_net_total es NULL y
-- gobierna la versión firmada:
--
--   SELECT i.employee_id,
--          i.net_pay          AS neto_firmado,
--          ci.corrected_net_pay AS neto_corregido,
--          COALESCE(ci.corrected_net_pay, i.net_pay) AS neto_vigente,
--          ci.previous_paid    AS pagado,
--          ci.previous_paid - COALESCE(ci.corrected_net_pay, i.net_pay) AS diferencia,
--          c.reason,
--          c.corrected_by,
--          c.corrected_at
--   FROM public.payroll_items AS i
--   LEFT JOIN public.payroll_period_corrections AS c ON c.period_id = i.period_id
--   LEFT JOIN public.payroll_period_correction_items AS ci
--          ON ci.correction_id = c.id AND ci.employee_id = i.employee_id
--   WHERE i.period_id = '<período>'
--   ORDER BY i.employee_id;
--
-- Y los totales de las dos versiones del período, de un solo lugar:
--
--   SELECT previous_net_total, corrected_net_total, previous_paid_total,
--          previous_net_total - corrected_net_total AS diferencia_neta,
--          reason, corrected_by, corrected_at
--   FROM public.payroll_period_corrections
--   WHERE period_id = '<período>';
--
-- La diferencia POSITIVA (pagado > corregido) es plata que salió de más; la
-- negativa es plata que quedó debida. En los dos casos la corrección NO la
-- mueve: se salda con un pago extraordinario cuyo motivo indique el ajuste por
-- la corrección del período.
