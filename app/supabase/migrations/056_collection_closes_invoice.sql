-- 056_collection_closes_invoice.sql — CL-17: los DOS huecos que le quedaban al
-- COBRO de una factura —el CIERRE sin sus datos de cierre y el TURNO que puede
-- cerrarse a mitad del cobro— dejan de poder existir.
--
-- MOTIVO DEL ARCHIVO (los dos huecos, medidos)
--
-- El barrido de atomicidad encontró, ya con las transacciones de la casa puestas
-- (046–053), DOS defectos SUPERSTITES que las migraciones anteriores no tocaron
-- porque cierran OTRA clase de ventana: no son una escritura a medias (eso ya lo
-- resolvió la 053 para este camino), son una escritura COMPLETA con el contenido
-- equivocado y una escritura COMPLETA que cae en un turno que ya no la admite.
--
--   a) EL CIERRE SIN SUS DATOS DE CIERRE. `053` cerró la ventana de atomicidad
--      del cobro de caja, pero CONSERVÓ a propósito los mismos campos que
--      escribía el UPDATE suelto del servicio: `cash_shift_id` y `status`. NO
--      escribe `closed_by` ni `closed_at` —su sección "LA ASIMETRÍA QUE SE
--      CONSERVA" lo declara— y la consecuencia es una factura `Pagada` con
--      `closed_at` en NULL. Eso CONTRADICE el contrato que la columna tiene
--      escrito en el esquema: `025_invoice_closed_at.sql` documenta
--      `closed_at` como "Fecha/hora de cierre de la factura: cuando se completó
--      el pago (Pagada) o se anuló (Anulada). NULL si sigue Emitida." Una
--      factura cobrada por caja queda `Pagada` con `closed_at` NULL, así que
--      cualquier lector que muestre la fecha de cierre —la columna "Cerrada" del
--      listado— muestra un guion sobre una factura CERRADA. Y el mismo camino
--      cobrado por el COBRO DIVIDIDO (`050`) sí escribe los dos campos, así que
--      la misma operación de negocio deja el mismo estado por dos caminos con
--      dos contenidos distintos. Lo que se midió, verbatim, con el código previo
--      a este archivo (factura de 100000 cobrada completa por caja):
--
--          expected null not to be null   (invoices.closed_at)
--
--   b) EL TURNO QUE SE CIERRA A MITAD DEL COBRO. El `registerPayment` de caja y
--      el `splitPayment` de facturación leen el TURNO antes de llamar (que
--      exista, que esté `abierto`, que sea de la sede del actor) y después
--      escriben sus filas de dinero con ese `cash_shift_id` —es un parámetro
--      explícito en `053` y viaja en cada porción en `050`—. Entre esa lectura y
--      el commit cabe un `closeShift` (049) o un `recountClosedShift` (049), que
--      bloquean la fila del turno y lo pasan a `cerrado`. La transacción del
--      cobro NO mira el turno: la FK de `invoice_payments.cash_shift_id` /
--      `payments.cash_shift_id` hacia `cash_shifts` toma un lock `FOR KEY SHARE`
--      sobre la fila referenciada, y ese lock NO compite con el
--      `FOR NO KEY UPDATE` que toma el UPDATE del cierre —y menos con su
--      `SELECT ... FOR UPDATE` explícito—, así que el cobro gana la carrera y
--      escribe su fila de dinero (y cierra la factura) en un turno que YA se
--      cerró: el arqueo FIRMADO de ese turno no lo cuenta, y el dinero queda
--      atribuido a un turno cerrado. La `053` declaró esta ventana con su costo
--      ("EL ESTADO DEL TURNO se lee en el SERVICIO"), y este archivo la cierra.
--      Lo que se midió, verbatim, con el código previo a este archivo:
--
--          expected [ { …(10) } ] to deeply equal []   (payments del turno, con
--                                                        el turno ya `cerrado`)
--
-- MECANISMO (dos funciones reemplazadas, y por qué las mismas dos)
--
-- La respuesta de la casa a "PostgREST no tiene transacción multi-statement" es
-- una FUNCIÓN SQL llamada por `db.rpc(...)` (005, 039–053). Este archivo NO crea
-- operaciones nuevas: REEMPLAZA las DOS funciones de cobro que ya existen para
-- que hagan DOS cosas más —escribir el cierre y bloquear el turno—, porque los
-- dos huecos viven exactamente en esas dos transacciones:
--
--   * `cash_invoice_payment_atomic` (cobro de caja, 053): su grupo 3 pasa a
--     escribir `closed_by`/`closed_at` cuando cierra la factura; y su paso 1.2
--     pasa a bloquear el turno antes de tocar la factura.
--   * `invoice_split_payment_atomic` (cobro dividido, 050): su paso 5.2 pasa a
--     bloquear el turno antes de tocar la factura. Sus datos de cierre YA se
--     escribían (5.5) y no cambian.
--
-- UNA FUNCIÓN POR OPERACIÓN Y NO UNA SOLA PARA LAS DOS: son dos operaciones
-- distintas, con llamadores distintos (caja y facturación), grupos de escritura
-- distintos (el cobro de caja escribe el libro de cajón `payments`, el dividido
-- no) y contratos distintos (el de caja acepta montos PARCIALES; el dividido
-- exige el saldo EXACTO con N porciones). Fusionarlas agregaría un discriminador
-- y un permiso compartido entre dos operaciones de dinero que hoy no comparten
-- nada. Descartado, igual que lo descartaron 050 y 053.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * UN TRIGGER QUE ESCRIBA `closed_at` AL PASAR A `Pagada`. Sería una sola
--     sentencia, pero movería a SQL la DECISIÓN de que la factura se cierra y,
--     peor, el INSTANTE del cierre: un disparador tendría que elegir un reloj
--     propio (el de la base) distinto del que eligen el cierre de turno (049),
--     la anulación (050) y el cobro dividido (050), que es el del SERVICIO.
--     Eso parte en dos el significado de `closed_at` según el camino que la
--     escribió. Descartado.
--   * UN CHECK o una FK que impida `Pagada` con `closed_at` NULL. No cierra el
--     hueco: convierte el cierre incompleto en un fallo de la transacción, pero
--     la transacción seguiría SIN escribir el dato, así que el cobro legítimo
--     empezaría a fallar. Un CHECK no produce el valor que falta. Descartado.
--   * `closed_at = now()` DENTRO DE LA FUNCIÓN (el reloj de la base) para no
--     cambiar la firma. Es la alternativa real y se evaluó en serio (ver "QUÉ
--     RELOJ"): se descartó porque dejaría a la caja con un reloj y al cobro
--     dividido, a la anulación y al cierre de turno con otro. El instante del
--     cierre es un DATO que el llamador resuelve, como ya lo resuelve en 049 y
--     050; la función sólo lo escribe.
--   * BLOQUEAR EL TURNO CON `FOR UPDATE` EN VEZ DE `FOR SHARE`. Cerraría la
--     ventana igual, pero serializaría TODOS los cobros de un mismo turno entre
--     sí (dos cajas pueden cobrar facturas DISTINTAS en el mismo turno) sin
--     necesidad. `FOR SHARE` compite con el cierre —que toma `FOR UPDATE`— y NO
--     compite con otro cobro. Descartado por costo, no por corrección.
--   * `FOR KEY SHARE` (el lock que ya toma la FK). NO cierra nada: es
--     precisamente el lock que hoy no excluye al cierre. Descartado.
--
-- QUÉ RELOJ PARA `closed_at`, Y POR QUÉ (decisión explícita)
--
-- El instante lo resuelve el SERVICIO (`new Date().toISOString()`) y viaja como
-- DATO en el parámetro `p_closed_at`; la función lo escribe VERBATIM. Es la
-- MISMA decisión que ya tomaron el cierre de turno (049), la anulación (050) y el
-- cobro dividido (050), que reciben `p_closed_at` y lo escriben tal cual, y por
-- eso la columna significa lo mismo en los tres caminos. Lo que cambia
-- respecto de la 053 es, exactamente, que el cobro de caja pasa a pedir el
-- instante que antes no pedía; lo que NO cambia es el reloj del sistema: la
-- fecha sigue siendo la del servidor de la aplicación, la que acompaña al
-- `writeAudit` posterior y la que el llamador puede devolver en la respuesta.
-- Renunciar a esto y usar `now()` habría dejado a `closed_at` con dos relojes
-- distintos según el camino, que es una inconsistencia silenciosa y permanente
-- en un dato que se lista y se audita.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y las funciones SÓLO ESCRIBEN. Las TRES comprobaciones de
-- que NO se movió aritmética de dinero a SQL son las mismas que dejaron escritas
-- 050 y 053, y se conservan una por una:
--
--   (1) EL BRUTO Y EL RECARGO. El monto sigue siendo el BRUTO ya redondeado por
--       el servicio (`roundMoney` / `computeCardFees`) y el reparto por método
--       (neto, porcentaje, recargo) sigue viajando como DATO dentro de
--       `p_collection` / `p_portions`. Cada columna se escribe VERBATIM —el
--       `::numeric` y el `::uuid` son CONVERSIONES de representación
--       (jsonb → la columna), no operaciones— y no hay en ninguna de las dos
--       funciones una sola suma, resta, producto ni redondeo sobre un monto.
--       Este archivo AGREGA un `CASE WHEN p_mark_paid THEN … ELSE i.closed_at`,
--       que es una SELECCIÓN entre dos valores ya resueltos (el dato que llegó y
--       la columna que ya estaba), no un cálculo: no hay aritmética nueva.
--   (2) EL SALDO Y EL TOPE DE 031. La comprobación de que el cobro no se pasa
--       del neto facturado sigue siendo del SERVICIO antes de llamar
--       (`invoiceNetBalance`: `netCollected + net − netBilled > 0.009` en caja;
--       `moneyEquals(netSum, netRemaining)` en el dividido). Ninguna de las dos
--       funciones lee `invoices.total` ni `invoices.surcharge` para compararlos
--       con nada: la única barrera de tope que corre adentro es la PREEXISTENTE
--       de la base (`trg_invoice_payments_cap`, 031), que COMPRUEBA un número
--       ajeno, con su SQLSTATE (P0001) intacto.
--   (3) LA DECISIÓN `Pagada` Y LOS DATOS DE CIERRE. No hay UNA SOLA comparación
--       del cobrado contra el facturado en ninguna de las dos funciones: la
--       decisión llega como el booleano `p_mark_paid` (caja:
--       `moneyEquals(roundMoney(netCollected + cardFee.net), netBilled)`;
--       dividido: `fullyPaid && status === 'Emitida'`). El `closed_by` es el
--       `p_user_id` que el actor ya trae y el `closed_at` es el `p_closed_at`
--       del servicio: los dos son DATOS, no derivaciones.
--
-- Se quedan donde están, además: la marca de la 042 (su lookup, ANTES de
-- cualquier escritura, y su forma en la primera porción del dividido), la
-- normalización del bruto y del `fee_percent`, el rechazo de la factura anulada
-- y del método inactivo, el candado de nómina cerrada y el tope declarado en el
-- esquema del servicio.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre las filas
-- BLOQUEADAS, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * El TURNO: se lee `FOR SHARE` y su estado tiene que ser `abierto`. Es la
--     guarda NUEVA de este archivo y la que cierra el hueco (b). El servicio ya
--     la revisa antes (caja: `if (shift.status !== "abierto")`; facturación: el
--     turno abierto de la sede), y acá se vuelve a comprobar sobre la fila
--     BLOQUEADA, que es lo único que la hace verdadera al momento del commit. Si
--     el turno no está, rechaza `SHIFT_NOT_FOUND`; si está pero cerrado,
--     `SHIFT_CLOSED`.
--   * La FACTURA: se lee `FOR UPDATE` —es el punto de serialización del dinero
--     de esa factura, el mismo lock que toma el tope de 031 y las 050— y una
--     factura `Anulada` se rechaza con `ANNUL_INVALID`, como ya hacían las dos
--     funciones.
--   * La forma de la marca del intento (042) en `p_portions` sigue siendo una
--     premisa y se exige por FORMA (a lo sumo una porción marcada). Nueva acá:
--     la premisa de que TODAS las porciones pertenecen al TURNO que la operación
--     bloquea (`cash_shift_id = p_shift_id`), para que el lock del turno cubra
--     exactamente los turnos que las filas van a referenciar.
--   * El tope de cobro (031) y el índice único parcial de identidad (042) NO se
--     replican: son barreras de la BASE y siguen corriendo dentro de las dos
--     transacciones con su propio SQLSTATE (P0001 y 23505).
--
-- LAS REDES DE CONTEO (una por grupo de escritura) NO CAMBIAN
--
-- Se conservan las mismas redes de 050 y 053 —dos y tres respectivamente—, con
-- los mismos códigos (`PAYMENT_MISMATCH`) y la misma consecuencia (rollback
-- entero). Este archivo no agrega ni quita ninguna: el grupo de cierre de caja
-- sigue corriendo SÓLO cuando el servicio lo decidió (`p_set_shift` o
-- `p_mark_paid`) y sigue exigiendo exactamente UNA factura actualizada.
--
-- SERIALIZACIÓN: ORDEN GLOBAL DE LOCKS (declarado, y por qué no hay ciclo)
--
-- El orden global de este sistema queda así, de mayor a menor:
--
--     cash_registers  >  cash_shifts  >  invoice_sequences  >  invoices  >  products
--
-- Cada operación toma los locks de SU subconjunto SIEMPRE en ese orden, así que
-- ninguna puede quedar esperando a otra en sentido contrario y no hay ciclo:
--
--   * APERTURA DE TURNO (049): `cash_registers` (`FOR UPDATE`) y después el
--     turno abierto de esa caja (`FOR UPDATE`). No toca facturas.
--   * CIERRE y RECONTEO (049): `cash_shifts` (`FOR UPDATE`). NO tocan facturas
--     —el arqueo lo computa el SERVICIO, antes de la transacción, con SELECTs
--     sin lock—, así que una operación que sólo toma el turno nunca espera por
--     una factura.
--   * EMISIÓN (052): `cash_shifts` (`FOR UPDATE`) y después `invoice_sequences`
--     (dentro de `next_invoice_number`, 005), y después la factura NUEVA (un
--     INSERT, que no bloquea ninguna fila existente de `invoices`) y el stock.
--     Es el PRECEDENTE del orden que este archivo declara: la emisión ya tomaba
--     el turno antes que nada de facturación.
--   * COBRO (este archivo): `cash_shifts` (`FOR SHARE`) y DESPUÉS `invoices`
--     (`FOR UPDATE`), y después las filas hijas del dinero. Antes de la 056 el
--     orden empezaba en la factura; ahora empieza en el turno, que es lo que lo
--     alinea con el orden global y hace que el turno sea el segundo punto de
--     serialización del cobro.
--   * ANULACIÓN (050): `invoices` (`FOR UPDATE`) y después `products` (el orden
--     determinista del trigger de stock de 004). No toca turnos, así que su
--     subconjunto (factura, después productos) respeta el orden global.
--   * COBRO DIVIDIDO (este archivo): `cash_shifts` (`FOR SHARE`) y después
--     `invoices` (`FOR UPDATE`).
--
-- POR QUÉ NO PUEDE HABER DEADLOCK, contra cada contraparte:
--   * Contra `closeShift` / `recountClosedShift` (que toman `FOR UPDATE` sobre
--     el turno y nada más): el cobro toma `FOR SHARE` sobre el turno PRIMERO, y
--     `FOR SHARE` compite con `FOR UPDATE`. Si el cierre llegó antes, el cobro
--     espera, y cuando el cierre commitea el cobro RELEE la fila y ve `cerrado`,
--     así que rechaza. Si el cobro llegó antes, el cierre espera; el cobro nunca
--     necesita nada que el cierre tenga (el cierre no toca facturas), así que
--     termina y libera. En ningún caso hay un ciclo: el cierre sólo tiene
--     recursos de "más arriba" en el orden global.
--   * Contra la EMISIÓN (052), que toma el turno con `FOR UPDATE`: el emisor y el
--     cobrador se serializan en el turno, en el MISMO orden (turno primero), y
--     el emisor no espera por una factura EXISTENTE (inserta una nueva), así que
--     tampoco hay ciclo. El emisor y el cobrador pueden ser de la misma caja: se
--     esperan, no se traban.
--   * Contra el TOPE DE 031 (que toma `FOR UPDATE` sobre la FACTURA dentro del
--     INSERT): el cobro ya tiene el lock de la factura cuando inserta, así que
--     el lock del trigger es reentrante (misma transacción) y no espera a nadie.
--   * Contra otro COBRO de la MISMA factura: los dos van turno → factura, así
--     que el segundo espera al primero en el MISMO orden.
--   * Contra otro COBRO de la MISMA caja en facturas DISTINTAS: los dos toman
--     `FOR SHARE` del mismo turno (compatible) y después cada uno su factura
--     (distinta). No se bloquean entre sí.
--   * Contra la ANULACIÓN (que toma la factura y después los productos): la
--     anulación nunca toma el turno, así que no puede quedarse con el turno
--     mientras espera una factura que un cobro tenga.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER, igual que 039 y 046–053.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría las dos operaciones a cualquier JWT
--     (anon/authenticated) por PostgREST: cualquiera podría cobrar una factura
--     de una sede, cerrarla, y escribir su dinero en el turno que quisiera (el
--     turno viaja como parámetro). Se cierra en los pasos de permisos de cada
--     función: se revoca de PUBLIC, anon y authenticated, y se otorga sólo a
--     service_role. Es la misma decisión que 018 tomó para `write_audit_log`,
--     que 039 para `replace_user_roles`, que 046 para `deduct_stock_atomic`,
--     que 047 para `payroll_apply_atomic` y que 048–053 para sus funciones.
--
-- POR QUÉ HAY `DROP FUNCTION` (y por qué es imprescindible)
--
-- Las dos funciones CAMBIAN DE FIRMA: el cobro de caja gana `p_closed_at` (el
-- instante del cierre) y el cobro dividido gana `p_shift_id` (el turno que la
-- operación bloquea y al que pertenecen sus porciones). PostgreSQL identifica
-- una función por su firma, así que `CREATE OR REPLACE` de la firma NUEVA deja
-- la firma VIEJA como una SOBRECARGA distinta, viva y ejecutable: quedaría un
-- cobro sin lock de turno y sin datos de cierre, alcanzable por nombre por
-- cualquiera con EXECUTE, y PostgREST resolvería el RPC con un overload
-- ambiguo. Por eso se DROPean las dos firmas viejas explícitamente, con
-- `IF EXISTS` (idempotente). Es un DROP de OBJETOS (funciones reemplazadas), no
-- de datos: no hay un solo DELETE ni TRUNCATE acá, y ninguna fila de ningún
-- turno, factura o pago se toca ni se reescribe.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: los `DROP FUNCTION IF EXISTS` de la firma vieja
-- son no-ops en la segunda corrida (ya no existen), `CREATE OR REPLACE FUNCTION`
-- deja las funciones idénticas con la misma firma y el mismo tipo de retorno, y
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. Los DOS `DROP FUNCTION IF EXISTS` de las firmas viejas, primero: si el
--      CREATE fuera antes, la sobrecarga vieja seguiría viva entre las dos
--      sentencias (no observable: la migración es una transacción, pero el
--      archivo se lee de arriba abajo y el orden tiene que explicarse solo).
--   2. La función `cash_invoice_payment_atomic` (cobro de caja).
--   3. Su `search_path` fijo (house style desde 018): resuelve `invoices`,
--      `invoice_payments`, `payments` y —nuevo— `cash_shifts`, y con una ruta
--      mutable un esquema anterior podría secuestrar esos nombres.
--   4. Sus permisos, y su comentario.
--   5. La función `invoice_split_payment_atomic` (cobro dividido), con sus
--      pasos 6, 7 y 8 (search_path, permisos, comentario).
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 056, asignado a esta unidad
-- (032 no existe y no existirá; 033–055 están tomados o asignados: la 052 y la
-- 054 son de otras unidades y la 057 está en vuelo en otra). No se reutiliza
-- ningún número y no se renombra ningún archivo anterior. Ninguna de las tablas
-- tiene serie ni consecutivo —`invoices` e `invoice_payments` (005), `payments`
-- (006) y `cash_shifts` (006) usan `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`—, así que una transacción abortada no deja fila y no deja
-- hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO: el consecutivo de la FACTURA
-- (`next_invoice_number`, 005) no pasa por acá —estas funciones cobran, no
-- emiten—. Y el `DROP FUNCTION` de una sobrecarga no quema nada: no hay serie de
-- funciones.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * EL ARQUEO DEL CIERRE sigue computándose en el SERVICIO, antes de la
--     transacción del cierre (049). Con el lock nuevo, el cobro commitea ANTES
--     de que el cierre tome `FOR UPDATE` del turno —el cierre espera—, pero los
--     números del arqueo (`expected_cash`, las diferencias por método) YA se
--     calcularon sobre una foto anterior: un cobro que commiteó después de esa
--     foto no entra en el arqueo firmado. Es una ventana DISTINTA a la que este
--     archivo cierra (acá se cierra que el cobro escreiba su fila en un turno ya
--     cerrado) y repararla exigiría recalcular el arqueo DENTRO de la
--     transacción del cierre, con el turno bloqueado —un cambio de forma y de
--     coste de la 049, con su propia unidad—. Queda declarada con su costo.
--   * La LECTURA que alimenta las dos operaciones (el detalle de la factura, el
--     saldo, los métodos activos, el turno) sigue separada de la escritura: eso
--     NO se cierra alargando la transacción (haría durar los locks todo el
--     cálculo). Lo que cierra es que la ESCRITURA sea indivisible, que el turno
--     se revalide sobre la fila bloqueada y que una carrera pierda ruidosamente
--     (`SHIFT_CLOSED`, `ANNUL_INVALID`, el tope de 031, el 23505 de la marca).
--   * La AUDITORÍA (`writeAudit`) queda FUERA de las dos transacciones: es un
--     INSERT posterior y separado. No es un punto de fallo de estado
--     (`writeAudit` no lanza: registra y sigue), así que a lo sumo falta la fila
--     de auditoría, nunca una escritura a medias (es el mismo límite declarado en
--     049–053).
--   * La igualdad EXACTA entre lo cobrado y el neto facturado (`moneyEquals`) y
--     la cota del tope de 031 del servicio se quedan en TypeScript (ver "LA
--     DIVISIÓN DE RESPONSABILIDADES"): comprobarlas adentro exigiría sumar y
--     comparar dinero en SQL, que es exactamente la aritmética que no se mueve.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 056 va ANTES que este código. Sin las funciones
-- NUEVAS, los RPC no existen con la firma que el código nuevo pide (y las
-- firmas viejas se dropean), así que los dos cobros fallan ENTEROS ANTES de
-- escribir, que es la dirección segura: un cobro que no se puede registrar no
-- deja dinero cobrado, ni una factura cerrada a medias, ni una fila en un turno
-- equivocado. Con las funciones nuevas y sin el código nuevo, los dos cobros
-- fallan por parámetro faltante (`p_closed_at` / `p_shift_id`) —también antes de
-- escribir—; no hay regresión de estado, sólo indisponibilidad hasta que el
-- despliegue del código termine. La ventana del despliegue es, por eso, un
-- rechazo ruidoso, nunca una escritura a medias.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 0. Las firmas VIEJAS se dropean (ver "POR QUÉ HAY DROP FUNCTION")
-- ===================================================================== ---
DROP FUNCTION IF EXISTS public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb);
DROP FUNCTION IF EXISTS public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb);

-- ===================================================================== ---
-- 1. El COBRO de caja: espejo + libro de cajón + estado, con el TURNO
--    bloqueado y con los datos de cierre escritos
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb)`: la sede
-- del actor, el TURNO que cobra, la factura que se cobra, quién cobra, el
-- instante del cierre —resuelto en el servicio, como en 049 y 050—, SI la
-- factura se enlaza al turno (`p_set_shift`), SI queda `Pagada` (`p_mark_paid`)
-- —las dos decisiones del servicio, ya tomadas— y el cobro en sí
-- (`p_collection`), ya computado: `{method_id, method_code, amount, fee_percent,
-- fee_amount, idempotency_key}`.
--
-- El tipo de retorno NO cambia: `{payment, invoice}` —la fila del libro de cajón
-- escrita (columnas de `PAYMENT_SELECT`) y el estado que quedó la factura—. Lo
-- único que el llamador ve distinto es que la factura pudo quedar `Pagada` con
-- su `closed_by`/`closed_at` escritos (Gap 1).
CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_shift_id IS NULL
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
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" en la cabecera). `FOR
  --     SHARE` es la fuerza elegida: compite con el `FOR UPDATE` que el cierre
  --     (049) toma sobre esta MISMA fila —así un cierre que llegó primero hace
  --     que esta lectura espere y después vea `cerrado`, y un cierre que llega
  --     después espera a este cobro— y NO compite con otro cobro del mismo turno
  --     (dos cajas cobrando facturas distintas en el mismo turno no se
  --     serializan entre sí). `FOR KEY SHARE` no serviría: es exactamente el lock
  --     que la FK toma hoy y el que NO excluye al cierre.
  --
  --     La sede también se verifica: un cobro no se atribuye al turno de otra
  --     sede. El estado se mira DESPUÉS del lock y sobre LA FILA (no sobre el
  --     dato que mandó el llamador): es la precondición que el servicio ya
  --     revisó, releída donde es verdadera.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
    AND s.sede_id = p_sede_id
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
  --     —el tope de 031 toma ESTE MISMO lock— o una anulación (050) esperan. La
  --     sede también se verifica: un cobro no se atribuye a la factura de otra
  --     sede.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
    AND i.sede_id = p_sede_id
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
  --     servicio resolvió, la sede del actor y el usuario que cobró —el único
  --     rastro de quién cobró (PRD §9.1)—. `idempotency_key` se escribe NULL A
  --     PROPÓSITO (043): la identidad de este camino vive en la fila espejo, y
  --     marcar las dos mezclaría en un mismo índice las marcas de dos caminos
  --     distintos. `created_at` no se toca: lo pone el DEFAULT de 006.
  INSERT INTO public.payments
    (sede_id, cash_shift_id, invoice_id, method_id, method_code, amount, user_id,
     idempotency_key)
  VALUES
    (p_sede_id,
     p_shift_id,
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
  --     factura se CIERRA (`p_mark_paid`) —Gap 1 de este archivo—: el responsable
  --     es el usuario que cobra (`p_user_id`) y el instante es el que resolvió el
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
       AND i.sede_id = p_sede_id
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
      'sede_id', v_pago.sede_id,
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

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments`, `payments` y `cash_shifts`
-- (nuevo: el turno se bloquea acá); con search_path mutable un esquema anterior
-- en la ruta podría secuestrar esos nombres. House style desde 018 (y el mismo
-- paso que dan 039 y 046–053).
ALTER FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría registrar un cobro por PostgREST —con el turno que
-- quisiera, porque el turno viaja como parámetro— y cerrar facturas. El único
-- llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) IS
'CL-17: cobro de factura desde CAJA, ATÓMICO (CAJ-02), con el TURNO bloqueado y con los datos de cierre. Escribe las TRES cosas del cobro —la fila espejo de invoice_payments (el dinero que suma el arqueo, con el turno que COBRA y la marca del intento de 042), la fila del libro de cajón payments (sin marca, 043) y el estado de la factura— en UNA sentencia, y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request. NO calcula nada: el bruto redondeado (roundMoney), el reparto del recargo (splitGrossCardFee), el saldo (invoiceNetBalance), la cota del tope de 031, la decisión Pagada (moneyEquals), el enlace al turno y el instante del cierre (p_closed_at, resuelto por el servicio como en 049 y 050) llegan computados por el servicio, y la función escribe cada columna verbatim, sin sumar, restar, multiplicar ni redondear un solo monto y sin comparar el cobrado contra el facturado ni una vez. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista, que sea de la sede y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir su fila de dinero en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. Revalida también la precondición de la factura sobre su fila bloqueada (Anulada → ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE (P0001 y 23505). Sus tres redes de conteo —una por grupo de escritura— abortan con PAYMENT_MISMATCH si no escribió exactamente lo recibido, y en ese caso la transacción se revierte ENTERA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus filas de dinero, y el reintento sigue siendo posible. CIERRA la factura con sus datos: cuando el servicio lo decidió (p_mark_paid), escribe status = Pagada y ADEMÁS closed_by (el usuario que cobra) y closed_at (el instante que resolvió el servicio), que era el hueco de CL-17: una factura Pagada con closed_at NULL contradecía el contrato de 025 y dejaba la columna Cerrada del listado en guion sobre una factura cerrada. La marca del intento es OBLIGATORIA (este camino escribe una sola fila en invoice_payments y esa fila es la operación). Devuelve la fila del libro de cajón escrita (columnas de PAYMENT_SELECT) y el estado que quedó la factura. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): las
-- facturas que el hueco (a) ya dejó `Pagada` con `closed_at` NULL —cobradas por
-- caja antes de este archivo— NO se reparan solas y este archivo no las toca (no
-- hay UPDATE masivo ni backfill: reescribir `closed_at` de filas históricas
-- inventaría un instante que nadie registró). Se reconcilian decidiendo, con
-- quien opera la base: `closed_at` puede completarse con una fecha documentada
-- (el cierre del turno al que la factura quedó enlazada por `cash_shift_id`, o
-- la fecha de su fila espejo en `invoice_payments`) y `closed_by` con el
-- `payments.user_id` del cobro del mismo turno y monto; o aceptarse el NULL como
-- "no registrado", entendiendo que la columna "Cerrada" del listado mostrará un
-- guion para esas facturas hasta que se completen. En los dos casos queda la
-- auditoría (`invoice.*`) y la fila espejo como registro del cobro.

-- ===================================================================== ---
-- 5. El COBRO DIVIDIDO: porciones + cierre, con el TURNO bloqueado
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb)`: la sede del
-- actor, la factura que se cobra, el TURNO que cobra —nuevo: es el turno que la
-- operación bloquea y al que pertenecen sus porciones—, quién cobra, el instante
-- del cierre (resuelto en el servicio), SI la factura queda `Pagada` y las
-- porciones del cobro, ya computadas por `computeCardFees`: cada una
-- `{method_code, method_id, amount, fee_percent, fee_amount, cash_shift_id,
-- idempotency_key}`.
--
-- El tipo de retorno NO cambia: `{invoice, portions}` —la FACTURA ESCRITA (con
-- el estado que quedó y, cuando se cierra, con sus datos de cierre, que YA
-- escribía) y cuántas porciones escribió—.
CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_invoice_id IS NULL
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

  --     Y la premisa NUEVA de este archivo: TODAS las porciones pertenecen al
  --     TURNO que la operación bloquea. Sin esta guarda, una porción podría
  --     referenciar otro turno —posiblemente uno que se está cerrando— y la fila
  --     de dinero caería en un turno que la transacción NO bloqueó ni revalidó,
  --     que es exactamente el hueco (b). La comparación corre DESPUÉS de la
  --     guarda de forma de arriba, así que cada `cash_shift_id` ya validó su
  --     forma de uuid.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE (item ->> 'cash_shift_id')::uuid <> p_shift_id
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  -- 5.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" en la cabecera). `FOR
  --     SHARE` es la fuerza elegida: compite con el `FOR UPDATE` que el cierre
  --     (049) toma sobre esta MISMA fila y NO compite con otro cobro del mismo
  --     turno. La sede también se verifica: un cobro no se atribuye al turno de
  --     otra sede. El estado se mira DESPUÉS del lock y sobre LA FILA.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
    AND s.sede_id = p_sede_id
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
    AND i.sede_id = p_sede_id
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
       AND i.sede_id = p_sede_id
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
      'sede_id', v_factura.sede_id,
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

-- ------------------------------------------- 6. search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments` y `cash_shifts` (nuevo: el
-- turno se bloquea acá); con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018.
ALTER FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ 7. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura y cerrarla por PostgREST, con
-- el turno de caja que quisiera (el turno viaja como dato en cada porción y como
-- parámetro). El único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) TO service_role;

-- --------------------------------------------- 8. Documentación ---
COMMENT ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) IS
'CL-11/CL-17: cobro dividido ATÓMICO (FAC-07), con el TURNO bloqueado. Inserta las porciones de invoice_payments —el dinero que entra, con la marca del intento de la 042 sólo en la primera— y, si el servicio decidió que la factura queda Pagada, la cierra con sus datos de cierre (closed_by = p_user_id y closed_at = p_closed_at, los dos DATOS), todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista, que sea de la sede y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir sus porciones en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. Exige además que TODAS las porciones pertenezcan a ese turno (cash_shift_id = p_shift_id), para que el lock cubra exactamente las filas que se van a escribir. NO calcula nada: el reparto por método (neto, porcentaje, recargo, bruto) llega computado por computeCardFees y la decisión Pagada llega como p_mark_paid (invoiceNetBalance + moneyEquals, TypeScript); la función escribe cada columna verbatim y no compara el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE. Su red de conteo aborta con PAYMENT_MISMATCH si no escribió exactamente las porciones recibidas o si no cerró exactamente una factura; en los dos casos la transacción se revierte COMPLETA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus porciones, y el reintento sigue siendo posible. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y el número de porciones. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): un
-- cobro que ya quedó a medias por el defecto anterior —las porciones escritas con
-- la factura todavía Emitida— NO se repara solo: el saldo cobrable quedó en cero
-- (invoiceNetBalance), así que ningún cobro posterior puede cerrarla, y el
-- reintento del mismo intento es un no-op que la devuelve abierta. Se reconcilia
-- decidiendo, con quien opera la base: si el neto de las porciones de esa factura
-- iguala su neto facturado (round(total − surcharge), la misma regla del tope de
-- 031), lo que falta es el estado —cerrar la factura a Pagada con su
-- closed_by/closed_at, información del turno y de la auditoría del cobro—; si el
-- neto no llega, lo que falta es una porción y hay que decidir con el arqueo del
-- turno si el dinero se recibió. En los dos casos queda la auditoría como
-- registro.
