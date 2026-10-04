-- 070_sedes_unique_name.sql — un nombre de sede identifica una sede.
--
-- MOTIVO (dos razones, ambas de negocio)
--
--   1. El aprovisionamiento de la sede de plataforma es idempotente POR NOMBRE:
--      `asegurarSedeDePlataforma` (scripts/create-superadmin.ts) LEE `sedes`
--      por `name` y, si no encuentra, crea `Plataforma (sistema)`. `sedes` no
--      tiene `code` ni unicidad por nombre (003_admin.sql), así que la garantía
--      de "una sola sede de plataforma" no vive en la base: vive en un
--      leer → crear → releer-y-contar del script. Dos corridas que se crucen
--      pueden crear dos filas con el mismo nombre y cada una anclarse a una
--      sede distinta, en silencio. La aplicación no es una barrera contra la
--      concurrencia; la barrera va acá.
--   2. Dos sedes con el mismo nombre son indistinguibles para una persona, y
--      ahora la pantalla de plataforma lista TODAS las sedes
--      (src/features/platform/service.ts). Dos filas iguales en esa lista no
--      se pueden elegir ni reportar con confianza.
--
-- DECISIÓN DE LA CLAVE: `lower(btrim(name))`
--
-- El nombre de una sede es una etiqueta HUMANA y es su única clave (no hay
-- `code`). Para una persona que lee la lista, los espacios de los extremos y la
-- diferencia de mayúsculas son INVISIBLES: "Sede Norte", " sede norte " y "SEDE
-- NORTE" son la misma sede, y por eso deben chocar. `lower(btrim(name))` es
-- entonces la clave correcta. NO se colapsan los espacios internos ni los
-- signos: "Sede Norte" y "Sede  Norte" son distinguibles a simple vista, y
-- unirlos rechazaría nombres que el dueño ve distintos. Este índice también
-- cierra la variante que el script no ve: un `plataforma (sistema)` en
-- minúsculas no coincide con el `.eq("name", ...)` exacto y hoy crearía una
-- segunda sede de plataforma; con este índice la base lo impide.
--
-- QUÉ HACER SI YA HAY NOMBRES REPETIDOS
--
-- El índice NO se puede crear con datos que lo violen (PostgreSQL rechaza el
-- CREATE con 23505). Este archivo detecta el caso ANTES y aborta con un mensaje
-- que lista los nombres repetidos y las filas de cada uno. No borra, no
-- renombra, no fusiona y no elige ganador: decide el dueño. El paso es revisar
-- los nombres que el error lista, renombrar las filas repetidas para que cada
-- nombre quede único y volver a correr la migración. El pre-vuelo es el PRECIO
-- de no tocar las filas existentes: renombrar en automático cambiaría el
-- nombre de sedes que la gente ya usa.
--
-- IDEMPOTENTE: el `CREATE UNIQUE INDEX IF NOT EXISTS` no hace nada si el índice
-- ya existe, así que volver a correr el archivo es seguro. No toca datos: no
-- borra (`DELETE`), no actualiza (`UPDATE`), no fusiona filas y no reescribe
-- nada. Sólo `sedes`: ninguna otra tabla se menciona.
--
-- COSTO DE NUMERACIÓN: 070 es el siguiente libre (la serie llega a
-- `069_superadmin_role.sql`); este archivo NO renumera ni toca ningún archivo
-- anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Pre-vuelo: sin esto, el CREATE de abajo fallaría con 23505 y un mensaje
--    de PostgreSQL que no dice QUÉ nombres chocan ni QUÉ hacer. Acá se listan.
-- ===================================================================== ---

DO $$
DECLARE
  v_duplicados integer;
  v_detalle text;
BEGIN
  SELECT count(*)
    INTO v_duplicados
    FROM (
      SELECT lower(btrim(name)) AS clave
        FROM public.sedes
       GROUP BY lower(btrim(name))
      HAVING count(*) > 1
    ) AS d;

  IF v_duplicados > 0 THEN
    -- Detalle acotado y legible: el nombre normalizado (la clave que choca) y
    -- las filas que lo comparten, para que el dueño sepa cuáles renombrar.
    SELECT string_agg(
             format('  «%s» — %s fila(s): %s', d.clave, d.repetidas, d.filas),
             E'\n' ORDER BY d.clave)
      INTO v_detalle
      FROM (
        SELECT lower(btrim(name)) AS clave,
               count(*) AS repetidas,
               string_agg(format('%s [id %s]', name, id), ', ' ORDER BY created_at, id) AS filas
          FROM public.sedes
         GROUP BY lower(btrim(name))
        HAVING count(*) > 1
      ) AS d;

    RAISE EXCEPTION E'migración 070 ABORTADA: % nombre(s) de sede están repetidos comparando sin espacios de los extremos ni mayúsculas, y el índice único no se puede crear con datos que lo violen (PostgreSQL responde 23505). No se borró, renombró ni fusionó ninguna fila.\n  QUÉ HACER: renombre las sedes repetidas para que cada nombre quede único y vuelva a correr la migración.\n  Nombres repetidos:\n%',
      v_duplicados, v_detalle
      USING ERRCODE = '23505',
            HINT = 'El nombre de la sede es la clave con la que una persona distingue una sede de otra.';
  END IF;
END $$;

-- ===================================================================== ---
-- 2. La barrera: unicidad sobre el nombre normalizado. Cubre INSERT y UPDATE
--    y a cualquier escritor (script, API, SQL a mano), no sólo al script de
--    aprovisionamiento.
-- ===================================================================== ---

CREATE UNIQUE INDEX IF NOT EXISTS uq_sedes_name
  ON public.sedes (lower(btrim(name)));

COMMENT ON INDEX public.uq_sedes_name IS
  'Un nombre de sede identifica una sede: la clave es lower(btrim(name)), porque los espacios de los extremos y las mayúsculas son invisibles para quien lee la lista de sedes. Cierra la carrera del aprovisionamiento por nombre de la sede de plataforma (Plataforma (sistema)) y la indistinguibilidad de dos sedes iguales en la pantalla de plataforma.';

-- ===================================================================== ---
-- 3. Cómo verifica el dueño (SOLO LECTURA; nada de acá cambia datos)
-- ===================================================================== ---
--
--   * El índice existe, es único y va sobre la expresión normalizada:
--
--       -- SELECT indexname, indexdef
--       --   FROM pg_indexes
--       --  WHERE schemaname = 'public'
--       --    AND tablename = 'sedes'
--       --    AND indexname = 'uq_sedes_name';
--
--   * No quedan nombres repetidos bajo la clave:
--
--       -- SELECT lower(btrim(name)) AS clave, count(*)
--       --   FROM public.sedes
--       --  GROUP BY lower(btrim(name))
--       -- HAVING count(*) > 1;
--
--   * Re-ejecutar el archivo deja el mismo esquema (no hace nada).
