-- 050_billing_state_atomic.sql — CL-11: las DOS ventanas de estado parcial del
-- dinero de una factura dejan de poder existir: la ANULACIÓN y el COBRO
-- DIVIDIDO.
--
-- MOTIVO DEL ARCHIVO (las dos ventanas, medidas)
--
-- El barrido de atomicidad encontró, en `src/features/billing/service.ts`, los
-- dos últimos pares de escrituras seguidas y sin transacción de la MISMA clase
-- que CL-7 (046), CL-8 (047), CL-9 (048) y CL-10 (049): son DOS requests
-- distintos contra PostgREST, que no ofrece multi-statement por request (la
-- misma nota que ya está escrita en 005, 039, 040, 041, 042, 043, 044, 045, 046,
-- 047, 048 y 049). Las líneas que siguen son las del código PREVIO a este
-- archivo (el que se midió):
--
--   a) `annulInvoice` (service.ts:1374; el compare-and-swap del UPDATE en :1390
--      y el bucle de reversiones en :1419). Pisa la factura a `Anulada` con un
--      compare-and-swap —`UPDATE ... WHERE status = <el estado leído>`— y
--      DESPUÉS revierte el stock con un `registerMovement` por línea de
--      producto. Un fallo entre las dos —una escritura que falla, la conexión
--      que se corta, el trigger que rechaza el tercer producto— dejaba la
--      factura ANULADA con el stock devuelto A MEDIAS: el kardex muestra unas
--      reversiones y no otras, y el inventario queda con unidades que la
--      anulación no devolvió. Y es un CALLEJÓN SIN SALIDA: el compare-and-swap
--      sólo pisa una factura en el estado leído, así que el reintento ya no
--      encuentra una factura anulable —el servicio ni siquiera llega al UPDATE,
--      porque `canAnnulStatus(detail.invoice.status)` ve `Anulada` y responde
--      ANNUL_INVALID—; el stock que faltaba devolver no se devuelve NUNCA. Es la
--      peor de las dos por eso: no sólo deja estado parcial, deja un estado
--      parcial que ya no se puede completar y que además miente sobre el stock.
--   b) `splitPayment` (service.ts:2206; el INSERT de las porciones en :2295 y el
--      paso a `Pagada` en :2345). Inserta las N porciones de `invoice_payments`
--      —el dinero que entra— y DESPUÉS pisa la factura a `Pagada`. Un fallo
--      entre las dos dejaba el dinero COBRADO con la factura todavía Emitida. Y
--      tampoco se arregla solo: el saldo cobrable quedó en CERO (las porciones
--      están escritas), así que ningún cobro posterior puede cerrarla
--      —`invoiceNetBalance` da saldo 0 y cualquier porción nueva se rechaza con
--      OVERPAID— y el reintento del MISMO intento, con la marca de la 042, es un
--      no-op que devuelve la factura ABIERTA. La factura queda Emitida para
--      siempre, con su dinero ya cobrado: la caja cobró y el sistema no lo
--      registra como cobrado.
--
-- MECANISMO (una FUNCIÓN por operación, y por qué)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047, las dos de 048 y
-- las tres de 049). Una función es UNA sentencia, y una sentencia corre ENTERA
-- dentro de una sola transacción del servidor: o se escriben TODAS las filas de
-- la operación, o no se escribe ninguna. Las dos operaciones tienen DOS grupos
-- de escritura cada una, así que cada una recibe su propia función:
--
--   * `invoice_annul_atomic` (la factura a `Anulada` + las N reversiones de
--     stock de la misma anulación).
--   * `invoice_split_payment_atomic` (las N porciones del cobro + el paso de la
--     factura a `Pagada`).
--
-- UNA FUNCIÓN POR OPERACIÓN Y NO UNA SOLA PARA LAS DOS: son dos operaciones
-- distintas, con precondiciones distintas (una factura en estado anulable, una
-- factura no anulada), grupos de escritura distintos, resultados distintos y dos
-- llamadores distintos. Una función que hiciera las dos tendría que recibir un
-- discriminador y ramificar; eso no agrega atomicidad —cada par ya es una
-- transacción— y sí agrega superficie de error y un permiso compartido entre una
-- operación que devuelve stock y otra que cobra. Descartado.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * COMPENSAR EN EL CLIENTE (revertir la anulación con otro UPDATE, o borrar
--     las porciones si el paso a `Pagada` falla). Revertir es escribir OTRA vez
--     y volver a exponerse al mismo fallo a mitad de camino: se compensa la
--     factura y falla la compensación, y entonces queda el estado parcial Y sin
--     registro de que faltaba compensarlo. En el cobro es peor: compensar
--     significaría BORRAR filas de `invoice_payments` —dinero— y un borrado no
--     es una compensación, es una pérdida de la evidencia de que el cobro
--     ocurrió. La única forma de que la compensación sea tan sólida como la
--     transacción es... una transacción. En las dos operaciones la ventana se
--     CIERRA en vez de repararse.
--   * INVERTIR EL ORDEN DE LAS ESCRITURAS (las reversiones primero y la factura
--     después; las porciones primero... que es lo que ya hace el cobro).
--     Cambia de lugar la ventana, no la cierra: en la anulación el fallo dejaría
--     movimientos IN de una factura que no se anuló —stock devuelto por una
--     venta que sigue viva—; en el cobro, invertir dejaría una factura `Pagada`
--     sin sus porciones (el mismo hueco con el signo cambiado, y esta vez el
--     dinero faltante es el que no se registró). Una transacción no depende del
--     orden para ser atómica; compensar sí, y por eso no se compensa.
--   * UN TRIGGER QUE CIERRE LA FACTURA AL INSERTAR SUS PORCIONES. Sería una sola
--     sentencia y el disparador haría el resto, pero movería a SQL la DECISIÓN de
--     que la factura queda `Pagada`, que es una decisión de DINERO: se toma
--     comparando el neto cobrado con el neto facturado (`invoiceNetBalance` y la
--     línea `balance.netCollected + netSum - balance.netBilled`, TypeScript) y
--     sobre el recargo por método que el servicio ya computó. Un trigger tendría
--     que recalcular esa comparación —aritmética de dinero en SQL— o confiar en
--     que la fila llegó al tope, que no es lo mismo (el tope de 031 es una cota,
--     no la igualdad exacta que exige FAC-07). Descartado.
--   * UN TRIGGER QUE REVIERTA EL STOCK AL ANULAR (AFTER UPDATE sobre `invoices`).
--     Además de esconder el kardex en un efecto colateral de un UPDATE, movería a
--     SQL QUÉ se revierte y CON QUÉ motivo: las líneas de producto, sus
--     cantidades y el texto de la reversión (`buildReversalReasons`) los computa
--     el servicio. Y un disparador no puede contrastar cuántos movimientos
--     esperaba el llamador, así que el subconjunto silencioso volvería a ser
--     posible. Descartado.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y las funciones SÓLO ESCRIBEN. Acá no se mueve NADA de
-- aritmética de dinero (ni de stock) a SQL:
--
--   * QUÉ se revierte —las líneas de producto, con su cantidad y su motivo— lo
--     decide `buildReversalReasons` (TypeScript) y viaja como DATO en
--     `p_items`; la función escribe cada movimiento VERBATIM. El motivo de la
--     reversión no se arma acá: no hay una sola concatenación de texto en la
--     función.
--   * QUÉ se cobra —las porciones, con su método, su neto, su porcentaje de
--     recargo, su recargo y su bruto— lo decide `computeCardFees` (TypeScript) y
--     viaja como DATO en `p_portions`; la función escribe cada columna verbatim.
--     El `::numeric` y el `::uuid` son CONVERSIONES de representación
--     (jsonb → la columna), no operaciones aritméticas.
--   * SI la factura queda `Pagada` lo decide el servicio (`invoiceNetBalance`,
--     `moneyEquals`, `fullyPaid`) y llega como el booleano `p_mark_paid`: la
--     función no compara el cobrado contra el facturado ni una vez, y por eso
--     tampoco necesita leer el total ni el recargo de la factura.
--   * El reparto del recargo, el saldo, la igualdad exacta de las porciones
--     (`portionMatchBalance` / `moneyEquals`, con su mensaje SUM_MISMATCH) y el
--     estado anulable (`canAnnulStatus`, con su mensaje) se quedan donde están:
--     en TypeScript, antes de llamar.
--   * La única validación de un monto que ocurre en la base es la de siempre: el
--     CHECK de `invoices`, `invoice_payments` (005/019) y `inventory_movements`
--     (004), y el tope de cobro de 031. Son barreras PREEXISTENTES que
--     COMPRUEBAN un número ajeno; este archivo no agrega ninguna y no deriva
--     ningún total.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre la fila
-- BLOQUEADA, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * La anulación: el estado anulable (`canAnnulStatus`) y el
--     compare-and-swap. Adentro, la fila de `invoices` se lee con `FOR UPDATE`
--     —es el punto de serialización del dinero de esa factura— y su estado tiene
--     que ser el que el servicio leyó (`p_expected_status`); el `UPDATE` conserva
--     además la MISMA precondición en su propio `WHERE` y su red de conteo. Una
--     carrera rechaza con `ANNUL_CONFLICT` —el MISMO código que el servicio ya
--     devolvía cuando perdía el compare-and-swap (`PGRST116`)— y no escribe una
--     sola fila, ni la factura ni el stock.
--   * El candado de NÓMINA CERRADA (`invoiceInClosedPayroll`, que bloquea tocar
--     al empleado ya pagado) NO se mueve: sigue siendo una lectura del servicio
--     sobre `payroll_periods`/`payroll_items`, ANTES de llamar. No se replica
--     adentro a propósito: no es una precondición de una fila —es una lectura
--     paginada de otro módulo— y meterla en la transacción alargaría los locks
--     todo un barrido. Se declara abajo como ventana.
--   * El cobro: la factura NO puede estar Anulada. El servicio ya lo rechaza
--     antes (`ANNUL_INVALID`); adentro se vuelve a comprobar con la fila
--     bloqueada, porque entre la lectura y la escritura cabe una anulación y
--     cobrar sobre una factura anulada es exactamente lo que no puede pasar.
--   * El tope de cobro (031) y el índice único parcial de identidad (042) NO se
--     replican: son barreras de la BASE y siguen corriendo dentro de esta
--     transacción con su propio SQLSTATE (P0001 y 23505), que el servicio
--     traduce como ya traducía (reencontrar la marca) o a OVERPAID.
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS ... ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluido el grupo anterior. Es la
-- misma disciplina de 046, 047, 048 y 049: cuatro redes en total.
--
--   * La ANULACIÓN, grupos 1 y 2 (la factura, los movimientos) y el mismo
--     `WHERE status = p_expected_status` del UPDATE. Cero filas actualizadas es
--     un estado que cambió bajo los pies: la operación entera aborta y el
--     llamador recibe `ANNUL_CONFLICT`. Menos movimientos que los pedidos es un
--     producto que no existe o que es de otra sede: aborta con
--     `PRODUCT_NOT_FOUND` (la misma red que 039 y 046 pusieron sobre su INSERT)
--     y NO queda la factura anulada sin su reversión. El arreglo de ítems VACÍO
--     es legal acá —una factura de servicios se anula sin movimientos— y la red
--     lo admite: `0 = 0`.
--   * El COBRO, grupos 1 y 2 (las porciones, el paso a `Pagada`). Menos porciones
--     que las pedidas aborta con `PAYMENT_MISMATCH`; un `UPDATE` que no escribió
--     exactamente una fila aborta con el mismo código. Sin esas redes, un
--     subconjunto silencioso dejaría el cobro incompleto con la factura ya
--     cerrada (o el cierre sin las porciones, que es la ventana de este
--     archivo).
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA y pasa por la fila de la
-- FACTURA, que es el punto de serialización del dinero de esa factura en las dos
-- operaciones y también en el tope de cobro (031 toma `FOR UPDATE` sobre
-- `invoices` antes de aceptar una porción). La anulación bloquea PRIMERO la fila
-- de la factura y después las de sus productos (las que su trigger de stock
-- toca); el cobro bloquea la fila de la factura y después inserta sus porciones.
-- Dos operaciones sobre la MISMA factura se bloquean en el MISMO orden —factura,
-- después lo demás— así que la segunda espera a la primera y no hay ciclo; y una
-- anulación y un cobro de la misma factura ya no pueden solaparse a mitad de
-- camino, que era la otra mitad de la ventana. Los movimientos de reversión se
-- insertan en orden determinista ascendente por producto (`ORDER BY p.id`): es
-- el orden en el que el trigger `trg_inventory_apply_stock` (004) toma sus
-- locks de fila, y con dos anulaciones de facturas distintas que comparten
-- productos el orden evita el ciclo. Las PORCIONES no llevan `ORDER BY`, a
-- propósito: no compiten con nadie (pertenecen a una transacción que ya tiene el
-- lock de su factura y ninguna otra puede verlas antes del commit), y conservar
-- el orden del llamador deja la fila de IDENTIDAD de la 042 —la única con marca—
-- en la posición que el servicio decidió.
--
-- EL STOCK DE LA REVERSIÓN: LA FRONTERA ES LA MISMA, EL CAMINO NO (lo medido)
--
-- La deducción multi-producto de la EMISIÓN es `deduct_stock_atomic` (046) y
-- esta reversión NO la reusa. No es una preferencia: es que no puede.
--
--   * `deduct_stock_atomic` escribe `type = 'OUT'` FIJO —es el descuento de una
--     venta, dice su propio comentario— y su `p_reason` es UN motivo común. La
--     reversión escribe `type = 'IN'` y un motivo por línea.
--   * Y sobre todo: su guarda de forma RECHAZA el producto repetido
--     (`count(DISTINCT product_id) = count(*)`). La reversión de la anulación
--     escribe UN movimiento por LÍNEA de factura, así que una factura con dos
--     líneas del mismo producto escribe DOS IN de ese producto. Reusar esa
--     función colapsaría esas dos filas en una y cambiaría el kardex (y el
--     motivo de una de ellas). La guarda de 046 existe por una razón que acá no
--     aplica: su `BEFORE ROW` valida el OUT contra el stock de SU producto, y dos
--     filas del mismo producto en una misma sentencia verían el MISMO stock
--     previo. Un IN no valida nada contra el stock.
--   * QUÉ HACE EL TRIGGER CON UN IN (esto es lo que se midió en 004): el
--     `BEFORE ROW` `trg_inventory_no_negative` sólo actúa `IF NEW.type = 'OUT'`
--     —toma el `FOR UPDATE` de la fila y lanza `INSUFFICIENT_STOCK` si quedaría
--     negativa—, así que un IN NO toma ese lock y NO pasa por esa guarda. El que
--     sí actúa es el `AFTER ROW` `trg_inventory_apply_stock`, que para `IN` hace
--     `stock_qty + NEW.qty`: es el ÚNICO escritor del stock y NO se toca. Es
--     decir: la reversión pasa por la misma frontera de inventario que la
--     emisión, con el mismo trigger aplicando el stock, pero por una rama
--     distinta del trigger —sin guarda de negatividad y sin su lock de fila—
--     así que el único lock de esas filas lo toma el UPDATE del trigger de
--     aplicación, en el orden en que las filas se insertan (de ahí el `ORDER BY`,
--     y de ahí que el orden importe igual que en 046).
--   * La ARITMÉTICA del stock no se toca: la función no escribe `stock_qty` ni
--     una sola vez. Ni los triggers, ni sus dos funciones, ni los CHECK de
--     `products` cambian acá.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER, igual que 039 y 046–049.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría las dos operaciones a cualquier JWT
--     (anon/authenticated) por PostgREST: cualquiera podría anular una factura
--     —devolviendo su stock y salteando el candado de nómina cerrada— o cobrar
--     una factura y cerrarla, con el turno de caja que quisiera. Se cierra en
--     los pasos 3 y 7: se revoca de PUBLIC, anon y authenticated, y se otorga
--     sólo a service_role. Es la misma decisión que 018 tomó para
--     `write_audit_log`, que 039 para `replace_user_roles`, que 046 para
--     `deduct_stock_atomic`, que 047 para `payroll_apply_atomic` y que 048/049
--     para sus funciones.
--
-- LA MARCA DE LA 045 NO ENTRA ACÁ (dos mecanismos, no uno)
--
-- La reversión de la anulación escribe `idempotency_key` en NULL,
-- EXPLÍCITAMENTE, como la deducción de 046: la anulación no tiene un intento de
-- cliente, su puerta es el compare-and-swap de estado sobre la FACTURA y su
-- identidad no vive en el movimiento. Las filas de facturación por eso quedan
-- FUERA del índice único parcial de la 045 (`WHERE idempotency_key IS NOT NULL`)
-- y no compiten con nadie. Consecuencia declarada: después de este archivo, la
-- reversión de la anulación deja de pasar por `registerMovement` —la 045 lo
-- lista entre sus llamadores de facturación— y pasa por esta función; la fila
-- sigue naciendo SIN marca, así que ni el índice de la 045 ni su conclusión (la
-- marca es opcional en la función compartida y los caminos sin marca no entran
-- al índice) cambian. Lo que NO se hace acá es volver obligatoria la marca en
-- `registerMovement`: los llamadores de facturación que siguen usándola (las dos
-- ediciones y la compensación de `cleanupFailedInvoice`) no tienen un intento del
-- cliente que marcar.
--
-- LA MARCA DE LA 042 SÍ MANDA EN EL COBRO, Y SU LOOKUP NO SE MUEVE
--
-- En el cobro la marca del intento SÍ existe y sigue igual: el servicio la busca
-- ANTES de leer el saldo y antes de cualquier escritura (el comentario largo de
-- `splitPayment` explica por qué), y una repetición sigue siendo un no-op
-- EXITOSO que devuelve el detalle. Lo que cambia es que la ESCRITURA de la marca
-- y el cierre de la factura pasan a ser la misma transacción, y que el índice
-- único parcial (042) se evalúa ADENTRO: si dos envíos con la misma marca se
-- solapan, el segundo choca con el índice (23505), la transacción entera se
-- revierte —sin porciones y sin cierre— y el servicio vuelve a buscar por la
-- marca y devuelve el resultado de la ganadora, como ya hacía con el P0001 del
-- tope. La forma de la marca no cambia: vive SÓLO en la primera porción y la
-- transacción lo exige por FORMA (a lo sumo una porción marcada), para que la
-- premisa de la 042 no pueda romperse desde un llamador nuevo.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza dos funciones y
--     ajusta permisos. No hay DELETE ni TRUNCATE en ninguna parte; los dos
--     UPDATE son los MISMOS que el servicio ya hacía (la anulación de la factura
--     y su paso a `Pagada`), con los mismos campos.
--   * No agrega ni quita columnas, índices ni constraints: los INSERT usan las
--     columnas de 004/005/019/023/042 y los índices y triggers que importan ya
--     existen (`trg_invoice_payments_cap` de 031,
--     `uq_invoice_payments_invoice_idempotency_key` de 042, los de 004, la PK de
--     `invoices` y la de `products`). No hay índice nuevo que justificar ni
--     coste de escritura nuevo que declarar.
--   * No toca la aritmética del dinero ni del stock: no escribe `stock_qty`, no
--     recalcula totales, no aplica el recargo, no compara el cobrado contra el
--     facturado.
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (005) el
--     único escritor de esa columna.
--   * No toca los caminos de dinero de otros módulos: ni `payments` (el espejo
--     de caja), ni `cash_shifts`, ni la nómina, ni `next_invoice_number`.
--   * No toca las OTRAS escrituras múltiples de facturación que ya están
--     reportadas aparte: los bucles de `registerMovement` por delta de producto
--     en las dos ediciones (`editInvoiceItems`, `editEmittedInvoiceItems`) y la
--     compensación por producto de `cleanupFailedInvoice` (que además se traga
--     su propio error). Son la misma CLASE de defecto y otro hallazgo, y el
--     candado de serialización de la edición (038) sigue siendo el suyo.
--   * No backfillea ni repara lo que las dos ventanas ya dejaron a medias: ver
--     las notas operativas al final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma y
-- el mismo tipo de retorno deja las funciones idénticas en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado), por función:
--   1. La función. Va PRIMERO porque es el objeto que sus permisos y su
--      comentario nombran.
--   2. Su `search_path` fijo (house style desde 018): la función resuelve
--      `invoices`, `products` e `inventory_movements` (la anulación) o
--      `invoices` e `invoice_payments` (el cobro), y con una ruta mutable un
--      esquema anterior podría secuestrar esos nombres.
--   3. Sus permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. Su comentario, para el que la lea desde `\df`.
--   La anulación va primero porque es la operación que ya existía (la que se
--   midió) y después el cobro, que es donde vive la marca de la 042.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 050, el siguiente libre
-- (032 no existe y no existirá; 033–049 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. Ninguna de las tablas tiene
-- serie ni consecutivo —`invoices` (005), `invoice_payments` (005) e
-- `inventory_movements` (004) usan `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`—, así que una operación abortada no deja fila y no deja
-- hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO, ni en el camino normal ni en el rechazo;
-- el consecutivo de la FACTURA (`next_invoice_number`, 005) no pasa por acá: la
-- anulación y el cobro no reservan números.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * El candado de nómina cerrada (`invoiceInClosedPayroll`) sigue siendo una
--     lectura del servicio ANTES de la transacción: una nómina puede cerrarse
--     entre esa lectura y la anulación. Cerrarla exigiría leer `payroll_periods`
--     y `payroll_items` —paginado, de otro módulo— dentro de la transacción, con
--     los locks de la factura tomados todo el barrido; es un cambio de forma y
--     de coste, no de atomicidad, y queda declarado.
--   * La LECTURA que alimenta las dos operaciones (el detalle de la factura, el
--     saldo, los métodos activos, el turno abierto) sigue separada de la
--     escritura: eso NO se cierra alargando la transacción (haría durar los
--     locks todo el cálculo). Lo que cierra es que la ESCRITURA sea indivisible y
--     que una carrera pierda ruidosamente (ANNUL_CONFLICT / el tope de 031 /
--     23505), como se probó.
--   * La igualdad EXACTA entre las porciones y el saldo (`moneyEquals`) y la
--     decisión `Pagada` se quedan en TypeScript (ver "LA DIVISIÓN DE
--     RESPONSABILIDADES"): comprobarlas adentro exigiría sumar y comparar dinero
--     en SQL, que es exactamente la aritmética que no se mueve. La transacción
--     conserva las consecuencias de esas reglas —si la decisión es `Pagada`, la
--     factura se cierra en la MISMA sentencia que cobró—, no las reimplementa.
--   * La AUDITORÍA (`writeAudit`) queda FUERA de las dos transacciones: es un
--     INSERT posterior y separado. No es un punto de fallo de estado
--     (`writeAudit` no lanza: registra y sigue), así que a lo sumo falta la fila
--     de auditoría, nunca una escritura a medias (es el mismo límite declarado en
--     049).
--   * El movimiento de stock de la reversión se escribe en la MISMA transacción
--     que la anulación, pero el stock que el kardex muestra sigue siendo el que
--     aplica el trigger de 004: si la transacción aborta, el trigger revierte con
--     ella (su UPDATE pertenece a la misma transacción). No hay una ventana entre
--     el movimiento y el stock.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 050 va ANTES que este código. Sin las
-- funciones, la anulación y el cobro no pueden escribir NADA —los RPC no existen
-- y las operaciones fallan enteras ANTES de escribir, que es la dirección segura:
-- una factura que no se puede anular no se anula a medias, y un cobro que no se
-- puede registrar no deja dinero cobrado sin factura cerrada—, y con las
-- funciones y sin el código las dos operaciones siguen siendo las de las
-- escrituras sueltas (no hay regresión, sólo no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La ANULACIÓN y su reversión de stock, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, timestamptz, text, text, jsonb)`: la sede del actor,
-- la factura que se anula, quién anula, el instante del cierre —resuelto en el
-- servicio, como en 049—, el motivo (obligatorio, ya normalizado por el schema),
-- el ESTADO que el servicio leyó (la precondición del compare-and-swap) y las
-- reversiones por línea de producto, ya computadas por `buildReversalReasons`:
-- cada una `{product_id, qty, reason}`.
--
-- El tipo de retorno es la FACTURA ESCRITA (jsonb), con las MISMAS columnas que
-- el servicio leía con `INVOICE_SELECT`: el llamador no necesita otra lectura
-- para tener la fila, y no hay ventana entre la escritura y la lectura del
-- resultado (el mismo criterio que `deduct_stock_atomic` con su conteo y que
-- 049 con sus turnos).
CREATE OR REPLACE FUNCTION public.invoice_annul_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_invoice_id IS NULL
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
  --     REVERSIÓN"). Lo que NO se permite es una línea a medio formar.
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
  --     el servicio ya hizo y la escritura de abajo. La sede también se
  --     verifica: una anulación no se atribuye a la factura de otra sede.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
    AND i.sede_id = p_sede_id
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
     AND i.sede_id = p_sede_id
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
  --     045 NO ENTRA ACÁ").
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN").
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    'IN',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
   AND p.sede_id = p_sede_id
  ORDER BY p.id;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     movimientos que los pedidos, se aborta y se revierte TODO, la anulación
  --     incluida. El `JOIN` de arriba filtra por sede, así que un producto
  --     inexistente o de otra sede escribiría menos filas en SILENCIO: esta
  --     guarda convierte ese subconjunto silencioso en un rechazo con rollback,
  --     y es exactamente lo que separa "la anulación no se pudo hacer" de "la
  --     factura quedó anulada sin su reversión". Es la misma red que 039, 046 y
  --     049 pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.7 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --     `INVOICE_SELECT`: eso es lo que el llamador usa como resultado, sin otra
  --     lectura y sin ventana.
  RETURN jsonb_build_object(
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
  );
END;
$$;

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `invoices`, `products` e `inventory_movements`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049).
ALTER FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría anular una factura —devolviendo su stock y
-- salteando el candado de nómina cerrada— por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb) IS
'CL-11: anulación ATÓMICA de una factura (FAC-04/FAC-06). Pisa la factura a Anulada —conservando el compare-and-swap sobre el estado leído— y escribe las reversiones IN de stock en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización del dinero de esa factura, también frente a un cobro) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el motivo, el estado esperado y cada reversión (producto, cantidad y motivo) llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004), que para un IN suma —la guarda de negatividad sólo actúa sobre los OUT, así que un IN no toma ese lock—. Sus redes de conteo abortan con ANNUL_CONFLICT si no actualizó exactamente la factura en el estado leído (una carrera se rechaza y no escribe nada) o con PRODUCT_NOT_FOUND si no escribió exactamente las reversiones pedidas; en los dos casos la transacción se revierte COMPLETA: no queda una factura anulada sin su reversión, y el reintento sigue siendo posible. El arreglo de reversiones puede venir VACÍO (una factura de servicios no mueve stock). Escribe idempotency_key NULL a propósito: la anulación no tiene intento de cliente y queda fuera del índice parcial de la 045. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): una
-- anulación que ya quedó a medias por el bug anterior —la factura Anulada y una
-- parte de sus reversiones escritas— NO se repara sola y NO se puede reintentar
-- (el compare-and-swap sólo pisa una factura en estado anulable). Se reconcilia
-- decidiendo, con quien opera la base: comparar las líneas de producto de la
-- factura (`invoice_items`) contra los movimientos IN cuyo motivo nombra su
-- consecutivo (`Reversión factura #N`) y escribir a mano los que faltan, o
-- aceptar el faltante como una diferencia de inventario y ajustarla con el
-- movimiento ADJUST del camino manual. En los dos casos queda la auditoría
-- (`invoice.annulled`) como registro de la anulación original.

-- ===================================================================== ---
-- 5. El COBRO y el cierre de la factura, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, timestamptz, boolean, jsonb)`: la sede del actor, la
-- factura que se cobra, quién cobra, el instante del cierre (resuelto en el
-- servicio), SI la factura queda `Pagada` —la decisión del servicio, ya tomada
-- con `invoiceNetBalance`/`moneyEquals`— y las porciones del cobro, ya
-- computadas por `computeCardFees`: cada una `{method_code, method_id, amount,
-- fee_percent, fee_amount, cash_shift_id, idempotency_key}`.
--
-- El tipo de retorno es `{invoice, portions}`: la FACTURA ESCRITA (jsonb, con
-- las MISMAS columnas de `INVOICE_SELECT`, ya con el estado que quedó) y cuántas
-- porciones escribió. El llamador contrasta ESE número contra las que pidió —en
-- vez de confiar en que el RPC no dejó ninguna afuera— y usa la fila como
-- resultado, sin una segunda lectura y sin su ventana.
CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic(
  p_sede_id uuid,
  p_invoice_id uuid,
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
  v_esperados integer;
  v_escritos integer;
  v_marcadas integer;
  v_actualizados integer;
BEGIN
  -- 5.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. La decisión del cierre tiene que venir (NULL no
  --     es una decisión) y las porciones no pueden venir vacías —un cobro sin
  --     porciones no es un cobro—.
  IF p_sede_id IS NULL
     OR p_invoice_id IS NULL
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
  --     trampa que documentan 046–049: con la clave ausente la comparación sería
  --     NULL y la guarda dejaría pasar la fila. El `CASE` vuelve a garantizar que
  --     cada cast sólo se evalúe cuando el texto ya validó su forma.
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

  -- 5.2 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA.
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

  -- 5.3 El grupo 1: las PORCIONES, UNA sentencia multi-fila y cada columna
  --     escrita VERBATIM desde `p_portions` (el `::numeric` y el `::uuid` son
  --     conversiones de representación, no operaciones). La fila de identidad de
  --     la 042 —la única con marca— es la que el servicio decidió: por eso el
  --     INSERT NO lleva `ORDER BY` (ver "SERIALIZACIÓN").
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

  -- 5.4 Red de seguridad DENTRO de la transacción: exactamente las porciones
  --     recibidas. Sin ella, un subconjunto silencioso dejaría el cobro
  --     incompleto con la factura ya cerrada por el grupo de abajo —la ventana
  --     que este archivo cierra, con el otro signo—. El tope de 031 y el índice
  --     de la 042 abortan ANTES de llegar acá (su error se propaga tal cual, con
  --     su SQLSTATE, para que el servicio lo traduzca como ya lo traducía).
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 5.5 El grupo 2: el CIERRE de la factura, SÓLO si el servicio lo decidió
  --     (`p_mark_paid`). Es la escritura que faltaba cuando el INSERT de arriba
  --     había entrado: ahora las dos son la misma transacción. Acá no se compara
  --     el cobrado contra el facturado —eso es `invoiceNetBalance` +
  --     `moneyEquals` en TypeScript— y no se recalcula ningún monto: la fila
  --     sólo cambia de estado, con su responsable y su instante.
  IF p_mark_paid THEN
    UPDATE public.invoices i
       SET status = 'Pagada',
           closed_by = p_user_id,
           closed_at = p_closed_at
     WHERE i.id = p_invoice_id
       AND i.sede_id = p_sede_id
    RETURNING * INTO v_factura;

    -- 5.6 La segunda red: exactamente UNA factura cerrada. Cero filas aborta la
    --     operación ENTERA —las porciones incluidas—, que es lo que impide que
    --     quede dinero cobrado con la factura abierta (o cerrada sin sus
    --     porciones). La fila está bloqueada desde 5.2, así que este caso es una
    --     invariante rota, no una carrera: se rechaza ruidosamente.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 5.7 La factura ESCRITA (con el estado que quedó) y cuántas porciones se
  --     escribieron, para el contraste del llamador. Devolverla evita una
  --     segunda lectura y su ventana.
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
-- La función resuelve `invoices` e `invoice_payments`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. House style
-- desde 018 (y el mismo paso que dan 039 y 046–049).
ALTER FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ 7. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura y cerrarla por PostgREST, con
-- el turno de caja que quisiera (el turno viaja como dato en cada porción). El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) TO service_role;

-- --------------------------------------------- 8. Documentación ---
COMMENT ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) IS
'CL-11: cobro dividido ATÓMICO (FAC-07). Inserta las porciones de invoice_payments —el dinero que entra, con la marca del intento de la 042 sólo en la primera— y, si el servicio decidió que la factura queda Pagada, la cierra, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización de su dinero, y el tope de 031 toma el mismo lock). NO calcula nada: el reparto por método (neto, porcentaje, recargo, bruto) llega computado por computeCardFees y la decisión Pagada llega como p_mark_paid (invoiceNetBalance + moneyEquals, TypeScript); la función escribe cada columna verbatim y no compara el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE. Su red de conteo aborta con PAYMENT_MISMATCH si no escribió exactamente las porciones recibidas o si no cerró exactamente una factura; en los dos casos la transacción se revierte COMPLETA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus porciones, y el reintento sigue siendo posible. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y el número de porciones. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): un
-- cobro que ya quedó a medias por el bug anterior —las porciones escritas con la
-- factura todavía Emitida— NO se repara solo: el saldo cobrable quedó en cero
-- (invoiceNetBalance), así que ningún cobro posterior puede cerrarla, y el
-- reintento del mismo intento es un no-op que la devuelve abierta. Se reconcilia
-- decidiendo, con quien opera la base: si el neto de las porciones de esa factura
-- iguala su neto facturado (round(total − surcharge), la misma regla del tope de
-- 031), lo que falta es el estado —cerrar la factura a Pagada con su
-- closed_by/closed_at, que es información del turno y de la auditoría del
-- cobro—; si el neto no llega, lo que falta es una porción y hay que decidir con
-- el arqueo del turno si el dinero se recibió. En los dos casos queda la
-- auditoría como registro, y el turno que cobró conserva su fila en
-- invoice_payments: lo que estaba mal era el estado de la factura, no la
-- atribución del dinero.
