-- 069_superadmin_role.sql — G1: el rol de PLATAFORMA `superadmin`.
--
-- MOTIVO DEL ARCHIVO (decisión del dueño, 2026-10-01)
--
-- El techo de privilegios del sistema es "admin de sede": no existe una capa por
-- encima del negocio donde SOLO el dueño administre la instalación. La identidad
-- de esa capa no se podía ni REPRESENTAR: el catálogo de roles está fijado por un
-- CHECK a tres códigos (`002_auth.sql:51`), así que ningún usuario podía llevar
-- un rol distinto de admin/empleado/caja. Este archivo abre el catálogo al cuarto
-- código, `superadmin`, que la guarda de plataforma (G1) exigirá después.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
--   1. Amplía el CHECK de `roles.code` para admitir `superadmin`, re-creando la
--      constraint por su nombre REAL (`roles_code_check`).
--   2. Inserta la fila del catálogo para `superadmin` de forma idempotente.
--   3. NADA MÁS: no toca `users`, `user_roles` ni `sessions`, no escribe roles
--      sobre personas y no relaja `users.sede_id`.
--
-- NOMBRE REAL DE LA CONSTRAINT
--
-- El CHECK nació como constraint de columna SIN nombre en `002_auth.sql:51`, y
-- ninguna migración posterior lo renombró (no hay ningún `DROP CONSTRAINT` ni
-- `ALTER ... RENAME` sobre `public.roles`). PostgreSQL nombra una constraint de
-- columna CHECK como `<tabla>_<columna>_check`, así que el nombre real es
-- `roles_code_check`. El `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` con ESE
-- nombre es el patrón idempotente que ya usan 033, 038, 063 y 066.
--
-- ES UN ROL ADICIONAL, NO UNA SEDE NUEVA
--
-- `superadmin` NO crea una sede ni libera `users.sede_id`: quien lo tenga sigue
-- perteneciendo a su sede y `resolveSede` (la frontera del aislamiento por sede)
-- NO se toca. El privilegio de plataforma viene del ROL, y es la guarda de
-- plataforma la que lo exige; para el negocio la cuenta sigue siendo un usuario
-- de su sede. Por eso acá no hay una sola sentencia sobre `users`.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: el `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
-- deja el esquema idéntico en cada corrida, y el `INSERT ... ON CONFLICT (code)
-- DO NOTHING` no duplica la fila. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 069 es el siguiente libre (la serie llega a
-- `068_payroll_start_date.sql`); este archivo NO renumera ni toca ningún archivo
-- anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. El catálogo abre el cuarto código
-- ===================================================================== ---

ALTER TABLE public.roles
  DROP CONSTRAINT IF EXISTS roles_code_check;

ALTER TABLE public.roles
  ADD CONSTRAINT roles_code_check
  CHECK (code IN ('admin', 'empleado', 'caja', 'superadmin'));

-- ===================================================================== ---
-- 2. La fila del catálogo (idempotente)
-- ===================================================================== ---

INSERT INTO public.roles (code, description)
VALUES (
  'superadmin',
  'G1: administración de la plataforma (sedes, módulos por sede y sus administradores). NO es un rol de sede: no se otorga ni se quita desde la administración de una sede.'
)
ON CONFLICT (code) DO NOTHING;

-- ===================================================================== ---
-- 3. Cómo verifica el dueño (SOLO LECTURA; nada de acá cambia datos)
-- ===================================================================== ---
--
--   * La constraint existe, con el cuarto código y el nombre real:
--
--       -- SELECT conname, pg_get_constraintdef(oid)
--       --   FROM pg_constraint
--       --  WHERE conrelid = 'public.roles'::regclass
--       --    AND conname = 'roles_code_check';
--
--   * La fila del catálogo existe UNA sola vez:
--
--       -- SELECT code, description FROM public.roles ORDER BY code;
--
--   * Re-ejecutar el archivo deja el mismo esquema y la misma fila.
