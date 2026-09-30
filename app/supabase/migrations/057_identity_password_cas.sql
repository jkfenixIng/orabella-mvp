-- 057_identity_password_cas.sql — CL-18 (cierre de la carrera declarada por 054):
-- el cambio de clave PROPIO deja de pisar en silencio la escritura de otro
-- escritor legítimo de la MISMA columna (`users.password_hash`).
--
-- MOTIVO DEL ARCHIVO (la carrera, medida)
--
-- 054 cerró las cuatro ventanas de estado parcial de identidad, y en su propia
-- nota final dejó escrita, como decisión explícita, UNA carrera sin cerrar
-- (054_identity_atomic.sql, nota operativa, último punto):
--
--   "Carrera considerada y NO cerrada: el cambio de clave propio contra un
--    cambio de clave ajeno del MISMO usuario (un admin restableciendo en el
--    medio). Cerrarla exigiría un CAS sobre `users.password_hash` y un error
--    visible nuevo para el usuario; el hallazgo no lo pide y no se inventa."
--
-- `changeUserPassword` (src/features/auth/service.ts) hace tres cosas en orden:
--   1. LEE `users.password_hash` y verifica contra él la clave ACTUAL que el
--      usuario escribió (`verifyPassword`, comparación en tiempo constante);
--   2. llama a `change_user_password` (054), que bloquea la fila y escribe el
--      hash NUEVO y revoca las demás sesiones, todo en una transacción.
--
-- Entre (1) y (2) hay una ventana: otro escritor de la MISMA columna puede
-- escribir. Los otros dos escritores de `users.password_hash` son
-- `adminResetUserPassword` (UPDATE directo desde PostgREST: el admin restablece
-- al documento) y `confirm_password_reset` (054: la recuperación confirmada).
-- El resultado de la ventana es que el ÚLTIMO escritor gana, sin que nadie lo
-- sepa: la intervención del admin —o la recuperación— desaparece del resultado
-- y no queda ni un rastro de que existió. Peor: el propio cambio se autorizó
-- con una clave que, al momento de escribir, YA NO ES la credencial vigente, y
-- el usuario no se entera de que perdió la carrera.
--
-- POR QUÉ UN CAS SOBRE EL HASH LEÍDO (y no otra cosa)
--
-- La verificación en tiempo constante de (1) es la PRUEBA que habilita el
-- cambio: el usuario demostró conocer esa credencial. La forma de que esa
-- prueba siga siendo verdadera al momento de escribir es EXIGIR que el hash
-- contra el que se verificó siga siendo el hash de la fila. Es decir: el hash
-- leído viaja como PRECONDICIÓN y la función lo compara bajo el candado de la
-- fila. Si difiere, la operación NO ESCRIBE NADA y devuelve un rechazo de
-- contrato (no un 500) que el usuario puede accionar.
--
--   * No se mueve la POLÍTICA de clave ni la de bloqueo: la recuperación sigue
--     limpiando `failed_attempts`/`locked_until` como siempre, la verificación
--     de la clave actual sigue en TypeScript (`verifyPassword`), y este archivo
--     no agrega ninguna forma nueva de LEER un hash: el valor esperado es el
--     MISMO que el servicio ya leía para verificar, y la función recibe hashes
--     ya calculados —nunca una clave en claro—.
--   * No se toca `adminResetUserPassword`: la decisión del admin es deliberada
--     y privilegiada; lo que se cierra es que su escritura sea PISADA sin que
--     el pisador lo sepa. Si el admin escribe primero, el cambio propio pierde
--     y se rechaza (el usuario reintenta con la clave nueva que le dejaron); si
--     el cambio propio escribe primero, el reset del admin lo sobrescribe
--     después, que es el orden legítimo de una acción privilegiada posterior.
--
-- POR QUÉ NO SE TOCA `confirm_password_reset` (decisión explícita)
--
-- La recuperación confirmada NO tiene la misma exposición, por dos razones:
--   * Su autoridad es el TOKEN de un solo uso, no una credencial verificada
--     contra el hash almacenado. No hay ninguna "prueba de credencial" que
--     pueda volverse mentira al escribir: el dueño de la cuenta eligiendo su
--     propia clave es el ganador INTENCIONADO de esa carrera, y el token ya
--     tiene su propio CAS (`used = false`) que garantiza que una sola
--     confirmación gane.
--   * Un CAS ahí exigiría que el llamador leyera `users.password_hash` para
--     tener una base que comparar —una lectura de hash NUEVA, que el hallazgo
--     prohíbe— y, a cambio, no protegería ninguna prueba de credencial. No se
--     escribe.
--
-- POR QUÉ `DROP FUNCTION` (y no `CREATE OR REPLACE` a secas)
--
-- PostgreSQL NO permite cambiar la lista de argumentos con `CREATE OR REPLACE`:
-- con una firma distinta crea una función NUEVA y deja viva la vieja. Eso sería
-- lo peor posible acá: quedaría `change_user_password(uuid, text, text)`, la
-- versión SIN CAS, disponible para cualquiera que la llame por PostgREST
-- (saltándose la comparación). Por eso este archivo primero REMUEVE la firma
-- vieja con `DROP FUNCTION IF EXISTS` y después crea la nueva. El `DROP` es de
-- una FUNCIÓN, no de datos: no borra ni reescribe ninguna fila (el requisito
-- duro se cumple), y con `IF EXISTS` el archivo sigue siendo re-ejecutable
-- cuantas veces haga falta.
--
-- QUIÉN PUEDE LLAMARLA Y CÓMO SE CIERRA EL PERMISO
--
-- Igual que 018/039/040/054: la función es SECURITY INVOKER (el único llamador
-- es el cliente `service_role` del servidor, que ya bypassa RLS), y `CREATE
-- FUNCTION` otorga EXECUTE a PUBLIC por defecto, así que se revoca de PUBLIC,
-- anon y authenticated y se otorga SÓLO a service_role. Sin ese bloque,
-- cualquier JWT podría cambiar una clave por PostgREST.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `DROP FUNCTION IF EXISTS` no falla si la firma
-- vieja no está; `CREATE OR REPLACE FUNCTION` con la misma firma y el mismo
-- tipo de retorno deja la función idéntica en cada corrida; REVOKE/GRANT y
-- COMMENT lo son. El runner de Supabase aplica el archivo en una transacción: o
-- entra todo, o no entra nada.
--
-- ACOPLAMIENTO DE DESPLIEGUE (declarado)
--
-- La app nueva y este archivo se despliegan JUNTOS. La app nueva llama a
-- `change_user_password` con CUATRO parámetros nombrados; si la migración no se
-- aplicó antes de que el servicio nuevo atienda tráfico, la ruta responde
-- PGRST202 ("no existe la función") y el cambio devuelve INTERNAL 500 SIN
-- ESCRIBIR NADA. Ese modo de fallo es cerrado y sin residuo: es mejor que dejar
-- la versión sin CAS sirviendo. Al revés (archivo aplicado, servicio viejo) el
-- servicio viejo llama con tres parámetros y recibe el mismo PGRST202: la clave
-- tampoco se escribe. La migración no es compatible hacia atrás a propósito:
-- una firma que permita el cambio sin la precondición sería exactamente el
-- bypass que este archivo elimina.
--
-- COSTO DE NUMERACIÓN (declarado)
--
-- 057 es el número asignado a esta unidad; 052 a 056 están tomados o asignados
-- a otras unidades (052/053 en vuelo, 054 de CL-15, 055/056 de otras dos). Este
-- archivo NO renumera ni toca ninguno, y no tiene ninguna dependencia de datos
-- ni de funciones con ellos: sólo usa `users` y `sessions` de 002_auth.sql y
-- reemplaza una función de 054. El orden relativo entre 055, 056 y 057 es por
-- lo tanto indiferente. El costo es una ranura más de la serie, consumida por
-- la unidad que la tiene asignada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===========================================================================
-- 1. Remover la firma vieja (sin CAS)
-- ===========================================================================
-- Sin esto, `CREATE OR REPLACE` crearía una sobrecarga y dejaría viva la
-- versión de 054, que cambia la clave sin comparar el hash leído: un bypass
-- silencioso del CAS que este archivo agrega. `IF EXISTS` la vuelve idempotente.
DROP FUNCTION IF EXISTS public.change_user_password(uuid, text, text);

-- ===========================================================================
-- 2. change_user_password CON CAS sobre el hash leído
-- ===========================================================================
-- Misma operación que 054 —el hash NUEVO y la revocación de las DEMÁS sesiones,
-- juntas, en UNA sentencia— más la precondición: el hash contra el que el
-- llamador verificó la clave ACTUAL tiene que seguir siendo el de la fila.
CREATE OR REPLACE FUNCTION public.change_user_password(
  p_user_id uuid,
  p_password_hash text,
  p_current_token_hash text,
  p_expected_password_hash text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_filas integer;
  v_revocadas integer;
  v_actual text;
BEGIN
  -- 2.1 FORMA de la entrada.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_INVALID';
  END IF;
  --     La PRECONDICIÓN es obligatoria: sin ella no hay CAS posible. Si el
  --     llamador no manda la base, se rechaza con el error de forma —jamás se
  --     interpreta la ausencia como "no compares"—, que es lo que impide que
  --     una firma mal llamada degrade al comportamiento sin CAS.
  IF p_expected_password_hash IS NULL OR btrim(p_expected_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_INVALID';
  END IF;

  -- 2.2 El CANDADO de la fila del usuario, el mismo de 039/040 y de 054, y la
  --     LECTURA del hash bajo ese candado: `adminResetUserPassword` (UPDATE sin
  --     `FOR UPDATE`) y cualquier otro escritor quedan serializados contra esta
  --     transacción. La comprobación de existencia viaja en la misma sentencia.
  SELECT u.password_hash
    INTO v_actual
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 2.3 El CAS. Si otro escritor legítimo (un admin restableciendo, una
  --     recuperación confirmada) escribió entre la lectura del llamador y este
  --     punto, el hash de la fila no es el que autorizó el cambio: la prueba de
  --     credencial dejó de ser válida y la operación NO ESCRIBE NADA. El código
  --     propio deja de confundir esta carrera con un fallo interno.
  IF v_actual IS DISTINCT FROM p_expected_password_hash THEN
    RAISE EXCEPTION 'PASSWORD_CHANGED_ELSEWHERE';
  END IF;

  -- 2.4 La CLAVE. La comparación vive además en el `WHERE` —el CAS literal— y
  --     su red de conteo: bajo el candado no puede fallar, pero un `UPDATE` que
  --     no matchea ninguna fila no es un error para PostgreSQL, y este archivo
  --     no confirma nada que no haya podido verificar.
  UPDATE public.users
  SET password_hash = p_password_hash,
      must_change_password = false,
      failed_attempts = 0,
      locked_until = null
  WHERE id = p_user_id
    AND password_hash = p_expected_password_hash;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'PASSWORD_CHANGED_ELSEWHERE';
  END IF;

  -- 2.5 Las OTRAS sesiones, en la MISMA transacción que la clave (idéntico a
  --     054). El `OR` explícito evita la trampa de `token_hash <> NULL` (que da
  --     NULL, no TRUE): sin él, "revocá todas" no revocaría ninguna.
  UPDATE public.sessions
  SET revoked = true
  WHERE user_id = p_user_id
    AND revoked = false
    AND (p_current_token_hash IS NULL OR token_hash <> p_current_token_hash);

  GET DIAGNOSTICS v_revocadas = ROW_COUNT;

  -- 2.6 POST-CONDICIÓN, idéntica a 054: no puede quedar NINGUNA otra sesión
  --     viva. Si algo quedó, la transacción ENTERA se revierte —y con ella el
  --     CAS y la clave nueva—.
  IF EXISTS (
    SELECT 1
    FROM public.sessions s
    WHERE s.user_id = p_user_id
      AND s.revoked = false
      AND (p_current_token_hash IS NULL OR s.token_hash <> p_current_token_hash)
  ) THEN
    RAISE EXCEPTION 'SESSIONS_NOT_REVOKED';
  END IF;

  RETURN v_revocadas;
END;
$$;

-- ===========================================================================
-- 3. search_path fijo (house style desde 018)
-- ===========================================================================
-- La función resuelve `users` y `sessions` de `public`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. El
-- `SET search_path = public` de la declaración queda además fijado en la
-- función, que es lo que sobrevive a un `CREATE OR REPLACE` mal hecho.
ALTER FUNCTION public.change_user_password(uuid, text, text, text) SET search_path = public;

-- ===========================================================================
-- 4. Permisos
-- ===========================================================================
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cambiar una clave por PostgREST. El único
-- llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.change_user_password(uuid, text, text, text) TO service_role;

-- ===========================================================================
-- 5. Documentación
-- ===========================================================================
COMMENT ON FUNCTION public.change_user_password(uuid, text, text, text) IS
'CL-18 (sobre CL-15): cambio de clave propio con CAS declarado. Además de lo de 054 —hash nuevo + revocación de las DEMÁS sesiones en una sola transacción, lock FOR UPDATE de la fila del usuario y post-condición "ninguna otra sesión viva" (''SESSIONS_NOT_REVOKED'')—, exige que el hash contra el que el llamador verificó la clave ACTUAL siga siendo el de la fila: si otro escritor legítimo (un admin restableciendo, una recuperación confirmada) escribió en el medio, aborta con ''PASSWORD_CHANGED_ELSEWHERE'' SIN escribir nada, en vez de pisar la escritura ajena en silencio. La precondición es obligatoria: ''PASSWORD_INVALID'' si falta. La verificación de la clave actual sigue en el servicio (tiempo constante); la función recibe sólo hashes ya calculados y nunca ve una clave en claro. Devuelve cuántas sesiones revocó. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
--   * Un pisado silencioso que YA haya ocurrido no se puede reconstruir: si el
--     admin restableció y el cambio propio lo pisó (o al revés), el rastro está
--     en `audit_logs` (ambos caminos auditan `auth.password_changed`) y la
--     coincidencia de dos filas cercanas de la MISMA entidad es lo que un
--     auditor puede leer. Esta migración impide que vuelva a ocurrir sin señal.
--   * La recuperación confirmada (`confirm_password_reset`) queda sin CAS sobre
--     el hash por decisión explícita (ver el encabezado): su autoridad es el
--     token de un solo uso, no una credencial verificada.
