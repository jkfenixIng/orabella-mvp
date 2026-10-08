-- 048_payroll_admin_atomic.sql — CL-9: las DOS ventanas de estado parcial que
-- quedaban en la administración de nómina dejan de poder existir.
--
-- MOTIVO DEL ARCHIVO (las dos ventanas, medidas)
--
-- El barrido de atomicidad encontró dos pares de escrituras seguidas y sin
-- transacción en `src/features/payroll/service.ts`, de la MISMA clase que CL-7
-- (046) y CL-8 (047): son DOS requests distintos contra PostgREST, que no
-- ofrece multi-statement por request (la misma nota que ya está escrita en 005,
-- 039, 040, 041, 042, 043, 044, 045, 046 y 047).
--
--   a) `deletePayrollPeriod` (service.ts:2039 y siguientes). Revertía los vales
--      que el borrador descontó —`UPDATE voucher_requests` a `aprobada` y a
--      `pendiente`, DOS escrituras con sus propios filtros— y DESPUÉS borraba
--      el período. Un fallo entre las dos —una escritura que falla, la conexión
--      que se corta— dejaba los vales YA revertidos y el borrador EN PIE: los
--      vales dicen `aprobada`/`pendiente` (plata que la sede todavía no
--      descontó) mientras la nómina que los descontaba sigue ahí, con su
--      liquidación firmada como si nada. La ventana gemela —un fallo entre las
--      DOS reversiones— deja la reversión a medias: unos vales vueltos a su
--      estado previo y otros todavía `descontada`, y el borrador en pie.
--   b) `correctPayrollPeriod` (service.ts:2221 y siguientes). Insertaba la
--      cabecera de la corrección en `payroll_period_corrections` y DESPUÉS sus
--      filas por empleado en `payroll_period_correction_items`. Un fallo entre
--      las dos dejaba la corrección FIRMADA sin sus filas —y, peor, es un
--      CALLEJÓN SIN SALIDA: el índice único por período de 037
--      (`uq_payroll_period_corrections_period`) hace que el reintento responda
--      ALREADY_CORRECTED, así que la corrección se queda sin sus filas para
--      siempre. Es la familia "firmado sin su prueba", la peor estructuralmente:
--      el registro dice que la liquidación se corrigió y no hay con qué
--      compararla.
--
-- La corrección NO mueve plata (la decisión del dueño está escrita en 037: la
-- diferencia se muestra y se salda a mano). El borrado tampoco cobra ni paga:
-- deshace un borrador. Aun así las dos ventanas son de ESTADO, y las dos se
-- cierran igual que las anteriores.
--
-- MECANISMO (por qué UNA función por par, y no algo más simple)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047). Una función es
-- UNA sentencia, y una sentencia corre ENTERA dentro de una sola transacción
-- del servidor: o se escriben TODAS las filas de la operación, o no se escribe
-- ninguna. Las dos operaciones tienen DOS escrituras cada una, así que cada par
-- recibe su propia función:
--
--   * `payroll_delete_period_atomic` (reversión de los vales + borrado del
--     período).
--   * `payroll_correct_period_atomic` (cabecera de la corrección + sus filas).
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * UN TRIGGER QUE REVIERTA LOS VALES AL BORRAR EL PERÍODO. Sería una sola
--     sentencia (`DELETE`) y el disparador haría el resto, pero movería a SQL
--     DOS reglas de negocio que hoy viven en TypeScript: QUÉ vales se revierten
--     (la atribución por rango de fechas y `status = 'descontada'`) y A QUÉ
--     estado vuelve cada uno (`restoreVoucherStatus`, que se deriva de
--     `approved_by`). Además escondería la reversión en un efecto colateral de
--     un DELETE y perdería la red de conteo: un disparador no puede contrastar
--     cuántas filas esperaba el llamador. Descartado.
--   * INVERTIR EL ORDEN (borrar primero y revertir después). Cambia de lugar la
--     ventana, no la cierra: el fallo dejaría exactamente lo que el hallazgo
--     describe del otro lado —vales `descontada` sin nómina que los respalde, la
--     liquidación borrada—. Una transacción no depende del orden para ser
--     atómica; compensar sí, y por eso no se compensa.
--   * UNA COMPENSACIÓN EN EL CLIENTE. Revertir lo escrito es escribir OTRA vez
--     y volver a exponerse al mismo fallo a mitad de camino (se compensa la
--     cabecera de la corrección y falla la compensación): es el defecto exacto
--     que 046 documenta. La única forma de que la compensación sea tan sólida
--     como la transacción es... una transacción.
--   * UNA SOLA FUNCIÓN PARA LOS DOS PARES. No: son dos operaciones distintas,
--     con precondiciones distintas (un período que se borra frente a uno que se
--     corrige) y llamadores distintos. Una función que hiciera las dos tendría
--     que recibir un discriminador y ramificar; eso no agrega atomicidad (cada
--     par ya es una transacción) y sí agrega superficie de error. Descartado.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y las funciones SÓLO ESCRIBEN. Acá no se mueve NADA de
-- aritmética de dinero a SQL:
--
--   * El borrado recibe los ids de los vales YA clasificados por
--     `restoreVoucherStatus` (`p_to_approved`, `p_to_pending`); la función sólo
--     los escribe.
--   * La corrección recibe la cabecera y las filas YA resueltas por
--     `computePayrollLines`, la prorata del fijo, el arrastre de los ajustes
--     manuales y `buildPayrollCorrectionView`; la función escribe
--     `(item ->> 'previous_base_fixed')::numeric` y cada campo verbatim. No
--     suma, no resta, no recalcula y no decide elegibilidad de vales. El
--     `::numeric` es una CONVERSIÓN de representación (jsonb → la columna), no
--     una operación aritmética. Lo único que valida un monto es el CHECK de las
--     tablas 007 y 037, que ya existía: una barrera PREEXISTENTE que COMPRUEBA
--     un número ajeno, no una fórmula que lo produzca.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre la fila
-- BLOQUEADA, para que no puedan volverse mentira entre la lectura y la
-- escritura.
--
--   * `assertDeletablePeriod` (sólo `borrador`): adentro, la fila de
--     `payroll_periods` se lee con `FOR UPDATE` y su estado tiene que seguir
--     siendo `borrador`. Un admin que CIERRA el período entre la lectura y la
--     llamada hace que la transacción rechace con `PAYROLL_PERIOD_CONFLICT` en
--     vez de borrar —y revertir— un período ya cerrado. El `DELETE` conserva
--     además la precondición en su propio `WHERE` y su red de conteo, que es lo
--     que hace que dos borrados concurrentes del mismo período no se pisen: el
--     segundo escribe cero filas y se rechaza.
--   * El guardia de SOLAPAMIENTO del borrado (`PERIOD_OVERLAP_AMBIGUOUS`: un
--     período CERRADO que solapa el rango impide revertir sus vales). Se
--     re-evalúa adentro con las fechas de la fila bloqueada, porque la lectura
--     del servicio puede quedar vieja: si otro admin CIERRA un período que
--     solapaba mientras se borraba, ese borrado revertiría vales de una nómina
--     YA PAGADA. El código y el mensaje son los mismos que el servicio ya
--     devolvía, así que el contrato de error no cambia.
--   * `assertCorrectablePeriod` (sólo `cerrado`): adentro, el período se lee con
--     `FOR UPDATE` y su estado tiene que ser `cerrado`; si no, la transacción
--     rechaza con `PERIOD_NOT_CLOSED` (el mismo código del servicio) y no escribe
--     nada. La sede también se verifica: una corrección no se atribuye a un
--     período de otra sede.
--   * La corrección "una por período" sigue siendo el índice único de 037: una
--     carrera la detecta la propia base dentro de la transacción (23505) y el
--     servicio la traduce a ALREADY_CORRECTED, como ya hacía. La transacción no
--     es un camino para saltearla: es un camino para que la perdedora no deje
--     NADA escrito.
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS ... ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluidos los grupos anteriores.
--
--   * Reversión de vales: exactamente `cardinality(p_to_approved) +
--     cardinality(p_to_pending)`. Un vale que ya no está `descontada` —otro
--     borrado lo revirtió, o el cálculo de otro borrador lo volvió a descontar—
--     escribe CERO filas y la operación entera aborta. Es la misma red que 047
--     puso sobre el flip de los vales y 046 sobre la deducción.
--   * Borrado del período: exactamente 1.
--   * Cabecera de la corrección: exactamente 1.
--   * Filas de la corrección: exactamente `jsonb_array_length(p_items)`. El
--     `JOIN` con `employees` filtra por sede y por existencia, así que un
--     empleado de otra sede o inexistente escribiría menos filas en SILENCIO:
--     la red convierte ese subconjunto silencioso en un rechazo con rollback.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA en las dos funciones.
-- Las dos empiezan BLOQUEANDO la fila del período (`SELECT ... FOR UPDATE`,
-- siempre la misma fila), después recorren los vales en orden ascendente por id
-- (`ORDER BY v.id`, el idioma de 046 y 047) y después la corrección inserta sus
-- filas en orden ascendente por empleado (`ORDER BY e.id`). Dos operaciones
-- concurrentes que compartan filas se bloquean en el MISMO orden, así que la
-- segunda espera a la primera y no hay ciclo.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER, igual que 039, 046 y 047.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría a cualquier JWT (anon/authenticated) por
--     PostgREST: cualquiera podría borrar un período en borrador revirtiendo
--     vales ajenos, o firmar una corrección de nómina con los montos que
--     quisiera. Se cierra en los pasos 3 y 7: se revoca de PUBLIC, anon y
--     authenticated, y se otorga sólo a service_role. Es la misma decisión que
--     018 tomó para `write_audit_log`, que 039 para `replace_user_roles`, que
--     046 para `deduct_stock_atomic` y que 047 para `payroll_apply_atomic`.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No agrega ni quita columnas, índices ni constraints: los INSERT usan las
--     columnas de 007 y 037, los `ON CONFLICT`/índices únicos que importan ya
--     existen (`uq_payroll_period_corrections_period`, PK de `payroll_periods`,
--     PK de `voucher_requests`) y el borrado arrastra los hijos con las FK
--     `ON DELETE CASCADE` de 007. No hay índice nuevo que justificar ni coste
--     de escritura nuevo que declarar.
--   * No borra ni reescribe filas de datos fuera de lo que la operación ya
--     hacía: el ÚNICO `DELETE` es el del período en borrador que el servicio ya
--     borraba (con su precondición). Los vales NUNCA se borran: se les cambia
--     el estado, como ya hacía el servicio.
--   * No toca `payroll_items` ni `payroll_payments`: caen con el período por las
--     FK de 007, dentro de la misma transacción.
--   * No toca los caminos de dinero de otros módulos: ni `invoices`, ni
--     `invoice_payments`, ni `payments`, ni `next_invoice_number`.
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (007) el
--     único escritor de esa columna.
--   * No backfillea ni repara lo que las dos ventanas ya dejaron a medias: ver
--     la nota operativa final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja las funciones idénticas en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. `payroll_delete_period_atomic`. Va PRIMERO porque es el objeto que sus
--      permisos y su comentario nombran.
--   2. Su `search_path` fijo (house style desde 018).
--   3. Sus permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. Su comentario, para el que la lea desde `\df`.
--   5. `payroll_correct_period_atomic`, y sus pasos 6, 7 y 8 por la misma razón.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 048, el siguiente libre
-- (032 no existe y no existirá; 033–047 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. Ninguna de las dos tablas
-- tiene serie ni consecutivo —`payroll_periods` (007) y
-- `payroll_period_corrections` (037) usan `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`—, así que una operación abortada no deja fila y no deja
-- hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO, ni en el camino normal ni en el
-- rechazo.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * El CONJUNTO de vales que se revierten se decide ANTES de la transacción
--     (la lectura por rango y estado la hace el servicio, que es donde vive la
--     regla). La transacción garantiza que ese conjunto se revierta ENTERO o
--     nada, y que un vale que cambió de estado bajo los pies sea un rechazo y no
--     un salto silencioso. Lo que no cierra es una lectura vieja por otra razón:
--     un vale descontado por OTRO borrador después de esa lectura no entra al
--     conjunto y no se revierte (es del otro borrador; el comportamiento ya
--     estaba documentado en `deletePayrollPeriod`).
--   * La lectura exhaustiva que alimenta el recálculo de la corrección sigue
--     separada de la escritura por el cálculo entero. Eso NO se cierra alargando
--     la transacción (haría durar los locks todo el cálculo): lo que cierra es
--     que la escritura sea indivisible y que una carrera pierda ruidosamente.
--   * La AUDITORÍA (`writeAudit`) queda FUERA de las dos transacciones: es un
--     INSERT posterior y separado. No es un punto de fallo de estado
--     (`writeAudit` no lanza: registra y sigue), así que a lo sumo falta la fila
--     de auditoría, nunca una escritura a medias.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 048 va ANTES que este código. Sin las
-- funciones, `deletePayrollPeriod` no puede borrar NADA y `correctPayrollPeriod`
-- no puede corregir NADA —los RPC no existen y las operaciones fallan enteras
-- ANTES de escribir, que es la dirección segura—, y con las funciones y sin el
-- código las dos operaciones siguen siendo las de las escrituras sueltas (no hay
-- regresión, sólo no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La REVERSIÓN de los vales y el BORRADO del período, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid[], uuid[])`: la sede del actor, el período en
-- borrador y los dos grupos de vales YA clasificados por el servicio (los que
-- vuelven a `aprobada` y los que vuelven a `pendiente`). El tipo de retorno es
-- el número de vales revertidos: el llamador contrasta ESE número contra lo que
-- pidió, en vez de confiar en que la función no dejó nada afuera.
CREATE OR REPLACE FUNCTION public.payroll_delete_period_atomic(
  p_sede_id uuid,
  p_period_id uuid,
  p_to_approved uuid[],
  p_to_pending uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_start date;
  v_end date;
  v_esperados integer;
  v_revertidos integer;
  v_borrados integer;
BEGIN
  -- 1.1 FORMA de la entrada. La función revierte estados de vales y borra una
  --     nómina: no puede aceptar una entrada a medio formar. Los dos arreglos
  --     pueden venir VACÍOS (un borrador sin vales descontados es un caso
  --     legal), pero tienen que venir.
  IF p_sede_id IS NULL
     OR p_period_id IS NULL
     OR p_to_approved IS NULL
     OR p_to_pending IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada grupo tiene que ser un CONJUNTO (sin ids repetidos) y los dos
  --     grupos tienen que ser DISJUNTOS. Un id repetido dentro de un grupo, o
  --     presente en los dos, no se puede revertir dos veces: la red de conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado. Se valida en
  --     vez de confiar en que el llamador partió bien.
  IF cardinality(p_to_approved) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_approved) AS id
     )
     OR cardinality(p_to_pending) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_pending) AS id
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_to_approved) AS id WHERE id = ANY (p_to_pending)
     )
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El PERÍODO, bloqueado, y su precondición de estado leída de LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047): a partir de acá, otro
  --     borrado o un cierre del mismo período espera, y si el período cambió
  --     antes, esta lectura ve la versión nueva y rechaza.
  SELECT p.status, p.start_date, p.end_date
    INTO v_status, v_start, v_end
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
    AND p.sede_id = p_sede_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'borrador' THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  -- 1.3 El guardia de SOLAPAMIENTO, re-evaluado adentro de la transacción con
  --     las fechas de la fila bloqueada. Es la misma regla que el servicio
  --     aplica en `overlapBlocksDeletion`: un período CERRADO que solapa el
  --     rango hace ambiguo qué vales son de este borrador, y revertirlos
  --     destruiría una nómina ya pagada. Solapar con otros BORRADORES no
  --     bloquea: no hay plata pagada y el borrador restante puede recalcularse.
  --     El código es el mismo que el servicio ya devolvía, así que el contrato
  --     de error no cambia.
  IF EXISTS (
    SELECT 1
    FROM public.payroll_periods o
    WHERE o.sede_id = p_sede_id
      AND o.id <> p_period_id
      AND o.status = 'cerrado'
      AND o.start_date <= v_end
      AND o.end_date >= v_start
  ) THEN
    RAISE EXCEPTION 'PERIOD_OVERLAP_AMBIGUOUS';
  END IF;

  -- 1.4 Los LOCKS de los vales, en orden determinista ascendente por id (ver
  --     "SERIALIZACIÓN" arriba). El bloqueo va PRIMERO y aparte del UPDATE: con
  --     `ORDER BY` delante, dos operaciones con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo. El `UPDATE` de abajo no
  --     necesita orden: sus filas ya las bloqueó este paso, en esta misma
  --     transacción.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.sede_id = p_sede_id
     AND v.id = ANY (p_to_approved || p_to_pending)
   ORDER BY v.id
     FOR UPDATE OF v;

  -- 1.5 La REVERSIÓN: UNA sentencia para los DOS grupos —y por eso UNA red de
  --     conteo—. El estado destino lo elige el servicio (`restoreVoucherStatus`)
  --     y viaja ya resuelto en el grupo donde va cada id; acá sólo se escribe.
  --     La precondición `status = 'descontada'` es la MISMA que llevaba cada
  --     `UPDATE` del servicio: un vale que ya no está descontado no se toca, y
  --     el conteo de abajo convierte esa carrera en un rechazo.
  v_esperados := cardinality(p_to_approved) + cardinality(p_to_pending);

  UPDATE public.voucher_requests v
     SET status = CASE
                    WHEN v.id = ANY (p_to_approved) THEN 'aprobada'
                    ELSE 'pendiente'
                  END
   WHERE v.sede_id = p_sede_id
     AND v.id = ANY (p_to_approved || p_to_pending)
     AND v.status = 'descontada';

  -- 1.6 Red de seguridad DENTRO de la transacción: si se revirtieron MENOS vales
  --     de los recibidos —uno lo revirtió otro borrado, o ya estaba en otro
  --     estado—, se aborta y se revierte todo lo que esta sentencia sí escribió.
  --     Sin esta red, el `UPDATE` afectaba cero filas y la operación seguía de
  --     largo EN SILENCIO, borrando el período con vales que ya no eran suyos.
  GET DIAGNOSTICS v_revertidos = ROW_COUNT;

  IF v_revertidos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.7 El BORRADO del período, con su precondición en el propio `WHERE` (la
  --     red de conteo de 1.2 ya la verificó sobre la fila bloqueada; acá se
  --     repite como un compare-and-swap, porque es lo que hace que dos borrados
  --     concurrentes no se pisen). `payroll_items` y `payroll_payments` caen con
  --     él por las FK `ON DELETE CASCADE` de 007, dentro de esta misma
  --     transacción: no hay borrado manual ni huérfanos.
  DELETE FROM public.payroll_periods p
   WHERE p.id = p_period_id
     AND p.sede_id = p_sede_id
     AND p.status = 'borrador';

  -- 1.8 La segunda red: exactamente UNA fila borrada. Cero filas es un período
  --     que cambió bajo los pies; el resultado es el mismo: rollback de TODO,
  --     la reversión incluida.
  GET DIAGNOSTICS v_borrados = ROW_COUNT;

  IF v_borrados <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  RETURN v_revertidos;
END;
$$;

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `payroll_periods` y `voucher_requests`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039, 046 y 047).
ALTER FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría borrar períodos en borrador y revertir vales por
-- PostgREST. El único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]) IS
'CL-9: borrado ATÓMICO de un período en BORRADOR. Revierte los vales que ese borrador descontó y borra el período en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero y los vales en orden ascendente por id para que dos borrados concurrentes no se bloqueen en ciclo. Conserva las precondiciones del servicio: sólo un período en borrador, y el guardia de solapamiento contra un período CERRADO (PERIOD_OVERLAP_AMBIGUOUS) re-evaluado dentro de la transacción. Los ids de los vales y su estado destino llegan YA resueltos por el servicio (restoreVoucherStatus): la función no decide qué se revierte ni a qué estado. Su red de conteo aborta con PAYROLL_VOUCHER_CONFLICT si no revirtió exactamente los vales recibidos y con PAYROLL_PERIOD_CONFLICT si el período ya no es borrador o no borró exactamente una fila; en los dos casos la transacción se revierte COMPLETA. Devuelve cuántos vales revirtió. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- un borrado que ya quedó a medias por el bug anterior —vales revertidos con el
-- borrador todavía en pie, o unos revertidos y otros no— NO se repara solo y no
-- es detectable desde la base sin comparar el estado de los vales del rango
-- contra los borradores que quedaron: el estado de cada vale es, por separado,
-- un estado válido (`aprobada`/`pendiente` para uno que no se descontó). Se
-- reconcilia decidiendo, por rango, si los vales deben volver a descontarse
-- (recalcular el borrador que quedó en pie) o si el borrador corresponde
-- borrarse (repetir el borrado, que ahora es atómico) — decidido por quien
-- opera la base, con la liquidación y los vales delante y la auditoría como
-- registro.

-- ===================================================================== ---
-- 5. La CABECERA de la corrección y sus FILAS, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, jsonb, jsonb)`: la sede del actor, el período corregido,
-- la cabecera ya resuelta (`{period_id, previous_net_total, previous_paid_total,
-- corrected_net_total, previous_item_count, corrected_item_count, reason,
-- corrected_by}`) y las filas por empleado con los montos de las DOS versiones.
-- El tipo de retorno es la cabecera ESCRITA (jsonb), que es lo que el servicio
-- devuelve como corrección: el llamador no necesita otra lectura para tener la
-- fila con su `id` y su `corrected_at`, y no hay ventana entre la escritura y la
-- lectura del resultado.
CREATE OR REPLACE FUNCTION public.payroll_correct_period_atomic(
  p_sede_id uuid,
  p_period_id uuid,
  p_correction jsonb,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_cabecera public.payroll_period_corrections;
  v_cabeceras integer;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 5.1 FORMA de la entrada. Una función que firma una corrección de nómina no
  --     puede aceptar una entrada a medio formar: el precio de un rechazo claro
  --     acá es infinitamente menor que el de una corrección interpretada.
  --     `p_items` puede venir VACÍO (un período sin planta activa todavía tiene
  --     una versión anterior que congelar), pero tiene que ser un ARREGLO.
  IF p_sede_id IS NULL
     OR p_period_id IS NULL
     OR p_correction IS NULL
     OR jsonb_typeof(p_correction) <> 'object'
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     La cabecera: el motivo no puede quedar vacío (ni en espacios), el actor
  --     tiene que ser un usuario, el período declarado tiene que ser EL MISMO
  --     que se va a corregir, y los totales y los conteos tienen que tener la
  --     forma que la tabla puede guardar (`numeric(12, 2)` y un entero).
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `p_correction ->> 'previous_net_total'` es NULL y `NULL !~ 'regex'` es
  --     NULL —no TRUE—, así que sin el coalesce una entrada sin un monto
  --     pasaría esta guarda y el `NOT NULL` de la columna sería el que hablara,
  --     con un error de la base en vez de un rechazo del contrato. Es la misma
  --     trampa que 046 documenta para `qty` y 047 para `net_pay`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  IF btrim(coalesce(p_correction ->> 'reason', '')) = ''
     OR coalesce(p_correction ->> 'period_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (p_correction ->> 'period_id')::uuid <> p_period_id
     OR coalesce(p_correction ->> 'corrected_by', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_correction ->> 'previous_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_paid_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'corrected_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_item_count', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_correction ->> 'corrected_item_count', '') !~ '^[0-9]{1,9}$'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada fila tiene que ser un objeto con un `employee_id` con la forma del
  --     `CHECK` de 001/007 y sus TRECE montos como número no negativo de hasta 9
  --     dígitos enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar, en las dos versiones (la anterior congelada y la corregida) más
  --     lo pagado—.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'previous_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_paid', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.2 Un empleado REPETIDO en las filas no es un empleado dos veces: las dos
  --     versiones de un empleado van en UNA fila (el índice único
  --     `uq_payroll_period_correction_items_employee` de 037 lo impide, y ese
  --     23505 se traduciría a ALREADY_CORRECTED, que sería una mentira). Se
  --     rechaza la entrada repetida en vez de confiar en que el llamador no
  --     repite.
  IF jsonb_array_length(p_items) <> (
    SELECT count(DISTINCT item ->> 'employee_id')
    FROM jsonb_array_elements(p_items) AS item
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.3 El PERÍODO, bloqueado, y sus dos precondiciones leídas de LA FILA: la
  --     sede (una corrección no se atribuye a un período ajeno) y el estado
  --     (`assertCorrectablePeriod`: sólo un período CERRADO se corrige; un
  --     borrador se recalcula, no se corrige).
  SELECT p.status
    INTO v_status
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
    AND p.sede_id = p_sede_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_CONFLICT';
  END IF;
  IF v_status <> 'cerrado' THEN
    RAISE EXCEPTION 'PERIOD_NOT_CLOSED';
  END IF;

  -- 5.4 La CABECERA: UNA sentencia, y por eso UNA transacción con las filas de
  --     5.5. Todos los campos entran VERBATIM desde `p_correction` —los totales
  --     de las dos versiones, los conteos, el motivo y el actor—: acá no se
  --     suma, no se resta y no se recalcula nada.
  --
  --     El índice único por período de 037 es la barrera de "una corrección por
  --     período": una carrera contra él levanta 23505 y aborta la transacción
  --     —el servicio lo traduce a ALREADY_CORRECTED, como ya hacía—, así que la
  --     corrección perdedora no deja NADA escrito.
  INSERT INTO public.payroll_period_corrections
    (period_id, previous_net_total, previous_paid_total, corrected_net_total,
     previous_item_count, corrected_item_count, reason, corrected_by)
  VALUES (
    p_period_id,
    (p_correction ->> 'previous_net_total')::numeric,
    (p_correction ->> 'previous_paid_total')::numeric,
    (p_correction ->> 'corrected_net_total')::numeric,
    (p_correction ->> 'previous_item_count')::integer,
    (p_correction ->> 'corrected_item_count')::integer,
    p_correction ->> 'reason',
    (p_correction ->> 'corrected_by')::uuid
  )
  RETURNING * INTO v_cabecera;

  GET DIAGNOSTICS v_cabeceras = ROW_COUNT;

  IF v_cabeceras <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.5 Las FILAS por empleado: la versión anterior congelada, lo pagado y la
  --     versión corregida, TODO verbatim desde `p_items`. Una fila por empleado
  --     de la comparación (`buildPayrollCorrectionView` puede incluir a alguien
  --     que sólo esté en una de las dos versiones, con la otra en cero).
  --
  --     El `JOIN` filtra por la sede del actor y por la existencia del empleado:
  --     un empleado de otra sede o inexistente escribiría menos filas en
  --     SILENCIO, y la red de 5.6 convierte ese subconjunto silencioso en un
  --     rechazo con rollback. `ORDER BY e.id` es el orden determinista de los
  --     locks de `payroll_period_correction_items` (ver "SERIALIZACIÓN").
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_period_correction_items
    (correction_id, employee_id,
     previous_base_fixed, previous_commissions, previous_bonuses,
     previous_deductions_vales, previous_other_discounts, previous_net_pay, previous_paid,
     corrected_base_fixed, corrected_commissions, corrected_bonuses,
     corrected_deductions_vales, corrected_other_discounts, corrected_net_pay)
  SELECT
    v_cabecera.id,
    e.id,
    (item ->> 'previous_base_fixed')::numeric,
    (item ->> 'previous_commissions')::numeric,
    (item ->> 'previous_bonuses')::numeric,
    (item ->> 'previous_deductions_vales')::numeric,
    (item ->> 'previous_other_discounts')::numeric,
    (item ->> 'previous_net_pay')::numeric,
    (item ->> 'previous_paid')::numeric,
    (item ->> 'corrected_base_fixed')::numeric,
    (item ->> 'corrected_commissions')::numeric,
    (item ->> 'corrected_bonuses')::numeric,
    (item ->> 'corrected_deductions_vales')::numeric,
    (item ->> 'corrected_other_discounts')::numeric,
    (item ->> 'corrected_net_pay')::numeric
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
   AND e.sede_id = p_sede_id
  ORDER BY e.id;

  -- 5.6 La segunda red: si se escribieron menos filas de las pedidas —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, la cabecera
  --     incluida. Es lo que separa "la corrección no se pudo firmar" de "la
  --     corrección quedó firmada sin su prueba".
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.7 La cabecera ESCRITA, tal como quedó en la tabla (con su `id` y su
  --     `corrected_at` del DEFAULT). Devolverla evita una segunda lectura y su
  --     ventana.
  RETURN to_jsonb(v_cabecera);
END;
$$;

-- ------------------------------------------- 6. search_path fijo ---
-- La función resuelve `payroll_periods`, `payroll_period_corrections` y
-- `employees`; con search_path mutable un esquema anterior en la ruta podría
-- secuestrar esos nombres. House style desde 018 (y el mismo paso que dan 039,
-- 046 y 047).
ALTER FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ 7. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría firmar una corrección de nómina por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) TO service_role;

-- --------------------------------------------- 8. Documentación ---
COMMENT ON FUNCTION public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb) IS
'CL-9: corrección ATÓMICA de un período CERRADO (PA-2b, 037). Inserta la cabecera de payroll_period_corrections y sus filas por empleado en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero para que el estado y la sede no puedan cambiar entre la lectura y la escritura. NO calcula nada: la cabecera y las filas llegan ya resueltas por el servicio (computePayrollLines, la prorata del fijo, el arrastre de los ajustes manuales y buildPayrollCorrectionView) y se escriben verbatim; la aritmética de la nómina vive en TypeScript. Conserva las precondiciones del servicio: sólo un período CERRADO (PERIOD_NOT_CLOSED) y de la sede del actor, y el índice único por período de 037 (23505 → ALREADY_CORRECTED) adentro de la transacción. Sus redes de conteo abortan con PAYROLL_CORRECTION_MISMATCH si no escribió exactamente una cabecera y exactamente las filas recibidas; en ese caso la transacción se revierte COMPLETA: no queda una corrección firmada sin su prueba. Devuelve la cabecera escrita. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- una corrección que ya quedó firmada sin sus filas por el bug anterior NO se
-- repara sola y no se puede reintentar (el índice único por período responde
-- ALREADY_CORRECTED). Se reconcilia a mano, con decisión de quien opera la
-- base: si la corrección sin filas no corresponde, se borra la cabecera
-- huérfana de `payroll_period_corrections` (sus filas no existen) y se vuelve a
-- corregir el período, que ahora es atómico; si el período no debe corregirse,
-- se deja la cabecera como registro de que la corrección se intentó. En los dos
-- casos queda la auditoría (`payroll.period_corrected`) como registro del
-- intento.
