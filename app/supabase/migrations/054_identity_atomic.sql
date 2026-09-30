-- 054_identity_atomic.sql — CL-15: las CUATRO ventanas de estado parcial de
-- identidad y acceso dejan de poder existir, y la peor de todo el barrido —el
-- token de recuperación quemado con la clave sin cambiar— pasa a ser
-- imposible.
--
-- MOTIVO DEL ARCHIVO (las cuatro ventanas, medidas)
--
-- Las cuatro operaciones escribían SEGUIDO y sin transacción contra PostgREST,
-- que no ofrece multi-statement por request (la misma nota que ya está escrita
-- en 005, 039, 040, 041, 042, 043, 044, 045, 046, 047, 048, 049, 050 y 051).
-- Cada escritura es su propio request, y por lo tanto su propia transacción:
-- entre dos de ellas no hay nada que las una.
--
--   1) `confirmPasswordReset` (src/features/auth/service.ts:540-558) quemaba el
--      token (`password_resets.used = true`, un CAS) y DESPUÉS cambiaba la
--      clave y revocaba las sesiones. Un fallo entre la marca y la clave dejaba
--      el token QUEMADO con la clave SIN CAMBIAR —y la clave vieja siguiendo
--      siendo la válida—. Es el único hallazgo del barrido que deja a una
--      persona sin salida para siempre: el enlace ya responde
--      RESET_TOKEN_INVALID (el token está usado), y no hay ningún otro camino
--      de recuperación en el MVP. No es una degradación: es un bloqueo
--      permanente de la cuenta.
--   2) `changeUserPassword` (service.ts:459-470) cambiaba la clave y DESPUÉS
--      revocaba las demás sesiones. Un fallo entre las dos dejaba la clave
--      cambiada con TODAS las otras sesiones vivas: exactamente lo contrario
--      del propósito del cambio (quien tenía la clave vieja sigue adentro, y la
--      víctima cree que lo expulsó).
--   3) `adminCreateUser` (service.ts:596-630) insertaba `users`, insertaba sus
--      `user_roles` y DESPUÉS llamaba a `db.auth.admin.createUser` —un sistema
--      EXTERNO: Supabase Auth, que no es una fila y no puede entrar en una
--      transacción de esta base—, compensando en el `catch` con
--      `db.from("users").delete()` que IGNORABA SU PROPIO ERROR. Si la
--      compensación también falla —y nadie se entera— queda un usuario
--      HUÉRFANO con roles y sin espejo, y el reintento responde USER_EXISTS.
--   4) `upsertEmployee` (src/features/admin/service.ts:310-429) insertaba el
--      usuario (si no existía), le aseguraba un rol (040) y DESPUÉS insertaba
--      el legajo. Un fallo entre medio dejaba un usuario con login y rol pero
--      SIN legajo: puede entrar y no existe como empleado.
--
-- MECANISMO (por qué UNA función por operación, y no otra cosa)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047,
-- `payroll_delete_period_atomic`/`payroll_correct_period_atomic` 048). Una
-- función es UNA sentencia, y una sentencia corre ENTERA dentro de una sola
-- transacción del servidor: o se escriben TODAS las filas de la operación, o no
-- se escribe ninguna. La ventana no se mueve de lugar: DEJA DE EXISTIR.
--
--   * Las ventanas 1, 2 y 4 son SÓLO filas de esta base (`password_resets`,
--     `users`, `sessions`, `user_roles`, `employees`), así que cada una recibe
--     UNA función que hace su par de escrituras adentro:
--       - `confirm_password_reset` (la marca de un solo uso + la clave + las
--         sesiones, con la validación del token adentro).
--       - `change_user_password` (la clave + la revocación de las demás
--         sesiones, con la post-condición "ninguna otra sesión viva" adentro).
--       - `upsert_employee_atomic` (el usuario si hay que crearlo + su rol + el
--         legajo, con la red de seguridad de roles de 040 COMPUESTA —no
--         copiada— adentro).
--   * La ventana 3 tiene un pedazo que NO puede estar en la transacción: el
--     espejo en Supabase Auth es una llamada a OTRO sistema. Ahí no hay
--     transacción posible, y por eso el archivo hace dos cosas:
--       - el par que SÍ es transaccional (`users` + `user_roles`) viaja en
--         `create_user_with_role`;
--       - la compensación del espejo fallido se vuelve ROBUSTA y AUDIBLE:
--         `discard_created_user` borra y VERIFICA el borrado adentro de su
--         transacción, y el servicio vuelve a leer para que el rastro auditado
--         corresponda a lo que el llamador pudo OBSERVAR (ver la nota final).
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas)
--
--   * REORDENAR las escrituras. En la 1 cambia de lugar el defecto, no lo
--     cierra: marcar el token DESPUÉS de la clave deja el token vivo sobre una
--     clave ya cambiada, y entonces el enlace se puede usar DOS veces (el token
--     sigue sin usar mientras la primera confirmación ya aplicó). En la 2 es
--     peor todavía: revocar primero y cambiar después deja las sesiones muertas
--     sin que la clave haya cambiado —el usuario queda afuera de su propia
--     cuenta y con la clave vieja—. En la 4 el orden disponible
--     (legajo → rol) deja a la persona con login y SIN NINGÚN rol, que es el
--     estado que 039 y 040 existen para hacer imposible. Una transacción no
--     depende del orden para ser atómica; una compensación sí.
--   * UNA COMPENSACIÓN EN EL CLIENTE para las ventanas 1, 2 y 4. Compensar es
--     escribir OTRA vez y volver a exponerse al mismo fallo a mitad de camino
--     (el defecto textual de la ventana 3, donde la compensación se traga el
--     error). La única forma de que la compensación sea tan sólida como la
--     transacción es... una transacción.
--   * UNA SOLA FUNCIÓN PARA LAS CUATRO. No: son operaciones distintas, con
--     precondiciones distintas y llamadores distintos (recuperación pública,
--     cambio autenticado, alta de usuario, alta de empleado). Una función que
--     las hiciera tendría que recibir un discriminador y ramificar; eso no
--     agrega atomicidad —cada una ya es una transacción— y sí agrega superficie
--     de error. Descartado.
--   * COMPARAR LA CLAVE DE LA VENTANA 2 DENTRO DE SQL (un CAS sobre
--     `users.password_hash`). Cerraría además la carrera "cambio propio" contra
--     "cambio de otro", pero obligaría a mandar el hash esperado como
--     precondición y a inventar un error visible nuevo para el usuario: es un
--     cambio de contrato y de superficie de clave que el hallazgo no pide. Se
--     deja anotado en la nota final, no se escribe.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPRUEBA y las funciones SÓLO VALIDAN LO SUYO Y ESCRIBEN. Acá no
-- se mueve nada de la política de autenticación a SQL:
--
--   * La VERIFICACIÓN de la clave actual (`verifyPassword`, comparación en
--     tiempo constante) sigue en TypeScript, con el hash leído de `users`: este
--     archivo no agrega ninguna forma nueva de leer una clave, un hash ni un
--     token. La función de cambio recibe el hash NUEVO ya calculado
--     (`hashPassword`) y lo escribe; nunca ve la clave en claro.
--   * La POLÍTICA de clave (8+, letra y número) y la de bloqueo (5 intentos,
--     `locked_until`, timeout de sesión) no se tocan: la recuperación sigue
--     limpiando `failed_attempts` y `locked_until` exactamente como antes, y el
--     archivo no cambia ni una regla de vigencia, ni el modelo de un rol por
--     usuario (039/040), ni la unicidad de `employee_code` (003) ni las claves
--     de unicidad de `users` (002).
--   * Las PRECONDICIONES de negocio del alta (`USER_EXISTS` por documento o
--     correo, `USER_ALREADY_LINKED`, `EMPLOYEE_CODE_TAKEN`, rol desconocido) se
--     siguen comprobando en el servicio —es lo que da el 409 legible— y las
--     funciones las REPITEN adentro sobre la fila bloqueada, que es lo que las
--     vuelve verdaderas al momento de escribir (mismo criterio que 048).
--
-- LAS REDES DE CONTEO (por qué cada escritura se verifica)
--
-- Dentro de una transacción, un `UPDATE`/`DELETE` que no matchea ninguna fila
-- NO es un error para PostgreSQL: confirma con cero filas y sigue. Por eso cada
-- escritura de este archivo lleva su red: `GET DIAGNOSTICS ... = ROW_COUNT` y
-- `RAISE EXCEPTION` cuando el conteo no es el esperado. Sin ellas, un cambio de
-- clave sobre un usuario borrado confirmaría el token quemado igual —el defecto
-- de la ventana 1, con transacción—.
--
-- SERIALIZACIÓN Y ORDEN DE LOCKS
--
-- `confirm_password_reset` bloquea la fila de `password_resets`
-- (`FOR UPDATE`; `token_hash` es UNIQUE en 002_auth.sql, así que la lectura no
-- puede traer dos filas) y después escribe `users` y `sessions`.
-- `change_user_password`, `create_user_with_role` y `upsert_employee_atomic`
-- bloquean la fila de `users` (`FOR UPDATE`), que es EL MISMO lock de
-- `replace_user_roles` (039) y de `ensure_user_has_role` (040): los escritores
-- de roles de un mismo usuario siguen serializados entre sí. El orden de locks
-- es siempre `password_resets` → `users` → `sessions` → `user_roles` →
-- `employees`: nadie toma `users` antes que `password_resets`, así que no hay
-- ciclo posible.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER (y `upsert_employee_atomic` puede invocar así la red de
--     040, que también es INVOKER y también está otorgada a service_role).
--   * SÍ hay que decidir el GRANT: `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría el cambio de clave, la recuperación, el alta y
--     el borrado de usuarios a cualquier JWT (anon/authenticated) vía
--     PostgREST. Se revoca de PUBLIC, anon y authenticated, y se otorga sólo a
--     service_role: el mismo bloque que 018/039/040.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza funciones y
--     ajusta permisos. El único `DELETE` es el de `discard_created_user`, que
--     es el cuerpo de la compensación del alta fallida y borra UN usuario por
--     id, el que el llamador acaba de crear en la misma operación.
--   * No agrega columnas, índices ni constraints: todas las tablas y claves que
--     usa ya existen (002_auth.sql, 003_admin.sql, 016_commissions.sql).
--   * No backfillea ni "arregla" residuos de los defectos anteriores: un
--     usuario huérfano o un token quemado que ya estén en la base son una
--     decisión de quien opera la base (ver la nota final).
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja cada función idéntica en cada corrida;
-- REVOKE/GRANT lo son. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN (declarado)
--
-- 054 es el número asignado a esta unidad; 052 y 053 pertenecen a otras dos
-- unidades en vuelo (facturación y caja). Este archivo NO renumera ni toca
-- ninguno de los dos, y no tiene ninguna dependencia de datos ni de funciones
-- con ellos: sólo usa tablas de 002, 003 y 016. El orden relativo entre 052,
-- 053 y 054 es por lo tanto indiferente. El costo es una ranura más de la
-- serie, consumida por la unidad que la tiene asignada.
--
-- ACOPLAMIENTO DE DESPLIEGUE (declarado)
--
-- La app nueva y este archivo se despliegan JUNTOS: el servicio pasa a llamar
-- estas funciones por `db.rpc(...)`, así que si el archivo no se aplicó antes
-- de que el servicio nuevo atienda tráfico, las cuatro rutas reciben
-- PGRST202 ("no existe la función") y responden INTERNAL 500 SIN ESCRIBIR NADA.
-- Ese modo de fallo es deliberado: es cerrado y sin residuo, que es mejor que el
-- estado parcial que este archivo elimina. Al revés (archivo aplicado, servicio
-- viejo) no pasa nada: las funciones quedan disponibles y sin usar.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===========================================================================
-- 1. confirm_password_reset
-- ===========================================================================
-- La ventana 1 entera, indivisible: el token se valida y se marca, la clave se
-- cambia y las sesiones se revocan, todo en UNA sentencia del servidor. El
-- orden INTERNO es el mismo que tenía el cliente (marcar, cambiar, revocar),
-- pero adentro de una transacción el orden deja de importar: si la clave no se
-- puede escribir, la marca se revierte con ella y el enlace sigue sirviendo.
CREATE OR REPLACE FUNCTION public.confirm_password_reset(
  p_token_hash text, p_password_hash text, p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_reset_id uuid;
  v_user_id uuid;
  v_expira timestamptz;
  v_usado boolean;
  v_filas integer;
BEGIN
  -- 1.1 FORMA de la entrada. El token llega como HASH (jamás en claro) y la
  --     clave como hash ya calculado: sin los dos no hay nada que confirmar y
  --     el rechazo es el mismo que el de un token inválido —no se filtra si el
  --     problema fue el token o la clave—.
  IF p_token_hash IS NULL OR btrim(p_token_hash) = ''
     OR p_password_hash IS NULL OR btrim(p_password_hash) = ''
     OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.2 El TOKEN, bajo candado. `password_resets.token_hash` es UNIQUE
  --     (002_auth.sql), así que esta lectura no puede traer dos filas; el
  --     `FOR UPDATE` es el que serializa dos confirmaciones del MISMO token:
  --     la segunda espera acá y, cuando entra, lo encuentra usado.
  SELECT pr.id, pr.user_id, pr.expires_at, pr.used
    INTO v_reset_id, v_user_id, v_expira, v_usado
  FROM public.password_resets pr
  WHERE pr.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.3 USABILIDAD adentro, sobre la fila ya bloqueada. El servicio comprobó lo
  --     mismo antes de llamar (es lo que da el 400 rápido), pero acá es donde
  --     la comprobación no puede volverse mentira: entre la lectura del
  --     llamador y esta sentencia, otro puede haber usado el token o el reloj
  --     haber pasado la expiración.
  IF v_usado OR v_expira <= p_now THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.4 La MARCA de un solo uso: el CAS que hacía el cliente
  --     (`used = true WHERE id = … AND used = false`), con su red de conteo.
  --     Si no marcó exactamente una fila, se aborta y el token NO se consume.
  UPDATE public.password_resets
  SET used = true
  WHERE id = v_reset_id
    AND used = false;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.5 La CLAVE, después de la marca y en la misma transacción. Que el orden
  --     sea el del defecto es lo que hace visible que el defecto no era el
  --     orden: la marca y la clave son ahora indivisibles, así que un fallo en
  --     cualquiera de las dos revierte las dos.
  UPDATE public.users
  SET password_hash = p_password_hash,
      must_change_password = false,
      failed_attempts = 0,
      locked_until = null
  WHERE id = v_user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.6 Las SESIONES de la cuenta, todas: recuperar la clave es el acto por el
  --     que se expulsa a cualquiera que estuviera adentro (mismo efecto que el
  --     UPDATE incondicional del cliente).
  UPDATE public.sessions
  SET revoked = true
  WHERE user_id = v_user_id
    AND revoked = false;

  --     POST-CONDICIÓN, dentro de la transacción: no puede quedar una sola
  --     sesión viva. Sin esto, un `UPDATE` que no matchea nada confirmaría la
  --     clave nueva dejando las sesiones viejas adentro.
  IF EXISTS (
    SELECT 1
    FROM public.sessions s
    WHERE s.user_id = v_user_id
      AND s.revoked = false
  ) THEN
    RAISE EXCEPTION 'SESSIONS_NOT_REVOKED';
  END IF;

  RETURN true;
END;
$$;

-- ===========================================================================
-- 2. change_user_password
-- ===========================================================================
-- La ventana 2: la clave nueva y la expulsión de las demás sesiones, juntas. La
-- sesión ACTUAL se conserva (AUTH-02): `p_current_token_hash` es su hash, y
-- `NULL` significa "revocá todas" —el mismo contrato que tenía el cliente—.
CREATE OR REPLACE FUNCTION public.change_user_password(
  p_user_id uuid, p_password_hash text, p_current_token_hash text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_filas integer;
  v_revocadas integer;
BEGIN
  -- 2.1 FORMA de la entrada.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_INVALID';
  END IF;

  -- 2.2 El CANDADO de la fila del usuario, el mismo de 039/040: dos cambios de
  --     clave del MISMO usuario se serializan, y el usuario tiene que existir
  --     (no se le cambia la clave a un fantasma). La comprobación viaja en la
  --     misma sentencia que toma el lock.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 2.3 La CLAVE. La verificación de la clave ACTUAL ya ocurrió en el servicio
  --     (comparación en tiempo constante contra el hash leído); acá sólo se
  --     escribe el hash nuevo, con la limpieza de bloqueo de siempre.
  UPDATE public.users
  SET password_hash = p_password_hash,
      must_change_password = false,
      failed_attempts = 0,
      locked_until = null
  WHERE id = p_user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 2.4 Las OTRAS sesiones, en la MISMA transacción que la clave. El `OR`
  --     explícito es lo que evita la trampa de `token_hash <> NULL` (que da
  --     NULL, no TRUE): sin él, "revocá todas" no revocaría ninguna.
  UPDATE public.sessions
  SET revoked = true
  WHERE user_id = p_user_id
    AND revoked = false
    AND (p_current_token_hash IS NULL OR token_hash <> p_current_token_hash);

  GET DIAGNOSTICS v_revocadas = ROW_COUNT;

  -- 2.5 POST-CONDICIÓN, dentro de la transacción: no puede quedar NINGUNA otra
  --     sesión viva. Si algo quedó —una escritura que no matcheó, un permiso a
  --     medias— la transacción ENTERA se revierte y la clave NO cambia. Es la
  --     garantía que el hallazgo pedía, escrita donde se puede probar.
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
-- 3. create_user_with_role
-- ===========================================================================
-- La mitad transaccional de la ventana 3: en `adminCreateUser` el par
-- `users` + `user_roles` es de esta base, y va junto. El espejo en Supabase Auth
-- NO está acá porque no es una fila: es una llamada a otro sistema (ver la
-- sección 5, la compensación).
CREATE OR REPLACE FUNCTION public.create_user_with_role(
  p_user jsonb, p_role_codes text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_desconocidos integer;
  v_roles uuid[];
BEGIN
  -- 3.1 FORMA de la entrada: los campos obligatorios de `users` (002_auth.sql)
  --     y al menos un rol. Un alta sin rol dejaría a la persona con login y sin
  --     acceso —el estado que 039/040 existen para hacer imposible—, así que se
  --     rechaza igual que un arreglo de códigos desconocidos.
  IF p_user IS NULL OR jsonb_typeof(p_user) <> 'object'
     OR coalesce(p_user ->> 'id_type', '') = ''
     OR coalesce(p_user ->> 'id_number', '') = ''
     OR coalesce(p_user ->> 'password_hash', '') = ''
     OR coalesce(p_user ->> 'full_name', '') = ''
  THEN
    RAISE EXCEPTION 'USER_INVALID';
  END IF;
  IF p_role_codes IS NULL OR cardinality(p_role_codes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 3.2 El CATÁLOGO: ningún código pedido puede quedar afuera. Un subconjunto
  --     silencioso no es un alta: si uno solo no existe, se aborta —y con él, el
  --     usuario que la sección 3.3 todavía no insertó—.
  SELECT count(*) INTO v_desconocidos
  FROM (SELECT DISTINCT t.code FROM unnest(p_role_codes) AS t(code)) AS pedidos
  WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r WHERE r.code = pedidos.code
  );

  IF v_desconocidos > 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     Los ids resueltos, sin repetidos: es lo que se inserta y también el
  --     valor esperado de la red de 3.5.
  SELECT array_agg(DISTINCT r.id) INTO v_roles
  FROM public.roles r
  WHERE r.code = ANY (p_role_codes);

  IF v_roles IS NULL
     OR cardinality(v_roles) = 0
     OR cardinality(v_roles) <> (
       SELECT count(DISTINCT t.code) FROM unnest(p_role_codes) AS t(code)
     )
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 3.3 El USUARIO. La unicidad de 002_auth.sql (`users.id_number` y
  --     `users.email`) es la guardia REAL: el servicio ya comprobó lo mismo
  --     antes de llamar —es lo que da el 409 legible—, pero entre esa lectura y
  --     esta sentencia otro alta puede haber ganado. El bloque las traduce a un
  --     código propio para que el llamador no confunda una carrera de unicidad
  --     con un rol desconocido.
  BEGIN
    INSERT INTO public.users (
      sede_id, email, phone, id_type, id_number, password_hash, full_name,
      must_change_password
    )
    VALUES (
      -- La sede puede no venir: el MVP opera una sola sede y `users.sede_id` es
      -- NULL-able desde 002 (003 lo vuelve NOT NULL con la sede inicial).
      CASE WHEN p_user ? 'sede_id' THEN (p_user ->> 'sede_id')::uuid ELSE NULL END,
      -- El correo puede faltar (usuarios solo-documento): NULL, nunca la cadena
      -- vacía. `email` es UNIQUE, así que dos NULL conviven (correcto) y dos
      -- vacíos no (incorrecto).
      NULLIF(btrim(coalesce(p_user ->> 'email', '')), ''),
      NULLIF(btrim(coalesce(p_user ->> 'phone', '')), ''),
      p_user ->> 'id_type',
      p_user ->> 'id_number',
      p_user ->> 'password_hash',
      p_user ->> 'full_name',
      -- AUTH-01: la clave inicial es el documento y el cambio es obligatorio.
      true
    )
    RETURNING id INTO v_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'USER_EXISTS';
  END;

  -- 3.4 Los ROLES, en la MISMA sentencia (los dos INSERT corren en la misma
  --     transacción: si este falla, el usuario de 3.3 se revierte con él, y por
  --     eso no puede quedar un huérfano sin rol).
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT v_user_id, r.id
  FROM unnest(v_roles) AS r(id);

  -- 3.5 Red de SEGURIDAD: el alta no puede confirmar un usuario SIN ningún rol
  --     —`requireSedeRole` lo rechazaría con 403 en TODA la aplicación—. Es la
  --     invariante de 039/040 comprobada en la única transacción que puede
  --     probarla.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_user_id;
END;
$$;

-- ===========================================================================
-- 4. upsert_employee_atomic
-- ===========================================================================
-- La ventana 4: el usuario (si hay que crearlo), su rol y el legajo, en UNA
-- sentencia. La red de seguridad de roles NO se copia de 040: se COMPONE
-- llamándola, porque el dueño de la invariante "escribe SÓLO si no tiene ningún
-- rol" tiene que ser uno solo.
CREATE OR REPLACE FUNCTION public.upsert_employee_atomic(
  p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_employee_id uuid;
  v_fila public.employees;
BEGIN
  -- 4.1 FORMA de la entrada: las columnas NOT NULL de `employees`
  --     (003_admin.sql) y el rol que se va a asegurar. Un legajo a medio formar
  --     no se escribe: el precio de un rechazo claro es infinitamente menor que
  --     el de un legajo incompleto.
  IF p_employee IS NULL OR jsonb_typeof(p_employee) <> 'object'
     OR coalesce(p_employee ->> 'sede_id', '') = ''
     OR coalesce(p_employee ->> 'full_name', '') = ''
     OR coalesce(p_employee ->> 'document', '') = ''
     OR coalesce(p_employee ->> 'pay_type', '') = ''
     OR p_role_code IS NULL
  THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;
  IF p_create_user IS NOT NULL AND jsonb_typeof(p_create_user) <> 'object' THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;

  -- 4.2 El USUARIO: o se crea (con la unicidad de 002_auth.sql como guardia
  --     real, traducida a su propio código) o ya existe y se lo bloquea con el
  --     MISMO lock de 039/040, que es lo que serializa a los escritores de roles
  --     del mismo usuario.
  IF p_create_user IS NOT NULL THEN
    IF coalesce(p_create_user ->> 'id_type', '') = ''
       OR coalesce(p_create_user ->> 'id_number', '') = ''
       OR coalesce(p_create_user ->> 'password_hash', '') = ''
       OR coalesce(p_create_user ->> 'full_name', '') = ''
    THEN
      RAISE EXCEPTION 'EMPLOYEE_INVALID';
    END IF;

    BEGIN
      INSERT INTO public.users (
        sede_id, email, phone, id_type, id_number, password_hash, full_name,
        must_change_password
      )
      VALUES (
        (p_create_user ->> 'sede_id')::uuid,
        NULLIF(btrim(coalesce(p_create_user ->> 'email', '')), ''),
        NULLIF(btrim(coalesce(p_create_user ->> 'phone', '')), ''),
        p_create_user ->> 'id_type',
        p_create_user ->> 'id_number',
        p_create_user ->> 'password_hash',
        p_create_user ->> 'full_name',
        true
      )
      RETURNING id INTO v_user_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'USER_EXISTS';
    END;
  ELSE
    PERFORM 1
    FROM public.users u
    WHERE u.id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    v_user_id := p_user_id;
  END IF;

  -- 4.3 La RED DE SEGURIDAD de roles, compuesta con 040: escribe `p_role_code`
  --     SÓLO si el usuario no tiene ningún rol (la intención de la red, no
  --     "agregá este rol"), valida el código contra el catálogo y aborta si no
  --     existe. Toma el lock de la fila del usuario, que esta transacción ya
  --     tiene —re-tomarlo desde la misma transacción es inocuo—, así que
  --     `replace_user_roles` (039) y esta función siguen serializadas.
  PERFORM public.ensure_user_has_role(v_user_id, p_role_code);

  -- 4.4 El LEGAJO. `id` no se menciona: lo genera el DEFAULT de 003. Las
  --     columnas que el llamador no manda quedan en NULL salvo las que tienen
  --     DEFAULT (`payout_mode`, `is_active`), que se resuelven en 4.5 sin
  --     repetir el DEFAULT acá.
  INSERT INTO public.employees (
    sede_id, user_id, full_name, employee_code, document, phone, position,
    email, birth_date, pay_type, salary_fixed, commission_percent
  )
  VALUES (
    (p_employee ->> 'sede_id')::uuid,
    v_user_id,
    p_employee ->> 'full_name',
    p_employee ->> 'employee_code',
    p_employee ->> 'document',
    p_employee ->> 'phone',
    p_employee ->> 'position',
    p_employee ->> 'email',
    CASE
      WHEN coalesce(p_employee ->> 'birth_date', '') = '' THEN NULL
      ELSE (p_employee ->> 'birth_date')::date
    END,
    p_employee ->> 'pay_type',
    CASE
      WHEN p_employee ->> 'salary_fixed' IS NULL THEN NULL
      ELSE (p_employee ->> 'salary_fixed')::numeric
    END,
    CASE
      WHEN p_employee ->> 'commission_percent' IS NULL THEN NULL
      ELSE (p_employee ->> 'commission_percent')::numeric
    END
  )
  RETURNING id INTO v_employee_id;

  -- 4.5 Las columnas OPCIONALES. PostgREST las deja FUERA del INSERT cuando la
  --     clave no viaja en el payload, y entonces la base aplica su DEFAULT
  --     (`payout_mode 'nomina'`, `is_active true` de 016/003). Acá se reproduce
  --     esa semántica sin repetir los DEFAULT —la fila nace con ellos, como con
  --     PostgREST— y se pisa SÓLO lo que el llamador mandó, usando el operador
  --     `?` de jsonb, que pregunta por la PRESENCIA de la clave (un `->>` no
  --     distingue "no vino" de "vino null").
  IF p_employee ? 'payout_mode' OR p_employee ? 'is_active' THEN
    UPDATE public.employees e
    SET payout_mode = CASE
          WHEN p_employee ? 'payout_mode' THEN p_employee ->> 'payout_mode'
          ELSE e.payout_mode
        END,
        is_active = CASE
          WHEN p_employee ? 'is_active' THEN (p_employee ->> 'is_active')::boolean
          ELSE e.is_active
        END
    WHERE e.id = v_employee_id;
  END IF;

  -- 4.6 POST-CONDICIÓN, leída de la base y no reconstruida desde lo pedido:
  --     el legajo tiene que existir, con SU usuario, y ese usuario tiene que
  --     tener al menos un rol. Es la propiedad del hallazgo —"nunca un usuario
  --     con login y rol pero sin legajo"— escrita donde se puede probar.
  SELECT * INTO v_fila
  FROM public.employees e
  WHERE e.id = v_employee_id;

  IF NOT FOUND OR v_fila.user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     La fila devuelta, con las MISMAS columnas que el `select` del servicio
  --     (`EMPLOYEE_SELECT`): la respuesta de la ruta no cambia de forma.
  RETURN jsonb_build_object(
    'id', v_fila.id,
    'sede_id', v_fila.sede_id,
    'user_id', v_fila.user_id,
    'full_name', v_fila.full_name,
    'employee_code', v_fila.employee_code,
    'document', v_fila.document,
    'phone', v_fila.phone,
    'position', v_fila.position,
    'payout_mode', v_fila.payout_mode,
    'email', v_fila.email,
    'birth_date', v_fila.birth_date,
    'pay_type', v_fila.pay_type,
    'salary_fixed', v_fila.salary_fixed,
    'commission_percent', v_fila.commission_percent,
    'is_active', v_fila.is_active
  );
END;
$$;

-- ===========================================================================
-- 5. discard_created_user
-- ===========================================================================
-- La compensación ROBUSTA de la ventana 3. El espejo en Supabase Auth es otro
-- sistema y no puede estar en esta transacción, así que el alta que ya escribió
-- `users` + `user_roles` tiene que poder deshacerse. Esta función lo hace
-- ADENTRO de una transacción y VERIFICA que el borrado ocurrió: no alcanza con
-- emitir el `DELETE` —el defecto era justamente un `DELETE` cuyo error nadie
-- miraba—. `user_roles`, `sessions` y `password_resets` caen por la FK
-- ON DELETE CASCADE de 002_auth.sql, y `employees.user_id` es ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION public.discard_created_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_filas integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 5.1 El candado de la fila: la compensación no puede competir con otro
  --     escritor del mismo usuario.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 5.2 Nada que compensar: el usuario no está, así que el estado YA está
    --     limpio. Devolver cero es una respuesta legítima, no un error.
    RETURN 0;
  END IF;

  -- 5.3 El BORRADO, con su red de conteo.
  DELETE FROM public.users
  WHERE id = p_user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 5.4 Red de SEGURIDAD: la compensación no puede CONFIRMAR "borrado" si algo
  --     del usuario quedó. Si quedó, esto revierte el DELETE y devuelve un
  --     error: el llamador lo lee como compensación FALLIDA y lo hace audible.
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id)
  THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  RETURN v_filas;
END;
$$;

-- ===========================================================================
-- 6. search_path fijo (house style desde 018)
-- ===========================================================================
-- Las cinco funciones resuelven tablas de `public`; con search_path mutable un
-- esquema anterior en la ruta podría secuestrar esos nombres. El `SET
-- search_path = public` de la declaración queda además fijado en la función,
-- que es lo que sobrevive a un `CREATE OR REPLACE` mal hecho.
ALTER FUNCTION public.confirm_password_reset(text, text, timestamptz) SET search_path = public;
ALTER FUNCTION public.change_user_password(uuid, text, text) SET search_path = public;
ALTER FUNCTION public.create_user_with_role(jsonb, text[]) SET search_path = public;
ALTER FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) SET search_path = public;
ALTER FUNCTION public.discard_created_user(uuid) SET search_path = public;

-- ===========================================================================
-- 7. Permisos
-- ===========================================================================
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cambiar una clave, confirmar una recuperación,
-- crear un usuario o borrarlo por PostgREST. El único llamador legítimo es el
-- cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.confirm_password_reset(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_password_reset(text, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_password_reset(text, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_password_reset(text, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.change_user_password(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.change_user_password(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_user_with_role(jsonb, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.discard_created_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discard_created_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.discard_created_user(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.discard_created_user(uuid) TO service_role;

-- ===========================================================================
-- 8. Documentación
-- ===========================================================================
COMMENT ON FUNCTION public.confirm_password_reset(text, text, timestamptz) IS
'CL-15: confirmación de recuperación ATÓMICA (AUTH-06). Valida el token bajo FOR UPDATE (token_hash es UNIQUE), lo marca usado con CAS y red de conteo, escribe la clave nueva y revoca TODAS las sesiones: una sola transacción. Un fallo en cualquier punto revierte el token quemado, así que el enlace sigue sirviendo y no hay callejón sin salida. Rechaza con RAISE EXCEPTION ''RESET_TOKEN_INVALID'' (P0001) el token inexistente, usado o vencido; ''USER_NOT_FOUND'' si el usuario no existe; ''SESSIONS_NOT_REVOKED'' si alguna sesión quedó viva. Recibe el token y la clave como HASH: nunca ve un secreto. Sólo service_role puede ejecutarla.';

COMMENT ON FUNCTION public.change_user_password(uuid, text, text) IS
'CL-15: cambio de clave ATÓMICO (AUTH-02). Actualiza el hash (la verificación de la clave actual ocurre en el servicio, en tiempo constante) y revoca las DEMÁS sesiones —conservando la actual, o todas si p_current_token_hash es NULL— en una sola transacción, con lock FOR UPDATE de la fila del usuario (el mismo de 039/040) y post-condición explícita: si alguna otra sesión queda viva, la transacción se revierte entera con ''SESSIONS_NOT_REVOKED'' y la clave NO cambia. Devuelve cuántas sesiones revocó. Sólo service_role puede ejecutarla.';

COMMENT ON FUNCTION public.create_user_with_role(jsonb, text[]) IS
'CL-15: alta ATÓMICA del par usuario + rol (AUTH-04/07). Inserta `users` y sus `user_roles` en una sola transacción, con la unicidad de 002_auth.sql como guardia real (traducida a ''USER_EXISTS'') y red de seguridad final: el alta no confirma un usuario sin ningún rol. Rechaza con ''ROLE_NOT_FOUND'' un código que no está en el catálogo o un arreglo vacío, y con ''USER_INVALID'' un payload a medio formar; en todos los casos no se escribe ninguna fila. La contraseña viaja como HASH ya calculado. Devuelve el id del usuario creado. Sólo service_role puede ejecutarla.';

COMMENT ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) IS
'CL-15: alta de empleado ATÓMICA (ADM-02/ADM-03). Crea el usuario de acceso si hace falta (su unicidad es la de 002_auth.sql), asegura su rol COMPONIENDO la red de seguridad de 040 (escribe sólo si el usuario no tiene ningún rol, con el mismo lock de la fila) e inserta el legajo, todo en una sola transacción: nunca queda un usuario con login y rol pero sin legajo. Reproduce la semántica de claves ausentes de PostgREST con el operador `?` (los DEFAULT de payout_mode/is_active los aplica la propia tabla). Verifica la post-condición (el legajo con SU usuario y ese usuario con al menos un rol) y devuelve la fila en la misma forma que el select del servicio. ''EMPLOYEE_INVALID''/''USER_NOT_FOUND''/''USER_EXISTS''/''ROLE_NOT_FOUND'' abortan sin escribir nada. Sólo service_role puede ejecutarla.';

COMMENT ON FUNCTION public.discard_created_user(uuid) IS
'CL-15: compensación VERIFICADA del alta de usuario (el espejo en Supabase Auth es otro sistema: no puede entrar en la transacción de create_user_with_role). Borra el usuario recién creado —sus user_roles, sessions y password_resets caen por ON DELETE CASCADE de 002_auth.sql— con lock de fila, red de conteo y red de seguridad que aborta si algo quedó. Devuelve 1 si borró, 0 si el usuario ya no está (el estado ya estaba limpio). Un error acá significa "la compensación falló": el servicio lo hace audible. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
--   * Un token quemado con la clave sin cambiar que ya esté en la base NO se
--     repara solo: si ese residuo existiera, el camino es `adminResetUserPassword`
--     (el admin restablece la clave al documento) o un UPDATE manual decidido
--     por quien opera la base. Esta migración impide que vuelva a ocurrir.
--   * Un usuario huérfano de un alta fallida anterior se resuelve desde
--     Administración (reasignando sus roles con 039 o vinculándolo a un legajo)
--     o con un DELETE manual decidido por quien opera la base.
--   * El rastro de una compensación fallida queda en `audit_logs` con la acción
--     `auth.user_create_rollback_failed` (que la escribe el servicio, no este
--     archivo): es el registro que convierte un residuo silencioso en trabajo
--     de reparación. No está en la bandeja de alertas de 011 porque la bandeja
--     filtra por acciones operativas; un auditor lo lee en `audit_logs`.
--   * Carrera considerada y NO cerrada: el cambio de clave propio contra un
--     cambio de clave ajeno del MISMO usuario (un admin restableciendo en el
--     medio). Cerrarla exigiría un CAS sobre `users.password_hash` y un error
--     visible nuevo para el usuario; el hallazgo no lo pide y no se inventa.
