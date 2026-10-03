-- 060_fix_invoice_create_guards.sql — CL-13: las redes de conteo de
-- `invoice_create_atomic` (052) vuelven a medir la ESCRITURA, no su propio
-- `SELECT ... INTO`.
--
-- MOTIVO DEL ARCHIVO (el defecto de 052, medido en PRUEBAS)
--
-- Una emisión real falló con:
--
--     PG invoice_create_atomic: {"code":"P0001","message":"ITEM_MISMATCH"}
--
-- En 052 las tres redes de conteo de los grupos 2 (líneas), 3 (impuestos) y 4
-- (porciones) quedaron ARMADAS AL REVÉS: el `SELECT jsonb_array_length(...) INTO
-- v_esperados;` se ejecuta DESPUÉS del `INSERT` y ANTES del `GET DIAGNOSTICS
-- v_escritos = ROW_COUNT;`. En PL/pgSQL un `SELECT ... INTO` pisa el estado de
-- `ROW_COUNT`, así que el `GET DIAGNOSTICS` posterior no mide las filas que
-- escribió el `INSERT` —que ya quedó atrás— sino la última sentencia, el propio
-- `SELECT ... INTO`: `v_escritos` queda en 1 SIEMPRE, sin importar cuántos
-- elementos trajo el arreglo.
--
-- CONSECUENCIA, que es el defecto: la emisión sólo funcionaba cuando cada grupo
-- tenía EXACTAMENTE un elemento. Con dos o más líneas —un caso de uso normal— la
-- comparación `v_escritos <> v_esperados` daba `1 <> N` y la transacción
-- abortaba con `ITEM_MISMATCH` (y con `TAX_MISMATCH` o `PAYMENT_MISMATCH` en los
-- otros dos grupos). El grupo 1 (la factura) no tiene el defecto: entre su
-- `INSERT ... RETURNING * INTO v_factura` y su `GET DIAGNOSTICS` no hay ninguna
-- sentencia que reescriba `ROW_COUNT`.
--
-- MECANISMO (re-emitir la función con el conteo ANTES del `INSERT`)
--
-- La corrección es de ORDEN, no de comportamiento: en cada uno de los tres
-- grupos el conteo de lo esperado se mueve ANTES de su `INSERT`, y el
-- `GET DIAGNOSTICS` queda inmediatamente DESPUÉS de la escritura. Así el
-- `ROW_COUNT` que se mide es el del `INSERT`, que es lo que la red de 052 siempre
-- quiso medir. Cada guarda corregida lleva el marcador
-- `-- fix-060: esperados ANTES del INSERT`, de modo que la función corregida se
-- distingue por TEXTO (lo usa `diagnostics/migraciones_faltantes.sql`).
--
-- POR QUÉ UNA MIGRACIÓN NUEVA Y NO EDITAR 052
--
-- PRUEBAS ya ejecutó 052, y una migración aplicada no se reescribe: la base no
-- vuelve a correr un archivo que ya corrió. La firma de `invoice_create_atomic`
-- NO cambia, así que `CREATE OR REPLACE FUNCTION` reemplaza la versión con el
-- defecto en vez de crear una sobrecarga, y aplicar SÓLO 060 repara el entorno
-- sin tocar nada más. El archivo es idempotente: volver a correrlo deja la misma
-- función.
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
  --
  -- 1.12 Red de seguridad: tantas líneas como elementos llegaron. Sin esta red,
  --      un subconjunto silencioso dejaría una factura con su total completo y
  --      sin todas sus líneas (y la nómina pagando comisiones de menos). El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_items) INTO v_esperados;

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

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  -- 1.13 GRUPO 3: el SNAPSHOT DE IMPUESTOS, UNA sentencia (y ninguna fila
  --      cuando no hay impuestos activos: `0 = 0` es legal). El monto y el
  --      porcentaje vienen computados.
  --
  -- 1.14 Red de seguridad: tantos impuestos como llegaron. El conteo va ANTES
  --      del INSERT: un `SELECT ... INTO` posterior pisaría el `ROW_COUNT` que
  --      mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_taxes) INTO v_esperados;

  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    v_factura.id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_taxes) AS item;

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
  --
  -- 1.16 Red de seguridad: tantas porciones como llegaron. El tope de cobro de
  --      031 (`trg_invoice_payments_cap`) corre dentro de esta sentencia con su
  --      propio P0001, y el servicio lo traduce a OVERPAID como siempre. El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_payments) INTO v_esperados;

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

-- ---------------------------------------- 5. Nota de esta migración ---
-- Las tres guardas corregidas se identifican con el marcador
-- `-- fix-060: esperados ANTES del INSERT`. `diagnostics/migraciones_faltantes.sql`
-- busca `%fix-060%` en `pg_get_functiondef` para saber si esta corrección está
-- aplicada en un entorno donde el nombre y la firma de 052 NO distinguen la
-- versión con el defecto de la corregida.
