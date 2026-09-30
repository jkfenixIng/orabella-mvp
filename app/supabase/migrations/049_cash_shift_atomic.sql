-- 049_cash_shift_atomic.sql — CL-10: las TRES ventanas de estado parcial del
-- ciclo del turno de caja dejan de poder existir.
--
-- MOTIVO DEL ARCHIVO (las tres ventanas, medidas)
--
-- El barrido de atomicidad encontró TRES pares de escrituras seguidas y sin
-- transacción en `src/features/cash/service.ts`, de la MISMA clase que CL-7
-- (046), CL-8 (047) y CL-9 (048): son DOS requests distintos contra PostgREST,
-- que no ofrece multi-statement por request (la misma nota que ya está escrita
-- en 005, 039, 040, 041, 042, 043, 044, 045, 046, 047 y 048).
--
--   a) `closeShift` (service.ts:1669 y 1709). Pisa el turno a `cerrado` con un
--      compare-and-swap —`UPDATE ... WHERE status = 'abierto'`— y DESPUÉS
--      inserta los conteos del cierre. Un fallo entre las dos —una escritura que
--      falla, la conexión que se corta— dejaba el cierre FIRMADO sin su conteo
--      por denominación: el turno dice que se cerró, con su total, su base
--      dejada, su recogido y su sobre, y NO existe una sola línea que diga
--      cuántos billetes de cada valor había. Y es un CALLEJÓN SIN SALIDA: el CAS
--      sólo pisa un turno `abierto`, así que el reintento responde
--      SHIFT_ALREADY_CLOSED; la evidencia que hace real a un arqueo no se puede
--      volver a escribir nunca. Es la peor de las tres por eso: no sólo deja
--      estado parcial, deja un estado parcial que ya no se puede completar.
--   b) `recountClosedShift` (service.ts:1850 y 1880). Inserta la fila del
--      reconteo en `cash_shift_recounts` —con las DOS versiones y el motivo— y
--      DESPUÉS sus líneas por denominación en `cash_shift_counts` (fase
--      `reconteo`). Un fallo entre las dos dejaba el reconteo FIRMADO sin su
--      detalle, y también es un callejón sin salida: el índice único por turno
--      de 033 (`uq_cash_shift_recounts_shift`) hace que el reintento responda
--      ALREADY_RECOUNTED, así que el reconteo se queda sin su detalle para
--      siempre. Rompe la promesa exacta que el reconteo existe para cumplir:
--      las DOS versiones, cada una con su evidencia por denominación.
--   c) `openShift` (service.ts:913 y 935). Inserta el turno `abierto` y DESPUÉS
--      su conteo de apertura. Un fallo entre las dos dejaba un turno ABIERTO sin
--      arqueo de apertura: la base con la que abrió el cajón no tiene respaldo
--      por denominación, el esperado digital del cierre pierde su punto de
--      partida (el conteo de apertura es el `openByMethod` contra el que se
--      mide) y los desajustes de la apertura no se pueden volver a comparar.
--      El reintento tampoco abre: el índice parcial de 006
--      (`uq_cash_shifts_open_per_register`) ya tiene un turno abierto.
--
-- MECANISMO (por qué UNA función por operación, y no algo más simple)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047 y las dos de 048).
-- Una función es UNA sentencia, y una sentencia corre ENTERA dentro de una sola
-- transacción del servidor: o se escriben TODAS las filas de la operación, o no
-- se escribe ninguna. Las tres operaciones tienen DOS escrituras cada una, así
-- que cada una recibe su propia función:
--
--   * `cash_open_shift_atomic` (el turno abierto + su conteo de apertura).
--   * `cash_close_shift_atomic` (el turno cerrado + su conteo de cierre).
--   * `cash_recount_shift_atomic` (la fila del reconteo + sus líneas).
--
-- UNA FUNCIÓN POR OPERACIÓN Y NO UNA SOLA PARA LAS TRES: son tres operaciones
-- distintas, con precondiciones distintas (una caja sin turno abierto, un turno
-- abierto, un turno cerrado sin reconteo), tres resultados distintos y tres
-- llamadores distintos. Una función que hiciera las tres tendría que recibir un
-- discriminador y ramificar; eso no agrega atomicidad —cada par ya es una
-- transacción— y sí agrega superficie de error. Descartado.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * UN TRIGGER QUE INSERTE EL CONTEO AL CREAR/ACTUALIZAR EL TURNO. Sería una
--     sola sentencia y el disparador haría el resto, pero movería a SQL la
--     DECISIÓN de qué líneas se escriben (el detalle por denominación lo arma el
--     servicio desde su conteo validado) y, sobre todo, perdería la red de
--     conteo: un disparador no puede contrastar cuántas filas esperaba el
--     llamador, así que un subconjunto silencioso volvería a ser posible.
--     Además escondería el arqueo en un efecto colateral de un UPDATE.
--     Descartado.
--   * INVERTIR EL ORDEN DE LAS ESCRITURAS (los conteos primero y el turno
--     después). Cambia de lugar la ventana, no la cierra: el fallo dejaría
--     líneas de conteo de un turno que nunca se cerró —un arqueo sin cierre— y,
--     en el caso del cierre, un CAS que ya no puede ganar. Una transacción no
--     depende del orden para ser atómica; compensar sí, y por eso no se
--     compensa.
--   * UNA COMPENSACIÓN EN EL CLIENTE (revertir el UPDATE del turno si el INSERT
--     de los conteos falla). Revertir es escribir OTRA vez y volver a exponerse
--     al mismo fallo a mitad de camino: se compensa el cierre y falla la
--     compensación, y entonces queda un cierre firmado sin evidencia Y sin
--     registro de que faltaba compensarlo. La única forma de que la compensación
--     sea tan sólida como la transacción es... una transacción.
--   * UN BORRADO DEL TURNO HUÉRFANO. Además de ser destructivo (nunca se borra
--     un turno en este sistema) no resuelve nada cuando el turno tiene pagos o
--     facturas colgando de sus FK, y deja el número quemado. Descartado.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y las funciones SÓLO ESCRIBEN. Acá no se mueve NADA de
-- aritmética de dinero a SQL:
--
--   * QUÉ se cuenta —qué métodos arqueables activos y qué denominaciones
--     configuradas— y QUÉ líneas se escriben lo decide `checkCounts`
--     (TypeScript) y viaja como DATO en `p_counts`: la función escribe
--     `(item ->> 'amount')::numeric` verbatim. El `::numeric` es una CONVERSIÓN
--     de representación (jsonb → la columna), no una operación aritmética.
--   * El total por método, el total declarado, la base heredada
--     (`resolveOpeningBase`), la base dejada (`resolveClosingBase`) y los
--     derivados del cierre (`computeCashClose`: recogido y sobre) los calcula el
--     servicio y viajan como DATO.
--   * La detección de desajustes de la apertura y del cierre
--     (`expectedDigitalTotal`, `moneyEquals`, `methodDifferences`) se queda
--     donde está: en TypeScript. La función no compara declarado contra
--     esperado ni una vez.
--   * La única aritmética que la función NO hace es también la que importa: no
--     suma líneas, no resta base, no multiplica denominación por cantidad y no
--     deriva ningún total. Lo único que valida un monto es el CHECK de la tabla
--     —`cash_shifts` (006) y `cash_shift_counts` (009)—, que ya existía: una
--     barrera PREEXISTENTE que COMPRUEBA un número ajeno, no una fórmula que lo
--     produzca.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre la fila
-- BLOQUEADA, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * `assertNoOpenShift` (una caja, un turno abierto): adentro, la fila de
--     `cash_registers` se lee con `FOR UPDATE` —es el punto de serialización de
--     la caja— y, con ese lock tomado, se busca un turno `abierto` de la misma
--     caja con `FOR UPDATE`. Si existe, la transacción rechaza con
--     `SHIFT_ALREADY_OPEN` y no escribe nada. El índice único PARCIAL de 006
--     sigue siendo la barrera final de la carrera (23505), y el servicio lo
--     traduce al MISMO error de negocio, como ya hacía.
--   * El CAS del cierre (`UPDATE ... WHERE status = 'abierto'`): adentro, el
--     turno se lee con `FOR UPDATE` y su estado tiene que ser `abierto`; el
--     `UPDATE` conserva además la precondición en su propio `WHERE` y su red de
--     conteo, que es lo que hace que dos cierres concurrentes no se pisen: el
--     segundo escribe cero filas y se rechaza con `SHIFT_ALREADY_CLOSED` —el
--     mismo código que el servicio ya devolvía cuando perdía el CAS—.
--   * La precondición del conteo del cierre: el turno no se cierra sin conteo
--     de efectivo ni sin base dejada (los CHECK de 006 con `status = 'cerrado'`)
--     y el conteo de efectivo tiene que venir. El conteo se valida por FORMA
--     adentro (arreglo no vacío, una línea por método con su denominación o su
--     total, cantidades y montos de la forma que la tabla puede guardar).
--   * La precondición del reconteo (`assertCorrectablePeriod` del cierre, acá:
--     sólo un turno CERRADO se recontá): adentro, el turno se lee con
--     `FOR UPDATE` y su estado tiene que ser `cerrado`; si no, la transacción
--     rechaza con `SHIFT_NOT_CLOSED` y no escribe nada. La sede también se
--     verifica: un reconteo no se atribuye al turno de otra sede.
--   * El reconteo "uno por turno" sigue siendo el índice único de 033: una
--     carrera la detecta la propia base dentro de la transacción (23505) y el
--     servicio la traduce a ALREADY_RECOUNTED, como ya hacía. La transacción no
--     es un camino para encadenar un segundo reconteo: es el camino para que el
--     perdedor no deje NADA escrito.
--   * El conteo COMPLETO del reconteo (la misma exigencia que el cierre) se
--     conserva: la transacción no acepta un arreglo de conteo vacío ni un
--     reconteo sin efectivo. La igualdad entre el total declarado y su detalle
--     por denominación (`moneyEquals(countedFromDetail, counted_cash)`) sigue
--     siendo una regla del SERVICIO, evaluada antes de llamar: la función no
--     suma el detalle —eso sería aritmética en SQL— y se declara abajo como
--     ventana.
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS ... ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluido el grupo anterior. Es la
-- misma disciplina de 046, 047 y 048: seis redes en total, dos por función.
--
--   * El TURNO: exactamente 1 fila (el INSERT de la apertura, el UPDATE del
--     cierre, el INSERT del reconteo). Cero filas es una precondición que se
--     volvió mentira bajo los pies y el resultado es el mismo: rollback de TODO.
--   * Las LÍNEAS de conteo: exactamente `jsonb_array_length(p_counts)`. Sin esta
--     red, un arreglo que escribiera menos líneas de las recibidas —por una
--     guarda de FORMA que dejó pasar algo que la tabla rechazó, o por cualquier
--     subconjunto silencioso— dejaría el arqueo incompleto con el turno ya
--     firmado, que es exactamente el estado parcial que este archivo cierra.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA. La apertura bloquea
-- PRIMERO la fila de la caja (`cash_registers`) y después el turno abierto de
-- esa caja; el cierre y el reconteo bloquean la fila del turno. Como todas las
-- operaciones de una misma caja pasan por la fila de su caja o por la fila de su
-- turno en ese orden, dos operaciones concurrentes se bloquean en el MISMO
-- orden y la segunda espera a la primera: no hay ciclo. Las líneas de conteo se
-- insertan en orden determinista ascendente por método y denominación
-- (`ORDER BY`), aunque no compitan con nadie: pertenecen a un turno que esta
-- transacción está creando o firmando y ninguna otra transacción puede verlas
-- antes del commit.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER, igual que 039 y 046–048.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría el ciclo de caja a cualquier JWT
--     (anon/authenticated) por PostgREST: cualquiera podría abrir un turno con
--     la base que quisiera, cerrar el turno de un cajero firmando un arqueo
--     falso, o firmar un reconteo que corrige una liquidación de caja. Se cierra
--     en los pasos 3, 7 y 11: se revoca de PUBLIC, anon y authenticated, y se
--     otorga sólo a service_role. Es la misma decisión que 018 tomó para
--     `write_audit_log`, que 039 para `replace_user_roles`, que 046 para
--     `deduct_stock_atomic`, que 047 para `payroll_apply_atomic` y que 048 para
--     sus dos funciones.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos fuera de lo que la operación ya
--     escribía: sólo crea/reemplaza tres funciones y ajusta permisos. No hay
--     DELETE ni TRUNCATE en ninguna parte, y el único UPDATE es el del turno al
--     cerrarse, que es el que el servicio ya hacía.
--   * No agrega ni quita columnas, índices ni constraints: los INSERT usan las
--     columnas de 006 y 009, y los índices que importan ya existen
--     (`uq_cash_shifts_open_per_register` de 006, `uq_cash_shift_recounts_shift`
--     de 033, las PK de `cash_shifts` y `cash_registers`). No hay índice nuevo
--     que justificar ni coste de escritura nuevo que declarar.
--   * No toca `cash_shifts` en el reconteo: el cierre firmado sigue siendo
--     INMUTABLE (decisión del dueño, 033) y la versión corregida sigue viviendo
--     en `cash_shift_recounts`.
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (006) el
--     único escritor de esa columna.
--   * No toca los caminos de dinero de otros módulos: ni `invoices`, ni
--     `invoice_payments`, ni `next_invoice_number`. Este archivo no escribe una
--     sola fila de facturación ni de nómina.
--   * No backfillea ni repara lo que las tres ventanas ya dejaron a medias: ver
--     la nota operativa final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja las funciones idénticas en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado), por función:
--   1. La función. Va PRIMERO porque es el objeto que sus permisos y su
--      comentario nombran.
--   2. Su `search_path` fijo (house style desde 018): la función resuelve
--      `cash_registers`, `cash_shifts`, `cash_shift_counts` y
--      `cash_shift_recounts`, y con una ruta mutable un esquema anterior podría
--      secuestrar esos nombres.
--   3. Sus permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. Su comentario, para el que la lea desde `\df`.
--   La apertura va primero —es la que crea el turno del que las otras dos
--   dependen— y después el cierre y el reconteo, en ese orden.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 049, el siguiente libre
-- (032 no existe y no existirá; 033–048 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. Ninguna de las tablas tiene
-- serie ni consecutivo —`cash_shifts` (006), `cash_shift_counts` (009) y
-- `cash_shift_recounts` (033) usan `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`—, así que una operación abortada no deja fila y no deja
-- hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO, ni en el camino normal ni en el
-- rechazo.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * La igualdad entre el TOTAL declarado y su detalle por denominación
--     (`moneyEquals(countedFromDetail, counted_cash)`, y su mensaje
--     COUNT_MISMATCH) se queda en TypeScript: comprobarla adentro exigiría
--     SUMAR las líneas de efectivo en SQL, que es exactamente la aritmética que
--     no se mueve. La transacción conserva la parte ESTRUCTURAL de esa
--     exigencia —el conteo no puede venir vacío ni sin efectivo— y la
--     igualdad sigue siendo una regla del servicio, evaluada antes de llamar.
--   * El CONJUNTO de líneas que se escriben se decide ANTES de la transacción
--     (`checkCounts` lee los métodos arqueables y las denominaciones activas).
--     La transacción garantiza que ese conjunto se escriba ENTERO o nada; lo
--     que no cierra es que una denominación se desactive entre la lectura y la
--     escritura (el conteo ya validado se escribe igual: la denominación
--     desactivada no invalida un billete que estaba en el cajón).
--   * La LECTURA que alimenta el arqueo —pagos, cobros de factura, vales y
--     comisiones del turno— sigue separada de la escritura por el cálculo
--     entero. Eso NO se cierra alargando la transacción (haría durar los locks
--     todo el cálculo): lo que cierra es que la escritura sea indivisible y que
--     una carrera pierda ruidosamente.
--   * La AUDITORÍA (`writeAudit`) queda FUERA de las tres transacciones: es un
--     INSERT posterior y separado. No es un punto de fallo de estado
--     (`writeAudit` no lanza: registra y sigue), así que a lo sumo falta la fila
--     de auditoría, nunca una escritura a medias.
--   * El INSERT del turno y el de sus conteos van juntos, pero la CAJA
--     (`cash_registers`) que `resolveRegister` puede crear cuando la sede no
--     tiene ninguna sigue siendo un request previo y aparte. No es una ventana
--     de estado parcial: una sede con caja y sin turnos es un estado legal (y es
--     el que 006 siembra), y el turno que la sigue sí es indivisible con su
--     arqueo.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 049 va ANTES que este código. Sin las
-- funciones, la apertura, el cierre y el reconteo no pueden escribir NADA —los
-- RPC no existen y las operaciones fallan enteras ANTES de escribir, que es la
-- dirección segura: un turno que no se puede abrir no se abre a medias—, y con
-- las funciones y sin el código las tres operaciones siguen siendo las de las
-- escrituras sueltas (no hay regresión, sólo no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La APERTURA del turno y su arqueo de apertura, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, numeric, jsonb)`: la sede del actor, la caja que
-- abre, quién abre, la base con la que abre —ya resuelta por
-- `resolveOpeningBase`— y las líneas del conteo por método y denominación, ya
-- validadas por `checkCounts`. El tipo de retorno es el TURNO ESCRITO (jsonb),
-- con las MISMAS columnas que el servicio leía con `SHIFT_SELECT`: el llamador
-- no necesita otra lectura para tener la fila, y no hay ventana entre la
-- escritura y la lectura del resultado.
CREATE OR REPLACE FUNCTION public.cash_open_shift_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_register_id IS NULL
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

  -- 1.2 La CAJA, bloqueada, y su sede: es el punto de serialización de todo el
  --     ciclo de caja. A partir de acá, otra apertura, otro cierre u otro
  --     reconteo de la MISMA caja espera; y si la caja no es de la sede del
  --     actor, la transacción rechaza en vez de abrir un turno ajeno.
  PERFORM 1
    FROM public.cash_registers r
   WHERE r.id = p_register_id
     AND r.sede_id = p_sede_id
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
    (cash_register_id, sede_id, opened_by, opening_base, expected_cash, status)
  VALUES
    (p_register_id, p_sede_id, p_opened_by, p_opening_base, 0, 'abierto')
  RETURNING * INTO v_turno;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 1.5 El ARQUEO DE APERTURA: las líneas por método y denominación, con la
  --     fase que le corresponde, el turno recién creado y cada monto ESCRITO
  --     VERBATIM desde `p_counts` —acá no se multiplica denominación por
  --     cantidad ni se suma nada—. `ORDER BY` deja el orden determinista (ver
  --     "SERIALIZACIÓN" arriba).
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
  --     que este archivo cierra.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, con las MISMAS columnas que el servicio leía: eso es
  --     lo que el llamador usa como resultado, sin otra lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'sede_id', v_turno.sede_id,
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

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `cash_registers`, `cash_shifts` y `cash_shift_counts`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–048).
ALTER FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría abrir un turno de caja por PostgREST con la base
-- que quisiera. El único llamador legítimo es el cliente service_role del
-- servidor.
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb) IS
'CL-10: apertura ATÓMICA de un turno de caja (CAJ-01). Inserta el turno ABIERTO y su conteo de apertura en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la caja bloqueada primero para que el guardia de "un turno abierto por caja" (índice único parcial de 006) no pueda volverse mentira entre la lectura y la escritura. NO calcula nada: la base del turno llega resuelta por resolveOpeningBase y cada línea del conteo llega validada por checkCounts; la función las escribe verbatim. Un fallo de la escritura del turno o del arqueo —y su red de conteo, que aborta si no escribió exactamente las líneas recibidas— revierte la transacción COMPLETA: no queda un turno abierto sin su arqueo de apertura. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT; falla con SHIFT_INVALID (entrada mal formada), SHIFT_REGISTER_NOT_FOUND (la caja no es de la sede del actor), SHIFT_ALREADY_OPEN (la carrera del turno abierto, 23505), SHIFT_WRITE_MISMATCH o SHIFT_COUNT_MISMATCH. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- una apertura que ya quedó a medias por el bug anterior —un turno abierto sin
-- su conteo de apertura, y con el índice de 006 impidiendo reintentar— NO se
-- repara sola. Se reconcilia decidiendo, con quien opera la caja: completar el
-- arqueo de apertura a mano con el conteo real que se hizo (el turno ya abierto
-- lo admite: las líneas se pueden insertar en la fase `apertura`), o cerrar el
-- turno sin arqueo de apertura y reabrirlo después, con el faltante de la
-- primera base registrado en la observación. En los dos casos queda la
-- auditoría del turno como registro.

-- ===================================================================== ---
-- 5. El CIERRE del turno y su arqueo de cierre, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, jsonb, jsonb)`: la sede del actor, el turno que se
-- cierra, quién cierra, los montos y la observación YA resueltos por el
-- servicio (`expected_cash`, `counted_cash`, `base_left` de `resolveClosingBase`,
-- y `cash_withdrawn`/`base_difference` de `computeCashClose`), el instante del
-- cierre y las líneas del conteo ya validadas. El tipo de retorno es el TURNO
-- ESCRITO (jsonb) con las MISMAS columnas que el servicio leía con
-- `SHIFT_SELECT`.
CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic(
  p_sede_id uuid,
  p_shift_id uuid,
  p_closed_by uuid,
  p_closed_at timestamptz,
  p_close jsonb,
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
  v_actualizados integer;
  v_escritos integer;
BEGIN
  -- 5.1 FORMA de la entrada. Un cierre es el documento que firma un arqueo: no
  --     puede aceptar una entrada a medio formar.
  IF p_sede_id IS NULL
     OR p_shift_id IS NULL
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
  --     1.1), porque es el mismo conteo con otra fase.
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

  -- 5.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA (no
  --     del dato que mandó el llamador). `FOR UPDATE` es el idioma de la casa
  --     para tomar un lock de fila (039, 040, 047, 048): a partir de acá, otro
  --     cierre del mismo turno espera; y si el turno ya se cerró antes, esta
  --     lectura ve la versión nueva y rechaza. La sede también se verifica: un
  --     cierre no se atribuye al turno de otra sede.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
    AND s.sede_id = p_sede_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 5.3 El CIERRE del turno: el mismo `UPDATE` que hacía el servicio, con su
  --     compare-and-swap (`status = 'abierto'`) conservado en el propio `WHERE`
  --     —es lo que hace que dos cierres concurrentes no se pisen: el segundo
  --     escribe cero filas—, y cada monto ESCRITO VERBATIM desde `p_close`. Acá
  --     no se suma, no se resta y no se recalcula nada: el recogido, la base
  --     dejada y el sobre llegan resueltos por `resolveClosingBase` y
  --     `computeCashClose` (TypeScript).
  --
  --     La observación entra tal como llegó (el servicio ya la normalizó a NULL
  --     cuando venía vacía). El CHECK de 006
  --     (`expected_cash >= 0`) NO se replica acá a propósito: es la regla de
  --     negocio que el servicio traduce a CASH_OUT_EXCEEDS_COLLECTED, y este
  --     archivo no la reemplaza ni la adelanta.
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
     AND s.sede_id = p_sede_id
     AND s.status = 'abierto'
  RETURNING * INTO v_turno;

  -- 5.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y
  --     el llamador recibe el MISMO error de negocio que ya recibía cuando
  --     perdía el CAS en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 5.5 El ARQUEO DE CIERRE: las líneas por denominación, con la fase que le
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

  -- 5.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el cierre incluido. Es lo que separa "el
  --     cierre no se pudo firmar" de "el cierre quedó firmado sin su evidencia"
  --     —y este último, con el CAS, ya no se podría volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 5.7 El turno ESCRITO, tal como quedó en la tabla, con las mismas columnas
  --     que el servicio leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'sede_id', v_turno.sede_id,
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

-- ------------------------------------------- 6. search_path fijo ---
-- La función resuelve `cash_shifts` y `cash_shift_counts`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039 y 046–048).
ALTER FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ 7. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cerrar el turno de un cajero firmando un arqueo
-- con los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) TO service_role;

-- --------------------------------------------- 8. Documentación ---
COMMENT ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb) IS
'CL-10: cierre ATÓMICO de un turno de caja (CAJ-03/CAJ-04). Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- un cierre que ya quedó firmado SIN su conteo por el bug anterior NO se repara
-- solo y no se puede reintentar (el CAS sólo pisa turnos abiertos). Se
-- reconcilia a mano, con decisión de quien opera la base: si el conteo físico
-- del cierre todavía existe, se insertan sus líneas en `cash_shift_counts` con
-- la fase `cierre` (es la evidencia que faltaba y la tabla no tiene una guarda
-- que lo impida); si el conteo ya no se puede reconstruir, se recontá el cierre
-- (033) para dejar una versión corregida CON su detalle, y el cierre original
-- queda como el registro de lo que se firmó sin respaldo. En los dos casos
-- queda la auditoría (`cash.shift_closed`) como registro del cierre original.

-- ===================================================================== ---
-- 9. El RECONTEO de un cierre y su detalle, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, jsonb, jsonb)`: la sede del actor, el turno cerrado
-- que se recontá, quién recontó, las DOS VERSIONES ya resueltas por
-- `buildRecountRecord` (la anterior congelada y la corregida, con el motivo) y
-- las líneas del conteo nuevo, ya validadas por `checkCounts`. El tipo de
-- retorno es el RECONTEO ESCRITO (jsonb) con las MISMAS columnas que el
-- servicio leía con `RECOUNT_SELECT`.
CREATE OR REPLACE FUNCTION public.cash_recount_shift_atomic(
  p_sede_id uuid,
  p_shift_id uuid,
  p_recounted_by uuid,
  p_recount jsonb,
  p_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_reconteo public.cash_shift_recounts;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 9.1 FORMA de la entrada. Un reconteo firma una versión CORREGIDA de un
  --     cierre ya firmado: no puede aceptar una entrada a medio formar.
  IF p_sede_id IS NULL
     OR p_shift_id IS NULL
     OR p_recounted_by IS NULL
     OR p_recount IS NULL
     OR jsonb_typeof(p_recount) <> 'object'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las DOS VERSIONES: los cuatro montos del cierre firmado (congelados) y
  --     los cuatro del reconteo, más el motivo. Las claves ausentes se rechazan
  --     por el mismo `coalesce` de las otras dos funciones. Las dos
  --     `*_base_difference` (un faltante de base) y los dos `*_cash_withdrawn`
  --     (una diferencia entre lo contado y la base dejada) admiten el signo: la
  --     tabla no les exige ser no negativos y el reconteo existe justamente para
  --     corregir un cierre, así que no puede rechazar la versión que va a
  --     corregir. `*_counted_cash` y `*_base_left` no lo admiten: el CHECK de
  --     006 los exige no negativos y su copia congelada también lo es.
  IF btrim(coalesce(p_recount ->> 'reason', '')) = ''
     OR coalesce(p_recount ->> 'previous_counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo nuevo: la misma guarda de forma del cierre (ver
  --     5.1). El conteo del reconteo tiene que ser COMPLETO, como el del cierre:
  --     la transacción no acepta un arreglo vacío, así que el reconteo no puede
  --     quedar firmado sin el detalle que lo respalda.
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

  --     El conteo tiene que traer el EFECTIVO: un reconteo sin efectivo no es un
  --     reconteo de la caja (y el total declarado no tendría contra qué
  --     cuadrar). Es la parte estructural de la exigencia de conteo completo; la
  --     igualdad entre el total y su detalle la comprueba el servicio antes de
  --     llamar (ver "VENTANAS DECLARADAS" arriba).
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    WHERE item ->> 'method_code' = 'efectivo'
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 9.2 El TURNO, bloqueado, y sus dos precondiciones leídas de LA FILA: la sede
  --     (un reconteo no se atribuye a un turno ajeno) y el estado —sólo un turno
  --     CERRADO se recontá: un turno abierto no tiene cierre que corregir—.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
    AND s.sede_id = p_sede_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'cerrado' THEN
    RAISE EXCEPTION 'SHIFT_NOT_CLOSED';
  END IF;

  -- 9.3 El reconteo "uno por turno" (033), re-evaluado adentro con el turno YA
  --     bloqueado. El índice único `uq_cash_shift_recounts_shift` sigue siendo la
  --     barrera final si dos reconteos llegaran a evaluar esto a la vez, y el
  --     `23505` que levanta lo traduce el servicio al MISMO error de negocio
  --     (ALREADY_RECOUNTED). Un reconteo no se encadena: la corrección también
  --     queda firmada.
  PERFORM 1
    FROM public.cash_shift_recounts r
   WHERE r.shift_id = p_shift_id
   ORDER BY r.id
   FOR UPDATE OF r;

  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_RECOUNTED';
  END IF;

  -- 9.4 El RECONTEO: UNA sentencia, y por eso UNA transacción con su detalle de
  --     abajo. Las DOS versiones entran VERBATIM desde `p_recount` —la anterior
  --     congelada y la corregida, con el motivo—, y `recounted_at` queda para su
  --     DEFAULT. Acá no se suma, no se resta y no se recalcula nada: la versión
  --     corregida llega resuelta por `resolveClosingBase` y `computeCashClose`
  --     dentro de `buildRecountRecord` (TypeScript).
  INSERT INTO public.cash_shift_recounts
    (shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn,
     previous_base_difference, counted_cash, base_left, cash_withdrawn,
     base_difference, reason, recounted_by)
  VALUES (
    p_shift_id,
    (p_recount ->> 'previous_counted_cash')::numeric,
    (p_recount ->> 'previous_base_left')::numeric,
    (p_recount ->> 'previous_cash_withdrawn')::numeric,
    (p_recount ->> 'previous_base_difference')::numeric,
    (p_recount ->> 'counted_cash')::numeric,
    (p_recount ->> 'base_left')::numeric,
    (p_recount ->> 'cash_withdrawn')::numeric,
    (p_recount ->> 'base_difference')::numeric,
    p_recount ->> 'reason',
    p_recounted_by
  )
  RETURNING * INTO v_reconteo;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 9.5 El DETALLE por denominación, en la MISMA tabla del arqueo (009), en la
  --     fase `reconteo` (033). Es lo que hace que la versión corregida tenga
  --     tanta evidencia como el cierre que corrige: sin estas líneas, el
  --     reconteo firmaría dos versiones que ningún conteo respalda.
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    p_shift_id,
    'reconteo',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 9.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el reconteo incluido. Es lo que separa "el
  --     reconteo no se pudo firmar" de "el reconteo quedó firmado sin su
  --     detalle" —y este último, con el índice único de 033, ya no se podría
  --     volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 9.7 El reconteo ESCRITO, tal como quedó en la tabla (con su `id` y su
  --     `recounted_at` del DEFAULT), con las mismas columnas que el servicio
  --     leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_reconteo.id,
    'shift_id', v_reconteo.shift_id,
    'previous_counted_cash', v_reconteo.previous_counted_cash,
    'previous_base_left', v_reconteo.previous_base_left,
    'previous_cash_withdrawn', v_reconteo.previous_cash_withdrawn,
    'previous_base_difference', v_reconteo.previous_base_difference,
    'counted_cash', v_reconteo.counted_cash,
    'base_left', v_reconteo.base_left,
    'cash_withdrawn', v_reconteo.cash_withdrawn,
    'base_difference', v_reconteo.base_difference,
    'reason', v_reconteo.reason,
    'recounted_by', v_reconteo.recounted_by,
    'recounted_at', v_reconteo.recounted_at
  );
END;
$$;

-- ------------------------------------------- 10. search_path fijo ---
-- La función resuelve `cash_shifts`, `cash_shift_recounts` y
-- `cash_shift_counts`; con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018 (y el mismo paso que dan
-- 039 y 046–048).
ALTER FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ 11. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría firmar un reconteo que corrige la caja de su sede
-- (o de otra, si no se filtrara la sede) por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

-- --------------------------------------------- 12. Documentación ---
COMMENT ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb) IS
'CL-10: reconteo ATÓMICO de un cierre (U3, 033). Inserta la fila de cash_shift_recounts —las DOS versiones, el motivo y quién— y su detalle por denominación en cash_shift_counts (fase reconteo) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: la versión anterior congelada y la corregida llegan resueltas por buildRecountRecord (resolveClosingBase + computeCashClose + signedAmounts) y se escriben verbatim; la aritmética del arqueo vive en TypeScript. Conserva las precondiciones del servicio: sólo un turno CERRADO (SHIFT_NOT_CLOSED) y de la sede del actor, y el índice único por turno de 033 (23505 → ALREADY_RECOUNTED) adentro de la transacción; el conteo tiene que traer el efectivo y no puede venir vacío. NO toca cash_shifts: el cierre firmado sigue siendo inmutable. Sus redes de conteo abortan con SHIFT_WRITE_MISMATCH si no escribió exactamente un reconteo y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un reconteo firmado sin su detalle. Devuelve el reconteo escrito con las mismas columnas de RECOUNT_SELECT. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- un reconteo que ya quedó firmado SIN su detalle por el bug anterior NO se
-- repara solo y no se puede reintentar (el índice único por turno responde
-- ALREADY_RECOUNTED). Se reconcilia a mano, con decisión de quien opera la base:
-- si el conteo del reconteo todavía existe, se insertan sus líneas en
-- `cash_shift_counts` con la fase `reconteo` (es el detalle que faltaba); si no,
-- la fila del reconteo queda como el registro de que se corrigió sin dejar
-- evidencia, y la versión que gobierna (`cash_shift_recounts`) se decide contra
-- el conteo del cierre firmado. En los dos casos queda la auditoría
-- (`cash.shift_recounted`) como registro.
