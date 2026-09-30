-- 042_payment_idempotency.sql — CL-2: reenviar el MISMO pago deja de pagar dos
-- veces, en las DOS puertas donde entra dinero por porciones: el abono de un
-- ítem de nómina (`payPayrollItem`) y el cobro dividido de una factura
-- (`splitPayment`).
--
-- MOTIVO DEL ARCHIVO
--
-- Las dos funciones leían lo ya pagado/cobrado y DESPUÉS insertaban sus
-- porciones, sin ninguna marca del ENVÍO y sin barrera de identidad. La única
-- barrera en BD era el tope de cada tabla —`trg_payroll_payments_cap` (007) y
-- `trg_invoice_payments_cap` (031)—, y un tope NO es una identidad: salta
-- cuando la suma se pasa del neto, no cuando la misma operación entra dos
-- veces. En nómina eso deja el doble pago REAL: con 2 × entrante ≤ saldo el
-- tope no ve nada y el reintento (doble clic, o el navegador reenviando tras
-- cortarse la red) paga dos veces. En el cobro de factura el doble pago no
-- llega a ocurrir porque `splitPayment` exige que las porciones igualen el
-- saldo EXACTO —después de un cobro bueno el saldo queda en cero y el reintento
-- muere en esa comprobación—, pero el reconocimiento también falta: el
-- reintento se rechaza como si fuera un cobro nuevo y la protección descansa en
-- una coincidencia aritmética, más el tope de 031 para la carrera concurrente.
-- Es la misma forma de defecto que la 041 cerró en la emisión de facturas.
--
-- CÓMO SE RECONOCE UNA REPETICIÓN (decisión del dueño, no del agente)
--
-- Por una MARCA que manda la pantalla: `idempotency_key` en las dos tablas. NO
-- por el CONTENIDO. Deduplicar por contenido prohibiría dos abonos legítimos
-- del mismo monto y del mismo método hechos en dos intentos distintos —lo
-- normal al pagar en partes— o dos cobros iguales de facturas distintas; la
-- marca es lo único que distingue "el mismo envío" de "el mismo contenido".
--
-- LA ARRUGA: UNA OPERACIÓN NO ES UNA FILA
--
-- Las dos funciones insertan N porciones (una por método) en UNA sola sentencia
-- multi-fila, así que un índice único sobre la marca a secas rechazaría la
-- SEGUNDA porción de una operación legítima. La forma elegida (entre las tres
-- evaluadas) es la menos invasiva de las dos que son sonoras: la marca vive
-- SÓLO EN LA PRIMERA PORCIÓN —el resto queda NULL— y el índice es PARCIAL
-- `(registro, idempotency_key) WHERE idempotency_key IS NOT NULL`.
--
-- POR QUÉ ESA FORMA ES SONORA (la premisa, verificada en el código)
--
-- Las dos funciones hacen UN SOLO `.insert([...])` con todas las porciones
-- (payroll/service.ts y billing/service.ts: un `insert(portions.map(...))`, no
-- un bucle de inserts). Una sentencia multi-fila es UNA operación de Postgres:
-- el 23505 de la primera fila aborta la sentencia ENTERA y no queda ninguna
-- porción de la repetición. Si esas porciones se insertaran fila por fila, esta
-- forma NO serviría (la repetición dejaría filas parciales antes de chocar) y
-- habría que pasar a un registro de operación en una tabla aparte, que es la
-- alternativa (a) evaluada y descartada por cara para lo que resuelve.
--
-- Las otras dos alternativas del análisis: (b) una columna de ordinal + único
-- `(marca, ordinal)` también es sonora, pero agrega una columna que no existe
-- hoy en el modelo y que no aporta nada más que la resolución del choque; (c)
-- es esta. (a) —una tabla de operaciones de la que cuelgan las porciones— es el
-- modelo más limpio a futuro y NO se construye acá: no hace falta para cerrar
-- el defecto y multiplica el cambio (tabla nueva, FK, backfill conceptual y
-- reescritura de dos pantallas). Queda como deuda declarada, no silenciosa.
--
-- MECANISMO (dos barreras por puerta, en este orden)
--
--   1. La columna. Guarda la marca del intento de pago: un uuid que genera la
--      PANTALLA al empezar el intento y que se reutiliza en los reintentos del
--      MISMO intento (nunca por tecla ni por render).
--   2. El índice único PARCIAL. Es la barrera FINAL contra la carrera: el
--      servicio mira la marca ANTES de insertar (así el reintento normal no
--      escribe nada), pero entre esa lectura y el INSERT hay una ventana. Si
--      otra operación con la MISMA marca se confirma ahí adentro, este INSERT
--      choca con el índice (código 23505), el servicio vuelve a buscar por la
--      marca y devuelve el resultado de la ganadora. Mismo patrón de barrera
--      final que `uq_invoices_sede_idempotency_key` (041),
--      `uq_cash_shifts_open_per_register` (006) y `uq_payroll_draft_per_range`
--      (007).
--
--      Parcial (`WHERE idempotency_key IS NOT NULL`) por tres razones: las
--      filas ya pagadas no tienen marca y no deben entrar al índice; una marca
--      NULL no es una marca y no puede deduplicar nada; y así las porciones
--      HERMANAS de una misma operación (marca NULL) nunca compiten entre sí.
--
--      La clave es `(payroll_item_id, idempotency_key)` y
--      `(invoice_id, idempotency_key)`, no la marca sola: la marca se resuelve
--      DENTRO del registro que la usó —el ítem o la factura, que es lo que la
--      URL identifica—, así que el lookup nunca puede devolver el pago de otro
--      registro, y una misma marca en dos registros distintos son dos
--      operaciones distintas. Un uuid ya es único globalmente: acotarlo no
--      cuesta nada y agrega el aislamiento.
--
-- COSTO DECLARADO (no se esconde)
--
-- AQUÍ NO SE QUEMA NINGÚN NÚMERO. Ninguna de las dos tablas tiene serie ni
-- consecutivo: `payroll_payments.id` e `invoice_payments.id` son
-- `uuid DEFAULT gen_random_uuid()`, así que no hay hueco que declarar, ni en el
-- camino normal ni en la carrera. Lo que sí cuesta la carrera es una sentencia
-- ABORTADA: la perdedora ya había leído el saldo y armado su INSERT cuando
-- chocó con el índice, y esa sentencia no deja filas. Es el mismo canje de la
-- 041 —perder trabajo invisible antes que pagar dos veces— sin el hueco de
-- consecutivo que allá sí existe. Se hace notar también en el código.
--
-- EL OTRO COSTO, el de la forma elegida: como la marca vive en la PRIMERA
-- porción, una repetición de una operación de VARIAS porciones reconoce la
-- operación por su fila de identidad, pero no puede enumerar sus hermanas (no
-- llevan marca, y atribuirlas sería adivinar). El monto de la repetición no
-- queda a medias: el acumulado del registro se relee y el saldo se recalcula.
-- En el cobro de factura la respuesta es el detalle completo de la factura
-- (`getInvoiceDetail`), así que ahí no se nota. Es el precio de no agregar una
-- columna de ordinal que sólo existiría para satisfacer el índice.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas: `ADD COLUMN IF NOT EXISTS` con NULL (sin
--     DEFAULT, así que no toca ninguna fila) y dos índices. No hay UPDATE de
--     datos, ni DELETE, ni TRUNCATE, ni backfill.
--   * No cambia el dinero: ni la aritmética, ni los topes (`trg_*_cap` de 007 y
--     031 quedan intactos), ni la resolución de métodos de pago. La columna no
--     entra en ninguna regla de negocio; sólo reconoce envíos repetidos.
--   * No toca las filas de `payments` (el espejo de caja de `registerPayment`):
--     esa es otra puerta, con su propio análisis, y no está en el alcance.
--   * No agrega índices redundantes: el índice único parcial ya sirve la
--     lectura por marca (el lookup del servicio).
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 042 va ANTES que este código. Sin las
-- columnas, los lookups por marca (`findPayrollPaymentsByIdempotencyKey` y
-- `findInvoicePaymentsByIdempotencyKey`) fallan y TODOS los pagos dan 500.
-- Misma regla que 005/034/041.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`,
-- `CREATE UNIQUE INDEX IF NOT EXISTS` y los CHECK con `DROP CONSTRAINT IF
-- EXISTS` + `ADD CONSTRAINT` (el patrón de 038/041) dejan el esquema idéntico en
-- cada corrida. Ninguna sentencia borra filas. El runner de Supabase aplica el
-- archivo en una transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La MARCA del intento de pago — nómina
-- ===================================================================== ---

-- NULL a propósito: las filas ya pagadas no tienen marca (la decisión del dueño
-- es hacia adelante) y la marca es opcional a nivel de esquema porque sólo el
-- camino de PAGO la exige. Sin DEFAULT, `ADD COLUMN` no reescribe la tabla y no
-- hay backfill que inventar.
ALTER TABLE public.payroll_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

COMMENT ON COLUMN public.payroll_payments.idempotency_key IS
  'CL-2: marca de idempotencia del intento de pago (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Vive SÓLO en la primera porción de la operación: las demás porciones quedan NULL. Reenviar la misma marca devuelve el pago ya registrado en vez de pagar otra vez. NULL en las filas anteriores a 042.';

-- ===================================================================== ---
-- 2. La MARCA del intento de cobro — factura
-- ===================================================================== ---

ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

COMMENT ON COLUMN public.invoice_payments.idempotency_key IS
  'CL-2: marca de idempotencia del intento de cobro dividido (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Vive SÓLO en la primera porción de la operación: las demás quedan NULL. Reenviar la misma marca devuelve la factura ya cobrada en vez de cobrar otra vez. NULL en las filas anteriores a 042 (incluidas las que escribe la caja, que no manda marca).';

-- ===================================================================== ---
-- 3. La guarda de forma: una marca es un uuid, no cualquier texto
-- ===================================================================== ---

-- El servicio valida el formato ANTES de escribir (`idempotencyKeySchema`, la
-- MISMA definición para las dos puertas: billing/schemas.ts), así que ningún
-- camino del usuario puede llegar a este CHECK: es la última red para un
-- escritor crudo (SQL, un servicio futuro) y prefiere rechazar la fila antes
-- que guardar una marca que el lookup nunca podría reconocer.
ALTER TABLE public.payroll_payments
  DROP CONSTRAINT IF EXISTS payroll_payments_idempotency_key_shape;
ALTER TABLE public.payroll_payments
  ADD CONSTRAINT payroll_payments_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

ALTER TABLE public.invoice_payments
  DROP CONSTRAINT IF EXISTS invoice_payments_idempotency_key_shape;
ALTER TABLE public.invoice_payments
  ADD CONSTRAINT invoice_payments_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ===================================================================== ---
-- 4. La barrera final: a lo sumo UNA operación por marca y registro
-- ===================================================================== ---

-- Parcial: la marca NULL (filas históricas y porciones hermanas) queda fuera
-- del índice, y una marca vacía tampoco deduplica nada. Es la barrera que
-- convierte la carrera lookup→INSERT en un 23505 que el servicio traduce en
-- "devuelve la operación existente".
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_payments_item_idempotency_key
  ON public.payroll_payments (payroll_item_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payments_invoice_idempotency_key
  ON public.invoice_payments (invoice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ===================================================================== ---
-- 5. Nota: qué NO protege este índice (para el que lea el tope de al lado)
-- ===================================================================== ---

-- El tope (`trg_payroll_payments_cap`, 007 / `trg_invoice_payments_cap`, 031)
-- y esta marca resuelven cosas DISTINTAS y las dos siguen haciendo falta:
--   * el tope impide que la SUMA de pagos de un registro pase de su neto, y no
--     ve las filas hermanas de un mismo INSERT multi-fila (mismo snapshot);
--   * la marca impide que la MISMA operación entre dos veces, y sí ve las filas
--     hermanas del mismo INSERT (Postgres comprueba cada fila al insertarla).
-- Ninguna reemplaza a la otra: un pago distinto por el saldo restante sigue
-- siendo un pago legítimo aunque su marca sea nueva, y una marca repetida sigue
-- siendo una repetición aunque su monto quepa en el saldo.
