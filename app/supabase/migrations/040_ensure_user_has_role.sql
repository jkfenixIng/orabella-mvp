-- 040_ensure_user_has_role.sql — CO-4: la red de seguridad de roles deja de
-- ser un read-then-insert sin lock.
--
-- MOTIVO DEL ARCHIVO
--
-- `upsertEmployee` (src/features/admin/service.ts) mantiene una red de
-- seguridad: si el usuario vinculado no tiene NINGÚN rol, se le asigna
-- `empleado` para que nadie quede sin acceso por olvido. La decisión se tomaba
-- desde el cliente con un `select` y la escritura con un `insert`, es decir DOS
-- requests de PostgREST —y por lo tanto dos transacciones distintas, porque
-- PostgREST no ofrece multi-statement por request: la misma nota que el README
-- de facturación ya deja escrita para `createInvoice`—. Entre las dos no hay
-- nada que las una, así que este intercalado era alcanzable:
--
--   * la red lee "este usuario no tiene ningún rol";
--   * OTRO escritor (`setUserRoles` -> `replace_user_roles`, 039) confirma
--     `admin` para el mismo usuario;
--   * la red inserta `empleado`;
--   * el usuario termina con DOS roles.
--
-- Dos roles no es un detalle cosmético: el modelo del proyecto es UN rol por
-- usuario (`setUserRolesSchema` exige una lista de longitud 1) y el resto del
-- código —permisos, sesión, gates por sede— está escrito sobre esa invariante.
--
-- Por qué NO alcanza con reordenar ni con releer desde el cliente: una
-- re-lectura de compensación también está sin lock, así que entre la relectura
-- y la escritura vuelve a existir la misma ventana; y si la relectura se usa
-- para "borrar el que sobra", puede borrar un rol concedido legítimamente por
-- otro operador. El cliente no puede emitir `FOR UPDATE`: cada request de
-- PostgREST es su propia transacción, que es exactamente la razón por la que
-- existe 039.
--
-- MECANISMO
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)`, como 039 y como
-- `next_invoice_number` (005): una función es UNA sentencia, y una sentencia
-- corre entera dentro de una sola transacción del servidor. La decisión y la
-- escritura quedan adentro, y el lock de la fila del usuario (`FOR UPDATE`)
-- serializa a los escritores concurrentes: quien quiera cambiar los roles del
-- mismo usuario —`replace_user_roles` (039) toma ESE MISMO lock— espera a que
-- esta función confirme, y viceversa. La invariante deja de depender de que el
-- cliente mire y escriba sin que nadie se interponga.
--
-- La intención es la de la red, no "agregar un rol": la función escribe
-- ÚNICAMENTE si el usuario no tiene ningún rol (`NOT EXISTS`), y devuelve el
-- conjunto final —el que quedó, no el que se pidió— para que el llamador
-- contraste la post-condición real y no una suposición.
--
-- QUIÉN PUEDE LLAMARLA (decisión de permiso, explícita)
--
--   * SECURITY INVOKER, igual que 039: el único llamador es el cliente
--     `service_role` del servidor (`createAdminClient()`), que ya bypassa RLS.
--   * `CREATE FUNCTION` deja EXECUTE a PUBLIC por defecto, y eso expondría el
--     otorgamiento de roles a cualquier JWT (anon/authenticated) vía
--     PostgREST. Se revoca de PUBLIC, anon y authenticated y se otorga sólo a
--     service_role, el mismo bloque de 018/039.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay UPDATE, DELETE ni TRUNCATE sobre `users`,
--     `roles` ni `user_roles`.
--   * No agrega columnas, índices ni constraints: la tabla objetivo
--     (`user_roles`) ya tiene PK `(user_id, role_id)` (002_auth.sql) y el lock
--     usa la PK de `users`.
--   * No "arregla" a un usuario que ya tenga dos roles: esta función nunca
--     quita roles, sólo impide que quede en cero.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja la función idéntica en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ------------------------------------------------------------- 1. Función ---
-- La red entera, indivisible. Firma `(uuid, text)`: el usuario y el código de
-- rol a dejarle SÓLO si no tiene ninguno (el servicio manda un código, no un
-- id: el catálogo vive adentro y se resuelve en la misma transacción).
CREATE OR REPLACE FUNCTION public.ensure_user_has_role(p_user_id uuid, p_role_code text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_tenia_roles boolean;
  v_filas integer;
  v_resultantes text[];
BEGIN
  -- 1.1 El CANDADO, antes de leer o escribir nada. Es el MISMO lock de la fila
  --     del usuario que toma `replace_user_roles` (039): por eso los dos
  --     caminos que pueden cambiar los roles de una persona quedan
  --     serializados entre sí, y el intercalado de CO-4 deja de existir. El
  --     usuario tiene que existir (no se le asignan roles a un fantasma) y eso
  --     se comprueba con la misma sentencia que toma el lock.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.2 VALIDACIÓN del código pedido. Un rol que no está en el catálogo no se
  --     inventa ni se ignora en silencio: se aborta acá. `p_role_code` nulo
  --     tampoco encuentra fila, así que cae en el mismo error.
  SELECT r.code INTO v_rol
  FROM public.roles r
  WHERE r.code = p_role_code;

  IF v_rol IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 1.3 El estado ANTES de escribir, ya bajo el candado: es la condición de la
  --     red y también el valor esperado contra el que 1.5 contrasta lo que la
  --     sentencia de 1.4 efectivamente hizo.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id
  ) INTO v_tenia_roles;

  -- 1.4 La ESCRITURA CONDICIONAL: el `NOT EXISTS` es la intención literal de la
  --     red ("sólo si no tiene NINGÚN rol"), no "agregá este rol". Corre en la
  --     misma transacción que el candado, así que entre la comprobación y el
  --     insert no hay ventana: ningún otro escritor que respete el lock puede
  --     confirmar un rol en el medio.
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT p_user_id, r.id
  FROM public.roles r
  WHERE r.code = v_rol
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id
    );

  -- 1.5 Red de seguridad dentro de la transacción: la sentencia tiene que haber
  --     escrito exactamente lo que correspondía a 1.3 —una fila si el usuario
  --     no tenía roles, CERO si ya tenía alguno—. El caso "ya tenía y se
  --     escribió" no lo detecta ninguna post-condición posterior (el usuario
  --     queda con roles, y con dos), así que se comprueba acá. Si no coincide,
  --     el RAISE EXCEPTION revierte también el insert de 1.4.
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF
    (v_tenia_roles AND v_filas <> 0)
    OR (NOT v_tenia_roles AND v_filas <> 1)
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 1.6 La POST-CONDICIÓN real, que es lo que la función devuelve: el conjunto
  --     que quedó, leído de la base y no reconstruido desde lo pedido. Jamás
  --     puede ser vacío: si lo fuera, la red habría dejado a la persona sin
  --     ningún rol, que es justo lo que existe para impedir.
  SELECT array_agg(r.code ORDER BY r.code) INTO v_resultantes
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  IF v_resultantes IS NULL OR cardinality(v_resultantes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_resultantes;
END;
$$;

-- ------------------------------------------------- 2. search_path fijo ---
-- La función resuelve `users`, `roles` y `user_roles`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. House style
-- desde 018 (y idéntico a 039).
ALTER FUNCTION public.ensure_user_has_role(uuid, text) SET search_path = public;

-- ---------------------------------------------------- 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría llamar la red por PostgREST y tocar los roles de
-- cualquier usuario. El único llamador legítimo es el cliente service_role del
-- servidor.
REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_user_has_role(uuid, text) TO service_role;

-- --------------------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.ensure_user_has_role(uuid, text) IS
'CO-4: red de seguridad de roles ATÓMICA. Deja p_role_code al usuario SÓLO si no tiene ningún rol (intención de la red de upsertEmployee), en una sola transacción del servidor, con lock FOR UPDATE de la fila del usuario —el mismo lock de replace_user_roles (039), que es lo que serializa a los dos escritores de roles—. Valida el código contra el catálogo y aborta con RAISE EXCEPTION ''ROLE_NOT_FOUND'' (P0001) si no existe; ''USER_NOT_FOUND'' si el usuario no existe; en ambos casos la transacción se revierte y el usuario queda como estaba. Devuelve el conjunto final de roles, nunca vacío. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- la red sólo garantiza que el usuario NO quede en cero. Un usuario que ya
-- arrastre dos roles por el bug anterior no se "corrige" solo: eso es una
-- decisión de negocio (qué rol conserva) y se resuelve desde Administración
-- con `replace_user_roles` (039) o con un UPDATE manual decidido por quien
-- opera la base.
