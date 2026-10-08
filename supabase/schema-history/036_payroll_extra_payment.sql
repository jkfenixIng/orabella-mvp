-- 036_payroll_extra_payment.sql — PA-2a: nómina individual por caso
-- extraordinario (despido, renuncia, emergencia del empleado) con motivo.
--
-- MOTIVO
--
-- El dueño lo pidió así: "se debe poder tener una nómina individual en caso de
-- un caso extraordinario como despido, renuncia o emergencia del empleado" y
-- "el sistema ayudará a generar esa nómina y guardar registro de cuánto y cómo
-- se pagó para que lleven control".
--
-- Hasta ahora ese caso NO TIENE CAMINO:
--   * `payPayrollItem` (src/features/payroll/service.ts) exige un período en
--     BORRADOR (`assertDraftPeriod`): una renuncia un miércoles, por días que
--     ya están dentro de un período CERRADO, se rechaza con PERIOD_CLOSED.
--   * `payroll_payments` (007_payroll.sql) no tiene columna de motivo y
--     `payPayrollItem` no escribe ninguna entrada de auditoría: nada registra
--     POR QUÉ salió la plata.
-- Y una nómina extraordinaria NO puede resolverse reabriendo el período: un
-- período cerrado es inmutable a propósito (el cierre firmado es historia), y
-- rehacerlo para colar un pago extraordinario destruiría esa garantía. Tampoco
-- puede resolverse abriendo un período nuevo sobre los mismos días: la
-- restricción de exclusión de 035 lo impide, y con razón —esos días ya se
-- nominaron—.
--
-- LA DECISIÓN: un registro de primera clase, NO un período.
--
-- `payroll_extras` es una TABLA PROPIA. No tiene `period_id`, no se calcula
-- desde facturas y no cierra nada. Es plata que sale de la sede por sí misma,
-- con su motivo y su tipo, y que puede convivir con días ya cubiertos por un
-- período CERRADO (que es justamente el caso que la motiva). Este archivo NO
-- toca `payroll_periods`: no lo altera, no le inserta filas, no lo reabre.
--
-- EL MOTIVO ES OBLIGATORIO, EN LA BASE
--
-- `reason text NOT NULL CHECK (btrim(reason) <> '')`: no alcanza con exigirlo
-- en el servicio. El dinero que sale sin explicación es un descuadre, y la
-- barrera tiene que estar donde vive el dato (cualquier escritor —API, SQL a
-- mano, otro proceso— pasa por la tabla). `kind` también es un vocabulario
-- CERRADO (mismo enum que `payrollExtraKindSchema` en schemas.ts): agregar un
-- caso nuevo es una decisión de producto, no un texto que cada sede inventa.
--
-- EL MONTO NO SE TOPA (decisión del dueño, no un olvido)
--
-- El sueldo mensual es la BASE GUÍA de lo que corresponde a los días
-- liquidados, explícitamente NO un tope: un despido liquida prestaciones e
-- indemnización y no es la porción del sueldo; una emergencia puede costar más
-- que los días trabajados. Por eso la única regla de monto es `amount > 0` y
-- por eso NO hay trigger de tope ni comparación contra `salary_fixed`. La
-- aplicación MUESTRA la guía (`payrollExtraGuide`, prorrateada con
-- `prorateFixedSalary`) y nada más. NO convertir esto en un cap.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La tabla (`CREATE TABLE IF NOT EXISTS`). Va PRIMERO: es la forma.
--      Incluye los CHECK (motivo no vacío, tipo acotado, monto > 0, días
--      juntos y en orden) y las FK (sede, empleado, método de pago, usuario).
--   2. Los comentarios de tabla y columnas: qué es el registro y por qué el
--      monto no tiene tope. Va después de la forma para que un lector de la
--      base entienda el dato sin leer la aplicación.
--   3. Los índices (`CREATE INDEX IF NOT EXISTS`). Van después de la tabla y
--      cubren las dos lecturas reales: el listado de la sede (por fecha de
--      pago) y el historial del empleado (por empleado y fecha).
--   4. La RLS (`ENABLE ROW LEVEL SECURITY` + política). Va al final: es
--      defensa en profundidad, no la forma del dato. La política es permisiva
--      hoy por la misma razón que en 007 (las sesiones del MVP no son JWT con
--      claim de sede; la segregación real la aplica la capa servidor con
--      service_role + requireSedeRole). Se re-crea con DROP POLICY IF EXISTS
--      para que un re-run deje la definición vigente.
--
-- NO HAY BACKFILL: la tabla nace vacía (ningún pago extraordinario anterior
-- existió por esta vía). Este archivo NUNCA borra filas: no hay DELETE ni
-- TRUNCATE ni DROP TABLE; el único DROP es el de la política, que se vuelve a
-- crear.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, ALTER TABLE ... ENABLE ROW LEVEL SECURITY (idempotente por sí solo) y
-- DROP POLICY IF EXISTS + CREATE POLICY dejan el esquema idéntico en cada
-- corrida. El runner de Supabase aplica el archivo en una transacción: o entra
-- todo, o no entra nada.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la aplicación escribe en `payroll_extras` en el
-- mismo momento en que esta tabla existe. Si 036 se aplica ANTES de desplegar
-- el servicio nuevo, el servicio viejo simplemente no usa la tabla (no rompe
-- nada: nadie más la escribe). Si el servicio nuevo va antes que la tabla,
-- PostgREST responde 204 (relación inexistente) y el pago extraordinario falla.
-- Orden recomendado: aplicar 036 y desplegar en la misma ventana.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La tabla
-- ===================================================================== ---

CREATE TABLE IF NOT EXISTS public.payroll_extras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  employee_id uuid NOT NULL REFERENCES public.employees (id),
  -- El monto lo escribe el admin y NO se topa (ver el encabezado): la guía del
  -- sueldo se muestra, no se aplica. La única regla es que sea plata real.
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  method_id uuid NULL REFERENCES public.payment_methods (id) ON DELETE SET NULL,
  method_code text NOT NULL,
  reference text NULL,
  -- PA-2a: motivo obligatorio y no vacío. La barrera vive acá para que
  -- cualquier escritor (no sólo el servicio) deje el pago explicado.
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  -- Mismo vocabulario cerrado que `payrollExtraKindSchema` (schemas.ts).
  kind text NOT NULL
    CHECK (kind IN ('despido', 'renuncia', 'emergencia', 'otro')),
  -- Días que el pago liquida (referencia de qué se pagó): opcionales, pero
  -- van juntos y en orden. Alimentan la GUÍA en la aplicación; no son un
  -- período ni participan de la exclusión de rangos de 035.
  days_from date NULL,
  days_to date NULL,
  CHECK ((days_from IS NULL) = (days_to IS NULL)),
  CHECK (days_from IS NULL OR days_to IS NULL OR days_to >= days_from),
  paid_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================================================================== ---
-- 2. Comentarios: qué es el registro y por qué el monto no tiene tope
-- ===================================================================== ---

COMMENT ON TABLE public.payroll_extras IS
  'PA-2a: pago de nómina individual por caso extraordinario (despido, renuncia, emergencia, otro). NO es un período: no tiene period_id, no se calcula desde facturas y no cierra nada. Existe para pagar días que un período CERRADO ya cubrió. El monto lo escribe el admin y NO se topa: el sueldo mensual es la base guía (se muestra prorrateado), no un límite.';

COMMENT ON COLUMN public.payroll_extras.reason IS
  'PA-2a: motivo del pago. Obligatorio y no vacío (CHECK btrim(reason) <> ''''). Es la explicación del dinero que sale.';

COMMENT ON COLUMN public.payroll_extras.kind IS
  'PA-2a: caso extraordinario que motiva el pago: despido | renuncia | emergencia | otro. Vocabulario cerrado (mismo enum en payrollExtraKindSchema).';

COMMENT ON COLUMN public.payroll_extras.amount IS
  'PA-2a: monto pagado, escrito por el admin. SIN TOPE por decisión del dueño: el sueldo mensual es la base guía que la aplicación muestra prorrateada (payrollExtraGuide), no un cap. Un despido liquida prestaciones y no es la porción del sueldo.';

COMMENT ON COLUMN public.payroll_extras.days_from IS
  'PA-2a: primer día que el pago liquida (referencia). Opcional; days_from y days_to van juntos. No es un período ni participa de la exclusión de rangos.';

COMMENT ON COLUMN public.payroll_extras.days_to IS
  'PA-2a: último día que el pago liquida (referencia). Opcional; va con days_from y no puede ser anterior.';

-- ===================================================================== ---
-- 3. Índices: las dos lecturas reales
-- ===================================================================== ---

-- Listado de la sede, del pago más reciente al más viejo (la vista del módulo).
CREATE INDEX IF NOT EXISTS idx_payroll_extras_sede_paid_at
  ON public.payroll_extras (sede_id, paid_at DESC);

-- Historial del empleado (cuánto y cómo se le pagó por casos extraordinarios).
CREATE INDEX IF NOT EXISTS idx_payroll_extras_employee_paid_at
  ON public.payroll_extras (employee_id, paid_at DESC);

-- ===================================================================== ---
-- 4. RLS (defensa en profundidad; la segregación real la aplica el servicio)
-- ===================================================================== ---

-- Deny-by-default, igual que las tablas de 007: sin política, ningún rol
-- alcanza la tabla. La política es permisiva hoy por el mismo TODO de 007: las
-- sesiones del MVP son tokens opacos propios (no JWT de Supabase Auth), así que
-- no hay claim de sede que filtrar; la capa servidor (service_role +
-- requireSedeRole) aplica la segregación por sede.
ALTER TABLE public.payroll_extras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_payroll_extras_sede_isolation ON public.payroll_extras;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: registrar y listar pagos extraordinarios es solo admin en su sede.
CREATE POLICY pol_payroll_extras_sede_isolation ON public.payroll_extras
  FOR ALL USING (true) WITH CHECK (true);
