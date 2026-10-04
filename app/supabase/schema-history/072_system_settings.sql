-- 072_system_settings.sql — los ajustes de la INSTALACIÓN en una sola tabla
-- `clave`/`valor`.
--
-- MOTIVO DEL ARCHIVO (decisión del dueño, 2026-10-01)
--
-- El proyecto es físicamente de una sola sede. Dos tablas tenían la SEDE como
-- CLAVE PRIMARIA y con ella se quedan sin clave:
--
--   * `invoice_sequences` (005): el contador del consecutivo de factura, una
--     fila por sede con `last_number`.
--   * `voucher_settings` (007, y las columnas de 024 y 026): topes de vales por
--     día y por semana, días permitidos y topes propios por día, una fila por
--     sede.
--
-- Quitarles `sede_id` no es sólo borrar una columna: las dos se quedarían con
-- una fila y NINGUNA clave que la identifique, que es el peor estado posible
-- para una fila que se bloquea e incrementa (`next_invoice_number` la bloquea con
-- `FOR UPDATE`; sin clave no hay fila que bloquear y el contador deja de ser
-- único). El dueño decidió NO darles una clave surrogada y reemplazarlas por
-- UNA tabla de configuración del sistema con `clave`/`valor`.
--
-- POR QUÉ CLAVE / VALOR Y NO UNA TABLA POR AJUSTE
--
-- La instalación tiene UNA fila por AJUSTE, no una fila por sede: el
-- consecutivo es un contador y los topes son cuatro números que se leen y se
-- escriben juntos. Una tabla por ajuste repetiría, en cada tabla, el mismo
-- problema que traen las dos que se sustituyen —la ausencia de fila es
-- indistinguible de «sin configurar»— y obligaría a decidir, por cada tabla, si
-- su fila existe (migración de datos) o si se crea al primer uso. Con la clave
-- como identificador:
--
--   * Cada ajuste es UNA fila, y su `clave` ES su identidad: no hay clave
--     ajena que inventar ni que mantener.
--   * Un ajuste ausente tiene un DEFAULT documentado (sección 3), así que la
--     ausencia de la fila significa «todavía no configurado» y la lectura
--     responde igual que antes, no con un error.
--   * La fila del consecutivo es la fila que `next_invoice_number` bloquea: es
--     la MISMA fila, con la MISMA clave primaria, sólo que en otra tabla.
--
-- QUÉ GUARDA `value`
--
-- `value` (jsonb) es el CONTENIDO del ajuste, y por eso es un objeto con el
-- nombre del dato dentro: la tabla es genérica y el lector tiene que poder
-- distinguir el contador de un tope sin adivinar por la forma. Las claves que
-- este archivo define son:
--
--   'invoice_sequence'      → {"last_number": <entero>}
--                              Último consecutivo emitido. Es la fila que la
--                              función bloquea e incrementa.
--   'voucher_max_per_day'   → {"amount": <número|null>}
--                              Tope diario general. NULL o 0 = sin tope (026).
--   'voucher_max_per_week'  → {"amount": <número|null>}
--                              Tope semanal. NULL o 0 = sin tope (026).
--   'voucher_per_day_limits'→ {"limits": {"1": <monto>, …}}
--                              Tope propio por día ISO (1=lunes…7=domingo),
--                              que REEMPLAZA al diario general ese día (026).
--                              {} = sin topes por día.
--   'voucher_allowed_days'  → {"days": [1,…,7]}
--                              Días ISO en que se puede pedir vale (024).
--                              Los siete = sin restricción.
--
-- POR QUÉ `value` ES jsonb Y NO UNA COLUMNA POR DATO
--
-- Los cinco ajustes no tienen ni el mismo tipo ni la misma forma (un entero
-- contador, dos montos, un mapa por día, una lista de días). Una tabla de
-- configuración con una columna por tipo obligaría a inventar columnas vacías
-- para los ajustes que no las usan y a ensuciar el lector con un
-- `CASE`/`COALESCE` por cada forma. Con `jsonb` cada ajuste declara su propio
-- sobre y su forma se valida donde se lee (el servicio, con Zod y con los
-- auxiliares puros de `payroll/schemas.ts`).
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
--   1. Crea `public.system_settings` con su COMMENT, su trigger de `updated_at`
--      y su RLS.
--   2. MUEVE ADELANTE los datos de las dos tablas viejas, de forma idempotente:
--      el contador a 'invoice_sequence' y los cuatro ajustes de vales a sus
--      claves. Cuando la fila vieja no existe, escribe el DEFAULT documentado
--      (sección 3) en vez de dejar la clave ausente.
--   3. Re-emite `public.next_invoice_number` (005) para que bloquee e
--      incremente la fila 'invoice_sequence'. SU FIRMA NO CAMBIA.
--
-- NO borra `invoice_sequences` ni `voucher_settings`: las dos siguen existiendo
-- y con sus datos intactos. El BORRADO es de la unidad que borra `sede_id`
-- (M3c), que es la única que puede hacerlo sin dejar un reader apuntando a una
-- tabla que ya no está.
--
-- POR QUÉ `next_invoice_number` CONSERVA SU PARÁMETRO
--
-- La firma sigue siendo `next_invoice_number(p_sede_id uuid)`, la de 005, y el
-- cuerpo NO usa el parámetro. Quitarlo sería cambiar la firma de una función a
-- la que llama `invoice_create_atomic` (071), y ese cambio es exactamente el que
-- pertenece a la unidad que borra `sede_id`: mientras la columna exista, el
-- llamador tiene que seguir mandando la sede que extrae de la fila que ya
-- bloqueó, y cambiarla acá dejaría a las dos versiones desacomodadas. El
-- parámetro pasa de «la fila del contador» a ser un dato que la función ya no
-- necesita; conserva su nombre y su tipo hasta que la unidad que borra la
-- columna lo retire de la firma.
--
-- LO QUE NO CAMBIA DE LA FUNCIÓN: el tipo de retorno (`integer`), el
-- `INSERT … ON CONFLICT DO NOTHING` que deja existir la fila antes de
-- bloquearla, el `SELECT … FOR UPDATE` —el lock de fila que serializa a los
-- emisores concurrentes—, el incremento DENTRO de la misma transacción que
-- reserva el número (052) y el nombre del error cuando la fila no aparece.
--
-- IDEMPOTENTE Y RE-EJECUTABLE
--
--   * `CREATE TABLE IF NOT EXISTS` + `COMMENT` dejan el esquema igual en cada
--     corrida.
--   * El trigger se re-emite con `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`.
--   * La política se re-emite con `DROP POLICY IF EXISTS` + `CREATE POLICY`.
--   * Los datos se mueven con `ON CONFLICT (key) DO NOTHING`: una segunda
--     corrida NO pisa el valor vigente. En el contador eso es lo que importa —
--     la fila puede haber avanzado desde la primera corrida y volver a copiar
--     `invoice_sequences` REBAJARÍA la serie y repetiría un número ya
--     emitido—; en los topes, una configuración que el admin cambió después de
--     aplicada la migración tampoco se pisa por volver a correr el archivo.
--   * La función se re-emite con `CREATE OR REPLACE FUNCTION`, que conserva
--     sus atributos.
--
-- El runner de Supabase aplica el archivo en una transacción: o entra todo, o
-- no entra nada.
--
-- LO QUE ESTA UNIDAD NO TOCA
--
--   * `invoice_create_atomic` (052/071): sigue llamando a
--     `next_invoice_number(v_sede)` con la sede del turno que bloqueó; sólo
--     cambia el cuerpo de la función a la que llama.
--   * El ACL de `next_invoice_number`: es el de 005 (`CREATE FUNCTION` otorga
--     EXECUTE a PUBLIC y este archivo no lo cambia). Ajustarlo es una decisión
--     sobre la superficie RPC del proyecto, no de esta tabla.
--   * `supabase/test-bootstrap.sql`, que es un volcado independiente del
--     esquema: aplicarle este archivo encima es lo que hace el runner de
--     migraciones.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La tabla
-- ===================================================================== ---
--
-- `key` es la PRIMARY KEY y por lo tanto el identificador de la fila: es lo que
-- `next_invoice_number` bloquea (`FOR UPDATE`) y lo que el `upsert` del servicio
-- usa como destino de conflicto. `value` es NOT NULL con `{}` por omisión para
-- que una fila exista siempre con una forma válida (un `jsonb` nulo no es un
-- sobre: es una ausencia). `updated_at` con el trigger compartido de 001 es la
-- convención de la casa para toda tabla que se actualiza, y acá importa más que
-- en una tabla de negocio: dice cuándo se movió el contador y cuándo se
-- reconfiguraron los topes.

CREATE TABLE IF NOT EXISTS public.system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.system_settings IS
  'Ajustes de la INSTALACIÓN, uno por fila, identificados por `key`. La instalación es de una sola sede: estos ajustes no se repiten por sede, así que la clave del ajuste ES su identidad (y la fila del consecutivo es la fila que next_invoice_number bloquea). `value` (jsonb) es el sobre del ajuste; cada clave declara el suyo (invoice_sequence → {"last_number": n}; voucher_max_per_day / voucher_max_per_week → {"amount": n|null}; voucher_per_day_limits → {"limits": {"<día ISO>": monto}}; voucher_allowed_days → {"days": [1..7]}). Sustituye a invoice_sequences (005) y voucher_settings (007/024/026), que quedan en pie hasta la unidad que borra sede_id.';

COMMENT ON COLUMN public.system_settings.key IS
  'Identificador del ajuste (clave primaria). Es también el destino del ON CONFLICT del upsert del servicio y la fila que next_invoice_number bloquea con FOR UPDATE.';

COMMENT ON COLUMN public.system_settings.value IS
  'Contenido del ajuste, en un objeto jsonb con el nombre del dato dentro (la tabla es genérica y el lector tiene que distinguir una forma de otra). Una clave ausente se lee con el DEFAULT documentado de la migración 072, no con un error.';

COMMENT ON COLUMN public.system_settings.updated_at IS
  'Instante de la última escritura de la fila (trigger set_updated_at de 001). En la fila del consecutivo dice cuándo se emitió el último número.';

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON public.system_settings;

CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------ RLS ---
-- Deny-by-default, igual que las tablas de 005/007/061: sin política ningún
-- rol alcanza la tabla. La política es permisiva hoy por el mismo TODO de 007
-- (`TODO(seguridad-T7)`, cerrado en T8): las sesiones del MVP son tokens opacos
-- propios, no JWT de Supabase Auth, así que no hay claim de sede que filtrar; la
-- capa servidor (service_role + requireSedeRole) es la frontera real.
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_system_settings_sede_isolation ON public.system_settings;

-- TODO(seguridad-T7): endurecer cuando exista JWT con claim de sede.
-- Nota: esta tabla no lleva `sede_id`, así que no hay predicado por sede que
-- escribir: es un ajuste de la instalación, no de una sede.
CREATE POLICY pol_system_settings_sede_isolation ON public.system_settings
  FOR ALL USING (true) WITH CHECK (true);

-- ===================================================================== ---
-- 2. Los datos, movidos ADELANTE
-- ===================================================================== ---
--
-- Las dos tablas viejas siguen existiendo (el borrado es de otra unidad), así
-- que esta sección es una COPIA con valores por omisión documentados, escrita de
-- forma que una segunda corrida no pise lo que ya está vigente.

-- ---------------------------------------------- el contador (005) --------
-- 'invoice_sequence' ← max(last_number) de `invoice_sequences`.
--
-- Se toma el MÁXIMO y no la fila de la sede: con una sola sede hay una sola fila
-- y las dos reglas coinciden, pero si quedara historia de más de una sede, el
-- máximo es el ÚNICO valor que no puede repetir un número ya emitido (con el
-- mínimo, la serie volvería atrás). Ante la ausencia total de filas, el
-- agregado devuelve 0 y se escribe el DEFAULT del contador: una instalación sin
-- facturas empieza en 1. El `CHECK (last_number >= 0)` de 005 hace que ningún
-- valor copiado sea negativo.
INSERT INTO public.system_settings (key, value)
SELECT 'invoice_sequence',
       jsonb_build_object('last_number', coalesce(max(s.last_number), 0))
  FROM public.invoice_sequences s
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------- los topes (007/024/026) ------
-- Un ajuste por clave. El `ORDER BY s.sede_id LIMIT 1` es determinista: con una
-- sola sede es la única fila, y si quedara historia de varias, la migración no
-- elige por la que tenga el mayor tope —eso sería inventar una política de
-- configuración que el dueño no decidió— sino que toma una fila concreta y
-- estable, y lo dice acá.
--
-- `coalesce` en cada DEFAULT: una columna que falta en la fila (024/026 sin
-- aplicar) o una fila que no existe (voucher_settings sin configurar) se
-- escriben con el valor por omisión del módulo, no con una clave ausente: la
-- ausencia y el valor por omisión tienen que ser lo mismo para el lector.
INSERT INTO public.system_settings (key, value)
SELECT v.clave, v.valor
  FROM (
    SELECT
      'voucher_max_per_day'::text AS clave,
      jsonb_build_object(
        'amount',
        (SELECT s.max_per_day FROM public.voucher_settings s ORDER BY s.sede_id LIMIT 1)
      ) AS valor
    UNION ALL
    SELECT
      'voucher_max_per_week'::text AS clave,
      jsonb_build_object(
        'amount',
        (SELECT s.max_per_week FROM public.voucher_settings s ORDER BY s.sede_id LIMIT 1)
      ) AS valor
    UNION ALL
    SELECT
      'voucher_per_day_limits'::text AS clave,
      jsonb_build_object(
        'limits',
        coalesce(
          (SELECT s.per_day_limits FROM public.voucher_settings s ORDER BY s.sede_id LIMIT 1),
          '{}'::jsonb
        )
      ) AS valor
    UNION ALL
    SELECT
      'voucher_allowed_days'::text AS clave,
      jsonb_build_object(
        'days',
        coalesce(
          (SELECT s.allowed_days FROM public.voucher_settings s ORDER BY s.sede_id LIMIT 1),
          '{1,2,3,4,5,6,7}'::smallint[]
        )
      ) AS valor
  ) AS v
ON CONFLICT (key) DO NOTHING;

-- ===================================================================== ===
-- 3. Los DEFAULT documentados de cada clave
-- ===================================================================== ===
--
-- No son una decisión de esta migración: son los de las columnas que cada ajuste
-- reemplaza, y por eso la LECTURA de una clave ausente devuelve lo mismo que
-- devolvía la tabla vieja cuando su fila no estaba.
--
--   'invoice_sequence'       → {"last_number": 0}   (005: DEFAULT 0; el primer
--                                                     número emitido es el 1)
--   'voucher_max_per_day'    → {"amount": null}     (026: «NULL o 0 = sin
--                                                     tope»; `checkVoucherCaps`
--                                                     trata 0 y null igual)
--   'voucher_max_per_week'   → {"amount": null}     (026, mismo criterio)
--   'voucher_per_day_limits' → {"limits": {}}       (026: DEFAULT '{}', «sin
--                                                     topes por día»)
--   'voucher_allowed_days'   → {"days": [1..7]}     (024: DEFAULT
--                                                     '{1,2,3,4,5,6,7}' = todos
--                                                     los días, sin restricción)
--
-- Los topes ausentes se leen como `null` y NO como `0`: el servicio ya trata
-- ambos como «sin tope» (`checkVoucherCaps`, `resolveVoucherDayCap`), así que
-- cualquiera de las dos formas da el mismo comportamiento, y `null` es la que
-- la pantalla distingue de «un tope configurado en cero».
--
-- El valor de una fila vieja se copia TAL COMO está, sin normalizar: si el admin
-- guardó 0 como «sin tope», la clave guarda 0 y la lectura lo traduce igual que
-- antes.

-- ===================================================================== ===
-- 4. `next_invoice_number` (005) re-emitida sobre la fila 'invoice_sequence'
-- ===================================================================== ===
--
-- Firma `(uuid)`: IDÉNTICA a la de 005, sin cambios. Lo que cambia es la fila
-- que bloquea: la clave 'invoice_sequence' de esta tabla en vez de la fila de
-- `invoice_sequences` de la sede.
--
-- EL LOCK ES LA PARTE NO NEGOCIABLE. `SELECT … FOR UPDATE` sobre la fila de la
-- clave es lo que serializa a los emisores concurrentes: el segundo emisor
-- ESPERA en esa fila y, cuando entra, lee el `last_number` que el primero dejó y
-- se lleva el siguiente. Sin ese lock, dos emisiones concurrentes leerían el
-- mismo número y la serie quedaría con un duplicado —el defecto FAC-05 que 005
-- resolvió con este mismo idiom—.
--
-- El incremento sigue DENTRO de la función, y por lo tanto dentro de la
-- transacción del llamador (`invoice_create_atomic`, 052/071): si la emisión
-- aborta, la reserva se revierte con ella y no queda número quemado.
--
-- El parámetro `p_sede_id` se conserva y no se usa. Antes seleccionaba la fila
-- del contador; ahora la fila es la clave, y la sede del llamador es LA sede de
-- la instalación. Se retira de la firma en la unidad que borra `sede_id`.

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_last integer;
BEGIN
  -- La fila del contador tiene que EXISTIR antes de bloquearla: el `ON CONFLICT
  -- DO NOTHING` no pisa el valor vigente y por eso es seguro repetirlo.
  INSERT INTO public.system_settings (key, value)
  VALUES ('invoice_sequence', jsonb_build_object('last_number', 0))
  ON CONFLICT (key) DO NOTHING;

  -- EL LOCK. Mismo idiom que 005 y por el mismo motivo: desde acá, otro emisor
  -- espera. El número se lee de la FILA bloqueada, nunca del sobre que trajo el
  -- llamador, y `coalesce` cubre el `{}` de una fila recién creada (mismo
  -- DEFAULT documentado que la sección 3).
  SELECT coalesce((s.value ->> 'last_number')::integer, 0)
    INTO v_last
    FROM public.system_settings s
   WHERE s.key = 'invoice_sequence'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEDE_NOT_FOUND';
  END IF;

  -- El incremento, en la misma transacción. `jsonb_set` con `create_missing` deja
  -- el sobre con la MISMA forma que la lectura espera.
  UPDATE public.system_settings
     SET value = jsonb_set(value, '{last_number}', to_jsonb(v_last + 1), true)
   WHERE key = 'invoice_sequence';

  RETURN v_last + 1;
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- Con search_path mutable, un esquema anterior en la ruta podría secuestrar
-- `system_settings`. House style desde 018 (y el mismo paso que dan 039 y 071).
ALTER FUNCTION public.next_invoice_number(uuid) SET search_path = public;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.next_invoice_number(uuid) IS
  'FAC-05: reserva el siguiente consecutivo de factura. Firma `(p_sede_id uuid)` idéntica a la de 005 —el parámetro ya NO selecciona nada: la fila del contador es la clave ''invoice_sequence'' de system_settings (072), porque la instalación es de una sola sede—; conservarla mantiene a `invoice_create_atomic` (052/071) llamando a la misma firma y deja el retiro del parámetro para la unidad que borra sede_id. BLOQUEA esa fila con SELECT … FOR UPDATE, lee `last_number` de la fila bloqueada e incrementa DENTRO de la misma transacción del llamador, así que dos emisores concurrentes obtienen números distintos (el segundo espera en el lock y ve el valor que el primero dejó) y un aborto del llamador no quema el número. El INSERT … ON CONFLICT DO NOTHING deja existir la fila antes de bloquearla sin pisar el contador vigente. Devuelve el número emitido siguiente (el primero es el 1).';

-- ------------------------------------------- Cómo verifica el dueño --------
-- Sólo lectura; nada de lo anterior cambia datos.
--
--   -- La tabla existe con su clave y sus cinco ajustes:
--
--   -- SELECT key, value, updated_at
--   --   FROM public.system_settings
--   --  ORDER BY key;
--
--   -- El contador avanza de a uno, sin repetir ni saltar:
--
--   -- SELECT public.next_invoice_number(NULL);  -- 1
--   -- SELECT public.next_invoice_number(NULL);  -- 2
--
--   -- Las dos tablas viejas siguen ahí (el borrado es de otra unidad):
--
--   -- SELECT to_regclass('public.invoice_sequences'),      -- sigue
--   --        to_regclass('public.voucher_settings');       -- sigue
--
--   -- Y la firma de la función no cambió:
--
--   -- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--   --   FROM pg_proc p
--   --  JOIN pg_namespace n ON n.oid = p.pronamespace
--   --  WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';
--   --   next_invoice_number | p_sede_id uuid