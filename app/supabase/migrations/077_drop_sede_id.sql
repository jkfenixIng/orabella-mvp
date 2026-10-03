-- ===================================================================== ---
-- DECISIÓN DE ALCANCE: POR QUÉ `users.sede_id` NO SE BORRA
-- ===================================================================== ---
--
-- Esta migración borra `sede_id` de las VEINTE tablas de negocio. Deja una sola
-- columna viva, `public.users.sede_id`, y es una excepción deliberada.
--
-- MOTIVO
--
-- Esa columna cumple una función real, que no es la de separar sedes:
--
--   1. ANCLA LA CUENTA A LA INSTALACIÓN ÚNICA. La fila de `sedes` que describe
--      la instalación es la referencia a la que la cuenta apunta. Es el único
--      vínculo durable entre un usuario y «la instalación» que no sea el negocio.
--   2. ES EL ORIGEN DE `session.sedeId`. `findUserByDocument` y `getSessionUser`
--      (`src/features/auth/service.ts`) leen la columna de la fila de la cuenta y
--      de ahí sale el `sedeId` de la sesión.
--   3. DE ESE `session.sedeId` DEPENDEN LAS SIETE GUARDAS DE SESIÓN —
--      `requireAdminSession`, `requireSession`, `requireBillingSession`,
--      `requireCashSession`, `requireInventorySession`, `requirePayrollAdmin` y
--      `requirePlatformAdmin`—, que rechazan con NO_SEDE cuando la cuenta no
--      tiene sede y protegen TODA ruta autenticada de la aplicación.
--
-- QUÉ NO ES
--
--   * NO es una clave multi-sede: no autoriza nada del negocio. La 071 le quitó
--     el parámetro a las doce funciones atómicas, la 072 movió los ajustes a
--     `system_settings`, la 073 volvió nulable la columna y la 074 reescribió las
--     diez unicidades y la restricción de exclusión que la comparaban. Ninguna de
--     esas cuarenta referencias se apoyaba en `users.sede_id`.
--   * NO es una deuda pendiente: no es residuo de la estructura multi sede que
--     haya que limpiar. Es un anclaje de una sola sede, con una columna y un
--     predicado de RLS, que hoy funcionan.
--
-- SI ALGÚN DÍA HUBIERA MÁS DE UNA SEDE
--
-- Esa columna vuelve a ser exactamente el punto de anclaje que sería: es donde
-- se escribe la pertenencia de la cuenta, de donde saldría el `sedeId` de la
-- sesión y contra el que comparan las cuatro políticas que este archivo conserva
-- (`users`, `user_roles`, `sessions`, `password_resets`). Con una sola sede su
-- valor es CONSTANTE para todas las cuentas —el id de la fila única de `sedes`—,
-- y por eso no acota nada: no se usa como filtro de lectura ni de escritura en
-- ninguna ruta.
--
-- LO QUE ESTA DECISIÓN DEJA VIVO, Y CÓMO
--
--   * La columna en `public.users`, con su clave foránea a `sedes` y su índice.
--   * Cuatro políticas: `pol_users_sede_isolation`,
--     `pol_user_roles_sede_isolation`, `pol_sessions_sede_isolation` y
--     `pol_password_resets_sede_isolation` (sección 2.2).
--   * `public.current_sede_id()` (sección 2.1): la primera de esas cuatro la
--     llama en su predicado.
--   * La escritura en `users.sede_id` de `create_user_with_role` (3.11) y
--     `upsert_employee_atomic` (3.12). `employees.sede_id` sí se borra, así que
--     dentro de la segunda lo que sale es el `INSERT` del legajo y su guarda.
--   * El modelo de sesión: sin cambios, sin migración y sin tocar las guardas.
--
-- EL ALCANCE QUE SE HABÍA PLANTEADO Y ESTA DECISIÓN RECHAZA
--
-- Borrar la columna en `users` obligaba a retirar `sedeId` del contrato de sesión
-- y a reescribir las siete guardas, cuatro de ellas fuera de la unidad. El dueño
-- evaluó esa vía y decidió que el modelo de sesión no se cambia acá: es un
-- contrato de siete guardas y diez puntos de llamada repartidos entre seis
-- features, y no es un efecto colateral de borrar una columna.

-- 077_drop_sede_id.sql — la columna `sede_id` desaparece de los datos de negocio.
--
-- MOTIVO DEL ARCHIVO
--
-- Es el ÚLTIMO paso de la serie de una sola sede y el único irreversible. Las
-- unidades anteriores dejaron la ESTRUCTURA multi sede atrás y fueron dejando
-- la columna sin lectores ni escritores: 071 le quitó el parámetro `p_sede_id`
-- a las funciones atómicas, 072 movió los ajustes de instalación a
-- `system_settings`, 073 volvió nulable la columna en dieciocho tablas, 074
-- reescribió las diez unicidades y la restricción de exclusión que la
-- comparaban, y 075 dejó la unicidad de las reglas de comisión en clave de
-- instalación. Este archivo borra lo que queda: las políticas que la nombraban,
-- la única función de sede que queda sin llamadores, el índice único viejo de
-- comisiones, las escrituras de la columna en trece funciones, y por último la
-- columna misma en las veinte tablas de negocio que la declaraban. La excepción
-- —`users.sede_id`— está escrita con su motivo en el bloque de alcance, más
-- abajo.
--
-- QUÉ CAMBIA, Y NADA MÁS
--
--   * Trece funciones se re-emiten: once quedan sin `sede_id` en el cuerpo —
--     donde la función leía la sede de una fila que ya tenía bloqueada (la caja,
--     el turno, el producto), la lectura desaparece y el LOCK se queda; donde la
--     escribía en una lista de columnas, la columna sale de la lista; donde la
--     devolvía en un `RETURNING`, la clave sale del `jsonb`— y dos
--     (`create_user_with_role` y `upsert_employee_atomic`) conservan la
--     escritura en `users.sede_id`, que sobrevive.
--   * `public.next_invoice_number` pierde el parámetro: desde 072 el parámetro no
--     selecciona nada (la fila del contador es la clave `invoice_sequence` de
--     `system_settings`), y `invoice_create_atomic` deja de pasarlo.
--   * Se borra `public.write_audit_log(...)`: es un helper que ninguna función de
--     la serie llama (la aplicación audita desde TypeScript, en
--     `src/shared/lib/audit.ts`, y desde la 072 el rastro no lleva la sede) y su
--     primer parámetro ya no tendría una columna donde escribir.
--     `current_sede_id()` NO se borra: la política de `users` que se conserva la
--     llama en su predicado.
--   * Se borran veintisiete de las treinta y una políticas que comparaban
--     `sede_id` con `current_sede_id()` o la leían por el padre. Las cuatro que
--     siguen en pie son las que leen `users.sede_id`, que no se borra.
--   * Se borra `public.uq_commission_rule`, el índice único de 016 que todavía
--     llevaba `sede_id` y que 075 dejó escrito que se quita acá.
--   * Se borra la columna en veinte tablas.
--
-- Lo que NO cambia: los tipos de retorno, las precondiciones de estado, los
-- locks y su orden, las redes de conteo, los SQLSTATE, el `search_path` fijo, el
-- ACL de cada función atómica (sólo `service_role`) y la prosa de los `COMMENT`
-- salvo donde describía la columna que ya no existe.
--
-- POR QUÉ LAS POLÍTICAS SE BORRAN Y NO SE REESCRIBEN
--
-- El aislamiento por sede era una frontera REAL mientras la columna existió:
-- `sede_id = current_sede_id()` separaba las filas de un cliente JWT de las de
-- otra sede. Sin columna no hay predicado que escribir, y el predicado no se
-- puede "relajar" a `USING (true)` sin abrir de golpe lo que 008 cerró: 008
-- revocó veinte políticas permisivas `USING (true)` justamente para dejar de
-- exponerlas.
--
-- La consecuencia —y es deliberada— es DENY-ALL: `ENABLE ROW LEVEL SECURITY`
-- sigue en pie en todas esas tablas y, sin ninguna política, `anon` y
-- `authenticated` no alcanzan ninguna fila, mientras `service_role` —el único
-- cliente que la aplicación usa— sigue pasando por el bypass que PostgreSQL le
-- da por diseño. Es la misma postura que `076_cash_shift_recounts_rls.sql`
-- escribió para `cash_shift_recounts`: fail-closed, y la política por cliente
-- se escribe en la migración que introduce al cliente. `public.roles` conserva
-- su `pol_roles_readonly` porque nunca nombró la sede, y lo mismo hacen `users`,
-- `user_roles`, `sessions` y `password_resets`, que conservan la suya porque la
-- columna que comparan sigue existiendo.
--
-- POR QUÉ ESTA UNIDAD NO PUEDE RE-HACERSE
--
-- `DROP COLUMN` no tiene vuelta atrás sin restaurar. Las once unidades
-- anteriores eran reversibles una por una; esta no. Por eso el pre-vuelo de la
-- sección 1 aborta ANTES de tocar un solo objeto, y por eso los objetos que
-- bloquean el `DROP COLUMN` se borran al principio y no al final: si la
-- transacción falla (el runner de Supabase la aplica en una sola transacción),
-- no queda ni una política a medias ni una columna a medias.
--
-- ACOPLAMIENTO DE DESPLIEGUE
--
-- El archivo va JUNTO con el código que deja de leer las claves que las
-- funciones ya no devuelven. Entre este archivo y el despliegue del código
-- nuevo, un servidor viejo recibe `function … does not exist` —o, si el orden
-- es el inverso, un `column … does not exist` de PostgREST— en vez de un
-- rechazo de negocio: es un fallo ruidoso y reintentable, que es la razón por la
-- que se puede aplicar en el mismo despliegue. La función que devuelve el turno
-- o la factura ya no trae `sede_id` en su `jsonb`, así que un servidor viejo
-- que lo lea recibe `undefined` en una clave que no usa para decidir nada.
--
-- LO QUE ESTE ARCHIVO NO TOCA
--
--   * Ninguna fila: no inserta, no actualiza, no borra y no fusiona datos de
--     negocio. `sedes` sigue siendo la fila que describe la instalación, con su
--     `id`, su `name` y su `is_active`.
--   * Ninguna fila de `invoice_sequences` ni de `voucher_settings`: las dos
--     tablas siguen existiendo con sus datos; lo que se borra es la columna que
--     las identificaba (ambas la tenían como clave primaria). Sin lectoras desde
--     072, sus filas quedan de archivo: borrarlas es otra decisión, de otra
--     unidad, y este archivo no la toma.
--   * Ningún `ENABLE/DISABLE ROW LEVEL SECURITY`, ningún `GRANT` de tabla y
--     ningún permiso de escritura por rol.
--   * `supabase/test-bootstrap.sql`, que es un volcado independiente del
--     esquema.
--
-- CÓMO VERIFICA EL DUEÑO (SOLO LECTURA; nada de acá cambia datos)
--
--   * La columna no está en ninguna tabla:
--
--       -- SELECT table_name FROM information_schema.columns
--       --  WHERE table_schema = 'public' AND column_name = 'sede_id';
--       -- (0 filas)
--
--   * Las trece funciones existen, y ninguna nombra la columna:
--
--       -- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--       --   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public'
--       --    AND p.proname IN ('deduct_stock_atomic', 'cash_open_shift_atomic',
--       --      'cash_close_shift_atomic', 'invoice_annul_atomic',
--       --      'invoice_edit_items_atomic', 'invoice_edit_emitted_atomic',
--       --      'invoice_create_atomic', 'invoice_split_payment_atomic',
--       --      'cash_invoice_payment_atomic', 'payroll_apply_atomic',
--       --      'create_user_with_role', 'upsert_employee_atomic',
--       --      'next_invoice_number')
--       --  ORDER BY 1, 2;
--
--       -- SELECT p.proname FROM pg_proc p
--       --   JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public' AND p.prosrc ~ '\msede_id\M';
--       -- (0 filas)
--
--   * No quedó ninguna política que compare la sede:
--
--       -- SELECT pol.polname, pol.polrelid::regclass
--       --   FROM pg_policy pol
--       --  WHERE coalesce(pg_get_expr(pol.qual, pol.polrelid), '')
--       --     ~ 'current_sede_id'
--       --     OR coalesce(pg_get_expr(pol.with_check, pol.polrelid), '')
--       --     ~ 'current_sede_id';
--       -- (0 filas)
--
--   * La garantía de nómina sigue en pie, con sus DOS elementos y no tres:
--
--       -- SELECT pg_get_constraintdef(oid), conname
--       --   FROM pg_constraint
--       --  WHERE conname = 'ex_payroll_periods_no_overlap';
--       -- EXCLUDE USING gist (coalesce(frequency, ''::text) WITH =,
--       --   daterange(start_date, end_date, '[]'::date) WITH &&)
--
--   * Y la de comisiones, ahora en clave de instalación:
--
--       -- SELECT indexname, indexdef FROM pg_indexes
--       --  WHERE schemaname = 'public' AND tablename = 'commission_rules'
--       --  ORDER BY indexname;
--       -- uq_commission_rule_install_key | … (item_type, item_id, employee_id)
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. PRE-VUELO: tres guardas que ABORTAN y no cambian nada
-- ===================================================================== ---
--
-- Van PRIMERO, antes de cualquier `DROP`, `CREATE` o `ALTER`, y las tres son de
-- sólo lectura: si alguna falla, la transacción se revierte entera y el esquema
-- queda como estaba. Cada una nombra a los infractores y dice qué hacer, y cada
-- una usa un SQLSTATE distinto para que el dueño sepa cuál se trippedó: `0A000`
-- para lo que este archivo no cubre, `23514` para la incoherencia de los ajustes
-- y `P0001` para el supuesto de una sola sede.
--
-- El runner de Supabase aplica el archivo en una transacción: o entra todo —las
-- tres guardas, los borrados, las trece funciones y las veinte columnas—, o
-- no entra nada.

-- ------------------------------------------------------------- 1.1 --------
-- (a) NADA FUERA DE ESTE ARCHIVO SIGUE NOMBRANDO UNA COLUMNA QUE ESTE ARCHIVO
--     BORRA.
--
-- Comprueba las cuatro categorías de objeto que NO se van con la columna y que,
-- si quedaran, o impedirían el `DROP COLUMN` (una política) o quedarían rotas
-- para siempre (una función, una vista, un `CHECK`):
--
--   * funciones cuyo cuerpo dice `sede_id` y que este archivo no re-emite ni
--     borra. La lista blanca de abajo NO es una lista de funciones a arreglar:
--     es el conjunto exacto de las que este archivo se hace cargo. Dos de ellas,
--     `create_user_with_role` y `upsert_employee_atomic`, se re-emiten aquí y
--     **siguen escribiendo `users.sede_id`** a propósito (decisión de alcance,
--     bloque del encabezado); ser incluidas en la lista blanca no significa que
--     la columna vaya a sobrar. `current_sede_id()` también se queda, y por lo
--     mismo. Lo que la guarda rechaza es una función que este archivo NO toca y
--     que seguiría leyendo o escribiendo una columna que ya no existe;
--   * políticas que comparan `sede_id` o llaman a `current_sede_id()` y que este
--     archivo no borra ni deja a propósito. La lista blanca incluye las cuatro
--     que se conservan (`pol_users_sede_isolation`,
--     `pol_user_roles_sede_isolation`, `pol_sessions_sede_isolation` y
--     `pol_password_resets_sede_isolation`): siguen nombrando `users.sede_id`,
--     que sigue existiendo, así que no son infractoras y el mensaje nunca las
--     ofrece como faltantes;
--   * vistas o vistas materializadas que nombren la columna;
--   * restricciones `CHECK` que la nombren.
--
-- Lo que SÍ se va con la columna no se comprueba, y es deliberado: los índices
-- que la contienen —`idx_payments_sede` e `idx_audit_logs_sede_created` entre
-- ellos— y las claves foráneas a `sedes` que la referencian caen con ella.
-- Comprobar esos sería exigir que ya estuvieran borrados, cuando es el propio
-- `DROP COLUMN` el que los deja caer. `idx_users_sede` NO se cuenta: su columna
-- sobrevive.

DO $$
DECLARE
  v_funciones text;
  v_politicas text;
  v_vistas    text;
  v_checks    text;
BEGIN
  -- Funciones que este archivo re-emite o borra: la lista blanca, escrita a
  -- mano porque es la lista exacta de la sección 3 y de la 2.1. Cualquier otra
  -- función que nombre la columna es un infractor.
  SELECT string_agg(infractor, E'\n    ' ORDER BY infractor)
    INTO v_funciones
    FROM (
      SELECT format('función public.%s', p.oid::regprocedure) AS infractor
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosrc ~ '\msede_id\M'
         AND p.proname <> ALL (ARRAY[
           'deduct_stock_atomic', 'cash_open_shift_atomic',
           'cash_close_shift_atomic', 'invoice_annul_atomic',
           'invoice_edit_items_atomic', 'invoice_edit_emitted_atomic',
           'invoice_create_atomic', 'invoice_split_payment_atomic',
           'cash_invoice_payment_atomic', 'payroll_apply_atomic',
           'create_user_with_role', 'upsert_employee_atomic',
           'next_invoice_number', 'current_sede_id', 'write_audit_log'
         ]::text[])
    ) t;

  IF v_funciones IS NOT NULL THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: hay función(es) cuya ventana todavía nombra la columna `sede_id`, y este archivo no las re-emite:\n    %\n  QUÉ HACER: re-emita cada una de estas funciones SIN la columna (o bórrela si ya no tiene llamadores) en una migración nueva, y vuelva a correr este archivo completo. Ningún objeto del esquema fue tocado.', v_funciones
      USING ERRCODE = '0A000',
            HINT = 'El pre-vuelo corre antes de cualquier cambio: por eso aborta en vez de limpiar lo que no le corresponde.';
  END IF;

  -- Políticas: la lista blanca es el conjunto exacto de las que este archivo
  -- conoce: las veintisiete que borra la sección 2.2 MÁS las cuatro que deja a
  -- propósito (`pol_users_sede_isolation`, `pol_user_roles_sede_isolation`,
  -- `pol_sessions_sede_isolation`, `pol_password_resets_sede_isolation`). Las
  -- cuatro siguen nombrando `users.sede_id`, que este archivo no borra, así que
  -- no son infractoras y el mensaje nunca las ofrece como faltantes.
  SELECT string_agg(infractor, E'\n    ' ORDER BY infractor)
    INTO v_politicas
    FROM (
      SELECT format('política %s ON %s', pol.polname, pol.polrelid::regclass) AS infractor
        FROM pg_policy pol
       WHERE coalesce(pg_get_expr(pol.qual, pol.polrelid), '') ~ 'sede_id|current_sede_id'
          OR coalesce(pg_get_expr(pol.with_check, pol.polrelid), '') ~ 'sede_id|current_sede_id'
         AND pol.polname NOT IN (
           'pol_sedes_sede_isolation', 'pol_employees_sede_isolation',
           'pol_services_sede_isolation', 'pol_tax_configs_sede_isolation',
           'pol_payment_methods_sede_isolation', 'pol_products_sede_isolation',
           'pol_movements_sede_select', 'pol_movements_sede_insert',
           'pol_invoice_sequences_sede_isolation', 'pol_invoices_sede_isolation',
           'pol_invoice_items_sede_isolation', 'pol_invoice_taxes_sede_isolation',
           'pol_invoice_payments_sede_isolation',
           'pol_cash_registers_sede_isolation', 'pol_cash_shifts_sede_isolation',
           'pol_payments_sede_isolation', 'pol_payroll_periods_sede_isolation',
           'pol_payroll_items_sede_isolation', 'pol_payroll_payments_sede_isolation',
           'pol_voucher_settings_sede_isolation',
           'pol_voucher_requests_sede_isolation', 'pol_users_sede_isolation',
           'pol_user_roles_sede_isolation', 'pol_sessions_sede_isolation',
           'pol_password_resets_sede_isolation', 'pol_audit_logs_sede_select',
           'pol_audit_logs_sede_insert',
           'pol_cash_denominations_sede_isolation', 'pol_shift_counts_sede_isolation',
           'pol_commission_rules_sede_isolation',
           'pol_commission_payouts_sede_isolation'
         )
    ) t;

  IF v_politicas IS NOT NULL THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: hay política(s) de RLS que nombran `sede_id` o `current_sede_id()` y este archivo no las borra:\n    %\n  QUÉ HACER: cada una tiene que caer —o reescribirse sin la sede— ANTES de que la columna se pueda borrar: PostgreSQL no permite quitar una columna de la que una política depende. Agregue el `DROP POLICY` de esta migración y vuelva a correr el archivo completo. Ningún objeto del esquema fue tocado.', v_politicas
      USING ERRCODE = '0A000',
            HINT = 'Con RLS activa y sin política, la tabla queda cerrada para anon/authenticated y abierta para service_role (la postura de 076).';
  END IF;

  SELECT string_agg(infractor, E'\n    ' ORDER BY infractor)
    INTO v_vistas
    FROM (
      SELECT format('vista %s', c.oid::regclass) AS infractor
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('v', 'm')
         AND pg_get_viewdef(c.oid) ~ '\msede_id\M'
    ) t;

  SELECT string_agg(infractor, E'\n    ' ORDER BY infractor)
    INTO v_checks
    FROM (
      SELECT format('CHECK %s ON %s', con.conname, con.conrelid::regclass) AS infractor
        FROM pg_constraint con
       WHERE con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ~ '\msede_id\M'
    ) t;

  IF v_vistas IS NOT NULL OR v_checks IS NOT NULL THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: hay vista(s) o restricción(es) CHECK que nombran la columna `sede_id`:\n    %\n  QUÉ HACER: re-escriba cada objeto SIN la columna (una vista no sobrevive a que su columna desaparezca, y un CHECK sobre una columna que no existe no se puede dejar), y vuelva a correr este archivo completo. Ningún objeto del esquema fue tocado.',
      coalesce(v_vistas, '') || coalesce(v_checks, '')
      USING ERRCODE = '0A000';
  END IF;
END
$$;

-- ------------------------------------------------------------- 1.2 --------
-- (b) NINGÚN AJUSTE VIVE SÓLO EN LAS TABLAS QUE 072 DEJÓ SIN LECTORAS.
--
-- `invoice_sequences` y `voucher_settings` quedaron sin ninguna lectora cuando
-- 072 movió el contador y los cuatro topes de vales a `system_settings`: desde
-- ese día los escribe y los lee el servicio por clave. Este archivo NO borra sus
-- filas (no hay ningún `DELETE` acá), así que nada se pierde al quitar la
-- columna; lo que esta guarda evita es el otro error posible: dejar la
-- instalación leyendo un contador que ya no existe, o un tope que nadie
-- copió.
--
-- El contador se compara por VALOR, no por igualdad de fila: entre 072 y hoy la
-- serie puede haber avanzado —`next_invoice_number` ya no escribe en
-- `invoice_sequences`—, así que la fila vieja está detrás a propósito y eso NO
-- es un problema. Lo que sería un problema es que la fila viva estuviera por
-- DEBAJO de lo que la vieja registró: eso permitiría repetir un número ya
-- emitido. La guarda aborta sólo en ese caso.
--
-- Los topes se comprueban por EXISTENCIA de la clave, no por igualdad del
-- valor: si el dueño cambió un tope después de 072, el valor nuevo está en
-- `system_settings` y el viejo en la tabla sin lectores, y comparar los dos
-- abortaría contra una base sana. Lo que no puede pasar es que la clave no esté
-- y el ajuste sí exista en la tabla vieja.

DO $$
DECLARE
  v_regresiones text;
  v_claves      text;
BEGIN
  SELECT string_agg(
           format('invoice_sequences.last_number = %s > system_settings[''invoice_sequence''].last_number = %s',
                  s.last_number, coalesce((SELECT (ss.value ->> 'last_number')::integer
                                             FROM public.system_settings ss
                                            WHERE ss.key = 'invoice_sequence'), 0)),
           E'\n    ' ORDER BY s.last_number)
    INTO v_regresiones
    FROM public.invoice_sequences s
   WHERE s.last_number > coalesce((SELECT (ss.value ->> 'last_number')::integer
                                     FROM public.system_settings ss
                                    WHERE ss.key = 'invoice_sequence'), 0);

  IF v_regresiones IS NOT NULL THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: el contador vivo de `system_settings` está POR DEBAJO de lo que `invoice_sequences` tiene registrado, y borrar la columna dejaría sin registro un número ya emitido:\n    %\n  QUÉ HACER: no corra este archivo. Revise la fila `''invoice_sequence''` de `system_settings` y ajuste su valor hasta que sea MAYOR O IGUAL al mayor `last_number` de la tabla vieja. Este archivo no escribe, no borra y no fusiona ningún contador.', v_regresiones
      USING ERRCODE = '23514',
            HINT = 'El contador de la instalación es la fila `invoice_sequence` de `system_settings` desde 072; la tabla vieja quedó congelada.';
  END IF;

  SELECT string_agg(k.clave, E'\n    ' ORDER BY k.clave)
    INTO v_claves
    FROM (VALUES
      ('voucher_max_per_day'), ('voucher_max_per_week'),
      ('voucher_per_day_limits'), ('voucher_allowed_days')
    ) AS k(clave)
   WHERE EXISTS (SELECT 1 FROM public.voucher_settings)
     AND NOT EXISTS (SELECT 1 FROM public.system_settings ss WHERE ss.key = k.clave);

  IF v_claves IS NOT NULL THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: `voucher_settings` tiene filas, pero % de sus cuatro claves NO están en `system_settings`, que es donde el servicio lee y escribe los topes desde 072:\n    %\n  QUÉ HACER: copie el ajuste de la tabla vieja a la clave que falta en `system_settings` (o decida que el valor por omisión documentado en 072 es el vigente) y vuelva a correr este archivo completo. Este archivo no escribe, no borra y no fusiona ningún ajuste.', v_claves
      USING ERRCODE = '23514',
            HINT = 'Las cuatro claves: voucher_max_per_day, voucher_max_per_week, voucher_per_day_limits, voucher_allowed_days.';
  END IF;
END
$$;

-- ------------------------------------------------------------- 1.3 --------
-- (c) LA INSTALACIÓN TIENE UNA SOLA SEDE.
--
-- `leerSedeDeLaInstalacion` (la capa de plataforma) ya rechaza con SEDE_AMBIGUA
-- una instalación con más de una sede activa, porque el negocio asume una sola.
-- Esta guarda pone el mismo supuesto en el lado de la base, antes de quitar la
-- columna que hoy todavía permite distinguir una fila de otra.
--
-- Una instalación SIN sede activa NO aborta acá: quitar la columna no necesita
-- que exista una fila de `sedes`, y el servicio ya responde NOT_FOUND por su
-- cuenta cuando no la hay.

DO $$
DECLARE
  v_activas integer;
BEGIN
  SELECT count(*) INTO v_activas
    FROM public.sedes
   WHERE is_active;

  IF v_activas > 1 THEN
    RAISE EXCEPTION E'migración 077 ABORTADA: la instalación tiene % sedes ACTIVAS y el negocio asume exactamente una: sin la columna `sede_id` no habría forma de saber a cuál de ellas pertenece una fila.\n  QUÉ HACER: deje activa una sola sede (desactive las demás desde la capa de plataforma) y vuelva a correr este archivo completo. Este archivo no borra, no actualiza y no fusiona sedes.', v_activas
      USING ERRCODE = 'P0001',
            HINT = 'Es el mismo supuesto que `leerSedeDeLaInstalacion` (src/features/platform/service.ts) ya hace del lado del servidor.';
  END IF;
END
$$;

-- ===================================================================== ---
-- 2. LO QUE SE BORRA PRIMERO, PORQUE BLOQUEA EL `DROP COLUMN`
-- ===================================================================== ---
--
-- El orden importa y no es cosmético:
--
--   * Las POLÍTICAS se borran antes que la columna porque PostgreSQL registra la
--     dependencia de una política sobre las columnas que su predicado nombra: sin
--     este paso, `ALTER TABLE … DROP COLUMN sede_id` falla con «cannot drop
--     column sede_id of table invoices because other objects depend on it».
--   * `uq_commission_rule` se borra antes que la columna porque 075 lo dejó
--     escrito para esta unidad.

-- ------------------------------------------------------------- 2.1 --------
-- Una sola función de sede: `write_audit_log`, sin llamadores.
--
-- `current_sede_id()` (008) **NO se borra**, y es una consecuencia directa de la
-- decisión de alcance del encabezado: `pol_users_sede_isolation` se conserva (la
-- columna que compara sigue existiendo) y su predicado es
-- `sede_id = public.current_sede_id()`. PostgreSQL registra la dependencia de una
-- política sobre las funciones que su predicado llama, así que quitar la función
-- con la política en pie haría fallar este archivo con «cannot drop function
-- public.current_sede_id() because other objects depend on it». Se queda con sus
-- permisos intactos —los de 017/018: EXECUTE para `authenticated` y
-- `service_role`, revocado para `anon`— y con su `COMMENT`, que sigue siendo
-- cierto: lee el claim `app_metadata.sede_id` del JWT.
--
-- `write_audit_log(p_sede_id, …)` (008) es un helper `SECURITY DEFINER` para
-- triggers futuros: inserta en `audit_logs` con la sede que le pasan. Ninguna
-- función de la serie la llama —la lista de funciones de la sección 1.1 la
-- revisa y no la nombra— y la aplicación audita desde TypeScript
-- (`src/shared/lib/audit.ts`), cuyo payload no lleva la sede desde la unidad que
-- la retiró del rastro. Con la columna fuera de `audit_logs`, su firma ya no
-- tendría un valor que escribir. Se le revocan los permisos antes de borrarla
-- para que, en una base donde el `DROP` fallara por lo que sea, no quede una
-- función huérfana con EXECUTE para `anon`.
--
-- Su `COMMENT` desaparece con la función: no hay dónde dejar la nota.

REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM service_role;

DROP FUNCTION IF EXISTS public.write_audit_log(uuid, uuid, text, text, text, jsonb);

-- ------------------------------------------------------------- 2.2 --------
-- Las veintisiete políticas que nombraban la sede de una tabla que la pierde.
--
-- La lista es la que la serie efectivamente dejó en pie, no la que cada
-- migración escribió: 003/005/006/007 crearon políticas permisivas `USING (true)`
-- que 008 revocó y reemplazó, así que las que viven hoy son las de 008 y las
-- cuatro que 017 abrió para las tablas de caja y comisiones. De las treinta y
-- una, se borran veintisiete —incluidas las que no nombraban la columna sino el
-- padre (`pol_invoice_items_sede_isolation` leía `invoices.sede_id` por
-- subconsulta; `pol_payroll_payments_sede_isolation`, dos niveles más abajo),
-- porque todas son la misma frontera retirándose en la misma unidad.
--
-- `pol_sedes_sede_isolation` entra en la lista aunque su predicado sea
-- `id = current_sede_id()`: no nombra ninguna columna, pero comparaba la sesión
-- contra la fila de la instalación y, con `current_sede_id()` conservada, lo que
-- la sostendría sería una frontera contra una fila que ya no existe para nadie.
--
-- LAS CUATRO QUE SE CONSERVAN, y por qué: `pol_users_sede_isolation`,
-- `pol_user_roles_sede_isolation`, `pol_sessions_sede_isolation` y
-- `pol_password_resets_sede_isolation`. Las cuatro comparan o leen
-- `users.sede_id`, que este archivo NO borra (decisión de alcance, bloque del
-- encabezado): las tres últimas por subconsulta sobre la cuenta dueña y la
-- primera directamente. Siguen siendo la frontera de la capa de datos por sesión,
-- y borrarlas dejaría a `users`, `user_roles`, `sessions` y `password_resets` con
-- RLS activa y sin ninguna política.
--
-- Lo que queda en las otras diecinueve tablas es deny-all: `ENABLE ROW LEVEL
-- SECURITY` sigue en pie y `service_role` sigue con su bypass. Las políticas que
-- NO aparecen acá son las que nunca nombraron la sede —`pol_roles_readonly`, las
-- de `payroll_extras`, `payroll_discount_carries`, `payroll_period_corrections`,
-- `payroll_period_correction_items` y `system_settings`, todas `USING (true)`— y
-- esas siguen igual.
--
-- `IF EXISTS` en todos: una segunda corrida del archivo deja el mismo esquema.

-- 008: la fila de la instalación y las tablas con sede propia.
DROP POLICY IF EXISTS pol_sedes_sede_isolation ON public.sedes;
DROP POLICY IF EXISTS pol_employees_sede_isolation ON public.employees;
DROP POLICY IF EXISTS pol_services_sede_isolation ON public.services;
DROP POLICY IF EXISTS pol_tax_configs_sede_isolation ON public.tax_configs;
DROP POLICY IF EXISTS pol_payment_methods_sede_isolation ON public.payment_methods;
DROP POLICY IF EXISTS pol_products_sede_isolation ON public.products;
DROP POLICY IF EXISTS pol_movements_sede_select ON public.inventory_movements;
DROP POLICY IF EXISTS pol_movements_sede_insert ON public.inventory_movements;
DROP POLICY IF EXISTS pol_invoice_sequences_sede_isolation ON public.invoice_sequences;
DROP POLICY IF EXISTS pol_invoices_sede_isolation ON public.invoices;
DROP POLICY IF EXISTS pol_cash_registers_sede_isolation ON public.cash_registers;
DROP POLICY IF EXISTS pol_cash_shifts_sede_isolation ON public.cash_shifts;
DROP POLICY IF EXISTS pol_payments_sede_isolation ON public.payments;
DROP POLICY IF EXISTS pol_voucher_settings_sede_isolation ON public.voucher_settings;
DROP POLICY IF EXISTS pol_voucher_requests_sede_isolation ON public.voucher_requests;
DROP POLICY IF EXISTS pol_audit_logs_sede_select ON public.audit_logs;
DROP POLICY IF EXISTS pol_audit_logs_sede_insert ON public.audit_logs;

-- 008: las tablas SIN sede propia, que filtraban por el padre. Mueren con la
-- columna del padre: `invoices` y `payroll_periods` son las dos columnas que sus
-- subconsultas nombran. Las que filtraban por `users` NO entran acá: `users`
-- conserva su columna (ver la cabecera del archivo).
DROP POLICY IF EXISTS pol_invoice_items_sede_isolation ON public.invoice_items;
DROP POLICY IF EXISTS pol_invoice_taxes_sede_isolation ON public.invoice_taxes;
DROP POLICY IF EXISTS pol_invoice_payments_sede_isolation ON public.invoice_payments;
DROP POLICY IF EXISTS pol_payroll_periods_sede_isolation ON public.payroll_periods;
DROP POLICY IF EXISTS pol_payroll_items_sede_isolation ON public.payroll_items;
DROP POLICY IF EXISTS pol_payroll_payments_sede_isolation ON public.payroll_payments;

-- 017: la segunda ronda de endurecimiento (caja y comisiones).
DROP POLICY IF EXISTS pol_cash_denominations_sede_isolation ON public.cash_denominations;
DROP POLICY IF EXISTS pol_shift_counts_sede_isolation ON public.cash_shift_counts;
DROP POLICY IF EXISTS pol_commission_rules_sede_isolation ON public.commission_rules;
DROP POLICY IF EXISTS pol_commission_payouts_sede_isolation ON public.commission_payouts;

-- ------------------------------------------------------------- 2.3 --------
-- `uq_commission_rule` (016): el índice único de cuatro columnas que la 075
-- dejó en pie a propósito y dejó señalado para esta unidad.
--
-- Con la columna fuera, el índice caería solo —cualquier índice que la contenga
-- muere con ella—, pero se borra explícito por dos razones que 075 escribió: la
-- primera es que el `DROP INDEX` hace el objeto disappear del catálogo con una
-- sentencia que se lee en el archivo, no como efecto lateral de otra; la
-- segunda es que el nombre `uq_commission_rule_install_key` (075) queda como la
-- ÚNICA garantía de «un ítem × empleado es una sola regla en la instalación», y
-- un índice viejo en pie mantiene viva una etiqueta falsa sobre lo que la base
-- garantiza. No hay ventana de despliegue que custodiar acá: para cuando corre
-- este archivo nadie escribe ni infiere la columna, que es exactamente lo que 075
-- exigía para que este `DROP` fuera seguro.

DROP INDEX IF EXISTS public.uq_commission_rule;

-- ===================================================================== ---
-- 3. LAS TRECE FUNCIONES, de a una: el cuerpo sin `sede_id`, su
--    `search_path` fijo, sus permisos y su documentación.
-- ===================================================================== ---
--
-- Cada cuerpo sale de la ÚLTIMA migración que lo definió —071 para las nueve
-- funciones atómicas de caja, inventario y facturación, 067 para
-- `payroll_apply_atomic`, 065 para `upsert_employee_atomic`, 054 para
-- `create_user_with_role`, 072 para `next_invoice_number`— y se copia entero.
-- Lo único que cambia son las lecturas de la columna, las escrituras de la
-- columna, las claves del `RETURNING` y la prosa que describía la columna.
--
-- Tres cosas de la casa se respetan una por una:
--
--   * EL LOCK SE QUEDA. Donde la función leía la sede de una fila que ya tenía
--     bloqueada —la caja en `cash_open_shift_atomic`, el turno en
--     `invoice_create_atomic`—, la lectura se convierte en un `PERFORM 1` con el
--     MISMO `FOR UPDATE`. El lock es el punto de serialización de la operación y
--     no se negocia: quitar la columna no puede cambiar el orden en que dos
--     operaciones se esperan.
--   * LA RED DE CONTEO SE QUEDA. Cada `GET DIAGNOSTICS` y su comparación
--     sobreviven tal cual, con el mismo SQLSTATE: un subconjunto silencioso
--     sigue siendo un rechazo con rollback, no una escritura parcial.
--   * LA FORMA DE LA RESPUESTA SE QUEDA, menos la clave de la sede. El servicio
--     leía esas columnas con un `select` explícito (`SHIFT_SELECT`,
--     `INVOICE_SELECT`, `PAYMENT_SELECT`, `EMPLOYEE_SELECT`) y ninguna de esas
--     listas nombraba la sede como filtro.

-- ---------------------------------------------------------------- 3.1 ----
-- deduct_stock_atomic (071, que a su vez trae 046)
--
-- El movimiento de stock tomaba la sede del PRODUCTO: sale del `SELECT` la
-- columna que la traía y de la lista de columnas del `INSERT` la que la
-- escribía. El `JOIN` por `p.id`, el `ORDER BY p.id` —el orden de los locks del
-- trigger de 004— y la comparación de conteos quedan igual.
CREATE OR REPLACE FUNCTION public.deduct_stock_atomic(
  p_user_id uuid,
  p_reason text,
  p_items jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pedidos integer;
  v_unicos integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que inserta stock no puede aceptar
  --     una entrada a medio formar: el precio de un rechazo claro acá es
  --     infinitamente menor que el de una deducción interpretada.
  IF p_user_id IS NULL
     OR p_reason IS NULL
     OR btrim(p_reason) = ''
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  --     Cada elemento tiene que ser un objeto con un uuid bien formado (la MISMA
  --     forma que valida el CHECK de la 045) y una cantidad de 1 a 9 dígitos.
  --     El `coalesce` es la parte que importa: con la clave ausente,
  --     `item ->> 'qty'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce una entrada sin `qty` pasaría esta guarda. El `CASE`
  --     garantiza además que el cast a integer sólo se evalúe cuando el texto
  --     YA validó la forma (SQL no promete el orden de las condiciones del OR).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer
            ELSE NULL
          END <= 0
  ) THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.2 Cuántos movimientos se piden y cuántos productos distintos hay. Una
  --     deducción sin ítems no es una deducción; una con un producto repetido
  --     tampoco (ver "UN MOVIMIENTO POR PRODUCTO" de 046: la guarda del stock
  --     no vería el efecto de la fila anterior de la misma sentencia).
  SELECT count(*), count(DISTINCT (item ->> 'product_id'))
    INTO v_pedidos, v_unicos
  FROM jsonb_array_elements(p_items) AS item;

  IF v_pedidos = 0 OR v_unicos <> v_pedidos THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.3 La ESCRITURA: UNA sentencia, y por eso UNA transacción. Todos los
  --     movimientos se insertan con el mismo motivo y el mismo responsable.
  --     `type` es 'OUT' y sólo 'OUT': esta función es el descuento de una venta,
  --     no un movimiento genérico.
  --
  --     `ORDER BY p.id` es el orden de los locks del trigger de 004 (ver
  --     "SERIALIZACIÓN" de 046).
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la deducción de una
  --     emisión no tiene intento de cliente, su puerta es la marca de la
  --     FACTURA (041) y su fila queda FUERA del índice único parcial de la 045
  --     (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 046).
  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    'OUT',
    (item ->> 'qty')::integer,
    btrim(p_reason),
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.4 Red de seguridad DENTRO de la transacción: si se escribió MENOS de lo
  --     pedido, se aborta y se revierte todo lo que esta sentencia sí escribió
  --     (el stock incluido, porque sus triggers corren en la misma
  --     transacción). El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback.
  --     Es la misma red que 039 puso sobre su INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_pedidos THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  RETURN v_escritos;
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres.
-- House style desde 018 (y el mismo paso que da 039).
ALTER FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría descontar stock por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) IS
'CL-7: descuento ATÓMICO del stock de una venta multi-producto. Inserta TODOS los movimientos OUT en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks de fila del trigger trg_inventory_no_negative ordenados por producto para que dos deducciones concurrentes no se bloqueen en ciclo. Un fallo de cualquier movimiento (o de la guarda del stock) revierte la deducción COMPLETA: no queda descuento parcial. Devuelve cuántos movimientos aplicó y falla con DEDUCTION_INVALID (entrada mal formada o producto repetido) o PRODUCT_NOT_FOUND (la red de seguridad del conteo). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock; esta función nunca escribe products.stock_qty. El movimiento no lleva columna de sede: la instalación es de una sola sede (071) y el producto era la fila que la definía (077). Escribe idempotency_key NULL a propósito: la deducción de una emisión no tiene intento de cliente y queda fuera del índice parcial de la 045. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.2 ----
-- cash_open_shift_atomic (071, que a su vez trae 049)
--
-- La caja se bloqueaba para leer su sede y para serializar el ciclo de caja de
-- esa caja. El lock se queda entero; lo que sale es la columna que se leía. El
-- `PERFORM` con `FOR UPDATE OF r` deja el comportamiento idéntico —incluido el
-- `NOT FOUND` que traduce el error de negocio— y sin una variable que ya no
-- tendría a qué asignarse.
CREATE OR REPLACE FUNCTION public.cash_open_shift_atomic(
  p_register_id uuid,
  p_opened_by uuid,
  p_opening_base numeric,
  p_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que abre un turno de caja no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de una apertura interpretada. La base no
  --     puede ser negativa, pero SÍ puede ser cero (una caja que abre sin
  --     fondo es un caso legal).
  IF p_register_id IS NULL
     OR p_opened_by IS NULL
     OR p_opening_base IS NULL
     OR p_opening_base < 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo. El `coalesce` es la parte que importa: con la
  --     clave AUSENTE, `item ->> 'amount'` es NULL y `NULL !~ 'regex'` es NULL
  --     —no TRUE—, así que sin el coalesce una línea sin monto pasaría esta
  --     guarda y sería el `NOT NULL` de la columna el que hablara, con un error
  --     de la base en vez de un rechazo del contrato. Es la misma trampa que 046
  --     documenta para `qty`, 047 para `net_pay` y 048 para sus montos.
  --
  --     La estructura que la tabla ya exige (009) también se comprueba acá, por
  --     FORMA y no por aritmética: una línea de EFECTIVO lleva denominación y
  --     cualquier cantidad; una línea DIGITAL no lleva denominación y declara su
  --     total con cantidad 1. El `CASE` garantiza que cada conversión a
  --     `numeric`/`integer` sólo se evalúe cuando el texto YA validó su forma
  --     (SQL no promete el orden de las condiciones del OR).
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    CROSS JOIN LATERAL (
      SELECT
        coalesce(item ->> 'method_code', '') AS method_code,
        coalesce(item ->> 'denomination', '') AS denomination_txt,
        coalesce(item ->> 'quantity', '') AS quantity_txt,
        coalesce(item ->> 'amount', '') AS amount_txt
    ) AS txt
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(txt.method_code) = ''
       OR txt.denomination_txt !~ '^([0-9]{1,9}([.][0-9]{1,2})?)?$'
       OR txt.quantity_txt !~ '^[0-9]{1,9}$'
       OR txt.amount_txt !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR CASE
            WHEN txt.quantity_txt ~ '^[0-9]{1,9}$'
              THEN (txt.quantity_txt)::integer <> 1 AND txt.denomination_txt = ''
            ELSE NULL
          END
       OR CASE
            WHEN txt.denomination_txt ~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
              THEN (txt.denomination_txt)::numeric <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 1.2 La CAJA, bloqueada: es el punto de serialización de todo el ciclo de
  --     caja. A partir de acá, otra apertura, otro cierre u otro reconteo de la
  --     MISMA caja espera; y si la caja no existe, la transacción rechaza en
  --     vez de abrir un turno de una caja que no está. El `PERFORM` con el mismo
  --     `FOR UPDATE` conserva el lock y el `NOT FOUND` conserva el error de
  --     negocio: lo único que se fue es la columna que la fila ya no declara.
  PERFORM 1
    FROM public.cash_registers r
   WHERE r.id = p_register_id
   FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_REGISTER_NOT_FOUND';
  END IF;

  -- 1.3 El guardia de "un turno abierto por caja" (CAJ-01), re-evaluado adentro
  --     con la caja YA bloqueada. Es la misma regla que `assertNoOpenShift`
  --     aplica en el servicio; el índice único parcial de 006
  --     (`uq_cash_shifts_open_per_register`) sigue siendo la barrera final si
  --     dos aperturas llegaran a evaluar esto a la vez, y el `23505` que
  --     levanta lo traduce el servicio al MISMO error de negocio.
  PERFORM 1
    FROM public.cash_shifts s
   WHERE s.cash_register_id = p_register_id
     AND s.status = 'abierto'
   ORDER BY s.id
   FOR UPDATE OF s;

  IF FOUND THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_OPEN';
  END IF;

  -- 1.4 El TURNO: UNA sentencia, y por eso UNA transacción con su arqueo de
  --     abajo. El turno nace `abierto`, con la base que el servicio resolvió
  --     —escrita verbatim— y con `expected_cash` en 0, como nacía antes: el
  --     esperado de un turno recién abierto todavía no tiene cobros.
  INSERT INTO public.cash_shifts
    (cash_register_id, opened_by, opening_base, expected_cash, status)
  VALUES
    (p_register_id, p_opened_by, p_opening_base, 0, 'abierto')
  RETURNING * INTO v_turno;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 1.5 El ARQUEO DE APERTURA: las líneas por método y denominación, con la
  --     fase que le corresponde, el turno recién creado y cada monto ESCRITO
  --     VERBATIM desde `p_counts` —acá no se multiplica denominación por
  --     cantidad ni se suma nada—. `ORDER BY` deja el orden determinista (ver
  --     "SERIALIZACIÓN" de 049).
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    v_turno.id,
    'apertura',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     líneas de las recibidas, se aborta y se revierte TODO, el turno
  --     incluido. Sin esta red, un arreglo que escribiera un subconjunto
  --     dejaría un turno ABIERTO sin su arqueo: exactamente el estado parcial
  --     que 049 cierra.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, con las MISMAS columnas que el servicio leía: eso es
  --     lo que el llamador usa como resultado, sin otra lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'opened_by', v_turno.opened_by,
    'closed_by', v_turno.closed_by,
    'opened_at', v_turno.opened_at,
    'closed_at', v_turno.closed_at,
    'opening_base', v_turno.opening_base,
    'expected_cash', v_turno.expected_cash,
    'counted_cash', v_turno.counted_cash,
    'base_left', v_turno.base_left,
    'cash_withdrawn', v_turno.cash_withdrawn,
    'base_difference', v_turno.base_difference,
    'status', v_turno.status,
    'observation', v_turno.observation
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `cash_registers`, `cash_shifts` y `cash_shift_counts`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–048).
ALTER FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría abrir un turno de caja por PostgREST con la base
-- y el conteo que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) IS
'CL-10: apertura ATÓMICA de un turno de caja (CAJ-01). Inserta el turno ABIERTO y su conteo de apertura en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la caja bloqueada primero para que el guardia de "un turno abierto por caja" (índice único parcial de 006) no pueda volverse mentira entre la lectura y la escritura. El turno no lleva columna de sede: la instalación es de una sola sede (071) y la caja era la fila que la definía, así que el lock de esa caja es lo que serializa la apertura (077). NO calcula nada: la base del turno llega resuelta por resolveOpeningBase y cada línea del conteo llega validada por checkCounts; la función las escribe verbatim. Un fallo de la escritura del turno o del arqueo —y su red de conteo, que aborta si no escribió exactamente las líneas recibidas— revierte la transacción COMPLETA: no queda un turno abierto sin su arqueo de apertura. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT; falla con SHIFT_INVALID (entrada mal formada), SHIFT_REGISTER_NOT_FOUND (la caja no existe), SHIFT_ALREADY_OPEN (la carrera del turno abierto, 23505), SHIFT_WRITE_MISMATCH o SHIFT_COUNT_MISMATCH. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.3 ----
-- cash_close_shift_atomic (071, que a su vez trae 059)
--
-- El cierre no escribía ni leía la columna de la sede: su único rastro era la
-- clave `sede_id` del `jsonb` que devuelve. Sale esa clave y sale la mención
-- de la columna en el `COMMENT`; el turno bloqueado, los cuatro re-conteos de
-- la precondición del arqueo, el compare-and-swap sobre `status` y las dos redes
-- de conteo quedan exactamente como estaban.
CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic(
  p_shift_id uuid,
  p_closed_by uuid,
  p_closed_at timestamptz,
  p_close jsonb,
  p_counts jsonb,
  p_collection_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_esperados integer;
  v_actualizados integer;
  v_escritos integer;
  v_payments bigint;
  v_invoice_payments bigint;
  v_commission_payouts bigint;
  v_voucher_requests bigint;
BEGIN
  -- 1.1 FORMA de la entrada. Un cierre es el documento que firma un arqueo: no
  --     puede aceptar una entrada a medio formar.
  IF p_shift_id IS NULL
     OR p_closed_by IS NULL
     OR p_closed_at IS NULL
     OR p_close IS NULL
     OR jsonb_typeof(p_close) <> 'object'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     EL TOKEN: la forma de la PRECONDICIÓN. Sin esta guarda, una clave
  --     ausente dejaría `(null)::integer` en la comparación de 1.3, la
  --     comparación daría NULL —no TRUE— y el cierre pasaría SIN comprobar
  --     nada: un bypass silencioso. Un objeto con los CUATRO conteo como enteros
  --     no negativos es la única forma aceptada; el `coalesce` es el mismo
  --     recurso que 046–049 y 058 usan para que una clave AUSENTE falle en vez
  --     de comparar contra NULL, y la ausencia se rechaza con el error de forma
  --     —jamás se interpreta como "no compares"—, como 057 dejó escrito para su
  --     propia precondición.
  --
  --     Que la guarda exija las CUATRO claves es lo que hace que este archivo no
  --     sea compatible hacia atrás con la app de 058: un llamador que mande dos
  --     recibe SHIFT_INVALID y no cierra. Es deliberado (ver "ACOPLAMIENTO DE
  --     DESPLIEGUE" de 059): aceptar dos sería aceptar firmar sin comprobar las
  --     salidas.
  IF p_collection_counts IS NULL
     OR jsonb_typeof(p_collection_counts) <> 'object'
     OR coalesce(p_collection_counts ->> 'payments', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'invoice_payments', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'commission_payouts', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'voucher_requests', '') !~ '^[0-9]{1,9}$'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Los CUATRO montos del turno y su observación. El `coalesce` es lo que
  --     hace que una clave AUSENTE falle en vez de comparar contra NULL (la
  --     misma trampa de 046–048).
  --
  --     `base_difference` (base dejada menos base configurada) y
  --     `expected_cash` PUEDEN ser negativos en una entrada legítima: el
  --     primero es el faltante de la base (caso 300/150 del dueño) y el segundo
  --     lo rechaza una regla de NEGOCIO que NO vive acá —el CHECK
  --     `expected_cash >= 0` de 006—, que el servicio traduce a
  --     CASH_OUT_EXCEEDS_COLLECTED. Por eso la guarda de forma de esos dos
  --     admite el signo: adelantarse a esa regla con un SHIFT_INVALID sería
  --     cambiar el contrato de error del cierre. `cash_withdrawn` también lo
  --     admite: es una DIFERENCIA (contado menos base dejada), no un nivel, y la
  --     tabla no le exige ser no negativo —la guarda espeja la tabla, no
  --     inventa una restricción que ella no tiene—. `counted_cash`, `base_left`
  --     y la base de apertura NO admiten signo porque el CHECK de 006 sí los
  --     exige no negativos (y el esquema del servicio también).
  IF coalesce(p_close ->> 'expected_cash', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR (p_close -> 'observation' IS NOT NULL
         AND jsonb_typeof(p_close -> 'observation') NOT IN ('null', 'string'))
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo: la misma guarda de forma de la apertura (ver
  --     1.1 de 049), porque es el mismo conteo con otra fase.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    CROSS JOIN LATERAL (
      SELECT
        coalesce(item ->> 'method_code', '') AS method_code,
        coalesce(item ->> 'denomination', '') AS denomination_txt,
        coalesce(item ->> 'quantity', '') AS quantity_txt,
        coalesce(item ->> 'amount', '') AS amount_txt
    ) AS txt
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(txt.method_code) = ''
       OR txt.denomination_txt !~ '^([0-9]{1,9}([.][0-9]{1,2})?)?$'
       OR txt.quantity_txt !~ '^[0-9]{1,9}$'
       OR txt.amount_txt !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR CASE
            WHEN txt.quantity_txt ~ '^[0-9]{1,9}$'
              THEN (txt.quantity_txt)::integer <> 1 AND txt.denomination_txt = ''
            ELSE NULL
          END
       OR CASE
            WHEN txt.denomination_txt ~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
              THEN (txt.denomination_txt)::numeric <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 1.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA (no
  --     del dato que mandó el llamador). `FOR UPDATE` es el idioma de la casa
  --     para tomar un lock de fila (039, 040, 047, 048): a partir de acá, otro
  --     cierre del mismo turno espera; un cobro del mismo turno (056) espera o
  --     es rechazado; y si el turno ya se cerró antes, esta lectura ve la versión
  --     nueva y rechaza.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 1.2b LA PRECONDICIÓN DEL CONJUNTO DEL ARQUEO (CL-19 + CL-20). El paso se
  --      numera "1.2b" —y no se renumeran los pasos de 049 ni los de 058— para
  --      que el diff se lea de un vistazo: la precondición entra EXACTAMENTE
  --      entre el lock del turno y la escritura, y nada más se mueve.
  --
  --      Los CUATRO `count(*)` RE-CUENTAN las MISMAS cuatro fuentes que el
  --      servicio usó: las dos que el arqueo SUMA (`payments` del turno sin
  --      factura, y las `invoice_payments` atribuidas al turno) y las dos que
  --      RESTA (`commission_payouts` del turno, y los vales aprobados con método
  --      del turno). NO se suma ningún monto: contar filas no es operar sobre
  --     dinero. Las variables son `bigint` porque es el tipo que `count(*)`
  --     devuelve: no hay ninguna conversión estrecha entre el conteo y lo que se
  --     compara (la guarda de forma de 1.1 ya limitó el token a nueve dígitos).
  --
  --      La segunda fuente es la UNIÓN que describe `fetchInvoicePaymentsByShift`:
  --      las filas con `cash_shift_id = p_shift_id` MÁS las históricas sin turno
  --      (`cash_shift_id IS NULL`) cuya factura pertenece al turno. Las dos ramas
  --      son disjuntas por construcción, así que el `OR` no cuenta una fila dos
  --      veces, y el `EXISTS` por la PK de `invoices` no recorre la tabla de
  --      facturas.
  SELECT count(*) INTO v_payments
    FROM public.payments p
   WHERE p.cash_shift_id = p_shift_id
     AND p.invoice_id IS NULL;

  SELECT count(*) INTO v_invoice_payments
    FROM public.invoice_payments ip
   WHERE ip.cash_shift_id = p_shift_id
      OR (ip.cash_shift_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM public.invoices i
             WHERE i.id = ip.invoice_id
               AND i.cash_shift_id = p_shift_id
          ));

  --      Tercera fuente: los pagos inmediatos de comisión del turno. TODAS las
  --      filas del turno restan del arqueo por su método (el servicio las agrupa
  --      con `paidOutByMethod` sin filtrar por método), así que el predicado es
  --      UNO solo y no lleva ninguna condición de más: es exactamente la lectura
  --      del servicio (`.eq("cash_shift_id", shift.id)`).
  SELECT count(*) INTO v_commission_payouts
    FROM public.commission_payouts cp
   WHERE cp.cash_shift_id = p_shift_id;

  --      Cuarta fuente: los vales del turno que el arqueo RESTA. El predicado es
  --      el de `isVoucherCashOut` (schemas.ts), transcrito UNA vez acá: aprobado
  --      (`approved_by` no nulo) Y con método (`method_code` no nulo). Un vale
  --      pendiente o rechazado no toca caja, y uno sin método es histórico
  --      (anterior a la 028) y tampoco afecta el arqueo; contarlos haría que una
  --      solicitud de vale nueva —que no cambia el número firmado— rechazara un
  --      cierre legítimo.
  SELECT count(*) INTO v_voucher_requests
    FROM public.voucher_requests vr
   WHERE vr.cash_shift_id = p_shift_id
     AND vr.approved_by IS NOT NULL
     AND vr.method_code IS NOT NULL;

  --      El RECHAZO. Si CUALQUIERA de los cuatro conteo difiere del que el
  --      llamador mandó, entre su lectura y este lock se confirmó un movimiento
  --      del turno: el arqueo que viaja en `p_close` ya no corresponde a sus
  --      cuatro entradas y la transacción NO ESCRIBE NADA. El arqueo NO se
  --      recalcula —eso sería sumar y restar dinero en SQL— ni se firma "como
  --      estaba": se rechaza, que es la única salida honesta cuando el llamador
  --      firmó un conjunto que cambió.
  --
  --      El código es el MISMO de 058 (`ARQUEO_STALE`) porque es el MISMO
  --      contrato: el servicio lo traduce a un rechazo accionable y el llamador
  --      reintenta con un arqueo fresco. No hace falta una red de conteo acá:
  --      esto no escribe nada, sólo lee cuatro veces y compara.
  IF v_payments <> (p_collection_counts ->> 'payments')::bigint
     OR v_invoice_payments <> (p_collection_counts ->> 'invoice_payments')::bigint
     OR v_commission_payouts <> (p_collection_counts ->> 'commission_payouts')::bigint
     OR v_voucher_requests <> (p_collection_counts ->> 'voucher_requests')::bigint
  THEN
    RAISE EXCEPTION 'ARQUEO_STALE';
  END IF;

  -- 1.3 El CIERRE del turno: el mismo `UPDATE` que hacía el servicio, con su
  --     compare-and-swap (`status = 'abierto'`) conservado en el propio `WHERE`
  --     —es lo que hace que dos cierres concurrentes no se pisen: el segundo
  --     escribe cero filas—, y cada monto ESCRITO VERBATIM desde `p_close`. Acá
  --     no se suma, no se resta y no se recalcula nada: el recogido, la base
  --     dejada y el sobre llegan resueltos por `resolveClosingBase` y
  --     `computeCashClose` (TypeScript).
  --
  --     La observación entra tal como llegó (el servicio ya la normalizó a NULL
  --     cuando venía vacía). El CHECK de 006 (`expected_cash >= 0`) NO se
  --     replica acá a propósito: es la regla de negocio que el servicio traduce a
  --     CASH_OUT_EXCEEDS_COLLECTED, y este archivo no la reemplaza ni la adelanta.
  UPDATE public.cash_shifts s
     SET expected_cash = (p_close ->> 'expected_cash')::numeric,
         counted_cash = (p_close ->> 'counted_cash')::numeric,
         base_left = (p_close ->> 'base_left')::numeric,
         cash_withdrawn = (p_close ->> 'cash_withdrawn')::numeric,
         base_difference = (p_close ->> 'base_difference')::numeric,
         observation = p_close ->> 'observation',
         status = 'cerrado',
         closed_at = p_closed_at,
         closed_by = p_closed_by
   WHERE s.id = p_shift_id
     AND s.status = 'abierto'
  RETURNING * INTO v_turno;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y el
  --     llamador recibe el MISMO error de negocio que ya recibía cuando perdía
  --     el compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 1.5 El ARQUEO DE CIERRE: las líneas por denominación, con la fase que le
  --     corresponde y cada monto escrito VERBATIM desde `p_counts`. Es la
  --     evidencia que hace real al cierre: sin ella, el turno firmaría un total
  --     que ningún detalle respalda.
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    p_shift_id,
    'cierre',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 1.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el cierre incluido. Es lo que separa "el
  --     cierre no se pudo firmar" de "el cierre quedó firmado sin su evidencia"
  --     —y este último, con el CAS, ya no se podría volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, tal como quedó en la tabla, con las mismas columnas
  --     que el servicio leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'opened_by', v_turno.opened_by,
    'closed_by', v_turno.closed_by,
    'opened_at', v_turno.opened_at,
    'closed_at', v_turno.closed_at,
    'opening_base', v_turno.opening_base,
    'expected_cash', v_turno.expected_cash,
    'counted_cash', v_turno.counted_cash,
    'base_left', v_turno.base_left,
    'cash_withdrawn', v_turno.cash_withdrawn,
    'base_difference', v_turno.base_difference,
    'status', v_turno.status,
    'observation', v_turno.observation
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `cash_shifts`, `cash_shift_counts`, `payments`,
-- `invoice_payments`, `invoices`, `commission_payouts` y `voucher_requests`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049/058).
ALTER FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cerrar el turno de un cajero firmando un arqueo
-- con los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) IS
'CL-10/CL-19/CL-20: cierre ATÓMICA de un turno de caja (CAJ-03/CAJ-04) con PRECONDICIÓN sobre las CUATRO entradas del arqueo. Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. CL-19 agregó p_collection_counts: los CONTEO de filas de las DOS fuentes que el arqueo SUMA (payments del turno sin factura e invoice_payments atribuidas al turno). CL-20 extiende el MISMO token con los CONTEO de las DOS fuentes que el arqueo RESTA (commission_payouts del turno y voucher_requests del turno aprobados y con método): una comisión pagada o la aprobación de un vale confirmadas entre la lectura del servicio y este lock ya no quedan fuera de un arqueo firmado. La transacción RE-CUENTA las cuatro fuentes bajo el lock y, si alguna difiere, RECHAZA con ARQUEO_STALE sin escribir nada. El token es OBLIGATORIO —las CUATRO claves se exigen por forma; su ausencia es SHIFT_INVALID, nunca "no compares"— y son CONTEO, no sumas: acá no se suma ni se resta un solo monto, porque mover aritmética de dinero a SQL está prohibido en este proyecto. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y el turno que devuelve ya no la nombra (077). Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.4 ----
-- invoice_annul_atomic (071, que a su vez trae 050)
--
-- Dos rastros de la columna y ninguno más: la del `INSERT` de movimientos —que
-- tomaba la del producto— y la clave `sede_id` del `jsonb` de la factura
-- devuelta. El lock de la factura, el compare-and-swap sobre el estado leído y
-- las dos redes de conteo quedan como estaban.
CREATE OR REPLACE FUNCTION public.invoice_annul_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_motivo text,
  p_expected_status text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que anula una factura y devuelve stock
  --     no puede aceptar una entrada a medio formar: el precio de un rechazo
  --     claro acá es infinitamente menor que el de una anulación interpretada.
  --     El motivo no puede venir vacío —el CHECK de 005 lo exige para `Anulada`
  --     y el schema del servicio ya lo garantiza— y la precondición de estado
  --     tiene que venir: es la mitad del compare-and-swap. Qué estados son
  --     anulables es una regla de NEGOCIO del servicio (`canAnnulStatus`), no de
  --     acá: sólo se exige que venga.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_motivo IS NULL
     OR btrim(p_motivo) = ''
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  --     Cada reversión tiene que ser un objeto con un uuid bien formado (la
  --     MISMA forma que valida el CHECK de la 045 para la marca y que 046 valida
  --     para el producto), una cantidad de 1 a 9 dígitos y un motivo no vacío.
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item ->> 'qty'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce una entrada sin `qty` pasaría esta guarda. El `CASE`
  --     garantiza además que el cast a integer sólo se evalúe cuando el texto YA
  --     validó la forma (SQL no promete el orden de las condiciones del OR).
  --
  --     La cantidad PUEDE repetirse entre líneas —a diferencia de 046, que la
  --     rechaza—: la reversión escribe un movimiento por LÍNEA de factura y el
  --     kardex tiene que conservar esas dos filas (ver "EL STOCK DE LA
  --     REVERSIÓN" de 050). Lo que NO se permite es una línea a medio formar.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR btrim(coalesce(item ->> 'reason', '')) = ''
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 1.2 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047, 048, 049): a partir de
  --     acá, otra anulación —o un cobro, que también bloquea esta fila por el
  --     tope de 031— espera, y el estado no puede cambiar entre la lectura que
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     El estado leído por el servicio es la precondición: si otra anulación
  --     ganó la carrera, esta lectura ya ve `Anulada` y la transacción rechaza
  --     SIN escribir. Es el mismo código (ANNUL_CONFLICT) que el servicio
  --     devolvía cuando perdía el compare-and-swap.
  IF v_factura.status <> p_expected_status THEN
    RAISE EXCEPTION 'ANNUL_CONFLICT';
  END IF;

  -- 1.3 El grupo 1: la FACTURA a `Anulada`, con el compare-and-swap CONSERVADO
  --     en su propio `WHERE` —es lo que hace que dos anulaciones concurrentes no
  --     se pisen, y ahora además una red de conteo— y con el motivo y el cierre
  --     escritos VERBATIM desde la entrada. Acá no se recalcula nada.
  UPDATE public.invoices i
     SET status = 'Anulada',
         cancel_reason = p_motivo,
         closed_by = p_user_id,
         closed_at = p_closed_at
   WHERE i.id = p_invoice_id
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --     actualizada. Cero filas es un estado que cambió bajo los pies (otra
  --     anulación ganó el CAS entre la lectura bloqueada y el UPDATE, o la fila
  --     desapareció): la operación entera aborta —el stock incluido— y el
  --     llamador recibe el MISMO error de negocio que ya recibía cuando perdía
  --     el compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'ANNUL_CONFLICT';
  END IF;

  -- 1.5 El grupo 2: las REVERSIONES de stock, UNA sentencia, y por eso la misma
  --     transacción que la factura: o se escriben TODAS, o no se escribió nada.
  --     `type` es 'IN' y sólo 'IN': esta función es la reversión de una
  --     anulación, no un movimiento genérico. Cada fila lleva el motivo de SU
  --     línea —tal como lo computó `buildReversalReasons`— escrito verbatim: acá
  --     no se concatena texto.
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la anulación no tiene un
  --     intento de cliente, su puerta es el compare-and-swap de la FACTURA y su
  --     fila queda FUERA del índice único parcial de la 045 (ver "LA MARCA DE LA
  --     045 NO ENTRA ACÁ" de 050).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 050).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    'IN',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     movimientos que los pedidos, se aborta y se revierte TODO, la anulación
  --     incluida. El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback, y es
  --     exactamente lo que separa "la anulación no se pudo hacer" de "la factura
  --     quedó anulada sin su reversión". Es la misma red que 039, 046 y 049
  --     pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.7 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --     `INVOICE_SELECT`: eso es lo que el llamador usa como resultado, sin otra
  --     lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_factura.id,
    'consecutive_number', v_factura.consecutive_number,
    'client_name', v_factura.client_name,
    'client_document', v_factura.client_document,
    'subtotal', v_factura.subtotal,
    'discount', v_factura.discount,
    'tax', v_factura.tax,
    'surcharge', v_factura.surcharge,
    'total', v_factura.total,
    'status', v_factura.status,
    'user_id', v_factura.user_id,
    'cash_shift_id', v_factura.cash_shift_id,
    'closed_by', v_factura.closed_by,
    'closed_at', v_factura.closed_at,
    'cancel_reason', v_factura.cancel_reason,
    'created_at', v_factura.created_at,
    'edit_version', v_factura.edit_version
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `products` e `inventory_movements`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049).
ALTER FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría anular una factura —devolviendo su stock y
-- salteando el candado de nómina cerrada— por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) IS
'CL-11: anulación ATÓMICA de una factura (FAC-04/FAC-06). Pisa la factura a Anulada —conservando el compare-and-swap sobre el estado leído— y escribe las reversiones IN de stock en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización del dinero de esa factura, también frente a un cobro) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el motivo, el estado esperado y cada reversión (producto, cantidad y motivo) llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004), que para un IN suma —la guarda de negatividad sólo actúa sobre los OUT, así que un IN no toma ese lock—. Sus redes de conteo abortan con ANNUL_CONFLICT si no actualizó exactamente la factura en el estado leído (una carrera se rechaza y no escribe nada) o con PRODUCT_NOT_FOUND si no escribió exactamente las reversiones pedidas; en los dos casos la transacción se revierte COMPLETA: no queda una factura anulada sin su reversión, y el reintento sigue siendo posible. El arreglo de reversiones puede venir VACÍO (una factura de servicios no mueve stock). Escribe idempotency_key NULL a propósito: la anulación no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.5 ----
-- invoice_edit_items_atomic (071, que a su vez trae 051)
--
-- La edición ADMIN: total inmutable. Los cambios son los de la lista de
-- columnas del `INSERT` de movimientos (que tomaba la del producto), la clave
-- `sede_id` de la factura anidada del `jsonb` y la prosa que describía ambos.
-- Los SEIS grupos de escritura, el candado de la 038 dentro del `WHERE` y las
-- CUATRO redes de conteo quedan intactos.
CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_items jsonb;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
  v_items_escritos integer := 0;
  v_movimientos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que REEMPLAZA los ítems de una factura
  --     y mueve su stock no puede aceptar una entrada a medio formar: el precio
  --     de un rechazo claro acá es infinitamente menor que el de una edición
  --     interpretada. La versión esperada tiene que venir y no puede ser negativa
  --     (el CHECK de la 038), y el estado esperado es la otra mitad del candado.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_edit IS NULL
     OR jsonb_typeof(p_edit) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Cada grupo tiene que venir como ARREGLO (una fila por request no existe
  --     acá) y una clave AUSENTE se trata como arreglo vacío: es el caso legal de
  --     "no hay nada de ese grupo" (una edición que sólo cambia el método de un
  --     cobro no borra ni inserta un solo ítem).
  IF jsonb_typeof(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_update', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'payments', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'movements', '[]'::jsonb)) <> 'array'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los ids a borrar, uno por uno: un uuid bien formado (la MISMA forma que
  --     valida el CHECK de la 045 para la marca y que 046/050 validan para el
  --     producto). El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item #>> '{}'` es NULL y `NULL !~* 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce un elemento sin texto pasaría esta guarda.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Y las líneas de ítem: las MISMAS para las que se actualizan y las que se
  --     insertan, así que se validan en UNA sola pasada sobre los dos arreglos
  --     juntos (`||` de jsonb concatena). Cada línea tiene que ser un objeto con
  --     su origen (`item_type` de los tres del CHECK de 005), su empleado (FAC-02:
  --     obligatorio), una cantidad de 1 a 9 dígitos y mayor que cero, y los
  --     valores que la tabla puede guardar (dinero con dos decimales, `percent`
  --     hasta 100). El `CASE` garantiza que cada cast sólo se evalúe cuando el
  --     texto YA validó su forma (SQL no promete el orden de las condiciones del
  --     OR), y los campos OPCIONALES (`product_id`, `service_id`, `custom_name`,
  --     `commission_value`, `commission_percent_override`) se aceptan ausentes o
  --     nulos pero se validan si vienen con valor.
  v_items := coalesce(p_edit -> 'items_update', '[]'::jsonb)
             || coalesce(p_edit -> 'items_insert', '[]'::jsonb);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(jsonb_typeof(item -> 'no_commission'), '') <> 'boolean'
       OR (coalesce(item ->> 'product_id', '') <> ''
           AND coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'service_id', '') <> ''
           AND coalesce(item ->> 'service_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (item ->> 'commission_value' IS NOT NULL
           AND (item ->> 'commission_value') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item ->> 'commission_percent_override' IS NOT NULL
           AND (item ->> 'commission_percent_override') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Las que se ACTUALIZAN llevan además su id: es la única referencia con la
  --     que la función sabe a QUÉ fila de la factura aplica cada juego de
  --     columnas.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
    WHERE coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los cobros: la edición NO agrega ni quita porciones (sólo cambia el
  --     método), así que cada entrada trae el id de una porción que ya existe,
  --     su código de método (el snapshot que la tabla exige) y, opcionalmente, el
  --     id del catálogo.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Y los movimientos de stock: el producto, el TIPO (esta operación escribe
  --     el ajuste de una edición, que puede subir o bajar el stock: IN u OUT, y
  --     nada más), la cantidad y el motivo, que no puede venir vacío (es el texto
  --     del kardex, y un movimiento sin motivo no es auditable).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'type', '') NOT IN ('IN', 'OUT')
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR btrim(coalesce(item ->> 'reason', '')) = ''
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  -- 1.2 La FACTURA, bloqueada, y su precondición RELEÍDA DE LA FILA (no del dato
  --     que mandó el llamador). `FOR UPDATE` es el idioma de la casa para tomar
  --     un lock de fila (039, 040, 047, 048, 049, 050): a partir de acá otra
  --     edición —y también una anulación o un cobro, que toman el mismo lock—
  --     espera, y ni la versión ni el estado pueden cambiar entre la lectura que
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     El candado de la 038 (CL-1): la versión Y el estado leídos por el
  --     servicio son la precondición. Si otra edición ya movió el token, o una
  --     anulación o un cobro dejaron la fila terminal, esta lectura ya lo ve y la
  --     transacción rechaza SIN escribir. Es el MISMO código (EDIT_CONFLICT) y el
  --     MISMO mensaje de negocio que el servicio devolvía cuando perdía el
  --     compare-and-swap en el cliente.
  IF v_factura.edit_version <> p_expected_version
     OR v_factura.status <> p_expected_status
  THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 1.3 El grupo 1: la FACTURA, con el token de la 038 CONSERVADO en su propio
  --     `WHERE` —es lo que hace que dos ediciones concurrentes no se pisen, ahora
  --     con el lock de arriba Y con la red de conteo de abajo— y sin una sola
  --     columna de dinero: esta función es la edición ADMIN, y su total es
  --     INMUTABLE. No hay `subtotal`, ni `discount`, ni `tax`, ni `surcharge`, ni
  --     `total` en la lista de columnas, y no es un olvido: es la política de esta
  --     edición, escrita como ausencia.
  UPDATE public.invoices i
     SET edit_version = p_expected_version + 1
   WHERE i.id = p_invoice_id
     AND i.edit_version = p_expected_version
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --     actualizada. Cero filas es un estado —o una versión— que cambió bajo los
  --     pies: la edición entera aborta, ítems y stock incluidos, y el llamador
  --     recibe el MISMO error de negocio que ya recibía cuando perdía el
  --     compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 1.5 El grupo 2: los ítems que se QUITAN. Se borra por id Y por factura (el id
  --     solo no alcanza: la edición no toca la línea de otra factura), en UNA
  --     sentencia. La cuenta es contra los ids RECIBIDOS: el reemplazo tiene que
  --     quitar exactamente lo que el servicio leyó, y un id que no era de esta
  --     factura —o que ya no está— es un subconjunto silencioso, no un reemplazo.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_items d
   WHERE d.invoice_id = p_invoice_id
     AND d.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.6 El grupo 3: los ítems que CAMBIAN, en UNA sentencia multi-fila: cada
  --     juego de columnas sale del arreglo y se aplica a la fila de su id. Las
  --     columnas son las MISMAS que el servicio escribía —y las mismas que el
  --     INSERT de 1.7, columna por columna—, con el `subtotal` que el servicio
  --     computó, y `custom_name` se escribe VERBATIM (el recorte del texto lo hizo
  --     el servicio: acá no hay una sola función de texto).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_update', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_items d
     SET item_type = item ->> 'item_type',
         product_id = CASE
                        WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
                        ELSE (item ->> 'product_id')::uuid
                      END,
         service_id = CASE
                        WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
                        ELSE (item ->> 'service_id')::uuid
                      END,
         custom_name = item ->> 'custom_name',
         employee_id = (item ->> 'employee_id')::uuid,
         qty = (item ->> 'qty')::integer,
         unit_price = (item ->> 'unit_price')::numeric,
         discount = (item ->> 'discount')::numeric,
         no_commission = (item ->> 'no_commission')::boolean,
         commission_value = CASE
                              WHEN item ->> 'commission_value' IS NULL THEN NULL
                              ELSE (item ->> 'commission_value')::numeric
                            END,
         commission_mode = item ->> 'commission_mode',
         commission_percent_override = CASE
                              WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
                              ELSE (item ->> 'commission_percent_override')::numeric
                            END,
         subtotal = (item ->> 'subtotal')::numeric
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
   WHERE d.id = (item ->> 'id')::uuid
     AND d.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.7 El grupo 4: los ítems que se AGREGAN, también en UNA sentencia: la fila
  --     nace con el `invoice_id` de esta factura y con las MISMAS columnas que el
  --     UPDATE de 1.6. El `id` lo genera la PK de la tabla, como en el camino
  --     viejo (el servicio nunca mandaba un id para una línea nueva).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_insert', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    p_invoice_id,
    item ->> 'item_type',
    CASE
      WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
      ELSE (item ->> 'product_id')::uuid
    END,
    CASE
      WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
      ELSE (item ->> 'service_id')::uuid
    END,
    item ->> 'custom_name',
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    CASE
      WHEN item ->> 'commission_value' IS NULL THEN NULL
      ELSE (item ->> 'commission_value')::numeric
    END,
    item ->> 'commission_mode',
    CASE
      WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
      ELSE (item ->> 'commission_percent_override')::numeric
    END,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.8 El grupo 5: los COBROS. La edición no agrega ni quita porciones —el
  --     servicio ya rechaza ese caso (`VALIDATION`)— ni toca un monto: sólo pisa
  --     el método (su código y, si el método sigue activo, su id de catálogo). El
  --     `amount` y el `fee_amount` NO están en la lista: son el dinero cobrado y
  --     no se editan. En UNA sentencia, con la cuenta de siempre.
  SELECT jsonb_array_length(coalesce(p_edit -> 'payments', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_payments pay
     SET method_code = item ->> 'method_code',
         method_id = CASE
                       WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
                       ELSE (item ->> 'method_id')::uuid
                     END
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
   WHERE pay.id = (item ->> 'id')::uuid
     AND pay.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.9 El grupo 6: el AJUSTE DE STOCK, UNA sentencia y por eso la misma
  --     transacción que los ítems: o se escribe el ajuste COMPLETO, o no se
  --     escribió ningún ítem. Cada fila lleva su tipo (IN u OUT), su cantidad y su
  --     motivo, escrito verbatim desde el dato del servicio.
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la edición no tiene un
  --     intento de cliente y su fila queda FUERA del índice único parcial de la
  --     045 (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 051).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 051), y el otro
  --     efecto —el orden de las filas del kardex dentro de una edición— está
  --     declarado en la cabecera de 051. El JOIN une por el id del producto.
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.10 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --      movimientos que los pedidos, se aborta y se revierte TODO, los ítems y
  --      el token incluidos. El `JOIN` de arriba une por el id del producto, así
  --      que un producto inexistente escribiría menos filas en SILENCIO: esta
  --      guarda convierte ese subconjunto silencioso en un rechazo con rollback, y
  --      es lo que separa "la edición no se pudo hacer" de "la factura quedó
  --      editada sin su ajuste de stock". Es la misma red que 039, 046 y 050
  --      pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.11 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --      `INVOICE_SELECT`, y los conteos que el llamador contrasta: sin una
  --      segunda lectura y sin su ventana.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_payments`,
-- `products` e `inventory_movements`; con search_path mutable un esquema
-- anterior en la ruta podría secuestrar esos nombres. House style desde 018 (y
-- el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems de una factura emitida
-- —y con ellos las comisiones de la nómina— y mover su stock por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) IS
'CL-12: edición ADMIN de factura ATÓMICA, con el total INMUTABLE. Reemplaza los ítems (borra los que se quitaron, actualiza los que cambian, inserta los nuevos), pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización de la edición de la 038 y también el del dinero de esa factura: la anulación y el cobro de la 050 toman el MISMO lock) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el diff de ítems (con el subtotal de cada línea), el delta de stock, su tipo y el motivo del kardex llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y la aritmética de dinero no aparece en esta función —no tiene una sola sentencia que escriba subtotal, discount, tax, surcharge ni total: la inmutabilidad del total de esta edición es ESTRUCTURAL, no una promesa del llamador—. MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila, y su mensaje de negocio es el mismo que devolvía el compare-and-swap del cliente. Sus redes de conteo abortan con EDIT_CONFLICT (la fila ya no está en la versión o el estado leídos), ITEM_MISMATCH (no borró, actualizó o insertó exactamente los ítems recibidos), PAYMENT_MISMATCH (no pisó exactamente los cobros recibidos) o PRODUCT_NOT_FOUND (no escribió exactamente los movimientos pedidos); en todos los casos la transacción se revierte COMPLETA: no queda una edición a medias con el token avanzado, y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.6 ----
-- invoice_edit_emitted_atomic (071, que a su vez trae 051)
--
-- La edición LIBRE: los mismos ocho grupos que la admin más el reemplazo del
-- snapshot de impuestos. Los cambios son los mismos dos que en la admin —la
-- lista de columnas del `INSERT` de movimientos y la clave `sede_id` de la
-- factura anidada—, porque los cuerpos difieren sólo en el grupo 1.
CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_items jsonb;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
  v_items_escritos integer := 0;
  v_movimientos integer;
BEGIN
  -- 5.1 FORMA de la entrada: lo mismo que la admin, más los tres grupos de esta
  --     edición. `totals` tiene que ser un OBJETO (los cinco números juntos: un
  --     total suelto no es un juego de totales) y los tres números de dinero con
  --     la forma que la tabla puede guardar.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_edit IS NULL
     OR jsonb_typeof(p_edit) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF jsonb_typeof(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_update', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'payments', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'movements', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'taxes', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'totals', 'null'::jsonb)) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los cinco números de la factura: subtotal, descuento, impuestos,
  --     recargo y total, todos escritos por el servicio y todos con la forma de
  --     una columna de dinero (dos decimales como máximo). Acá NO se comprueba la
  --     identidad `total = subtotal − discount + tax + surcharge`: esa es la
  --     aritmética de dinero del servicio, y su guarda es el CHECK de la tabla
  --     (005/019), que la comprueba sobre el número ya escrito.
  IF coalesce(p_edit -> 'totals' ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'tax', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'surcharge', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Las filas del snapshot NUEVO de impuestos: el snapshot inmutable de la
  --     FAC-03, con su código, su nombre, su porcentaje (0 a 100) y su monto ya
  --     calculado. La función no calcula el monto: lo escribe.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'taxes', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'tax_code', '')) = ''
       OR btrim(coalesce(item ->> 'tax_name', '')) = ''
       OR coalesce(item ->> 'percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR CASE
            WHEN coalesce(item ->> 'percent', '') ~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
              THEN (item ->> 'percent')::numeric > 100
            ELSE NULL
          END
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  v_items := coalesce(p_edit -> 'items_update', '[]'::jsonb)
             || coalesce(p_edit -> 'items_insert', '[]'::jsonb);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(jsonb_typeof(item -> 'no_commission'), '') <> 'boolean'
       OR (coalesce(item ->> 'product_id', '') <> ''
           AND coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'service_id', '') <> ''
           AND coalesce(item ->> 'service_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (item ->> 'commission_value' IS NOT NULL
           AND (item ->> 'commission_value') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item ->> 'commission_percent_override' IS NOT NULL
           AND (item ->> 'commission_percent_override') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
    WHERE coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'type', '') NOT IN ('IN', 'OUT')
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR btrim(coalesce(item ->> 'reason', '')) = ''
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  -- 5.2 La FACTURA, bloqueada, y su precondición RELEÍDA DE LA FILA: el MISMO
  --     candado de la 038 (versión + estado) que la edición admin, por el MISMO
  --     motivo y con el MISMO código de rechazo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  IF v_factura.edit_version <> p_expected_version
     OR v_factura.status <> p_expected_status
  THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 5.3 El grupo 1: la FACTURA, con el token Y los totales en UNA sentencia. Los
  --     cinco números llegan computados (`computeInvoiceTotals` + `round2` en
  --     TypeScript) y se escriben VERBATIM: acá no se suma un impuesto, no se
  --     aplica un descuento y no se recalcula el recargo EMITIDO que el servicio
  --     conserva. El `WHERE` conserva el candado de la 038 y su red de conteo.
  UPDATE public.invoices i
     SET edit_version = p_expected_version + 1,
         subtotal = (p_edit -> 'totals' ->> 'subtotal')::numeric,
         discount = (p_edit -> 'totals' ->> 'discount')::numeric,
         tax = (p_edit -> 'totals' ->> 'tax')::numeric,
         surcharge = (p_edit -> 'totals' ->> 'surcharge')::numeric,
         total = (p_edit -> 'totals' ->> 'total')::numeric
   WHERE i.id = p_invoice_id
     AND i.edit_version = p_expected_version
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 5.4 El grupo 2: se QUITA el snapshot de impuestos que el servicio LEYÓ, por
  --     id y por factura, en UNA sentencia y con su cuenta. Es la PRIMERA mitad
  --     del reemplazo del snapshot: la segunda (5.5) inserta el nuevo. Si la
  --     segunda falla, esta se revierte con ella —la colección ANTERIOR queda
  --     entera—, que es lo que significa todo-o-nada en un reemplazo.
  SELECT jsonb_array_length(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_taxes t
   WHERE t.invoice_id = p_invoice_id
     AND t.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 5.5 El grupo 3: el snapshot NUEVO, en UNA sentencia, con el monto ya
  --     computado y el porcentaje y el nombre que el servicio tomó de los
  --     impuestos ACTIVOS (FAC-03: el snapshot es inmutable y no sigue al
  --     catálogo). Se corre SIEMPRE, aunque el arreglo venga vacío: así el
  --     grupo tiene una red de conteo uniforme (0 = 0) y no hay dos caminos.
  SELECT jsonb_array_length(coalesce(p_edit -> 'taxes', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    p_invoice_id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'taxes', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 5.6 El grupo 4: los ítems que se QUITAN (las MISMAS tres sentencias de la
  --     edición admin, con las mismas columnas y las mismas cuentas).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_items d
   WHERE d.invoice_id = p_invoice_id
     AND d.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.7 El grupo 5: los ítems que CAMBIAN.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_update', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_items d
     SET item_type = item ->> 'item_type',
         product_id = CASE
                        WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
                        ELSE (item ->> 'product_id')::uuid
                      END,
         service_id = CASE
                        WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
                        ELSE (item ->> 'service_id')::uuid
                      END,
         custom_name = item ->> 'custom_name',
         employee_id = (item ->> 'employee_id')::uuid,
         qty = (item ->> 'qty')::integer,
         unit_price = (item ->> 'unit_price')::numeric,
         discount = (item ->> 'discount')::numeric,
         no_commission = (item ->> 'no_commission')::boolean,
         commission_value = CASE
                              WHEN item ->> 'commission_value' IS NULL THEN NULL
                              ELSE (item ->> 'commission_value')::numeric
                            END,
         commission_mode = item ->> 'commission_mode',
         commission_percent_override = CASE
                              WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
                              ELSE (item ->> 'commission_percent_override')::numeric
                            END,
         subtotal = (item ->> 'subtotal')::numeric
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
   WHERE d.id = (item ->> 'id')::uuid
     AND d.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.8 El grupo 6: los ítems que se AGREGAN. Las MISMAS columnas que el UPDATE
  --     de 5.7, columna por columna.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_insert', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    p_invoice_id,
    item ->> 'item_type',
    CASE
      WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
      ELSE (item ->> 'product_id')::uuid
    END,
    CASE
      WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
      ELSE (item ->> 'service_id')::uuid
    END,
    item ->> 'custom_name',
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    CASE
      WHEN item ->> 'commission_value' IS NULL THEN NULL
      ELSE (item ->> 'commission_value')::numeric
    END,
    item ->> 'commission_mode',
    CASE
      WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
      ELSE (item ->> 'commission_percent_override')::numeric
    END,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.9 El grupo 7: los COBROS (el método, nunca el monto).
  SELECT jsonb_array_length(coalesce(p_edit -> 'payments', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_payments pay
     SET method_code = item ->> 'method_code',
         method_id = CASE
                       WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
                       ELSE (item ->> 'method_id')::uuid
                     END
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
   WHERE pay.id = (item ->> 'id')::uuid
     AND pay.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 5.10 El grupo 8: el ajuste de STOCK, idéntico al de la edición admin (una
  --      sentencia, `ORDER BY p.id`, la marca en NULL y la red de conteo).
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 5.11 La factura ESCRITA (con sus totales nuevos) y los conteos.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems, los TOTALES y los impuestos
-- de una factura emitida —salteando el estado terminal, el candado de nómina y
-- las comisiones— por PostgREST. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) IS
'CL-12: edición LIBRE de una factura emitida, ATÓMICA, con el total RECALCULADO. Reemplaza los ítems, REEMPLAZA el snapshot de impuestos (borra el que el servicio leyó e inserta el que computó), reescribe los cinco números de la factura, pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (el punto de serialización de la edición de la 038 y el del dinero de esa factura, el MISMO lock que toman la anulación y el cobro de la 050) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: los totales y el snapshot llegan computados por computeInvoiceTotals/snapshotInvoiceTaxes, el diff de ítems con su subtotal por computeLineSubtotal, y el delta de stock con su tipo y su motivo, todos en TypeScript y escritos verbatim; acá no hay una sola suma, resta, multiplicación ni redondeo, ni una operación sobre las columnas de dinero (escribir es convertir la representación). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004). MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila. El REEMPLAZO del snapshot de impuestos es todo-o-nada: si el INSERT del snapshot nuevo falla, el DELETE del viejo se revierte con la transacción entera y la factura conserva su snapshot ANTERIOR completo (el estado intermedio —sin impuestos— no es ninguna de las dos colecciones). Sus redes de conteo abortan con EDIT_CONFLICT (versión o estado movidos), TAX_MISMATCH (no borró o insertó exactamente el snapshot recibido), ITEM_MISMATCH, PAYMENT_MISMATCH o PRODUCT_NOT_FOUND; en todos los casos la transacción se revierte COMPLETA y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.7 ----
-- invoice_create_atomic (071, que a su vez trae 060 y 052)
--
-- La emisión. Es la función donde la columna aparecía en más lugares y la
-- única cuyo cuerpo pierde un ARGUMENTO de una llamada a otra: `next_invoice_number`
-- deja de recibir la sede del turno bloqueado (sección 3.13) y
-- `deduct_stock_atomic` deja de recibirla también. El `FOR UPDATE` del turno se
-- queda —de él dependen el `SHIFT_NOT_OPEN`, la reserva del consecutivo y el
-- cierre concurrente—, las cinco redes de conteo se quedan y las ocho columnas de
-- la factura escrita se quedan.
CREATE OR REPLACE FUNCTION public.invoice_create_atomic(
  p_user_id uuid,
  p_cash_shift_id uuid,
  p_idempotency_key text,
  p_invoice jsonb,
  p_items jsonb,
  p_taxes jsonb,
  p_payments jsonb,
  p_out_reason text,
  p_out_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_consecutivo integer;
  v_turno_estado text;
  v_motivo text;
  v_esperados integer;
  v_escritos integer;
  v_aplicados integer;
  v_factura public.invoices;
BEGIN
  -- 1.1 FORMA de los escalares. Una función que emite una factura —y descuenta
  --     stock— no puede aceptar una entrada a medio formar: el precio de un
  --     rechazo claro acá es infinitamente menor que el de una emisión
  --     interpretada. La marca tiene que tener la MISMA forma que exige el CHECK
  --     de 041 (el `coalesce` es la parte que importa: con la clave AUSENTE el
  --     `!~` compara contra NULL —no TRUE— y sin el coalesce una marca vacía
  --     pasaría esta guarda).
  IF p_user_id IS NULL
     OR p_cash_shift_id IS NULL
     OR p_idempotency_key IS NULL
     OR p_idempotency_key
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_invoice IS NULL
     OR jsonb_typeof(p_invoice) <> 'object'
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR p_taxes IS NULL
     OR jsonb_typeof(p_taxes) <> 'array'
     OR p_payments IS NULL
     OR jsonb_typeof(p_payments) <> 'array'
     OR p_out_items IS NULL
     OR jsonb_typeof(p_out_items) <> 'array'
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.2 FORMA de la FACTURA: los cinco montos (los computa
  --     `computeInvoiceTotals`), el estado y la coherencia del cierre. Los montos
  --     viajan como TEXTOS de números y el `::numeric` de abajo es una conversión
  --     de representación: acá sólo se COMPRUEBA la forma (hasta 9 dígitos y 2
  --     decimales, la misma forma que 050 y 051 aceptan), nunca el valor.
  IF coalesce(p_invoice ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'tax', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'surcharge', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'status', '') NOT IN ('Emitida', 'Pagada')
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  --     El CIERRE va con el estado y sólo con él: una factura `Pagada` nace
  --     cerrada (con su responsable y el instante que resolvió el servicio) y una
  --     `Emitida` no lleva cierre. La función no decide ninguna de las dos cosas;
  --     comprueba que el dato sea coherente para que una emisión a medio armar no
  --     entre a la base con un estado que la contradice.
  IF (
       p_invoice ->> 'status' = 'Pagada'
       AND (
         p_invoice ->> 'closed_at' IS NULL
         OR p_invoice ->> 'closed_by' IS NULL
         OR p_invoice ->> 'closed_by'
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
     )
     OR (
       p_invoice ->> 'status' = 'Emitida'
       AND (p_invoice ->> 'closed_at' IS NOT NULL OR p_invoice ->> 'closed_by' IS NOT NULL)
     )
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.3 FORMA de cada LÍNEA. `product_id`, `service_id`, `custom_name`,
  --     `commission_value` y `commission_percent_override` pueden venir
  --     AUSENTES o en null (una línea de servicio no lleva producto, una línea
  --     sin comisión no lleva valor), así que su comprobación es "vacío o con
  --     forma". El `CASE` garantiza que el cast a integer sólo se evalúe cuando
  --     el texto YA validó la forma (SQL no promete el orden de las condiciones
  --     del OR), y `no_commission` se comprueba contra los dos textos del
  --     booleano antes de castearlo.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (
         coalesce(item ->> 'product_id', '') <> ''
         AND coalesce(item ->> 'product_id', '')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       OR (
         coalesce(item ->> 'service_id', '') <> ''
         AND coalesce(item ->> 'service_id', '')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'no_commission', '') NOT IN ('true', 'false')
       OR coalesce(item ->> 'commission_mode', '') NOT IN ('comision', 'porcentaje', 'ninguna')
       OR (
         coalesce(item ->> 'commission_value', '') <> ''
         AND coalesce(item ->> 'commission_value', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       )
       OR (
         coalesce(item ->> 'commission_percent_override', '') <> ''
         AND coalesce(item ->> 'commission_percent_override', '')
               !~ '^([0-9]{1,2}|100)([.][0-9]{1,2})?$'
       )
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.4 FORMA del SNAPSHOT DE IMPUESTOS. El monto lo computa
  --     `snapshotInvoiceTaxes`; acá sólo se comprueba que venga con forma y que
  --     el nombre y el código no estén vacíos (viajan a `invoice_taxes`, que los
  --     exige NOT NULL).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_taxes) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'tax_code', '')) = ''
       OR btrim(coalesce(item ->> 'tax_name', '')) = ''
       OR coalesce(item ->> 'percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.5 FORMA de las PORCIONES. El bruto y el recargo los computa
  --     `computeCardFees`; el `method_id` puede venir AUSENTE o en null (el
  --     catálogo no siempre tiene id: 005 lo permite) pero su método es
  --     obligatorio.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_payments) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR (
         coalesce(item ->> 'method_id', '') <> ''
         AND coalesce(item ->> 'method_id', '')
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.6 FORMA del PLAN DE STOCK. La agregación por producto y la guarda de
  --     negocio las hizo `planStockDeduction` (TypeScript); acá sólo se comprueba
  --     la forma —un producto por fila, con cantidad positiva— porque la guarda
  --     completa (producto repetido, existencia) la hace `deduct_stock_atomic`
  --     (046) con su propio SQLSTATE.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_out_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  --     Y la PLANTILLA del motivo: si hay productos que descontar, tiene que
  --     venir y tiene que traer el token. Se comprueba ACÁ —antes de cualquier
  --     escritura— para que una plantilla mal armada rechace barato.
  IF jsonb_array_length(p_out_items) > 0
     AND (p_out_reason IS NULL OR strpos(p_out_reason, '{consecutivo}') = 0)
  THEN
    RAISE EXCEPTION 'OUT_REASON_INVALID';
  END IF;

  -- 1.7 LA PRECONDICIÓN DEL TURNO, sobre la fila BLOQUEADA. `FOR UPDATE` es el
  --     idioma de la casa para tomar un lock de fila (039, 040, 047, 048, 049):
  --     a partir de acá, un cierre de caja espera, y el turno no puede cerrarse
  --     entre la lectura que el servicio ya hizo y la escritura de la factura. El
  --     `SELECT` conserva el mismo `FOR UPDATE OF s` y con él el `NOT FOUND` que
  --     traduce SHIFT_NOT_OPEN: lo único que se fue es la segunda columna del
  --     `INTO`. El estado se relee de la FILA (no del dato que mandó el
  --     llamador).
  SELECT s.status
    INTO v_turno_estado
  FROM public.cash_shifts s
  WHERE s.id = p_cash_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND OR v_turno_estado <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN';
  END IF;

  -- 1.8 EL CONSECUTIVO, reservado ADENTRO: es la decisión central de este
  --     archivo. La autoridad es la de siempre (`next_invoice_number`, 005 y 072:
  --     bloquea la fila `invoice_sequence` de `system_settings` e incrementa
  --     `last_number`), pero ahora el incremento pertenece a ESTA transacción: si
  --     algo falla de acá en adelante, se revierte con ella y el número NO queda
  --     quemado. El costo está declarado en la cabecera de 052 (el lock se
  --     sostiene hasta el commit). La llamada ya no lleva la sede: desde 072 el
  --     parámetro de esa función no seleccionaba nada (sección 3.13).
  v_consecutivo := public.next_invoice_number();

  --     Y el motivo del OUT: la plantilla trae el token UNA vez y acá se
  --     sustituye la PRIMERA ocurrencia —`overlay` desde `strpos`, no `replace`
  --     (que sustituiría todas y un nombre de cliente podría contener el
  --     token)— por el número que esta misma transacción acaba de reservar.
  IF jsonb_array_length(p_out_items) > 0 THEN
    v_motivo := overlay(
      p_out_reason
      placing v_consecutivo::text
      from strpos(p_out_reason, '{consecutivo}')
      for length('{consecutivo}')
    );
  END IF;

  -- 1.9 GRUPO 1: la FACTURA, con el consecutivo reservado y la marca del
  --     intento escritos VERBATIM. Nada se recalcula: cada monto llega computado
  --     y se escribe con su conversión de representación. La marca queda EN LA
  --     FILA: su índice único parcial (041) es la barrera final de la
  --     idempotencia, y acá se evalúa dentro de la MISMA transacción.
  INSERT INTO public.invoices
    (consecutive_number, idempotency_key, client_name, client_document,
     subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id,
     closed_by, closed_at)
  VALUES
    (v_consecutivo,
     p_idempotency_key,
     p_invoice ->> 'client_name',
     p_invoice ->> 'client_document',
     (p_invoice ->> 'subtotal')::numeric,
     (p_invoice ->> 'discount')::numeric,
     (p_invoice ->> 'tax')::numeric,
     (p_invoice ->> 'surcharge')::numeric,
     (p_invoice ->> 'total')::numeric,
     p_invoice ->> 'status',
     p_user_id,
     p_cash_shift_id,
     (p_invoice ->> 'closed_by')::uuid,
     (p_invoice ->> 'closed_at')::timestamptz)
  RETURNING * INTO v_factura;

  -- 1.10 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --      escrita. Cero filas es una emisión que no se aplicó: la transacción
  --      entera aborta —con la reserva del consecutivo— y el llamador recibe un
  --      fallo real en vez de una factura que no está. El 23505 de los dos
  --      índices únicos no llega hasta acá (la sentencia falla antes), y lo
  --      traduce el servicio (ver "EL 23505" de 052).
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'INVOICE_MISMATCH';
  END IF;

  -- 1.11 GRUPO 2: las LÍNEAS, UNA sentencia para todas. Una línea por elemento
  --      de `p_items`, con su subtotal y sus campos de comisión escritos
  --      VERBATIM: el `::integer`, el `::numeric`, el `::boolean` y el `::uuid`
  --      son conversiones de representación (jsonb → la columna), no
  --      operaciones. `nullif(… , '')` convierte la clave ausente en NULL, que es
  --      lo que el servicio mandaba para una línea sin producto/servicio/valor.
  --
  -- 1.12 Red de seguridad: tantas líneas como elementos llegaron. Sin esta red,
  --      un subconjunto silencioso dejaría una factura con su total completo y
  --      sin todas sus líneas (y la nómina pagando comisiones de menos). El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    v_factura.id,
    item ->> 'item_type',
    nullif(item ->> 'product_id', '')::uuid,
    nullif(item ->> 'service_id', '')::uuid,
    nullif(item ->> 'custom_name', ''),
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    nullif(item ->> 'commission_value', '')::numeric,
    item ->> 'commission_mode',
    nullif(item ->> 'commission_percent_override', '')::numeric,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  -- 1.13 GRUPO 3: el SNAPSHOT DE IMPUESTOS, UNA sentencia (y ninguna fila
  --      cuando no hay impuestos activos: `0 = 0` es legal). El monto y el
  --      porcentaje vienen computados.
  --
  -- 1.14 Red de seguridad: tantos impuestos como llegaron. El conteo va ANTES
  --      del INSERT: un `SELECT ... INTO` posterior pisaría el `ROW_COUNT` que
  --      mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_taxes) INTO v_esperados;

  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    v_factura.id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_taxes) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 1.15 GRUPO 4: las PORCIONES, UNA sentencia (y ninguna fila para una factura
  --      sin cobro: `0 = 0` es legal). El bruto, el porcentaje y el monto del
  --      recargo vienen computados por `computeCardFees`; `cash_shift_id` es el
  --      MISMO en todas y por eso viaja como escalar en la firma: la función
  --      escribe el valor en cada fila, sin decidir nada.
  --
  --      El ORDEN de las porciones se conserva (no hay `ORDER BY`, a
  --      propósito): pertenecen a una transacción que ya tiene el lock de su
  --      turno y de su factura, y nadie puede verlas antes del commit.
  --
  -- 1.16 Red de seguridad: tantas porciones como llegaron. El tope de cobro de
  --      031 (`trg_invoice_payments_cap`) corre dentro de esta sentencia con su
  --      propio P0001, y el servicio lo traduce a OVERPAID como siempre. El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_payments) INTO v_esperados;

  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id)
  SELECT
    v_factura.id,
    nullif(item ->> 'method_id', '')::uuid,
    item ->> 'method_code',
    (item ->> 'amount')::numeric,
    (item ->> 'fee_percent')::numeric,
    (item ->> 'fee_amount')::numeric,
    p_cash_shift_id
  FROM jsonb_array_elements(p_payments) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.17 GRUPO 5: el OUT de STOCK, en la MISMA transacción que las filas. La
  --      escritura la hace `deduct_stock_atomic` (046), que es la autoridad de la
  --      deducción: un movimiento por producto, con su motivo, SIN marca de
  --      intento (la emisión no tiene intento por producto: su puerta es la marca
  --      de la FACTURA), con sus propias guardas y sus propias redes, y con el
  --      orden de locks que fija (`ORDER BY p.id`, el orden del trigger de 004).
  --      El grupo vacío es legal y no se llama: una venta de servicios no toca el
  --      stock (y 046 rechaza el arreglo vacío a propósito, porque una deducción
  --      sin ítems no es una deducción).
  SELECT jsonb_array_length(p_out_items) INTO v_esperados;

  IF v_esperados > 0 THEN
    v_aplicados := public.deduct_stock_atomic(p_user_id, v_motivo, p_out_items);

    --     Red de seguridad sobre la RESPUESTA: la función ya revierte si
    --     escribió menos de lo pedido, así que un conteo distinto sólo puede
    --     venir de una respuesta incoherente. Se reporta como fallo real en vez
    --     de dar por aplicado un descuento que la base no hizo.
    IF v_aplicados <> v_esperados THEN
      RAISE EXCEPTION 'MOVEMENT_MISMATCH';
    END IF;
  END IF;

  -- 1.18 La FACTURA ESCRITA, con las MISMAS columnas de `INVOICE_SELECT` (el
  --      servicio no necesita otra lectura para tener la fila, y no hay ventana
  --      entre la escritura y la lectura del resultado). Se listan una por una, a
  --      propósito: `to_jsonb(v_factura)` agregaría `updated_at`, que el servicio
  --      nunca leyó.
  RETURN jsonb_build_object(
    'id', v_factura.id,
    'consecutive_number', v_factura.consecutive_number,
    'client_name', v_factura.client_name,
    'client_document', v_factura.client_document,
    'subtotal', v_factura.subtotal,
    'discount', v_factura.discount,
    'tax', v_factura.tax,
    'surcharge', v_factura.surcharge,
    'total', v_factura.total,
    'status', v_factura.status,
    'user_id', v_factura.user_id,
    'cash_shift_id', v_factura.cash_shift_id,
    'closed_by', v_factura.closed_by,
    'closed_at', v_factura.closed_at,
    'cancel_reason', v_factura.cancel_reason,
    'created_at', v_factura.created_at,
    'edit_version', v_factura.edit_version
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `cash_shifts` y `system_settings` (esta última dentro de
-- `next_invoice_number`); con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018 (y el mismo paso que da
-- 039).
ALTER FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría EMITIR facturas por PostgREST —cobrar, descontar
-- stock, quemar consecutivos y cerrar el turno que quisiera—. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) IS
'CL-13: la EMISIÓN de una factura, ATÓMICA. Reserva el consecutivo (next_invoice_number, 005 y 072), escribe la factura, sus líneas, su snapshot de impuestos, sus porciones y el OUT de stock (deduct_stock_atomic, 046) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con las precondiciones recomprobadas sobre la fila bloqueada (el turno de caja abierto, con FOR UPDATE). El servicio computa TODO —subtotales, impuestos, recargos, totales, estado, plan de stock y el motivo del OUT como plantilla— y la función sólo escribe lo que recibe: no hay una sola expresión aritmética sobre una columna de dinero. Un fallo de cualquier grupo revierte la emisión COMPLETA, incluida la reserva del consecutivo: no queda residuo parcial y no se quema ningún número, así que NO hay compensación (cleanupFailedInvoice se elimina con 052). Rechaza con INVOICE_INVALID (entrada mal formada), OUT_REASON_INVALID (la plantilla del motivo no trae su token), SHIFT_NOT_OPEN (el turno se cerró en la ventana), INVOICE_MISMATCH / ITEM_MISMATCH / TAX_MISMATCH / PAYMENT_MISMATCH / MOVEMENT_MISMATCH (las redes de conteo) y lo que levanten 005/031/041/046 (23505, el tope de cobro, INSUFFICIENT_STOCK, PRODUCT_NOT_FOUND). La instalación es de una sola sede (071): la función no recibe ni escribe la sede, el turno bloqueado ya no la nombra y ni el consecutivo ni el stock la necesitan (077). Devuelve la factura escrita con las columnas de INVOICE_SELECT. El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y el consecutivo lo sigue asignando EXCLUSIVAMENTE next_invoice_number (005/072). Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.8 ----
-- invoice_split_payment_atomic (071, que a su vez trae 056 y 050)
--
-- El cobro dividido. El único rastro de la columna era la clave `sede_id` de la
-- factura anidada del `jsonb`; el resto —el `FOR SHARE` del turno, el `FOR
-- UPDATE` de la factura, la revalidación de estado, la marca única de la 042 y la
-- red de conteo— no la nombraba y queda igual.
CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic(
  p_invoice_id uuid,
  p_shift_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_mark_paid boolean,
  p_portions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_turno public.cash_shifts;
  v_esperados integer;
  v_escritos integer;
  v_marcadas integer;
  v_actualizados integer;
BEGIN
  -- 5.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. El turno también tiene que venir (es el punto de
  --     serialización nuevo), la decisión del cierre tiene que venir (NULL no es
  --     una decisión) y las porciones no pueden venir vacías —un cobro sin
  --     porciones no es un cobro—.
  IF p_invoice_id IS NULL
     OR p_shift_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_mark_paid IS NULL
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  IF p_portions IS NULL
     OR jsonb_typeof(p_portions) <> 'array'
     OR jsonb_array_length(p_portions) = 0
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Cada porción: método con código (el snapshot que la tabla exige), monto
  --     y recargo con la forma que la tabla puede guardar, porcentaje de recargo,
  --     y el turno y la marca como uuid o ausentes. El `coalesce` es la misma
  --     trampa que documentan 046–053. El `CASE` vuelve a garantizar que cada
  --     cast sólo se evalúe cuando el texto ya validó su forma.
  --
  --     `method_id` y `idempotency_key` son OPCIONALES (la columna admite NULL:
  --     005 para el método, 042 para la marca); `cash_shift_id` también lo es a
  --     nivel de columna (023), pero el cobro SIEMPRE pertenece al turno abierto
  --     y el servicio lo informa: acá se exige.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'cash_shift_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'idempotency_key', '') <> ''
           AND coalesce(item ->> 'idempotency_key', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Y la forma de la MARCA de la 042, que es una premisa y no un detalle: la
  --     marca vive SÓLO en la primera porción, porque una marca única sobre una
  --     operación de varias filas es lo que hace sonoro el índice único parcial
  --     (`uq_invoice_payments_invoice_idempotency_key`). El servicio ya la manda
  --     así; acá se exige, para que un llamador nuevo no pueda romper la premisa
  --     y convertir una operación legítima en un 23505.
  SELECT count(*) INTO v_marcadas
  FROM jsonb_array_elements(p_portions) AS item
  WHERE coalesce(item ->> 'idempotency_key', '') <> '';

  IF v_marcadas > 1 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Y la premisa NUEVA de 056: TODAS las porciones pertenecen al TURNO que
  --     la operación bloquea. Sin esta guarda, una porción podría referenciar
  --     otro turno —posiblemente uno que se está cerrando— y la fila de dinero
  --     caería en un turno que la transacción NO bloqueó ni revalidó, que es
  --     exactamente el hueco (b). La comparación corre DESPUÉS de la guarda de
  --     forma de arriba, así que cada `cash_shift_id` ya validó su forma de uuid.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE (item ->> 'cash_shift_id')::uuid <> p_shift_id
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  -- 5.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila y NO compite con otro cobro del mismo turno. El estado se
  --     mira DESPUÉS del lock y sobre LA FILA.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR SHARE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_CLOSED';
  END IF;

  -- 5.3 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA.
  --     Una factura Anulada no admite cobros —el servicio ya lo rechaza antes
  --     (`ANNUL_INVALID`), y acá se vuelve a comprobar porque entre su lectura y
  --     esta escritura cabe una anulación—. El lock, además, es lo que serializa
  --     dos cobros de la misma factura: el tope de 031 toma el MISMO lock al
  --     insertar cada porción, así que el segundo espera y después evalúa su
  --     tope contra lo que el primero dejó.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  IF v_factura.status = 'Anulada' THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 5.4 El grupo 1: las PORCIONES, UNA sentencia multi-fila y cada columna
  --     escrita VERBATIM desde `p_portions` (el `::numeric` y el `::uuid` son
  --     conversiones de representación, no operaciones). La fila de identidad de
  --     la 042 —la única con marca— es la que el servicio decidió: por eso el
  --     INSERT NO lleva `ORDER BY`.
  SELECT jsonb_array_length(p_portions) INTO v_esperados;

  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount,
     cash_shift_id, idempotency_key)
  SELECT
    p_invoice_id,
    CASE
      WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
      ELSE (item ->> 'method_id')::uuid
    END,
    item ->> 'method_code',
    (item ->> 'amount')::numeric,
    (item ->> 'fee_percent')::numeric,
    (item ->> 'fee_amount')::numeric,
    (item ->> 'cash_shift_id')::uuid,
    CASE
      WHEN coalesce(item ->> 'idempotency_key', '') = '' THEN NULL
      ELSE (item ->> 'idempotency_key')::uuid
    END
  FROM jsonb_array_elements(p_portions) AS item;

  -- 5.5 Red de seguridad DENTRO de la transacción: exactamente las porciones
  --     recibidas. Sin ella, un subconjunto silencioso dejaría el cobro
  --     incompleto con la factura ya cerrada por el grupo de abajo. El tope de
  --     031 y el índice de la 042 abortan ANTES de llegar acá (su error se
  --     propaga tal cual, con su SQLSTATE, para que el servicio lo traduzca como
  --     ya lo traducía).
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 5.6 El grupo 2: el CIERRE de la factura, SÓLO si el servicio lo decidió
  --     (`p_mark_paid`). Acá no se compara el cobrado contra el facturado —eso es
  --     `invoiceNetBalance` + `moneyEquals` en TypeScript— y no se recalcula
  --     ningún monto: la fila cambia de estado, con su responsable
  --     (`p_user_id`, un DATO) y su instante (`p_closed_at`, el que resolvió el
  --     servicio). Este camino YA escribía los dos campos; la 056 no los cambia.
  IF p_mark_paid THEN
    UPDATE public.invoices i
       SET status = 'Pagada',
           closed_by = p_user_id,
           closed_at = p_closed_at
     WHERE i.id = p_invoice_id
    RETURNING * INTO v_factura;

    -- 5.7 La segunda red: exactamente UNA factura cerrada. Cero filas aborta la
    --     operación ENTERA —las porciones incluidas—, que es lo que impide que
    --     quede dinero cobrado con la factura abierta (o cerrada sin sus
    --     porciones). La fila está bloqueada desde 5.3, así que este caso es una
    --     invariante rota, no una carrera: se rechaza ruidosamente.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 5.8 La factura ESCRITA (con el estado que quedó) y cuántas porciones se
  --     escribieron, para el contraste del llamador. Devolverla evita una
  --     segunda lectura y su ventana. La FORMA de la respuesta no cambia.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'portions', v_escritos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments` y `cash_shifts` (nuevo: el
-- turno se bloquea acá); con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018.
ALTER FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura y cerrarla por PostgREST, con
-- los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) IS
'CL-11/CL-17: cobro dividido ATÓMICO (FAC-07), con el TURNO bloqueado. Inserta las porciones de invoice_payments —el dinero que entra, con la marca del intento de la 042 sólo en la primera— y, si el servicio decidió que la factura queda Pagada, la cierra con sus datos de cierre (closed_by = p_user_id y closed_at = p_closed_at, los dos DATOS), todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir sus porciones en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. Exige además que TODAS las porciones pertenezcan a ese turno (cash_shift_id = p_shift_id), para que el lock cubra exactamente las filas que se van a escribir. NO calcula nada: el reparto por método (neto, porcentaje, recargo, bruto) llega computado por computeCardFees y la decisión Pagada llega como p_mark_paid (invoiceNetBalance + moneyEquals, TypeScript); la función escribe cada columna verbatim y no compara el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE. Su red de conteo aborta con PAYMENT_MISMATCH si no escribió exactamente las porciones recibidas o si no cerró exactamente una factura; en los dos casos la transacción se revierte COMPLETA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus porciones, y el reintento sigue siendo posible. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y la factura que devuelve ya no la nombra (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y el número de porciones. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 3.9 ----
-- cash_invoice_payment_atomic (071, que a su vez trae 056 y 053)
--
-- El cobro desde caja. Dos rastros de la columna: la lista de columnas del
-- `INSERT` del libro de cajón —que tomaba la del turno bloqueado con `FOR
-- SHARE`— y la clave `sede_id` de la fila de `payments` que la función devuelve.
-- El `FOR SHARE` del turno se queda: es el punto de serialización contra el
-- cierre, y el `NOT FOUND`/`SHIFT_CLOSED` se leen sobre la MISMA fila.
CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic(
  p_shift_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_set_shift boolean,
  p_mark_paid boolean,
  p_collection jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_turno public.cash_shifts;
  v_pago public.payments;
  v_method_id uuid;
  v_escritos integer;
  v_actualizados integer;
BEGIN
  -- 1.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. El tipo `uuid` de los cuatro identificadores los
  --     valida la propia firma, `p_closed_at` tiene que venir —el instante del
  --     cierre es un DATO, y NULL no es un instante— y `p_set_shift`/`p_mark_paid`
  --     no aceptan NULL (NULL no es una decisión).
  IF p_shift_id IS NULL
     OR p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_set_shift IS NULL
     OR p_mark_paid IS NULL
     OR p_collection IS NULL
     OR jsonb_typeof(p_collection) <> 'object'
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     El cobro: método con código (el snapshot que la tabla exige), monto y
  --     recargo con la forma que la tabla puede guardar, porcentaje de recargo, y
  --     la marca del intento. El `coalesce` es la misma trampa que documentan
  --     046–053: con la clave AUSENTE, `p_collection ->> 'amount'` es NULL y
  --     `NULL !~ 'regex'` es NULL —no TRUE—, así que sin el coalesce una entrada
  --     sin monto pasaría esta guarda y sería el NOT NULL de la columna el que
  --     hablara, con un error de la base en vez de un rechazo del contrato.
  --
  --     La MARCA NO ES OPCIONAL acá, a diferencia de las porciones de 050 (donde
  --     vive sólo en la primera): este camino escribe UNA sola fila en
  --     `invoice_payments` y esa fila ES la operación, así que un cobro sin marca
  --     sería un cobro sin identidad. La firma del índice único parcial (042)
  --     depende de esa premisa.
  IF btrim(coalesce(p_collection ->> 'method_code', '')) = ''
     OR coalesce(p_collection ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'idempotency_key', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (coalesce(p_collection ->> 'method_id', '') <> ''
         AND coalesce(p_collection ->> 'method_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     El método, resuelto UNA vez para las dos filas del dinero. El `CASE`
  --     garantiza que el cast a uuid sólo se evalúe cuando el texto YA validó la
  --     forma (SQL no promete el orden de las condiciones del OR).
  v_method_id := CASE
    WHEN coalesce(p_collection ->> 'method_id', '') = '' THEN NULL
    ELSE (p_collection ->> 'method_id')::uuid
  END;

  -- 1.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila —así un cierre que llegó primero hace que esta lectura
  --     espere y después vea `cerrado`, y un cierre que llega después espera a
  --     este cobro— y NO compite con otro cobro del mismo turno (dos cajas
  --     cobrando facturas distintas en el mismo turno no se serializan entre sí).
  --     `FOR KEY SHARE` no serviría: es exactamente el lock que la FK toma hoy y
  --     el que NO excluye al cierre.
  --
  --     El estado se mira DESPUÉS del lock y sobre LA FILA (no sobre el dato que
  --     mandó el llamador): es la precondición que el servicio ya revisó, releída
  --     donde es verdadera. De ESTA fila salía además la sede del libro de cajón.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR SHARE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_CLOSED';
  END IF;

  -- 1.3 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047–053): es el punto de
  --     serialización del dinero de esa factura, y a partir de acá otro cobro
  --     —el tope de 031 toma ESTE MISMO lock— o una anulación (050) esperan.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     Una factura ANULADA no admite cobros: el servicio ya lo rechaza antes con
  --     este MISMO código, y acá se vuelve a comprobar sobre la fila bloqueada
  --     porque entre su lectura y esta escritura cabe una anulación.
  IF v_factura.status = 'Anulada' THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 1.4 El grupo 1: la fila ESPEJO (`invoice_payments`), con el turno que COBRA
  --     y con la marca del intento —la identidad de este camino (042)—. Cada
  --     columna se escribe VERBATIM desde `p_collection`: el `::numeric` y el
  --     `::uuid` son conversiones de representación, no operaciones. El `id` NO
  --     se escribe: lo pone el DEFAULT de 005 (`gen_random_uuid()`).
  --
  --     Adentro corren las dos barreras PREEXISTENTES de la base, con su
  --     SQLSTATE intacto: el tope de cobro de 031 (trigger BEFORE INSERT →
  --     P0001) y el índice único parcial de identidad de la 042 (23505).
  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount,
     cash_shift_id, idempotency_key)
  VALUES
    (p_invoice_id,
     v_method_id,
     p_collection ->> 'method_code',
     (p_collection ->> 'amount')::numeric,
     (p_collection ->> 'fee_percent')::numeric,
     (p_collection ->> 'fee_amount')::numeric,
     p_shift_id,
     (p_collection ->> 'idempotency_key')::uuid);

  -- 1.5 Red de seguridad DENTRO de la transacción: exactamente UNA fila espejo.
  --     Sin ella, un subconjunto silencioso dejaría el cobro sin su dinero en el
  --     ledger y con la factura ya cerrada por el grupo de abajo.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.6 El grupo 2: el LIBRO DE CAJÓN del turno (`payments`), con el turno que el
  --     servicio resolvió y el usuario que cobró —el único rastro de quién cobró
  --     (PRD §9.1)—. `idempotency_key` se escribe NULL A PROPÓSITO (043): la
  --     identidad de este camino vive en la fila espejo, y marcar las dos
  --     mezclaría en un mismo índice las marcas de dos caminos distintos.
  --     `created_at` no se toca: lo pone el DEFAULT de 006.
  INSERT INTO public.payments
    (cash_shift_id, invoice_id, method_id, method_code, amount, user_id,
     idempotency_key)
  VALUES
    (p_shift_id,
     p_invoice_id,
     v_method_id,
     p_collection ->> 'method_code',
     (p_collection ->> 'amount')::numeric,
     p_user_id,
     NULL)
  RETURNING * INTO v_pago;

  -- 1.7 La segunda red: exactamente UNA fila en el libro de cajón. Sin ella, el
  --     dinero podría quedar en el ledger de la factura y fuera del arqueo del
  --     turno (o al revés) con la factura ya cerrada.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.8 El grupo 3: el ESTADO de la factura, y SÓLO si el servicio lo decidió.
  --
  --     Acá no se compara el cobrado contra el facturado —eso es
  --     `invoiceNetBalance` + `moneyEquals` en TypeScript— y no se recalcula
  --     ningún monto: la fila cambia de turno y de estado con los datos del
  --     llamador.
  --
  --     `cash_shift_id` sólo se pisa si el servicio lo decidió (`p_set_shift`):
  --     una factura se enlaza al turno que la COBRA, y una que ya tenía turno
  --     conserva el suyo. `closed_by`/`closed_at` se escriben SÓLO cuando la
  --     factura se CIERRA (`p_mark_paid`) —Gap 1 de 056—: el responsable es el
  --     usuario que cobra (`p_user_id`) y el instante es el que resolvió el
  --     servicio (`p_closed_at`), los dos DATOS. El `CASE … ELSE i.<columna>` es
  --     una SELECCIÓN entre el dato y la columna que ya estaba (cuando el grupo
  --     corre sólo para enlazar el turno), no un cálculo.
  IF p_set_shift OR p_mark_paid THEN
    UPDATE public.invoices i
       SET cash_shift_id = CASE WHEN p_set_shift THEN p_shift_id ELSE i.cash_shift_id END,
           status = CASE WHEN p_mark_paid THEN 'Pagada' ELSE i.status END,
           closed_by = CASE WHEN p_mark_paid THEN p_user_id ELSE i.closed_by END,
           closed_at = CASE WHEN p_mark_paid THEN p_closed_at ELSE i.closed_at END
     WHERE i.id = p_invoice_id
    RETURNING * INTO v_factura;

    -- 1.9 La tercera red: exactamente UNA factura actualizada. Cero filas con el
    --     grupo corriendo es una invariante rota (la fila está bloqueada desde
    --     1.3): la operación entera aborta —el espejo y el libro de cajón
    --     incluidos—, que es exactamente lo que impide que quede dinero cobrado
    --     con la factura abierta.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 1.10 El resultado: la fila del LIBRO DE CAJÓN escrita (las MISMAS columnas de
  --      `PAYMENT_SELECT`, que es lo que el servicio devuelve) y el ESTADO que
  --      quedó la factura. Devolverlas evita una segunda lectura y su ventana. La
  --      FORMA de la respuesta no cambia; lo único que puede venir distinto es el
  --      estado (`Pagada`) acompañado, ahora sí, de sus datos de cierre en la
  --      base.
  RETURN jsonb_build_object(
    'payment', jsonb_build_object(
      'id', v_pago.id,
      'cash_shift_id', v_pago.cash_shift_id,
      'invoice_id', v_pago.invoice_id,
      'method_id', v_pago.method_id,
      'method_code', v_pago.method_code,
      'amount', v_pago.amount,
      'user_id', v_pago.user_id,
      'created_at', v_pago.created_at
    ),
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'status', v_factura.status
    )
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments`, `payments` y `cash_shifts`
-- (nuevo: el turno se bloquea acá); con search_path mutable un esquema anterior
-- en la ruta podría secuestrar esos nombres. House style desde 018 (y el mismo
-- paso que dan 039 y 046–053).
ALTER FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura desde la caja por PostgREST, con
-- los montos que quisiera y cerrando el turno que quisiera. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) IS
'CL-17: cobro de factura desde CAJA, ATÓMICO (CAJ-02), con el TURNO bloqueado y con los datos de cierre. Escribe las TRES cosas del cobro —la fila espejo de invoice_payments (el dinero que suma el arqueo, con el turno que COBRA y la marca del intento de 042), la fila del libro de cajón payments (sin marca, 043) y el estado de la factura— en UNA sentencia, y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request. NO calcula nada: el bruto redondeado (roundMoney), el reparto del recargo (splitGrossCardFee), el saldo (invoiceNetBalance), la cota del tope de 031, la decisión Pagada (moneyEquals), el enlace al turno y el instante del cierre (p_closed_at, resuelto por el servicio como en 049 y 050) llegan computados por el servicio, y la función escribe cada columna verbatim, sin sumar, restar, multiplicar ni redondear un solo monto y sin comparar el cobrado contra el facturado ni una vez. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir su fila de dinero en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. La fila del libro de cajón ya no lleva columna de sede: la instalación es de una sola sede (071) y el turno bloqueado era la fila que la definía (077). Revalida también la precondición de la factura sobre su fila bloqueada (Anulada → ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE (P0001 y 23505). Sus tres redes de conteo —una por grupo de escritura— abortan con PAYMENT_MISMATCH si no escribió exactamente lo recibido, y en ese caso la transacción se revierte ENTERA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus filas de dinero, y el reintento sigue siendo posible. CIERRA la factura con sus datos: cuando el servicio lo decidió (p_mark_paid), escribe status = Pagada y ADEMÁS closed_by (el usuario que cobra) y closed_at (el instante que resolvió el servicio), que era el hueco de CL-17: una factura Pagada con closed_at NULL contradecía el contrato de 025 y dejaba la columna Cerrada del listado en guion sobre una factura cerrada. La marca del intento es OBLIGATORIA (este camino escribe una sola fila en invoice_payments y esa fila es la operación). Devuelve la fila del libro de cajón escrita (columnas de PAYMENT_SELECT) y el estado que quedó la factura. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 3.10 ----
-- payroll_apply_atomic (067, que a su vez trae 047, 061 y 064)
--
-- La liquidación. Su firma NUNCA lleva `p_sede_id`: tomaba la sede del PERÍODO
-- que bloquea y la comparaba contra la del EMPLEADO en el `JOIN` de los tres
-- `INSERT` (1.4 ítems, 1.6 sobrante del vale, 1.8 sobrante de la deuda), y la
-- escribía en las dos tablas de deuda. Lo que sale son tres predicados de
-- `JOIN` y dos columnas de `INSERT`: con una sola sede, `e.sede_id = p.sede_id`
-- no podía ser falso y el filtro no acotaba nada.
--
-- Lo que NO sale es el filtro por EXISTENCIA del empleado —`JOIN public.employees
-- e ON e.id = (item ->> 'employee_id')::uuid`—, que sigue siendo la mitad de la
-- red de conteo: sin él, un empleado inexistente escribiría menos ítems en
-- silencio, y `PAYROLL_ITEM_MISMATCH` seguiría siendo la red que aborta. El
-- `ORDER BY e.id` —el orden determinista de los locks— también queda.
CREATE OR REPLACE FUNCTION public.payroll_apply_atomic(
  p_period_id uuid,
  p_items jsonb,
  p_voucher_ids uuid[],
  p_carry_ids uuid[] DEFAULT '{}'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_esperados integer;
  v_marcados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que escribe la nómina no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de un descuento interpretado.
  --     `p_items` puede venir VACÍO (una liquidación sin planta activa pero con
  --     vales que descontar es un caso legal), pero tiene que ser un ARREGLO.
  IF p_period_id IS NULL
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR p_voucher_ids IS NULL
     OR p_carry_ids IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada ítem tiene que ser un objeto, con el MISMO período que el
  --     llamador declaró, un `employee_id` con la forma del `CHECK` de 001/007 y
  --     las SEIS columnas de dinero como número no negativo de hasta 9 dígitos
  --     enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar—.
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item ->> 'net_pay'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así
  --     que sin el coalesce una entrada sin `net_pay` pasaría esta guarda y el
  --     `NOT NULL` de la columna sería el que hablara, con un error de la base
  --     en vez de un rechazo del contrato. Es la misma trampa que 046 documenta
  --     para `qty`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  --
  --     Acá NO hace falta el `CASE` que 046 usa: esta guarda sólo compara
  --     TEXTO contra una expresión regular, y la conversión a `numeric` ocurre
  --     después, en el INSERT (otra sentencia).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'period_id', '') <> p_period_id::text
       OR coalesce(item ->> 'base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR (item -> 'voucher_total' IS NOT NULL
           AND coalesce(item ->> 'voucher_total', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'voucher_excess' IS NOT NULL
           AND coalesce(item ->> 'voucher_excess', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'debt_remainder' IS NOT NULL
           AND coalesce(item ->> 'debt_remainder', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'adjustment_reason' IS NOT NULL
           AND jsonb_typeof(item -> 'adjustment_reason') <> 'null'
           AND (
             jsonb_typeof(item -> 'adjustment_reason') <> 'string'
             OR char_length(btrim(item ->> 'adjustment_reason')) < 1
             OR char_length(btrim(item ->> 'adjustment_reason')) > 200
           ))
       OR (item -> 'detail_json' IS NOT NULL AND jsonb_typeof(item -> 'detail_json') <> 'array')
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Un vale REPETIDO en el arreglo no es un vale dos veces: el arreglo es un
  --     CONJUNTO de ids, y un repetido no se puede marcar dos veces (el conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado). Un elemento
  --     NULL se rechaza por la misma puerta. Se valida en vez de confiar en que
  --     el llamador no repite.
  IF cardinality(p_voucher_ids) <> (
    SELECT count(DISTINCT id) FROM unnest(p_voucher_ids) AS id
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El FLIP de los vales: la transición única a `descontada` que el
  --     servicio ya hacía con su `UPDATE`, con la MISMA precondición de estado
  --     y con los locks en orden determinista (ver "SERIALIZACIÓN" arriba).
  --
  --     El bloqueo va PRIMERO y aparte: `PERFORM ... FOR UPDATE` es el idioma de
  --     la casa para tomar locks de fila (039, 040) y, con `ORDER BY` delante,
  --     bloquea en ese orden: dos cálculos con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo.
  --
  --     El `UPDATE` de abajo no necesita orden: sus filas ya las bloqueó este
  --     paso, en esta misma transacción, y volver a tocarlas no adquiere ningún
  --     lock nuevo.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.id = ANY (p_voucher_ids)
   ORDER BY v.id
     FOR UPDATE OF v;

  UPDATE public.voucher_requests v
     SET status = 'descontada'
   WHERE v.id = ANY (p_voucher_ids)
     AND v.status IN ('pendiente', 'aprobada');

  -- 1.3 Red de seguridad DENTRO de la transacción: si no se marcaron
  --     EXACTAMENTE los vales que se recibieron, se aborta y se revierte todo
  --     (los ítems incluidos). Un vale que ya no está `pendiente`/`aprobada` —lo
  --     descontó otro cálculo— escribe CERO filas: esta guarda convierte esa
  --     carrera silenciosa en un rechazo con rollback, en vez de dejar los
  --     ítems escritos sobre un descuento ajeno. Es la misma red que 046 y 039
  --     pusieron sobre su escritura.
  GET DIAGNOSTICS v_marcados = ROW_COUNT;

  IF v_marcados <> cardinality(p_voucher_ids) THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.4 La ESCRITURA de los ítems: UNA sentencia, y por eso UNA transacción
  --     con el flip de arriba. Todos los ítems entran con el período declarado
  --     y con los montos EXACTOS que el servicio calculó —acá no se suma, no se
  --     resta y no se recalcula nada—.
  --
  --     El `JOIN` filtra por la EXISTENCIA del empleado: un empleado inexistente
  --     escribiría menos filas en SILENCIO, y la guarda de conteo de abajo
  --     convierte ese subconjunto silencioso en un rechazo con rollback.
  --     `ORDER BY e.id` es el orden determinista de los locks de `payroll_items`
  --     (ver "SERIALIZACIÓN").
  --
  --     `ON CONFLICT (period_id, employee_id) DO UPDATE` es el upsert del
  --     servicio (`onConflict: "period_id,employee_id"`) traducido: recalcular
  --     el mismo período REEMPLAZA la fila del empleado, no la duplica. Las
  --     columnas que se pisan son exactamente las del payload y `updated_at`
  --     queda para su trigger. `voucher_total` entra por la misma puerta: el
  --     total real de vales también se refresca al recalcular.
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_items
    (period_id, employee_id, base_fixed, commissions, bonuses,
     deductions_vales, other_discounts, net_pay, detail_json, voucher_total,
     adjustment_reason)
  SELECT
    p_period_id,
    e.id,
    (item ->> 'base_fixed')::numeric,
    (item ->> 'commissions')::numeric,
    (item ->> 'bonuses')::numeric,
    (item ->> 'deductions_vales')::numeric,
    (item ->> 'other_discounts')::numeric,
    (item ->> 'net_pay')::numeric,
    coalesce(item -> 'detail_json', '[]'::jsonb),
    coalesce((item ->> 'voucher_total')::numeric, 0),
    (item ->> 'adjustment_reason')
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  ORDER BY e.id
  ON CONFLICT (period_id, employee_id) DO UPDATE
    SET base_fixed = EXCLUDED.base_fixed,
        commissions = EXCLUDED.commissions,
        bonuses = EXCLUDED.bonuses,
        deductions_vales = EXCLUDED.deductions_vales,
        other_discounts = EXCLUDED.other_discounts,
        net_pay = EXCLUDED.net_pay,
        detail_json = EXCLUDED.detail_json,
        voucher_total = EXCLUDED.voucher_total,
        adjustment_reason = EXCLUDED.adjustment_reason;

  -- 1.5 La segunda red: si se escribieron menos ítems de los pedidos —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, el flip incluido.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_ITEM_MISMATCH';
  END IF;

  -- 1.6 La DEUDA del sobrante del vale. Por cada ítem cuyo `voucher_excess` sea
  --     positivo se registra UNA fila en `payroll_discount_carries`: el sobrante
  --     que el período no pudo descontar, y el período como ORIGEN.
  --     `applied_period_id` nace NULL (PENDIENTE): acá no se aplica nada, sólo se
  --     registra de dónde salió el exceso.
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) hace que RECALCULAR el
  --     mismo período NO duplique la deuda: el upsert de 1.4 reemplaza el ítem y
  --     este paso reencuentra la fila existente en vez de insertar una segunda.
  --     El tipo entra en la clave (NV-02): el sobrante de la deuda de 1.8 tiene
  --     el MISMO origen y el MISMO empleado y no puede bloquear esta fila (ni al
  --     revés). La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (employee_id, amount, origin_period_id, origin_kind)
  SELECT
    e.id,
    (item ->> 'voucher_excess')::numeric,
    p_period_id,
    'voucher_excess'
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  WHERE coalesce((item ->> 'voucher_excess')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
        AND c.origin_kind = 'voucher_excess'
    )
  ORDER BY e.id;

  -- 1.7 La DEUDA ENTRANTE que este cálculo absorbe en `other_discounts` queda
  --     CONSUMIDA: `applied_period_id` se llena con el período que la aplicó.
  --     El descuento ya viajó en el ítem (1.4) y el registro del sobrante
  --     saliente (1.6) es otra fila: acá sólo se cierra la deuda que el
  --     servicio leyó como pendiente y sumó al descuento.
  --
  --     El `IS NULL` es la regla de una sola aplicación: una deuda ya consumida
  --     no se vuelve a marcar (replay no-op) y no vuelve a entrar al conjunto
  --     pendiente. NO se cuenta ni se aborta si se marcaron menos filas: a
  --     diferencia del flip de vales —donde marcar de menos es una carrera que
  --     hay que rechazar—, acá marcar de menos es exactamente el replay que
  --     debe ser silencioso. Los locks van en orden determinista, igual que los
  --     vales, para que dos cálculos con deudas solapadas no se bloqueen en
  --     ciclo.
  PERFORM 1
    FROM public.payroll_discount_carries c
   WHERE c.id = ANY (p_carry_ids)
   ORDER BY c.id
     FOR UPDATE OF c;

  UPDATE public.payroll_discount_carries c
     SET applied_period_id = p_period_id
   WHERE c.id = ANY (p_carry_ids)
     AND c.applied_period_id IS NULL;

  -- 1.8 El SOBRANTE DE LA DEUDA (NV-02). Cuando el tope no alcanzó a absorber
  --     toda la deuda entrante, el ítem trae en `debt_remainder` la parte que no
  --     entró a `other_discounts`. Esa parte NO se perdona: se registra como una
  --     fila PENDIENTE NUEVA con ESTE período como ORIGEN —así ningún cálculo de
  --     este período la vuelve a aplicar (el origen no es anterior a sí mismo) y
  --     sí la aplica cualquier período POSTERIOR— y con el tipo
  --     `'carry_remainder'`, que la distingue del sobrante del vale (1.6).
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) es la misma guarda de
  --     1.6: RECALCULAR el mismo período reencuentra la fila y no inserta una
  --     segunda. El descuento (1.4) y esta re-registración viven en la misma
  --     sentencia y por lo tanto en la MISMA transacción: si cualquiera de los
  --     dos falla, se revierten los dos y la deuda no se pierde ni se duplica.
  --     La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (employee_id, amount, origin_period_id, origin_kind)
  SELECT
    e.id,
    (item ->> 'debt_remainder')::numeric,
    p_period_id,
    'carry_remainder'
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  WHERE coalesce((item ->> 'debt_remainder')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
        AND c.origin_kind = 'carry_remainder'
    )
  ORDER BY e.id;

  RETURN v_escritos;
END;
$$;

-- -------------------------------------- 3.1 search_path fijo ---
-- La función resuelve `payroll_items`, `payroll_discount_carries`,
-- `voucher_requests`, `payroll_periods` y `employees`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. House style
-- desde 018 (y el mismo paso que dan 039 y 046).
ALTER FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) SET search_path = public;

-- ------------------------------------------------ 3.2 Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría escribir la nómina, marcar vales y consumir
-- deudas por PostgREST. El único llamador legítimo es el cliente service_role
-- del servidor. `CREATE OR REPLACE` conserva el ACL, pero el bloque se repite:
-- es barato, idempotente y deja el archivo válido también sobre una base donde
-- la función no existiera.
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) TO service_role;

-- ------------------------------------------- 3.3 Documentación ---
COMMENT ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) IS
'CL-8 + NV-01 + NV-02 + F8: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items (incluidos voucher_total, el total REAL de vales del período, fuera de la igualdad del neto, y adjustment_reason, el motivo del ajuste manual), marca los vales en descontada, registra la deuda del sobrante del vale en payroll_discount_carries, marca CONSUMIDAS (applied_period_id) las deudas que este cálculo absorbe en other_discounts y re-registra como PENDIENTE (origin_kind = carry_remainder, con este período como origen) el sobrante de la deuda que el tope no alcanzó a descontar, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista. NO calcula nada: cada monto y cada motivo llegan ya resueltos por el servicio y se escriben verbatim; la aritmética de la nómina vive en TypeScript. La instalación es de una sola sede (071): el filtro por sede del empleado y la columna de sede de las deudas ya no existen (077), así que el único `JOIN` que sobrevive en los tres `INSERT` es el de EXISTENCIA del empleado, que sigue siendo la mitad de la red de PAYROLL_ITEM_MISMATCH. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente, reemplaza también adjustment_reason (recalcular no deja el motivo viejo pegado a un ajuste nuevo) y aborta si escribió menos filas de las pedidas; las dos deudas salientes se insertan sólo si el ítem trae voucher_excess o debt_remainder > 0 y no existe ya una deuda del mismo empleado, mismo período de origen y mismo origin_kind (recalcular no duplica); la deuda entrante se marca sólo si sigue pendiente, así un replay es un no-op y una deuda se aplica exactamente una vez. El sobrante de la deuda se re-registra en ESTA transacción a propósito: si fuera una segunda escritura del servicio, un fallo entre el descuento y la re-registración borraría la deuda restante. El motivo del ajuste viaja en el ítem por la misma razón: un fallo entre el monto y su explicación dejaría una diferencia sin rastro. Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada, motivo vacío o desmedido, o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem, ni un vale marcado, ni una deuda consumida, ni un sobrante re-registrado. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 3.11 ----
-- create_user_with_role (054)
--
-- El alta de una cuenta con sus roles. Es la PRIMERA de las trece que NO
-- pierde la columna: `users.sede_id` se conserva (decisión de alcance, ver el
-- bloque del encabezado) y por eso el `INSERT` de `users` queda como en 054, con
-- su columna y su `CASE`. Lo único que este archivo le cambia a la función es la
-- prosa que decía que la sede ya no se guardaba. Las dos validaciones que
-- quedan (los cuatro campos NOT NULL y el catálogo de roles completo) y la red
-- que aborta un alta sin rol no cambian.
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
  --
  --     `users.sede_id` SE ESCRIBE, y es la excepción que este archivo deja viva:
  --     ancla la cuenta a la instalación única y es el origen de `session.sedeId`,
  --     del que dependen las siete guardas de sesión (ver el bloque de decisión
  --     del encabezado). El `CASE` que decide su valor se conserva tal cual: la
  --     clave ausente es un valor legítimo y produce NULL.
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

-- ------------------------------------------- search_path fijo ---
ALTER FUNCTION public.create_user_with_role(jsonb, text[]) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría crear un usuario —con sus roles— por PostgREST.
-- El único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_user_with_role(jsonb, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_user_with_role(jsonb, text[]) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.create_user_with_role(jsonb, text[]) IS
'CL-15: alta ATÓMICA del par usuario + rol (AUTH-04/07). Inserta `users` y sus `user_roles` en una sola transacción, con la unicidad de 002_auth.sql como guardia real (traducida a ''USER_EXISTS'') y red de seguridad final: el alta no confirma un usuario sin ningún rol. Rechaza con ''ROLE_NOT_FOUND'' un código que no está en el catálogo o un arreglo vacío, y con ''USER_INVALID'' un payload a medio formar; en todos los casos no se escribe ninguna fila. La contraseña viaja como HASH ya calculado. La fila de la cuenta SÍ guarda la sede: `users.sede_id` es el anclaje de la cuenta a la instalación única y el origen de `session.sedeId`, que alimentan las siete guardas de sesión (077). Devuelve el id del usuario creado. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 3.12 ----
-- upsert_employee_atomic (065, que a su vez trae 054)
--
-- El alta del legajo con su usuario y su rol. Es la SEGUNDA de las trece que no
-- pierde del todo la columna, y por eso el cambio es distinto en cada mitad: el
-- `INSERT` de `users` conserva su columna de sede (misma excepción que 3.11) y el
-- `INSERT` de `employees` la pierde, porque `employees.sede_id` sí se borra. En la
-- guarda de forma 4.1 sale el requisito de que `p_employee.sede_id` venga, que
-- sólo tenía sentido para la columna que ya no existe; el resto de la guarda —los
-- tres campos NOT NULL y la cadencia de 065— queda igual.
--
-- La red de roles se sigue COMPONIENDO con `ensure_user_has_role`, la
-- post-condición se sigue leyendo de la base y la forma de la fila devuelta no
-- cambia más que en la clave del legajo.
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
  --
  --     F2: `pay_frequency` es OPCIONAL (su clave puede no viajar y la columna
  --     nace NULL), pero un valor PRESENTE tiene que ser una de las tres
  --     cadencias cerradas de 063. La comprobación se escribe con `?` —pregunta
  --     por la PRESENCIA de la clave— y un `IS NOT NULL` que deja pasar el JSON
  --     null: "sin cadencia definida" es un estado LEGAL, no un valor inválido.
  --     Un objeto o un arreglo en esa clave no están en la lista y se rechazan
  --     sin llegar al CHECK de la columna.
  IF p_employee IS NULL OR jsonb_typeof(p_employee) <> 'object'
     OR coalesce(p_employee ->> 'full_name', '') = ''
     OR coalesce(p_employee ->> 'document', '') = ''
     OR coalesce(p_employee ->> 'pay_type', '') = ''
     OR (
       p_employee ? 'pay_frequency'
       AND p_employee ->> 'pay_frequency' IS NOT NULL
       AND p_employee ->> 'pay_frequency' NOT IN ('semanal', 'quincenal', 'mensual')
     )
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
  --
  --     F2: `pay_frequency` entra DIRECTO en la lista de columnas. La clave
  --     ausente y el JSON null dan SQL NULL —el DEFAULT de la columna— y un
  --     valor presente ya pasó la guarda de 4.1, así que no hay nada que
  --     convertir ni que distinguir (ver "NULL SIGUE SIENDO..." arriba).
  --
  --     El legajo ya no lleva columna de sede (`employees.sede_id` se borra en
  --     077); la cuenta que lo acompaña sí la lleva, y es la que la escribe 4.2.
  INSERT INTO public.employees (
    user_id, full_name, employee_code, document, phone, position,
    email, birth_date, pay_type, salary_fixed, commission_percent, pay_frequency
  )
  VALUES (
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
    END,
    p_employee ->> 'pay_frequency'
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
  --     (`EMPLOYEE_SELECT`): la respuesta de la ruta no cambia de forma. F2:
  --     `pay_frequency` se agrega a esa forma, al final, para que el alta
  --     devuelva la cadencia que acaba de escribir.
  RETURN jsonb_build_object(
    'id', v_fila.id,
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
    'pay_frequency', v_fila.pay_frequency,
    'is_active', v_fila.is_active
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- `CREATE OR REPLACE` conserva el `SET search_path` de la declaración, pero el
-- `ALTER FUNCTION` es la parte que sobrevive a un reemplazo mal hecho: se repite
-- para dejar la función en el mismo estado que la 054.
ALTER FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- La ACL se re-emite SIN cambios (misma firma): el único llamador legítimo es el
-- cliente service_role del servidor. `CREATE OR REPLACE` no la toca, así que
-- repetirla es lo que hace que este archivo sea seguro de re-ejecutar y que la
-- función no quede abierta si alguna vez se recreara desde cero.
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) IS
'CL-15: alta de empleado ATÓMICA (ADM-02/ADM-03). Crea el usuario de acceso si hace falta (su unicidad es la de 002_auth.sql), asegura su rol COMPONIENDO la red de seguridad de 040 (escribe sólo si el usuario no tiene ningún rol, con el mismo lock de la fila) e inserta el legajo, todo en una sola transacción: nunca queda un usuario con login y rol pero sin legajo. Reproduce la semántica de claves ausentes de PostgREST con el operador `?` (los DEFAULT de payout_mode/is_active los aplica la propia tabla). Verifica la post-condición (el legajo con SU usuario y ese usuario con al menos un rol) y devuelve la fila en la misma forma que el select del servicio. F2 (065): `p_employee.pay_frequency` es OPCIONAL y se escribe en el legajo; si viene con valor tiene que ser semanal, quincenal o mensual (la clave ausente y el JSON null son "sin cadencia definida" y dejan NULL), de modo que el alta guarda la misma cadencia que la edición y la respuesta la devuelve. El legajo ya NO se guarda con columna de sede (`employees.sede_id` se borra en 077 y la guarda que exigía `p_employee.sede_id` desaparece con ella), pero la cuenta de acceso SÍ la guarda: `p_create_user.sede_id` sigue siendo el anclaje de la cuenta a la instalación y el origen de `session.sedeId`. ''EMPLOYEE_INVALID''/''USER_NOT_FOUND''/''USER_EXISTS''/''ROLE_NOT_FOUND'' abortan sin escribir nada. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 3.13 ----
-- next_invoice_number (072)
--
-- La ÚNICA de las trece que cambia de FIRMA, y por eso la única que necesita un
-- `DROP` antes del `CREATE`: PostgreSQL identifica una función por su firma, así
-- que un `CREATE OR REPLACE` sin argumentos dejaría VIVA la sobrecarga vieja
-- —con su `p_sede_id`, su ACL y su permiso— al lado de la nueva. Es el mismo
-- criterio que 056, 057 y 071 aplicaron.
--
-- El parámetro se retire porque desde 072 no seleccionaba NADA: la fila del
-- contador es la clave `invoice_sequence` de `system_settings`, y el `SELECT … FOR
-- UPDATE` de esa fila —el lock que serializa a los emisores concurrentes— no
-- necesita de qué sede es. La 072 lo dejó escrito ("Se retira de la firma en la
-- unidad que borra `sede_id`") y esta es esa unidad.
--
-- EL ACL NO SE TOCA, y es una decisión que viene de antes: `CREATE FUNCTION`
-- otorga EXECUTE a PUBLIC y 072 dejó constancia de no cambiarlo ("Ajustarlo es
-- una decisión sobre la superficie RPC del proyecto"). Lo único que se repite acá
-- es el `search_path` fijo, con la firma nueva. Con la columna fuera, esta función
-- ya no es alcanzable desde ningún cliente que no sea el del servidor de la
-- aplicación, porque no hay ningún `sede_id` que un `anon` pudiera inventar para
-- llamar a `invoice_create_atomic`.

DROP FUNCTION IF EXISTS public.next_invoice_number(uuid);

CREATE FUNCTION public.next_invoice_number()
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
  -- DEFAULT documentado que la sección 3 de 072).
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
ALTER FUNCTION public.next_invoice_number() SET search_path = public;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.next_invoice_number() IS
  'FAC-05: reserva el siguiente consecutivo de factura. SIN parámetros: el que tenía (`p_sede_id uuid`) ya no seleccionaba nada —la fila del contador es la clave ''invoice_sequence'' de system_settings (072)— y la instalación es de una sola sede (077), así que no hay de qué elegir. BLOQUEA esa fila con SELECT … FOR UPDATE, lee `last_number` de la fila bloqueada e incrementa DENTRO de la misma transacción del llamador (`invoice_create_atomic`), así que dos emisores concurrentes obtienen números distintos (el segundo espera en el lock y ve el valor que el primero dejó) y un aborto del llamador no quema el número. El INSERT … ON CONFLICT DO NOTHING deja existir la fila antes de bloquearla sin pisar el contador vigente. Devuelve el número emitido siguiente (el primero es el 1).';

-- ===================================================================== ---
-- 4. LA COLUMNA, en las veinte tablas de negocio que la pierden
-- ===================================================================== ---
--
-- Va al final y no antes por una razón que no es de estilo: hasta que las trece
-- funciones de la sección 3 están re-emitidas, esta columna es lo que las une con
-- las tablas que tocan. Y va antes que cualquier borrado de datos porque las
-- veinte tablas NECESITAN la columna para seguir siendo lo que son: cada una la
-- usa como clave foránea hacia `sedes`, y `invoice_sequences` y
-- `voucher_settings` la tienen además como clave primaria. Quitar la columna no
-- borra ninguna fila: se borran las claves foráneas y los índices que la
-- nombraban (PostgreSQL los deja caer con ella) y el resto de cada tabla queda
-- intacto.
--
-- `public.users` NO está en la lista, y no es un olvido: la decisión de alcance
-- del encabezado lo deja con su columna.
--
-- El orden es el de creación, que es el que 073 usó para las dieciocho que ya no
-- eran obligatorias. `IF EXISTS` en todas: una segunda corrida deja el esquema
-- igual.
--
-- Lo que NO se pierde al quitar la columna, escrito porque es lo que más preguntas
-- genera al leer este archivo:
--
--   * `ex_payroll_periods_no_overlap` (063/074): la 074 la reescribió con sus dos
--     elementos —la cadencia y el rango de días— y ya no la nombraba. Sobrevive
--     intacta, y es la garantía de que un día se nomina una sola vez por ciclo.
--   * `uq_employees_sede_code`, `uq_invoices_sede_idempotency_key` y
--     `uq_payroll_draft_per_range` (074) y `uq_commission_rule_install_key`
--     (075): las cuatro se escribieron SIN `sede_id`, así que sobreviven.
--   * `sedes` NO entra en la lista: su clave primaria es `id`, no `sede_id`. La
--     fila que describe la instalación sigue existiendo y sigue siendo la que
--     `leerSedeDeLaInstalacion` resuelve por dato.
--   * `users` NO entra en la lista: ver el bloque de decisión del encabezado.

-- 008_hardening.sql (`audit_logs`).
ALTER TABLE public.audit_logs DROP COLUMN IF EXISTS sede_id;

-- 003_admin.sql.
ALTER TABLE public.employees DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.services DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.tax_configs DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.payment_methods DROP COLUMN IF EXISTS sede_id;

-- 004_inventory.sql.
ALTER TABLE public.products DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.inventory_movements DROP COLUMN IF EXISTS sede_id;

-- 005_billing.sql.
ALTER TABLE public.invoices DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.invoice_sequences DROP COLUMN IF EXISTS sede_id;

-- 006_cash.sql.
ALTER TABLE public.cash_registers DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.cash_shifts DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.payments DROP COLUMN IF EXISTS sede_id;

-- 007_payroll.sql.
ALTER TABLE public.payroll_periods DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.voucher_requests DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.voucher_settings DROP COLUMN IF EXISTS sede_id;

-- 010_cash_denominations.sql.
ALTER TABLE public.cash_denominations DROP COLUMN IF EXISTS sede_id;

-- 016_commissions.sql.
ALTER TABLE public.commission_rules DROP COLUMN IF EXISTS sede_id;
ALTER TABLE public.commission_payouts DROP COLUMN IF EXISTS sede_id;

-- 036_payroll_extra_payment.sql.
ALTER TABLE public.payroll_extras DROP COLUMN IF EXISTS sede_id;

-- 061_payroll_voucher_debt.sql.
ALTER TABLE public.payroll_discount_carries DROP COLUMN IF EXISTS sede_id;

-- ===================================================================== ---
-- 5. CÓMO VERIFICA EL DUEÑO DESPUÉS DE APLICARLO (SOLO LECTURA)
-- ===================================================================== ---
--
-- Las consultas están también en la cabecera del archivo; acá van las que
-- distingue el resultado de este archivo del de una base que nunca lo corrió.
--
--   * Las veinte tablas de negocio sin la columna, y `users` CON ella:
--
--       -- SELECT table_name FROM information_schema.columns
--       --  WHERE table_schema = 'public' AND column_name = 'sede_id'
--       --  ORDER BY table_name;
--       -- users            <- la única que queda, por decisión de alcance
--
--   * Las trece funciones con la firma esperada, y `next_invoice_number` SIN
--     parámetros:
--
--       -- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--       --   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';
--       -- next_invoice_number |
--
--   * Ninguna función nombra una columna que este archivo haya borrado. Las dos
--     que sí la nombran son las que la conservan a propósito:
--
--       -- SELECT p.proname FROM pg_proc p
--       --   JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public' AND p.prsrc ~ '\msede_id\M'
--       --  ORDER BY 1;
--       -- create_user_with_role | current_sede_id | upsert_employee_atomic
--
--   * `write_audit_log` se fue, con sus permisos, y `current_sede_id()` sigue
--     ahí porque `pol_users_sede_isolation` la llama:
--
--       -- SELECT to_regprocedure('public.write_audit_log(uuid,uuid,text,text,text,jsonb)');
--       -- NULL
--       -- SELECT to_regprocedure('public.current_sede_id()') IS NOT NULL;
--       -- t
--
--   * Ninguna política menciona ya la sede, EXCEPTUATRO las cuatro que
--     dependían de `users.sede_id`, que siguen en pie:
--
--       -- SELECT pol.polname, pol.polrelid::regclass
--       --   FROM pg_policy pol
--       --  WHERE coalesce(pg_get_expr(pol.qual, pol.polrelid), '')
--       --     ~ 'current_sede_id|sede_id'
--       --  ORDER BY 2, 1;
--       -- pol_password_resets_sede_isolation | password_resets
--       -- pol_sessions_sede_isolation        | sessions
--       -- pol_user_roles_sede_isolation       | user_roles
--       -- pol_users_sede_isolation            | users
--
--   * La garantía de nómina sigue siendo la de dos elementos:
--
--       -- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--       --  WHERE conname = 'ex_payroll_periods_no_overlap';
--
--   * Y las dos tablas que se quedaron sin lectoras siguen con sus filas (este
--     archivo NO borró ninguna):
--
--       -- SELECT count(*) FROM public.invoice_sequences;
--       -- SELECT count(*) FROM public.voucher_settings;
--
--   * Prueba funcional, con datos de prueba y NUNCA con los reales: emitir una
--     factura (turno abierto) devuelve la factura SIN sede y el consecutivo
--     avanza; reabrir el turno, hacer un cobro y cerrar el turno funcionan igual
--     que antes; dar de alta un empleado y una cuenta funcionan; liquidar un
--     período con vales y sobrantes funciona. Un rechazo de negocio (plantilla sin
--     token, cobro sobre factura anulada, arqueo desactualizado) sigue rechazando
--     con el mismo código.

-- ===================================================================== ---
-- 6. CÓMO SE REVIERTE
-- ===================================================================== ---
--
-- Las veinte columnas se pueden volver a agregar con `ADD COLUMN … uuid`, y las
-- funciones se pueden re-emitir con las firmas de 071, 067, 065, 054 y 072.
--
-- `users.sede_id` no participa de esta sección: no se quitó.
--
-- Lo que no tiene vuelta atrás es el CONTENIDO: las filas que había cuando la
-- columna se borró no se recuperan, y `sede_id` era nullable desde 073, así que
-- una reconstrucción volvería con la columna en NULL. Por eso el pre-vuelo de la
-- sección 1 corre antes de tocar nada y por eso este archivo es la unidad que el
-- dueño tiene que aplicar con la decisión ya tomada.
--
-- Para deshacerlo de verdad hay que restaurar un respaldo de la base, y eso es
-- una decisión del dueño, no de este archivo.
