-- 039_atomic_role_replacement.sql — CO-2: reemplazar los roles de un usuario
-- deja de poder dejarlo con CERO roles.
--
-- MOTIVO DEL ARCHIVO
--
-- `setUserRoles` (src/features/admin/service.ts) reemplazaba los roles con un
-- DELETE y un INSERT SEGUIDOS y SIN transacción: dos requests distintos contra
-- PostgREST, que no ofrece multi-statement por request (la misma nota que el
-- README de facturación ya deja escrita para `createInvoice`). Si el INSERT
-- fallaba, o si dos escritores se intercalaban, el DELETE ya había confirmado:
-- el usuario quedaba con CERO roles y `requireSedeRole`
-- (`src/shared/lib/sede.ts`) lo rechazaba con 403 en TODA la aplicación. No es
-- una degradación: es el bloqueo total de la persona. El otro escritor de esas
-- tablas son las propias rutas de autenticación
-- (`src/features/auth/service.ts`).
--
-- MECANISMO
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)`: es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number`, 005). Una función es UNA sentencia, y una sentencia
-- corre entera dentro de una sola transacción del servidor: o aplica el
-- reemplazo completo, o no aplica nada —el DELETE incluido—. Eso es lo que
-- vuelve el reemplazo atómico, y NO un orden distinto de las dos escrituras:
--   * borrar primero deja CERO roles si el INSERT falla (el hallazgo, hoy);
--   * insertar primero sobre-privilegia al usuario si el DELETE falla, que es
--     peor que un bloqueo.
-- Adentro de la transacción el orden es indiferente: el par es indivisible.
--
-- SERIALIZACIÓN: dos reemplazos concurrentes del MISMO usuario no se
-- intercalan. La función toma primero el lock de la fila del usuario
-- (`FOR UPDATE`, el mismo patrón que `next_invoice_number` usa sobre la fila de
-- la sede): el segundo reemplazo espera a que el primero confirme y recién ahí
-- lee y escribe, así que el resultado final es uno de los dos conjuntos —
--nunca la unión de ambos ni el vacío—.
--
-- QUIÉN PUEDE LLAMARLA (decisión de permiso, explícita)
--
--   * NO necesita ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS; mover el
--     privilegio a la función no agregaría nada. Se declara SECURITY INVOKER.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría el reemplazo de roles a cualquier JWT
--     (anon/authenticated) vía PostgREST. Se cierra en el paso 3: se revoca de
--     PUBLIC, anon y authenticated, y se otorga sólo a service_role. Es la
--     misma decisión que 018 tomó para `write_audit_log`.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay UPDATE, DELETE ni TRUNCATE sobre `users`,
--     `roles` ni `user_roles`.
--   * No agrega columnas, índices ni constraints: la tabla objetivo
--     (`user_roles`) ya tiene PK `(user_id, role_id)` y el lock usa la PK de
--     `users`.
--   * No backfillea: un usuario que HOY esté sin roles no se arregla solo (ver
--     la nota final).
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja la función idéntica en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ------------------------------------------------------------- 1. Función ---
-- El reemplazo entero, indivisible. Firma `(uuid, text[])`: el usuario y los
-- códigos de rol pedidos (el servicio manda códigos, no ids: el catálogo vive
-- adentro y se resuelve en la misma transacción).
CREATE OR REPLACE FUNCTION public.replace_user_roles(p_user_id uuid, p_role_codes text[])
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_codes text[];
  v_desconocidos integer;
  v_filas integer;
BEGIN
  -- 1.1 El CANDADO, antes de leer o escribir nada del reemplazo. El lock sobre
  --     la fila del usuario es lo que serializa a los escritores concurrentes:
  --     el segundo espera acá hasta que el primero confirme. El usuario tiene
  --     que existir (no se asignan roles a un fantasma) y eso se comprueba con
  --     la misma sentencia que toma el lock.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.2 VALIDACIÓN de la entrada. Un reemplazo sin roles no es un reemplazo:
  --     "cero roles" es exactamente el estado que este archivo existe para
  --     hacer imposible, así que el arreglo vacío se rechaza igual que un
  --     código desconocido.
  IF p_role_codes IS NULL OR cardinality(p_role_codes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     Ningún código pedido puede quedar afuera: si uno no existe en el
  --     catálogo, se aborta el reemplazo entero en vez de aplicar un
  --     subconjunto silencioso.
  SELECT count(*) INTO v_desconocidos
  FROM (SELECT DISTINCT t.code FROM unnest(p_role_codes) AS t(code)) AS pedidos
  WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r WHERE r.code = pedidos.code
  );

  IF v_desconocidos > 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     El conjunto APLICADO: los códigos pedidos, sin repetidos y ordenados.
  --     Es lo que devuelve la función, así el servicio puede contrastar lo
  --     pedido contra lo que la base efectivamente escribió.
  SELECT array_agg(DISTINCT r.code ORDER BY r.code) INTO v_codes
  FROM public.roles r
  WHERE r.code = ANY (p_role_codes);

  -- 1.3 El REEMPLAZO. El DELETE y el INSERT están en la misma transacción que
  --     el candado: si cualquiera de los dos falla, la transacción entera se
  --     revierte y el usuario conserva su conjunto viejo. Por eso el orden
  --     (borrar y después insertar) es seguro acá y no lo era en el cliente.
  DELETE FROM public.user_roles
  WHERE user_id = p_user_id;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT p_user_id, r.id
  FROM public.roles r
  WHERE r.code = ANY (v_codes);

  -- 1.4 Red de seguridad dentro de la transacción: si no se escribió
  --     EXACTAMENTE el conjunto validado, se aborta y el DELETE de arriba se
  --     revierte con él. Es la garantía "nunca cero roles" escrita en el
  --     lugar donde se puede probar, y no una promesa del llamador. Las tres
  --     condiciones son necesarias: `v_filas <> cardinality(v_codes)` solo no
  --     alcanza, porque con `v_codes` nulo la comparación da NULL, el IF no
  --     dispara y el DELETE quedaría confirmado con CERO filas insertadas.
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF
    v_codes IS NULL
    OR cardinality(v_codes) = 0
    OR v_filas <> cardinality(v_codes)
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_codes;
END;
$$;

-- ------------------------------------------------- 2. search_path fijo ---
-- La función resuelve `users`, `roles` y `user_roles`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. House style
-- desde 018.
ALTER FUNCTION public.replace_user_roles(uuid, text[]) SET search_path = public;

-- ---------------------------------------------------- 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría llamar el reemplazo de roles por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_roles(uuid, text[]) TO service_role;

-- --------------------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.replace_user_roles(uuid, text[]) IS
'CO-2: reemplazo ATÓMICO de los roles de un usuario. DELETE + INSERT en una sola transacción del servidor (una función es una sentencia; PostgREST no ofrece multi-statement por request), con lock FOR UPDATE de la fila del usuario para serializar reemplazos concurrentes. Rechaza arreglo vacío y códigos desconocidos con RAISE EXCEPTION ''ROLE_NOT_FOUND'' (P0001) y usuario inexistente con ''USER_NOT_FOUND''; en los tres casos la transacción se revierte y el usuario conserva sus roles. Devuelve el conjunto aplicado. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- un usuario que ya haya quedado sin roles por el bug anterior NO se repara
-- solo. Se le vuelve a asignar un rol desde Administración (ese camino ya usa
-- esta función) o con un UPDATE manual decidido por quien opera la base.
