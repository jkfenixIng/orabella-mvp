-- 058_close_arqueo_consistency.sql — CL-19: el CIERRE deja de poder firmar un
-- arqueo que ya no corresponde al conjunto de cobros del turno.
--
-- MOTIVO DEL ARCHIVO (la ventana, medida)
--
-- `closeShift` (src/features/cash/service.ts:1654-1658) LEE los dos ledgers del
-- turno —las filas de `payments` del turno SIN factura (`invoice_id IS NULL`) y
-- las `invoice_payments` atribuidas al turno— y computa con ellos el arqueo
-- entero: `expected_cash`, el esperado digital por método y la lista de
-- desajustes. Recién DESPUÉS, en el `db.rpc("cash_close_shift_atomic")`
-- (service.ts:1760), la transacción de 049 bloquea la fila del turno con
-- `FOR UPDATE` y escribe.
--
-- El cobro (056) toma `FOR SHARE` sobre esa MISMA fila antes de tocar la
-- factura, así que las dos operaciones SÍ se serializan —el cierre espera al
-- cobro o el cobro espera al cierre—. Pero eso no alcanza: el arqueo ya estaba
-- computado cuando el lock se tomó. Un cobro que se confirma ENTRE la lectura
-- del servicio y el lock del cierre queda FUERA del arqueo firmado, aunque sea
-- dinero que entró al turno. El resultado no es un cobro perdido ni un cobro
-- contado dos veces: es un cierre FIRMADO con un `expected_cash` corto por un
-- cobro que sí existió. Es la última ventana de la clase "firmado sobre un
-- estado que ya no es el que se leyó" que le quedaba a la caja.
--
-- Lo que se midió, verbatim, con el código previo a este archivo (turno con
-- 300 000 cobrados en efectivo y un cobro de 100 000 que se confirma entre la
-- lectura y el lock):
--
--     AssertionError: expected 300000 to be 400000 // Object.is equality
--
--     ❯ tests/cash.test.ts:4970:39
--     4969|     expect(collectedCash()).toBe(400000);
--     4970|     expect(shifts()[0].expected_cash).toBe(collectedCash());
--
-- Es decir: entraron 400 000 y el cierre firmado dice 300 000. (El test RED que
-- midió esto —con esa aserción, que sólo podía fallar mientras el defecto
-- existiera— se convirtió después en el test de RECHAZO permanente del bloque
-- CL-19 de `tests/cash.test.ts`.)
--
-- MECANISMO (una PRECONDICIÓN —CAS—, no un recálculo)
--
-- Lo que cierra la ventana no es alargar la transacción para que el cálculo
-- ocurra adentro (eso haría durar los locks del turno todo el cálculo, y además
-- movería a SQL una aritmética que este proyecto tiene prohibido mover), ni
-- volver a computar el arqueo en la base: es una PRECONDICIÓN. El servicio
-- manda, JUNTO CON el arqueo que computó, el TOKEN del conjunto de cobros que
-- leyó; la transacción, BAJO EL LOCK DEL TURNO, vuelve a contar esos mismos
-- conjuntos y RECHAZA el cierre si alguno cambió. El llamador recibe un rechazo
-- de CONTRATO y vuelve a cerrar con un arqueo fresco —que ahora sí cuenta el
-- cobro—, y el turno queda intacto y todavía cerrable.
--
-- EL TOKEN: QUÉ ES Y POR QUÉ ES ESOS DOS CONTEO (y no otra cosa)
--
--   * Son los CONTEO de FILAS de las DOS fuentes que el arqueo suma:
--     `payments` del turno con `invoice_id IS NULL` y `invoice_payments`
--     atribuidas al turno. Son exactamente las dos listas que
--     `mergeShiftMoney` une en TypeScript para armar `paidByMethod`, que es la
--     base de `expected_cash`. La correspondencia es literal: cada fila que el
--     arqueo sumó está contada en el token, y ninguna otra.
--   * NO son las SUMAS de esas fuentes. Sumar dinero en SQL está prohibido en
--     este proyecto: 005, 031, 049, 050 y 053 ya dejaron escrito que comprobar
--     una relación entre un total y su detalle exigiría SUM en SQL y que por eso
--     esa comprobación vive en TypeScript. Un `count(*)` NO es aritmética de
--     dinero: cuenta filas, no pesos. Es la misma frontera que 049 respeta
--     cuando escribe `(item ->> 'amount')::numeric` —una conversión de
--     representación, no una operación— y la que este archivo NO cruza.
--   * Las `invoice_payments` atribuidas al turno son la UNIÓN de dos conjuntos,
--     los mismos que lee `fetchInvoicePaymentsByShift` (service.ts:536): las
--     filas con `cash_shift_id = p_shift_id` y las filas HISTÓRICAS sin turno
--     (`cash_shift_id IS NULL`) cuya factura pertenece al turno
--     (`invoices.cash_shift_id = p_shift_id`). El conteo de abajo describe esos
--     dos conjuntos porque el arqueo suma los dos: si contara sólo el directo,
--     un turno con filas históricas no podría cerrarse NUNCA (el token sería
--     mayor que el conteo de la base), y si contara sólo el histórico dejaría de
--     ver el cobro normal. Es un ACOPLAMIENTO DECLARADO: la regla de atribución
--     vive en `fetchInvoicePaymentsByShift` (TypeScript) y acá se transcribe una
--     vez; el test de la migración la fija en las dos puntas.
--   * El token es OBLIGATORIO. Si `p_collection_counts` no llega, no es un
--     objeto, o alguna de las dos claves no es un entero no negativo, la
--     transacción rechaza con `SHIFT_INVALID`. La ausencia JAMÁS se interpreta
--     como "no compares" (la misma regla que 057 dejó escrita para su
--     precondición): una firma mal llamada no puede degradar al comportamiento
--     sin CAS, que es exactamente el agujero que este archivo cierra.
--
-- LECTURA BAJO EL LOCK, Y POR QUÉ LOS DOS CONTEO SON SUFICIENTES CONTRA UN COBRO
--
-- Los dos `count(*)` corren DESPUÉS del `SELECT ... FOR UPDATE` del turno y
-- DESPUÉS de su precondición de estado, y antes del `UPDATE`. Bajo READ
-- COMMITTED eso da la garantía exacta que hace falta:
--   * Un cobro que YA commiteó es visible —un `SELECT` ve todo lo confirmado
--     antes de empezar—, así que su fila entra en el conteo y el token, que se
--     computó antes, no coincide: se rechaza.
--   * Un cobro EN VUELO no puede ser invisible: el cobro toma `FOR SHARE` del
--     turno (056) y `FOR SHARE` COMPITE con el `FOR UPDATE` de acá. O el cobro
--     llegó primero —y este `FOR UPDATE` espera hasta que commitee, con lo que
--     sus filas ya son visibles para el conteo—, o llegó después —y espera a
--     esta transacción y, al re-leer la fila bloqueada, ve el turno `cerrado` y
--     RECHAZA con SHIFT_CLOSED sin escribir nada—. No hay una tercera instancia
--     en la que un cobro quede fuera del conteo Y fuera del rechazo.
--   * El `UPDATE` de abajo conserva además su propio CAS (`status = 'abierto'`)
--     y su red de conteo, así que un cierre concurrente sigue rechazándose con
--     `SHIFT_ALREADY_CLOSED` como antes.
--
-- POR QUÉ NO ALGO MÁS SIMPLE (las alternativas evaluadas, una por una)
--
--   * BLOQUEAR EL TURNO ANTES DE COMPUTAR EL ARQUEO (mover la lectura de los
--     ledgers adentro de una transacción que empiece con `SELECT ... FOR UPDATE`
--     del turno). Cerraría la ventana, pero exige una función que LEA y SUME en
--     SQL —justo la aritmética que no se mueve— o un `rpc` de ida y vuelta con
--     el conteo entero viajando como dato de entrada. Además haría durar el lock
--     del turno todo el cómputo y las validaciones del servicio
--     (`checkCounts` consulta dos catálogos, `fetchCountTotals` otro). Se
--     descarta por alcance y por costo, no por corrección.
--   * UN `SELECT ... FOR SHARE` DEL TURNO EN EL SERVICIO antes de leer los
--     ledgers (el lock que toma el cobro). No sirve: PostgREST no mantiene una
--     transacción entre requests; el lock se suelta al terminar el request, así
--     que no cubre nada.
--   * RECOMPUTAR EL ARQUEO DENTRO DE LA TRANSACCIÓN. Es lo mismo que la primera
--     alternativa y es exactamente lo prohibido: sumar dinero en SQL. Se
--     descarta.
--   * UN TOKEN CON LAS SUMAS (`sum(amount)`) EN VEZ DE LOS CONTEO. Sería más
--     fino —detectaría también un cambio de MONTO de una fila existente— y está
--     PROHIBIDO por la regla del proyecto. No se hace, y la limitación que eso
--     deja se declara abajo, en "VENTANAS DECLARADAS", con su propuesta.
--   * UN TOKEN CON UN HASH DE LAS FILAS (por ejemplo `md5` sobre el método y el
--     monto de cada fila). No es aritmética de dinero y detectaría también el
--     cambio de método de una fila existente, pero convierte el token en una
--     cadena opaca que el servicio tendría que construir con las MISMAS filas en
--     el MISMO orden, acoplando las dos puntas a una serialización inventada.
--     Queda como alternativa declarada, no como lo que se escribió.
--
-- LO QUE ESTE ARCHIVO NO CAMBIA (la aritmética sigue en TypeScript, entera)
--
-- Reemplaza la función del cierre (049) conservando su cuerpo VERBATIM y
-- agregando sólo la precondición: la guarda de FORMA de los cuatro montos y de
-- las líneas del conteo, el `FOR UPDATE` del turno con su verificación de sede,
-- su precondición de estado, su CAS en el `WHERE` del `UPDATE`, sus DOS redes de
-- conteo (`SHIFT_ALREADY_CLOSED` si no actualizó exactamente un turno y
-- `SHIFT_COUNT_MISMATCH` si no escribió exactamente las líneas recibidas), la
-- escritura VERBATIM de `p_close` y de `p_counts`, la devolución con las MISMAS
-- columnas de `SHIFT_SELECT` y el paso del CHECK `expected_cash >= 0` de 006 al
-- servicio (que lo traduce a CASH_OUT_EXCEEDS_COLLECTED).
--
-- NO se mueve ni una operación: la función sigue sin sumar, sin restar, sin
-- multiplicar y sin redondear un solo monto. `expected_cash`, `base_left`,
-- `cash_withdrawn` y `base_difference` llegan resueltos por `resolveClosingBase`
-- y `computeCashClose`; los desajustes por método, por `expectedDigitalTotal` y
-- `moneyEquals`; las líneas del conteo, por `checkCounts`. Lo ÚNICO nuevo es un
-- `count(*)` de dos conjuntos de filas y una comparación contra el número que el
-- llamador mandó. Tampoco cambia el resultado devuelto: un arqueo viejo ahora se
-- RECHAZA en vez de firmarse, y eso es lo único distinto.
--
-- Los otros dos caminos de 049 —`cash_open_shift_atomic` y
-- `cash_recount_shift_atomic`— NO se tocan: la apertura no computa un arqueo a
-- partir de ledgers (su base llega resuelta y su conteo es el que el cajero
-- declara) y el reconteo CORRIGE un cierre ya firmado, con las dos versiones
-- como dato; ninguno de los dos tiene esta ventana.
--
-- POR QUÉ `DROP FUNCTION` (y no `CREATE OR REPLACE` a secas)
--
-- PostgreSQL NO permite cambiar la lista de argumentos con `CREATE OR REPLACE`:
-- con una firma distinta crea una función NUEVA y deja viva la vieja. Acá eso
-- sería lo peor posible: quedaría
-- `cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb)`, la
-- versión SIN la precondición, viva y llamable —un cierre que firma un arqueo
-- viejo, el bypass exacto que este archivo elimina—. Por eso el archivo primero
-- REMUEVE la firma vieja con `DROP FUNCTION IF EXISTS` y después crea la nueva,
-- igual que 057 con `change_user_password`. El `DROP` es de una FUNCIÓN, no de
-- datos: no borra ni reescribe ninguna fila, y con `IF EXISTS` el archivo sigue
-- siendo re-ejecutable cuantas veces haga falta. La firma vieja no la referencia
-- ningún objeto de la base (no hay trigger, ni default, ni vista que la llame:
-- su único llamador es `db.rpc(...)` del servicio, que resuelve por NOMBRE y
-- lista de argumentos), así que el `DROP` no rompe ninguna dependencia.
--
-- QUIÉN PUEDE LLAMARLA Y CÓMO SE CIERRA EL PERMISO
--
-- Igual que 018/039/046–049: la función es SECURITY INVOKER (el único llamador
-- es el cliente `service_role` del servidor, que ya bypassa RLS), y
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC por defecto, así que se revoca de
-- PUBLIC, anon y authenticated y se otorga SÓLO a service_role. El `DROP` se
-- lleva los permisos de la firma vieja (con ella), y la firma nueva nace con los
-- suyos. Sin ese bloque, cualquier JWT podría cerrar el turno de un cajero
-- firmando un arqueo con los montos que quisiera.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `DROP FUNCTION IF EXISTS` no falla si la firma
-- vieja no está; `CREATE OR REPLACE FUNCTION` con la misma firma y el mismo tipo
-- de retorno deja la función idéntica en cada corrida; REVOKE/GRANT, ALTER y
-- COMMENT lo son. El runner de Supabase aplica el archivo en una transacción: o
-- entra todo, o no entra nada.
--
-- ACOPLAMIENTO DE DESPLIEGUE (declarado)
--
-- La app nueva y este archivo se despliegan JUNTOS. La app nueva llama a
-- `cash_close_shift_atomic` con SIETE argumentos nombrados; si la migración no
-- se aplicó antes de que el servicio nuevo atienda tráfico, la ruta responde
-- PGRST202 ("no existe la función") y el cierre devuelve INTERNAL 500 SIN
-- ESCRIBIR NADA —el turno sigue abierto y cerrable—. Al revés (archivo aplicado,
-- servicio viejo) el servicio viejo llama con SEIS argumentos y recibe el mismo
-- PGRST202: el cierre tampoco se firma. Las dos direcciones fallan CERRADO
-- (nada escrito, reintento posible), que es la dirección segura; y la migración
-- no es compatible hacia atrás a propósito, porque una firma que permita cerrar
-- sin el token sería exactamente el bypass que este archivo elimina.
--
-- COSTO DE NUMERACIÓN (declarado)
--
-- 058 es el número asignado a esta unidad; 052 a 057 están tomados por otras
-- unidades (052/053, 054, 055, 056, 057). Este archivo NO renumera ni toca
-- ninguno, y no tiene ninguna dependencia de datos ni de funciones con ellos:
-- usa las tablas de 005/006 (payments, invoices, invoice_payments), la función
-- de 049 y nada más. El costo es una ranura más de la serie, consumida por la
-- unidad que la tiene asignada. Tampoco quema ningún número de negocio: el
-- cierre no tiene serie ni consecutivo (`cash_shifts.id` es un uuid con
-- `gen_random_uuid()`), así que un rechazo no deja hueco.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * EL ARQUEO NO SUMA SÓLO COBROS: también RESTA dos salidas de caja —los
--     pagos inmediatos de comisión (`commission_payouts` del turno) y los vales
--     APROBADOS del turno (`voucher_requests` con `approved_by` no nulo)—, y el
--     token NO las cuenta. Un pago de comisión o la aprobación de un vale que se
--     confirmen entre la lectura del arqueo y el lock del turno cambian
--     `expected_cash` con estos dos conteo intactos, así que el cierre no los
--     detecta. Es una ventana de la MISMA clase que la que este archivo cierra,
--      y se declara en vez de esconderse. La propuesta, si esta unidad quiere
--     cerrarla también, es la MISMA y no cruza la frontera: agregar
--     `commission_payouts` y `voucher_requests` (aprobados) al objeto del token,
--     con su `count(*)` y su comparación. No se hizo acá porque el hallazgo que
--     esta unidad cierra es el COBRO, y porque agregar conteos a un token no es
--     una decisión que esta unidad pueda tomar sola: cambia el contrato de la
--     precondición. Con el token como objeto jsonb, esa extensión NO exige un
--     `DROP` ni un cambio de firma.
--   * EL MONTO DE UNA FILA EXISTENTE NO SE VE: cambiar el `amount` de una fila
--     de `payments` o de `invoice_payments` no cambia ningún conteo. Hoy ningún
--     camino del sistema edita un monto cobrado (051 toca el MÉTODO de las
--     porciones, nunca el `amount`), así que la ventana no tiene escritor
--     conocido; si lo tuviera, el token tendría que pasar a un hash de las filas
--     (declarado arriba) y no a una suma.
--   * EL MÉTODO DE UNA PORCIÓN SÍ PUEDE CAMBIAR sin cambiar el conteo: la
--     edición de una factura `Emitida` (051) pisa `invoice_payments.method_code`
--     y `method_id`, y eso mueve el reparto por método del arqueo —y con él
--     `expected_cash`, que sale del efectivo— sin agregar ni quitar una fila. La
--     edición es una operación legítima y CONCURRENTE (exige un turno abierto),
--      así que la ventana existe y se declara. Cerrarla pide un token que mire el
--     CONTENIDO de las filas (el hash de arriba), no un conteo: está fuera de lo
--     que esta unidad puede decidir y no se hace a medias.
--   * La igualdad entre el TOTAL declarado y su detalle por denominación
--     (`moneyEquals(countedFromDetail, counted_cash)`) sigue siendo una regla
--     del SERVICIO, evaluada antes de llamar, como en 049: comprobarla adentro
--     exigiría SUMAR las líneas de efectivo en SQL.
--   * La AUDITORÍA (`writeAudit`) sigue FUERA de la transacción: es un INSERT
--     posterior y separado que no lanza. Con el rechazo nuevo, además, no corre:
--      el servicio lanza ANTES de auditarlo, así que un arqueo viejo no deja
--     ninguna fila de auditoría del cierre que no ocurrió.
--   * La ventana de 049 que este archivo NO toca sigue igual: el CONJUNTO de
--     líneas del conteo se decide antes de la transacción (`checkCounts`), y una
--     denominación que se desactive en el medio no invalida el conteo ya
--     validado.
--   * EL TECHO DE FILAS POR REQUEST DEL DATA API (`max-rows`, 1000 por defecto;
--     ver `src/shared/lib/paged.ts`). Los dos conteo del token salen de las
--     MISMAS lecturas que alimentan el arqueo, y esas dos lecturas no están
--     paginadas: si un turno tuviera más filas que el techo, el servicio leería
--     una ventana y el conteo de la base sería mayor que el token, así que el
--     cierre se RECHAZARÍA con ARQUEO_STALE una y otra vez. Es un fallo CERRADO y
--     RUIDOSO —mejor que firmar un arqueo corto en silencio, que es lo que
--     pasaba antes de este archivo—, pero deja el turno sin poder cerrarse. La
--     truncación NO la introduce este archivo: ya afectaba al arqueo (que se
--     computa con esas mismas filas) y a los lectores de las vistas de día,
--     historia y cobros, que usan el mismo `fetchInvoicePaymentsByShift`. La
--     propuesta es paginar las dos lecturas con `readAllPaged`
--     (`src/shared/lib/paged.ts`, el helper de la casa para ese techo), en una
--     unidad aparte: toca un fetcher COMPARTIDO por otros lectores y con esto no
--     se gana ni se pierde corrección del arqueo.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Remover la firma vieja (sin la precondición del conjunto de cobros)
-- ===================================================================== ---
-- Sin esto, `CREATE OR REPLACE` crearía una sobrecarga y dejaría viva la versión
-- de 049, que cierra el turno firmando el arqueo que el llamador mandó sin
-- comprobar que ese arqueo siga correspondiendo al conjunto de cobros del turno:
-- un bypass silencioso de la precondición que este archivo agrega. `IF EXISTS`
-- la vuelve idempotente.
DROP FUNCTION IF EXISTS public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb);

-- ===================================================================== ---
-- 2. cash_close_shift_atomic CON la precondición del conjunto de cobros
-- ===================================================================== ---
-- La misma operación de 049 —el CAS del turno, sus dos redes de conteo y su
-- arqueo de cierre, en UNA sentencia y por lo tanto en UNA transacción— más el
-- séptimo argumento: el TOKEN del conjunto de cobros que el llamador sumó, que
-- la transacción revalida BAJO EL LOCK DEL TURNO.
CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic(
  p_sede_id uuid,
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
BEGIN
  -- 2.1 FORMA de la entrada. Un cierre es el documento que firma un arqueo: no
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

  --     EL TOKEN: la forma de la PRECONDICIÓN. Sin esta guarda, una clave
  --     ausente dejaría `(null)::integer` en la comparación de 2.3, la
  --     comparación daría NULL —no TRUE— y el cierre pasaría SIN comprobar
  --     nada: un bypass silencioso. Un objeto con los dos conteo como enteros no
  --     negativos es la única forma aceptada; el `coalesce` es el mismo recurso
  --     que 046–049 usan para que una clave AUSENTE falle en vez de comparar
  --     contra NULL, y la ausencia se rechaza con el error de forma —jamás se
  --     interpreta como "no compares"—, como 057 dejó escrito para su propia
  --     precondición.
  IF p_collection_counts IS NULL
     OR jsonb_typeof(p_collection_counts) <> 'object'
     OR coalesce(p_collection_counts ->> 'payments', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'invoice_payments', '') !~ '^[0-9]{1,9}$'
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

  -- 2.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA (no
  --     del dato que mandó el llamador). `FOR UPDATE` es el idioma de la casa
  --     para tomar un lock de fila (039, 040, 047, 048): a partir de acá, otro
  --     cierre del mismo turno espera; un cobro del mismo turno (056) espera o
  --     es rechazado; y si el turno ya se cerró antes, esta lectura ve la versión
  --     nueva y rechaza. La sede también se verifica: un cierre no se atribuye al
  --     turno de otra sede.
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

  -- 2.2b LA PRECONDICIÓN DEL CONJUNTO DE COBROS (CL-19). El paso se numera
  --      "2.2b" —y no se renumeran los pasos de 049— para que el diff contra
  --      aquel archivo se lea de un vistazo: la precondición nueva entra
  --      EXACTAMENTE entre el lock del turno y la escritura, y nada más se mueve.
  --
  --      Los dos `count(*)` RE-CUENTAN las MISMAS dos fuentes que el servicio
  --      sumó: las filas de `payments` del turno sin factura y las
  --      `invoice_payments` atribuidas al turno. NO se suma ningún monto: contar
  --      filas no es operar sobre dinero. Las dos variables son `bigint` porque
  --      es el tipo que `count(*)` devuelve: no hay ninguna conversión estrecha
  --      entre el conteo y lo que se compara (la guarda de forma de 2.1 ya limitó
  --      el token a nueve dígitos).
  --
  --      La segunda fuente es la UNIÓN que describe `fetchInvoicePaymentsByShift`
  --      (service.ts:536): las filas con `cash_shift_id = p_shift_id` MÁS las
  --      históricas sin turno (`cash_shift_id IS NULL`) cuya factura pertenece al
  --      turno. Las dos ramas son disjuntas por construcción, así que el `OR` no
  --      cuenta una fila dos veces, y el `EXISTS` por la PK de `invoices` no
  --      recorre la tabla de facturas.
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

  --      El RECHAZO. Si alguno de los dos conteo difiere del que el llamador
  --      mandó, entre su lectura y este lock se confirmó un cobro del turno: el
  --      arqueo que viaja en `p_close` ya no corresponde al conjunto de cobros y
  --      la transacción NO ESCRIBE NADA. El arqueo NO se recalcula —eso sería
  --      sumar dinero en SQL— ni se firma "como estaba": se rechaza, que es la
  --      única salida honesta cuando el llamador firmó un conjunto que cambió.
  --
  --      El código es propio (`ARQUEO_STALE`) para que el servicio pueda
  --      distinguirlo de la carrera del estado (`SHIFT_ALREADY_CLOSED`) y
  --      devolver un mensaje accionable. No hace falta una red de conteo acá:
  --      esto no escribe nada, sólo lee dos veces y compara.
  IF v_payments <> (p_collection_counts ->> 'payments')::bigint
     OR v_invoice_payments <> (p_collection_counts ->> 'invoice_payments')::bigint
  THEN
    RAISE EXCEPTION 'ARQUEO_STALE';
  END IF;

  -- 2.3 El CIERRE del turno: el mismo `UPDATE` que hacía el servicio, con su
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

  -- 2.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y
  --     el llamador recibe el MISMO error de negocio que ya recibía cuando
  --     perdía el CAS en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 2.5 El ARQUEO DE CIERRE: las líneas por denominación, con la fase que le
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

  -- 2.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el cierre incluido. Es lo que separa "el
  --     cierre no se pudo firmar" de "el cierre quedó firmado sin su evidencia"
  --     —y este último, con el CAS, ya no se podría volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 2.7 El turno ESCRITO, tal como quedó en la tabla, con las mismas columnas
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

-- ------------------------------------------- 3. search_path fijo ---
-- La función resuelve `cash_shifts`, `cash_shift_counts`, `payments`,
-- `invoice_payments` y `invoices`; con search_path mutable un esquema anterior en
-- la ruta podría secuestrar esos nombres. House style desde 018 (y el mismo paso
-- que dan 039 y 046–049).
ALTER FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ 4. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cerrar el turno de un cajero firmando un arqueo
-- con los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor. La firma vieja se fue con su `DROP`, y con ella sus
-- permisos y su comentario.
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) TO service_role;

-- --------------------------------------------- 5. Documentación ---
COMMENT ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) IS
'CL-10/CL-19: cierre ATÓMICO de un turno de caja (CAJ-03/CAJ-04) con PRECONDICIÓN sobre el conjunto de cobros que el arqueo sumó. Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. CL-19 agrega el séptimo argumento p_collection_counts: los CONTEO de filas de las dos fuentes que el arqueo suma (payments del turno sin factura e invoice_payments atribuidas al turno), que la transacción RE-CUENTA bajo el lock y compara, y que si difieren hacen que el cierre RECHAZE con ARQUEO_STALE sin escribir nada: un cobro confirmado entre la lectura del servicio y el lock ya no queda fuera de un arqueo firmado. El token es OBLIGATORIO (su ausencia es SHIFT_INVALID, nunca "no compares") y son CONTEO, no sumas: acá no se suma un solo monto, porque sumar dinero en SQL está prohibido en este proyecto. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. Sólo service_role puede ejecutarla.';

-- Reemplaza la firma de 049 (seis argumentos) por la de esta migración (siete):
-- el `DROP FUNCTION IF EXISTS` de arriba es lo que impide que la de 049 sobreviva
-- como sobrecarga y siga cerrando turnos sin la precondición.
