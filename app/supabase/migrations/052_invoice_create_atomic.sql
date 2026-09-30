-- 052_invoice_create_atomic.sql — CL-13: la EMISIÓN de una factura deja de poder
-- dejar un residuo silencioso. La operación más ejecutada del sistema —y la
-- única cuyo camino de fallo MENTÍA por quedarse callado— pasa a ser UNA
-- transacción del servidor.
--
-- MOTIVO DEL ARCHIVO (la ventana, medida)
--
-- El barrido de atomicidad encontró, en `src/features/billing/service.ts`, el
-- último de los caminos de escritura múltiple de la MISMA clase que CL-7 (046),
-- CL-8 (047), CL-9 (048), CL-10 (049), CL-11 (050) y CL-12 (051): es una
-- SECUENCIA de requests distintos contra PostgREST, que no ofrece multi-statement
-- por request (la misma nota que ya está escrita en 005, 039, 040, 041, 042,
-- 043, 044, 045, 046, 047, 048, 049, 050 y 051). Las líneas que siguen son las
-- del código PREVIO a este archivo (el que se midió):
--
--   * `createInvoice` (service.ts:1072). Reservaba el consecutivo con el RPC
--     `next_invoice_number` (`:1181`), insertaba la factura (`:1237`), sus
--     líneas (`:1304`), su snapshot de impuestos (`:1325`), sus porciones
--     (`:1342`) y DESPUÉS descontaba el stock con el RPC de 046 (`:1346`): cinco
--     sentencias, cinco requests, cinco confirmaciones independientes.
--   * `cleanupFailedInvoice` (`:1189`). La compensación: un `registerMovement`
--     por producto revertido MÁS cuatro `DELETE` —`invoice_payments`,
--     `invoice_taxes`, `invoice_items`, `invoices`, en ese orden—, cada uno su
--     propia sentencia, todos DENTRO de un `catch {}` que se tragaba su propio
--     error ("Best-effort: el error original manda").
--
-- CONSECUENCIA, que es el defecto: si la compensación no se podía aplicar
-- completa, el llamador recibía el error ORIGINAL y NADA MÁS. Nadie se enteraba
-- de lo que había quedado a medias. El residuo medido con el código previo (ver
-- el test "un fallo cuya compensación TAMBIÉN falla no deja residuo ni
-- silencio"): con el grupo de stock rechazado (la carrera de stock que el plan
-- pre-verificado no vio) y el borrado de las líneas fallando, quedaba una factura
-- VIVA que el sistema da por `Pagada` con CERO porciones registradas —el dinero
-- cobrado desaparecido de una factura que sigue ahí, y el stock sin descontar—.
-- La otra cara del mismo defecto es el consecutivo: la reserva era una sentencia
-- APARTE y anterior, así que CUALQUIER fallo posterior la dejaba quemada —un
-- hueco en la serie sin nada que lo explique—.
--
-- No es sólo un residuo: es un residuo del que no queda rastro. La única prueba
-- se queda, como mucho, en el estado de la base, y para verla hay que ir a
-- buscarla.
--
-- MECANISMO (una FUNCIÓN, y por qué)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047, las dos de 048, las
-- tres de 049, las dos de 050 y las dos de 051). Una función es UNA sentencia, y
-- una sentencia corre ENTERA dentro de una sola transacción del servidor: o se
-- escriben TODAS las filas de la emisión, o no se escribe ninguna.
--
-- La emisión pasa a tener SEIS SENTENCIAS en la misma función: la reserva del
-- consecutivo y CINCO GRUPOS DE ESCRITURA:
--
--   1. El CONSECUTIVO (`next_invoice_number`, 005, llamada ADENTRO).
--   2. La FACTURA.
--   3. Las LÍNEAS.
--   4. El SNAPSHOT DE IMPUESTOS.
--   5. Las PORCIONES DEL COBRO.
--   6. El OUT de STOCK (`deduct_stock_atomic`, 046, llamada ADENTRO).
--
-- (Son seis sentencias: la primera reserva el número y las otras cinco escriben
-- filas. De ahí que las redes de conteo de abajo sean cuatro —una por grupo que
-- inserta— más la del grupo de stock, que la tiene dentro de 046.)
--
-- Y `cleanupFailedInvoice` DESAPARECE. No se vuelve "más robusta": se elimina,
-- porque ya no hay nada que compensar. Con la emisión en una sola transacción, un
-- fallo significa que el servidor revirtió TODO —incluida la reserva del
-- consecutivo— antes de que el llamador recibiera el error. No hay estado a
-- medias que reparar, así que no hay compensación que pueda fallar y no queda
-- ningún `catch {}` que pueda tragarse un fallo propio.
--
-- POR QUÉ NO UNA COMPENSACIÓN ROBUSTA Y AUDIBLE (la alternativa evaluada, y por
-- qué la decisión pudo haber sido la otra)
--
-- La otra opción era (b): dejar la secuencia de requests y hacer que la
-- compensación fuera sólida y ruidosa —no tragarse su error, registrar el
-- residuo, hacerlo auditable—. Es defendible y NO es gratis descartarla: una
-- compensación que se audita le deja al humano el estado exacto que hay que
-- reparar, que es algo que una transacción revertida no le da (no hay nada que
-- reparar, pero tampoco un registro de qué se intentó emitir).
--
-- Se descarta por tres razones, en orden de peso:
--
--   1. LA AUDITORÍA DEL RESIDUO PUEDE FALLAR TAMBIÉN. El registro del residuo
--      sería otra escritura (una fila de `audit_logs`, que `writeAudit` escribe
--      best-effort y NUNCA lanza: su fallo deja `written: false` sin frenar
--      nada). Es decir: el mecanismo que hace "auditable" el residuo tiene el
--      MISMO defecto que se está arreglando un nivel más arriba. La única forma
--      de que la compensación sea tan sólida como la transacción es... una
--      transacción.
--   2. LA COMPENSACIÓN ES MÁS CARA QUE LA TRANSACCIÓN AQUÍ. Lo que habría que
--      deshacer es una COLECCIÓN de filas escritas (las líneas, el snapshot de
--      impuestos, las porciones) más el stock ya aplicado por el trigger de 004,
--      más la reserva del consecutivo (que NO se puede deshacer: `last_number`
--      es monótono; un número reservado no se devuelve). Revertir el kardex
--      exige escribir movimientos IN —escribir OTRA vez— y devolver el
--      consecutivo no se puede. La transacción lo resuelve porque el incremento
--      y las filas pertenecen al mismo acto.
--   3. COHERENCIA CON LOS SEIS GEMELOS. 046–051 ya tomaron esta decisión seis
--      veces, con el mismo argumento y la misma evidencia. Dejar la emisión
--      —justo la operación MÁS ejecutada— con el mecanismo que los seis archivos
--      anteriores descartaron dejaría el camino más transitado con la solución
--      más débil y con una segunda maquinaria de compensación viva para siempre.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las otras alternativas, una por una)
--
--   * INVERTIR EL ORDEN DE LAS ESCRITURAS (el stock primero y las filas
--     después). Cambia de lugar la ventana, no la cierra: con el stock ya
--     descontado y la factura sin escribir, el kardex muestra una salida de una
--     venta que no existe. Una transacción no depende del orden para ser
--     atómica; compensar sí.
--   * UN TRIGGER QUE DESCUENTE EL STOCK AL INSERTAR LAS LÍNEAS. Sería UNA
--     sentencia, pero movería a SQL QUÉ se descuenta y CON QUÉ motivo: el plan
--     agregado por producto (`planStockDeduction`) y el texto del kardex
--     (`buildInvoiceOutReason`) los computa el servicio. Además un disparador no
--     podría contrastar cuántos movimientos esperaba el llamador, así que el
--     subconjunto silencioso volvería a ser posible, y el trigger BEFORE ROW de
--     004 —que ya es la guarda del stock— no puede escribir filas como efecto
--     colateral sin volver opaca la frontera de inventario. Descartado.
--   * DOS FUNCIONES (una para las filas y otra para el stock). Dos sentencias
--     son DOS transacciones: la ventana entre el commit de la primera y el de la
--     segunda es exactamente la que este archivo cierra. Descartado.
--   * UNA MARCA DE "EMISIÓN EN CURSO" CON REINTENTO (escribir la intención
--     primero y completarla después). Agrega un estado intermedio observable
--     —una factura a medio armar, ahora persistente— y por lo tanto otra ventana
--     que hay que limpiar: el mismo problema con más maquinaria. Descartado.
--   * BLOQUEAR POR SEDE O POR TABLA. Serializaría emisiones de clientes distintos
--     —y contra cobros y anulaciones, que también pasan por `invoices`—, que es
--     justo lo que la 038 evitó a propósito ("el candado es por FILA, no
--     global"). Descartado: acá no hace falta ningún candado nuevo, porque la
--     fila de la factura todavía no existe (se está insertando).
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y la función SÓLO ESCRIBE. Acá no se mueve NADA de
-- aritmética de dinero (ni de stock) a SQL:
--
--   * LOS MONTOS de la factura —`subtotal`, `discount`, `tax`, `surcharge`,
--     `total`— llegan computados por `computeInvoiceTotals` (con `roundMoney`, la
--     regla del peso entero y el snapshot de impuestos activos) como DATO en
--     `p_invoice`, y la función los escribe VERBATIM con un `::numeric`: el
--     `::numeric` es una CONVERSIÓN de representación (jsonb → la columna), no
--     una operación. La función no suma, no resta, no aplica el recargo y no
--     deriva ningún total: no hay una sola expresión aritmética sobre una columna
--     de dinero.
--   * EL SUBTOTAL DE CADA LÍNEA llega computado por `computeLineSubtotal` (la
--     MISMA fórmula que el subtotal de la factura, para que la línea y el total
--     no puedan discrepar) y los campos de comisión por
--     `normalizeCommissionFields`; la función escribe cada columna verbatim.
--   * EL SNAPSHOT DE IMPUESTOS —código, nombre, porcentaje y MONTO— llega
--     computado por `snapshotInvoiceTaxes`: la función no lo recalcula ni lo
--     compara contra la base.
--   * EL RECARGO POR MÉTODO llega computado por `computeCardFees` (`net`,
--     `feePercent`, `fee`, `gross`); la función escribe el bruto, el porcentaje y
--     el monto, y NUNCA multiplica.
--   * EL ESTADO (`Emitida` / `Pagada`) y el INSTANTE DE CIERRE los decide el
--     servicio (la factura con porciones nace `Pagada` y cerrada, 005) y viajan
--     como DATO: `p_invoice.status`, `p_invoice.closed_by` y
--     `p_invoice.closed_at` —el instante resuelto en el servicio, como en 049 y
--     050—. La función sólo comprueba que el cierre venga cuando el estado es
--     `Pagada` y que no venga cuando es `Emitida`; no decide ninguna de las dos
--     cosas.
--   * EL PLAN DE STOCK —qué producto, con qué cantidad agregada, y con qué
--     motivo de kardex— llega computado por `planStockDeduction` y
--     `buildInvoiceOutReason`; viaja como DATO en `p_out_items` y `p_out_reason`
--     y lo escribe `deduct_stock_atomic` (046). La función no agrega cantidades
--     por producto (la agregación es de TypeScript, y 046 la VERIFICA con su
--     `count(DISTINCT product_id)`).
--   * La ÚNICA validación de un número que ocurre en la base es la de siempre:
--     los CHECK de `invoices` (005/019), `invoice_items` (005/020/030),
--     `invoice_taxes` (005), `invoice_payments` (005/019), el CHECK de
--     `inventory_movements` (004) y el tope de cobro de 031. Son barreras
--     PREEXISTENTES que COMPRUEBAN un número ajeno; este archivo no agrega
--     ninguna y no deriva ningún total.
--
-- LA ÚNICA OPERACIÓN DE TEXTO, declarada
--
-- Hay UNA cosa que la función hace con texto, y conviene decirla en vez de
-- esconderla: el motivo del OUT.
--
-- El motivo (`FACTURA #N — Cliente`) lo arma `buildInvoiceOutReason` en
-- TypeScript —es la función de formato, con su separador, su recorte a 120 y su
-- respaldo "Cliente sin nombre"—. Pero el número lo conoce la TRANSACCIÓN, no el
-- servicio: es ella la que reserva el consecutivo. Lo que viaja en
-- `p_out_reason` es entonces una PLANTILLA: el mismo texto con el número
-- reemplazado por el token `{consecutivo}`, construida por
-- `buildInvoiceOutReasonTemplate` (service.ts) a partir de la MISMA función de
-- formato con un consecutivo SENTINELA imposible (`-1`: el CHECK de 005 exige
-- `consecutive_number > 0`), así que el texto no está duplicado en ningún lado.
--
-- La función sustituye la PRIMERA ocurrencia del token por el número que
-- reservó, con `overlay` (no con `replace`, que sustituiría todas: un nombre de
-- cliente que contuviera el token no puede corromper el motivo) y exige con una
-- guarda de forma que el token esté presente. No decide el texto, ni el
-- separador, ni el recorte: sustituye un número en una frase que ya viene armada.
--
-- La alternativa era NO mover la reserva adentro y dejar que el servicio mandara
-- el consecutivo y el motivo completos (como 050 manda `p_closed_at`). Se
-- descartó por lo que cuesta: la reserva afuera es, precisamente, el hueco en la
-- serie que el MOTIVO DEL ARCHIVO mide —cualquier fallo posterior la deja
-- quemada, y un consecutivo reservado no se devuelve—. Entre una sustitución de
-- un número y un hueco en la numeración, el hueco es el peor de los dos.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo no
-- las reemplaza: las REPITE dentro de la transacción sobre las filas que
-- corresponde, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * EL TURNO ABIERTO (`getOpenShiftWithOpener`, CAJ-01/FAC-01) SE RECOMPRUEBA
--     SOBRE LA FILA BLOQUEADA: `cash_shifts` se lee con `FOR UPDATE`, su sede
--     tiene que ser la de la emisión y su estado tiene que seguir siendo
--     `abierto`. Cierra una ventana que existía: entre la lectura del turno y la
--     escritura de la factura cabe un cierre de caja, y una factura que nace
--     dentro de un turno ya cerrado descuadra el arqueo de los dos turnos. El
--     error es el MISMO código y el MISMO mensaje que ya devolvía la comprobación
--     del servicio (`SHIFT_NOT_OPEN` → NO_OPEN_SHIFT, 409): el llamador no ve
--     ninguna diferencia.
--   * LA REGLA DE DUEÑO/ADMIN DEL TURNO (sólo quien abrió el turno emite; el
--     admin con justificación, que se audita) NO se mueve: es una decisión sobre
--     ROLES del actor, y los roles son de TypeScript. Se declara abajo como
--     ventana, igual que el candado de nómina cerrada en 050/051.
--   * LA MARCA DE LA 041 (`idempotency_key`) SIGUE MANDANDO, y su LOOKUP NO SE
--     MUEVE: el servicio busca la marca ANTES de llamar, y una repetición sigue
--     siendo un no-op EXITOSO que devuelve el detalle, sin llegar a la
--     transacción. Lo que cambia es que la ESCRITURA de la marca y el índice
--     único parcial `(sede_id, idempotency_key)` se evalúan ADENTRO: si dos
--     envíos con la misma marca se solapan, el segundo choca con el índice
--     (23505), la transacción ENTERA se revierte, y el servicio vuelve a buscar
--     por la marca y devuelve el resultado de la ganadora (el mismo tratamiento
--     que ya tenía). La marca sigue siendo OBLIGATORIA (su forma se comprueba
--     acá con la MISMA regex del CHECK de 041).
--   * EL CONSECUTIVO (FAC-05): la reserva se hace ADENTRO, con la autoridad de
--     siempre (`next_invoice_number`, 005), y el índice único
--     `(sede_id, consecutive_number)` sigue siendo la barrera final contra
--     duplicados. Ver "LA NUMERACIÓN" abajo: es la decisión central del archivo.
--
-- LA NUMERACIÓN (qué pasa con el consecutivo en cada camino, y qué cuesta)
--
-- La reserva se MUEVE ADENTRO. `next_invoice_number` bloquea la fila de
-- `invoice_sequences` de la sede (`SELECT … FOR UPDATE`) e incrementa
-- `last_number`; como ahora eso ocurre dentro de la transacción de la emisión,
-- el incremento se CONFIRMA o se REVIERTE con ella. Consecuencias, camino por
-- camino:
--
--   * EMISIÓN CONFIRMADA: el número queda consumido por la factura, en orden,
--     sin huecos.
--   * EMISIÓN RECHAZADA (cualquier fallo, en cualquier grupo, incluido el stock):
--     el incremento se REVIERTE. NO se quema ningún consecutivo. La serie sigue
--     continua: `consecutives` y facturas emitidas coinciden siempre.
--   * REPETICIÓN DE LA MISMA MARCA (041): no reserva nada —el lookup del
--     servicio la resuelve ANTES— y devuelve la factura existente.
--   * CARRERA DE LA 041 (dos envíos con la misma marca solapados): la perdedora
--     choca con el índice único, la transacción se revierte y su reserva se
--     revierte CON ELLA. El hueco que la 041 documentaba como "COSTO DECLARADO"
--     deja de poder existir en este camino. (La 041 queda como está: su prosa
--     describe el estado del mundo ANTES de este archivo, y este archivo la
--     supersede sólo para la emisión.)
--
-- COSTO DECLARADO DE LA RESERVA ADENTRO: el lock de la fila de
-- `invoice_sequences` de la sede se sostiene hasta el COMMIT de la emisión, no
-- sólo durante el incremento. Consecuencia: dos emisiones concurrentes de la
-- MISMA sede serializan todo el acto —no sólo la asignación del número—, así que
-- la segunda espera a que la primera confirme. Hoy la espera es de unos pocos
-- milisegundos (la emisión son seis sentencias cortas) y, contra eso, el
-- beneficio es que el número deja de ser una promesa que se puede romper. Es un
-- cambio de coste, no de corrección, y se declara acá. NADA se resuelve con un
-- segundo lock: el de la secuencia ya era el punto de serialización de la
-- numeración de la sede.
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS … ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluidos los grupos anteriores y
-- la reserva del consecutivo. Es la misma disciplina de 046, 047, 048, 049, 050
-- y 051. Los grupos vacíos son legales (`0 = 0`): una factura puede no llevar
-- impuestos (ninguno activo) ni porciones (emitida a crédito) ni productos (una
-- venta de servicios), y las redes lo admiten a propósito.
--
--   * GRUPO 1 — la FACTURA: exactamente UNA fila (`INVOICE_MISMATCH`). La red
--     del `INSERT … RETURNING` es también la de la marca y la del consecutivo:
--     el índice único parcial de 041 y el UNIQUE de 005 pueden hacerla fallar
--     con 23505 (que el servicio traduce, ver "EL 23505" abajo).
--   * GRUPO 2 — las LÍNEAS: tantas filas como elementos trae `p_items`
--     (`ITEM_MISMATCH`). Sin esta red, un subconjunto silencioso dejaría una
--     factura sin todas sus líneas y con su total completo.
--   * GRUPO 3 — el SNAPSHOT DE IMPUESTOS: tantas filas como impuestos activos
--     (`TAX_MISMATCH`). El arreglo vacío es legal.
--   * GRUPO 4 — las PORCIONES: tantas filas como porciones (`PAYMENT_MISMATCH`).
--     El arreglo vacío es legal (factura sin cobro).
--   * GRUPO 5 — el STOCK: `deduct_stock_atomic` (046) tiene SU propia red (y
--     fracasa con `PRODUCT_NOT_FOUND` si un producto no existe o es de otra
--     sede). Acá se contrasta además lo que DEVOLVIÓ contra lo que se pidió
--     (`MOVEMENT_MISMATCH`): una respuesta incoherente se reporta como fallo real
--     en vez de dar por aplicado un descuento que la base no hizo.
--   * La reserva del consecutivo no necesita red: `next_invoice_number` devuelve
--     el número que acaba de escribir, y si la transacción aborta después, la
--     reversión es del servidor, no una compensación que alguien tenga que
--     recordar.
--
-- EL 23505 TIENE DOS ORÍGENES Y UN SOLO TRATAMIENTO
--
-- Un choque 23505 dentro de esta transacción puede venir del índice único
-- parcial de la MARCA (041: `uq_invoices_sede_idempotency_key`) o del UNIQUE del
-- CONSECUTIVO (005: `invoices_sede_id_consecutive_number_key`). El servicio ya
-- resuelve la ambigüedad como siempre y en el mismo orden: vuelve a buscar por
-- la MARCA y, si hay una factura con esa marca, devuelve esa (la carrera de la
-- 041, no-op exitoso); si no la hay, el choque es del consecutivo y responde
-- `DUPLICATE_NUMBER` (409). Este archivo no cambia ese contrato: sólo hace que el
-- choque NO escriba nada (antes escribía lo mismo hasta el INSERT fallido) y que
-- no queme el consecutivo de la perdedora.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA y va
-- secuencia → turno → productos. La emisión toma PRIMERO la fila de
-- `invoice_sequences` de su sede (dentro de `next_invoice_number`), DESPUÉS la
-- fila de su turno de caja (la precondición) y al final las filas de `products`,
-- en el orden ascendente por id que fija 046 (`ORDER BY p.id`) y que es el orden
-- en el que el trigger `trg_inventory_apply_stock` (004) toma sus locks.
-- `next_invoice_number` no lo llama nadie más, así que no hay ciclo posible por
-- la secuencia; el turno lo toma la caja (049) en el mismo orden relativo
-- —primero el turno— y ninguna de sus operaciones vuelve a pedir la secuencia ni
-- un producto; y los productos se piden siempre DESPUÉS de la factura o del
-- turno, en el orden de 046, así que dos operaciones concurrentes no pueden
-- quedar esperándose en ciclo.
--
-- LA MARCA DE LA 045 NO ENTRA ACÁ (dos mecanismos, no uno)
--
-- El OUT de stock lo escribe `deduct_stock_atomic` (046) con
-- `idempotency_key` en NULL, EXPLÍCITAMENTE, y esta función no lo toca: la
-- emisión no tiene un intento de cliente por producto, su puerta es la marca de
-- la FACTURA y sus filas quedan FUERA del índice único parcial de la 045. Este
-- archivo no cambia esa conclusión ni vuelve obligatoria la marca en
-- `registerMovement`; lo único que cambia es QUIÉN llama a `deduct_stock_atomic`:
-- antes `deductStock` (una transacción propia, y por eso una ventana), ahora esta
-- transacción.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay UPDATE, DELETE ni TRUNCATE en ninguna parte, ni
--     sobre las tablas de facturación ni sobre las de inventario. Las filas de
--     datos que la emisión escribe las escribe el código, por esta función.
--   * No agrega ni quita columnas, índices ni constraints: los INSERT usan las
--     columnas de 004/005/019/020/021/030 y los índices y triggers que importan
--     ya existen (`uq_invoices_sede_idempotency_key` de 041,
--     `invoices_sede_id_consecutive_number_key` de 005, `trg_invoice_payments_cap`
--     de 031, los de 004 y la PK de `invoice_sequences`). No hay índice nuevo
--     que justificar ni coste de escritura nuevo que declarar.
--   * No toca la ARITMÉTICA del dinero ni del stock: no recalcula totales, no
--     aplica recargos, no suma impuestos, no agrega cantidades por producto y no
--     escribe `products.stock_qty` ni una sola vez (el stock lo aplica
--     EXCLUSIVAMENTE `trg_inventory_apply_stock`, 004).
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (005) el
--     único escritor de esas columnas.
--   * No redefine `next_invoice_number` (005) ni `deduct_stock_atomic` (046):
--     las LLAMA. Son las autoridades del consecutivo y del kardex, y siguen
--     siendo las únicas.
--   * No backfillea ni repara lo que la ventana ya dejó a medias: ver la nota
--     operativa al final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma y
-- el mismo tipo de retorno deja la función idéntica en cada corrida; REVOKE/GRANT
-- son idempotentes. El runner de Supabase aplica el archivo en una transacción: o
-- entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La función. Va PRIMERO porque es el objeto que los permisos y el
--      comentario de abajo nombran.
--   2. El `search_path` fijo (house style desde 018): la función resuelve
--      `invoices`, `invoice_items`, `invoice_taxes`, `invoice_payments`,
--      `cash_shifts` y `invoice_sequences`, y con una ruta mutable un esquema
--      anterior podría secuestrar esos nombres.
--   3. Los permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. El comentario de la función, para el que la lea desde `\df`.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 052, el siguiente libre
-- (032 no existe y no existirá; 033–051 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. La tabla de la numeración de la
-- FACTURA es `invoice_sequences` (005), que NO es una serie: es un contador por
-- sede, y en este camino el contador sólo avanza cuando la emisión confirma. Es
-- decir: ACÁ NO SE QUEMA NINGÚN CONSECUTIVO, ni en el camino normal ni en
-- ninguno de los rechazos —es lo que este archivo compra y su razón de ser—. Las
-- otras tablas que esta función toca no tienen serie:
-- `invoices`, `invoice_items`, `invoice_taxes`, `invoice_payments` e
-- `inventory_movements` usan `uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * LA REGLA DE DUEÑO/ADMIN DEL TURNO (`SHIFT_NOT_OWNER`) sigue siendo una
--     decisión del servicio, ANTES de la transacción, porque depende de los
--     ROLES del actor y de quién abrió el turno (una lectura de `cash_shifts` que
--     el servicio ya hace). Lo que sí se recomprueba adentro es el ESTADO del
--     turno (abierto) y su sede.
--   * LA LECTURA QUE ALIMENTA LA EMISIÓN (catálogos, stock, turno, métodos
--     activos) sigue separada de la escritura: eso NO se cierra alargando la
--     transacción (haría durar los locks todo el cálculo). Lo que cierra es que
--     la ESCRITURA sea indivisible y que una carrera pierda ruidosamente
--     (INSUFFICIENT_STOCK del trigger, SHIFT_NOT_OPEN, 23505).
--   * LA AUDITORÍA (`writeAudit`) queda FUERA de la transacción: es un INSERT
--     posterior y separado. No es un punto de fallo de estado (`writeAudit` no
--     lanza: registra y sigue), así que a lo sumo falta la fila de auditoría,
--     nunca una escritura a medias. El precio es el mismo que en 049, 050 y 051:
--     una emisión confirmada puede quedarse sin su fila de auditoría.
--   * LA RELECTURA DEL DETALLE (`loadDetail`, posterior al commit) sigue siendo
--     un fallo posible DESPUÉS de una emisión confirmada. Lo que cambia es lo que
--     deja: la emisión COMPLETA —antes, ese mismo fallo podía disparar la
--     compensación y dejar el residuo—, y el reintento del MISMO envío (la marca
--     de 041) devuelve la factura. El error, ESO sí, se reporta como un fallo de
--     la emisión aunque la factura exista: el llamador no puede distinguirlo sin
--     reintentar, y en este camino reintentar es seguro y barato.
--   * UN FALLO DEL SERVIDOR ENTERO (la conexión se corta, la base se reinicia)
--     entre el COMMIT y la respuesta: la emisión quedó hecha y el llamador no
--     recibió nada. Lo cubre la marca de 041 —el reintento devuelve la factura
--     emitida— y es exactamente para lo que la marca existe.
--   * LA VENTANA ENTRE LAS SENTENCIAS DE LA EMISIÓN: ninguna. Es una transacción
--     del servidor; no hay un instante observable a medias entre su primera
--     sentencia y su commit.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 052 va ANTES que este código. Sin la función, la
-- emisión no puede escribir NADA —el RPC no existe y `createInvoice` falla entero
-- ANTES de escribir, que es la dirección segura: una emisión que no se puede
-- registrar no cobra ni descuenta stock a medias—, y con la función y sin el
-- código la emisión sigue siendo la secuencia de requests sueltos con su
-- compensación (no hay regresión, sólo no mejora). El servicio TAMPOCO puede
-- desplegarse antes de tiempo al revés: con el código nuevo y sin la función, la
-- emisión rechaza TODOS los intentos (el RPC no existe), así que el orden es
-- obligatorio.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La EMISIÓN entera, indivisible
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb)`:
-- la sede del actor, quién emite, el turno de caja abierto (la precondición que
-- se recomprueba adentro), la MARCA del intento (041, obligatoria), y los cinco
-- grupos como DATOS: la factura (sus montos, su estado y su cierre), las líneas,
-- el snapshot de impuestos, las porciones y el plan de stock; más la PLANTILLA
-- del motivo del OUT.
--
-- El tipo de retorno es la FACTURA ESCRITA (jsonb), con las MISMAS columnas que
-- el servicio leía con `INVOICE_SELECT`: el llamador no necesita otra lectura
-- para tener la fila (y el detalle se lee después, fuera de la transacción).
-- El mismo criterio que 050 y 051.
CREATE OR REPLACE FUNCTION public.invoice_create_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_user_id IS NULL
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
  --     completa (producto repetido, producto de otra sede, existencia) la hace
  --     `deduct_stock_atomic` (046) con su propio SQLSTATE.
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
  --     entre la lectura que el servicio ya hizo y la escritura de la factura. La
  --     sede también se verifica: una emisión no se atribuye al turno de otra
  --     sede. El estado se relee de la FILA (no del dato que mandó el llamador).
  SELECT s.status
    INTO v_turno_estado
  FROM public.cash_shifts s
  WHERE s.id = p_cash_shift_id
    AND s.sede_id = p_sede_id
  FOR UPDATE OF s;

  IF NOT FOUND OR v_turno_estado <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN';
  END IF;

  -- 1.8 EL CONSECUTIVO, reservado ADENTRO: es la decisión central de este
  --     archivo. La autoridad es la de siempre (`next_invoice_number`, 005:
  --     bloquea la fila de `invoice_sequences` de la sede e incrementa
  --     `last_number`), pero ahora el incremento pertenece a ESTA transacción: si
  --     algo falla de acá en adelante, se revierte con ella y el número NO queda
  --     quemado. El costo está declarado arriba (el lock se sostiene hasta el
  --     commit).
  v_consecutivo := public.next_invoice_number(p_sede_id);

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
    (sede_id, consecutive_number, idempotency_key, client_name, client_document,
     subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id,
     closed_by, closed_at)
  VALUES
    (p_sede_id,
     v_consecutivo,
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
  --      traduce el servicio (ver "EL 23505" arriba).
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

  -- 1.12 Red de seguridad: tantas líneas como elementos llegaron. Sin esta red,
  --      un subconjunto silencioso dejaría una factura con su total completo y
  --      sin todas sus líneas (y la nómina pagando comisiones de menos).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  -- 1.13 GRUPO 3: el SNAPSHOT DE IMPUESTOS, UNA sentencia (y ninguna fila
  --      cuando no hay impuestos activos: `0 = 0` es legal). El monto y el
  --      porcentaje vienen computados.
  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    v_factura.id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_taxes) AS item;

  -- 1.14 Red de seguridad: tantos impuestos como llegaron.
  SELECT jsonb_array_length(p_taxes) INTO v_esperados;

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

  -- 1.16 Red de seguridad: tantas porciones como llegaron. El tope de cobro de
  --      031 (`trg_invoice_payments_cap`) corre dentro de esta sentencia con su
  --      propio P0001, y el servicio lo traduce a OVERPAID como siempre.
  SELECT jsonb_array_length(p_payments) INTO v_esperados;

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
    v_aplicados := public.deduct_stock_atomic(p_sede_id, p_user_id, v_motivo, p_out_items);

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
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `cash_shifts` e `invoice_sequences` (esta última dentro de
-- `next_invoice_number`): con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018 (y el mismo paso que da
-- 039).
ALTER FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría EMITIR facturas por PostgREST —cobrar, descontar
-- stock, quemar consecutivos y cerrar el turno que quisiera—. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) IS
'CL-13: la EMISIÓN de una factura, ATÓMICA. Reserva el consecutivo (next_invoice_number, 005), escribe la factura, sus líneas, su snapshot de impuestos, sus porciones y el OUT de stock (deduct_stock_atomic, 046) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con las precondiciones recomprobadas sobre la fila bloqueada (el turno de caja abierto, con FOR UPDATE). El servicio computa TODO —subtotales, impuestos, recargos, totales, estado, plan de stock y el motivo del OUT como plantilla— y la función sólo escribe lo que recibe: no hay una sola expresión aritmética sobre una columna de dinero. Un fallo de cualquier grupo revierte la emisión COMPLETA, incluida la reserva del consecutivo: no queda residuo parcial y no se quema ningún número, así que NO hay compensación (cleanupFailedInvoice se elimina con este archivo). Rechaza con INVOICE_INVALID (entrada mal formada), OUT_REASON_INVALID (la plantilla del motivo no trae su token), SHIFT_NOT_OPEN (el turno se cerró en la ventana), INVOICE_MISMATCH / ITEM_MISMATCH / TAX_MISMATCH / PAYMENT_MISMATCH / MOVEMENT_MISMATCH (las redes de conteo) y lo que levanten 005/031/041/046 (23505, el tope de cobro, INSUFFICIENT_STOCK, PRODUCT_NOT_FOUND). Devuelve la factura escrita con las columnas de INVOICE_SELECT. El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y el consecutivo lo sigue asignando EXCLUSIVAMENTE next_invoice_number (005). Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
--   * Una emisión que ya quedó a medias por el defecto anterior NO se repara
--     sola y no hay forma de detectarla desde los datos con certeza: una factura
--     viva sin sus porciones, o con sus líneas borradas, es indistinguible de una
--     factura legítima sin cobro. Se reconcilia contra la caja (el dinero que
--     entró) y contra el conteo físico del stock, decidido por quien opera la
--     base. El kardex es la mejor pista: un OUT y un IN de la misma cantidad, con
--     el motivo de compensación ("Compensación fallo emisión factura #N"), sobre
--     una factura que no existe.
--   * Los HUECOS en la serie de consecutivos que el defecto anterior dejó
--     (una reserva sin factura) quedan como están: no se renumeran ni se
--     rellenan. La serie se conserva; un hueco es exactamente el rastro del
--     fallo, y taparlo borraría la evidencia.
--   * Después de este archivo, un hueco NUEVO sólo puede venir de algo que NO
--     pasa por acá (una emisión manual sobre la base, o un `last_number` movido a
--     mano). Si un hueco nuevo aparece, es señal de que hay otro camino de
--     emisión que hay que encontrar.
