-- 059_close_arqueo_outflows.sql — CL-20: el cierre deja de poder firmar un
-- arqueo al que le faltan sus DOS SALIDAS.
--
-- MOTIVO DEL ARCHIVO (la ventana residual de 058, medida)
--
-- El arqueo de `closeShift` (src/features/cash/service.ts) no SÓLO suma cobros:
-- también RESTA dos salidas de caja del turno —los pagos inmediatos de comisión
-- (`commission_payouts`) y los vales APROBADOS (`voucher_requests` con
-- `approved_by` y `method_code` no nulos)—. `expected_cash` es, literalmente,
-- `efectivo cobrado menos efectivo pagado`.
--
-- La 058 (CL-19) cerró la ventana del COBRO con una precondición: el servicio
-- manda, junto con el arqueo, el TOKEN con los CONTEO de filas de las dos
-- fuentes que el arqueo SUMA, y la transacción los re-cuenta bajo el lock del
-- turno. Pero el token de la 058 no cuenta las dos fuentes que el arqueo RESTA.
-- Un pago de comisión o la aprobación de un vale confirmados ENTRE la lectura
-- del servicio y el lock del cierre cambian `expected_cash` con los dos conteo
-- de la 058 INTACTOS, así que su precondición no dispara: el cierre se firma
-- igual, con un `expected_cash` corto por una salida que sí existió y que un
-- reintento ya no puede corregir (el turno quedó `cerrado`).
--
-- Lo que se midió, verbatim, con el código previo a este archivo (turno con
-- 300 000 cobrados en efectivo y una salida de 100 000 —comisión pagada, y en
-- una segunda corrida un vale aprobado— que se confirma entre la lectura y el
-- lock; las dos fuentes del token de la 058 quietas):
--
--     AssertionError: expected 300000 to be 200000 // Object.is equality
--
--     ❯ tests/cash.test.ts:5403:39
--     5402|     expect(shifts()[0].status).toBe("cerrado");
--     5403|     expect(shifts()[0].expected_cash).toBe(collectedCash() - paidOutCa…
--
-- Es decir: salieron 100 000 del cajón, el arqueo correcto era 200 000 y el
-- cierre firmado dice 300 000. (Los tests RED que midieron esto —con esa
-- aserción, que sólo podía fallar mientras el defecto existiera— se convirtieron
-- después en los tests de RECHAZO permanentes del bloque CL-20 de
-- `tests/cash.test.ts`.)
--
-- MECANISMO (la MISMA precondición de 058, extendida — no una segunda)
--
-- No se agrega un mecanismo nuevo: se agregan DOS CONTEO de filas al MISMO
-- objeto jsonb del token y DOS `count(*)` más a la MISMA precondición, con el
-- MISMO código de rechazo (`ARQUEO_STALE`) y el MISMO mensaje. La transacción
-- sigue sin recalcular nada: re-cuenta y, si algo cambió, RECHAZA sin escribir;
-- el llamador vuelve a cerrar con un arqueo fresco —que ahora sí resta la salida
-- o la cuenta— y el turno queda intacto y todavía cerrable.
--
-- EL TOKEN AHORA: CUATRO CONTEO, Y POR QUÉ CUATRO ALCANZAN
--
-- El token pasa de dos a cuatro claves, todas CONTEO de filas:
--
--   * `payments`            — filas de `payments` del turno con `invoice_id IS NULL`.
--   * `invoice_payments`    — filas de `invoice_payments` atribuidas al turno (la
--                             unión que describe `fetchInvoicePaymentsByShift`).
--   * `commission_payouts`  — filas de `commission_payouts` del turno.
--   * `voucher_requests`    — filas de `voucher_requests` del turno APROBADAS y
--                             con método (`approved_by` y `method_code` no nulos).
--
-- Los dos primeros son las fuentes que `mergeShiftMoney` SUMA para armar
-- `paidByMethod`; los dos últimos, las que `paidOutByMethod` RESTA (y que
-- `fetchVoucherOutRows` entrega ya filtradas por `isVoucherCashOut`, el mismo
-- predicado). La correspondencia es literal en las cuatro: cada fila que el
-- arqueo usó está contada en el token, y ninguna otra. Por eso cuatro conteo
-- alcanzan: `expected_cash` es UNA función de esas cuatro listas —su suma y su
-- resta—, así que congelar las cuatro listas congela el arqueo. No hace falta
-- contar nada más porque ningún otro dato entra en el número firmado.
--
-- La correspondencia de `voucher_requests` es la única que lleva predicados, y
-- por eso queda escrita acá una vez: el arqueo resta un vale SÓLO si está
-- aprobado Y tiene método (`isVoucherCashOut`, schemas.ts) —un vale pendiente o
-- rechazado no toca caja, y uno sin método es un vale histórico anterior a la
-- 028—. Contar TODAS las filas del turno sería un token más grueso: una solicitud
-- de vale nueva (que no cambia el arqueo) rechazaría un cierre legítimo. Es un
-- ACOPLAMIENTO DECLARADO: la regla vive en `isVoucherCashOut` (TypeScript) y acá
-- se transcribe; los tests la fijan en las DOS puntas —el doble la aplica al
-- re-contar—.
--
-- Ninguna de las cuatro claves es una SUMA: sumar dinero en SQL está prohibido en
-- este proyecto (005, 031, 049, 050 y 053 ya lo dejaron escrito). Un `count(*)`
-- cuenta filas, no pesos, y es la misma frontera que 049 respeta cuando escribe
-- `(item ->> 'amount')::numeric` —una conversión de representación, no una
-- operación— y la que este archivo NO cruza. Un token con las sumas sería más
-- fino (detectaría también el cambio de MONTO de una fila existente) y está
-- PROHIBIDO; la limitación que eso deja se declara abajo, en "VENTANAS
-- DECLARADAS".
--
-- LECTURA BAJO EL LOCK, Y POR QUÉ LOS CUATRO CONTEO SON SUFICIENTES
--
-- Los cuatro `count(*)` corren DESPUÉS del `SELECT ... FOR UPDATE` del turno y
-- DESPUÉS de su precondición de estado, y antes del `UPDATE`. Bajo READ
-- COMMITTED eso da la garantía exacta que hace falta, para las cuatro fuentes:
--   * Un movimiento que YA commiteó es visible —un `SELECT` ve todo lo
--     confirmado antes de empezar—, así que su fila entra en el conteo y el
--     token, computado antes, no coincide: se rechaza.
--   * Un movimiento EN VUELO no puede ser invisible: el cobro (056) toma
--     `FOR SHARE` del turno, y `FOR SHARE` COMPITE con el `FOR UPDATE` de acá. O
--     llegó primero —y este `FOR UPDATE` espera hasta que commitee, con lo que sus
--     filas ya son visibles para el conteo—, o llegó después —y espera a esta
--     transacción; al re-leer la fila bloqueada ve el turno `cerrado` y RECHAZA
--     sin escribir nada—. No hay una tercera instancia en que un movimiento quede
--     fuera del conteo Y fuera del rechazo.
--   * El arqueo se computó UNA vez, con las cuatro listas que el servicio leyó, y
--     cada conteo del token sale de la MISMA lista que entró en ese cómputo (no
--     de una lectura aparte, que los tests fijan). Así, "el token coincide" es
--     exactamente "las cuatro entradas del arqueo siguen siendo las mismas".
--   * El `UPDATE` de abajo conserva además su propio CAS (`status = 'abierto'`)
--     y su red de conteo, así que un cierre concurrente sigue rechazándose con
--     `SHIFT_ALREADY_CLOSED` como antes.
--
-- POR QUÉ NO HAY `DROP FUNCTION` (la firma NO cambia)
--
-- 058 tuvo que hacer `DROP` porque la precondición le agregaba un ARGUMENTO: con
-- `CREATE OR REPLACE` PostgreSQL no cambia la lista de argumentos —crea una
-- función NUEVA y deja viva la vieja—, y la vieja (seis argumentos) habría sido
-- un bypass de la precondición.
--
-- Acá NO: la extensión entra DENTRO del objeto jsonb que ya viajaba, con dos
-- claves más. La firma es la MISMA que la de 058 —`p_collection_counts jsonb`,
-- séptimo argumento, mismo tipo y mismo orden— y también son iguales el tipo de
-- retorno, el lenguaje y el `SECURITY INVOKER`. Con `CREATE OR REPLACE` la
-- función se REEMPLAZA (no se agrega una sobrecarga: para eso haría falta una
-- firma distinta) y no queda ninguna versión sin la precondición extendida.
-- Por eso este archivo no lleva `DROP FUNCTION IF EXISTS`: no hay firma vieja que
-- remover, y un `DROP` de la firma que se vuelve a crear sólo agregaría una
-- ventana de "la función no existe" sin cerrar nada. El archivo sigue siendo
-- idempotente y re-ejecutable por `CREATE OR REPLACE`, REVOKE/GRANT, ALTER y
-- COMMENT.
--
-- LO QUE ESTE ARCHIVO NO CAMBIA (la aritmética sigue en TypeScript, entera)
--
-- Reemplaza la función del cierre conservando su cuerpo VERBATIM —el de 058, que
-- a su vez conservó el de 049— y agregando sólo la extensión del token: la guarda
-- de FORMA de los cuatro montos y de las líneas del conteo, el `FOR UPDATE` del
-- turno con su verificación de sede, su precondición de estado, su CAS en el
-- `WHERE` del `UPDATE`, sus DOS redes de conteo (`SHIFT_ALREADY_CLOSED` si no
-- actualizó exactamente un turno y `SHIFT_COUNT_MISMATCH` si no escribió
-- exactamente las líneas recibidas), la escritura VERBATIM de `p_close` y de
-- `p_counts`, la devolución con las MISMAS columnas de `SHIFT_SELECT` y el paso
-- del CHECK `expected_cash >= 0` de 006 al servicio (que lo traduce a
-- CASH_OUT_EXCEEDS_COLLECTED).
--
-- NO se mueve ni una operación: la función sigue sin sumar, sin restar, sin
-- multiplicar y sin redondear un solo monto. `expected_cash`, `base_left`,
-- `cash_withdrawn` y `base_difference` llegan resueltos por `resolveClosingBase`
-- y `computeCashClose`; los desajustes por método, por `expectedDigitalTotal` y
-- `moneyEquals`; las líneas del conteo, por `checkCounts`. Lo ÚNICO distinto es
-- que ahora hay CUATRO `count(*)` de conjuntos de filas y una comparación contra
-- los cuatro números que el llamador mandó. Tampoco cambia el resultado devuelto:
-- un arqueo viejo ahora se RECHAZA en vez de firmarse, y eso es lo único
-- distinto.
--
-- Los otros dos caminos de 049 —`cash_open_shift_atomic` y
-- `cash_recount_shift_atomic`— siguen sin tocarse, por la misma razón que en 058:
-- la apertura no computa un arqueo a partir de ledgers y el reconteo CORRIGE un
-- cierre ya firmado, con las dos versiones como dato.
--
-- QUIÉN PUEDE LLAMARLA Y CÓMO SE CIERRA EL PERMISO
--
-- Igual que 018/039/046–049/058: la función es SECURITY INVOKER (el único
-- llamador es el cliente `service_role` del servidor, que ya bypassa RLS), y
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC por defecto, así que se revoca de
-- PUBLIC, anon y authenticated y se otorga SÓLO a service_role. Sin ese bloque,
-- cualquier JWT podría cerrar el turno de un cajero firmando un arqueo con los
-- montos que quisiera. `CREATE OR REPLACE` CONSERVA el ACL existente, pero el
-- bloque se repite igual: es barato, idempotente y deja el archivo válido también
-- sobre una base donde la función no existiera (una restauración parcial).
--
-- ACOPLAMIENTO DE DESPLIEGUE (declarado)
--
-- La app nueva y este archivo se despliegan JUNTOS, y en este caso la
-- compatibilidad es HACIA LOS DOS LADOS de forma asimétrica, así que va explícita:
--
--   * App nueva + archivo sin aplicar: la app manda el token con CUATRO claves y
--     la función de 058 (la que está en la base) valida FORMA y sólo compara dos.
--     Las claves de más se IGNORAN, así que el cierre FUNCIONA —y sigue sin
--     cubrir las salidas, que es el defecto que esta unidad cierra—. No es un
--     fallo cerrado: es una degradación SILENCIOSA, y por eso la app nueva y el
--     archivo van juntos.
--   * Archivo aplicado + app vieja: la app manda el token con DOS claves, la
--     guarda de FORMA de la versión nueva rechaza con `SHIFT_INVALID` y el cierre
--     devuelve un error de contrato SIN ESCRIBIR NADA: el turno sigue abierto y
--     cerrable. La migración NO es compatible hacia atrás con la app vieja, a
--     propósito: una firma que acepte cerrar sin los conteo de las salidas sería
--     el bypass que este archivo elimina (la misma decisión que 057 y 058).
--   * `voucher_requests.method_code` y `cash_shift_id` existen desde la 028. En
--     una base SIN la 028, el conteo de vales de la transacción no puede correr
--     y el cierre falla CERRADO (error, nada escrito) en vez de degradar como
--     hacía el servicio, que con `hasVoucherOutColumns` se saltaba las salidas
--     por vale. La 028 está aplicada en este proyecto y el camino de vales ya la
--     usa; la dependencia se declara acá porque este archivo la vuelve DURA.
--
-- COSTO DE NUMERACIÓN (declarado)
--
-- 059 es el número asignado a esta unidad; 052 a 058 están tomados por otras
-- unidades. Este archivo NO renumera ni toca ninguno, y no tiene ninguna
-- dependencia de datos ni de funciones con ellos: usa las tablas de 005/006/016
-- (payments, invoices, invoice_payments, commission_payouts) más
-- `voucher_requests` (007/028), la función de 058 y nada más. El costo es una
-- ranura más de la serie, consumida por la unidad que la tiene asignada. Tampoco
-- quema ningún número de negocio: el cierre no tiene serie ni consecutivo
-- (`cash_shifts.id` es un uuid con `gen_random_uuid()`), así que un rechazo no
-- deja hueco.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra)
--
--   * EL MONTO DE UNA FILA EXISTENTE NO SE VE (heredada de 058, sin cambio): un
--     `count(*)` no nota que cambió el `amount` de una fila que ya estaba en la
--     lista del arqueo. Hoy NO hay escritor conocido: ningún camino del sistema
--     edita el monto de un pago, de una porción de factura, de un pago de comisión
--     o de un vale ya aprobado. Si lo hubiera, el token tendría que pasar a un
--     hash de las filas (declarado en 058) y nunca a una suma.
--   * EL CONJUNTO de filas de un vale tampoco se ve en su CONTENIDO: la apertura
--     de un vale nuevo y una aprobación SÍ cambian el conteo (una fila más en el
--     token, o el paso de no-aprobada a aprobada), pero pasar de aprobado con
--     método A a aprobado con método B no cambia ni una fila. Ningún camino del
--     sistema re-aprueba un vale cambiándole el método (`approveVoucher` decide
--     una vez), así que la ventana no tiene escritor conocido.
--   * EL MÉTODO DE UNA PORCIÓN SÍ PUEDE CAMBIAR sin cambiar el conteo (heredada
--     de 058, sin cambio): la edición de una factura `Emitida` (051) pisa
--     `invoice_payments.method_code` y `method_id`, y eso mueve el reparto por
--     método del arqueo —y con él `expected_cash`, que sale del efectivo— sin
--     agregar ni quitar una fila. La edición es legítima y CONCURRENTE (exige un
--     turno abierto), así que la ventana existe. En las salidas hay un equivalente
--     más angosto: el método de una comisión pagada o de un vale aprobado no lo
--     edita nadie hoy. Cerrar esta clase pide un token que mire el CONTENIDO de
--     las filas (el hash de 058), no un conteo, y no se hace a medias.
--   * EL TECHO DE FILAS POR REQUEST DEL DATA API (`max-rows`, 1000 por defecto;
--     ver `src/shared/lib/paged.ts`), heredada de 058 y AMPLIADA por este
--     archivo: ahora son CUATRO lecturas las que alimentan el arqueo y el token
--     (`payments`, `fetchInvoicePaymentsByShift`, `commission_payouts` y
--     `fetchVoucherOutRows`), ninguna paginada. Si un turno tuviera más filas que
--     el techo, el servicio leería una ventana y el conteo de la base sería mayor
--     que el token, así que el cierre se RECHAZARÍA con `ARQUEO_STALE` una y otra
--     vez. Es un fallo CERRADO y RUIDOSO —mejor que firmar un arqueo corto en
--     silencio—, pero deja el turno sin poder cerrarse. Cerrarlo pide paginar las
--     CUATRO lecturas con `readAllPaged` (`src/shared/lib/paged.ts`), en una
--     unidad aparte: dos de esos fetchers son COMPARTIDOS por las vistas de día e
--     historia, y con esto no se gana ni se pierde corrección del arqueo. Lo que
--     este archivo SÍ cambia respecto de 058 es la SUPERFICIE: la ventana pasa de
--     dos lecturas a cuatro, y las dos nuevas son las de menor volumen (una
--     comisión pagada y un vale son movimientos de excepción, no cobros).
--   * La APERTURA del turno entra en el esperado DIGITAL por método
--     (`openByMethod`, las líneas de fase `apertura` de `cash_shift_counts`),
--     pero NO en el token. Se comprobó y no se agrega: esa tabla es de SÓLO
--     INSERCIÓN —ningún camino del sistema la actualiza ni la borra— y la única
--     fase que se puede escribir con el turno ya no `abierto` es la del reconteo,
--     que exige `cerrado` (049). Con el turno `abierto` —el único estado en que
--     esta transacción cierra— sus líneas no pueden cambiar, así que contarlas no
--     cerraría ninguna ventana; y no tocan `expected_cash`, que sale del efectivo
--     cobrado menos el efectivo pagado.
--   * La igualdad entre el TOTAL declarado y su detalle por denominación
--     (`moneyEquals(countedFromDetail, counted_cash)`) sigue siendo una regla del
--     SERVICIO, evaluada antes de llamar: comprobarla adentro exigiría SUMAR las
--     líneas de efectivo en SQL.
--   * La AUDITORÍA (`writeAudit`) sigue FUERA de la transacción: es un INSERT
--     posterior y separado que no lanza. Con el rechazo, además, no corre: el
--     servicio lanza ANTES de auditarlo, así que un arqueo viejo no deja ninguna
--     fila de auditoría del cierre que no ocurrió.
--   * La ventana de 049 que 058 tampoco toca sigue igual: el CONJUNTO de líneas
--     del conteo se decide antes de la transacción (`checkCounts`), y una
--     denominación que se desactive en el medio no invalida el conteo ya
--     validado.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. cash_close_shift_atomic con la precondición EXTENDIDA a las dos salidas
-- ===================================================================== ---
-- La MISMA operación de 058 —que es la de 049 más la precondición del conjunto
-- de cobros—, con los DOS CONTEO de las salidas que el arqueo resta agregados al
-- mismo objeto jsonb y a la misma comparación. Sin `DROP`: la firma NO cambia
-- (ver "POR QUÉ NO HAY DROP FUNCTION" arriba), así que `CREATE OR REPLACE` deja
-- UNA sola función y no una sobrecarga.
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
  v_commission_payouts bigint;
  v_voucher_requests bigint;
BEGIN
  -- 1.1 FORMA de la entrada. Un cierre es el documento que firma un arqueo: no
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
  --     DESPLIEGUE"): aceptar dos sería aceptar firmar sin comprobar las salidas.
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
  --      dinero. Las variables son `bigint` porque es el tipo que `count(*)`
  --      devuelve: no hay ninguna conversión estrecha entre el conteo y lo que se
  --      compara (la guarda de forma de 1.1 ya limitó el token a nueve dígitos).
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

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y
  --     el llamador recibe el MISMO error de negocio que ya recibía cuando
  --     perdía el CAS en el cliente.
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
-- La función resuelve `cash_shifts`, `cash_shift_counts`, `payments`,
-- `invoice_payments`, `invoices`, `commission_payouts` y `voucher_requests`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049/058).
ALTER FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cerrar el turno de un cajero firmando un arqueo
-- con los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor. La firma es la MISMA que la de 058 (ver "POR QUÉ NO
-- HAY DROP FUNCTION"), así que el bloque se repite idéntico: es idempotente y
-- deja el archivo válido sobre una base donde la función no existiera.
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb) IS
'CL-10/CL-19/CL-20: cierre ATÓMICO de un turno de caja (CAJ-03/CAJ-04) con PRECONDICIÓN sobre las CUATRO entradas del arqueo. Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. CL-19 agregó p_collection_counts: los CONTEO de filas de las DOS fuentes que el arqueo SUMA (payments del turno sin factura e invoice_payments atribuidas al turno). CL-20 extiende el MISMO token con los CONTEO de las DOS fuentes que el arqueo RESTA (commission_payouts del turno y voucher_requests del turno aprobados y con método): una comisión pagada o la aprobación de un vale confirmadas entre la lectura del servicio y este lock ya no quedan fuera de un arqueo firmado. La transacción RE-CUENTA las cuatro fuentes bajo el lock y, si alguna difiere, RECHAZA con ARQUEO_STALE sin escribir nada. El token es OBLIGATORIO —las CUATRO claves se exigen por forma; su ausencia es SHIFT_INVALID, nunca "no compares"— y son CONTEO, no sumas: acá no se suma ni se resta un solo monto, porque mover aritmética de dinero a SQL está prohibido en este proyecto. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. Sólo service_role puede ejecutarla.';

-- No hay `DROP FUNCTION` en este archivo: la firma de siete argumentos NO cambia
-- respecto de 058 —la extensión entra dentro del objeto jsonb del token—, así que
-- `CREATE OR REPLACE` reemplaza la función en vez de crear una sobrecarga, y no
-- puede quedar viva ninguna versión sin la precondición extendida.
