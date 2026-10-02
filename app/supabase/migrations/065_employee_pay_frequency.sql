-- 065_employee_pay_frequency.sql — F2: la CADENCIA del empleado llega al
-- legajo, también en el alta atómica.
--
-- MOTIVO DEL ARCHIVO (por qué el alta no puede escribir la columna desde
-- TypeScript)
--
-- La 063 agregó `employees.pay_frequency` (text NULL, semanal | quincenal |
-- mensual) para que la nómina sepa con qué cadencia se acordó el pago de cada
-- empleado: F2 la pregunta en alta y edición y F3 la usa para la fracción del
-- fijo. El `select` y el `upsert` suelto de `admin/service.ts` escriben las
-- columnas POR NOMBRE, así que la edición de un empleado ya persistiría la
-- cadencia sin tocar la base. El ALTA, en cambio, no pasa por ese `upsert`: pasa
-- por el rpc `upsert_employee_atomic` (054), que escribe el legajo con una LISTA
-- DE COLUMNAS FIJA. Una columna que no está en esa lista no se escribe: el
-- payload puede traer `pay_frequency` y la función la IGNORA EN SILENCIO.
--
-- POR QUÉ ESO ES UN DEFECTO Y NO UNA SIMPLE AUSENCIA
--
-- No es "la cadencia no se guarda en el alta": es PEOR, porque las dos
-- superficies del MISMO formulario divergen. El admin elige "Semanal" al crear
-- al empleado, la fila vuelve con la clave, y la base la descarta. El legajo
-- queda sin cadencia —que es un estado LEGAL y significa "sin cadencia
-- definida"— así que no hay ningún error: el empleado se paga con el fijo
-- prorrateado por los días calendario del período (el comportamiento de hoy) y
-- nadie se entera hasta que la liquidación paga una cifra distinta de la
-- acordada. Un valor descartado en silencio es el defecto que la 054 vino a
-- cerrar para el rol y el legajo; acá se cierra para la cadencia.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
-- Reemplaza `upsert_employee_atomic` conservando el cuerpo de la 054 (la ventana
-- de usuario + rol + legajo en UNA sentencia, el lock de la fila del usuario, la
-- red de seguridad de 040 COMPUESTA y no copiada, la post-condición y la forma
-- de la respuesta) y agrega DOS cosas, las mínimas:
--
--   1. La validación de forma de `pay_frequency` en la guarda 4.1: la clave es
--      OPCIONAL, pero si viene con valor tiene que ser una de las tres cadencias
--      cerradas. Un cuarto valor no es una cadencia que la nómina sepa liquidar,
--      y rechazarlo acá da el código `EMPLOYEE_INVALID` del contrato en vez del
--      error crudo del CHECK de 063.
--   2. La ESCRITURA de `pay_frequency` en el INSERT del legajo (4.4) y su
--      LECTURA en la respuesta (4.6), para que la fila que devuelve el rpc tenga
--      la MISMA forma que el `select` del servicio (`EMPLOYEE_SELECT`,
--      `src/features/admin/service.ts`).
--
-- NO toca la nómina (la fracción del fijo es de la unidad de CÁLCULO), NO toca
-- la columna ni su CHECK (son de la 063), NO migra datos (no se escribe ni una
-- fila) y NO cambia la firma ni la ACL.
--
-- NULL SIGUE SIENDO "SIN CADENCIA DEFINIDA"
--
-- La clave ausente y el JSON null dejan SQL NULL en la columna, que es su
-- DEFAULT: un empleado sin `pay_frequency` sigue cobrando el fijo prorrateado por
-- los días calendario del período, exactamente como hoy. Por eso 4.4 escribe el
-- valor DIRECTO y NO usa el operador `?` de 4.5: ese operador existe para
-- distinguir "no vino la clave" de "vino null" cuando la columna tiene un
-- DEFAULT que hay que preservar (`payout_mode 'nomina'`, `is_active true`); acá
-- los dos casos significan lo mismo —sin cadencia— y el DEFAULT también es NULL,
-- así que no hay nada que distinguir. Es DELIBERADO que ningún empleado
-- existente cambie de comportamiento.
--
-- LA FIRMA ES LA MISMA (cuatro parámetros, mismo orden y mismos tipos)
--
-- `(jsonb, uuid, jsonb, text)`: NO se agrega ningún parámetro. La cadencia viaja
-- DENTRO de `p_employee`, igual que `salary_fixed` y `commission_percent`, así
-- que la llamada de cuatro argumentos del servicio no cambia y `CREATE OR
-- REPLACE` reemplaza la función sin dejar una sobrecarga vieja al lado. El
-- `ALTER FUNCTION` del search_path, el REVOKE/GRANT (sólo service_role) y el
-- COMMENT se repiten porque son parte del contrato de la función: un `CREATE OR
-- REPLACE` no los restaura ni los actualiza.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la MISMA firma
-- deja el esquema idéntico en cada corrida. El runner de Supabase aplica el
-- archivo en una transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 065 es el siguiente libre (la serie llega a
-- `064_payroll_partial_carry.sql`); este archivo NO renumera ni toca ningún
-- archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===========================================================================
-- 1. La función del alta de empleado, con la cadencia adentro del payload
-- ===========================================================================
-- El CUERPO es el de la 054, verbatim, salvo los DOS agregados marcados con
-- `-- F2:`. La ventana de usuario + rol + legajo sigue siendo UNA sentencia y la
-- red de seguridad de roles se sigue COMPONIENDO (`PERFORM
-- public.ensure_user_has_role`), porque el dueño de esa invariante tiene que ser
-- uno solo.
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
     OR coalesce(p_employee ->> 'sede_id', '') = ''
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
  INSERT INTO public.employees (
    sede_id, user_id, full_name, employee_code, document, phone, position,
    email, birth_date, pay_type, salary_fixed, commission_percent, pay_frequency
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
    'pay_frequency', v_fila.pay_frequency,
    'is_active', v_fila.is_active
  );
END;
$$;

-- ===========================================================================
-- 2. search_path fijo (house style desde 018)
-- ===========================================================================
-- `CREATE OR REPLACE` conserva el `SET search_path` de la declaración, pero el
-- `ALTER FUNCTION` es la parte que sobrevive a un reemplazo mal hecho: se repite
-- para dejar la función en el mismo estado que la 054.
ALTER FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) SET search_path = public;

-- ===========================================================================
-- 3. Permisos
-- ===========================================================================
-- La ACL se re-emite SIN cambios (misma firma): el único llamador legítimo es el
-- cliente service_role del servidor. `CREATE OR REPLACE` no la toca, así que
-- repetirla es lo que hace que este archivo sea seguro de re-ejecutar y que la
-- función no quede abierta si alguna vez se recreara desde cero.
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) TO service_role;

-- ===========================================================================
-- 4. Documentación
-- ===========================================================================
-- El COMMENT de la 054 se CONSERVA (el contrato de la ventana no cambió) y se le
-- agrega la frase de F2: qué clave se valida y qué clave se escribe.
COMMENT ON FUNCTION public.upsert_employee_atomic(jsonb, uuid, jsonb, text) IS
'CL-15: alta de empleado ATÓMICA (ADM-02/ADM-03). Crea el usuario de acceso si hace falta (su unicidad es la de 002_auth.sql), asegura su rol COMPONIENDO la red de seguridad de 040 (escribe sólo si el usuario no tiene ningún rol, con el mismo lock de la fila) e inserta el legajo, todo en una sola transacción: nunca queda un usuario con login y rol pero sin legajo. Reproduce la semántica de claves ausentes de PostgREST con el operador `?` (los DEFAULT de payout_mode/is_active los aplica la propia tabla). Verifica la post-condición (el legajo con SU usuario y ese usuario con al menos un rol) y devuelve la fila en la misma forma que el select del servicio. F2 (065): `p_employee.pay_frequency` es OPCIONAL y se escribe en el legajo; si viene con valor tiene que ser semanal, quincenal o mensual (la clave ausente y el JSON null son "sin cadencia definida" y dejan NULL), de modo que el alta guarda la misma cadencia que la edición y la respuesta la devuelve. ''EMPLOYEE_INVALID''/''USER_NOT_FOUND''/''USER_EXISTS''/''ROLE_NOT_FOUND'' abortan sin escribir nada. Sólo service_role puede ejecutarla.';

-- ===========================================================================
-- 5. Nota para quien aplica (verificación; no hay SQL que cambie datos)
-- ===========================================================================
--
-- Después de aplicar el archivo, compruebe en PRUEBAS:
--   * La función existe con la MISMA firma que antes
--     (`pg_get_function_identity_arguments` = 'jsonb, uuid, jsonb, text'), hay
--     UNA sola sobrecarga con ese nombre y su ACL sigue en service_role.
--   * En el cuerpo (`pg_get_functiondef`) aparecen `pay_frequency` en la lista
--     de columnas del INSERT y en `jsonb_build_object`, y la guarda de 4.1 con
--     los tres valores.
--   * Prueba funcional con filas de prueba (no con las reales): un alta con
--     `pay_frequency = 'semanal'` guarda 'semanal' y lo devuelve; un alta sin
--     la clave (o con JSON null) guarda NULL y no cambia la liquidación de ese
--     empleado; un alta con `pay_frequency = 'diario'` falla con
--     'EMPLOYEE_INVALID' sin escribir el usuario, el rol ni el legajo.
--   * Si vuelve a correr el archivo, el esquema queda igual.
--
-- OJO: `supabase/diagnostics/migraciones_faltantes.sql` cubre hasta la 059 y su
-- fila de la 054 es de tipo `function` (nombre + firma). Como 065 reescribe la
-- MISMA firma, esa fila sigue dando `presente = true` y no distingue la versión.
-- Agregar una fila `functiondef` de la 065 con un marcador (`pay_frequency`) es
-- trabajo de quien mantiene ese diagnóstico: este archivo no lo toca.
