-- =============================================================================
-- _platform_fixture.sql — FIXTURE DE PLATAFORMA.  DESCARTABLE.
-- =============================================================================
--
-- QUÉ ES
--   Un stub mínimo del esquema `auth` de Supabase, para que el HISTORIAL de
--   migraciones COMPILE dentro de una base nueva y desechable.  No modela
--   comportamiento: existe solo para que `auth.jwt()` resuelva en tiempo de
--   creación de funciones.
--
-- POR QUÉ EXISTE
--   `008_hardening.sql` (líneas 73-74) declara:
--
--       CREATE OR REPLACE FUNCTION public.current_sede_id()
--       RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
--       SET search_path = public
--       AS $$ SELECT CASE
--              WHEN (auth.jwt() -> 'app_metadata' ->> 'sede_id') ~ '...uuid...' THEN ...
--              ELSE NULL END; $$;
--
--   Como es `LANGUAGE sql`, PostgreSQL valida el cuerpo al crearla.  En la base
--   temporal `orabella_build` (creada con CREATE DATABASE desde template1) el
--   esquema `auth` no existe, así que la migración moría en esa línea con
--   `schema "auth" does not exist`.
--
--   ÉSTA ES LA ÚNICA DEPENDENCIA EJECUTABLE DE PLATAFORMA EN TODO EL HISTORIAL.
--   Se comprobó sobre `app/supabase/migrations/*.sql`, descartando comentarios
--   (`--`) y literales de cadena: las demás apariciones de `auth.jwt()`,
--   `auth.uid()`, `auth.users` y `auth.admin` están en prosa o en el texto de
--   `COMMENT ON`, nunca en SQL que se ejecute.  Por eso NO se declara
--   `auth.uid()`: no lo necesita nada del historial.
--
-- POR QUÉ `NULL::jsonb` Y NO OTRA COSA
--   El stub devuelve NULL.  Entonces `(NULL -> 'app_metadata')` es NULL,
--   `NULL ~ 'regex'` es NULL, y el `CASE` cae en `ELSE NULL`.  Es la respuesta
--   honesta para "no hay JWT": coincide con el deny-by-default que describe el
--   propio comentario de la 008, sin inventar un claim.
--
-- POR QUÉ EL VOLCADO NO LLEVA ESTO
--   El destino (cualquier proyecto Supabase) YA tiene `auth.jwt()` con su
--   definición real.  Si el archivo único declarara `CREATE SCHEMA auth` o
--   `auth.jwt()`, fallaría al aplicarse allí.  Por eso el volcado se hace con
--   `--exclude-schema=auth`, y esta fixture NO se aplica en el destino.
--
--   Lo que el volcado SÍ conserva es la REFERENCIA a `auth.jwt()` dentro del
--   cuerpo de `public.current_sede_id()`, porque un volcado captura texto, no
--   comportamiento: el cuerpo sale idéntico al que hoy está en el historial.
--
-- CÓMO SE USA
--   Se aplica UNA vez, sobre `orabella_build`, ANTES de la migración 001, y en
--   una base que después se tira.  `.squash-build.py` la copia a
--   `~/orabella-db/_platform_fixture.sql` (el directorio de trabajo, fuera del
--   repo) y la aplica ahí con `psql -v ON_ERROR_STOP=1 --single-transaction`.
--
-- ESTE ARCHIVO NO ES UNA MIGRACIÓN.
--   No entra en `app/supabase/migrations/`, no se versiona como parte del
--   esquema y no se aplica jamás contra Pruebas, Producción ni un proyecto
--   Supabase real.  Si aparece algún día dentro de `001_orabella_schema.sql`,
--   es un defecto del archivo único.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT NULL::jsonb $$;

COMMENT ON SCHEMA auth IS
  'FIXTURE de plataforma (descartable): stub minimo para que el historial compile. NO se aplica en el destino.';
COMMENT ON FUNCTION auth.jwt() IS
  'FIXTURE de plataforma (descartable): devuelve NULL (sin JWT). En el destino real, Supabase provee la version verdadera.';