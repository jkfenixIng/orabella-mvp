-- 044_remaining_payment_idempotency.sql — CL-5: reenviar el MISMO pago
-- extraordinario de nómina, el MISMO pago inmediato de comisión o la MISMA
-- solicitud de vale deja de pagar dos veces.
--
-- MOTIVO DEL ARCHIVO
--
-- La 041 (emisión de facturas), la 042 (abono de nómina y cobro dividido) y la
-- 043 (pago de cajón) construyeron el mecanismo de identidad del ENVÍO: una
-- marca que el llamador acuña por intento, una guarda de forma, un índice único
-- PARCIAL por el registro de la operación, y el 23505 como barrera final de la
-- carrera. Cada una cerró una puerta y declaró lo que NO cerraba. Las tres
-- puertas de este archivo son las que quedaron abiertas:
--
--   1. `commission_payouts` (`payCommissionNow`, commissions/service.ts). El
--      pago PARCIAL es legal y deliberado (016/034: nada de UNIQUE(factura,
--      empleado); el tope es ACUMULADO contra el ganado inmediato), y el tope
--      de la base `trg_commission_payouts_cap` (034) usa LA MISMA aritmética
--      que la validación del servicio (`Σ + nuevo − ganado > 0,009`). Con
--      `2 × monto ≤ pendiente` las DOS barreras pasan y un reintento paga la
--      comisión dos veces, sin que nada lo recupere después: el tope sólo acota
--      la suma al ganado, no distingue "el mismo envío" de "un segundo pago".
--      Es la única de las tres alcanzable desde una pantalla (el modal de pago
--      inmediato al cobrar la factura).
--   2. `payroll_extras` (`payPayrollExtra`, payroll/service.ts). El monto es a
--      propósito SIN TOPE (036: "El monto lo escribe el admin y NO se topa":
--      un despido liquida prestaciones, no la porción del sueldo), así que no
--      hay obligación contra la cual comparar y un reintento escribe SIEMPRE un
--      segundo pago extraordinario.
--   3. `voucher_requests` (`requestVoucher`, payroll/service.ts). Los topes de
--      026 (día y semana) son ACUMULADOS —una obligación total—, no la
--      identidad de un envío: mientras `2 × monto` quepa en el día y en la
--      semana, un reintento abre un SEGUNDO vale, con su segunda salida de caja
--      en el arqueo y su segundo descuento en la nómina.
--
-- QUÉ SE MIDIÓ (no lo que se supuso)
--
-- Las tres puertas se midieron con un test que llamaba dos veces al servicio con
-- el MISMO cuerpo, ANTES de tocar el código, y las tres reprodujeron el
-- hallazgo (el ROJO quedó como test permanente, ya en verde):
--
--   commission_payouts:
--     expected [ { id: 'payout-1', …(12) }, …(1) ] to have a length of 1 but got 2
--   payroll_extras:
--     expected [ …(2) ] to have a length of 1 but got 2
--   voucher_requests (los dos vales quedaron APROBADOS):
--     SONDA vales: {"total":2,"statuses":["aprobada","aprobada"], …}
--     expected [ …(2) ] to have a length of 1 but got 2
--
-- La misma medición, con marca mandada por el llamador, mostró el otro lado del
-- defecto en comisión: un envío que AGOTÓ el pendiente y se reintenta moría con
-- NOTHING_PENDING —un error por una operación que SÍ se registró— porque el
-- tope del servicio y el de la base son la misma aritmética.
--
-- LAS TRES MARCAS LAS MINTE EL CLIENTE, y por eso las tres pantallas que llegan
-- a estas puertas las acuñan por intento y las conservan mientras se reintenta:
-- el modal de comisión de la factura, el formulario de pago extraordinario de
-- nómina y el modal de vales. En las tres, el servidor NO puede acuñarla: un
-- reintento es una invocación nueva, así que una marca generada en el servidor
-- sería otra marca y el defecto seguiría igual. Para un llamador crudo (la ruta
-- `POST /api/v1/vouchers` es pass-through y no necesita código), la marca pasa a
-- ser un requisito del CONTRATO: el cuerpo tiene que traerla o la operación se
-- rechaza con VALIDATION (400), ruidosamente y sin escribir.
--
-- CÓMO SE RECONOCE UNA REPETICIÓN (decisión del dueño, no del agente)
--
-- Por una MARCA que manda el llamador: `idempotency_key` en las dos tablas, el
-- mismo mecanismo de la 041, la 042 y la 043. NO por el CONTENIDO: deduplicar
-- por contenido prohibiría dos pagos legítimos iguales hechos en dos intentos
-- distintos —dos abonos parciales de comisión del mismo monto a la misma
-- empleada, o dos pagos extraordinarios iguales por dos casos distintos—; la
-- marca es lo único que distingue "el mismo envío" de "el mismo contenido". La
-- marca es un uuid que el llamador acuña al empezar el intento, que reutiliza
-- en los reintentos del MISMO intento y que suelta al éxito (nunca por tecla ni
-- por render), y se valida con la MISMA definición para todas las puertas del
-- dinero (`idempotencyKeySchema`, billing/schemas.ts).
--
-- POR QUÉ CADA TABLA NECESITA SU PROPIA COLUMNA
--
-- Porque en las tres la fila ES la operación completa: no hay fila espejo que la
-- identifique y no hay obligación de la que colgarla (el pago extraordinario no
-- tiene período NI ítem por diseño; el pago de comisión tiene un tope acumulado,
-- que no es una identidad; el vale es una obligación que la nómina descuenta
-- después). Guardar la marca en otra tabla exigiría un registro de operación que
-- la 042 evaluó y descartó por caro (tabla nueva, FK, backfill conceptual y
-- reescritura de pantallas) para lo que resuelve. Y la columna es la MISMA que
-- ya existe en las otras tablas de dinero: una sola forma de reconocer una
-- repetición en todo el sistema.
--
-- LA CLAVE DE CADA ÍNDICE (no es la misma: la dicta lo que la operación
-- significa)
--
--   * `commission_payouts`: (`invoice_id`, `employee_id`, `idempotency_key`).
--     El registro de esta operación es el PAR (factura, empleado): es lo que el
--     modal identifica —paga la comisión de UN empleado en UNA factura—, es la
--     clave del tope de 034 (la suma es por factura y empleado) y es la clave
--     de `immediatePaidTotal`. La sede NO entra porque no agrega identidad: la
--     factura pertenece a una sola sede y el servicio la resuelve dentro de la
--     del actor (una factura ajena es NOT_FOUND antes del lookup), así que el
--     lookup no puede devolver el pago de otra sede. La misma marca con otra
--     factura —o con otro empleado— es OTRA operación.
--   * `payroll_extras`: (`employee_id`, `idempotency_key`). El registro acá es
--     el EMPLEADO: el pago extraordinario no tiene período ni ítem —esa es su
--     razón de ser (036): existe justo para pagar días que un período CERRADO
--     ya cubrió—, y el empleado es a quien el pago significa y la dimensión del
--     historial del módulo (`idx_payroll_extras_employee_paid_at`). La sede NO
--     entra porque el servicio resuelve al empleado y exige que sea de la sede
--     del actor (uno ajeno es NOT_FOUND antes del lookup). La misma marca para
--     otro empleado es OTRA operación.
--   * `voucher_requests`: (`employee_id`, `idempotency_key`). El registro acá es
--     el EMPLEADO, y el TURNO NO ENTRA, deliberadamente: el vale es una
--     OBLIGACIÓN del empleado —es lo que la nómina descuenta y es la dimensión
--     de los topes acumulados de 026 (`idx_voucher_requests_employee_date`)—,
--     mientras que el turno es el dueño del EFECTIVO que sale, no lo que el
--     vale ES. Meterlo costaría el defecto mismo: un reintento que llegue
--     después de que el turno original se cerró y se abrió OTRO se resolvería
--     contra el turno nuevo, no encontraría su marca ahí y abriría el SEGUNDO
--     vale que esta puerta existe para evitar. La sede NO entra porque el
--     servicio valida que el empleado sea de la sede del actor (uno ajeno es
--     NOT_FOUND) antes del lookup, así que no puede cruzar de sede. La misma
--     marca para otro empleado es OTRA operación.
--
-- En los dos casos el lookup del servicio filtra EXACTAMENTE las columnas del
-- índice —el mismo `eq` set—, así que no puede devolver una fila que el índice
-- no habría bloqueado.
--
-- MECANISMO (dos barreras por puerta, en este orden)
--
--   1. La columna. Guarda la marca del intento.
--   2. El índice único PARCIAL. Es la barrera FINAL contra la carrera: el
--      servicio mira la marca ANTES de insertar (así el reintento normal no
--      escribe nada), pero entre esa lectura y el INSERT hay una ventana. Si
--      otra operación con la MISMA marca y el MISMO registro se confirma ahí
--      adentro, este INSERT choca con el índice (código 23505), el servicio
--      vuelve a buscar por la marca y devuelve la fila de la ganadora. Mismo
--      patrón de barrera final que `uq_invoices_sede_idempotency_key` (041),
--      `uq_invoice_payments_invoice_idempotency_key` y
--      `uq_payroll_payments_item_idempotency_key` (042),
--      `uq_payments_shift_idempotency_key` (043), `uq_cash_shifts_open_per_register`
--      (006) y `uq_payroll_draft_per_range` (007).
--
--      Parcial (`WHERE idempotency_key IS NOT NULL`) por tres razones: las
--      filas ya pagadas no tienen marca y no deben entrar al índice; una marca
--      NULL no es una marca y no puede deduplicar nada; y una marca vacía
--      tampoco.
--
-- LA ARRUGA DE 042 NO APLICA A NINGUNA DE LAS DOS: las dos insertan UNA sola
-- fila (una sentencia de un objeto, no un `insert([...])` de N porciones), así
-- que la marca vive en esa única fila, no hay porciones hermanas que enumerar y
-- el índice nunca puede rechazar una operación legítima. En `commission_payouts`
-- el pago PARCIAL sigue siendo legal por otra razón: dos pagos parciales son dos
-- INTENTOS distintos con dos marcas distintas, y el pago parcial no se toca.
--
-- COSTO DECLARADO (no se esconde, por tabla)
--
-- AQUÍ NO SE QUEMA NINGÚN NÚMERO, EN NINGUNA DE LAS TRES TABLAS.
-- `commission_payouts.id` es `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
-- (016_commissions.sql), `payroll_extras.id` también (036_payroll_extra_payment.sql)
-- y `voucher_requests.id` también (007_payroll.sql), así que ninguna de las tres
-- tiene serie ni consecutivo y no hay hueco que declarar, ni en el camino normal
-- ni en la carrera. Lo que sí cuesta la carrera es una sentencia ABORTADA: la
-- perdedora ya había resuelto el empleado, el turno y el método cuando chocó con
-- el índice, y esa sentencia no deja filas. Es el mismo canje de la 042 y la
-- 043 —perder trabajo invisible antes que pagar dos veces— sin el hueco de
-- consecutivo que sí existe en la 041.
--
-- EL OTRO COSTO, el de cada clave: como la clave incluye el REGISTRO, la marca
-- se resuelve dentro de él. La misma marca en dos registros distintos son dos
-- operaciones (no una repetición), que es lo correcto y está probado en los dos
-- ejes de cada índice (otra factura u otro empleado para comisión; otro
-- empleado para extraordinarios).
--
-- LIMITACIONES DECLARADAS (ventanas que estos índices NO cierran)
--
--   * `commission_payouts`: la marca NO puede reconocerse antes de que el par
--     quede validado dentro de la sede del actor, porque esa validación vive en
--     `earnedCommissionFor` (que incluye la anulación de la factura). Un
--     reintento que llegue con la factura ANULADA, SIN turno abierto
--     (NO_OPEN_SHIFT), con el método ya INACTIVO (METHOD_INACTIVE) o con el
--     empleado marcado `no_aplica` se rechaza en vez de reconocerse. Es la misma
--     familia que la limitación ya declarada en CL-3/CL-4 ("un reintento que
--     llegue con el turno ya cerrado o con el método inactivo se rechaza en vez
--     de reconocerse"): el caso real del reintento —doble clic, o el navegador
--     reenviando tras cortarse la red— ocurre segundos después, con la factura
--     vigente, el mismo turno abierto y el mismo método activo, y ahí la marca
--     SÍ reconoce. No se pierde plata: el rechazo es ruidoso y, levantada la
--     guarda, la misma marca sigue reconociendo.
--   * `commission_payouts`: el índice NO mira el turno. Es deliberado y es una
--     propiedad, no una limitación: la operación sale de la caja, pero su
--     identidad es el par, así que un reintento que llegue con OTRO turno
--     abierto se reconoce igual (la 043 sí declara esa ventana porque su clave
--     es el turno).
--   * `payroll_extras`: el método de pago no es la identidad, así que un
--     reintento que llegue con el método ya inactivo se reconoce igual (y no se
--     duplica). Un pago NUEVO con el método inactivo sigue rechazándose con
--     METHOD_INACTIVE.
--   * `voucher_requests`: las guardas de la CAJA van antes del lookup, porque
--     son las que deciden si esta caja puede entregar dinero: un reintento que
--     llegue con el turno ya CERRADO (NO_OPEN_SHIFT) o con la caja abierta a
--     nombre de otro (SHIFT_NOT_OWNER) recibe el rechazo de estado en vez del
--     reconocimiento. Misma familia que las limitaciones ya declaradas en
--     CL-3/CL-4: el caso real del reintento —doble clic, o el navegador
--     reenviando tras cortarse la red— ocurre segundos después, con la misma
--     caja abierta, y ahí la marca SÍ reconoce. No se pierde plata: el rechazo
--     es ruidoso y, con la caja abierta de nuevo, la misma marca sigue
--     reconociendo (la clave NO lleva el turno, así que un reintento con OTRO
--     turno abierto también se reconoce).
--   * `voucher_requests`: la repetición devuelve el ESTADO REGISTRADO del vale
--     (`requires_approval` = sigue pendiente; `auto_approved` = entró aprobado)
--     y NO vuelve a evaluar la elegibilidad: los topes de 026 son acumulados y
--     reevaluarlos con los totales de AHORA respondería otra pregunta. Los tres
--     flags de rango son insumos de la decisión original —viajan en la auditoría
--     de la alerta, escrita al solicitar— y no están guardados en la fila.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas: `ADD COLUMN IF NOT EXISTS` con NULL (sin
--     DEFAULT, así que no toca ninguna fila) y dos índices. No hay UPDATE de
--     datos, ni DELETE, ni TRUNCATE, ni backfill: las filas anteriores a esta
--     migración no tienen marca y no pueden tenerla (reconstruirla sería
--     adivinar qué filas fueron el mismo envío).
--   * No cambia el dinero: ni la aritmética, ni el redondeo a peso entero, ni
--     el tope acumulado de comisión de 034, ni la decisión de que el monto del
--     pago extraordinario NO se topa (036), ni la guía del sueldo. Las columnas
--     no entran en ninguna regla de negocio; sólo reconocen envíos repetidos.
--   * No toca las otras puertas del dinero: la emisión de facturas y el cobro
--     (041/042), ni el pago de ítem de nómina (042), ni la caja (042/043).
--   * No agrega índices redundantes: cada índice único parcial ya sirve la
--     lectura por marca de su puerta.
--   * YA NO QUEDA NINGUNA PUERTA DE REINTENTO DECLARADA ABIERTA en el camino del
--     dinero: las tres que la 043 dejó escritas —comisión, pago extraordinario y
--     vale— se cierran acá. Queda fuera, y se dice porque no es plata, el
--     MOVIMIENTO MANUAL DE INVENTARIO (`registerMovement`, inventory/service.ts):
--     un reintento duplica el movimiento de stock y el kardex, pero no escribe
--     ningún monto dos veces (el descuento por emisión sí es plata y está
--     cubierto por la marca de la factura, 041). Se reporta como hallazgo propio,
--     no se arregla en este archivo.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 044 va ANTES que este código. Sin las
-- columnas, los lookups por marca (`findCommissionPayoutByIdempotencyKey`,
-- `findPayrollExtraByIdempotencyKey` y `findVoucherRequestByIdempotencyKey`)
-- fallan y TODOS los pagos inmediatos de comisión, TODOS los pagos
-- extraordinarios y TODAS las solicitudes de vale dan 500. Misma regla que
-- 005/034/041/042/043.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`,
-- `CREATE UNIQUE INDEX IF NOT EXISTS` y los CHECK con `DROP CONSTRAINT IF
-- EXISTS` + `ADD CONSTRAINT` (el patrón de 038/041/042/043) dejan el esquema
-- idéntico en cada corrida. Ninguna sentencia borra filas. El runner de
-- Supabase aplica el archivo en una transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La columna de `commission_payouts`. Va PRIMERO porque es el insumo del
--      índice y del CHECK: sin ella las dos sentencias siguientes no
--      compilarían.
--   2. Su comentario (sólo comentario): qué es la marca y por qué las filas
--      anteriores quedan NULL.
--   3. Su guarda de forma (CHECK). Va ANTES del índice porque es el rechazo más
--      barato y el más explícito: un escritor crudo que mande una marca que no
--      es un uuid se rechaza por forma antes de llegar a la comparación del
--      índice.
--   4. Su índice único parcial. Cierra la primera puerta antes de empezar la
--      siguiente, igual que la 042 agrupó por puerta.
--   5. La columna de `payroll_extras`.
--   6. Su comentario.
--   7. Su guarda de forma (CHECK).
--   8. Su índice único parcial.
--   9. La columna de `voucher_requests`.
--  10. Su comentario.
--  11. Su guarda de forma (CHECK).
--  12. Su índice único parcial.
--  13. La nota final: qué NO protegen estos índices y qué hallazgo queda
--      fuera (el movimiento manual de inventario), para el que lea los topes y
--      crea que ya está todo cubierto.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La MARCA del intento de pago inmediato de comisión
-- ===================================================================== ---

-- NULL a propósito: las filas ya pagadas no tienen marca (la decisión del dueño
-- es hacia adelante) y la marca es opcional a nivel de esquema porque sólo el
-- camino del PAGO la exige. Sin DEFAULT, `ADD COLUMN` no reescribe la tabla y
-- no hay backfill que inventar.
ALTER TABLE public.commission_payouts
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

-- ===================================================================== ---
-- 2. Qué es la marca de esta tabla
-- ===================================================================== ---

COMMENT ON COLUMN public.commission_payouts.idempotency_key IS
  'CL-5: marca de idempotencia del intento de pago inmediato de comisión (uuid que acuña la pantalla al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el pago ya registrado en vez de pagar la comisión dos veces. La misma marca con otra factura o con otro empleado es OTRA operación. NULL en las filas anteriores a 044.';

-- ===================================================================== ---
-- 3. La guarda de forma: una marca es un uuid, no cualquier texto
-- ===================================================================== ---

-- El servicio valida el formato ANTES de escribir (`idempotencyKeySchema`, la
-- MISMA definición para todas las puertas del dinero: billing/schemas.ts), así
-- que ningún camino del usuario puede llegar a este CHECK: es la última red
-- para un escritor crudo (SQL, un servicio futuro) y prefiere rechazar la fila
-- antes que guardar una marca que el lookup nunca podría reconocer.
ALTER TABLE public.commission_payouts
  DROP CONSTRAINT IF EXISTS commission_payouts_idempotency_key_shape;
ALTER TABLE public.commission_payouts
  ADD CONSTRAINT commission_payouts_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ===================================================================== ---
-- 4. La barrera final: a lo sumo UNA operación por marca y PAR
--    (factura, empleado)
-- ===================================================================== ---

-- Parcial: la marca NULL (filas históricas) queda fuera del índice, y una marca
-- vacía tampoco deduplica nada. Es la barrera que convierte la carrera
-- lookup→INSERT en un 23505 que el servicio traduce en "devuelve la operación
-- existente". Un índice único NO contradice los pagos parciales que 016/034
-- declaran legales: dos pagos parciales son dos intentos con dos marcas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_payouts_pair_idempotency_key
  ON public.commission_payouts (invoice_id, employee_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ===================================================================== ---
-- 5. La MARCA del intento de pago extraordinario de nómina
-- ===================================================================== ---

-- Igual que la primera: nullable, sin DEFAULT y sin backfill, por la misma
-- razón (las filas anteriores no tienen marca y reconstruirla sería adivinar).
ALTER TABLE public.payroll_extras
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

-- ===================================================================== ---
-- 6. Qué es la marca de esta tabla
-- ===================================================================== ---

COMMENT ON COLUMN public.payroll_extras.idempotency_key IS
  'CL-5: marca de idempotencia del intento de pago extraordinario (uuid que acuña la pantalla al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el pago ya registrado en vez de escribir un segundo pago extraordinario. La misma marca para otro empleado es OTRA operación. NULL en las filas anteriores a 044.';

-- ===================================================================== ---
-- 7. La guarda de forma de la segunda marca
-- ===================================================================== ---

ALTER TABLE public.payroll_extras
  DROP CONSTRAINT IF EXISTS payroll_extras_idempotency_key_shape;
ALTER TABLE public.payroll_extras
  ADD CONSTRAINT payroll_extras_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ===================================================================== ---
-- 8. La barrera final de la segunda puerta: a lo sumo UNA operación por
--    marca y EMPLEADO
-- ===================================================================== ---

-- El registro acá es el empleado (el pago no tiene período ni ítem), así que la
-- clave es `(employee_id, idempotency_key)`. Parcial por la misma razón que la
-- anterior: la marca NULL de las filas históricas no compite con nada, y una
-- marca vacía no deduplica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_extras_employee_idempotency_key
  ON public.payroll_extras (employee_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ===================================================================== ---
-- 9. La MARCA del intento de solicitud de vale
-- ===================================================================== ---

-- Igual que las dos anteriores: nullable, sin DEFAULT y sin backfill, por la
-- misma razón (las filas anteriores no tienen marca y reconstruirla sería
-- adivinar cuáles fueron el mismo envío).
ALTER TABLE public.voucher_requests
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

-- ===================================================================== ---
-- 10. Qué es la marca de esta tabla
-- ===================================================================== ---

COMMENT ON COLUMN public.voucher_requests.idempotency_key IS
  'CL-5: marca de idempotencia del intento de solicitud de vale (uuid que acuña la pantalla de vales al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el vale ya registrado en vez de abrir un segundo vale (segunda salida de caja y segundo descuento de nómina). La misma marca para otro empleado es OTRA operación; el TURNO no entra en la clave a propósito (el vale es una obligación del empleado, y con el turno dentro un reintento con otro turno abierto no se reconocería). NULL en las filas anteriores a 044.';

-- ===================================================================== ---
-- 11. La guarda de forma de la tercera marca
-- ===================================================================== ---

ALTER TABLE public.voucher_requests
  DROP CONSTRAINT IF EXISTS voucher_requests_idempotency_key_shape;
ALTER TABLE public.voucher_requests
  ADD CONSTRAINT voucher_requests_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ===================================================================== ---
-- 12. La barrera final de la tercera puerta: a lo sumo UNA operación por
--     marca y EMPLEADO
-- ===================================================================== ---

-- El registro acá es el empleado (la obligación que la nómina descuenta).
-- Parcial por la misma razón que las anteriores: la marca NULL de las filas
-- históricas no compite con nada y una marca vacía no deduplica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_requests_employee_idempotency_key
  ON public.voucher_requests (employee_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ===================================================================== ---
-- 13. Nota: qué NO protegen estos índices
-- ===================================================================== ---

--   * No protegen ninguna otra tabla. En particular NO tocan la caja
--     (`payments`, `invoice_payments`), la emisión (`invoices`) ni el abono de
--     nómina (`payroll_payments`), que tienen sus propias marcas en 041/042/043.
--   * No reemplazan a los topes de 026 (vales), al tope de 034
--     (`commission_payouts`) ni a la decisión de que el monto extraordinario no
--     se topa (036): el tope y la marca resuelven cosas DISTINTAS y las dos
--     siguen haciendo falta. Ninguna reemplaza a la otra: una operación distinta
--     sigue siendo legítima aunque su marca sea nueva, y una marca repetida
--     sigue siendo una repetición aunque su monto quepa en el tope.
--   * No cierran la ventana de las LIMITACIONES DECLARADAS (las guardas de
--     estado —factura anulada, turno cerrado, caja de otro, método inactivo—
--     corren antes del lookup): eso lo decide el ORDEN del servicio, no el
--     índice.
--   * No protegen el MOVIMIENTO MANUAL DE INVENTARIO (`registerMovement`,
--     inventory/service.ts): un reintento duplica el movimiento de stock y el
--     kardex. No es plata —no se escribe ningún monto dos veces— y es un
--     hallazgo propio, reportado y no arreglado acá.
