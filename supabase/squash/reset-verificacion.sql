-- reset-verificacion.sql — Verificación del RESET de la base PRUEBAS
-- =====================================================================
-- Script de SOLO LECTURA. No contiene DROP/CREATE/ALTER/DELETE: su único
-- propósito es medir el estado posterior al reset y compararlo con los
-- valores esperados del procedimiento.
--
-- Uso (desde D:/u/orabella, la clave NUNCA va en la línea de comandos):
--   psql -h <pooler> -p 5432 -U <user> -d postgres -v ON_ERROR_STOP=1 \
--        -f app/supabase/squash/reset-verificacion.sql
--
-- Cada métrica imprime: ETIQUETA | VALOR | ESPERADO | OK
-- "OK" compara el valor contra lo esperado; los chequeos de lista (sede_id,
-- extensiones, firmas) imprimen el detalle en vez de un sí/no.
--
-- Los roles que TIENEN que tener default privileges en `public` son un dato de
-- la PLATAFORMA, no del proyecto.  Se pueden ajustar con
--   psql -v roles_default_esperados='postgres,supabase_admin' ...
-- y en PRODUCCION son exactamente ésos dos.

\pset border 2
\pset linestyle unicode

\if :{?roles_default_esperados}
\else
\set roles_default_esperados 'postgres,supabase_admin'
\endif

\echo ''
\echo '### 1. OBJETOS DEL ESQUEMA public ###'
-- "funciones" = funciones de la APLICACIÓN, es decir las que NO pertenecen a
-- una extensión (btree_gist aporta ~188 funciones de soporte en public y no
-- son código de la app, por eso se mide aparte en el desglose de más abajo).
SELECT 'tablas'      AS objeto, count(*)::text AS valor, '36' AS esperado,
       CASE WHEN count(*) = 36 THEN 'OK' ELSE 'FALLA' END AS ok
FROM pg_tables WHERE schemaname = 'public'
UNION ALL
SELECT 'tablas con RLS', count(*)::text, '36',
       CASE WHEN count(*) = 36 THEN 'OK' ELSE 'FALLA' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
UNION ALL
SELECT 'tablas SIN RLS', count(*)::text, '0',
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FALLA' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
UNION ALL
SELECT 'politicas RLS', count(*)::text, '10',
       CASE WHEN count(*) = 10 THEN 'OK' ELSE 'FALLA' END
FROM pg_policies WHERE schemaname = 'public'
UNION ALL
SELECT 'funciones (app)', count(*)::text, '28',
       CASE WHEN count(*) = 28 THEN 'OK' ELSE 'FALLA' END
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass
                    AND d.refclassid = 'pg_extension'::regclass)
UNION ALL
SELECT 'procedimientos', count(*)::text, '0',
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FALLA' END
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'p';

\echo ''
\echo '--- desglose de funciones en public (informativo) ---'
SELECT coalesce(ext.extname, '(sin extension: app)') AS origen,
       count(*) AS funciones
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL (
  SELECT e2.extname FROM pg_depend d
  JOIN pg_extension e2 ON e2.oid = d.refobjid
  WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass
    AND d.refclassid = 'pg_extension'::regclass
  LIMIT 1) ext ON true
WHERE n.nspname = 'public' AND p.prokind = 'f'
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '### 2. CATÁLOGO (seeds/catalog.sql) ###'
SELECT * FROM (VALUES
  ('roles',              (SELECT count(*) FROM public.roles),              4),
  ('sedes',              (SELECT count(*) FROM public.sedes),              1),
  ('cash_denominations', (SELECT count(*) FROM public.cash_denominations),11),
  ('system_settings',    (SELECT count(*) FROM public.system_settings),    5),
  ('payment_methods',    (SELECT count(*) FROM public.payment_methods),    6),
  ('tax_configs',        (SELECT count(*) FROM public.tax_configs),        2),
  ('cash_registers',     (SELECT count(*) FROM public.cash_registers),     1)
) AS t(tabla, valor, esperado);

\echo ''
\echo '### 3. DATOS DE ACEPTACIÓN (seeds/acceptance.sql) ###'
SELECT * FROM (VALUES
  ('users',              (SELECT count(*) FROM public.users),              10),
  ('employees',          (SELECT count(*) FROM public.employees),          10),
  ('services',           (SELECT count(*) FROM public.services),            4),
  ('products',           (SELECT count(*) FROM public.products),            3),
  ('inventory_movements',(SELECT count(*) FROM public.inventory_movements), 3),
  ('user_roles',         (SELECT count(*) FROM public.user_roles),         11)
) AS t(tabla, valor, esperado);

\echo ''
\echo '### 4. sede_id SOLO en users ###'
SELECT table_name,
       CASE WHEN table_name = 'users' THEN 'OK' ELSE 'FALLA' END AS ok
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'sede_id'
ORDER BY table_name;

\echo ''
\echo '### 5. UNA sola sede y ACTIVA (SEDE_AMBIGUA si no) ###'
SELECT count(*)                                        AS sedes_total,
       count(*) FILTER (WHERE is_active)               AS sedes_activas,
       CASE WHEN count(*) = 1 AND count(*) FILTER (WHERE is_active) = 1
            THEN 'OK' ELSE 'FALLA' END                 AS ok
FROM public.sedes;

\echo ''
\echo '### 6. users.sede_id: no nulas y apuntando a esa sede ###'
SELECT count(*)                                                   AS users_total,
       count(*) FILTER (WHERE u.sede_id IS NULL)                  AS sede_id_nula,
       count(*) FILTER (WHERE u.sede_id IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM public.sedes s
                                          WHERE s.id = u.sede_id))  AS sede_id_huerfano,
       CASE WHEN count(*) FILTER (WHERE u.sede_id IS NULL) = 0
             AND count(*) FILTER (WHERE u.sede_id IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM public.sedes s
                                            WHERE s.id = u.sede_id)) = 0
            THEN 'OK' ELSE 'FALLA' END                           AS ok
FROM public.users u;

\echo ''
\echo '### 7. FIRMAS de payroll_apply_atomic / next_invoice_number ###'
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       pg_get_function_result(p.oid)            AS retorna
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('payroll_apply_atomic', 'next_invoice_number')
ORDER BY p.proname, argumentos;

-- pronargs = número de argumentos de ENTRADA de cada firma.
-- payroll_apply_atomic: UNA sola firma, de 4 argumentos de entrada.
-- next_invoice_number: la firma válida es la SIN argumentos (072); lo que no
-- debe existir es la sobrecarga legada `next_invoice_number(p_sede_id uuid)`.
SELECT 'payroll_apply_atomic' AS funcion,
       count(*)::text         AS firmas,
       coalesce(max(p.pronargs), 0)::text AS args_entrada,
       CASE WHEN count(*) = 1 AND max(p.pronargs) = 4
            THEN 'OK (una sola firma de 4 argumentos)'
            ELSE 'FALLA' END AS ok
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'payroll_apply_atomic'
UNION ALL
SELECT 'next_invoice_number',
       count(*)::text,
       coalesce(max(p.pronargs), 0)::text,
       CASE WHEN count(*) = 1 AND max(p.pronargs) = 0
            THEN 'OK (una sola firma, sin argumentos: sin sobrecarga con p_sede_id)'
            ELSE 'FALLA' END
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number'
ORDER BY funcion;

\echo ''
\echo '### 8. UBICACIÓN DE EXTENSIONES ###'
SELECT e.extname, n.nspname AS esquema,
       CASE WHEN e.extname = 'btree_gist' THEN n.nspname
            WHEN e.extname = 'pgcrypto'   THEN n.nspname END AS esperado_esquema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('btree_gist', 'pgcrypto')
ORDER BY e.extname;

\echo ''
\echo '### 9. CONTEO DE FILAS POR TABLA (post-reset) ###'
SELECT relname AS tabla,
       (xpath('/row/c/text()', query_to_xml(
          format('SELECT count(*) AS c FROM public.%I', relname),
          false, true, '')))[1]::text::bigint AS filas
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY relname;

\echo ''
\echo '### 10. PLATAFORMA: ACL y default privileges del esquema public ###'
-- El detalle primero, para poder leer qué hay; el veredicto después.
SELECT pg_get_userbyid(n.nspowner)                             AS propietario,
       coalesce(array_to_string(n.nspacl, ', '), '<NULL>')     AS nspacl
FROM pg_namespace n WHERE n.nspname = 'public';

SELECT pg_get_userbyid(d.defaclrole)                    AS rol,
       d.defaclobjtype::text                            AS objtype,
       coalesce(array_to_string(d.defaclacl, ', '), '<NULL>') AS acl
FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
ORDER BY 1, 2;

\echo ''
\echo '--- 10.a VEREDICTO: el ACL y las default privileges deben seguir SIENDO los de la plataforma ---'
-- Éste es el punto que distingue un reset que VACIA `public` de uno que lo
-- BORRA.  Con `DROP SCHEMA public CASCADE` el `nspacl` y las filas de
-- `pg_default_acl` se van con el esquema, y las del rol `supabase_admin` no se
-- pueden reponer desde `postgres` (no es superusuario y `SET ROLE
-- supabase_admin` está denegado).  En una base de pruebas es un detalle; en
-- PRODUCCIÓN es un cambio permanente.  Por eso estos tres chequeos existen.

-- El ACL que la plataforma deja en `public`: el propietario con todo, PUBLIC
-- con USAGE, y USAGE para postgres, anon, authenticated y service_role.
WITH esperado(ord, item) AS (
  VALUES (1, 'pg_database_owner=UC/pg_database_owner'),
         (2, '=U/pg_database_owner'),
         (3, 'postgres=U/pg_database_owner'),
         (4, 'anon=U/pg_database_owner'),
         (5, 'authenticated=U/pg_database_owner'),
         (6, 'service_role=U/pg_database_owner')
)
SELECT 'nspacl de public'                            AS comprobacion,
       coalesce((SELECT array_to_string(nspacl, ', ') FROM pg_namespace
                  WHERE nspname = 'public'), '<NULL>') AS valor,
       (SELECT string_agg(item, ', ' ORDER BY ord) FROM esperado) AS esperado,
       CASE WHEN coalesce((SELECT array_to_string(nspacl, ', ') FROM pg_namespace
                            WHERE nspname = 'public'), '<NULL>')
               = (SELECT string_agg(item, ', ' ORDER BY ord) FROM esperado)
            THEN 'OK' ELSE 'FALLA (se perdio o cambio el ACL del esquema)' END AS ok;

SELECT 'propietario de public'    AS comprobacion,
       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') AS valor,
       'pg_database_owner'                                                     AS esperado,
       CASE WHEN (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public')
               = 'pg_database_owner'
            THEN 'OK' ELSE 'FALLA' END                                        AS ok;

-- Cada rol de la plataforma que tiene default privileges debe seguir TENIENDO
-- las tres: tablas (r), secuencias (S) y funciones (f).
SELECT 'roles con default privileges' AS comprobacion,
       coalesce((
         SELECT string_agg(r, ',' ORDER BY r) FROM (
           SELECT DISTINCT pg_get_userbyid(defaclrole) AS r
           FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
           WHERE n.nspname = 'public') s), '<NINGUNO>') AS valor,
       replace(:'roles_default_esperados', ' ', '') AS esperado,
       CASE WHEN coalesce((
              SELECT string_agg(r, ',' ORDER BY r) FROM (
                SELECT DISTINCT pg_get_userbyid(defaclrole) AS r
                FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
                WHERE n.nspname = 'public') s), '')
              = replace(:'roles_default_esperados', ' ', '')
            THEN 'OK'
            ELSE 'FALLA: falta default privileges de algun rol de la plataforma. '
                 || 'Un DROP SCHEMA public CASCADE las borre y postgres NO las puede recrear.'
            END AS ok;

SELECT 'filas en pg_default_acl de public' AS comprobacion,
       (SELECT count(*)::text FROM pg_default_acl d
          JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE n.nspname = 'public') AS valor,
       (3 * array_length(string_to_array(replace(:'roles_default_esperados', ' ', ''), ','), 1))::text AS esperado,
       CASE WHEN (SELECT count(*) FROM pg_default_acl d
                   JOIN pg_namespace n ON n.oid = d.defaclnamespace
                  WHERE n.nspname = 'public')
               = 3 * array_length(string_to_array(replace(:'roles_default_esperados', ' ', ''), ','), 1)
            THEN 'OK' ELSE 'FALLA' END AS ok;

\echo ''
\echo '### 11. OTROS ESQUEMAS: deben seguir intactos ###'
SELECT nspname FROM pg_namespace
WHERE nspname IN ('auth','storage','vault','extensions','graphql','realtime','pgbouncer')
ORDER BY 1;

\echo ''
\echo '### FIN DE LA VERIFICACIÓN ###'