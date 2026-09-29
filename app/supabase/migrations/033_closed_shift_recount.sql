-- 033_closed_shift_recount.sql — U3: un cierre firmado es inmutable y su
-- corrección es un reconteo con las dos versiones guardadas.
--
-- MOTIVO DEL ARCHIVO
--
-- Hasta ahora `updateClosedShift` (src/features/cash/service.ts) dejaba que un
-- admin escribiera `counted_cash` y `base_left` de un turno ya CERRADO. El
-- servicio recalculaba `cash_withdrawn` y `base_difference` y los pisaba en
-- `cash_shifts`, pero NO tocaba `cash_shift_counts` (las líneas por
-- denominación del cierre original). Resultado: el total firmado dejaba de
-- cuadrar con su propio detalle por denominación, que es justamente la
-- evidencia que hace del cierre un conteo real; nada obligaba a recontar; y la
-- versión anterior sólo sobrevivía dentro del `metadata` de la auditoría, no
-- como una versión de primera clase del turno.
--
-- DECISIÓN DEL DUEÑO (ya tomada; este archivo la implementa, no la discute):
--   * el cierre cerrado NO se pisa en el lugar;
--   * una corrección exige un CONTEO COMPLETO NUEVO (no un total tecleado);
--   * las DOS versiones quedan guardadas, con quién, cuándo y por qué.
--
-- MECANISMO
--
--   * `cash_shifts` conserva SIEMPRE el cierre firmado original. El nuevo
--     `recountClosedShift` sólo INSERTA; nunca hace UPDATE sobre el turno.
--   * La versión corregida vive en `cash_shift_recounts`, que además congela
--     la versión anterior (`previous_*`) al momento del reconteo. La fila es
--     autocontenida: las dos versiones se leen de un solo lugar y no dependen
--     de que nadie haya respetado la inmutabilidad de `cash_shifts`.
--   * Las líneas del reconteo por denominación viven en `cash_shift_counts`,
--     la MISMA tabla del arqueo (misma validación `checkCounts`, mismo
--     `insertCounts`), en una fase nueva `reconteo`. Esto es lo que obliga a
--     extender el CHECK de `phase` (ver statement 1).
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. Extender el CHECK de `cash_shift_counts.phase` para admitir
--      `reconteo`. Va PRIMERO porque es un permiso: sin él, el INSERT de las
--      líneas del reconteo fallaría contra la barrera de la tabla vieja. Se
--      hace con DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, de modo que un
--      re-run vuelve a dejar la misma definición (idempotente).
--   2. Crear `cash_shift_recounts` (CREATE TABLE IF NOT EXISTS). Va después
--      del permiso y antes del índice: primero la forma, después la barrera.
--   3. Índice único por turno (CREATE UNIQUE INDEX IF NOT EXISTS). Es la
--      barrera de la inmutabilidad de la corrección: un cierre se recontá UNA
--      vez y el reconteo también queda firmado. Un segundo intento (o una
--      carrera) choca contra `23505` y el servicio lo traduce a
--      ALREADY_RECOUNTED en vez de encadenar otro reconteo encima.
--   4. Comentarios de tabla y columnas, y la consulta de solo lectura para
--      listar las dos versiones.
--
-- NO HAY BACKFILL: la tabla `cash_shift_recounts` nace vacía (ningún cierre
-- anterior fue recontado por esta vía) y el CHECK de `phase` sólo AMPLÍA lo
-- permitido. Ninguna fila existente cambia de valor. Este archivo NUNCA borra
-- filas: no hay DELETE ni TRUNCATE ni DROP TABLE; el único DROP es de una
-- constraint que se vuelve a crear con la definición ampliada.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT,
-- CREATE TABLE IF NOT EXISTS y CREATE UNIQUE INDEX IF NOT EXISTS dejan el
-- esquema idéntico en cada corrida. El runner de Supabase aplica el archivo en
-- una transacción: o entra todo, o no entra nada.
--
-- CONSECUENCIA OPERATIVA (leer antes de aplicar): a partir de este archivo la
-- versión que GOBIERNA un turno recontado es la del reconteo. La vista del día,
-- el historial y la base que hereda el PRÓXIMO turno leen los valores
-- corregidos; `cash_shifts` sigue mostrando el cierre original firmado. Todo
-- número que cambie de significado queda señalizado en la UI como recontado.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Ampliar el CHECK de la fase de conteo para admitir el reconteo
-- ===================================================================== ---

-- La tabla 009_cash_control.sql declaró:
--   CHECK (phase IN ('apertura', 'cierre'))
-- El reconteo reutiliza la MISMA tabla y la MISMA maquinaria de conteo, así
-- que su fase tiene que ser una fase válida. Se elimina la constraint por su
-- nombre autogenerado (Postgres nombra los CHECK en línea como
-- `<tabla>_<columna>_check`) y se vuelve a crear ampliada. El DROP IF EXISTS
-- hace el re-run inocuo; el ADD inmediato deja siempre la definición vigente.
ALTER TABLE public.cash_shift_counts
  DROP CONSTRAINT IF EXISTS cash_shift_counts_phase_check;

ALTER TABLE public.cash_shift_counts
  ADD CONSTRAINT cash_shift_counts_phase_check
  CHECK (phase IN ('apertura', 'cierre', 'reconteo'));

-- ===================================================================== ---
-- 2. Tabla de reconteos: las dos versiones de un cierre, con quién y por qué
-- ===================================================================== ---

CREATE TABLE IF NOT EXISTS public.cash_shift_recounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El turno cerrado recontado. ON DELETE CASCADE: si algún día se borra el
  -- turno (no ocurre en el MVP, que no borra turnos), su reconteo no queda
  -- huérfano.
  shift_id uuid NOT NULL REFERENCES public.cash_shifts (id) ON DELETE CASCADE,

  -- Versión ANTERIOR congelada: el cierre firmado tal como estaba al recontar.
  -- Es la copia que hace la fila autocontenida y legible por sí sola.
  previous_counted_cash numeric(12, 2) NOT NULL CHECK (previous_counted_cash >= 0),
  previous_base_left numeric(12, 2) NOT NULL CHECK (previous_base_left >= 0),
  previous_cash_withdrawn numeric(12, 2) NOT NULL,
  previous_base_difference numeric(12, 2) NOT NULL,

  -- Versión NUEVA (corregida) por el reconteo. Mismos cuatro montos que firma
  -- un cierre, calculados con `resolveClosingBase` + `computeCashClose`.
  counted_cash numeric(12, 2) NOT NULL CHECK (counted_cash >= 0),
  base_left numeric(12, 2) NOT NULL CHECK (base_left >= 0),
  cash_withdrawn numeric(12, 2) NOT NULL,
  base_difference numeric(12, 2) NOT NULL,

  -- Motivo OBLIGATORIO: no se firma un reconteo sin decir por qué. El CHECK
  -- exige texto no vacío más allá de los espacios (no confía sólo en el schema
  -- del servicio, que también lo valida).
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  -- Quién recontó y cuándo. FK a users: un reconteo siempre tiene responsable.
  recounted_by uuid NOT NULL REFERENCES public.users (id),
  recounted_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cash_shift_recounts IS
  'U3: reconteos de un cierre. Guarda la versión corregida y la anterior congelada, más quién, cuándo y por qué. El cierre firmado original sigue en cash_shifts; esta tabla es la versión que gobierna cuando existe.';

COMMENT ON COLUMN public.cash_shift_recounts.shift_id IS
  'Turno cerrado recontado. A lo sumo un reconteo por turno (índice único).';

COMMENT ON COLUMN public.cash_shift_recounts.previous_counted_cash IS
  'U3: counted_cash del cierre firmado antes de recontar (versión anterior, congelada).';

COMMENT ON COLUMN public.cash_shift_recounts.counted_cash IS
  'U3: counted_cash corregido por el reconteo; es el valor que gobierna el turno.';

COMMENT ON COLUMN public.cash_shift_recounts.reason IS
  'U3: motivo del reconteo, obligatorio.';

-- ===================================================================== ---
-- 3. A lo sumo un reconteo por cierre (inmutabilidad de la corrección)
-- ===================================================================== ---

-- El reconteo también queda firmado: no se apila un segundo reconteo encima,
-- porque eso volvería a dejar la última versión editable en el lugar (el mismo
-- defecto un nivel más abajo). Un intento posterior choca contra este índice
-- (código 23505) y el servicio responde ALREADY_RECOUNTED.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shift_recounts_shift
  ON public.cash_shift_recounts (shift_id);

-- ===================================================================== ---
-- 4. Cómo leer las dos versiones (consulta de solo lectura)
-- ===================================================================== ---

-- El cierre firmado sale de `cash_shifts` y la corrección de
-- `cash_shift_recounts`. Sin reconteo, r.counted_cash es NULL y gobierna el
-- cierre firmado:
--
--   SELECT s.id,
--          s.counted_cash  AS cierre_contado,
--          r.counted_cash  AS reconteo_contado,
--          COALESCE(r.counted_cash, s.counted_cash) AS contado_vigente,
--          s.base_left     AS cierre_base,
--          r.base_left     AS reconteo_base,
--          COALESCE(r.base_left, s.base_left)       AS base_vigente,
--          r.reason,
--          r.recounted_by,
--          r.recounted_at
--   FROM public.cash_shifts AS s
--   LEFT JOIN public.cash_shift_recounts AS r ON r.shift_id = s.id
--   WHERE s.status = 'cerrado'
--   ORDER BY s.closed_at DESC;
--
-- Y las líneas por denominación de cada versión, para comparar la evidencia
-- del conteo (mismo turno, distinta fase):
--
--   SELECT phase, method_code, denomination, quantity, amount
--   FROM public.cash_shift_counts
--   WHERE shift_id = '<turno>'
--     AND phase IN ('cierre', 'reconteo')
--   ORDER BY phase, method_code, denomination DESC NULLS LAST;