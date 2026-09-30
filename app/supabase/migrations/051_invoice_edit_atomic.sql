-- 051_invoice_edit_atomic.sql — CL-12: las DOS ventanas que le quedaban a la
-- edición de factura dejan de poder existir: la EDICIÓN ADMIN (total inmutable)
-- y la EDICIÓN LIBRE de una emitida (total recalculado).
--
-- MOTIVO DEL ARCHIVO (las dos ventanas, medidas)
--
-- El barrido de atomicidad encontró, en `src/features/billing/service.ts`, los
-- dos últimos caminos de escritura múltiple de la MISMA clase que CL-7 (046),
-- CL-8 (047), CL-9 (048), CL-10 (049) y CL-11 (050): son SECUENCIAS de requests
-- distintos contra PostgREST, que no ofrece multi-statement por request (la
-- misma nota que ya está escrita en 005, 039, 040, 041, 042, 043, 044, 045, 046,
-- 047, 048, 049 y 050). Las líneas que siguen son las del código PREVIO a este
-- archivo (el que se midió):
--
--   a) `editInvoiceItems` (service.ts:1516; el candado `claimInvoiceEdit` en
--      :1668, el borrado de ítems en :1679, su actualización en :1685, las altas
--      en :1703, el cambio de método de los cobros en :1721 y el ajuste de stock
--      en :1731). Reclama el token de la edición (`edit_version`, 038), BORRA y
--      ACTUALIZA e INSERTA los ítems, pisa el método de cada cobro y DESPUÉS
--      aplica el ajuste de stock por delta NETO por producto, un
--      `registerMovement` por producto. Un fallo a mitad de la secuencia —una
--      escritura que falla, la conexión que se corta, el trigger de stock que
--      rechaza el segundo producto— dejaba la factura con los ÍTEMS YA
--      reemplazados y el STOCK A MEDIAS, y con el token YA avanzado: como el
--      candado es un compare-and-swap sobre la versión, el reintento de la MISMA
--      edición afecta 0 filas y se rechaza con `EDIT_CONFLICT`. El ajuste que
--      faltaba no se aplicaba NUNCA, y nada lo detectaba: el estado parcial es
--      indistinguible de una edición completa sin otro error a la vista.
--
--   b) `editEmittedInvoiceItems` (service.ts:1765; el candado en :1988, los
--      ítems en :1999/:2005/:2023, los cobros en :2041, el reemplazo del
--      snapshot de impuestos en :2046/:2049, los totales en :2061 y el stock en
--      :2078). La MISMA secuencia, más el `DELETE` de `invoice_taxes` y el
--      `INSERT` del snapshot nuevo, más el `UPDATE` de los totales. Un fallo a
--      mitad dejaba lo mismo —ítems, impuestos y totales escritos, stock a
--      medias, token avanzado y reintento rechazado— y es PEOR por dos razones:
--      el reemplazo del snapshot de impuestos tiene una ventana propia (entre el
--      `DELETE` de :2046 y el `INSERT` de :2049 la factura queda SIN impuestos,
--      que no es ni el snapshot viejo ni el nuevo), y el CIERRE DEL TURNO se
--      firma ARRIBA de ese estado: la caja arquea contra una factura que ya no
--      es la que se emitió ni la que el operador quiso editar.
--
-- MECANISMO (una FUNCIÓN por edición, y por qué)
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)` es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046, `payroll_apply_atomic` 047, las dos de 048, las
-- tres de 049 y las dos de 050). Una función es UNA sentencia, y una sentencia
-- corre ENTERA dentro de una sola transacción del servidor: o se escriben TODAS
-- las filas de la edición, o no se escribe ninguna. Cada edición recibe su
-- propia función:
--
--   * `invoice_edit_items_atomic` — la edición ADMIN: el token, los ítems, los
--     métodos de los cobros y el ajuste de stock.
--   * `invoice_edit_emitted_atomic` — la edición LIBRE de una emitida: lo mismo
--     MÁS el reemplazo del snapshot de impuestos y los totales.
--
-- UNA FUNCIÓN POR EDICIÓN Y NO UNA SOLA PARA LAS DOS. La tentación es evidente
-- —el diff de ítems, los cobros, el stock y el candado son idénticos— y sin
-- embargo la respuesta es dos, por una razón que no es de forma sino de DINERO:
-- las dos ediciones tienen POLÍTICAS DISTINTAS sobre el total. La admin lo tiene
-- INMUTABLE (`assertEditReconciles`: el subtotal nuevo tiene que igualar al
-- emitido) y la libre lo RECALCULA. Con UNA función compartida, la escritura del
-- total y del snapshot de impuestos tendría que existir en la función y quedar
-- desactivada por un discriminador ("si viene `p_totals`, escribilo"): la
-- inmutabilidad del total de la admin pasaría a ser una promesa del LLAMADOR, no
-- una propiedad de la operación —exactamente lo que este paquete viene evitando
-- desde 046—. Con DOS funciones, la de la admin NO TIENE un grupo capaz de
-- escribir dinero: no hay sentencia que pueda mover su total ni sus impuestos, y
-- la inmutabilidad queda ESTRUCTURAL. Además son dos llamadores distintos, dos
-- precondiciones de servicio distintas (sólo admin / caja dueña del turno o
-- admin; la libre rechaza `Pagada`) y dos permisos que conviene poder revisar
-- por separado. Es la misma decisión que 050 tomó entre anular y cobrar.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * COMPENSAR EN EL CLIENTE (rehacer los ítems borrados si falla el stock,
--     reinsertar el snapshot de impuestos si falla el total). Compensar es
--     escribir OTRA vez y volver a exponerse al mismo fallo a mitad de camino:
--     se compensa el borrado y falla la compensación, y queda el estado parcial
--     Y sin registro de que faltaba compensarlo. Y en esta operación la
--     compensación es peor que en las anteriores: lo que habría que rehacer es
--     una COLECCIÓN BORRADA —los ítems que el diff quitó, los impuestos que el
--     reemplazo pisó—, y reconstruirla exige tenerla a mano y volver a
--     escribirla con los mismos subtotales computados. La única compensación tan
--     sólida como una transacción es una transacción.
--   * INVERTIR EL ORDEN DE LAS ESCRITURAS (el stock primero y los ítems
--     después). Cambia de lugar la ventana, no la cierra: con el stock aplicado
--     y la edición no escrita, el kardex muestra un ajuste de una factura que
--     sigue teniendo los ítems viejos —y el token avanzado rechaza el reintento,
--     así que el kardex queda mintiendo sin que la factura lo explique—. Una
--     transacción no depende del orden para ser atómica; compensar sí, y por eso
--     no se compensa.
--   * UN TRIGGER QUE AJUSTE EL STOCK AL ACTUALIZAR LOS ÍTEMS. Sería una sola
--     sentencia y el disparador haría el resto, pero movería a SQL QUÉ se ajusta
--     y CON QUÉ motivo: el delta NETO por producto —que se calcula comparando
--     las líneas LEÍDAS contra las que llegan, agregando por producto y
--     descartando los deltas que quedan en cero— y el texto del kardex
--     (`Ajuste edición factura #N — motivo` / `Edición libre emitida factura
--     #N`) los computa el servicio. Un trigger además no podría contrastar
--     cuántos movimientos esperaba el llamador (el subconjunto silencioso
--     volvería a ser posible) ni distinguir las dos políticas del total.
--     Descartado.
--   * BLOQUEAR POR SEDE O POR TABLA en vez de por fila. Cerraría la ventana a
--     costa de serializar ediciones de facturas DISTINTAS —y contra cobros y
--     anulaciones, que también pasan por `invoices`—, que es justo lo que la 038
--     evitó a propósito ("el candado es por FILA, no global"). Descartado.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y las funciones SÓLO ESCRIBEN. Acá no se mueve NADA de
-- aritmética de dinero (ni de stock) a SQL:
--
--   * QUÉ se borra, QUÉ se actualiza y QUÉ se inserta —el diff de
--     `diffInvoiceItems` (TypeScript), con el `subtotal` de cada línea ya
--     computado por `computeLineSubtotal`— lo decide el servicio y viaja como
--     DATO; la función escribe cada columna VERBATIM. El `::numeric`, el
--     `::integer`, el `::uuid` y el `::boolean` son CONVERSIONES de
--     representación (jsonb → la columna), no operaciones aritméticas.
--   * QUÉ se ajusta en el stock —el delta NETO por producto, su tipo (OUT si
--     sube la cantidad, IN si baja) y el motivo del kardex— lo decide el
--     servicio y viaja como DATO; la función escribe cada movimiento verbatim y
--     no arma una sola concatenación de texto.
--   * El SNAPSHOT DE IMPUESTOS y los TOTALES de la edición libre llegan
--     computados (`computeInvoiceTotals` / `snapshotInvoiceTaxes`, con
--     `roundMoney` y la regla del peso entero) como DATO: la función no suma, no
--     redondea ni compara.
--   * La decisión de que el total de la edición admin no se mueve es de
--     TypeScript (`assertEditReconciles`, con su mensaje TOTAL_MISMATCH) y acá
--     es además ESTRUCTURAL: esa función no tiene una sentencia que escriba
--     `subtotal`, `discount`, `tax`, `surcharge` ni `total`.
--   * El candado de nómina cerrada (`invoiceInClosedPayroll`), el estado
--     terminal (`Anulada`), el rechazo de `Pagada` en la libre, el gate de
--     sobre-cobro (`overCollectedEdit`) y el pre-chequeo de stock
--     (`planStockDeduction`) se quedan donde están: en TypeScript, ANTES de
--     llamar.
--   * La única validación de un número que ocurre en la base es la de siempre:
--     los CHECK de `invoices`, `invoice_items`, `invoice_taxes` (005/019) y el
--     CHECK de `inventory_movements` más el trigger de stock (004). Son barreras
--     PREEXISTENTES que COMPRUEBAN un número ajeno; este archivo no agrega
--     ninguna y no deriva ningún total.
--
-- LAS PRECONDICIONES DE ESTADO (conservadas, y por qué también adentro)
--
-- El servicio revisa las MISMAS precondiciones antes de llamar, y este archivo
-- no las reemplaza: las REPITE dentro de la transacción, sobre la fila
-- BLOQUEADA, para que no puedan volverse mentira entre la lectura y la
-- escritura. Una transacción NO es un camino para saltear una guarda.
--
--   * EL CANDADO DE LA 038 SE MUEVE ADENTRO (es la decisión central de este
--     archivo). El token `invoices.edit_version` deja de reclamarse desde el
--     cliente (`claimInvoiceEdit`) y pasa a escribirse en la MISMA sentencia que
--     la edición, con la precondición `(versión, estado)` en su propio `WHERE`,
--     sobre la fila YA bloqueada con `FOR UPDATE`. Las dos formas eran válidas
--     —moverse o reescribirse como precondición con la fila bloqueada— y acá se
--     hacen las dos juntas: el lock es lo que hace ESPERAR a la edición
--     concurrente, y el `WHERE` es lo que la RECHAZA si el estado o la versión
--     cambiaron. Una edición que llega segunda espera el lock, encuentra la
--     versión nueva y se rechaza con `EDIT_CONFLICT`: NO se aplica en silencio.
--     El estado sigue siendo la otra mitad de la precondición (CL-1): una
--     anulación o un cobro que ganen la ventana lectura→escritura dejan la fila
--     terminal y la edición se rechaza por el MISMO código, con su mensaje.
--   * El candado de NÓMINA CERRADA (`invoiceInClosedPayroll`, que bloquea tocar
--     al empleado ya pagado) NO se mueve: sigue siendo una lectura del servicio
--     sobre `payroll_periods`/`payroll_items`, ANTES de llamar. No se replica
--     adentro a propósito: no es una precondición de una fila —es una lectura
--     paginada de otro módulo— y meterla en la transacción alargaría los locks
--     todo un barrido (el mismo límite que declara 050).
--   * La AUDITORÍA (`writeAudit`) queda FUERA de la transacción: es un INSERT
--     posterior y separado. No es un punto de fallo de estado (`writeAudit` no
--     lanza), así que a lo sumo falta la fila de auditoría, nunca una escritura
--     a medias.
--
-- LAS REDES DE CONTEO (una por grupo de escritura, y qué pasa si fallan)
--
-- Cada grupo de escritura se cuenta con `GET DIAGNOSTICS ... ROW_COUNT` y, si no
-- escribió EXACTAMENTE lo que recibió, la función lanza una excepción: la
-- transacción del servidor se revierte ENTERA, incluidos los grupos anteriores.
-- Es la misma disciplina de 046, 047, 048, 049 y 050. Los grupos vacíos son
-- legales (`0 = 0`): una edición puede no borrar nada, no cambiar nada, no
-- agregar nada y no mover stock —una factura de servicios, o una edición que
-- sólo cambia el método de un cobro—, y las redes lo admiten a propósito.
--
--   * La edición ADMIN tiene SEIS redes: el token (la fila de la factura), el
--     borrado, la actualización y la inserción de ítems, los cobros y los
--     movimientos. Menos ítems que los pedidos, o menos movimientos que los
--     pedidos, aborta todo (`ITEM_MISMATCH` / `PRODUCT_NOT_FOUND`): sin esas
--     redes, un subconjunto silencioso dejaría la edición aplicada a medias con
--     el token ya avanzado, que es exactamente la ventana.
--   * La edición LIBRE tiene OCHO: las seis anteriores más el borrado y la
--     inserción del snapshot de impuestos. El borrado del snapshot se cuenta
--     contra los ids que el servicio LEYÓ (`taxes_remove`), no contra un
--     `DELETE ... WHERE invoice_id = …` a ciegas: un reemplazo se puede contar
--     —"quité exactamente lo que leí e inserté exactamente lo que computé"— y un
--     borrado sin cuenta no podría distinguir "no había nada que borrar" de "el
--     snapshot cambió bajo los pies".
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA y pasa por la fila de la
-- FACTURA, que es el punto de serialización de la edición (038) y también del
-- dinero de esa factura (050: la anulación y el cobro toman el MISMO lock). La
-- edición bloquea PRIMERO la fila de la factura y después, si hay ajuste de
-- stock, las filas de sus productos —insertando los movimientos en orden
-- determinista ascendente por producto (`ORDER BY p.id`), que es el orden en el
-- que el trigger `trg_inventory_apply_stock` (004) toma sus locks—. Dos
-- ediciones de la MISMA factura se bloquean en el MISMO orden (factura,
-- después lo demás), así que la segunda espera a la primera y no hay ciclo. Los
-- ítems, los cobros y los impuestos NO llevan orden: pertenecen a una
-- transacción que ya tiene el lock de su factura y ninguna otra puede verlos
-- antes del commit. EFECTO DECLARADO: las filas del kardex de una edición
-- quedan insertadas en orden ascendente por producto (antes, en el orden en que
-- el servicio iteraba los productos: el orden de `productIds`, que es el de
-- aparición de las líneas). El CONJUNTO de movimientos es el mismo y el orden
-- del kardex no participa de ninguna regla; lo que cambia es la posición de las
-- filas entre sí, y es el precio —ya pagado en 046, 050 y 049— de que dos
-- transacciones que comparten productos no se bloqueen en ciclo.
--
-- EL REEMPLAZO: QUÉ SIGNIFICA "TODO O NADA" ACÁ (lo distinto de estas ventanas)
--
-- A diferencia de las operaciones de 046–050, que AGREGAN filas, la edición
-- REEMPLAZA una colección: los ítems (borra los que se quitaron, actualiza los
-- que cambian, inserta los nuevos) y, en la libre, el snapshot de impuestos
-- (borra el que se leyó e inserta el que se computó). "Todo o nada" en un
-- reemplazo quiere decir las DOS MITADES: o queda la colección ANTERIOR
-- completa, o queda la NUEVA completa. El estado intermedio —el borrado hecho y
-- la inserción no— no es un reemplazo a medias: es una colección VACÍA, que no
-- es ninguna de las dos y que la factura no puede explicar. Por eso el borrado
-- lleva cuenta (contra los ids leídos) y por eso el rollback tiene que devolver
-- la colección anterior COMPLETA. El doble de las pruebas modela exactamente
-- eso: trabaja sobre un estado aparte y lo publica entero (o no publica nada).
--
-- LA MARCA DE LA 045 NO ENTRA ACÁ (dos mecanismos, no uno)
--
-- Los movimientos del ajuste se escriben con `idempotency_key` en NULL,
-- EXPLÍCITAMENTE, como la deducción de 046 y la reversión de 050: la edición no
-- tiene un intento de cliente —su puerta es el candado de la 038/CL-12 sobre la
-- FACTURA y su identidad no vive en el movimiento—. Las filas quedan FUERA del
-- índice único parcial de la 045 (`WHERE idempotency_key IS NOT NULL`) y no
-- compiten con nadie. Consecuencia declarada: después de este archivo, la
-- edición deja de pasar por `registerMovement` —la 045 y la 046 lo listan entre
-- sus llamadores de facturación— y pasa por estas funciones; la fila sigue
-- naciendo SIN marca, así que ni el índice de la 045 ni su conclusión cambian.
-- Lo que NO se hace acá es volver obligatoria la marca en `registerMovement`.
--
-- QUIÉN PUEDE LLAMARLAS (decisión de permiso, explícita)
--
--   * NO necesitan ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declaran
--     SECURITY INVOKER, igual que 039 y 046–050.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría las dos ediciones a cualquier JWT
--     (anon/authenticated) por PostgREST: cualquiera podría reescribir los
--     ítems de una factura emitida —y con ellos las comisiones de la nómina—,
--     mover su stock y, en la libre, reescribir sus totales y sus impuestos,
--     salteando el candado de nómina cerrada, el estado terminal y el turno de
--     caja. Se cierra en los pasos 3 y 7: se revoca de PUBLIC, anon y
--     authenticated, y se otorga sólo a service_role. Es la misma decisión que
--     018 tomó para `write_audit_log`, que 039 para `replace_user_roles`, que
--     046 para `deduct_stock_atomic` y que 047–050 para sus funciones.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas DE DATOS: sólo crea/reemplaza dos funciones y
--     ajusta permisos. No hay un solo `ALTER TABLE`, ni un `CREATE INDEX`, ni un
--     `DROP`, ni un backfill. Los dos `DELETE` y los dos `INSERT` que contiene la
--     función de la edición libre son los MISMOS que el servicio ya hacía en el
--     momento de editar (el reemplazo de los ítems y el del snapshot de
--     impuestos, filtrando por la factura): son la OPERACIÓN, no una migración de
--     datos, y corren dentro de la transacción de esa operación.
--   * No agrega ni quita columnas, índices ni constraints: los INSERT/UPDATE
--     usan las columnas de 004/005/019/023/030 y los índices y triggers que
--     importan ya existen (la PK de `invoices`, `invoice_items`,
--     `invoice_taxes`, `invoice_payments` e `inventory_movements`, el índice de
--     `edit_version` implícito en la PK, y los triggers de 004 y 005).
--   * No toca la aritmética del dinero ni del stock: no escribe `stock_qty`, no
--     recalcula subtotales, no aplica recargos, no suma impuestos.
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (005) el
--     único escritor de esa columna. Efecto declarado de unir el token y los
--     totales en UNA sentencia: la fila de la factura se toca UNA vez por
--     edición (antes la libre la tocaba dos: el token y después los totales),
--     así que su `updated_at` refleja la edición completa —que es lo que
--     significa— en vez del último de los dos pasos.
--   * No toca los caminos de dinero de otros módulos: ni `payments` (el espejo
--     de caja), ni `cash_shifts`, ni la nómina, ni `next_invoice_number`.
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
--      `invoices`, `invoice_items`, `invoice_payments`, `products` e
--      `inventory_movements` (y `invoice_taxes` la libre), y con una ruta
--      mutable un esquema anterior podría secuestrar esos nombres.
--   3. Sus permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. Su comentario, para el que la lea desde `\df`.
--   La edición ADMIN va primero porque es la operación más chica y la que fija
--   la forma; la LIBRE después, que es la admin MÁS el reemplazo de impuestos y
--   los totales.
--
-- LOS GRUPOS DE ESCRITURA VIAJAN EN UN OBJETO, NO EN CINCO ARGUMENTOS SUELTOS:
-- la firma lleva `p_edit jsonb` con una clave por grupo (`items_remove`,
-- `items_update`, `items_insert`, `payments`, `movements` y, en la libre,
-- `taxes_remove`, `taxes`, `totals`). Cinco (u ocho) arreglos jsonb del mismo
-- tipo, uno al lado del otro en la lista de argumentos, es un lugar donde un
-- intercambio de orden no lo ve ni el compilador ni el lector y la escritura
-- sale con los datos del grupo equivocado; adentro de un objeto, cada grupo se
-- nombra. La forma se valida igual de estricto (clave por clave) y las claves
-- ausentes se tratan como arreglo VACÍO, que es el caso legal de "no hay nada de
-- ese grupo".
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 051, el siguiente libre
-- (032 no existe y no existirá; 033–050 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. Ninguna de las tablas que
-- toca tiene serie ni consecutivo —`invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments` e `inventory_movements` usan `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`—, así que una operación abortada no deja fila y no deja
-- hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO: el consecutivo de la FACTURA
-- (`next_invoice_number`, 005) no pasa por acá —la edición no reserva números— y
-- el token de la 038 no es un consecutivo: es un contador de versión por fila, y
-- una transacción rechazada no lo mueve.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * El candado de nómina cerrada sigue siendo una lectura del servicio ANTES
--     de la transacción: una nómina puede cerrarse entre esa lectura y la
--     edición. Cerrarla exigiría leer `payroll_periods` y `payroll_items`
--     —paginado, de otro módulo— dentro de la transacción, con los locks de la
--     factura tomados todo el barrido (el mismo límite declarado en 050).
--   * La LECTURA que alimenta la edición (el detalle de la factura, los
--     catálogos, el stock) sigue separada de la escritura: eso NO se cierra
--     alargando la transacción (haría durar los locks todo el cálculo). Lo que
--     cierra es que la ESCRITURA sea indivisible y que una carrera pierda
--     ruidosamente (`EDIT_CONFLICT`), como se probó.
--   * El pre-chequeo de stock (`planStockDeduction`) sigue en TypeScript y sigue
--     siendo una FOTO: entre la foto y la transacción, otro movimiento puede
--     dejar el stock corto. La guarda que manda es la del trigger de 004, que
--     corre ADENTRO y aborta la edición entera con `INSUFFICIENT_STOCK`.
--   * La auditoría queda fuera (ver arriba), y el envío de la edición no tiene
--     marca de idempotencia propia: repetir el MISMO envío después de un éxito
--     es una edición NUEVA (el diff se recalcula contra lo que quedó, y suele
--     quedar vacío). Es el comportamiento de siempre y no se cambia acá.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 051 va ANTES que este código. Sin las
-- funciones, las dos ediciones no pueden escribir NADA —los RPC no existen y las
-- operaciones fallan enteras ANTES de escribir, que es la dirección segura: una
-- edición que no se puede aplicar no deja la factura a medias—, y con las
-- funciones y sin el código las dos ediciones siguen siendo las de las
-- escrituras sueltas (no hay regresión, sólo no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La edición ADMIN (total INMUTABLE) entera, indivisible
-- ===================================================================== ---

-- Firma `(uuid, uuid, uuid, integer, text, jsonb)`: la sede del actor, la factura,
-- quién edita, la VERSIÓN que el servicio leyó (`edit_version`, la mitad del
-- candado de la 038), el ESTADO que el servicio leyó (la otra mitad) y el diff de
-- la edición ya computado: `{items_remove, items_update, items_insert, payments,
-- movements}`.
--
-- El tipo de retorno es `{invoice, items, movements}`: la FACTURA ESCRITA (jsonb,
-- con las MISMAS columnas que el servicio leía con `INVOICE_SELECT`) y cuántas
-- filas de ítems y de movimientos se escribieron. El llamador contrasta ESOS
-- números contra los que pidió —en vez de confiar en que el RPC no dejó nada
-- afuera— y usa la fila como resultado, sin una segunda lectura y sin su ventana.
CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_invoice_id IS NULL
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
  --     el ajuste de una edición, que puede subir o bajar el stock: IN o OUT, y
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
  --     el servicio ya hizo y la escritura de abajo. La sede también se verifica:
  --     una edición no se atribuye a la factura de otra sede.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
    AND i.sede_id = p_sede_id
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
     AND i.sede_id = p_sede_id
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
  --     `idempotency_key` se escribe NULL a PROPÓSITO: la edición no tiene un
  --     intento de cliente y su fila queda FUERA del índice único parcial de la
  --     045 (ver "LA MARCA DE LA 045 NO ENTRA ACÁ").
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN"), y el otro efecto —el
  --     orden de las filas del kardex dentro de una edición— está declarado
  --     arriba. El JOIN filtra por sede: un producto de otra sede no se ajusta.
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
   AND p.sede_id = p_sede_id
  ORDER BY p.id;

  -- 1.10 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --      movimientos que los pedidos, se aborta y se revierte TODO, los ítems y
  --      el token incluidos. El `JOIN` de arriba filtra por sede, así que un
  --      producto inexistente o de otra sede escribiría menos filas en SILENCIO:
  --      esta guarda convierte ese subconjunto silencioso en un rechazo con
  --      rollback, y es lo que separa "la edición no se pudo hacer" de "la
  --      factura quedó editada sin su ajuste de stock". Es la misma red que 039,
  --      046 y 050 pusieron sobre sus INSERT.
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
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_payments`,
-- `products` e `inventory_movements`; con search_path mutable un esquema
-- anterior en la ruta podría secuestrar esos nombres. House style desde 018 (y
-- el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems de una factura emitida
-- —y con ellos las comisiones de la nómina— y mover su stock por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb) IS
'CL-12: edición ADMIN de factura ATÓMICA, con el total INMUTABLE. Reemplaza los ítems (borra los que se quitaron, actualiza los que cambian, inserta los nuevos), pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización de la edición de la 038 y también el del dinero de esa factura: la anulación y el cobro de la 050 toman el MISMO lock) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el diff de ítems (con el subtotal de cada línea), el delta de stock, su tipo y el motivo del kardex llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y la aritmética de dinero no aparece en esta función —no tiene una sola sentencia que escriba subtotal, discount, tax, surcharge ni total: la inmutabilidad del total de esta edición es ESTRUCTURAL, no una promesa del llamador—. MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila, y su mensaje de negocio es el mismo que devolvía el compare-and-swap del cliente. Sus redes de conteo abortan con EDIT_CONFLICT (la fila ya no está en la versión o el estado leídos), ITEM_MISMATCH (no borró, actualizó o insertó exactamente los ítems recibidos), PAYMENT_MISMATCH (no pisó exactamente los cobros recibidos) o PRODUCT_NOT_FOUND (no escribió exactamente los movimientos pedidos); en todos los casos la transacción se revierte COMPLETA: no queda una edición a medias con el token avanzado, y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): una
-- edición que ya quedó a medias por el bug anterior —los ítems reemplazados, el
-- stock a medias y el token avanzado— NO se detecta sola: el estado parcial es
-- indistinguible de una edición completa. Se reconcilia decidiendo, con quien
-- opera la base: comparar las líneas de producto de la factura (`invoice_items`)
-- contra los movimientos del kardex cuyo motivo nombra su consecutivo
-- (`Ajuste edición factura #N`) y escribir a mano los ajustes que faltan como
-- movimientos IN/OUT, o aceptar el faltante como diferencia de inventario y
-- ajustarlo con el movimiento ADJUST del camino manual. En los dos casos la
-- auditoría (`invoice.edited`) conserva el `inventory_moves` que el servicio
-- CREYÓ haber escrito, y ese es el dato con el que se reconstruye qué faltó.

-- ===================================================================== ---
-- 5. La edición LIBRE de una emitida (total RECALCULADO), indivisible
-- ===================================================================== ---

-- Misma firma que la admin. La diferencia está en el contenido de `p_edit`, que
-- trae además `taxes_remove` (los ids del snapshot que el servicio LEYÓ),
-- `taxes` (el snapshot nuevo, ya computado) y `totals` (los cinco números de la
-- factura, ya computados). El tipo de retorno es el mismo.
CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_invoice_id IS NULL
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
    AND i.sede_id = p_sede_id
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
     AND i.sede_id = p_sede_id
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
  --     impuestos ACTIVOS de la sede (FAC-03: el snapshot es inmutable y no sigue
  --     al catálogo). Se corre SIEMPRE, aunque el arreglo venga vacío: así el
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
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
   AND p.sede_id = p_sede_id
  ORDER BY p.id;

  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 5.11 La factura ESCRITA (con sus totales nuevos) y los conteos.
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
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- 6. search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ 7. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems, los TOTALES y los impuestos
-- de una factura emitida —salteando el estado terminal, el candado de nómina
-- cerrada y el turno de caja— y mover su stock por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- 8. Documentación ---
COMMENT ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb) IS
'CL-12: edición LIBRE de una factura emitida, ATÓMICA, con el total RECALCULADO. Reemplaza los ítems, REEMPLAZA el snapshot de impuestos (borra el que el servicio leyó e inserta el que computó), reescribe los cinco números de la factura, pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (el punto de serialización de la edición de la 038 y el del dinero de esa factura, el MISMO lock que toman la anulación y el cobro de la 050) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: los totales y el snapshot llegan computados por computeInvoiceTotals/snapshotInvoiceTaxes, el diff de ítems con su subtotal por computeLineSubtotal, y el delta de stock con su tipo y su motivo, todos en TypeScript y escritos verbatim; acá no hay una sola suma, resta, multiplicación ni redondeo, ni una operación sobre las columnas de dinero (escribir es convertir la representación). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004). MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila. El REEMPLAZO del snapshot de impuestos es todo-o-nada: si el INSERT del snapshot nuevo falla, el DELETE del viejo se revierte con la transacción entera y la factura conserva su snapshot ANTERIOR completo (el estado intermedio —sin impuestos— no es ninguna de las dos colecciones). Sus redes de conteo abortan con EDIT_CONFLICT (versión o estado movidos), TAX_MISMATCH (no borró o insertó exactamente el snapshot recibido), ITEM_MISMATCH, PAYMENT_MISMATCH o PRODUCT_NOT_FOUND; en todos los casos la transacción se revierte COMPLETA y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá): una
-- edición libre que ya quedó a medias por el bug anterior puede haber dejado la
-- factura SIN snapshot de impuestos (el `DELETE` entró y el `INSERT` no), con los
-- totales viejos y el token avanzado. No se detecta sola y no hay forma de
-- reconstruir el snapshot desde la base: el porcentaje y el monto originales son
-- un dato HISTÓRICO (FAC-03) que el servicio computó y se perdió. Se reconcilia
-- decidiendo, con quien opera la base: recalcular el snapshot con los impuestos
-- ACTIVOS de hoy y los ítems que la factura tiene —aceptando que el porcentaje
-- puede haber cambiado desde la emisión— o dejarla sin impuestos y ajustar el
-- total a mano, dejando la decisión en la auditoría. El `total` y el `subtotal`
-- de la fila dicen cuál era el snapshot esperado; la auditoría
-- (`invoice.edited`) conserva las cifras del aviso de sobre-cobro si lo hubo.
