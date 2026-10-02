-- 015_employees_full_name.sql — nombre propio en empleados (ADM).
--
-- La lista de empleados se encabeza por nombre, y el personal sin login
-- no tiene de dónde heredarlo: el nombre vive en la fila del empleado.
-- Se rellena desde el usuario vinculado cuando existe; los huérfanos
-- quedan pendientes de la próxima edición (el esquema ya lo exige).
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS full_name text NOT NULL DEFAULT '';

UPDATE public.employees AS e
SET full_name = u.full_name
FROM public.users AS u
WHERE u.id = e.user_id
  AND (e.full_name IS NULL OR btrim(e.full_name) = '')
  AND u.full_name IS NOT NULL
  AND btrim(u.full_name) <> '';

COMMENT ON COLUMN public.employees.full_name IS
  'ADM: nombre del empleado. Obligatorio; heredado del usuario vinculado cuando existe.';
