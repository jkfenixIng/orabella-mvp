-- 053_cash_payment_state_atomic.sql — CL-14: la ÚLTIMA ventana de caja —el
-- cobro de una factura cuyo estado nunca llega— deja de poder existir.
--
-- MOTIVO DEL ARCHIVO (la ventana, medida)
--
-- El barrido de atomicidad encontró en `src/features/cash/service.ts`, dentro de
-- `registerPayment` (~:1174), el último caso de la MISMA clase que CL-7 (046),
-- CL-8 (047), CL-9 (048), CL-10 (049) y CL-11 (050): son TRES requests distintos
-- contra PostgREST, que no ofrece multi-statement por request (la misma nota que
-- ya está escrita en 005, 039, 040, 041, 042, 043, 044, 045, 046, 047, 048, 049
-- y 050). Las líneas que siguen son las del código PREVIO a este archivo (el que
-- se midió):
--
--   a) la fila ESPEJO de la factura (`invoice_payments`, :1339): el dinero que
--      suma el arqueo, con `cash_shift_id` = turno que COBRA (031/023);
--   b) la fila del LIBRO DE CAJÓN (`payments`, :1425), con `invoice_id` y con la
--      marca en NULL a propósito (043: la identidad de este camino vive en el
--      espejo);
--   c) el ESTADO de la factura (`invoices`, :1513): el enlace al turno que cobra
--      (`cash_shift_id`, si la factura no tenía) y el paso a `Pagada` cuando el
--      neto cobrado cubre el neto facturado.
--
-- El PAR (a)+(b) SÍ estaba compensado, y robustamente: si el INSERT de (b)
-- fallaba, el servicio borraba la fila (a) por id —el id se generaba en el
-- cliente ANTES del INSERT justamente para que la compensación fuera exacta y no
-- pudiera tocar un cobro legítimo anterior— y verificaba su propio rollback,
-- gritando `PAYMENT_ROLLBACK_FAILED` si el DELETE tampoco salía.
--
-- La escritura (c) NO TENÍA COMPENSACIÓN NINGUNA. Un fallo ahí —una escritura
-- que falla, la conexión que se corta entre los dos requests, el proceso que
-- muere— dejaba el dinero COBRADO con la factura ABIERTA:
--
--   * El dinero está cobrado DOS veces contado: la fila (a) es el ledger que
--     suma el arqueo por `cash_shift_id` y la fila (b) es el libro de cajón del
--     turno. Las dos escritas, las dos visibles.
--   * La factura queda `Emitida` PARA SIEMPRE, porque el saldo cobrable quedó en
--     CERO: `invoiceNetBalance` (TypeScript) ve el neto ya cobrado y cualquier
--     porción nueva se rechaza con OVERPAID —y el tope de 031, que usa la MISMA
--     aritmética, tampoco la deja entrar—. Ningún cobro posterior puede cerrarla.
--   * Y el reintento del MISMO envío NO la arregla: trae la marca del intento
--     (042), el servicio la reconoce ANTES de escribir y es un no-op EXITOSO que
--     devuelve el detalle de la factura… ABIERTA. El llamador recibe un 200 con
--     `invoice_status: "Emitida"` sobre un cobro ya cobrado.
--
-- Es la peor de las tres ventanas de dinero de esta clase (la de 050 y esta
-- misma) por eso: la caja cobró y el sistema no lo registra como cobrado, sin
-- salida automática y sin que el reintento lo note. La medición se rehizo acá
-- como test permanente, ANTES de tocar el código, con el mismo desenlace:
--
--     expected [ { …(10) } ] to deeply equal []        (el espejo escrito)
--     expected 'Emitida' to be 'Pagada'                (el reintento, no-op)
--
-- MECANISMO (una FUNCIÓN, y por qué)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047, las dos de 048,
-- las tres de 049 y las dos de 050). Una función es UNA sentencia, y una
-- sentencia corre ENTERA dentro de una sola transacción del servidor: o se
-- escriben los TRES grupos de la operación, o no se escribe ninguno.
-- `cash_invoice_payment_atomic` escribe el espejo, el libro de cajón y el estado
-- de la factura.
--
-- UNA FUNCIÓN NUEVA Y NO `invoice_split_payment_atomic` (050), AUNQUE SE PAREZCA:
-- aquélla cobra el saldo EXACTO con N porciones (una por método) y cierra la
-- factura; ésta acepta montos PARCIALES, escribe UNA sola porción por método y
-- ADEMÁS escribe el libro de cajón del turno (`payments`), que es una tabla del
-- módulo de caja que la 050 no toca. Reusarla exigiría darle un parámetro de
-- turno, un booleano de "escribe también el cajón" y una aritmética de parciales
-- que su contrato no tiene (su igualdad exacta `moneyEquals(netSum,
-- netRemaining)` rechazaría todo cobro parcial): eso no agrega atomicidad —cada
-- par ya es una transacción— y sí le cambia el contrato a un llamador que ya
-- está en producción. Descartado.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * COMPENSAR EN EL CLIENTE (borrar el espejo y la fila de cajón si el UPDATE
--     del estado falla). Compensar significaría BORRAR filas de dinero —el
--     espejo y el libro de cajón— y un borrado no es una compensación: es la
--     pérdida de la evidencia de que el cobro ocurrió, en las dos tablas que el
--     arqueo y la auditoría miran. Y volvería a exponerse al MISMO fallo a mitad
--     de camino: se compensa el par y falla la compensación, y entonces queda el
--     estado parcial Y sin registro de que faltaba compensarlo. La única forma
--     de que la compensación sea tan sólida como la transacción es… una
--     transacción.
--   * INVERTIR EL ORDEN DE LAS ESCRITURAS (el estado primero y las filas de
--     dinero después, o al revés). Cambia de lugar la ventana, no la cierra: con
--     el estado primero, una falla deja una factura `Pagada` sin un solo cobro
--     —el mismo hueco con el signo cambiado, y esta vez el dinero que falta es
--     el que no se registró—; con el dinero primero —lo que ya hace— pasa
--     exactamente lo medido. Una transacción no depende del orden para ser
--     atómica; compensar sí, y por eso no se compensa.
--   * UN TRIGGER QUE CIERRE LA FACTURA AL INSERTAR EL ESPEJO. Sería una sola
--     sentencia, pero movería a SQL la DECISIÓN de que la factura queda
--     `Pagada`, que es una decisión de DINERO: se toma comparando el neto
--     cobrado contra el neto facturado (`invoiceNetBalance` + `moneyEquals`,
--     TypeScript) y sobre el recargo por método que el servicio ya computó. Un
--     trigger tendría que recalcular esa comparación —aritmética de dinero en
--     SQL— o confiar en que la fila llegó al tope, que no es lo mismo (el tope
--     de 031 es una cota, y este camino acepta parciales: llegar al tope no
--     significa cerrar). Descartado.
--   * MOVER LA FILA DEL LIBRO DE CAJÓN AL MISMO TRIGGER. Además de lo anterior,
--     el libro de cajón pertenece a OTRA operación del mismo módulo (CAJ-02) y
--     lleva el `user_id` de quien cobró y el turno que cobra como datos del
--     llamador; esconderlo en un efecto colateral del espejo lo dejaría fuera
--     del camino que su propio módulo gobierna. Descartado.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y la función SÓLO ESCRIBE. Acá no se mueve NADA de
-- aritmética de dinero a SQL, y las TRES comprobaciones que lo prueban son:
--
--   (1) EL BRUTO Y EL RECARGO. El monto que se escribe es el BRUTO ya
--       redondeado por el servicio (`gross = roundMoney(input.amount)`) y su
--       reparto por método (`cardFee = splitGrossCardFee(gross, feePercent)`:
--       neto, porcentaje y recargo) viaja como DATO dentro de `p_collection`. La
--       función escribe cada columna VERBATIM —`(p_collection ->> 'amount')::numeric`,
--       `::numeric` es una CONVERSIÓN de representación (jsonb → la columna), no
--       una operación— y no hay en la función una sola suma, resta, producto ni
--       redondeo sobre un monto. Si el recargo se hubiera movido a SQL, acá
--       habría un `amount * fee_percent / 100`; no hay ninguno.
--   (2) EL SALDO Y EL TOPE DE 031. La comprobación de que el cobro no se pasa
--       del neto facturado (`invoiceBalance.netCollected + cardFee.net −
--       invoiceBalance.netBilled > 0.009`, sobre `invoiceNetBalance`) es del
--       SERVICIO, antes de llamar, y la función NO lee `invoices.total` ni
--       `invoices.surcharge` para compararlos con nada: la única barrera de tope
--       que corre adentro es la PREEXISTENTE de la base (`trg_invoice_payments_cap`,
--       migración 031, que COMPRUEBA un número ajeno), con su SQLSTATE (P0001)
--       intacto.
--   (3) LA DECISIÓN `Pagada` Y EL ENLACE AL TURNO. No hay UNA SOLA comparación
--       del cobrado contra el facturado en la función: la decisión se toma en
--       TypeScript (`invoiceStatus === "Emitida" && moneyEquals(roundMoney(
--       netCollected + cardFee.net), netBilled)`) y llega como el booleano
--       `p_mark_paid`; el enlace llega como `p_set_shift`. El grupo 3 sólo
--       ESCRIBE el estado decidido, y ni siquiera necesita el total de la
--       factura para hacerlo.
--
-- Se quedan donde están, además: la marca de la 042 (lookup ANTES de cualquier
-- escritura), la normalización del bruto y del `fee_percent` del método
-- (`Math.max(0, Number(method.fee_percent) || 0)`), el rechazo de la factura
-- anulada y el del método inactivo, y el tope declarado en el esquema del
-- servicio. La única validación de un monto que ocurre en la base es la de
-- siempre: los CHECK de `invoices`/`invoice_payments`/`payments` (005/006/019),
-- que COMPRUEBAN un número ajeno; este archivo no agrega ninguna y no deriva
-- ningún total.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre la fila
-- BLOQUEADA, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * La factura NO puede estar Anulada. El servicio ya lo rechaza antes
--     (`ANNUL_INVALID`, y antes todavía que el lookup de la marca: una factura
--     anulada no admite cobros, repetidos o no); adentro se vuelve a comprobar
--     con la fila bloqueada, porque entre la lectura y la escritura cabe una
--     anulación —y una anulación toma ESE MISMO lock (050), así que la carrera
--     se decide acá—. Sin esa relectura, un cobro podría escribir su dinero
--     sobre una factura recién anulada.
--   * La marca del intento (042/043) es OBLIGATORIA acá —a diferencia de las
--     porciones de 050, donde vive sólo en la primera—: este camino escribe UNA
--     sola fila en `invoice_payments` y esa fila ES la operación, así que la
--     guarda de forma exige la marca bien formada. Un cobro sin marca sería el
--     defecto de CL-3 otra vez (un reintento contando el dinero dos veces).
--   * El tope de cobro (031) y el índice único parcial de identidad (042) NO se
--     replican: son barreras de la BASE y siguen corriendo dentro de esta
--     transacción con su propio SQLSTATE (P0001 y 23505), que el servicio
--     traduce como ya traducía (reencontrar la marca, o OVERPAID).
--   * El TURNO (que exista, que esté `abierto`, que sea de la sede del actor) se
--     sigue resolviendo en el SERVICIO, antes de llamar: ver "VENTANAS
--     DECLARADAS".
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS ... ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluidos los grupos anteriores.
-- Es la misma disciplina de 046–050: TRES redes en total, una por grupo.
--
--   * El ESPEJO: exactamente 1 fila. Menos sería un cobro que no registró su
--     dinero; el aborto revierte todo y el llamador recibe PAYMENT_MISMATCH.
--   * El LIBRO DE CAJÓN: exactamente 1 fila. Sin esta red, un fallo silencioso
--     dejaría el dinero en el ledger de la factura y FUERA del arqueo del turno
--     (o al revés), que es la mitad de la clase de defecto que la 031 cerró por
--     otro camino.
--   * El ESTADO: exactamente 1 factura actualizada, y SÓLO cuando el servicio
--     decidió algo (`p_set_shift` o `p_mark_paid`); si no decidió nada, el grupo
--     no corre y no hay nada que pueda fallar ahí (y por eso un cobro parcial
--     de una factura ya enlazada no tiene esta ventana). Cero filas con el grupo
--     corriendo es una invariante rota (la fila está bloqueada desde 2.2): el
--     aborto revierte el cobro ENTERO y el llamador recibe PAYMENT_MISMATCH, que
--     es exactamente lo que impide que quede dinero cobrado con la factura
--     abierta.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA y pasa por la fila de la
-- FACTURA, que es el punto de serialización del dinero de esa factura —el mismo
-- lock que toma el tope de 031 antes de aceptar una porción, el mismo que toma
-- `splitPayment` (050) y el mismo que toma la anulación (050)—. Esta función
-- bloquea la factura PRIMERO y después inserta sus dos filas de dinero: dos
-- cobros de la MISMA factura se bloquean en el MISMO orden, así que el segundo
-- espera al primero y evalúa su tope contra lo que el primero dejó; y un cobro y
-- una anulación de la misma factura ya no pueden solaparse a mitad de camino. Ni
-- las dos filas de dinero ni las porciones llevan `ORDER BY`: pertenecen a una
-- transacción que YA tiene el lock de su factura —ninguna otra las ve antes del
-- commit— y conservar el orden del llamador deja la fila de IDENTIDAD de la 042
-- (la única con marca) donde el servicio la decidió.
--
-- QUIÉN PUEDE LLAMARLA (decisión de permiso, explícita)
--
--   * NO necesita ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declara
--     SECURITY INVOKER, igual que 039 y 046–050.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría el cobro a cualquier JWT (anon/authenticated) por
--     PostgREST: cualquiera podría registrar dinero en la caja de una sede, con
--     el turno que quisiera (el turno viaja como parámetro) y cerrar facturas.
--     Se cierra en los pasos 3 y 7: se revoca de PUBLIC, anon y authenticated, y
--     se otorga sólo a service_role. Es la misma decisión que 018 tomó para
--     `write_audit_log`, que 039 para `replace_user_roles`, que 046 para
--     `deduct_stock_atomic`, que 047 para `payroll_apply_atomic` y que 048–050
--     para sus funciones.
--
-- LA MARCA DE LA 042 MANDA, Y SU LOOKUP NO SE MUEVE
--
-- El servicio sigue buscando la marca ANTES de leer el saldo y antes de
-- cualquier escritura (el comentario largo de `registerPayment` explica por qué:
-- sin eso, el reintento que llena el saldo moría con OVERPAID por una operación
-- que SÍ se registró). Lo que cambia es que la ESCRITURA de la marca y las otras
-- dos escrituras pasan a ser la MISMA transacción, y que el índice único parcial
-- (042) se evalúa ADENTRO: si dos envíos con la misma marca se solapan, el
-- segundo choca con el índice (23505), la transacción entera se revierte —sin
-- espejo, sin libro de cajón y sin estado— y el servicio vuelve a buscar por la
-- marca y devuelve el resultado de la ganadora, como ya hacía con el P0001 del
-- tope. La marca escribe NULL en el LIBRO DE CAJÓN a propósito (043): marcar las
-- dos filas mezclaría en un mismo índice las marcas de dos caminos distintos.
--
-- LA ASIMETRÍA QUE SE CONSERVA (declarada, no arreglada)
--
-- El grupo 3 escribe EXACTAMENTE los mismos campos que escribía el UPDATE del
-- servicio: `cash_shift_id` (el enlace al turno que cobra) y `status`
-- (`Pagada`). NO escribe `closed_by` ni `closed_at`, a diferencia del cobro
-- dividido (050), que sí los escribe: este camino los dejaba en NULL desde
-- antes, y este archivo los deja en NULL igual. Es deliberado: CL-14 cierra una
-- VENTANA DE ATOMICIDAD y no cambia el contenido de una escritura (una factura
-- cerrada por caja tiene que quedar escrita igual que antes; el comentario de la
-- columna en 025 documenta lo contrario y es un hallazgo aparte, reportado, no
-- resuelto acá). Cambiarlo habría mezclado dos cambios de naturaleza distinta en
-- la misma migración.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay DELETE ni TRUNCATE en ninguna parte; el único
--     UPDATE es el MISMO que el servicio ya hacía (el estado de la factura), con
--     los mismos campos y el mismo contenido.
--   * No agrega ni quita columnas, índices ni constraints: los INSERT usan las
--     columnas de 005, 006, 019, 023, 042 y 043, y las barreras que importan ya
--     existen (`trg_invoice_payments_cap` de 031,
--     `uq_invoice_payments_invoice_idempotency_key` de 042,
--     `uq_payments_shift_idempotency_key` de 043, la PK de `invoices`, la de
--     `payments` y la de `invoice_payments`). No hay índice nuevo que justificar
--     ni coste de escritura nuevo que declarar.
--   * No toca la aritmética del dinero: no recalcula el recargo, no compara el
--     cobrado contra el facturado, no aplica topes propios. Ver "LA DIVISIÓN DE
--     RESPONSABILIDADES" (las tres comprobaciones).
--   * No toca `updated_at` a mano: siguen siendo `set_updated_at()` (005/006) los
--     únicos escritores de esa columna.
--   * No toca los otros caminos de dinero del módulo: ni el pago SIN factura
--     (`payments` sin espejo, CL-4: es UNA sola escritura, ya era atómico), ni el
--     ciclo del turno (049), ni `invoice_payments` fuera de esta operación.
--   * No toca el cobro dividido ni la emisión de facturas: son la 050 y su
--     unidad.
--   * No backfillea ni repara lo que la ventana ya dejó a medias: ver la nota
--     operativa final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma y
-- el mismo tipo de retorno deja la función idéntica en cada corrida; REVOKE/GRANT
-- son idempotentes. El runner de Supabase aplica el archivo en una transacción:
-- o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La función. Va PRIMERO porque es el objeto que sus permisos y su
--      comentario nombran.
--   2. Su `search_path` fijo (house style desde 018): la función resuelve
--      `invoices`, `invoice_payments` y `payments`, y con una ruta mutable un
--      esquema anterior podría secuestrar esos nombres.
--   3. Sus permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. Su comentario, para el que la lea desde `\df`.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 053, asignado a esta unidad
-- (032 no existe y no existirá; 033–052 están tomados o asignados: la 052 es de
-- otra unidad en vuelo). No se reutiliza ningún número y no se renombra ningún
-- archivo anterior. Ninguna de las tres tablas tiene serie ni consecutivo —
-- `invoices` e `invoice_payments` (005) y `payments` (006) usan `uuid PRIMARY KEY
-- DEFAULT gen_random_uuid()`—, así que una transacción abortada no deja fila y no
-- deja hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO: el consecutivo de la FACTURA
-- (`next_invoice_number`, 005) no pasa por acá —esta función no emite facturas,
-- sólo las cobra—. Y a diferencia del INSERT del cliente, que generaba el id del
-- espejo en el servicio para poder compensar por id, ahora el id lo pone la
-- columna: el cobro aceptado nace con un uuid nuevo, y el revertido no nace.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * EL ESTADO DEL TURNO se lee en el SERVICIO, antes de la transacción, y no
--     se vuelve a comprobar adentro: un turno puede CERRARSE entre esa lectura y
--     el commit, y entonces este cobro escribiría su fila de cajón en un turno
--     ya cerrado (cambiando el arqueo firmado de ese turno). No se cierra acá a
--     propósito, y el costo es concreto: haría falta bloquear la fila del TURNO
--     además de la de la factura, o sea un SEGUNDO punto de serialización en
--     cada cobro —y un orden global de locks entre turnos y facturas que hoy no
--     existe, porque el cierre de turno (049) no toca facturas y el cobro no
--     toca turnos—. Es la misma forma de decisión que la 050 ya declaró para su
--     candado de nómina cerrada: un cambio de forma y de coste, no de atomicidad,
--     y va con su propia unidad. Lo que SÍ conserva esta transacción es que la
--     fila de cajón escriba el `cash_shift_id` que el servicio resolvió, y que el
--     cobro no pueda quedar a medias dentro del turno que le tocó.
--   * La LECTURA que alimenta la operación (el detalle de la factura, su saldo,
--     el método activo, el turno abierto) sigue separada de la escritura: eso NO
--     se cierra alargando la transacción (haría durar los locks todo el cálculo).
--     Lo que cierra es que la ESCRITURA sea indivisible y que una carrera pierda
--     ruidosamente (ANNUL_INVALID sobre la fila bloqueada, el tope de 031,
--     el 23505 de la marca).
--   * La igualdad EXACTA entre lo cobrado y el neto facturado que decide
--     `Pagada` (`moneyEquals`) y la cota del tope 031 del servicio se quedan en
--     TypeScript (ver "LA DIVISIÓN DE RESPONSABILIDADES", comprobaciones (2) y
--     (3)): comprobarlas adentro exigiría sumar y comparar dinero en SQL, que es
--     exactamente la aritmética que no se mueve. La transacción conserva las
--     CONSECUENCIAS de esas reglas —si la decisión es `Pagada`, la factura se
--     cierra en la MISMA sentencia que cobró—, no las reimplementa.
--   * La AUDITORÍA (`writeAudit`) queda FUERA de la transacción: es un INSERT
--     posterior y separado. No es un punto de fallo de estado (`writeAudit` no
--     lanza: registra y sigue), así que a lo sumo falta la fila de auditoría,
--     nunca una escritura a medias (es el mismo límite declarado en 049 y 050).
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 053 va ANTES que este código. Sin la función,
-- el cobro de una factura no puede escribir NADA —el RPC no existe y la
-- operación falla ENTERA antes de escribir, que es la dirección segura: un cobro
-- que no se puede registrar no deja dinero cobrado ni una factura cerrada a
-- medias—, y con la función y sin el código el cobro sigue siendo el de las tres
-- escrituras sueltas (no hay regresión, sólo no mejora). El pago SIN factura no
-- depende de esta migración.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. El COBRO de una factura: espejo + libro de cajón + estado, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, uuid, boolean, boolean, jsonb)`: la sede del actor, el
-- TURNO que cobra, la factura que se cobra, quién cobra, SI la factura se enlaza
-- al turno (`p_set_shift`), SI queda `Pagada` (`p_mark_paid`) —las dos decisiones
-- del servicio, ya tomadas— y el cobro en sí (`p_collection`), ya computado:
-- `{method_id, method_code, amount, fee_percent, fee_amount, idempotency_key}`.
--
-- `p_collection` describe el COBRO, no una fila: la función lo escribe en las DOS
-- filas del dinero —el espejo de la factura (con la marca del intento) y el libro
-- de cajón del turno (sin marca, 043)—, y el turno y la sede del libro de cajón
-- vienen como parámetros de la operación, no dentro del objeto.
--
-- El tipo de retorno es `{payment, invoice}`: la fila del LIBRO DE CAJÓN escrita
-- (jsonb, con las MISMAS columnas de `PAYMENT_SELECT`, que es lo que el servicio
-- devuelve como resultado en `PaymentResult.payment`) y el ESTADO que quedó la
-- factura. El llamador no necesita otra lectura para saber qué escribió ni en qué
-- estado terminó la factura, y no hay ventana entre la escritura y el resultado.
CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic(
  p_sede_id uuid,
  p_shift_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
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
  v_pago public.payments;
  v_method_id uuid;
  v_escritos integer;
  v_actualizados integer;
BEGIN
  -- 1.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. El tipo `uuid` de los cuatro identificadores los
  --     valida la propia firma, y `p_set_shift`/`p_mark_paid` no aceptan NULL
  --     (NULL no es una decisión).
  IF p_sede_id IS NULL
     OR p_shift_id IS NULL
     OR p_invoice_id IS NULL
     OR p_user_id IS NULL
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
  --     046–050: con la clave AUSENTE, `p_collection ->> 'amount'` es NULL y
  --     `NULL !~ 'regex'` es NULL —no TRUE—, así que sin el coalesce una entrada
  --     sin monto pasaría esta guarda y sería el NOT NULL de la columna el que
  --     hablara, con un error de la base en vez de un rechazo del contrato.
  --
  --     La MARCA NO ES OPCIONAL acá, a diferencia de las porciones de 050 (donde
  --     vive sólo en la primera): este camino escribe UNA sola fila en
  --     `invoice_payments` y esa fila ES la operación, así que un cobro sin marca
  --     sería un cobro sin identidad —el defecto de CL-3 de vuelta—. La firma del
  --     índice único parcial (042) depende de esa premisa.
  --
  --     `method_id` sí es opcional (la columna admite NULL: 005).
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

  -- 1.2 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la casa
  --     para tomar un lock de fila (039, 040, 047, 048, 049, 050): es el punto de
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

  -- 1.3 El grupo 1: la fila ESPEJO (`invoice_payments`), con el turno que COBRA
  --     y con la marca del intento —la identidad de este camino (042)—. Cada
  --     columna se escribe VERBATIM desde `p_collection`: el `::numeric` y el
  --     `::uuid` son conversiones de representación, no operaciones. El `id` NO
  --     se escribe: lo pone el DEFAULT de 005 (`gen_random_uuid()`), porque la
  --     compensación por id que lo exigía ya no existe.
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

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UNA fila espejo.
  --     Sin ella, un subconjunto silencioso dejaría el cobro sin su dinero en el
  --     ledger y con la factura ya cerrada por el grupo de abajo.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.5 El grupo 2: el LIBRO DE CAJÓN del turno (`payments`), con el turno que el
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

  -- 1.6 La segunda red: exactamente UNA fila en el libro de cajón. Sin ella, el
  --     dinero podría quedar en el ledger de la factura y fuera del arqueo del
  --     turno (o al revés) con la factura ya cerrada.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.7 El grupo 3: el ESTADO de la factura, y SÓLO si el servicio lo decidió.
  --     Es la escritura que faltaba cuando las dos de arriba ya habían entrado:
  --     ahora las tres son la misma transacción, y por eso ya no hace falta
  --     compensar nada.
  --
  --     Acá no se compara el cobrado contra el facturado —eso es
  --     `invoiceNetBalance` + `moneyEquals` en TypeScript— y no se recalcula
  --     ningún monto: la fila sólo cambia de turno y de estado, con los MISMOS
  --     campos y el MISMO contenido que escribía el UPDATE del servicio.
  --
  --     `cash_shift_id` sólo se pisa si el servicio lo decidió (`p_set_shift`):
  --     una factura se enlaza al turno que la COBRA, y una que ya tenía turno
  --     conserva el suyo. `closed_by`/`closed_at` NO se escriben (ver "LA
  --     ASIMETRÍA QUE SE CONSERVA").
  IF p_set_shift OR p_mark_paid THEN
    UPDATE public.invoices i
       SET cash_shift_id = CASE WHEN p_set_shift THEN p_shift_id ELSE i.cash_shift_id END,
           status = CASE WHEN p_mark_paid THEN 'Pagada' ELSE i.status END
     WHERE i.id = p_invoice_id
       AND i.sede_id = p_sede_id
    RETURNING * INTO v_factura;

    -- 1.8 La tercera red: exactamente UNA factura actualizada. Cero filas con el
    --     grupo corriendo es una invariante rota (la fila está bloqueada desde
    --     1.2): la operación entera aborta —el espejo y el libro de cajón
    --     incluidos—, que es exactamente lo que impide que quede dinero cobrado
    --     con la factura abierta.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 1.9 El resultado: la fila del LIBRO DE CAJÓN escrita (las MISMAS columnas de
  --     `PAYMENT_SELECT`, que es lo que el servicio devuelve como resultado) y el
  --     ESTADO que quedó la factura. Devolverlas evita una segunda lectura y su
  --     ventana.
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
-- La función resuelve `invoices`, `invoice_payments` y `payments`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría registrar un cobro por PostgREST —con el turno que
-- quisiera, porque el turno viaja como parámetro— y cerrar facturas. El único
-- llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb) IS
'CL-14: cobro de factura desde CAJA, ATÓMICO (CAJ-02). Escribe las TRES cosas que antes eran tres requests —la fila espejo de invoice_payments (el dinero que suma el arqueo, con el turno que COBRA y la marca del intento de 042), la fila del libro de cajón payments (sin marca, 043) y el estado de la factura (el enlace al turno y el paso a Pagada)— en UNA sentencia, y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request. Antes, una falla al escribir el estado dejaba el dinero COBRADO con la factura Emitida para siempre (el saldo quedaba en cero y el reintento de la marca era un no-op que devolvía la factura abierta); ahora no hay mitad del camino donde fallar, y la compensación del par espejo+cajón dejó de existir porque dejó de hacer falta. NO calcula nada: el bruto redondeado (roundMoney), el reparto del recargo (splitGrossCardFee), el saldo (invoiceNetBalance), la cota del tope de 031, la decisión Pagada (moneyEquals) y el enlace al turno llegan computados por el servicio —el cobro como dato en p_collection, las dos decisiones como p_mark_paid y p_set_shift— y la función escribe cada columna verbatim, sin sumar, restar, multiplicar ni redondear un solo monto y sin comparar el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE (P0001 y 23505). Sus tres redes de conteo —una por grupo de escritura— abortan con PAYMENT_MISMATCH si no escribió exactamente lo recibido, y en ese caso la transacción se revierte ENTERA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus filas de dinero, y el reintento sigue siendo posible. La marca del intento es OBLIGATORIA (este camino escribe una sola fila en invoice_payments y esa fila es la operación). NO escribe closed_by ni closed_at: el servicio tampoco los escribía (asimetría declarada frente a la 050, conservada a propósito). Devuelve la fila del libro de cajón escrita (columnas de PAYMENT_SELECT) y el estado que quedó la factura. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): un
-- cobro que ya quedó a medias por el defecto anterior —las dos filas de dinero
-- escritas (el espejo y el libro de cajón) con la factura todavía Emitida— NO se
-- repara solo: el saldo cobrable quedó en cero (invoiceNetBalance), así que
-- ningún cobro posterior puede cerrarla, y el reintento del mismo intento es un
-- no-op que la devuelve abierta. Se reconcilia decidiendo, con quien opera la
-- base: si el neto de las porciones de esa factura iguala su neto facturado
-- (round(total − surcharge), la misma regla del tope de 031), lo que falta es el
-- ESTADO —cerrar la factura a Pagada, que es información del turno y de la
-- auditoría del cobro—; si el neto no llega, lo que falta es una porción y hay
-- que decidir con el arqueo del turno si el dinero se recibió. En los dos casos
-- queda la auditoría como registro, y el turno que cobró conserva su fila en
-- `invoice_payments`: lo que estaba mal era el estado de la factura, no la
-- atribución del dinero. Cuando se cierre esa factura a mano, tener presente que
-- este camino tampoco escribe `closed_at`/`closed_by` (ver "LA ASIMETRÍA QUE SE
-- CONSERVA"): la fecha de cierre hay que elegirla con quien operó la caja.
