-- =============================================================================
-- 001_orabella_schema.sql — EL ESQUEMA DE ORABELLA, EN UN SOLO ARCHIVO
-- =============================================================================
--
-- QUÉ ES ESTE ARCHIVO
--   El esquema completo de Orabella en el estado exacto en que quedó después de
--   aplicar el historial 001-077: 36 tablas, 28 funciones, 10 políticas RLS, 65
--   índices, 21 disparadores, 104 restricciones de tabla (34 PRIMARY KEY, 56
--   FOREIGN KEY, 13 UNIQUE y 1 EXCLUDE), 128 restricciones CHECK en línea y 139
--   comentarios, con RLS habilitado en las 36 tablas.
--
--   Sustituye a las 76 migraciones: se aplica una vez, de una sola pasada, y a
--   partir de ahí no hay más migraciones que mantener en sincronía.  Es un
--   VOLCADO de esquema (`--schema-only`), no una migración incremental: asume
--   el esquema vacío y por eso no lleva `IF NOT EXISTS` sobre las tablas ni
--   ningún `DROP`.
--
-- DE DÓNDE SALE
--   De `~/orabella-db/esquema-final.sql` (357.380 bytes, 8.100 líneas, UTF-8 sin
--   BOM), producido por:
--
--       pg_dump --schema-only --no-owner --exclude-schema=auth \
--               --file ~/orabella-db/esquema-final.sql
--
--   sobre la base descartable `orabella_build` del servidor de PRUEBAS, ya
--   sembrada con el historial 001-077.  Ese volcado es la FUENTE DE VERDAD:
--   este archivo se construye a partir de él y no se edita a mano.  Servidor
--   PostgreSQL 17.6; cliente pg_dump 18.3.
--
-- CÓMO SE REGENERA
--   1. Aplicar el historial `app/supabase/schema-history/*.sql` en orden sobre
--      una base limpia, con la fixture de plataforma
--      `app/supabase/squash/_platform_fixture.sql` antes de la 001.  Ese paso,
--      junto con la creación de la base y el volcado, es lo que automatiza
--      `.squash-build.py`.
--   2. Volcar con el comando de arriba, sin `--no-privileges`: los `REVOKE` y
--      `GRANT` de las funciones son parte del objeto y el inventario los exige.
--   3. Reconstruir ESTE archivo: este encabezado + el volcado entero, quitando
--      únicamente lo que se enumera más abajo en "LÍNEAS DESCARTADAS".  Nada
--      más se quita, nada se reordena y nada se escribe a mano.
--
-- CÓMO SE APLICA
--   psql -v ON_ERROR_STOP=1 --single-transaction -f 001_orabella_schema.sql
--
--   Con `--single-transaction` el archivo es todo o nada: o queda el esquema
--   completo, o no queda nada.  `ON_ERROR_STOP=1` es lo que hace que un error
--   corte en vez de seguir.  En el destino hace falta lo mismo, porque las
--   funciones de negocio llaman a `auth.jwt()` en tiempo de ejecución.
--
-- QUÉ NO CONTIENE, Y POR QUÉ
--   Ningún objeto de PLATAFORMA.  Este archivo describe lo que define Orabella,
--   no lo que el proyecto de destino ya trae, así que NO declara ningún objeto
--   de los que administra la plataforma: ni el esquema `auth` con su `jwt()`,
--   ni `storage`, ni `vault`, ni `extensions`, ni `graphql`, ni `realtime`, ni
--   `pgbouncer`, ni los roles internos que la plataforma crea sola.
--
--     - `auth` está excluido del volcado a propósito (`--exclude-schema=auth`).
--       El destino ya lo tiene con su definición real; declararlo aquí lo
--       duplicaría y fallaría al aplicarse.  Lo que sí sobrevive es la
--       REFERENCIA a `auth.jwt()` dentro del cuerpo de
--       `public.current_sede_id()`: un volcado captura texto, no comportamiento.
--     - `storage`, `vault`, `graphql`, `realtime` y `pgbouncer` no aparecen
--       porque el proyecto los administra la plataforma.  Recrearlos desde acá
--       sería pelearse con ella y dejarlos en un estado que Supabase no espera.
--     - `extensions` tampoco se declara.  Las dos extensiones que este esquema
--       necesita se piden con la forma `IF NOT EXISTS`, que es idempotente y no
--       ata el archivo a un esquema de destino; véase "EXTENSIONES" más abajo.
--
-- POR QUÉ EL HISTORIAL VIVE EN `app/supabase/schema-history/`
--   Porque este archivo no reemplaza al historial: lo resume.  Las 76
--   migraciones 001-077 (la 032 nunca existió) se movieron ahí con `git mv`,
--   con su historial de git intacto, por dos razones:
--
--     1. Explican el PORQUÉ de cada objeto.  El volcado captura el resultado,
--        no la razón.  Los `COMMENT ON` de negocio, el motivo de la 074 al
--        sacar `sede_id` de la exclusión, la 077 que lo elimina de `users`: todo
--        eso está en el historial, y nada de eso se puede reconstruir leyendo
--        un volcado.
--     2. Son el respaldo para regenerar.  Si el volcado se pierde o este
--        archivo se corrompe, se reaplica el historial y se vuelve a volcar.  Un
--        archivo único sin el historial debajo no se puede rehacer; el historial
--        sin el archivo único se puede volver a compactar.
--
--   En una base YA construida, el historial no se aplica: son pasos incrementales
--   que asumen el estado que dejó el anterior.  Para una base nueva, el archivo
--   único.  Para reconstruir el archivo único, el historial.
--
-- LÍNEAS DESCARTADAS DEL VOLCADO (y solo estas tres cosas)
--
--   1. Líneas 1 a 4 del volcado: el banner `--` / `-- PostgreSQL database
--      dump` / `--` y la línea vacía.  Lo que aportaban —de dónde sale y con qué
--      versiones— queda arriba, en "DE DÓNDE SALE", en español y con los datos
--      de este volcado.
--   2. Línea 5 del volcado: el metacomando `\restrict` de psql 18 con su clave
--      aleatoria de sesión.
--   3. Línea 8099 del volcado: el metacomando `\unrestrict` correspondiente.
--
--   2 y 3 no son SQL: es lo que psql 18 emite alrededor de un volcado para que
--   no interprete como metacomando lo que en realidad son literales.  Un archivo
--   de migración se aplica con otros clientes y con versiones anteriores de
--   `psql`, que no conocen esos metacomandoS; si se dejaran, el metacomando
--   desconocido abortaría la carga.  La clave que los acompaña es un token
--   aleatorio por sesión, no información del esquema.
--
--   TODO LO DEMÁS SE CONSERVA LITERAL, en particular:
--
--     - Los comentarios `-- Name: <objeto>; Type: ...`, que son los marcadores
--       de sección del volcado y mapean una a una las tablas, funciones,
--       índices, políticas y disparadores.  Se dejan: sin ellos el archivo se
--       sigue aplicando igual, pero se pierde la trazabilidad objeto-origen.
--     - El preámbulo `SET` completo, líneas 10 a 20 del volcado:
--       `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`,
--       `transaction_timeout`, `client_encoding`, `standard_conforming_strings`,
--       `set_config('search_path', '', false)`, `check_function_bodies`,
--       `xmloption`, `client_min_messages` y `row_security`.  Los timeouts en 0
--       son lo que permite que la creación de las 36 tablas y los 65 índices no
--       se corte a mitad; `row_security = off` es lo que permite leer el
--       catálogo sin que las políticas filtren el volcado;
--       `check_function_bodies = false` es lo que permite que los cuerpos
--       plpgsql que llaman a `auth.jwt()` compilen sin que exista el esquema
--       `auth`.
--     - `SELECT pg_catalog.set_config('search_path', '', false)`: se conserva.
--       Véase "EL SEARCH_PATH VACÍO" más abajo.
--     - Los comentarios de versión del cliente, líneas 7 y 8 del volcado.
--
-- EXTENSIONES: `btree_gist` Y `pgcrypto`
--   El volcado las pide con la forma `IF NOT EXISTS <ext> WITH SCHEMA public`, tal
--   cual, sin cambiar una palabra.  Comprobado contra un entorno
--   que imita a Supabase —esquema `extensions` con las dos extensiones ya
--   instaladas, que es donde las pone la plataforma—: las dos órdenes NO chocan
--   con nada.  PostgreSQL responde `NOTICE: extension "btree_gist" already
--   exists, skipping` (idem `pgcrypto`), no da error y no mueve la extensión de
--   esquema.  `IF NOT EXISTS` resuelve por el NOMBRE de la extensión, no por el
--   esquema: la cláusula `WITH SCHEMA` solo se mira en el momento de crearla, y
--   para eso hace falta que la extensión todavía no exista.
--
--   La cláusula queda como está porque es la que describe cómo se construyó el
--   volcado, y porque `public` es un destino válido si algún día hace falta
--   instalar de verdad.  Si algún día se quisiera atar el archivo al esquema
--   `extensions` de la plataforma, la cláusula a cambiar sería `WITH SCHEMA
--   public` por `WITH SCHEMA extensions`, y SOLO en ese caso: con las extensiones
--   ya instaladas —el caso real de un proyecto Supabase— ninguna de las dos
--   formas produce diferencia.
--
--   Y nada del esquema depende de dónde vivan: la única función de extensión
--   que el archivo llama sin calificar es `gen_random_uuid()`, que desde
--   PostgreSQL 13 vive en `pg_catalog` y no en `pgcrypto`.  El esquema de
--   instalación importaría para el `search_path` de las 27 funciones que lo fijan
--   a `public`, y ninguna de ellas llama a `digest()`, `crypt()` ni a otra
--   función de `pgcrypto`.
--
-- EL `search_path` VACÍO: POR QUÉ NO ES UN RIESGO AQUÍ
--   El volcado deja el `search_path` vacío a propósito, y esa línea se conserva.
--   Con el `search_path` vacío todo nombre sin calificar falla, y por eso cada
--   objeto del volcado va escrito con su esquema (`public.`).  Es lo que permite
--   que el archivo sea reproducible sin depender del `search_path` que tenga la
--   sesión que lo aplica.
--
--   El punto delicado es la exclusión `ex_payroll_periods_no_overlap`, que
--   compara texto con GiST y depende del operator class que aporta `btree_gist`.
--   Está comprobado, no supuesto:
--
--     - El operador `=` de un índice o de una exclusión NO depende del
--       `search_path`: es un operador binario de `pg_catalog` y se resuelve
--       siempre.  Comprobado: con el `search_path` vacío, `SELECT 'a' = 'a'`
--       funciona, mientras que un operador de fuera de `pg_catalog` escrito sin
--       calificar da `operator does not exist`.
--     - El operator class NO se busca por nombre, sino como el OPERATOR CLASS
--       POR DEFECTO del par (método, tipo), y esa búsqueda del catálogo no filtra
--       por esquema.  Comprobado: con `btree_gist` instalada en `extensions`, el
--       `search_path` vacío resuelve igual `extensions.gist_text_ops` para el
--       elemento de texto y `pg_catalog.range_ops` para el `daterange`, y la
--       exclusión se crea sin error.
--     - Lo que SÍ depende del `search_path` es nombrar el operator class de
--       forma explícita —`... USING gist (frequency gist_text_ops)`, que con el
--       `search_path` vacío falla con `operator class "gist_text_ops" does not
--       exist`—.  El volcado nunca lo hace: usa el operator class por defecto.
--       Ese es el único escenario en el que la ubicación de `btree_gist`
--       importaría, y este archivo no lo tiene.
--
--   Conclusión: el `search_path` vacío se queda.  Fijar uno explícito al
--   principio del archivo (`public, extensions`) no hace falta y sí haría daño:
--   habilitaría resolución implícita justo donde el volcado no la quiere, y
--   ataría el archivo a un esquema de plataforma que puede no existir.
--
-- =============================================================================
-- Cuerpo del volcado, literal, desde la línea 7 del original.
-- =============================================================================
-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: cash_close_shift_atomic(uuid, uuid, timestamp with time zone, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_shift_id IS NULL
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
  --     DESPLIEGUE" de 059): aceptar dos sería aceptar firmar sin comprobar las
  --     salidas.
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
  --     nueva y rechaza.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
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
  --     dinero. Las variables son `bigint` porque es el tipo que `count(*)`
  --     devuelve: no hay ninguna conversión estrecha entre el conteo y lo que se
  --     compara (la guarda de forma de 1.1 ya limitó el token a nueve dígitos).
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
  --     cuando venía vacía). El CHECK de 006 (`expected_cash >= 0`) NO se
  --     replica acá a propósito: es la regla de negocio que el servicio traduce a
  --     CASH_OUT_EXCEEDS_COLLECTED, y este archivo no la reemplaza ni la adelanta.
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
     AND s.status = 'abierto'
  RETURNING * INTO v_turno;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y el
  --     llamador recibe el MISMO error de negocio que ya recibía cuando perdía
  --     el compare-and-swap en el cliente.
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
$_$;


--
-- Name: FUNCTION cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb) IS 'CL-10/CL-19/CL-20: cierre ATÓMICA de un turno de caja (CAJ-03/CAJ-04) con PRECONDICIÓN sobre las CUATRO entradas del arqueo. Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. CL-19 agregó p_collection_counts: los CONTEO de filas de las DOS fuentes que el arqueo SUMA (payments del turno sin factura e invoice_payments atribuidas al turno). CL-20 extiende el MISMO token con los CONTEO de las DOS fuentes que el arqueo RESTA (commission_payouts del turno y voucher_requests del turno aprobados y con método): una comisión pagada o la aprobación de un vale confirmadas entre la lectura del servicio y este lock ya no quedan fuera de un arqueo firmado. La transacción RE-CUENTA las cuatro fuentes bajo el lock y, si alguna difiere, RECHAZA con ARQUEO_STALE sin escribir nada. El token es OBLIGATORIO —las CUATRO claves se exigen por forma; su ausencia es SHIFT_INVALID, nunca "no compares"— y son CONTEO, no sumas: acá no se suma ni se resta un solo monto, porque mover aritmética de dinero a SQL está prohibido en este proyecto. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y el turno que devuelve ya no la nombra (077). Sólo service_role puede ejecutarla.';


--
-- Name: cash_invoice_payment_atomic(uuid, uuid, uuid, timestamp with time zone, boolean, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_shift_id IS NULL
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
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila —así un cierre que llegó primero hace que esta lectura
  --     espere y después vea `cerrado`, y un cierre que llega después espera a
  --     este cobro— y NO compite con otro cobro del mismo turno (dos cajas
  --     cobrando facturas distintas en el mismo turno no se serializan entre sí).
  --     `FOR KEY SHARE` no serviría: es exactamente el lock que la FK toma hoy y
  --     el que NO excluye al cierre.
  --
  --     El estado se mira DESPUÉS del lock y sobre LA FILA (no sobre el dato que
  --     mandó el llamador): es la precondición que el servicio ya revisó, releída
  --     donde es verdadera. De ESTA fila salía además la sede del libro de cajón.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
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
  --     —el tope de 031 toma ESTE MISMO lock— o una anulación (050) esperan.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
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
  --     servicio resolvió y el usuario que cobró —el único rastro de quién cobró
  --     (PRD §9.1)—. `idempotency_key` se escribe NULL A PROPÓSITO (043): la
  --     identidad de este camino vive en la fila espejo, y marcar las dos
  --     mezclaría en un mismo índice las marcas de dos caminos distintos.
  --     `created_at` no se toca: lo pone el DEFAULT de 006.
  INSERT INTO public.payments
    (cash_shift_id, invoice_id, method_id, method_code, amount, user_id,
     idempotency_key)
  VALUES
    (p_shift_id,
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
  --     factura se CIERRA (`p_mark_paid`) —Gap 1 de 056—: el responsable es el
  --     usuario que cobra (`p_user_id`) y el instante es el que resolvió el
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
$_$;


--
-- Name: FUNCTION cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb) IS 'CL-17: cobro de factura desde CAJA, ATÓMICO (CAJ-02), con el TURNO bloqueado y con los datos de cierre. Escribe las TRES cosas del cobro —la fila espejo de invoice_payments (el dinero que suma el arqueo, con el turno que COBRA y la marca del intento de 042), la fila del libro de cajón payments (sin marca, 043) y el estado de la factura— en UNA sentencia, y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request. NO calcula nada: el bruto redondeado (roundMoney), el reparto del recargo (splitGrossCardFee), el saldo (invoiceNetBalance), la cota del tope de 031, la decisión Pagada (moneyEquals), el enlace al turno y el instante del cierre (p_closed_at, resuelto por el servicio como en 049 y 050) llegan computados por el servicio, y la función escribe cada columna verbatim, sin sumar, restar, multiplicar ni redondear un solo monto y sin comparar el cobrado contra el facturado ni una vez. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir su fila de dinero en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. La fila del libro de cajón ya no lleva columna de sede: la instalación es de una sola sede (071) y el turno bloqueado era la fila que la definía (077). Revalida también la precondición de la factura sobre su fila bloqueada (Anulada → ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE (P0001 y 23505). Sus tres redes de conteo —una por grupo de escritura— abortan con PAYMENT_MISMATCH si no escribió exactamente lo recibido, y en ese caso la transacción se revierte ENTERA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus filas de dinero, y el reintento sigue siendo posible. CIERRA la factura con sus datos: cuando el servicio lo decidió (p_mark_paid), escribe status = Pagada y ADEMÁS closed_by (el usuario que cobra) y closed_at (el instante que resolvió el servicio), que era el hueco de CL-17: una factura Pagada con closed_at NULL contradecía el contrato de 025 y dejaba la columna Cerrada del listado en guion sobre una factura cerrada. La marca del intento es OBLIGATORIA (este camino escribe una sola fila en invoice_payments y esa fila es la operación). Devuelve la fila del libro de cajón escrita (columnas de PAYMENT_SELECT) y el estado que quedó la factura. Sólo service_role puede ejecutarla.';


--
-- Name: cash_open_shift_atomic(uuid, uuid, numeric, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_turno public.cash_shifts;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que abre un turno de caja no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de una apertura interpretada. La base no
  --     puede ser negativa, pero SÍ puede ser cero (una caja que abre sin
  --     fondo es un caso legal).
  IF p_register_id IS NULL
     OR p_opened_by IS NULL
     OR p_opening_base IS NULL
     OR p_opening_base < 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo. El `coalesce` es la parte que importa: con la
  --     clave AUSENTE, `item ->> 'amount'` es NULL y `NULL !~ 'regex'` es NULL
  --     —no TRUE—, así que sin el coalesce una línea sin monto pasaría esta
  --     guarda y sería el `NOT NULL` de la columna el que hablara, con un error
  --     de la base en vez de un rechazo del contrato. Es la misma trampa que 046
  --     documenta para `qty`, 047 para `net_pay` y 048 para sus montos.
  --
  --     La estructura que la tabla ya exige (009) también se comprueba acá, por
  --     FORMA y no por aritmética: una línea de EFECTIVO lleva denominación y
  --     cualquier cantidad; una línea DIGITAL no lleva denominación y declara su
  --     total con cantidad 1. El `CASE` garantiza que cada conversión a
  --     `numeric`/`integer` sólo se evalúe cuando el texto YA validó su forma
  --     (SQL no promete el orden de las condiciones del OR).
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
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

  -- 1.2 La CAJA, bloqueada: es el punto de serialización de todo el ciclo de
  --     caja. A partir de acá, otra apertura, otro cierre u otro reconteo de la
  --     MISMA caja espera; y si la caja no existe, la transacción rechaza en
  --     vez de abrir un turno de una caja que no está. El `PERFORM` con el mismo
  --     `FOR UPDATE` conserva el lock y el `NOT FOUND` conserva el error de
  --     negocio: lo único que se fue es la columna que la fila ya no declara.
  PERFORM 1
    FROM public.cash_registers r
   WHERE r.id = p_register_id
   FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_REGISTER_NOT_FOUND';
  END IF;

  -- 1.3 El guardia de "un turno abierto por caja" (CAJ-01), re-evaluado adentro
  --     con la caja YA bloqueada. Es la misma regla que `assertNoOpenShift`
  --     aplica en el servicio; el índice único parcial de 006
  --     (`uq_cash_shifts_open_per_register`) sigue siendo la barrera final si
  --     dos aperturas llegaran a evaluar esto a la vez, y el `23505` que
  --     levanta lo traduce el servicio al MISMO error de negocio.
  PERFORM 1
    FROM public.cash_shifts s
   WHERE s.cash_register_id = p_register_id
     AND s.status = 'abierto'
   ORDER BY s.id
   FOR UPDATE OF s;

  IF FOUND THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_OPEN';
  END IF;

  -- 1.4 El TURNO: UNA sentencia, y por eso UNA transacción con su arqueo de
  --     abajo. El turno nace `abierto`, con la base que el servicio resolvió
  --     —escrita verbatim— y con `expected_cash` en 0, como nacía antes: el
  --     esperado de un turno recién abierto todavía no tiene cobros.
  INSERT INTO public.cash_shifts
    (cash_register_id, opened_by, opening_base, expected_cash, status)
  VALUES
    (p_register_id, p_opened_by, p_opening_base, 0, 'abierto')
  RETURNING * INTO v_turno;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 1.5 El ARQUEO DE APERTURA: las líneas por método y denominación, con la
  --     fase que le corresponde, el turno recién creado y cada monto ESCRITO
  --     VERBATIM desde `p_counts` —acá no se multiplica denominación por
  --     cantidad ni se suma nada—. `ORDER BY` deja el orden determinista (ver
  --     "SERIALIZACIÓN" de 049).
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    v_turno.id,
    'apertura',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     líneas de las recibidas, se aborta y se revierte TODO, el turno
  --     incluido. Sin esta red, un arreglo que escribiera un subconjunto
  --     dejaría un turno ABIERTO sin su arqueo: exactamente el estado parcial
  --     que 049 cierra.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, con las MISMAS columnas que el servicio leía: eso es
  --     lo que el llamador usa como resultado, sin otra lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
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
$_$;


--
-- Name: FUNCTION cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb) IS 'CL-10: apertura ATÓMICA de un turno de caja (CAJ-01). Inserta el turno ABIERTO y su conteo de apertura en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la caja bloqueada primero para que el guardia de "un turno abierto por caja" (índice único parcial de 006) no pueda volverse mentira entre la lectura y la escritura. El turno no lleva columna de sede: la instalación es de una sola sede (071) y la caja era la fila que la definía, así que el lock de esa caja es lo que serializa la apertura (077). NO calcula nada: la base del turno llega resuelta por resolveOpeningBase y cada línea del conteo llega validada por checkCounts; la función las escribe verbatim. Un fallo de la escritura del turno o del arqueo —y su red de conteo, que aborta si no escribió exactamente las líneas recibidas— revierte la transacción COMPLETA: no queda un turno abierto sin su arqueo de apertura. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT; falla con SHIFT_INVALID (entrada mal formada), SHIFT_REGISTER_NOT_FOUND (la caja no existe), SHIFT_ALREADY_OPEN (la carrera del turno abierto, 23505), SHIFT_WRITE_MISMATCH o SHIFT_COUNT_MISMATCH. Sólo service_role puede ejecutarla.';


--
-- Name: cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_turno public.cash_shifts;
  v_reconteo public.cash_shift_recounts;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 9.1 FORMA de la entrada. Un reconteo firma una versión CORREGIDA de un
  --     cierre ya firmado: no puede aceptar una entrada a medio formar.
  IF p_shift_id IS NULL
     OR p_recounted_by IS NULL
     OR p_recount IS NULL
     OR jsonb_typeof(p_recount) <> 'object'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las DOS VERSIONES: los cuatro montos del cierre firmado (congelados) y
  --     los cuatro del reconteo, más el motivo. Las claves ausentes se rechazan
  --     por el mismo `coalesce` de las otras dos funciones. Las dos
  --     `*_base_difference` (un faltante de base) y los dos `*_cash_withdrawn`
  --     (una diferencia entre lo contado y la base dejada) admiten el signo: la
  --     tabla no les exige ser no negativos y el reconteo existe justamente para
  --     corregir un cierre, así que no puede rechazar la versión que va a
  --     corregir. `*_counted_cash` y `*_base_left` no lo admiten: el CHECK de
  --     006 los exige no negativos y su copia congelada también lo es.
  IF btrim(coalesce(p_recount ->> 'reason', '')) = ''
     OR coalesce(p_recount ->> 'previous_counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo nuevo: la misma guarda de forma del cierre (ver
  --     5.1 de 049). El conteo del reconteo tiene que ser COMPLETO, como el del
  --     cierre: la transacción no acepta un arreglo vacío, así que el reconteo no
  --     puede quedar firmado sin el detalle que lo respalda.
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

  --     El conteo tiene que traer el EFECTIVO: un reconteo sin efectivo no es un
  --     reconteo de la caja (y el total declarado no tendría contra qué
  --     cuadrar). Es la parte estructural de la exigencia de conteo completo; la
  --     igualdad entre el total y su detalle la comprueba el servicio antes de
  --     llamar (ver "VENTANAS DECLARADAS" de 049).
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    WHERE item ->> 'method_code' = 'efectivo'
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 9.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA: sólo
  --     un turno CERRADO se recontá —un turno abierto no tiene cierre que
  --     corregir—.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'cerrado' THEN
    RAISE EXCEPTION 'SHIFT_NOT_CLOSED';
  END IF;

  -- 9.3 El reconteo "uno por turno" (033), re-evaluado adentro con el turno YA
  --     bloqueado. El índice único `uq_cash_shift_recounts_shift` sigue siendo la
  --     barrera final si dos reconteos llegaran a evaluar esto a la vez, y el
  --     `23505` que levanta lo traduce el servicio al MISMO error de negocio
  --     (ALREADY_RECOUNTED). Un reconteo no se encadena: la corrección también
  --     queda firmada.
  PERFORM 1
    FROM public.cash_shift_recounts r
   WHERE r.shift_id = p_shift_id
   ORDER BY r.id
   FOR UPDATE OF r;

  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_RECOUNTED';
  END IF;

  -- 9.4 El RECONTEO: UNA sentencia, y por eso UNA transacción con su detalle de
  --     abajo. Las DOS versiones entran VERBATIM desde `p_recount` —la anterior
  --     congelada y la corregida, con el motivo—, y `recounted_at` queda para su
  --     DEFAULT. Acá no se suma, no se resta y no se recalcula nada: la versión
  --     corregida llega resuelta por `resolveClosingBase` y `computeCashClose`
  --     dentro de `buildRecountRecord` (TypeScript).
  INSERT INTO public.cash_shift_recounts
    (shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn,
     previous_base_difference, counted_cash, base_left, cash_withdrawn,
     base_difference, reason, recounted_by)
  VALUES (
    p_shift_id,
    (p_recount ->> 'previous_counted_cash')::numeric,
    (p_recount ->> 'previous_base_left')::numeric,
    (p_recount ->> 'previous_cash_withdrawn')::numeric,
    (p_recount ->> 'previous_base_difference')::numeric,
    (p_recount ->> 'counted_cash')::numeric,
    (p_recount ->> 'base_left')::numeric,
    (p_recount ->> 'cash_withdrawn')::numeric,
    (p_recount ->> 'base_difference')::numeric,
    p_recount ->> 'reason',
    p_recounted_by
  )
  RETURNING * INTO v_reconteo;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 9.5 El DETALLE por denominación, en la MISMA tabla del arqueo (009), en la
  --     fase `reconteo` (033). Es lo que hace que la versión corregida tenga
  --     tanta evidencia como el cierre que corrige: sin estas líneas, el
  --     reconteo firmaría dos versiones que ningún conteo respalda.
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    p_shift_id,
    'reconteo',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 9.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el reconteo incluido. Es lo que separa "el
  --     reconteo no se pudo firmar" de "el reconteo quedó firmado sin su
  --     detalle" —y este último, con el índice único de 033, ya no se podría
  --     volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 9.7 El reconteo ESCRITO, tal como quedó en la tabla (con su `id` y su
  --     `recounted_at` del DEFAULT), con las mismas columnas que el servicio
  --     leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_reconteo.id,
    'shift_id', v_reconteo.shift_id,
    'previous_counted_cash', v_reconteo.previous_counted_cash,
    'previous_base_left', v_reconteo.previous_base_left,
    'previous_cash_withdrawn', v_reconteo.previous_cash_withdrawn,
    'previous_base_difference', v_reconteo.previous_base_difference,
    'counted_cash', v_reconteo.counted_cash,
    'base_left', v_reconteo.base_left,
    'cash_withdrawn', v_reconteo.cash_withdrawn,
    'base_difference', v_reconteo.base_difference,
    'reason', v_reconteo.reason,
    'recounted_by', v_reconteo.recounted_by,
    'recounted_at', v_reconteo.recounted_at
  );
END;
$_$;


--
-- Name: FUNCTION cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb) IS 'CL-10: reconteo ATÓMICO de un cierre (U3, 033). Inserta la fila de cash_shift_recounts —las DOS versiones, el motivo y quién— y su detalle por denominación en cash_shift_counts (fase reconteo) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: la versión anterior congelada y la corregida llegan resueltas por buildRecountRecord (resolveClosingBase + computeCashClose + signedAmounts) y se escriben verbatim; la aritmética del arqueo vive en TypeScript. Conserva las precondiciones del servicio: sólo un turno CERRADO (SHIFT_NOT_CLOSED) y el índice único por turno de 033 (23505 → ALREADY_RECOUNTED) adentro de la transacción; el conteo tiene que traer el efectivo y no puede venir vacío. NO toca cash_shifts: el cierre firmado sigue siendo inmutable. Sus redes de conteo abortan con SHIFT_WRITE_MISMATCH si no escribió exactamente un reconteo y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un reconteo firmado sin su detalle. Devuelve el reconteo escrito con las mismas columnas de RECOUNT_SELECT. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';


--
-- Name: change_user_password(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_filas integer;
  v_revocadas integer;
  v_actual text;
BEGIN
  -- 2.1 FORMA de la entrada.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_INVALID';
  END IF;
  --     La PRECONDICIÓN es obligatoria: sin ella no hay CAS posible. Si el
  --     llamador no manda la base, se rechaza con el error de forma —jamás se
  --     interpreta la ausencia como "no compares"—, que es lo que impide que
  --     una firma mal llamada degrade al comportamiento sin CAS.
  IF p_expected_password_hash IS NULL OR btrim(p_expected_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_INVALID';
  END IF;

  -- 2.2 El CANDADO de la fila del usuario, el mismo de 039/040 y de 054, y la
  --     LECTURA del hash bajo ese candado: `adminResetUserPassword` (UPDATE sin
  --     `FOR UPDATE`) y cualquier otro escritor quedan serializados contra esta
  --     transacción. La comprobación de existencia viaja en la misma sentencia.
  SELECT u.password_hash
    INTO v_actual
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 2.3 El CAS. Si otro escritor legítimo (un admin restableciendo, una
  --     recuperación confirmada) escribió entre la lectura del llamador y este
  --     punto, el hash de la fila no es el que autorizó el cambio: la prueba de
  --     credencial dejó de ser válida y la operación NO ESCRIBE NADA. El código
  --     propio deja de confundir esta carrera con un fallo interno.
  IF v_actual IS DISTINCT FROM p_expected_password_hash THEN
    RAISE EXCEPTION 'PASSWORD_CHANGED_ELSEWHERE';
  END IF;

  -- 2.4 La CLAVE. La comparación vive además en el `WHERE` —el CAS literal— y
  --     su red de conteo: bajo el candado no puede fallar, pero un `UPDATE` que
  --     no matchea ninguna fila no es un error para PostgreSQL, y este archivo
  --     no confirma nada que no haya podido verificar.
  UPDATE public.users
  SET password_hash = p_password_hash,
      must_change_password = false,
      failed_attempts = 0,
      locked_until = null
  WHERE id = p_user_id
    AND password_hash = p_expected_password_hash;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'PASSWORD_CHANGED_ELSEWHERE';
  END IF;

  -- 2.5 Las OTRAS sesiones, en la MISMA transacción que la clave (idéntico a
  --     054). El `OR` explícito evita la trampa de `token_hash <> NULL` (que da
  --     NULL, no TRUE): sin él, "revocá todas" no revocaría ninguna.
  UPDATE public.sessions
  SET revoked = true
  WHERE user_id = p_user_id
    AND revoked = false
    AND (p_current_token_hash IS NULL OR token_hash <> p_current_token_hash);

  GET DIAGNOSTICS v_revocadas = ROW_COUNT;

  -- 2.6 POST-CONDICIÓN, idéntica a 054: no puede quedar NINGUNA otra sesión
  --     viva. Si algo quedó, la transacción ENTERA se revierte —y con ella el
  --     CAS y la clave nueva—.
  IF EXISTS (
    SELECT 1
    FROM public.sessions s
    WHERE s.user_id = p_user_id
      AND s.revoked = false
      AND (p_current_token_hash IS NULL OR s.token_hash <> p_current_token_hash)
  ) THEN
    RAISE EXCEPTION 'SESSIONS_NOT_REVOKED';
  END IF;

  RETURN v_revocadas;
END;
$$;


--
-- Name: FUNCTION change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text) IS 'CL-18 (sobre CL-15): cambio de clave propio con CAS declarado. Además de lo de 054 —hash nuevo + revocación de las DEMÁS sesiones en una sola transacción, lock FOR UPDATE de la fila del usuario y post-condición "ninguna otra sesión viva" (''SESSIONS_NOT_REVOKED'')—, exige que el hash contra el que el llamador verificó la clave ACTUAL siga siendo el de la fila: si otro escritor legítimo (un admin restableciendo, una recuperación confirmada) escribió en el medio, aborta con ''PASSWORD_CHANGED_ELSEWHERE'' SIN escribir nada, en vez de pisar la escritura ajena en silencio. La precondición es obligatoria: ''PASSWORD_INVALID'' si falta. La verificación de la clave actual sigue en el servicio (tiempo constante); la función recibe sólo hashes ya calculados y nunca ve una clave en claro. Devuelve cuántas sesiones revocó. Sólo service_role puede ejecutarla.';


--
-- Name: check_commission_payouts_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_commission_payouts_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_invoice_id uuid;
  v_earned numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  -- Lock de la factura: serializa dos pagos concurrentes del mismo par.
  -- Misma forma que `check_invoice_payments_cap` (031), donde la fila padre
  -- es también la que se bloquea.
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id;
  END IF;

  v_earned := NEW.earned_immediate;

  -- Sin el ganado que entrega la aplicación no hay tope posible. Es mejor
  -- rechazar la fila que dejar pasar un pago sin comparación: la aplicación
  -- siempre lo entrega, así que una fila sin él es una escritura que no pasó
  -- por el servicio.
  IF v_earned IS NULL THEN
    RAISE EXCEPTION
      'El pago inmediato no trae el ganado de la comisión (earned_immediate): sin ese valor la base no puede aplicar el tope';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.commission_payouts
  WHERE invoice_id = NEW.invoice_id
    AND employee_id = NEW.employee_id;

  -- Tolerancia de centavo (0,009), la misma del servicio: el tope es acumulado
  -- y una porción igual al pendiente entra exacta.
  IF v_paid + coalesce(NEW.amount, 0) - v_earned > 0.009 THEN
    RAISE EXCEPTION
      'El pago supera la comisión ganada del par (factura %, empleado %): ganado %, pagado %, nuevo %',
      NEW.invoice_id, NEW.employee_id, v_earned, v_paid, NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION check_commission_payouts_cap(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_commission_payouts_cap() IS 'U9 (034): la suma de `commission_payouts` por (factura, empleado) nunca excede el ganado inmediato que la aplicación entrega en `earned_immediate`, con la tolerancia de centavo del servicio (0,009). Barrera en BD ante carreras; el servicio sigue validando el pendiente exacto. El trigger NO recalcula la comisión: compara un número que la app entrega contra la suma de lo pagado — la misma división que `payroll_items.net_pay` (servicio) + `trg_payroll_payments_cap` (base). RAISE EXCEPTION plano = P0001, que el servicio traduce a COMMISSION_OVERPAID. Los pagos PARCIALES siguen siendo legales: el tope es acumulado, no una fila única.';


--
-- Name: check_invoice_payments_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_invoice_payments_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_total numeric(12, 2);
  v_surcharge numeric(12, 2);
  v_paid_net numeric(12, 2);
  v_new_net numeric(12, 2);
BEGIN
  -- Lock de la factura: serializa dos cobros concurrentes de la misma factura.
  SELECT total, surcharge INTO v_total, v_surcharge
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id;
  END IF;

  v_new_net := coalesce(NEW.amount, 0) - coalesce(NEW.fee_amount, 0);

  SELECT coalesce(sum(amount - fee_amount), 0) INTO v_paid_net
  FROM public.invoice_payments
  WHERE invoice_id = NEW.invoice_id;

  -- Tope = NETO FACTURADO COBRABLE, en la unidad del cobro (peso entero):
  -- `round(total − surcharge)` — el recargo emitido ya viene sumado en el
  -- bruto de cada fila y no es saldo cobrable; y el datafono no acepta
  -- centavos, así que el monto cobrable es el neto redondeado a peso entero
  -- (misma regla que `invoiceNetBalance`, billing/service.ts). Sin el
  -- `round()`, una factura legacy con centavos rechaza su liquidación
  -- legítima: neto 9999,99 y el cliente entregó 10000 en el terminal; ese
  -- cobro exacto queda 0,01 por encima del tope y ninguna otra porción entera
  -- cuadra (9999 queda 0,99 corta), así que la factura queda impagable. La
  -- diferencia es de a lo sumo un peso y la corrección de datos de centavos
  -- históricos la elimina. Misma tolerancia de centavo que nómina (0.009).
  IF v_paid_net + v_new_net - round(v_total - coalesce(v_surcharge, 0)) > 0.009 THEN
    RAISE EXCEPTION
      'El cobro supera el neto facturado de la factura (total %, recargo %, cobrado neto %, nuevo neto %)',
      v_total, coalesce(v_surcharge, 0), v_paid_net, v_new_net;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION check_invoice_payments_cap(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_invoice_payments_cap() IS 'T0-a (C2): la suma NETA de invoice_payments por factura nunca excede el neto facturado COBRABLE (round(invoices.total − invoices.surcharge), peso entero: el datafono no acepta centavos). El recargo emitido ya viene sumado en el bruto de cada fila, así que comparar contra total dejaba un hueco del tamaño del recargo; y sin el round() una factura legacy con centavos rechazaba su liquidación legítima en pesos enteros. Barrera en BD ante carreras; el servicio valida el cobro exacto. RAISE EXCEPTION plano = P0001 (el servicio lo traduce a OVERPAID).';


--
-- Name: check_payroll_payments_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_payroll_payments_cap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_net numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  -- Lock de la fila PADRE (el ítem, dueño del neto): serializa dos pagos
  -- concurrentes del mismo ítem. Es el mismo idioma que 031 y 034, donde la
  -- fila bloqueada es también la que tiene el tope (allá `invoices`). Va ANTES
  -- del SUM a propósito: es lo que hace que el SUM corra después del commit
  -- rival y vea su fila.
  SELECT net_pay INTO v_net
  FROM public.payroll_items
  WHERE id = NEW.payroll_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem de nómina inexistente (%)', NEW.payroll_item_id;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.payroll_payments
  WHERE payroll_item_id = NEW.payroll_item_id;

  IF v_paid + NEW.amount - v_net > 0.009 THEN
    RAISE EXCEPTION 'El pago supera el neto del ítem (neto %, pagado %, nuevo %)', v_net, v_paid, NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION check_payroll_payments_cap(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_payroll_payments_cap() IS 'CL-16: la suma de payroll_payments por ítem nunca excede payroll_items.net_pay (tolerancia de centavo 0,009). A diferencia de la 007, BLOQUEA la fila del padre (`payroll_items`) con FOR UPDATE antes de leer el acumulado: sin el lock, dos INSERT concurrentes del mismo ítem leían la misma suma, no veían la fila rival y los dos entraban —el ítem pagado dos veces—. El lock ordena la lectura del acumulado después del commit rival, y con READ COMMITTED el SUM ve la fila ya confirmada. RAISE EXCEPTION plano = SQLSTATE P0001, el que payroll/service.ts traduce a OVERPAID (422). No crea, reemplaza ni borra filas: sólo reescribe el cuerpo de la función, así que el trigger trg_payroll_payments_cap (007) conserva su vínculo por OID.';


--
-- Name: confirm_password_reset(text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_reset_id uuid;
  v_user_id uuid;
  v_expira timestamptz;
  v_usado boolean;
  v_filas integer;
BEGIN
  -- 1.1 FORMA de la entrada. El token llega como HASH (jamás en claro) y la
  --     clave como hash ya calculado: sin los dos no hay nada que confirmar y
  --     el rechazo es el mismo que el de un token inválido —no se filtra si el
  --     problema fue el token o la clave—.
  IF p_token_hash IS NULL OR btrim(p_token_hash) = ''
     OR p_password_hash IS NULL OR btrim(p_password_hash) = ''
     OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.2 El TOKEN, bajo candado. `password_resets.token_hash` es UNIQUE
  --     (002_auth.sql), así que esta lectura no puede traer dos filas; el
  --     `FOR UPDATE` es el que serializa dos confirmaciones del MISMO token:
  --     la segunda espera acá y, cuando entra, lo encuentra usado.
  SELECT pr.id, pr.user_id, pr.expires_at, pr.used
    INTO v_reset_id, v_user_id, v_expira, v_usado
  FROM public.password_resets pr
  WHERE pr.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.3 USABILIDAD adentro, sobre la fila ya bloqueada. El servicio comprobó lo
  --     mismo antes de llamar (es lo que da el 400 rápido), pero acá es donde
  --     la comprobación no puede volverse mentira: entre la lectura del
  --     llamador y esta sentencia, otro puede haber usado el token o el reloj
  --     haber pasado la expiración.
  IF v_usado OR v_expira <= p_now THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.4 La MARCA de un solo uso: el CAS que hacía el cliente
  --     (`used = true WHERE id = … AND used = false`), con su red de conteo.
  --     Si no marcó exactamente una fila, se aborta y el token NO se consume.
  UPDATE public.password_resets
  SET used = true
  WHERE id = v_reset_id
    AND used = false;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'RESET_TOKEN_INVALID';
  END IF;

  -- 1.5 La CLAVE, después de la marca y en la misma transacción. Que el orden
  --     sea el del defecto es lo que hace visible que el defecto no era el
  --     orden: la marca y la clave son ahora indivisibles, así que un fallo en
  --     cualquiera de las dos revierte las dos.
  UPDATE public.users
  SET password_hash = p_password_hash,
      must_change_password = false,
      failed_attempts = 0,
      locked_until = null
  WHERE id = v_user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.6 Las SESIONES de la cuenta, todas: recuperar la clave es el acto por el
  --     que se expulsa a cualquiera que estuviera adentro (mismo efecto que el
  --     UPDATE incondicional del cliente).
  UPDATE public.sessions
  SET revoked = true
  WHERE user_id = v_user_id
    AND revoked = false;

  --     POST-CONDICIÓN, dentro de la transacción: no puede quedar una sola
  --     sesión viva. Sin esto, un `UPDATE` que no matchea nada confirmaría la
  --     clave nueva dejando las sesiones viejas adentro.
  IF EXISTS (
    SELECT 1
    FROM public.sessions s
    WHERE s.user_id = v_user_id
      AND s.revoked = false
  ) THEN
    RAISE EXCEPTION 'SESSIONS_NOT_REVOKED';
  END IF;

  RETURN true;
END;
$$;


--
-- Name: FUNCTION confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone) IS 'CL-15: confirmación de recuperación ATÓMICA (AUTH-06). Valida el token bajo FOR UPDATE (token_hash es UNIQUE), lo marca usado con CAS y red de conteo, escribe la clave nueva y revoca TODAS las sesiones: una sola transacción. Un fallo en cualquier punto revierte el token quemado, así que el enlace sigue sirviendo y no hay callejón sin salida. Rechaza con RAISE EXCEPTION ''RESET_TOKEN_INVALID'' (P0001) el token inexistente, usado o vencido; ''USER_NOT_FOUND'' si el usuario no existe; ''SESSIONS_NOT_REVOKED'' si alguna sesión quedó viva. Recibe el token y la clave como HASH: nunca ve un secreto. Sólo service_role puede ejecutarla.';


--
-- Name: create_user_with_role(jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_user_with_role(p_user jsonb, p_role_codes text[]) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_desconocidos integer;
  v_roles uuid[];
BEGIN
  -- 3.1 FORMA de la entrada: los campos obligatorios de `users` (002_auth.sql)
  --     y al menos un rol. Un alta sin rol dejaría a la persona con login y sin
  --     acceso —el estado que 039/040 existen para hacer imposible—, así que se
  --     rechaza igual que un arreglo de códigos desconocidos.
  IF p_user IS NULL OR jsonb_typeof(p_user) <> 'object'
     OR coalesce(p_user ->> 'id_type', '') = ''
     OR coalesce(p_user ->> 'id_number', '') = ''
     OR coalesce(p_user ->> 'password_hash', '') = ''
     OR coalesce(p_user ->> 'full_name', '') = ''
  THEN
    RAISE EXCEPTION 'USER_INVALID';
  END IF;
  IF p_role_codes IS NULL OR cardinality(p_role_codes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 3.2 El CATÁLOGO: ningún código pedido puede quedar afuera. Un subconjunto
  --     silencioso no es un alta: si uno solo no existe, se aborta —y con él, el
  --     usuario que la sección 3.3 todavía no insertó—.
  SELECT count(*) INTO v_desconocidos
  FROM (SELECT DISTINCT t.code FROM unnest(p_role_codes) AS t(code)) AS pedidos
  WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r WHERE r.code = pedidos.code
  );

  IF v_desconocidos > 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     Los ids resueltos, sin repetidos: es lo que se inserta y también el
  --     valor esperado de la red de 3.5.
  SELECT array_agg(DISTINCT r.id) INTO v_roles
  FROM public.roles r
  WHERE r.code = ANY (p_role_codes);

  IF v_roles IS NULL
     OR cardinality(v_roles) = 0
     OR cardinality(v_roles) <> (
       SELECT count(DISTINCT t.code) FROM unnest(p_role_codes) AS t(code)
     )
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 3.3 El USUARIO. La unicidad de 002_auth.sql (`users.id_number` y
  --     `users.email`) es la guardia REAL: el servicio ya comprobó lo mismo
  --     antes de llamar —es lo que da el 409 legible—, pero entre esa lectura y
  --     esta sentencia otro alta puede haber ganado. El bloque las traduce a un
  --     código propio para que el llamador no confunda una carrera de unicidad
  --     con un rol desconocido.
  --
  --     `users.sede_id` SE ESCRIBE, y es la excepción que este archivo deja viva:
  --     ancla la cuenta a la instalación única y es el origen de `session.sedeId`,
  --     del que dependen las siete guardas de sesión (ver el bloque de decisión
  --     del encabezado). El `CASE` que decide su valor se conserva tal cual: la
  --     clave ausente es un valor legítimo y produce NULL.
  BEGIN
    INSERT INTO public.users (
      sede_id, email, phone, id_type, id_number, password_hash, full_name,
      must_change_password
    )
    VALUES (
      -- La sede puede no venir: el MVP opera una sola sede y `users.sede_id` es
      -- NULL-able desde 002 (003 lo vuelve NOT NULL con la sede inicial).
      CASE WHEN p_user ? 'sede_id' THEN (p_user ->> 'sede_id')::uuid ELSE NULL END,
      -- El correo puede faltar (usuarios solo-documento): NULL, nunca la cadena
      -- vacía. `email` es UNIQUE, así que dos NULL conviven (correcto) y dos
      -- vacíos no (incorrecto).
      NULLIF(btrim(coalesce(p_user ->> 'email', '')), ''),
      NULLIF(btrim(coalesce(p_user ->> 'phone', '')), ''),
      p_user ->> 'id_type',
      p_user ->> 'id_number',
      p_user ->> 'password_hash',
      p_user ->> 'full_name',
      -- AUTH-01: la clave inicial es el documento y el cambio es obligatorio.
      true
    )
    RETURNING id INTO v_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'USER_EXISTS';
  END;

  -- 3.4 Los ROLES, en la MISMA sentencia (los dos INSERT corren en la misma
  --     transacción: si este falla, el usuario de 3.3 se revierte con él, y por
  --     eso no puede quedar un huérfano sin rol).
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT v_user_id, r.id
  FROM unnest(v_roles) AS r(id);

  -- 3.5 Red de SEGURIDAD: el alta no puede confirmar un usuario SIN ningún rol
  --     —`requireSedeRole` lo rechazaría con 403 en TODA la aplicación—. Es la
  --     invariante de 039/040 comprobada en la única transacción que puede
  --     probarla.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_user_id;
END;
$$;


--
-- Name: FUNCTION create_user_with_role(p_user jsonb, p_role_codes text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_user_with_role(p_user jsonb, p_role_codes text[]) IS 'CL-15: alta ATÓMICA del par usuario + rol (AUTH-04/07). Inserta `users` y sus `user_roles` en una sola transacción, con la unicidad de 002_auth.sql como guardia real (traducida a ''USER_EXISTS'') y red de seguridad final: el alta no confirma un usuario sin ningún rol. Rechaza con ''ROLE_NOT_FOUND'' un código que no está en el catálogo o un arreglo vacío, y con ''USER_INVALID'' un payload a medio formar; en todos los casos no se escribe ninguna fila. La contraseña viaja como HASH ya calculado. La fila de la cuenta SÍ guarda la sede: `users.sede_id` es el anclaje de la cuenta a la instalación única y el origen de `session.sedeId`, que alimentan las siete guardas de sesión (077). Devuelve el id del usuario creado. Sólo service_role puede ejecutarla.';


--
-- Name: current_sede_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_sede_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  SELECT CASE
    WHEN (auth.jwt() -> 'app_metadata' ->> 'sede_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (auth.jwt() -> 'app_metadata' ->> 'sede_id')::uuid
    ELSE NULL
  END;
$_$;


--
-- Name: FUNCTION current_sede_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.current_sede_id() IS 'T8: sede del JWT (claim app_metadata.sede_id inyectado por el Auth Hook custom_access_token_hook). NULL = sin acceso (deny-by-default).';


--
-- Name: deduct_stock_atomic(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_pedidos integer;
  v_unicos integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que inserta stock no puede aceptar
  --     una entrada a medio formar: el precio de un rechazo claro acá es
  --     infinitamente menor que el de una deducción interpretada.
  IF p_user_id IS NULL
     OR p_reason IS NULL
     OR btrim(p_reason) = ''
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  --     Cada elemento tiene que ser un objeto con un uuid bien formado (la MISMA
  --     forma que valida el CHECK de la 045) y una cantidad de 1 a 9 dígitos.
  --     El `coalesce` es la parte que importa: con la clave ausente,
  --     `item ->> 'qty'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce una entrada sin `qty` pasaría esta guarda. El `CASE`
  --     garantiza además que el cast a integer sólo se evalúe cuando el texto
  --     YA validó la forma (SQL no promete el orden de las condiciones del OR).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer
            ELSE NULL
          END <= 0
  ) THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.2 Cuántos movimientos se piden y cuántos productos distintos hay. Una
  --     deducción sin ítems no es una deducción; una con un producto repetido
  --     tampoco (ver "UN MOVIMIENTO POR PRODUCTO" de 046: la guarda del stock
  --     no vería el efecto de la fila anterior de la misma sentencia).
  SELECT count(*), count(DISTINCT (item ->> 'product_id'))
    INTO v_pedidos, v_unicos
  FROM jsonb_array_elements(p_items) AS item;

  IF v_pedidos = 0 OR v_unicos <> v_pedidos THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.3 La ESCRITURA: UNA sentencia, y por eso UNA transacción. Todos los
  --     movimientos se insertan con el mismo motivo y el mismo responsable.
  --     `type` es 'OUT' y sólo 'OUT': esta función es el descuento de una venta,
  --     no un movimiento genérico.
  --
  --     `ORDER BY p.id` es el orden de los locks del trigger de 004 (ver
  --     "SERIALIZACIÓN" de 046).
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la deducción de una
  --     emisión no tiene intento de cliente, su puerta es la marca de la
  --     FACTURA (041) y su fila queda FUERA del índice único parcial de la 045
  --     (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 046).
  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    'OUT',
    (item ->> 'qty')::integer,
    btrim(p_reason),
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.4 Red de seguridad DENTRO de la transacción: si se escribió MENOS de lo
  --     pedido, se aborta y se revierte todo lo que esta sentencia sí escribió
  --     (el stock incluido, porque sus triggers corren en la misma
  --     transacción). El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback.
  --     Es la misma red que 039 puso sobre su INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_pedidos THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  RETURN v_escritos;
END;
$_$;


--
-- Name: FUNCTION deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb) IS 'CL-7: descuento ATÓMICO del stock de una venta multi-producto. Inserta TODOS los movimientos OUT en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks de fila del trigger trg_inventory_no_negative ordenados por producto para que dos deducciones concurrentes no se bloqueen en ciclo. Un fallo de cualquier movimiento (o de la guarda del stock) revierte la deducción COMPLETA: no queda descuento parcial. Devuelve cuántos movimientos aplicó y falla con DEDUCTION_INVALID (entrada mal formada o producto repetido) o PRODUCT_NOT_FOUND (la red de seguridad del conteo). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock; esta función nunca escribe products.stock_qty. El movimiento no lleva columna de sede: la instalación es de una sola sede (071) y el producto era la fila que la definía (077). Escribe idempotency_key NULL a propósito: la deducción de una emisión no tiene intento de cliente y queda fuera del índice parcial de la 045. Sólo service_role puede ejecutarla.';


--
-- Name: discard_created_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.discard_created_user(p_user_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_filas integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 5.1 El candado de la fila: la compensación no puede competir con otro
  --     escritor del mismo usuario.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 5.2 Nada que compensar: el usuario no está, así que el estado YA está
    --     limpio. Devolver cero es una respuesta legítima, no un error.
    RETURN 0;
  END IF;

  -- 5.3 El BORRADO, con su red de conteo.
  DELETE FROM public.users
  WHERE id = p_user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 5.4 Red de SEGURIDAD: la compensación no puede CONFIRMAR "borrado" si algo
  --     del usuario quedó. Si quedó, esto revierte el DELETE y devuelve un
  --     error: el llamador lo lee como compensación FALLIDA y lo hace audible.
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id)
  THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  RETURN v_filas;
END;
$$;


--
-- Name: FUNCTION discard_created_user(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.discard_created_user(p_user_id uuid) IS 'CL-15: compensación VERIFICADA del alta de usuario (el espejo en Supabase Auth es otro sistema: no puede entrar en la transacción de create_user_with_role). Borra el usuario recién creado —sus user_roles, sessions y password_resets caen por ON DELETE CASCADE de 002_auth.sql— con lock de fila, red de conteo y red de seguridad que aborta si algo quedó. Devuelve 1 si borró, 0 si el usuario ya no está (el estado ya estaba limpio). Un error acá significa "la compensación falló": el servicio lo hace audible. Sólo service_role puede ejecutarla.';


--
-- Name: ensure_user_has_role(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_user_has_role(p_user_id uuid, p_role_code text) RETURNS text[]
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_rol text;
  v_tenia_roles boolean;
  v_filas integer;
  v_resultantes text[];
BEGIN
  -- 1.1 El CANDADO, antes de leer o escribir nada. Es el MISMO lock de la fila
  --     del usuario que toma `replace_user_roles` (039): por eso los dos
  --     caminos que pueden cambiar los roles de una persona quedan
  --     serializados entre sí, y el intercalado de CO-4 deja de existir. El
  --     usuario tiene que existir (no se le asignan roles a un fantasma) y eso
  --     se comprueba con la misma sentencia que toma el lock.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.2 VALIDACIÓN del código pedido. Un rol que no está en el catálogo no se
  --     inventa ni se ignora en silencio: se aborta acá. `p_role_code` nulo
  --     tampoco encuentra fila, así que cae en el mismo error.
  SELECT r.code INTO v_rol
  FROM public.roles r
  WHERE r.code = p_role_code;

  IF v_rol IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 1.3 El estado ANTES de escribir, ya bajo el candado: es la condición de la
  --     red y también el valor esperado contra el que 1.5 contrasta lo que la
  --     sentencia de 1.4 efectivamente hizo.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id
  ) INTO v_tenia_roles;

  -- 1.4 La ESCRITURA CONDICIONAL: el `NOT EXISTS` es la intención literal de la
  --     red ("sólo si no tiene NINGÚN rol"), no "agregá este rol". Corre en la
  --     misma transacción que el candado, así que entre la comprobación y el
  --     insert no hay ventana: ningún otro escritor que respete el lock puede
  --     confirmar un rol en el medio.
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT p_user_id, r.id
  FROM public.roles r
  WHERE r.code = v_rol
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id
    );

  -- 1.5 Red de seguridad dentro de la transacción: la sentencia tiene que haber
  --     escrito exactamente lo que correspondía a 1.3 —una fila si el usuario
  --     no tenía roles, CERO si ya tenía alguno—. El caso "ya tenía y se
  --     escribió" no lo detecta ninguna post-condición posterior (el usuario
  --     queda con roles, y con dos), así que se comprueba acá. Si no coincide,
  --     el RAISE EXCEPTION revierte también el insert de 1.4.
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF
    (v_tenia_roles AND v_filas <> 0)
    OR (NOT v_tenia_roles AND v_filas <> 1)
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  -- 1.6 La POST-CONDICIÓN real, que es lo que la función devuelve: el conjunto
  --     que quedó, leído de la base y no reconstruido desde lo pedido. Jamás
  --     puede ser vacío: si lo fuera, la red habría dejado a la persona sin
  --     ningún rol, que es justo lo que existe para impedir.
  SELECT array_agg(r.code ORDER BY r.code) INTO v_resultantes
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  IF v_resultantes IS NULL OR cardinality(v_resultantes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_resultantes;
END;
$$;


--
-- Name: FUNCTION ensure_user_has_role(p_user_id uuid, p_role_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ensure_user_has_role(p_user_id uuid, p_role_code text) IS 'CO-4: red de seguridad de roles ATÓMICA. Deja p_role_code al usuario SÓLO si no tiene ningún rol (intención de la red de upsertEmployee), en una sola transacción del servidor, con lock FOR UPDATE de la fila del usuario —el mismo lock de replace_user_roles (039), que es lo que serializa a los dos escritores de roles—. Valida el código contra el catálogo y aborta con RAISE EXCEPTION ''ROLE_NOT_FOUND'' (P0001) si no existe; ''USER_NOT_FOUND'' si el usuario no existe; en ambos casos la transacción se revierte y el usuario queda como estaba. Devuelve el conjunto final de roles, nunca vacío. Sólo service_role puede ejecutarla.';


--
-- Name: inventory_apply_stock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inventory_apply_stock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.type = 'IN' THEN
    UPDATE public.products
    SET stock_qty = stock_qty + NEW.qty
    WHERE id = NEW.product_id;
  ELSIF NEW.type = 'OUT' THEN
    UPDATE public.products
    SET stock_qty = stock_qty - NEW.qty
    WHERE id = NEW.product_id;
  ELSIF NEW.type = 'ADJUST' THEN
    UPDATE public.products
    SET stock_qty = NEW.qty
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: inventory_no_negative_stock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inventory_no_negative_stock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_stock integer;
BEGIN
  IF NEW.type = 'OUT' THEN
    SELECT stock_qty INTO v_stock
    FROM public.products
    WHERE id = NEW.product_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;
    IF v_stock < NEW.qty THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: invoice_annul_atomic(uuid, uuid, timestamp with time zone, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_invoice_id IS NULL
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
  --     REVERSIÓN" de 050). Lo que NO se permite es una línea a medio formar.
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
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
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
  --     045 NO ENTRA ACÁ" de 050).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 050).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    'IN',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     movimientos que los pedidos, se aborta y se revierte TODO, la anulación
  --     incluida. El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback, y es
  --     exactamente lo que separa "la anulación no se pudo hacer" de "la factura
  --     quedó anulada sin su reversión". Es la misma red que 039, 046 y 049
  --     pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.7 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --     `INVOICE_SELECT`: eso es lo que el llamador usa como resultado, sin otra
  --     lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_factura.id,
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
$_$;


--
-- Name: FUNCTION invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb) IS 'CL-11: anulación ATÓMICA de una factura (FAC-04/FAC-06). Pisa la factura a Anulada —conservando el compare-and-swap sobre el estado leído— y escribe las reversiones IN de stock en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización del dinero de esa factura, también frente a un cobro) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el motivo, el estado esperado y cada reversión (producto, cantidad y motivo) llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004), que para un IN suma —la guarda de negatividad sólo actúa sobre los OUT, así que un IN no toma ese lock—. Sus redes de conteo abortan con ANNUL_CONFLICT si no actualizó exactamente la factura en el estado leído (una carrera se rechaza y no escribe nada) o con PRODUCT_NOT_FOUND si no escribió exactamente las reversiones pedidas; en los dos casos la transacción se revierte COMPLETA: no queda una factura anulada sin su reversión, y el reintento sigue siendo posible. El arreglo de reversiones puede venir VACÍO (una factura de servicios no mueve stock). Escribe idempotency_key NULL a propósito: la anulación no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT. Sólo service_role puede ejecutarla.';


--
-- Name: invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_user_id IS NULL
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
  --     completa (producto repetido, existencia) la hace `deduct_stock_atomic`
  --     (046) con su propio SQLSTATE.
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
  --     entre la lectura que el servicio ya hizo y la escritura de la factura. El
  --     `SELECT` conserva el mismo `FOR UPDATE OF s` y con él el `NOT FOUND` que
  --     traduce SHIFT_NOT_OPEN: lo único que se fue es la segunda columna del
  --     `INTO`. El estado se relee de la FILA (no del dato que mandó el
  --     llamador).
  SELECT s.status
    INTO v_turno_estado
  FROM public.cash_shifts s
  WHERE s.id = p_cash_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND OR v_turno_estado <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN';
  END IF;

  -- 1.8 EL CONSECUTIVO, reservado ADENTRO: es la decisión central de este
  --     archivo. La autoridad es la de siempre (`next_invoice_number`, 005 y 072:
  --     bloquea la fila `invoice_sequence` de `system_settings` e incrementa
  --     `last_number`), pero ahora el incremento pertenece a ESTA transacción: si
  --     algo falla de acá en adelante, se revierte con ella y el número NO queda
  --     quemado. El costo está declarado en la cabecera de 052 (el lock se
  --     sostiene hasta el commit). La llamada ya no lleva la sede: desde 072 el
  --     parámetro de esa función no seleccionaba nada (sección 3.13).
  v_consecutivo := public.next_invoice_number();

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
    (consecutive_number, idempotency_key, client_name, client_document,
     subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id,
     closed_by, closed_at)
  VALUES
    (v_consecutivo,
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
  --      traduce el servicio (ver "EL 23505" de 052).
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
    v_aplicados := public.deduct_stock_atomic(p_user_id, v_motivo, p_out_items);

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
$_$;


--
-- Name: FUNCTION invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb) IS 'CL-13: la EMISIÓN de una factura, ATÓMICA. Reserva el consecutivo (next_invoice_number, 005 y 072), escribe la factura, sus líneas, su snapshot de impuestos, sus porciones y el OUT de stock (deduct_stock_atomic, 046) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con las precondiciones recomprobadas sobre la fila bloqueada (el turno de caja abierto, con FOR UPDATE). El servicio computa TODO —subtotales, impuestos, recargos, totales, estado, plan de stock y el motivo del OUT como plantilla— y la función sólo escribe lo que recibe: no hay una sola expresión aritmética sobre una columna de dinero. Un fallo de cualquier grupo revierte la emisión COMPLETA, incluida la reserva del consecutivo: no queda residuo parcial y no se quema ningún número, así que NO hay compensación (cleanupFailedInvoice se elimina con 052). Rechaza con INVOICE_INVALID (entrada mal formada), OUT_REASON_INVALID (la plantilla del motivo no trae su token), SHIFT_NOT_OPEN (el turno se cerró en la ventana), INVOICE_MISMATCH / ITEM_MISMATCH / TAX_MISMATCH / PAYMENT_MISMATCH / MOVEMENT_MISMATCH (las redes de conteo) y lo que levanten 005/031/041/046 (23505, el tope de cobro, INSUFFICIENT_STOCK, PRODUCT_NOT_FOUND). La instalación es de una sola sede (071): la función no recibe ni escribe la sede, el turno bloqueado ya no la nombra y ni el consecutivo ni el stock la necesitan (077). Devuelve la factura escrita con las columnas de INVOICE_SELECT. El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y el consecutivo lo sigue asignando EXCLUSIVAMENTE next_invoice_number (005/072). Sólo service_role puede ejecutarla.';


--
-- Name: invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_invoice_id IS NULL
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
  --     impuestos ACTIVOS (FAC-03: el snapshot es inmutable y no sigue al
  --     catálogo). Se corre SIEMPRE, aunque el arreglo venga vacío: así el
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
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 5.11 La factura ESCRITA (con sus totales nuevos) y los conteos.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
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
$_$;


--
-- Name: FUNCTION invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) IS 'CL-12: edición LIBRE de una factura emitida, ATÓMICA, con el total RECALCULADO. Reemplaza los ítems, REEMPLAZA el snapshot de impuestos (borra el que el servicio leyó e inserta el que computó), reescribe los cinco números de la factura, pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (el punto de serialización de la edición de la 038 y el del dinero de esa factura, el MISMO lock que toman la anulación y el cobro de la 050) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: los totales y el snapshot llegan computados por computeInvoiceTotals/snapshotInvoiceTaxes, el diff de ítems con su subtotal por computeLineSubtotal, y el delta de stock con su tipo y su motivo, todos en TypeScript y escritos verbatim; acá no hay una sola suma, resta, multiplicación ni redondeo, ni una operación sobre las columnas de dinero (escribir es convertir la representación). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004). MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila. El REEMPLAZO del snapshot de impuestos es todo-o-nada: si el INSERT del snapshot nuevo falla, el DELETE del viejo se revierte con la transacción entera y la factura conserva su snapshot ANTERIOR completo (el estado intermedio —sin impuestos— no es ninguna de las dos colecciones). Sus redes de conteo abortan con EDIT_CONFLICT (versión o estado movidos), TAX_MISMATCH (no borró o insertó exactamente el snapshot recibido), ITEM_MISMATCH, PAYMENT_MISMATCH o PRODUCT_NOT_FOUND; en todos los casos la transacción se revierte COMPLETA y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';


--
-- Name: invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_invoice_id IS NULL
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
  --     el ajuste de una edición, que puede subir o bajar el stock: IN u OUT, y
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
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
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
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la edición no tiene un
  --     intento de cliente y su fila queda FUERA del índice único parcial de la
  --     045 (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 051).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 051), y el otro
  --     efecto —el orden de las filas del kardex dentro de una edición— está
  --     declarado en la cabecera de 051. El JOIN une por el id del producto.
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.10 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --      movimientos que los pedidos, se aborta y se revierte TODO, los ítems y
  --      el token incluidos. El `JOIN` de arriba une por el id del producto, así
  --      que un producto inexistente escribiría menos filas en SILENCIO: esta
  --      guarda convierte ese subconjunto silencioso en un rechazo con rollback, y
  --      es lo que separa "la edición no se pudo hacer" de "la factura quedó
  --      editada sin su ajuste de stock". Es la misma red que 039, 046 y 050
  --      pusieron sobre sus INSERT.
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
$_$;


--
-- Name: FUNCTION invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) IS 'CL-12: edición ADMIN de factura ATÓMICA, con el total INMUTABLE. Reemplaza los ítems (borra los que se quitaron, actualiza los que cambian, inserta los nuevos), pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización de la edición de la 038 y también el del dinero de esa factura: la anulación y el cobro de la 050 toman el MISMO lock) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el diff de ítems (con el subtotal de cada línea), el delta de stock, su tipo y el motivo del kardex llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y la aritmética de dinero no aparece en esta función —no tiene una sola sentencia que escriba subtotal, discount, tax, surcharge ni total: la inmutabilidad del total de esta edición es ESTRUCTURAL, no una promesa del llamador—. MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila, y su mensaje de negocio es el mismo que devolvía el compare-and-swap del cliente. Sus redes de conteo abortan con EDIT_CONFLICT (la fila ya no está en la versión o el estado leídos), ITEM_MISMATCH (no borró, actualizó o insertó exactamente los ítems recibidos), PAYMENT_MISMATCH (no pisó exactamente los cobros recibidos) o PRODUCT_NOT_FOUND (no escribió exactamente los movimientos pedidos); en todos los casos la transacción se revierte COMPLETA: no queda una edición a medias con el token avanzado, y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y ni el movimiento ni la factura devuelta la nombran (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';


--
-- Name: invoice_split_payment_atomic(uuid, uuid, uuid, timestamp with time zone, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  IF p_invoice_id IS NULL
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

  --     Y la premisa NUEVA de 056: TODAS las porciones pertenecen al TURNO que
  --     la operación bloquea. Sin esta guarda, una porción podría referenciar
  --     otro turno —posiblemente uno que se está cerrando— y la fila de dinero
  --     caería en un turno que la transacción NO bloqueó ni revalidó, que es
  --     exactamente el hueco (b). La comparación corre DESPUÉS de la guarda de
  --     forma de arriba, así que cada `cash_shift_id` ya validó su forma de uuid.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE (item ->> 'cash_shift_id')::uuid <> p_shift_id
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  -- 5.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila y NO compite con otro cobro del mismo turno. El estado se
  --     mira DESPUÉS del lock y sobre LA FILA.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
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
$_$;


--
-- Name: FUNCTION invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb) IS 'CL-11/CL-17: cobro dividido ATÓMICO (FAC-07), con el TURNO bloqueado. Inserta las porciones de invoice_payments —el dinero que entra, con la marca del intento de la 042 sólo en la primera— y, si el servicio decidió que la factura queda Pagada, la cierra con sus datos de cierre (closed_by = p_user_id y closed_at = p_closed_at, los dos DATOS), todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir sus porciones en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. Exige además que TODAS las porciones pertenezcan a ese turno (cash_shift_id = p_shift_id), para que el lock cubra exactamente las filas que se van a escribir. NO calcula nada: el reparto por método (neto, porcentaje, recargo, bruto) llega computado por computeCardFees y la decisión Pagada llega como p_mark_paid (invoiceNetBalance + moneyEquals, TypeScript); la función escribe cada columna verbatim y no compara el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE. Su red de conteo aborta con PAYMENT_MISMATCH si no escribió exactamente las porciones recibidas o si no cerró exactamente una factura; en los dos casos la transacción se revierte COMPLETA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus porciones, y el reintento sigue siendo posible. La instalación es de una sola sede (071): la función no filtra por sede, no la recibe y la factura que devuelve ya no la nombra (077). Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y el número de porciones. Sólo service_role puede ejecutarla.';


--
-- Name: next_invoice_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_invoice_number() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_last integer;
BEGIN
  -- La fila del contador tiene que EXISTIR antes de bloquearla: el `ON CONFLICT
  -- DO NOTHING` no pisa el valor vigente y por eso es seguro repetirlo.
  INSERT INTO public.system_settings (key, value)
  VALUES ('invoice_sequence', jsonb_build_object('last_number', 0))
  ON CONFLICT (key) DO NOTHING;

  -- EL LOCK. Mismo idiom que 005 y por el mismo motivo: desde acá, otro emisor
  -- espera. El número se lee de la FILA bloqueada, nunca del sobre que trajo el
  -- llamador, y `coalesce` cubre el `{}` de una fila recién creada (mismo
  -- DEFAULT documentado que la sección 3 de 072).
  SELECT coalesce((s.value ->> 'last_number')::integer, 0)
    INTO v_last
    FROM public.system_settings s
   WHERE s.key = 'invoice_sequence'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEDE_NOT_FOUND';
  END IF;

  -- El incremento, en la misma transacción. `jsonb_set` con `create_missing` deja
  -- el sobre con la MISMA forma que la lectura espera.
  UPDATE public.system_settings
     SET value = jsonb_set(value, '{last_number}', to_jsonb(v_last + 1), true)
   WHERE key = 'invoice_sequence';

  RETURN v_last + 1;
END;
$$;


--
-- Name: FUNCTION next_invoice_number(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.next_invoice_number() IS 'FAC-05: reserva el siguiente consecutivo de factura. SIN parámetros: el que tenía (`p_sede_id uuid`) ya no seleccionaba nada —la fila del contador es la clave ''invoice_sequence'' de system_settings (072)— y la instalación es de una sola sede (077), así que no hay de qué elegir. BLOQUEA esa fila con SELECT … FOR UPDATE, lee `last_number` de la fila bloqueada e incrementa DENTRO de la misma transacción del llamador (`invoice_create_atomic`), así que dos emisores concurrentes obtienen números distintos (el segundo espera en el lock y ve el valor que el primero dejó) y un aborto del llamador no quema el número. El INSERT … ON CONFLICT DO NOTHING deja existir la fila antes de bloquearla sin pisar el contador vigente. Devuelve el número emitido siguiente (el primero es el 1).';


--
-- Name: payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[] DEFAULT '{}'::uuid[]) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_esperados integer;
  v_marcados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que escribe la nómina no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de un descuento interpretado.
  --     `p_items` puede venir VACÍO (una liquidación sin planta activa pero con
  --     vales que descontar es un caso legal), pero tiene que ser un ARREGLO.
  IF p_period_id IS NULL
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR p_voucher_ids IS NULL
     OR p_carry_ids IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada ítem tiene que ser un objeto, con el MISMO período que el
  --     llamador declaró, un `employee_id` con la forma del `CHECK` de 001/007 y
  --     las SEIS columnas de dinero como número no negativo de hasta 9 dígitos
  --     enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar—.
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item ->> 'net_pay'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así
  --     que sin el coalesce una entrada sin `net_pay` pasaría esta guarda y el
  --     `NOT NULL` de la columna sería el que hablara, con un error de la base
  --     en vez de un rechazo del contrato. Es la misma trampa que 046 documenta
  --     para `qty`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  --
  --     Acá NO hace falta el `CASE` que 046 usa: esta guarda sólo compara
  --     TEXTO contra una expresión regular, y la conversión a `numeric` ocurre
  --     después, en el INSERT (otra sentencia).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'period_id', '') <> p_period_id::text
       OR coalesce(item ->> 'base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR (item -> 'voucher_total' IS NOT NULL
           AND coalesce(item ->> 'voucher_total', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'voucher_excess' IS NOT NULL
           AND coalesce(item ->> 'voucher_excess', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'debt_remainder' IS NOT NULL
           AND coalesce(item ->> 'debt_remainder', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'adjustment_reason' IS NOT NULL
           AND jsonb_typeof(item -> 'adjustment_reason') <> 'null'
           AND (
             jsonb_typeof(item -> 'adjustment_reason') <> 'string'
             OR char_length(btrim(item ->> 'adjustment_reason')) < 1
             OR char_length(btrim(item ->> 'adjustment_reason')) > 200
           ))
       OR (item -> 'detail_json' IS NOT NULL AND jsonb_typeof(item -> 'detail_json') <> 'array')
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Un vale REPETIDO en el arreglo no es un vale dos veces: el arreglo es un
  --     CONJUNTO de ids, y un repetido no se puede marcar dos veces (el conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado). Un elemento
  --     NULL se rechaza por la misma puerta. Se valida en vez de confiar en que
  --     el llamador no repite.
  IF cardinality(p_voucher_ids) <> (
    SELECT count(DISTINCT id) FROM unnest(p_voucher_ids) AS id
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El FLIP de los vales: la transición única a `descontada` que el
  --     servicio ya hacía con su `UPDATE`, con la MISMA precondición de estado
  --     y con los locks en orden determinista (ver "SERIALIZACIÓN" arriba).
  --
  --     El bloqueo va PRIMERO y aparte: `PERFORM ... FOR UPDATE` es el idioma de
  --     la casa para tomar locks de fila (039, 040) y, con `ORDER BY` delante,
  --     bloquea en ese orden: dos cálculos con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo.
  --
  --     El `UPDATE` de abajo no necesita orden: sus filas ya las bloqueó este
  --     paso, en esta misma transacción, y volver a tocarlas no adquiere ningún
  --     lock nuevo.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.id = ANY (p_voucher_ids)
   ORDER BY v.id
     FOR UPDATE OF v;

  UPDATE public.voucher_requests v
     SET status = 'descontada'
   WHERE v.id = ANY (p_voucher_ids)
     AND v.status IN ('pendiente', 'aprobada');

  -- 1.3 Red de seguridad DENTRO de la transacción: si no se marcaron
  --     EXACTAMENTE los vales que se recibieron, se aborta y se revierte todo
  --     (los ítems incluidos). Un vale que ya no está `pendiente`/`aprobada` —lo
  --     descontó otro cálculo— escribe CERO filas: esta guarda convierte esa
  --     carrera silenciosa en un rechazo con rollback, en vez de dejar los
  --     ítems escritos sobre un descuento ajeno. Es la misma red que 046 y 039
  --     pusieron sobre su escritura.
  GET DIAGNOSTICS v_marcados = ROW_COUNT;

  IF v_marcados <> cardinality(p_voucher_ids) THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.4 La ESCRITURA de los ítems: UNA sentencia, y por eso UNA transacción
  --     con el flip de arriba. Todos los ítems entran con el período declarado
  --     y con los montos EXACTOS que el servicio calculó —acá no se suma, no se
  --     resta y no se recalcula nada—.
  --
  --     El `JOIN` filtra por la EXISTENCIA del empleado: un empleado inexistente
  --     escribiría menos filas en SILENCIO, y la guarda de conteo de abajo
  --     convierte ese subconjunto silencioso en un rechazo con rollback.
  --     `ORDER BY e.id` es el orden determinista de los locks de `payroll_items`
  --     (ver "SERIALIZACIÓN").
  --
  --     `ON CONFLICT (period_id, employee_id) DO UPDATE` es el upsert del
  --     servicio (`onConflict: "period_id,employee_id"`) traducido: recalcular
  --     el mismo período REEMPLAZA la fila del empleado, no la duplica. Las
  --     columnas que se pisan son exactamente las del payload y `updated_at`
  --     queda para su trigger. `voucher_total` entra por la misma puerta: el
  --     total real de vales también se refresca al recalcular.
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_items
    (period_id, employee_id, base_fixed, commissions, bonuses,
     deductions_vales, other_discounts, net_pay, detail_json, voucher_total,
     adjustment_reason)
  SELECT
    p_period_id,
    e.id,
    (item ->> 'base_fixed')::numeric,
    (item ->> 'commissions')::numeric,
    (item ->> 'bonuses')::numeric,
    (item ->> 'deductions_vales')::numeric,
    (item ->> 'other_discounts')::numeric,
    (item ->> 'net_pay')::numeric,
    coalesce(item -> 'detail_json', '[]'::jsonb),
    coalesce((item ->> 'voucher_total')::numeric, 0),
    (item ->> 'adjustment_reason')
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  ORDER BY e.id
  ON CONFLICT (period_id, employee_id) DO UPDATE
    SET base_fixed = EXCLUDED.base_fixed,
        commissions = EXCLUDED.commissions,
        bonuses = EXCLUDED.bonuses,
        deductions_vales = EXCLUDED.deductions_vales,
        other_discounts = EXCLUDED.other_discounts,
        net_pay = EXCLUDED.net_pay,
        detail_json = EXCLUDED.detail_json,
        voucher_total = EXCLUDED.voucher_total,
        adjustment_reason = EXCLUDED.adjustment_reason;

  -- 1.5 La segunda red: si se escribieron menos ítems de los pedidos —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, el flip incluido.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_ITEM_MISMATCH';
  END IF;

  -- 1.6 La DEUDA del sobrante del vale. Por cada ítem cuyo `voucher_excess` sea
  --     positivo se registra UNA fila en `payroll_discount_carries`: el sobrante
  --     que el período no pudo descontar, y el período como ORIGEN.
  --     `applied_period_id` nace NULL (PENDIENTE): acá no se aplica nada, sólo se
  --     registra de dónde salió el exceso.
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) hace que RECALCULAR el
  --     mismo período NO duplique la deuda: el upsert de 1.4 reemplaza el ítem y
  --     este paso reencuentra la fila existente en vez de insertar una segunda.
  --     El tipo entra en la clave (NV-02): el sobrante de la deuda de 1.8 tiene
  --     el MISMO origen y el MISMO empleado y no puede bloquear esta fila (ni al
  --     revés). La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (employee_id, amount, origin_period_id, origin_kind)
  SELECT
    e.id,
    (item ->> 'voucher_excess')::numeric,
    p_period_id,
    'voucher_excess'
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  WHERE coalesce((item ->> 'voucher_excess')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
        AND c.origin_kind = 'voucher_excess'
    )
  ORDER BY e.id;

  -- 1.7 La DEUDA ENTRANTE que este cálculo absorbe en `other_discounts` queda
  --     CONSUMIDA: `applied_period_id` se llena con el período que la aplicó.
  --     El descuento ya viajó en el ítem (1.4) y el registro del sobrante
  --     saliente (1.6) es otra fila: acá sólo se cierra la deuda que el
  --     servicio leyó como pendiente y sumó al descuento.
  --
  --     El `IS NULL` es la regla de una sola aplicación: una deuda ya consumida
  --     no se vuelve a marcar (replay no-op) y no vuelve a entrar al conjunto
  --     pendiente. NO se cuenta ni se aborta si se marcaron menos filas: a
  --     diferencia del flip de vales —donde marcar de menos es una carrera que
  --     hay que rechazar—, acá marcar de menos es exactamente el replay que
  --     debe ser silencioso. Los locks van en orden determinista, igual que los
  --     vales, para que dos cálculos con deudas solapadas no se bloqueen en
  --     ciclo.
  PERFORM 1
    FROM public.payroll_discount_carries c
   WHERE c.id = ANY (p_carry_ids)
   ORDER BY c.id
     FOR UPDATE OF c;

  UPDATE public.payroll_discount_carries c
     SET applied_period_id = p_period_id
   WHERE c.id = ANY (p_carry_ids)
     AND c.applied_period_id IS NULL;

  -- 1.8 El SOBRANTE DE LA DEUDA (NV-02). Cuando el tope no alcanzó a absorber
  --     toda la deuda entrante, el ítem trae en `debt_remainder` la parte que no
  --     entró a `other_discounts`. Esa parte NO se perdona: se registra como una
  --     fila PENDIENTE NUEVA con ESTE período como ORIGEN —así ningún cálculo de
  --     este período la vuelve a aplicar (el origen no es anterior a sí mismo) y
  --     sí la aplica cualquier período POSTERIOR— y con el tipo
  --     `'carry_remainder'`, que la distingue del sobrante del vale (1.6).
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) es la misma guarda de
  --     1.6: RECALCULAR el mismo período reencuentra la fila y no inserta una
  --     segunda. El descuento (1.4) y esta re-registración viven en la misma
  --     sentencia y por lo tanto en la MISMA transacción: si cualquiera de los
  --     dos falla, se revierten los dos y la deuda no se pierde ni se duplica.
  --     La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (employee_id, amount, origin_period_id, origin_kind)
  SELECT
    e.id,
    (item ->> 'debt_remainder')::numeric,
    p_period_id,
    'carry_remainder'
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  WHERE coalesce((item ->> 'debt_remainder')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
        AND c.origin_kind = 'carry_remainder'
    )
  ORDER BY e.id;

  RETURN v_escritos;
END;
$_$;


--
-- Name: FUNCTION payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[]) IS 'CL-8 + NV-01 + NV-02 + F8: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items (incluidos voucher_total, el total REAL de vales del período, fuera de la igualdad del neto, y adjustment_reason, el motivo del ajuste manual), marca los vales en descontada, registra la deuda del sobrante del vale en payroll_discount_carries, marca CONSUMIDAS (applied_period_id) las deudas que este cálculo absorbe en other_discounts y re-registra como PENDIENTE (origin_kind = carry_remainder, con este período como origen) el sobrante de la deuda que el tope no alcanzó a descontar, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista. NO calcula nada: cada monto y cada motivo llegan ya resueltos por el servicio y se escriben verbatim; la aritmética de la nómina vive en TypeScript. La instalación es de una sola sede (071): el filtro por sede del empleado y la columna de sede de las deudas ya no existen (077), así que el único `JOIN` que sobrevive en los tres `INSERT` es el de EXISTENCIA del empleado, que sigue siendo la mitad de la red de PAYROLL_ITEM_MISMATCH. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente, reemplaza también adjustment_reason (recalcular no deja el motivo viejo pegado a un ajuste nuevo) y aborta si escribió menos filas de las pedidas; las dos deudas salientes se insertan sólo si el ítem trae voucher_excess o debt_remainder > 0 y no existe ya una deuda del mismo empleado, mismo período de origen y mismo origin_kind (recalcular no duplica); la deuda entrante se marca sólo si sigue pendiente, así un replay es un no-op y una deuda se aplica exactamente una vez. El sobrante de la deuda se re-registra en ESTA transacción a propósito: si fuera una segunda escritura del servicio, un fallo entre el descuento y la re-registración borraría la deuda restante. El motivo del ajuste viaja en el ítem por la misma razón: un fallo entre el monto y su explicación dejaría una diferencia sin rastro. Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada, motivo vacío o desmedido, o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem, ni un vale marcado, ni una deuda consumida, ni un sobrante re-registrado. Sólo service_role puede ejecutarla.';


--
-- Name: payroll_correct_period_atomic(uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_status text;
  v_cabecera public.payroll_period_corrections;
  v_cabeceras integer;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 5.1 FORMA de la entrada. Una función que firma una corrección de nómina no
  --     puede aceptar una entrada a medio formar: el precio de un rechazo claro
  --     acá es infinitamente menor que el de una corrección interpretada.
  --     `p_items` puede venir VACÍO (un período sin planta activa todavía tiene
  --     una versión anterior que congelar), pero tiene que ser un ARREGLO.
  IF p_period_id IS NULL
     OR p_correction IS NULL
     OR jsonb_typeof(p_correction) <> 'object'
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     La cabecera: el motivo no puede quedar vacío (ni en espacios), el actor
  --     tiene que ser un usuario, el período declarado tiene que ser EL MISMO
  --     que se va a corregir, y los totales y los conteos tienen que tener la
  --     forma que la tabla puede guardar (`numeric(12, 2)` y un entero).
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `p_correction ->> 'previous_net_total'` es NULL y `NULL !~ 'regex'` es
  --     NULL —no TRUE—, así que sin el coalesce una entrada sin un monto
  --     pasaría esta guarda y el `NOT NULL` de la columna sería el que hablara,
  --     con un error de la base en vez de un rechazo del contrato. Es la misma
  --     trampa que 046 documenta para `qty` y 047 para `net_pay`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  IF btrim(coalesce(p_correction ->> 'reason', '')) = ''
     OR coalesce(p_correction ->> 'period_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (p_correction ->> 'period_id')::uuid <> p_period_id
     OR coalesce(p_correction ->> 'corrected_by', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_correction ->> 'previous_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_paid_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'corrected_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_item_count', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_correction ->> 'corrected_item_count', '') !~ '^[0-9]{1,9}$'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada fila tiene que ser un objeto con un `employee_id` con la forma del
  --     `CHECK` de 001/007 y sus TRECE montos como número no negativo de hasta 9
  --     dígitos enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar, en las dos versiones (la anterior congelada y la corregida) más
  --     lo pagado—.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'previous_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_paid', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.2 Un empleado REPETIDO en las filas no es un empleado dos veces: las dos
  --     versiones de un empleado van en UNA fila (el índice único
  --     `uq_payroll_period_correction_items_employee` de 037 lo impide, y ese
  --     23505 se traduciría a ALREADY_CORRECTED, que sería una mentira). Se
  --     rechaza la entrada repetida en vez de confiar en que el llamador no
  --     repite.
  IF jsonb_array_length(p_items) <> (
    SELECT count(DISTINCT item ->> 'employee_id')
    FROM jsonb_array_elements(p_items) AS item
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.3 El PERÍODO, bloqueado, y su precondición de estado leída DE LA FILA
  --     (`assertCorrectablePeriod`: sólo un período CERRADO se corrige; un
  --     borrador se recalcula, no se corrige).
  SELECT p.status
    INTO v_status
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_CONFLICT';
  END IF;
  IF v_status <> 'cerrado' THEN
    RAISE EXCEPTION 'PERIOD_NOT_CLOSED';
  END IF;

  -- 5.4 La CABECERA: UNA sentencia, y por eso UNA transacción con las filas de
  --     5.5. Todos los campos entran VERBATIM desde `p_correction` —los totales
  --     de las dos versiones, los conteos, el motivo y el actor—: acá no se
  --     suma, no se resta y no se recalcula nada.
  --
  --     El índice único por período de 037 es la barrera de "una corrección por
  --     período": una carrera contra él levanta 23505 y aborta la transacción
  --     —el servicio lo traduce a ALREADY_CORRECTED, como ya hacía—, así que la
  --     corrección perdedora no deja NADA escrito.
  INSERT INTO public.payroll_period_corrections
    (period_id, previous_net_total, previous_paid_total, corrected_net_total,
     previous_item_count, corrected_item_count, reason, corrected_by)
  VALUES (
    p_period_id,
    (p_correction ->> 'previous_net_total')::numeric,
    (p_correction ->> 'previous_paid_total')::numeric,
    (p_correction ->> 'corrected_net_total')::numeric,
    (p_correction ->> 'previous_item_count')::integer,
    (p_correction ->> 'corrected_item_count')::integer,
    p_correction ->> 'reason',
    (p_correction ->> 'corrected_by')::uuid
  )
  RETURNING * INTO v_cabecera;

  GET DIAGNOSTICS v_cabeceras = ROW_COUNT;

  IF v_cabeceras <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.5 Las FILAS por empleado: la versión anterior congelada, lo pagado y la
  --     versión corregida, TODO verbatim desde `p_items`. Una fila por empleado
  --     de la comparación (`buildPayrollCorrectionView` puede incluir a alguien
  --     que sólo esté en una de las dos versiones, con la otra en cero).
  --
  --     El `JOIN` filtra por la existencia del empleado: uno inexistente
  --     escribiría menos filas en SILENCIO, y la red de 5.6 convierte ese
  --     subconjunto silencioso en un rechazo con rollback. `ORDER BY e.id` es el
  --     orden determinista de los locks de `payroll_period_correction_items`
  --     (ver "SERIALIZACIÓN" de 048).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_period_correction_items
    (correction_id, employee_id,
     previous_base_fixed, previous_commissions, previous_bonuses,
     previous_deductions_vales, previous_other_discounts, previous_net_pay, previous_paid,
     corrected_base_fixed, corrected_commissions, corrected_bonuses,
     corrected_deductions_vales, corrected_other_discounts, corrected_net_pay)
  SELECT
    v_cabecera.id,
    e.id,
    (item ->> 'previous_base_fixed')::numeric,
    (item ->> 'previous_commissions')::numeric,
    (item ->> 'previous_bonuses')::numeric,
    (item ->> 'previous_deductions_vales')::numeric,
    (item ->> 'previous_other_discounts')::numeric,
    (item ->> 'previous_net_pay')::numeric,
    (item ->> 'previous_paid')::numeric,
    (item ->> 'corrected_base_fixed')::numeric,
    (item ->> 'corrected_commissions')::numeric,
    (item ->> 'corrected_bonuses')::numeric,
    (item ->> 'corrected_deductions_vales')::numeric,
    (item ->> 'corrected_other_discounts')::numeric,
    (item ->> 'corrected_net_pay')::numeric
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  ORDER BY e.id;

  -- 5.6 La segunda red: si se escribieron menos filas de las pedidas —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, la cabecera
  --     incluida. Es lo que separa "la corrección no se pudo firmar" de "la
  --     corrección quedó firmada sin su prueba".
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.7 La cabecera ESCRITA, tal como quedó en la tabla (con su `id` y su
  --     `corrected_at` del DEFAULT). Devolverla evita una segunda lectura y su
  --     ventana.
  RETURN to_jsonb(v_cabecera);
END;
$_$;


--
-- Name: FUNCTION payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb) IS 'CL-9: corrección ATÓMICA de un período CERRADO (PA-2b, 037). Inserta la cabecera de payroll_period_corrections y sus filas por empleado en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: la cabecera y las filas llegan ya resueltas por el servicio (computePayrollLines, la prorata del fijo, el arrastre de los ajustes manuales y buildPayrollCorrectionView) y se escriben verbatim; la aritmética de la nómina vive en TypeScript. Conserva las precondiciones del servicio: sólo un período CERRADO (PERIOD_NOT_CLOSED) y el índice único por período de 037 (23505 → ALREADY_CORRECTED) adentro de la transacción. Sus redes de conteo abortan con PAYROLL_CORRECTION_MISMATCH si no escribió exactamente una cabecera y exactamente las filas recibidas; en ese caso la transacción se revierte COMPLETA: no queda una corrección firmada sin su prueba. Devuelve la cabecera escrita. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';


--
-- Name: payroll_delete_period_atomic(uuid, uuid[], uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_status text;
  v_start date;
  v_end date;
  v_esperados integer;
  v_revertidos integer;
  v_borrados integer;
BEGIN
  -- 1.1 FORMA de la entrada. La función revierte estados de vales y borra una
  --     nómina: no puede aceptar una entrada a medio formar. Los dos arreglos
  --     pueden venir VACÍOS (un borrador sin vales descontados es un caso
  --     legal), pero tienen que venir.
  IF p_period_id IS NULL
     OR p_to_approved IS NULL
     OR p_to_pending IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada grupo tiene que ser un CONJUNTO (sin ids repetidos) y los dos
  --     grupos tienen que ser DISJUNTOS. Un id repetido dentro de un grupo, o
  --     presente en los dos, no se puede revertir dos veces: la red de conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado. Se valida en
  --     vez de confiar en que el llamador partió bien.
  IF cardinality(p_to_approved) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_approved) AS id
     )
     OR cardinality(p_to_pending) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_pending) AS id
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_to_approved) AS id WHERE id = ANY (p_to_pending)
     )
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El PERÍODO, bloqueado, y su precondición de estado leída de LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047): a partir de acá, otro
  --     borrado o un cierre del mismo período espera, y si el período cambió
  --     antes, esta lectura ve la versión nueva y rechaza.
  SELECT p.status, p.start_date, p.end_date
    INTO v_status, v_start, v_end
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'borrador' THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  -- 1.3 El guardia de SOLAPAMIENTO, re-evaluado adentro de la transacción con
  --     las fechas de la fila bloqueada. Es la misma regla que el servicio
  --     aplica en `overlapBlocksDeletion`: un período CERRADO que solapa el
  --     rango hace ambiguo qué vales son de este borrador, y revertirlos
  --     destruiría una nómina ya pagada. Solapar con otros BORRADORES no
  --     bloquea: no hay plata pagada y el borrador restante puede recalcularse.
  --     El código es el mismo que el servicio ya devolvía, así que el contrato
  --     de error no cambia.
  IF EXISTS (
    SELECT 1
    FROM public.payroll_periods o
    WHERE o.id <> p_period_id
      AND o.status = 'cerrado'
      AND o.start_date <= v_end
      AND o.end_date >= v_start
  ) THEN
    RAISE EXCEPTION 'PERIOD_OVERLAP_AMBIGUOUS';
  END IF;

  -- 1.4 Los LOCKS de los vales, en orden determinista ascendente por id (ver
  --     "SERIALIZACIÓN" de 048). El bloqueo va PRIMERO y aparte del UPDATE: con
  --     `ORDER BY` delante, dos operaciones con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo. El `UPDATE` de abajo no
  --     necesita orden: sus filas ya las bloqueó este paso, en esta misma
  --     transacción.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.id = ANY (p_to_approved || p_to_pending)
   ORDER BY v.id
     FOR UPDATE OF v;

  -- 1.5 La REVERSIÓN: UNA sentencia para los DOS grupos —y por eso UNA red de
  --     conteo—. El estado destino lo elige el servicio (`restoreVoucherStatus`)
  --     y viaja ya resuelto en el grupo donde va cada id; acá sólo se escribe.
  --     La precondición `status = 'descontada'` es la MISMA que llevaba cada
  --     `UPDATE` del servicio: un vale que ya no está descontado no se toca, y el
  --     conteo de abajo convierte esa carrera en un rechazo.
  v_esperados := cardinality(p_to_approved) + cardinality(p_to_pending);

  UPDATE public.voucher_requests v
     SET status = CASE
                    WHEN v.id = ANY (p_to_approved) THEN 'aprobada'
                    ELSE 'pendiente'
                  END
   WHERE v.id = ANY (p_to_approved || p_to_pending)
     AND v.status = 'descontada';

  -- 1.6 Red de seguridad DENTRO de la transacción: si se revirtieron MENOS vales
  --     de los recibidos —uno lo revirtió otro borrado, o ya estaba en otro
  --     estado—, se aborta y se revierte todo lo que esta sentencia sí escribió.
  --     Sin esta red, el `UPDATE` afectaba cero filas y la operación seguía de
  --     largo EN SILENCIO, borrando el período con vales que ya no eran suyos.
  GET DIAGNOSTICS v_revertidos = ROW_COUNT;

  IF v_revertidos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.7 El BORRADO del período, con su precondición en el propio `WHERE` (la
  --     red de conteo de 1.2 ya la verificó sobre la fila bloqueada; acá se
  --     repite como un compare-and-swap, porque es lo que hace que dos borrados
  --     concurrentes no se pisen). `payroll_items` y `payroll_payments` caen con
  --     él por las FK `ON DELETE CASCADE` de 007, dentro de esta misma
  --     transacción: no hay borrado manual ni huérfanos.
  DELETE FROM public.payroll_periods p
   WHERE p.id = p_period_id
     AND p.status = 'borrador';

  -- 1.8 La segunda red: exactamente UNA fila borrada. Cero filas es un período
  --     que cambió bajo los pies; el resultado es el mismo: rollback de TODO,
  --     la reversión incluida.
  GET DIAGNOSTICS v_borrados = ROW_COUNT;

  IF v_borrados <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  RETURN v_revertidos;
END;
$$;


--
-- Name: FUNCTION payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]) IS 'CL-9: borrado ATÓMICO de un período en BORRADOR. Revierte los vales que ese borrador descontó y borra el período en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero y los vales en orden ascendente por id para que dos borrados concurrentes no se bloqueen en ciclo. Conserva las precondiciones del servicio: sólo un período en borrador, y el guardia de solapamiento contra un período CERRADO (PERIOD_OVERLAP_AMBIGUOUS) re-evaluado dentro de la transacción. Los ids de los vales y su estado destino llegan YA resueltos por el servicio (restoreVoucherStatus): la función no decide qué se revierte ni a qué estado. Su red de conteo aborta con PAYROLL_VOUCHER_CONFLICT si no revirtió exactamente los vales recibidos y con PAYROLL_PERIOD_CONFLICT si el período ya no es borrador o no borró exactamente una fila; en los dos casos la transacción se revierte COMPLETA. Devuelve cuántos vales revirtió. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';


--
-- Name: replace_user_roles(uuid, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_user_roles(p_user_id uuid, p_role_codes text[]) RETURNS text[]
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_codes text[];
  v_desconocidos integer;
  v_filas integer;
BEGIN
  -- 1.1 El CANDADO, antes de leer o escribir nada del reemplazo. El lock sobre
  --     la fila del usuario es lo que serializa a los escritores concurrentes:
  --     el segundo espera acá hasta que el primero confirme. El usuario tiene
  --     que existir (no se asignan roles a un fantasma) y eso se comprueba con
  --     la misma sentencia que toma el lock.
  PERFORM 1
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1.2 VALIDACIÓN de la entrada. Un reemplazo sin roles no es un reemplazo:
  --     "cero roles" es exactamente el estado que este archivo existe para
  --     hacer imposible, así que el arreglo vacío se rechaza igual que un
  --     código desconocido.
  IF p_role_codes IS NULL OR cardinality(p_role_codes) = 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     Ningún código pedido puede quedar afuera: si uno no existe en el
  --     catálogo, se aborta el reemplazo entero en vez de aplicar un
  --     subconjunto silencioso.
  SELECT count(*) INTO v_desconocidos
  FROM (SELECT DISTINCT t.code FROM unnest(p_role_codes) AS t(code)) AS pedidos
  WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r WHERE r.code = pedidos.code
  );

  IF v_desconocidos > 0 THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     El conjunto APLICADO: los códigos pedidos, sin repetidos y ordenados.
  --     Es lo que devuelve la función, así el servicio puede contrastar lo
  --     pedido contra lo que la base efectivamente escribió.
  SELECT array_agg(DISTINCT r.code ORDER BY r.code) INTO v_codes
  FROM public.roles r
  WHERE r.code = ANY (p_role_codes);

  -- 1.3 El REEMPLAZO. El DELETE y el INSERT están en la misma transacción que
  --     el candado: si cualquiera de los dos falla, la transacción entera se
  --     revierte y el usuario conserva su conjunto viejo. Por eso el orden
  --     (borrar y después insertar) es seguro acá y no lo era en el cliente.
  DELETE FROM public.user_roles
  WHERE user_id = p_user_id;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT p_user_id, r.id
  FROM public.roles r
  WHERE r.code = ANY (v_codes);

  -- 1.4 Red de seguridad dentro de la transacción: si no se escribió
  --     EXACTAMENTE el conjunto validado, se aborta y el DELETE de arriba se
  --     revierte con él. Es la garantía "nunca cero roles" escrita en el
  --     lugar donde se puede probar, y no una promesa del llamador. Las tres
  --     condiciones son necesarias: `v_filas <> cardinality(v_codes)` solo no
  --     alcanza, porque con `v_codes` nulo la comparación da NULL, el IF no
  --     dispara y el DELETE quedaría confirmado con CERO filas insertadas.
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF
    v_codes IS NULL
    OR cardinality(v_codes) = 0
    OR v_filas <> cardinality(v_codes)
  THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  RETURN v_codes;
END;
$$;


--
-- Name: FUNCTION replace_user_roles(p_user_id uuid, p_role_codes text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.replace_user_roles(p_user_id uuid, p_role_codes text[]) IS 'CO-2: reemplazo ATÓMICO de los roles de un usuario. DELETE + INSERT en una sola transacción del servidor (una función es una sentencia; PostgREST no ofrece multi-statement por request), con lock FOR UPDATE de la fila del usuario para serializar reemplazos concurrentes. Rechaza arreglo vacío y códigos desconocidos con RAISE EXCEPTION ''ROLE_NOT_FOUND'' (P0001) y usuario inexistente con ''USER_NOT_FOUND''; en los tres casos la transacción se revierte y el usuario conserva sus roles. Devuelve el conjunto aplicado. Sólo service_role puede ejecutarla.';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: upsert_employee_atomic(jsonb, uuid, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_employee_id uuid;
  v_fila public.employees;
BEGIN
  -- 4.1 FORMA de la entrada: las columnas NOT NULL de `employees`
  --     (003_admin.sql) y el rol que se va a asegurar. Un legajo a medio formar
  --     no se escribe: el precio de un rechazo claro es infinitamente menor que
  --     el de un legajo incompleto.
  --
  --     F2: `pay_frequency` es OPCIONAL (su clave puede no viajar y la columna
  --     nace NULL), pero un valor PRESENTE tiene que ser una de las tres
  --     cadencias cerradas de 063. La comprobación se escribe con `?` —pregunta
  --     por la PRESENCIA de la clave— y un `IS NOT NULL` que deja pasar el JSON
  --     null: "sin cadencia definida" es un estado LEGAL, no un valor inválido.
  --     Un objeto o un arreglo en esa clave no están en la lista y se rechazan
  --     sin llegar al CHECK de la columna.
  IF p_employee IS NULL OR jsonb_typeof(p_employee) <> 'object'
     OR coalesce(p_employee ->> 'full_name', '') = ''
     OR coalesce(p_employee ->> 'document', '') = ''
     OR coalesce(p_employee ->> 'pay_type', '') = ''
     OR (
       p_employee ? 'pay_frequency'
       AND p_employee ->> 'pay_frequency' IS NOT NULL
       AND p_employee ->> 'pay_frequency' NOT IN ('semanal', 'quincenal', 'mensual')
     )
     OR p_role_code IS NULL
  THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;
  IF p_create_user IS NOT NULL AND jsonb_typeof(p_create_user) <> 'object' THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;

  -- 4.2 El USUARIO: o se crea (con la unicidad de 002_auth.sql como guardia
  --     real, traducida a su propio código) o ya existe y se lo bloquea con el
  --     MISMO lock de 039/040, que es lo que serializa a los escritores de roles
  --     del mismo usuario.
  IF p_create_user IS NOT NULL THEN
    IF coalesce(p_create_user ->> 'id_type', '') = ''
       OR coalesce(p_create_user ->> 'id_number', '') = ''
       OR coalesce(p_create_user ->> 'password_hash', '') = ''
       OR coalesce(p_create_user ->> 'full_name', '') = ''
    THEN
      RAISE EXCEPTION 'EMPLOYEE_INVALID';
    END IF;

    BEGIN
      INSERT INTO public.users (
        sede_id, email, phone, id_type, id_number, password_hash, full_name,
        must_change_password
      )
      VALUES (
        (p_create_user ->> 'sede_id')::uuid,
        NULLIF(btrim(coalesce(p_create_user ->> 'email', '')), ''),
        NULLIF(btrim(coalesce(p_create_user ->> 'phone', '')), ''),
        p_create_user ->> 'id_type',
        p_create_user ->> 'id_number',
        p_create_user ->> 'password_hash',
        p_create_user ->> 'full_name',
        true
      )
      RETURNING id INTO v_user_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'USER_EXISTS';
    END;
  ELSE
    PERFORM 1
    FROM public.users u
    WHERE u.id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    v_user_id := p_user_id;
  END IF;

  -- 4.3 La RED DE SEGURIDAD de roles, compuesta con 040: escribe `p_role_code`
  --     SÓLO si el usuario no tiene ningún rol (la intención de la red, no
  --     "agregá este rol"), valida el código contra el catálogo y aborta si no
  --     existe. Toma el lock de la fila del usuario, que esta transacción ya
  --     tiene —re-tomarlo desde la misma transacción es inocuo—, así que
  --     `replace_user_roles` (039) y esta función siguen serializadas.
  PERFORM public.ensure_user_has_role(v_user_id, p_role_code);

  -- 4.4 El LEGAJO. `id` no se menciona: lo genera el DEFAULT de 003. Las
  --     columnas que el llamador no manda quedan en NULL salvo las que tienen
  --     DEFAULT (`payout_mode`, `is_active`), que se resuelven en 4.5 sin
  --     repetir el DEFAULT acá.
  --
  --     F2: `pay_frequency` entra DIRECTO en la lista de columnas. La clave
  --     ausente y el JSON null dan SQL NULL —el DEFAULT de la columna— y un
  --     valor presente ya pasó la guarda de 4.1, así que no hay nada que
  --     convertir ni que distinguir (ver "NULL SIGUE SIENDO..." arriba).
  --
  --     El legajo ya no lleva columna de sede (`employees.sede_id` se borra en
  --     077); la cuenta que lo acompaña sí la lleva, y es la que la escribe 4.2.
  INSERT INTO public.employees (
    user_id, full_name, employee_code, document, phone, position,
    email, birth_date, pay_type, salary_fixed, commission_percent, pay_frequency
  )
  VALUES (
    v_user_id,
    p_employee ->> 'full_name',
    p_employee ->> 'employee_code',
    p_employee ->> 'document',
    p_employee ->> 'phone',
    p_employee ->> 'position',
    p_employee ->> 'email',
    CASE
      WHEN coalesce(p_employee ->> 'birth_date', '') = '' THEN NULL
      ELSE (p_employee ->> 'birth_date')::date
    END,
    p_employee ->> 'pay_type',
    CASE
      WHEN p_employee ->> 'salary_fixed' IS NULL THEN NULL
      ELSE (p_employee ->> 'salary_fixed')::numeric
    END,
    CASE
      WHEN p_employee ->> 'commission_percent' IS NULL THEN NULL
      ELSE (p_employee ->> 'commission_percent')::numeric
    END,
    p_employee ->> 'pay_frequency'
  )
  RETURNING id INTO v_employee_id;

  -- 4.5 Las columnas OPCIONALES. PostgREST las deja FUERA del INSERT cuando la
  --     clave no viaja en el payload, y entonces la base aplica su DEFAULT
  --     (`payout_mode 'nomina'`, `is_active true` de 016/003). Acá se reproduce
  --     esa semántica sin repetir los DEFAULT —la fila nace con ellos, como con
  --     PostgREST— y se pisa SÓLO lo que el llamador mandó, usando el operador
  --     `?` de jsonb, que pregunta por la PRESENCIA de la clave (un `->>` no
  --     distingue "no vino" de "vino null").
  IF p_employee ? 'payout_mode' OR p_employee ? 'is_active' THEN
    UPDATE public.employees e
    SET payout_mode = CASE
          WHEN p_employee ? 'payout_mode' THEN p_employee ->> 'payout_mode'
          ELSE e.payout_mode
        END,
        is_active = CASE
          WHEN p_employee ? 'is_active' THEN (p_employee ->> 'is_active')::boolean
          ELSE e.is_active
        END
    WHERE e.id = v_employee_id;
  END IF;

  -- 4.6 POST-CONDICIÓN, leída de la base y no reconstruida desde lo pedido:
  --     el legajo tiene que existir, con SU usuario, y ese usuario tiene que
  --     tener al menos un rol. Es la propiedad del hallazgo —"nunca un usuario
  --     con login y rol pero sin legajo"— escrita donde se puede probar.
  SELECT * INTO v_fila
  FROM public.employees e
  WHERE e.id = v_employee_id;

  IF NOT FOUND OR v_fila.user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'EMPLOYEE_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  --     La fila devuelta, con las MISMAS columnas que el `select` del servicio
  --     (`EMPLOYEE_SELECT`): la respuesta de la ruta no cambia de forma. F2:
  --     `pay_frequency` se agrega a esa forma, al final, para que el alta
  --     devuelva la cadencia que acaba de escribir.
  RETURN jsonb_build_object(
    'id', v_fila.id,
    'user_id', v_fila.user_id,
    'full_name', v_fila.full_name,
    'employee_code', v_fila.employee_code,
    'document', v_fila.document,
    'phone', v_fila.phone,
    'position', v_fila.position,
    'payout_mode', v_fila.payout_mode,
    'email', v_fila.email,
    'birth_date', v_fila.birth_date,
    'pay_type', v_fila.pay_type,
    'salary_fixed', v_fila.salary_fixed,
    'commission_percent', v_fila.commission_percent,
    'pay_frequency', v_fila.pay_frequency,
    'is_active', v_fila.is_active
  );
END;
$$;


--
-- Name: FUNCTION upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text) IS 'CL-15: alta de empleado ATÓMICA (ADM-02/ADM-03). Crea el usuario de acceso si hace falta (su unicidad es la de 002_auth.sql), asegura su rol COMPONIENDO la red de seguridad de 040 (escribe sólo si el usuario no tiene ningún rol, con el mismo lock de la fila) e inserta el legajo, todo en una sola transacción: nunca queda un usuario con login y rol pero sin legajo. Reproduce la semántica de claves ausentes de PostgREST con el operador `?` (los DEFAULT de payout_mode/is_active los aplica la propia tabla). Verifica la post-condición (el legajo con SU usuario y ese usuario con al menos un rol) y devuelve la fila en la misma forma que el select del servicio. F2 (065): `p_employee.pay_frequency` es OPCIONAL y se escribe en el legajo; si viene con valor tiene que ser semanal, quincenal o mensual (la clave ausente y el JSON null son "sin cadencia definida" y dejan NULL), de modo que el alta guarda la misma cadencia que la edición y la respuesta la devuelve. El legajo ya NO se guarda con columna de sede (`employees.sede_id` se borra en 077 y la guarda que exigía `p_employee.sede_id` desaparece con ella), pero la cuenta de acceso SÍ la guarda: `p_create_user.sede_id` sigue siendo el anclaje de la cuenta a la instalación y el origen de `session.sedeId`. ''EMPLOYEE_INVALID''/''USER_NOT_FOUND''/''USER_EXISTS''/''ROLE_NOT_FOUND'' abortan sin escribir nada. Sólo service_role puede ejecutarla.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    review_note text,
    reviewed_by uuid
);


--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_logs IS 'TRA-01: auditoría de acciones críticas (login fallido/bloqueo, anulación de factura, cierre con base incompleta, cálculo/cierre de nómina, vales sobre tope, cambio de clave). Escritura solo servidor (service_role).';


--
-- Name: COLUMN audit_logs.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.metadata IS 'Detalle libre (motivo, consecutivos, montos, intentos). Jamás claves ni tokens.';


--
-- Name: COLUMN audit_logs.is_read; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.is_read IS 'Bandeja admin: si la alerta ya fue revisada. Solo lo marca un admin de la sede.';


--
-- Name: COLUMN audit_logs.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.read_at IS 'Bandeja admin: cuándo se marcó como revisada. NULL mientras siga sin leer.';


--
-- Name: COLUMN audit_logs.review_note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.review_note IS 'Bandeja admin: justificación obligatoria al marcar como revisada (qué pasó, qué se habló).';


--
-- Name: COLUMN audit_logs.reviewed_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.reviewed_by IS 'Bandeja admin: quién la marcó como revisada.';


--
-- Name: cash_denominations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_denominations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    value numeric(12,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_denominations_kind_check CHECK ((kind = ANY (ARRAY['billete'::text, 'moneda'::text]))),
    CONSTRAINT cash_denominations_value_check CHECK ((value > (0)::numeric))
);


--
-- Name: TABLE cash_denominations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cash_denominations IS 'CASH: denominaciones de efectivo para el conteo por denominación. UNIQUE (value) desde 074 (antes `sede_id` + `value`, y la instalación es de una sola sede).';


--
-- Name: cash_registers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_registers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text DEFAULT 'Caja única'::text NOT NULL,
    base_configurada numeric(12,2) DEFAULT 200000 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_registers_base_configurada_check CHECK ((base_configurada >= (0)::numeric))
);


--
-- Name: COLUMN cash_registers.base_configurada; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_registers.base_configurada IS 'CAJ-04: base de efectivo que debe quedar al cierre (p. ej. 300 000). El primer turno abre con esta base; los siguientes heredan base_left del cierre anterior.';


--
-- Name: cash_shift_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_shift_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    phase text NOT NULL,
    method_code text NOT NULL,
    denomination numeric(12,2),
    quantity integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_shift_counts_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT cash_shift_counts_check CHECK ((((denomination IS NOT NULL) AND (quantity >= 0)) OR ((denomination IS NULL) AND (quantity = 1)))),
    CONSTRAINT cash_shift_counts_denomination_check CHECK (((denomination IS NULL) OR (denomination > (0)::numeric))),
    CONSTRAINT cash_shift_counts_phase_check CHECK ((phase = ANY (ARRAY['apertura'::text, 'cierre'::text, 'reconteo'::text]))),
    CONSTRAINT cash_shift_counts_quantity_check CHECK ((quantity >= 0))
);


--
-- Name: TABLE cash_shift_counts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cash_shift_counts IS 'CASH: detalle de conteo de apertura/cierre por método y denominación. Evidencia ante faltantes/sobrantes.';


--
-- Name: cash_shift_recounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_shift_recounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    previous_counted_cash numeric(12,2) NOT NULL,
    previous_base_left numeric(12,2) NOT NULL,
    previous_cash_withdrawn numeric(12,2) NOT NULL,
    previous_base_difference numeric(12,2) NOT NULL,
    counted_cash numeric(12,2) NOT NULL,
    base_left numeric(12,2) NOT NULL,
    cash_withdrawn numeric(12,2) NOT NULL,
    base_difference numeric(12,2) NOT NULL,
    reason text NOT NULL,
    recounted_by uuid NOT NULL,
    recounted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_shift_recounts_base_left_check CHECK ((base_left >= (0)::numeric)),
    CONSTRAINT cash_shift_recounts_counted_cash_check CHECK ((counted_cash >= (0)::numeric)),
    CONSTRAINT cash_shift_recounts_previous_base_left_check CHECK ((previous_base_left >= (0)::numeric)),
    CONSTRAINT cash_shift_recounts_previous_counted_cash_check CHECK ((previous_counted_cash >= (0)::numeric)),
    CONSTRAINT cash_shift_recounts_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: TABLE cash_shift_recounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cash_shift_recounts IS 'U3: reconteos de un cierre. Guarda la versión corregida y la anterior congelada, más quién, cuándo y por qué. El cierre firmado original sigue en cash_shifts; esta tabla es la versión que gobierna cuando existe.';


--
-- Name: COLUMN cash_shift_recounts.shift_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shift_recounts.shift_id IS 'Turno cerrado recontado. A lo sumo un reconteo por turno (índice único).';


--
-- Name: COLUMN cash_shift_recounts.previous_counted_cash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shift_recounts.previous_counted_cash IS 'U3: counted_cash del cierre firmado antes de recontar (versión anterior, congelada).';


--
-- Name: COLUMN cash_shift_recounts.counted_cash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shift_recounts.counted_cash IS 'U3: counted_cash corregido por el reconteo; es el valor que gobierna el turno.';


--
-- Name: COLUMN cash_shift_recounts.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shift_recounts.reason IS 'U3: motivo del reconteo, obligatorio.';


--
-- Name: cash_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cash_register_id uuid NOT NULL,
    opened_by uuid NOT NULL,
    closed_by uuid,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    opening_base numeric(12,2) NOT NULL,
    expected_cash numeric(12,2) DEFAULT 0 NOT NULL,
    counted_cash numeric(12,2),
    base_left numeric(12,2),
    cash_withdrawn numeric(12,2),
    base_difference numeric(12,2),
    status text DEFAULT 'abierto'::text NOT NULL,
    observation text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_shifts_base_left_check CHECK (((base_left IS NULL) OR (base_left >= (0)::numeric))),
    CONSTRAINT cash_shifts_check CHECK (((status <> 'cerrado'::text) OR (counted_cash IS NOT NULL))),
    CONSTRAINT cash_shifts_check1 CHECK (((status <> 'cerrado'::text) OR (base_left IS NOT NULL))),
    CONSTRAINT cash_shifts_check2 CHECK (((status <> 'cerrado'::text) OR (cash_withdrawn IS NOT NULL))),
    CONSTRAINT cash_shifts_check3 CHECK (((status <> 'cerrado'::text) OR (base_difference IS NOT NULL))),
    CONSTRAINT cash_shifts_check4 CHECK (((status <> 'cerrado'::text) OR (closed_at IS NOT NULL))),
    CONSTRAINT cash_shifts_check5 CHECK (((status <> 'cerrado'::text) OR (abs((cash_withdrawn - (counted_cash - base_left))) < 0.01))),
    CONSTRAINT cash_shifts_counted_cash_check CHECK (((counted_cash IS NULL) OR (counted_cash >= (0)::numeric))),
    CONSTRAINT cash_shifts_expected_cash_check CHECK ((expected_cash >= (0)::numeric)),
    CONSTRAINT cash_shifts_opening_base_check CHECK ((opening_base >= (0)::numeric)),
    CONSTRAINT cash_shifts_status_check CHECK ((status = ANY (ARRAY['abierto'::text, 'cerrado'::text])))
);


--
-- Name: COLUMN cash_shifts.opening_base; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shifts.opening_base IS 'CAJ-01: base con la que abre el turno = base_left del cierre anterior (o base_configurada si es el primero).';


--
-- Name: COLUMN cash_shifts.expected_cash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shifts.expected_cash IS 'CAJ-03: efectivo cobrado según los payments del turno (method_code = efectivo). Lo calcula el servicio al cerrar.';


--
-- Name: COLUMN cash_shifts.base_difference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_shifts.base_difference IS 'CAJ-04: base_left − base_configurada vigente (negativo = faltante, positivo = sobrante). Si base_left < base_configurada la observación es obligatoria (regla en servicio).';


--
-- Name: commission_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    cash_shift_id uuid NOT NULL,
    method_code text NOT NULL,
    base_subtotal numeric(12,2) NOT NULL,
    percent_applied numeric(5,2),
    fixed_applied numeric(12,2),
    amount numeric(12,2) NOT NULL,
    paid_by uuid,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    earned_immediate numeric(12,2),
    idempotency_key text,
    CONSTRAINT commission_payouts_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT commission_payouts_base_subtotal_check CHECK ((base_subtotal >= (0)::numeric)),
    CONSTRAINT commission_payouts_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: TABLE commission_payouts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commission_payouts IS 'Comisiones pagadas de inmediato desde caja. Trazan cuánto, quién pagó, cuándo, con qué método, factura y turno. UNIQUE(factura, empleado) impide el doble pago.';


--
-- Name: COLUMN commission_payouts.earned_immediate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_payouts.earned_immediate IS 'U9 (034): ganado pagable DE INMEDIATO del par (factura, empleado) tal como lo calculó la aplicación al momento del pago (`earned.immediateEarned`): solo la comisión por ítem; el porcentaje del empleado se acumula y va en nómina. Es el TOPE contra el que el trigger compara Σamount, no una regla: la base no recalcula comisión. NULL = fila histórica (anterior a 034), su ganado no está en la base y no se reconstruye.';


--
-- Name: COLUMN commission_payouts.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_payouts.idempotency_key IS 'CL-5: marca de idempotencia del intento de pago inmediato de comisión (uuid que acuña la pantalla al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el pago ya registrado en vez de pagar la comisión dos veces. La misma marca con otra factura o con otro empleado es OTRA operación. NULL en las filas anteriores a 044.';


--
-- Name: commission_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_type text NOT NULL,
    item_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    percent numeric(5,2),
    amount numeric(12,2),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rules_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT commission_rules_check CHECK (((percent IS NOT NULL) OR (amount IS NOT NULL))),
    CONSTRAINT commission_rules_item_type_check CHECK ((item_type = ANY (ARRAY['producto'::text, 'servicio'::text]))),
    CONSTRAINT commission_rules_percent_check CHECK (((percent IS NULL) OR ((percent >= (0)::numeric) AND (percent <= (100)::numeric))))
);


--
-- Name: TABLE commission_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commission_rules IS 'Acuerdo de comisión por (ítem × empleado): % y/o valor fijo por unidad. Sin regla rige la tasa plana del empleado.';


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    employee_code text,
    document text NOT NULL,
    phone text,
    "position" text,
    pay_type text NOT NULL,
    salary_fixed numeric(12,2),
    commission_percent numeric(5,2),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    full_name text DEFAULT ''::text NOT NULL,
    payout_mode text DEFAULT 'nomina'::text NOT NULL,
    email text,
    birth_date date,
    pay_frequency text,
    CONSTRAINT chk_employees_pay_frequency CHECK (((pay_frequency IS NULL) OR (pay_frequency = ANY (ARRAY['semanal'::text, 'quincenal'::text, 'mensual'::text])))),
    CONSTRAINT chk_employees_payout_mode CHECK ((payout_mode = ANY (ARRAY['nomina'::text, 'inmediato'::text, 'no_aplica'::text]))),
    CONSTRAINT employees_commission_percent_check CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))),
    CONSTRAINT employees_pay_type_check CHECK ((pay_type = ANY (ARRAY['fijo'::text, 'porcentaje'::text, 'mixto'::text]))),
    CONSTRAINT employees_salary_fixed_check CHECK (((salary_fixed IS NULL) OR (salary_fixed >= (0)::numeric)))
);


--
-- Name: COLUMN employees.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.user_id IS 'ADM-02: vínculo al usuario de acceso. Nullable en T3 (personal sin login); UNIQUE impide dos empleados con el mismo usuario.';


--
-- Name: COLUMN employees.employee_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.employee_code IS 'ADM-03: código interno visible, opcional y cambiable. Vacío/nulo se permite repetir; con valor es único por sede (índice parcial uq_employees_sede_code).';


--
-- Name: COLUMN employees.full_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.full_name IS 'ADM: nombre del empleado. Obligatorio; heredado del usuario vinculado cuando existe.';


--
-- Name: COLUMN employees.payout_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.payout_mode IS 'Preferencia de cobro: nomina, inmediato desde caja, o no_aplica (sin acuerdo de comisión).';


--
-- Name: COLUMN employees.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.email IS 'Correo de contacto del empleado (no es login; solo informativo).';


--
-- Name: COLUMN employees.birth_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.birth_date IS 'Fecha de nacimiento del empleado (informativa).';


--
-- Name: COLUMN employees.pay_frequency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.pay_frequency IS 'F1: cadencia de pago acordada con el empleado: semanal (mensual / 4), quincenal (mensual / 2) o mensual (mes completo), sobre un mes comercial de 30 días. NULL = sin cadencia definida: el fijo se sigue prorrateando por los días calendario del período (prorateFixedSalary), que es el comportamiento de hoy. La fracción del fijo se aplica en la unidad de CÁLCULO; esta columna sólo la almacena.';


--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    type text NOT NULL,
    qty integer NOT NULL,
    reason text NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT inventory_movements_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT inventory_movements_qty_check CHECK ((qty > 0)),
    CONSTRAINT inventory_movements_type_check CHECK ((type = ANY (ARRAY['IN'::text, 'OUT'::text, 'ADJUST'::text])))
);


--
-- Name: COLUMN inventory_movements.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory_movements.type IS 'INV-02/INV-03: IN suma stock, OUT resta (nunca deja negativo), ADJUST fija el nivel absoluto.';


--
-- Name: COLUMN inventory_movements.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory_movements.user_id IS 'INV-02: responsable del movimiento. Nullable (movimientos del sistema, p. ej. reversión de factura anulada en T5).';


--
-- Name: COLUMN inventory_movements.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory_movements.idempotency_key IS 'CL-6: marca de idempotencia del intento de movimiento MANUAL (uuid que acuña la pantalla al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito y al cancelar). Reenviar la misma marca para el MISMO producto devuelve el movimiento ya registrado en vez de escribir un segundo movimiento y mover el stock dos veces. La misma marca para OTRO producto es OTRA operación. NULL en los movimientos de FACTURACIÓN (que no tienen intento propio) y en las filas anteriores a 045.';


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    item_type text NOT NULL,
    product_id uuid,
    service_id uuid,
    custom_name text,
    employee_id uuid NOT NULL,
    qty integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    no_commission boolean DEFAULT false NOT NULL,
    commission_value numeric(12,2),
    commission_mode text,
    commission_percent_override numeric(5,2),
    CONSTRAINT chk_invoice_items_commission_mode CHECK (((commission_mode IS NULL) OR (commission_mode = ANY (ARRAY['comision'::text, 'porcentaje'::text, 'ninguna'::text])))),
    CONSTRAINT chk_invoice_items_commission_percent_override CHECK (((commission_percent_override IS NULL) OR ((commission_percent_override >= (0)::numeric) AND (commission_percent_override <= (100)::numeric)))),
    CONSTRAINT invoice_items_check CHECK ((((item_type = 'producto'::text) AND (product_id IS NOT NULL) AND (service_id IS NULL) AND ((custom_name IS NULL) OR (btrim(custom_name) = ''::text))) OR ((item_type = 'servicio'::text) AND (service_id IS NOT NULL) AND (product_id IS NULL) AND ((custom_name IS NULL) OR (btrim(custom_name) = ''::text))) OR ((item_type = 'custom'::text) AND (custom_name IS NOT NULL) AND (btrim(custom_name) <> ''::text) AND (product_id IS NULL) AND (service_id IS NULL)))),
    CONSTRAINT invoice_items_discount_check CHECK ((discount >= (0)::numeric)),
    CONSTRAINT invoice_items_item_type_check CHECK ((item_type = ANY (ARRAY['producto'::text, 'servicio'::text, 'custom'::text]))),
    CONSTRAINT invoice_items_qty_check CHECK ((qty > 0)),
    CONSTRAINT invoice_items_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT invoice_items_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: COLUMN invoice_items.employee_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_items.employee_id IS 'FAC-02: empleado por línea, base de participación/comisión (T7 liquida desde invoice_items por employee_id). NOT NULL siempre.';


--
-- Name: COLUMN invoice_items.no_commission; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_items.no_commission IS 'La línea no genera comisión aunque exista regla (insumo dentro de un servicio).';


--
-- Name: COLUMN invoice_items.commission_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_items.commission_value IS 'Comisión en VALOR fijo ($) solo para ítems personalizados con comisión (no es %). NULL = sin comisión o no aplica (productos usan % del empleado, servicios nunca).';


--
-- Name: COLUMN invoice_items.commission_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_items.commission_mode IS 'Modo de comisión de la línea: ''comision'' (valor fijo por unidad, commission_value × cantidad), ''porcentaje'' (porcentaje del subtotal: el del empleado o commission_percent_override si el empleado es de pago fijo) o ''ninguna'' (no comisiona). NULL = derivar de no_commission/commission_value (filas previas a la migración 030). Coherente con no_commission/commission_value: ninguna ⇒ no_commission = true; comision ⇒ commission_value informado.';


--
-- Name: COLUMN invoice_items.commission_percent_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_items.commission_percent_override IS 'Porcentaje explícito (0–100) de una línea ''porcentaje'' cuando el empleado es de pago fijo y no tiene commission_percent. La resolución usa el porcentaje del empleado si existe; si no, este. Siempre se paga en nómina, nunca de inmediato. NULL = usar el porcentaje del empleado.';


--
-- Name: invoice_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    method_id uuid,
    method_code text NOT NULL,
    amount numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fee_percent numeric(5,2) DEFAULT 0 NOT NULL,
    fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
    cash_shift_id uuid,
    idempotency_key text,
    CONSTRAINT invoice_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT invoice_payments_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: TABLE invoice_payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_payments IS 'FAC-07 (T5): porciones del cobro por método. Registro interno T5; los pagos por turno de T6 (tabla payments del PRD) referenciarán a invoices y la consolidación se definirá en T6.';


--
-- Name: COLUMN invoice_payments.fee_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_payments.fee_percent IS 'Snapshot del fee_percent del método al momento del cobro.';


--
-- Name: COLUMN invoice_payments.fee_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_payments.fee_amount IS 'Recargo cobrado en esta porción (bruto − neto). Suma con invoices.surcharge.';


--
-- Name: COLUMN invoice_payments.cash_shift_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_payments.cash_shift_id IS 'Turno abierto al momento del cobro (dueño del dinero en caja). NULL = la migración 031 no pudo atribuirlo (factura sin turno): legacy residual.';


--
-- Name: COLUMN invoice_payments.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoice_payments.idempotency_key IS 'CL-2: marca de idempotencia del intento de cobro dividido (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Vive SÓLO en la primera porción de la operación: las demás quedan NULL. Reenviar la misma marca devuelve la factura ya cobrada en vez de cobrar otra vez. NULL en las filas anteriores a 042 (incluidas las que escribe la caja, que no manda marca).';


--
-- Name: invoice_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_sequences (
    last_number integer DEFAULT 0 NOT NULL,
    CONSTRAINT invoice_sequences_last_number_check CHECK ((last_number >= 0))
);


--
-- Name: invoice_taxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_taxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    tax_code text NOT NULL,
    tax_name text NOT NULL,
    percent numeric(5,2) NOT NULL,
    amount numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoice_taxes_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT invoice_taxes_percent_check CHECK (((percent >= (0)::numeric) AND (percent <= (100)::numeric)))
);


--
-- Name: TABLE invoice_taxes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_taxes IS 'FAC-03: snapshot inmutable. Cambiar tax_configs (porcentaje, nombre, activo) nunca altera facturas ya emitidas.';


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    consecutive_number integer NOT NULL,
    client_name text,
    client_document text,
    subtotal numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    tax numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) NOT NULL,
    status text DEFAULT 'Emitida'::text NOT NULL,
    user_id uuid,
    cash_shift_id uuid,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    surcharge numeric(12,2) DEFAULT 0 NOT NULL,
    closed_by uuid,
    closed_at timestamp with time zone,
    edit_version integer DEFAULT 0 NOT NULL,
    idempotency_key text,
    CONSTRAINT invoices_check1 CHECK (((status <> 'Anulada'::text) OR ((cancel_reason IS NOT NULL) AND (btrim(cancel_reason) <> ''::text)))),
    CONSTRAINT invoices_consecutive_number_check CHECK ((consecutive_number > 0)),
    CONSTRAINT invoices_discount_check CHECK ((discount >= (0)::numeric)),
    CONSTRAINT invoices_edit_version_nonnegative CHECK ((edit_version >= 0)),
    CONSTRAINT invoices_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['Emitida'::text, 'Pagada'::text, 'Anulada'::text]))),
    CONSTRAINT invoices_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT invoices_tax_check CHECK ((tax >= (0)::numeric)),
    CONSTRAINT invoices_total_check CHECK ((total >= (0)::numeric)),
    CONSTRAINT invoices_total_surcharge_check CHECK ((abs((total - (((subtotal - discount) + tax) + surcharge))) < 0.01))
);


--
-- Name: COLUMN invoices.consecutive_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.consecutive_number IS 'FAC-05: consecutivo sin huecos ni duplicados. Se reserva con next_invoice_number() (que desde 072 bloquea la fila ''invoice_sequence'' de system_settings) e inserta inmediatamente; UNIQUE (consecutive_number) —sin sede desde 074, porque la instalación es de una sola sede— impide el duplicado.';


--
-- Name: COLUMN invoices.client_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.client_name IS 'Opcional: muchos clientes no dan su nombre. NULL = mostrador / sin nombre.';


--
-- Name: COLUMN invoices.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.user_id IS 'Responsable de la emisión. Nullable (filas del sistema); la app siempre lo informa.';


--
-- Name: COLUMN invoices.cash_shift_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.cash_shift_id IS 'Forward-ref T6: vinculará la factura al turno de caja abierto (tabla cash_shifts, aún no existe). T6 agregará la FK; en T5 siempre NULL.';


--
-- Name: COLUMN invoices.cancel_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.cancel_reason IS 'FAC-04: motivo obligatorio al anular (CHECK cuando status = Anulada). La anulación no borra el registro y conserva el consecutivo.';


--
-- Name: COLUMN invoices.surcharge; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.surcharge IS 'Suma de recargos por método de las porciones (snapshot al emitir). Auditable por reportes.';


--
-- Name: COLUMN invoices.closed_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.closed_by IS 'Usuario que cerró la factura: quien completó el pago (Pagada) o quien la anulo (Anulada). NULL si sigue Emitida.';


--
-- Name: COLUMN invoices.closed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.closed_at IS 'Fecha/hora de cierre de la factura: cuando se completó el pago (Pagada) o se anuló (Anulada). NULL si sigue Emitida.';


--
-- Name: COLUMN invoices.edit_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.edit_version IS 'CO-1: token del compare-and-swap de las ediciones de la factura. Cada edición exitosa lo escribe como (valor leído + 1) con el valor leído como precondición; si otra edición ya lo movió, el UPDATE afecta 0 filas y el servicio rechaza con EDIT_CONFLICT (409) antes de tocar stock. No participa en ninguna regla de dinero.';


--
-- Name: COLUMN invoices.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.idempotency_key IS 'MO-1: marca de idempotencia del intento de emisión (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Reenviar la misma marca devuelve la factura ya emitida en vez de escribir otra. NULL en las filas anteriores a 041.';


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT password_resets_check CHECK ((expires_at > created_at))
);


--
-- Name: payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    arqueable boolean DEFAULT true NOT NULL,
    fee_percent numeric(5,2) DEFAULT 0 NOT NULL,
    CONSTRAINT payment_methods_code_check CHECK ((code = ANY (ARRAY['efectivo'::text, 'transferencia_normal'::text, 'nequi'::text, 'daviplata'::text, 'bre-b'::text, 'tarjeta'::text])))
);


--
-- Name: COLUMN payment_methods.arqueable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_methods.arqueable IS 'CASH: si el método se arquea en apertura/cierre (efectivo por denominación, digitales por total declarado).';


--
-- Name: COLUMN payment_methods.fee_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_methods.fee_percent IS 'Recargo % que se suma al total cuando se cobra con este método (tarjeta: 5). 0 = sin recargo.';


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cash_shift_id uuid NOT NULL,
    invoice_id uuid,
    method_id uuid,
    method_code text NOT NULL,
    amount numeric(12,2) NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payments_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: TABLE payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payments IS 'CAJ-02 (T6): pagos por turno (PRD §9.1). Todo pago con invoice_id se refleja también en invoice_payments (dual-write) para que el saldo de la factura siga cuadrando; ver src/features/cash/README.md.';


--
-- Name: COLUMN payments.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payments.idempotency_key IS 'CL-4: marca de idempotencia del intento de pago de cajón (uuid que acuña el llamador al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). La escribe SÓLO el camino SIN factura; el camino con factura la deja NULL porque su identidad vive en la fila espejo (invoice_payments, 042). Reenviar la misma marca devuelve el pago ya registrado en vez de contar el efectivo dos veces. NULL en las filas anteriores a 043.';


--
-- Name: payroll_discount_carries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_discount_carries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    origin_period_id uuid NOT NULL,
    applied_period_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin_kind text DEFAULT 'voucher_excess'::text NOT NULL,
    CONSTRAINT chk_payroll_discount_carries_origin_kind CHECK ((origin_kind = ANY (ARRAY['voucher_excess'::text, 'carry_remainder'::text]))),
    CONSTRAINT payroll_discount_carries_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: TABLE payroll_discount_carries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_discount_carries IS 'NV-01: deuda arrastrada del empleado por el sobrante de sus vales. Cuando un vale supera lo ganado en el período, el exceso se registra acá con el período de origen y se descuenta en el período siguiente dentro de other_discounts (el neto sigue con piso en cero y la igualdad del CHECK no cambia). Una deuda se consume UNA vez: applied_period_id NULL = pendiente; con valor, ya se aplicó y no vuelve a entrar.';


--
-- Name: COLUMN payroll_discount_carries.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_discount_carries.amount IS 'NV-01: monto del sobrante del vale que quedó como deuda (> 0). Es lo que el período de origen no pudo descontar; se aplica al neto del período siguiente vía other_discounts.';


--
-- Name: COLUMN payroll_discount_carries.origin_period_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_discount_carries.origin_period_id IS 'NV-01: período donde se produjo el exceso (de dónde sale la deuda). Trazabilidad del sobrante: sin esta referencia la deuda no se puede explicar.';


--
-- Name: COLUMN payroll_discount_carries.applied_period_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_discount_carries.applied_period_id IS 'NV-01: período donde la deuda se descontó. NULL = PENDIENTE. Con valor, la deuda quedó CONSUMIDA: una deuda se aplica exactamente una vez y no vuelve a entrar al conjunto pendiente.';


--
-- Name: COLUMN payroll_discount_carries.origin_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_discount_carries.origin_kind IS 'NV-02: tipo de deuda. ''voucher_excess'' = sobrante de un vale que el período de origen no pudo descontar (061/062); ''carry_remainder'' = parte de una deuda entrante que el tope del período de origen no alcanzó a absorber (064). Discrimina la guarda anti-duplicado (origen + empleado + tipo): un período puede producir las dos deudas para el mismo empleado y ninguna puede silenciar a la otra.';


--
-- Name: payroll_extras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_extras (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    method_id uuid,
    method_code text NOT NULL,
    reference text,
    reason text NOT NULL,
    kind text NOT NULL,
    days_from date,
    days_to date,
    paid_by uuid,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT payroll_extras_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payroll_extras_check CHECK (((days_from IS NULL) = (days_to IS NULL))),
    CONSTRAINT payroll_extras_check1 CHECK (((days_from IS NULL) OR (days_to IS NULL) OR (days_to >= days_from))),
    CONSTRAINT payroll_extras_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT payroll_extras_kind_check CHECK ((kind = ANY (ARRAY['despido'::text, 'renuncia'::text, 'emergencia'::text, 'otro'::text]))),
    CONSTRAINT payroll_extras_reason_check CHECK ((btrim(reason) <> ''::text))
);


--
-- Name: TABLE payroll_extras; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_extras IS 'PA-2a: pago de nómina individual por caso extraordinario (despido, renuncia, emergencia, otro). NO es un período: no tiene period_id, no se calcula desde facturas y no cierra nada. Existe para pagar días que un período CERRADO ya cubrió. El monto lo escribe el admin y NO se topa: el sueldo mensual es la base guía (se muestra prorrateado), no un límite.';


--
-- Name: COLUMN payroll_extras.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.amount IS 'PA-2a: monto pagado, escrito por el admin. SIN TOPE por decisión del dueño: el sueldo mensual es la base guía que la aplicación muestra prorrateada (payrollExtraGuide), no un cap. Un despido liquida prestaciones y no es la porción del sueldo.';


--
-- Name: COLUMN payroll_extras.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.reason IS 'PA-2a: motivo del pago. Obligatorio y no vacío (CHECK btrim(reason) <> ''''). Es la explicación del dinero que sale.';


--
-- Name: COLUMN payroll_extras.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.kind IS 'PA-2a: caso extraordinario que motiva el pago: despido | renuncia | emergencia | otro. Vocabulario cerrado (mismo enum en payrollExtraKindSchema).';


--
-- Name: COLUMN payroll_extras.days_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.days_from IS 'PA-2a: primer día que el pago liquida (referencia). Opcional; days_from y days_to van juntos. No es un período ni participa de la exclusión de rangos.';


--
-- Name: COLUMN payroll_extras.days_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.days_to IS 'PA-2a: último día que el pago liquida (referencia). Opcional; va con days_from y no puede ser anterior.';


--
-- Name: COLUMN payroll_extras.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_extras.idempotency_key IS 'CL-5: marca de idempotencia del intento de pago extraordinario (uuid que acuña la pantalla al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el pago ya registrado en vez de escribir un segundo pago extraordinario. La misma marca para otro empleado es OTRA operación. NULL en las filas anteriores a 044.';


--
-- Name: payroll_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    base_fixed numeric(12,2) DEFAULT 0 NOT NULL,
    commissions numeric(12,2) DEFAULT 0 NOT NULL,
    bonuses numeric(12,2) DEFAULT 0 NOT NULL,
    deductions_vales numeric(12,2) DEFAULT 0 NOT NULL,
    other_discounts numeric(12,2) DEFAULT 0 NOT NULL,
    net_pay numeric(12,2) NOT NULL,
    detail_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    voucher_total numeric(12,2) DEFAULT 0 NOT NULL,
    adjustment_reason text,
    CONSTRAINT payroll_items_base_fixed_check CHECK ((base_fixed >= (0)::numeric)),
    CONSTRAINT payroll_items_bonuses_check CHECK ((bonuses >= (0)::numeric)),
    CONSTRAINT payroll_items_check CHECK ((abs((net_pay - ((((base_fixed + commissions) + bonuses) - deductions_vales) - other_discounts))) < 0.01)),
    CONSTRAINT payroll_items_commissions_check CHECK ((commissions >= (0)::numeric)),
    CONSTRAINT payroll_items_deductions_vales_check CHECK ((deductions_vales >= (0)::numeric)),
    CONSTRAINT payroll_items_net_pay_check CHECK ((net_pay >= (0)::numeric)),
    CONSTRAINT payroll_items_other_discounts_check CHECK ((other_discounts >= (0)::numeric))
);


--
-- Name: COLUMN payroll_items.net_pay; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_items.net_pay IS 'PAY-02: base_fixed + commissions + bonuses − deductions_vales − other_discounts (tolerancia de centavo).';


--
-- Name: COLUMN payroll_items.detail_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_items.detail_json IS 'PAY-03: líneas por factura/ítem [{invoice_id, consecutive_number, item_id, item_type, qty, unit_price, line_subtotal, commission}] que reproducen commissions sin diferencias.';


--
-- Name: COLUMN payroll_items.voucher_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_items.voucher_total IS 'NV-01: suma REAL de los vales del empleado en el rango del período (total de vales, sin recorte). Vive FUERA de la igualdad del neto: el CHECK de payroll_items sigue siendo neto = base_fixed + commissions + bonuses − deductions_vales − other_discounts, y esta columna no entra en él. deductions_vales conserva su significado (lo que se aplicó, topeado al bruto); el sobrante que esta columna revela se registra como deuda en payroll_discount_carries.';


--
-- Name: COLUMN payroll_items.adjustment_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_items.adjustment_reason IS 'F8: motivo escrito del ajuste manual del ítem (bonos u otros descuentos). NULL = sin ajuste manual: cuando bonuses y other_discounts son 0 no hay nada que explicar y el servicio descarta cualquier motivo suelto. Con un ajuste distinto de 0 es obligatorio y explica POR QUÉ el empleado tiene ese bono o descuento. Viaja en la MISMA fila —y por lo tanto en la MISMA transacción— que el monto que justifica: el ajuste y su explicación se confirman o se revierten juntos. Máximo 200 caracteres, validado por el contrato antes de escribir.';


--
-- Name: payroll_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payroll_item_id uuid NOT NULL,
    method_id uuid,
    method_code text NOT NULL,
    amount numeric(12,2) NOT NULL,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_by uuid,
    reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT payroll_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payroll_payments_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: TABLE payroll_payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_payments IS 'PAY-04: porciones de pago de un ítem de nómina. La suma por ítem no excede net_pay (trigger trg_payroll_payments_cap + validación exacta en el servicio).';


--
-- Name: COLUMN payroll_payments.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_payments.idempotency_key IS 'CL-2: marca de idempotencia del intento de pago (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Vive SÓLO en la primera porción de la operación: las demás porciones quedan NULL. Reenviar la misma marca devuelve el pago ya registrado en vez de pagar otra vez. NULL en las filas anteriores a 042.';


--
-- Name: payroll_period_correction_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_period_correction_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    correction_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    previous_base_fixed numeric(12,2) NOT NULL,
    previous_commissions numeric(12,2) NOT NULL,
    previous_bonuses numeric(12,2) NOT NULL,
    previous_deductions_vales numeric(12,2) NOT NULL,
    previous_other_discounts numeric(12,2) NOT NULL,
    previous_net_pay numeric(12,2) NOT NULL,
    previous_paid numeric(12,2) NOT NULL,
    corrected_base_fixed numeric(12,2) NOT NULL,
    corrected_commissions numeric(12,2) NOT NULL,
    corrected_bonuses numeric(12,2) NOT NULL,
    corrected_deductions_vales numeric(12,2) NOT NULL,
    corrected_other_discounts numeric(12,2) NOT NULL,
    corrected_net_pay numeric(12,2) NOT NULL,
    CONSTRAINT payroll_period_correction_item_corrected_deductions_vales_check CHECK ((corrected_deductions_vales >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_corrected_base_fixed_check CHECK ((corrected_base_fixed >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_corrected_bonuses_check CHECK ((corrected_bonuses >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_corrected_commissions_check CHECK ((corrected_commissions >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_corrected_net_pay_check CHECK ((corrected_net_pay >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_corrected_other_discounts_check CHECK ((corrected_other_discounts >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_base_fixed_check CHECK ((previous_base_fixed >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_bonuses_check CHECK ((previous_bonuses >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_commissions_check CHECK ((previous_commissions >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_deductions_vales_check CHECK ((previous_deductions_vales >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_net_pay_check CHECK ((previous_net_pay >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_other_discounts_check CHECK ((previous_other_discounts >= (0)::numeric)),
    CONSTRAINT payroll_period_correction_items_previous_paid_check CHECK ((previous_paid >= (0)::numeric))
);


--
-- Name: TABLE payroll_period_correction_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_period_correction_items IS 'PA-2b: las dos versiones por empleado de una corrección (anterior congelada y corregida) más lo pagado. La diferencia (pagado − neto corregido) NO se guarda: se deriva, para que no pueda contradecir a los montos.';


--
-- Name: COLUMN payroll_period_correction_items.previous_paid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_correction_items.previous_paid IS 'PA-2b: pagado a este empleado en este período (suma de payroll_payments) al corregir. Congelado para que la comparación sea reproducible.';


--
-- Name: COLUMN payroll_period_correction_items.corrected_net_pay; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_correction_items.corrected_net_pay IS 'PA-2b: neto recalculado con las reglas vigentes para este empleado. La diferencia que el sistema MUESTRA es previous_paid − corrected_net_pay; saldarla es un acto humano.';


--
-- Name: payroll_period_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_period_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    previous_net_total numeric(12,2) NOT NULL,
    previous_paid_total numeric(12,2) NOT NULL,
    previous_item_count integer NOT NULL,
    corrected_net_total numeric(12,2) NOT NULL,
    corrected_item_count integer NOT NULL,
    reason text NOT NULL,
    corrected_by uuid NOT NULL,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_period_corrections_corrected_item_count_check CHECK ((corrected_item_count >= 0)),
    CONSTRAINT payroll_period_corrections_corrected_net_total_check CHECK ((corrected_net_total >= (0)::numeric)),
    CONSTRAINT payroll_period_corrections_previous_item_count_check CHECK ((previous_item_count >= 0)),
    CONSTRAINT payroll_period_corrections_previous_net_total_check CHECK ((previous_net_total >= (0)::numeric)),
    CONSTRAINT payroll_period_corrections_previous_paid_total_check CHECK ((previous_paid_total >= (0)::numeric)),
    CONSTRAINT payroll_period_corrections_reason_check CHECK ((btrim(reason) <> ''::text))
);


--
-- Name: TABLE payroll_period_corrections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_period_corrections IS 'PA-2b: corrección de un período CERRADO. Guarda los totales de las DOS versiones (anterior congelada y corregida), el motivo, quién y cuándo. El período firmado sigue en payroll_periods/payroll_items; esta tabla es la versión que gobierna cuando existe. NO mueve plata: la diferencia se muestra y se salda a mano con un pago extraordinario (payroll_extras).';


--
-- Name: COLUMN payroll_period_corrections.period_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_corrections.period_id IS 'PA-2b: período cerrado corregido. A lo sumo una corrección por período (índice único).';


--
-- Name: COLUMN payroll_period_corrections.previous_net_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_corrections.previous_net_total IS 'PA-2b: total neto de la liquidación firmada antes de corregir (versión anterior, congelada).';


--
-- Name: COLUMN payroll_period_corrections.previous_paid_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_corrections.previous_paid_total IS 'PA-2b: total pagado del período al momento de corregir. La corrección NO lo cambia.';


--
-- Name: COLUMN payroll_period_corrections.corrected_net_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_corrections.corrected_net_total IS 'PA-2b: total neto recalculado con las reglas vigentes. Es lo que el registro dice que DEBÍA pagarse; no es plata que se mueva.';


--
-- Name: COLUMN payroll_period_corrections.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_period_corrections.reason IS 'PA-2b: motivo de la corrección. Obligatorio y no vacío (CHECK btrim(reason) <> ''''). Es la explicación de por qué cambió un número ya firmado.';


--
-- Name: payroll_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text DEFAULT 'borrador'::text NOT NULL,
    created_by uuid,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    frequency text,
    CONSTRAINT chk_payroll_periods_frequency CHECK (((frequency IS NULL) OR (frequency = ANY (ARRAY['semanal'::text, 'quincenal'::text, 'mensual'::text])))),
    CONSTRAINT payroll_periods_check CHECK ((end_date >= start_date)),
    CONSTRAINT payroll_periods_check1 CHECK (((status <> 'cerrado'::text) OR (closed_at IS NOT NULL))),
    CONSTRAINT payroll_periods_status_check CHECK ((status = ANY (ARRAY['borrador'::text, 'cerrado'::text])))
);


--
-- Name: COLUMN payroll_periods.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_periods.status IS 'PAY-01: borrador (editable, calculable, pagable) / cerrado (inmutable: bloquea cálculo, pagos, vales y reapertura).';


--
-- Name: COLUMN payroll_periods.closed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_periods.closed_at IS 'Fecha de cierre del periodo. Solo informada cuando status = cerrado.';


--
-- Name: COLUMN payroll_periods.frequency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_periods.frequency IS 'F1: cadencia del período: semanal, quincenal o mensual. NULL = sin cadencia definida: el período se comporta como hoy (el fijo se prorratea por días calendario y la guarda lo trata como cadencia vacía). Un valor acota la guarda de solape: dos períodos de la misma sede sólo comparten días si su cadencia difiere.';


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    description text,
    stock_qty integer DEFAULT 0 NOT NULL,
    min_stock integer DEFAULT 0 NOT NULL,
    cost_price numeric(12,2),
    sale_price numeric(12,2),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_value numeric(12,2),
    CONSTRAINT chk_products_commission_value CHECK (((commission_value IS NULL) OR (commission_value >= (0)::numeric))),
    CONSTRAINT products_cost_price_check CHECK (((cost_price IS NULL) OR (cost_price >= (0)::numeric))),
    CONSTRAINT products_min_stock_check CHECK ((min_stock >= 0)),
    CONSTRAINT products_sale_price_check CHECK (((sale_price IS NULL) OR (sale_price >= (0)::numeric))),
    CONSTRAINT products_stock_qty_check CHECK ((stock_qty >= 0))
);


--
-- Name: COLUMN products.sku; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.sku IS 'INV-01: SKU único (UNIQUE sku; la unicidad por sede de 004 se cerró a una sola columna en 074 porque la instalación es de una sola sede). El servicio lo normaliza (trim + mayúsculas) antes de guardar.';


--
-- Name: COLUMN products.stock_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.stock_qty IS 'INV-03: stock derivado EXCLUSIVAMENTE de inventory_movements vía triggers T4. La app nunca lo escribe directo.';


--
-- Name: COLUMN products.commission_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.commission_value IS 'I1: comisión sugerida del producto (valor absoluto). Precarga la comisión de la línea al facturar; el valor editado en la línea manda. NULL = sin sugerencia.';


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    description text,
    CONSTRAINT roles_code_check CHECK ((code = ANY (ARRAY['admin'::text, 'empleado'::text, 'caja'::text, 'superadmin'::text])))
);


--
-- Name: sedes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sedes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    address text,
    phone text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payroll_start_date date
);


--
-- Name: COLUMN sedes.payroll_start_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sedes.payroll_start_date IS 'F10: fecha desde la que la nómina OPERA en esta sede (la fecha de inicio de la implementación). Nada ANTERIOR a esta fecha existe para el sistema: no se ofrece ni se liquida ningún ciclo que cierre antes, un período nuevo no puede empezar antes, y el PRIMER ciclo de cada cadencia —el que contiene esta fecha— se recorta a ella y se paga con la prorrata del ciclo parcial (F5). Es una fecha de calendario (yyyy-mm-dd, la convención del módulo), no un instante. NULL = todavía NO configurada: el aviso de pendientes conserva el comportamiento anterior (se detiene en el arranque de la historia de la sede) y la pantalla invita al admin a fijarla. Ninguna sede existente cambia de comportamiento por aplicar esta migración: el cambio empieza cuando se fija la fecha.';


--
-- Name: services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    price numeric(12,2) NOT NULL,
    duracion_min integer NOT NULL,
    duracion_max integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT services_check CHECK ((duracion_min <= duracion_max)),
    CONSTRAINT services_duracion_max_check CHECK ((duracion_max >= 0)),
    CONSTRAINT services_duracion_min_check CHECK ((duracion_min >= 0)),
    CONSTRAINT services_price_check CHECK ((price >= (0)::numeric))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE system_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.system_settings IS 'Ajustes de la INSTALACIÓN, uno por fila, identificados por `key`. La instalación es de una sola sede: estos ajustes no se repiten por sede, así que la clave del ajuste ES su identidad (y la fila del consecutivo es la fila que next_invoice_number bloquea). `value` (jsonb) es el sobre del ajuste; cada clave declara el suyo (invoice_sequence → {"last_number": n}; voucher_max_per_day / voucher_max_per_week → {"amount": n|null}; voucher_per_day_limits → {"limits": {"<día ISO>": monto}}; voucher_allowed_days → {"days": [1..7]}). Sustituye a invoice_sequences (005) y voucher_settings (007/024/026), que quedan en pie hasta la unidad que borra sede_id.';


--
-- Name: COLUMN system_settings.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_settings.key IS 'Identificador del ajuste (clave primaria). Es también el destino del ON CONFLICT del upsert del servicio y la fila que next_invoice_number bloquea con FOR UPDATE.';


--
-- Name: COLUMN system_settings.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_settings.value IS 'Contenido del ajuste, en un objeto jsonb con el nombre del dato dentro (la tabla es genérica y el lector tiene que distinguir una forma de otra). Una clave ausente se lee con el DEFAULT documentado de la migración 072, no con un error.';


--
-- Name: COLUMN system_settings.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_settings.updated_at IS 'Instante de la última escritura de la fila (trigger set_updated_at de 001). En la fila del consecutivo dice cuándo se emitió el último número.';


--
-- Name: tax_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    percent numeric(5,2) NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_configs_code_check CHECK ((code = ANY (ARRAY['IVA'::text, 'ICA'::text, 'Rete'::text, 'otro'::text]))),
    CONSTRAINT tax_configs_percent_check CHECK (((percent >= (0)::numeric) AND (percent <= (100)::numeric)))
);


--
-- Name: COLUMN tax_configs.code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tax_configs.code IS 'ADM-06: tipo de impuesto de la lista cerrada del CHECK (IVA, ICA, Rete, otro). UNIQUE (code, name) —sin sede desde 074, porque la instalación es de una sola sede— impide repetir un impuesto con el mismo nombre.';


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid,
    email text,
    phone text,
    id_type text NOT NULL,
    id_number text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_failed_attempts_check CHECK ((failed_attempts >= 0)),
    CONSTRAINT users_id_type_check CHECK ((id_type = ANY (ARRAY['CC'::text, 'CE'::text, 'PPT'::text, 'PEP'::text, 'otro'::text])))
);


--
-- Name: COLUMN users.sede_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.sede_id IS 'FK futura a sedes (T3 admin). Nullable en T2; T3 la vuelve NOT NULL con RLS por sede.';


--
-- Name: COLUMN users.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.email IS 'Correo real del usuario. T2 lo exige en adminCreateUser (sin emails sintéticos); nullable en BD para usuarios legacy solo-documento.';


--
-- Name: COLUMN users.password_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.password_hash IS 'Hash scrypt de la clave. Fuente de verdad del login por documento en el MVP (ver README del módulo auth).';


--
-- Name: COLUMN users.must_change_password; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.must_change_password IS 'AUTH-01: true al crear (clave inicial = documento); bloquea todo hasta el cambio.';


--
-- Name: voucher_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voucher_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    request_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'pendiente'::text NOT NULL,
    approved_by uuid,
    approval_code text,
    observation text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    method_code text,
    cash_shift_id uuid,
    created_by uuid,
    idempotency_key text,
    CONSTRAINT chk_voucher_requests_method_code CHECK (((method_code IS NULL) OR (length(btrim(method_code)) > 0))),
    CONSTRAINT voucher_requests_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT voucher_requests_idempotency_key_shape CHECK (((idempotency_key IS NULL) OR (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT voucher_requests_status_check CHECK ((status = ANY (ARRAY['pendiente'::text, 'aprobada'::text, 'rechazada'::text, 'descontada'::text])))
);


--
-- Name: COLUMN voucher_requests.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.status IS 'PAY-06/PAY-07: pendiente → aprobada/rechazada; aprobada/pendiente → descontada al liquidar. Descontada y rechazada son terminales.';


--
-- Name: COLUMN voucher_requests.approval_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.approval_code IS 'Código de aprobación histórico (PAY-06). Ya no se genera ni se valida: la autorización del vale queda en approved_by + observation. Se conserva por compatibilidad; NULL en los vales nuevos.';


--
-- Name: COLUMN voucher_requests.method_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.method_code IS 'Método arqueable por el que sale el dinero del vale (efectivo, nequi, daviplata, …). Se elige al crear el vale. NULL = vale histórico sin método (no afecta el arqueo).';


--
-- Name: COLUMN voucher_requests.cash_shift_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.cash_shift_id IS 'Turno de caja (abierto) que abrió el vale. El arqueo atribuye los vales aprobados a su turno por method_code; un vale pendiente no afecta caja. NULL = vale histórico sin turno.';


--
-- Name: COLUMN voucher_requests.created_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.created_by IS 'Usuario de caja que abrió el vale (turno abierto). NULL = vale histórico, sin autor registrado.';


--
-- Name: COLUMN voucher_requests.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_requests.idempotency_key IS 'CL-5: marca de idempotencia del intento de solicitud de vale (uuid que acuña la pantalla de vales al empezar el intento, se reutiliza en los reintentos del MISMO intento y se suelta al éxito). Reenviar la misma marca devuelve el vale ya registrado en vez de abrir un segundo vale (segunda salida de caja y segundo descuento de nómina). La misma marca para otro empleado es OTRA operación; el TURNO no entra en la clave a propósito (el vale es una obligación del empleado, y con el turno dentro un reintento con otro turno abierto no se reconocería). NULL en las filas anteriores a 044.';


--
-- Name: voucher_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voucher_settings (
    max_per_day numeric(12,2) DEFAULT 0,
    max_per_week numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_days smallint[] DEFAULT '{1,2,3,4,5,6,7}'::smallint[] NOT NULL,
    per_day_limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT chk_voucher_settings_allowed_days CHECK (((allowed_days <@ '{1,2,3,4,5,6,7}'::smallint[]) AND (cardinality(allowed_days) > 0))),
    CONSTRAINT chk_voucher_settings_per_day_limits CHECK ((jsonb_typeof(per_day_limits) = 'object'::text)),
    CONSTRAINT voucher_settings_max_per_day_check CHECK ((max_per_day >= (0)::numeric)),
    CONSTRAINT voucher_settings_max_per_week_check CHECK ((max_per_week >= (0)::numeric))
);


--
-- Name: TABLE voucher_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.voucher_settings IS 'PAY-05: topes de vales por sede (día/semana). Todo desembolso se valida contra ambos topes en el servicio.';


--
-- Name: COLUMN voucher_settings.max_per_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_settings.max_per_day IS 'V2: tope diario general. NULL o 0 = sin tope. El tope propio del día (per_day_limits) lo reemplaza ese día.';


--
-- Name: COLUMN voucher_settings.allowed_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_settings.allowed_days IS 'Item 5: días ISO (1=lunes…7=domingo) en que se pueden pedir vales. Pedir fuera de estos días exige revisión del admin (no bloquea). Por defecto todos.';


--
-- Name: COLUMN voucher_settings.per_day_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voucher_settings.per_day_limits IS 'V2: tope propio por día ISO {"3": 50000}. Reemplaza al tope diario general ese día; {} = sin topes por día.';


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: cash_denominations cash_denominations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_denominations
    ADD CONSTRAINT cash_denominations_pkey PRIMARY KEY (id);


--
-- Name: cash_denominations cash_denominations_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_denominations
    ADD CONSTRAINT cash_denominations_value_key UNIQUE (value);


--
-- Name: cash_registers cash_registers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_name_key UNIQUE (name);


--
-- Name: cash_registers cash_registers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_pkey PRIMARY KEY (id);


--
-- Name: cash_shift_counts cash_shift_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shift_counts
    ADD CONSTRAINT cash_shift_counts_pkey PRIMARY KEY (id);


--
-- Name: cash_shift_recounts cash_shift_recounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shift_recounts
    ADD CONSTRAINT cash_shift_recounts_pkey PRIMARY KEY (id);


--
-- Name: cash_shifts cash_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shifts
    ADD CONSTRAINT cash_shifts_pkey PRIMARY KEY (id);


--
-- Name: commission_payouts commission_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payouts
    ADD CONSTRAINT commission_payouts_pkey PRIMARY KEY (id);


--
-- Name: commission_rules commission_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: employees employees_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_key UNIQUE (user_id);


--
-- Name: payroll_periods ex_payroll_periods_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_periods
    ADD CONSTRAINT ex_payroll_periods_no_overlap EXCLUDE USING gist (COALESCE(frequency, ''::text) WITH =, daterange(start_date, end_date, '[]'::text) WITH &&);


--
-- Name: CONSTRAINT ex_payroll_periods_no_overlap ON payroll_periods; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT ex_payroll_periods_no_overlap ON public.payroll_periods IS 'F1: un día se nomina una sola vez DENTRO DEL MISMO CICLO (074). Dos períodos de la MISMA cadencia no pueden compartir días: el rango es inclusivo y la cadencia se compara con coalesce(frequency, '''') para que los períodos sin cadencia (NULL) sigan siendo mutuamente excluyentes entre sí. Ciclos distintos (semanal y mensual) sí pueden superponerse. El elemento `sede_id` se retiró en 074 porque, siendo la columna nulable, dejaba de participar en la comparación (NULL no es igual a nada) y la garantía se perdía en silencio; la instalación es de una sola sede, así que el elemento era redundante.';


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoice_payments invoice_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_pkey PRIMARY KEY (id);


--
-- Name: invoice_taxes invoice_taxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_taxes
    ADD CONSTRAINT invoice_taxes_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_consecutive_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_consecutive_number_key UNIQUE (consecutive_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash);


--
-- Name: payment_methods payment_methods_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_code_key UNIQUE (code);


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payroll_discount_carries payroll_discount_carries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_discount_carries
    ADD CONSTRAINT payroll_discount_carries_pkey PRIMARY KEY (id);


--
-- Name: payroll_extras payroll_extras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_extras
    ADD CONSTRAINT payroll_extras_pkey PRIMARY KEY (id);


--
-- Name: payroll_items payroll_items_period_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_items
    ADD CONSTRAINT payroll_items_period_id_employee_id_key UNIQUE (period_id, employee_id);


--
-- Name: payroll_items payroll_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_items
    ADD CONSTRAINT payroll_items_pkey PRIMARY KEY (id);


--
-- Name: payroll_payments payroll_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_payments
    ADD CONSTRAINT payroll_payments_pkey PRIMARY KEY (id);


--
-- Name: payroll_period_correction_items payroll_period_correction_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_correction_items
    ADD CONSTRAINT payroll_period_correction_items_pkey PRIMARY KEY (id);


--
-- Name: payroll_period_corrections payroll_period_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_corrections
    ADD CONSTRAINT payroll_period_corrections_pkey PRIMARY KEY (id);


--
-- Name: payroll_periods payroll_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_periods
    ADD CONSTRAINT payroll_periods_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_sku_key UNIQUE (sku);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sedes sedes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sedes
    ADD CONSTRAINT sedes_pkey PRIMARY KEY (id);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: tax_configs tax_configs_code_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_configs
    ADD CONSTRAINT tax_configs_code_name_key UNIQUE (code, name);


--
-- Name: tax_configs tax_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_configs
    ADD CONSTRAINT tax_configs_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_id_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_id_number_key UNIQUE (id_number);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: voucher_requests voucher_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_requests
    ADD CONSTRAINT voucher_requests_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_entity ON public.audit_logs USING btree (entity, entity_id);


--
-- Name: idx_audit_reviewed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_reviewed_by ON public.audit_logs USING btree (reviewed_by);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user ON public.audit_logs USING btree (user_id);


--
-- Name: idx_cash_shifts_closed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_shifts_closed_by ON public.cash_shifts USING btree (closed_by);


--
-- Name: idx_cash_shifts_opened_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_shifts_opened_by ON public.cash_shifts USING btree (opened_by);


--
-- Name: idx_cash_shifts_register_opened; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_shifts_register_opened ON public.cash_shifts USING btree (cash_register_id, opened_at);


--
-- Name: idx_commission_payouts_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_payouts_employee ON public.commission_payouts USING btree (employee_id);


--
-- Name: idx_commission_payouts_invoice_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_payouts_invoice_employee ON public.commission_payouts USING btree (invoice_id, employee_id);


--
-- Name: idx_commission_payouts_paid_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_payouts_paid_by ON public.commission_payouts USING btree (paid_by);


--
-- Name: idx_commission_payouts_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_payouts_shift ON public.commission_payouts USING btree (cash_shift_id);


--
-- Name: idx_commission_rules_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_rules_employee ON public.commission_rules USING btree (employee_id);


--
-- Name: idx_employees_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_user_id ON public.employees USING btree (user_id);


--
-- Name: idx_invoice_items_employee_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_employee_invoice ON public.invoice_items USING btree (employee_id, invoice_id);


--
-- Name: idx_invoice_items_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items USING btree (invoice_id);


--
-- Name: idx_invoice_items_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_product ON public.invoice_items USING btree (product_id);


--
-- Name: idx_invoice_items_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_service ON public.invoice_items USING btree (service_id);


--
-- Name: idx_invoice_payments_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_payments_invoice_id ON public.invoice_payments USING btree (invoice_id);


--
-- Name: idx_invoice_payments_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_payments_method ON public.invoice_payments USING btree (method_id);


--
-- Name: idx_invoice_payments_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_payments_shift ON public.invoice_payments USING btree (cash_shift_id);


--
-- Name: idx_invoice_taxes_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_taxes_invoice_id ON public.invoice_taxes USING btree (invoice_id);


--
-- Name: idx_invoices_cash_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_cash_shift ON public.invoices USING btree (cash_shift_id);


--
-- Name: idx_invoices_closed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_closed_at ON public.invoices USING btree (closed_at);


--
-- Name: idx_invoices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_user ON public.invoices USING btree (user_id);


--
-- Name: idx_movements_product_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movements_product_created ON public.inventory_movements USING btree (product_id, created_at);


--
-- Name: idx_movements_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movements_user ON public.inventory_movements USING btree (user_id);


--
-- Name: idx_password_resets_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_token_hash ON public.password_resets USING btree (token_hash);


--
-- Name: idx_payments_cash_shift_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_cash_shift_id ON public.payments USING btree (cash_shift_id);


--
-- Name: idx_payments_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_invoice_id ON public.payments USING btree (invoice_id);


--
-- Name: idx_payments_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_method ON public.payments USING btree (method_id);


--
-- Name: idx_payments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_user ON public.payments USING btree (user_id);


--
-- Name: idx_payroll_discount_carries_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_discount_carries_origin ON public.payroll_discount_carries USING btree (origin_period_id);


--
-- Name: idx_payroll_extras_employee_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_extras_employee_paid_at ON public.payroll_extras USING btree (employee_id, paid_at DESC);


--
-- Name: idx_payroll_items_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_items_employee_id ON public.payroll_items USING btree (employee_id);


--
-- Name: idx_payroll_items_period_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_items_period_id ON public.payroll_items USING btree (period_id);


--
-- Name: idx_payroll_payments_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_payments_item_id ON public.payroll_payments USING btree (payroll_item_id);


--
-- Name: idx_payroll_payments_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_payments_method ON public.payroll_payments USING btree (method_id);


--
-- Name: idx_payroll_payments_paid_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_payments_paid_by ON public.payroll_payments USING btree (paid_by);


--
-- Name: idx_payroll_period_correction_items_correction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_period_correction_items_correction ON public.payroll_period_correction_items USING btree (correction_id, employee_id);


--
-- Name: idx_payroll_periods_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_periods_created_by ON public.payroll_periods USING btree (created_by);


--
-- Name: idx_resets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resets_user ON public.password_resets USING btree (user_id);


--
-- Name: idx_sessions_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token_hash ON public.sessions USING btree (token_hash);


--
-- Name: idx_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);


--
-- Name: idx_shift_counts_shift_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shift_counts_shift_id ON public.cash_shift_counts USING btree (shift_id);


--
-- Name: idx_user_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_role ON public.user_roles USING btree (role_id);


--
-- Name: idx_users_id_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_id_number ON public.users USING btree (id_number);


--
-- Name: idx_users_sede; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_sede ON public.users USING btree (sede_id);


--
-- Name: idx_voucher_requests_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_requests_approved_by ON public.voucher_requests USING btree (approved_by);


--
-- Name: idx_voucher_requests_cash_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_requests_cash_shift ON public.voucher_requests USING btree (cash_shift_id);


--
-- Name: idx_voucher_requests_employee_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_requests_employee_date ON public.voucher_requests USING btree (employee_id, request_date);


--
-- Name: uq_cash_shift_recounts_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cash_shift_recounts_shift ON public.cash_shift_recounts USING btree (shift_id);


--
-- Name: uq_cash_shifts_open_per_register; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cash_shifts_open_per_register ON public.cash_shifts USING btree (cash_register_id) WHERE (status = 'abierto'::text);


--
-- Name: uq_commission_payouts_pair_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_commission_payouts_pair_idempotency_key ON public.commission_payouts USING btree (invoice_id, employee_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_commission_rule_install_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_commission_rule_install_key ON public.commission_rules USING btree (item_type, item_id, employee_id);


--
-- Name: INDEX uq_commission_rule_install_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.uq_commission_rule_install_key IS 'COM: un (ítem × empleado) es UNA sola regla en toda la instalación (075). Reemplaza a `uq_commission_rule` (016), que además de `sede_id` ya no forma parte de la garantía desde que la columna es nulable (073): los tres elementos de este son los que infiere el `onConflict` del `upsert` en `src/features/commissions/service.ts`, y la coincidencia tiene que ser exacta o PostgreSQL responde 42P10. `uq_commission_rule` sigue en pie hasta la migración final de una sola sede (M3c), que lo quita con `DROP INDEX IF EXISTS public.uq_commission_rule;` en la misma unidad que borra la columna.';


--
-- Name: uq_employees_sede_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_employees_sede_code ON public.employees USING btree (employee_code) WHERE ((employee_code IS NOT NULL) AND (btrim(employee_code) <> ''::text));


--
-- Name: uq_inventory_movements_product_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_inventory_movements_product_idempotency_key ON public.inventory_movements USING btree (product_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_invoice_payments_invoice_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoice_payments_invoice_idempotency_key ON public.invoice_payments USING btree (invoice_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_invoices_sede_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoices_sede_idempotency_key ON public.invoices USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_payments_shift_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payments_shift_idempotency_key ON public.payments USING btree (cash_shift_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_payroll_draft_per_range; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payroll_draft_per_range ON public.payroll_periods USING btree (start_date, end_date) WHERE (status = 'borrador'::text);


--
-- Name: uq_payroll_extras_employee_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payroll_extras_employee_idempotency_key ON public.payroll_extras USING btree (employee_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_payroll_payments_item_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payroll_payments_item_idempotency_key ON public.payroll_payments USING btree (payroll_item_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_payroll_period_correction_items_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payroll_period_correction_items_employee ON public.payroll_period_correction_items USING btree (correction_id, employee_id);


--
-- Name: uq_payroll_period_corrections_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payroll_period_corrections_period ON public.payroll_period_corrections USING btree (period_id);


--
-- Name: uq_sedes_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sedes_name ON public.sedes USING btree (lower(btrim(name)));


--
-- Name: INDEX uq_sedes_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.uq_sedes_name IS 'Un nombre de sede identifica una sede: la clave es lower(btrim(name)), porque los espacios de los extremos y las mayúsculas son invisibles para quien lee la lista de sedes. Cierra la carrera del aprovisionamiento por nombre de la sede de plataforma (Plataforma (sistema)) y la indistinguibilidad de dos sedes iguales en la pantalla de plataforma.';


--
-- Name: uq_voucher_requests_employee_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_voucher_requests_employee_idempotency_key ON public.voucher_requests USING btree (employee_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: cash_registers trg_cash_registers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cash_registers_updated_at BEFORE UPDATE ON public.cash_registers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cash_shifts trg_cash_shifts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cash_shifts_updated_at BEFORE UPDATE ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: commission_payouts trg_commission_payouts_cap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_commission_payouts_cap BEFORE INSERT ON public.commission_payouts FOR EACH ROW EXECUTE FUNCTION public.check_commission_payouts_cap();


--
-- Name: employees trg_employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_movements trg_inventory_apply_stock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inventory_apply_stock AFTER INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_apply_stock();


--
-- Name: inventory_movements trg_inventory_no_negative; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inventory_no_negative BEFORE INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_no_negative_stock();


--
-- Name: invoice_items trg_invoice_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoice_items_updated_at BEFORE UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: invoice_payments trg_invoice_payments_cap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoice_payments_cap BEFORE INSERT ON public.invoice_payments FOR EACH ROW EXECUTE FUNCTION public.check_invoice_payments_cap();


--
-- Name: invoices trg_invoices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payment_methods trg_payment_methods_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_methods_updated_at BEFORE UPDATE ON public.payment_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payroll_items trg_payroll_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payroll_items_updated_at BEFORE UPDATE ON public.payroll_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payroll_payments trg_payroll_payments_cap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payroll_payments_cap BEFORE INSERT ON public.payroll_payments FOR EACH ROW EXECUTE FUNCTION public.check_payroll_payments_cap();


--
-- Name: payroll_periods trg_payroll_periods_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payroll_periods_updated_at BEFORE UPDATE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products trg_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sedes trg_sedes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sedes_updated_at BEFORE UPDATE ON public.sedes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: services trg_services_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_services_updated_at BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: system_settings trg_system_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_system_settings_updated_at BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tax_configs trg_tax_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tax_configs_updated_at BEFORE UPDATE ON public.tax_configs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: voucher_requests trg_voucher_requests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_voucher_requests_updated_at BEFORE UPDATE ON public.voucher_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: voucher_settings trg_voucher_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_voucher_settings_updated_at BEFORE UPDATE ON public.voucher_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: audit_logs audit_logs_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_shift_counts cash_shift_counts_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shift_counts
    ADD CONSTRAINT cash_shift_counts_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.cash_shifts(id) ON DELETE CASCADE;


--
-- Name: cash_shift_recounts cash_shift_recounts_recounted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shift_recounts
    ADD CONSTRAINT cash_shift_recounts_recounted_by_fkey FOREIGN KEY (recounted_by) REFERENCES public.users(id);


--
-- Name: cash_shift_recounts cash_shift_recounts_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shift_recounts
    ADD CONSTRAINT cash_shift_recounts_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.cash_shifts(id) ON DELETE CASCADE;


--
-- Name: cash_shifts cash_shifts_cash_register_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shifts
    ADD CONSTRAINT cash_shifts_cash_register_id_fkey FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id);


--
-- Name: cash_shifts cash_shifts_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shifts
    ADD CONSTRAINT cash_shifts_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_shifts cash_shifts_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_shifts
    ADD CONSTRAINT cash_shifts_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.users(id);


--
-- Name: commission_payouts commission_payouts_cash_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payouts
    ADD CONSTRAINT commission_payouts_cash_shift_id_fkey FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id) ON DELETE RESTRICT;


--
-- Name: commission_payouts commission_payouts_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payouts
    ADD CONSTRAINT commission_payouts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: commission_payouts commission_payouts_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payouts
    ADD CONSTRAINT commission_payouts_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE RESTRICT;


--
-- Name: commission_payouts commission_payouts_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payouts
    ADD CONSTRAINT commission_payouts_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: commission_rules commission_rules_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employees employees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoices fk_invoices_cash_shift; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_cash_shift FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id) ON DELETE SET NULL;


--
-- Name: users fk_users_sede; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_sede FOREIGN KEY (sede_id) REFERENCES public.sedes(id);


--
-- Name: inventory_movements inventory_movements_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: inventory_movements inventory_movements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoice_items invoice_items_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: invoice_items invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: invoice_items invoice_items_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);


--
-- Name: invoice_payments invoice_payments_cash_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_cash_shift_id_fkey FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id) ON DELETE SET NULL;


--
-- Name: invoice_payments invoice_payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_payments invoice_payments_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_method_id_fkey FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE SET NULL;


--
-- Name: invoice_taxes invoice_taxes_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_taxes
    ADD CONSTRAINT invoice_taxes_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: password_resets password_resets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_cash_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_cash_shift_id_fkey FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id);


--
-- Name: payments payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: payments payments_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_method_id_fkey FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE SET NULL;


--
-- Name: payments payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payroll_discount_carries payroll_discount_carries_applied_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_discount_carries
    ADD CONSTRAINT payroll_discount_carries_applied_period_id_fkey FOREIGN KEY (applied_period_id) REFERENCES public.payroll_periods(id) ON DELETE SET NULL;


--
-- Name: payroll_discount_carries payroll_discount_carries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_discount_carries
    ADD CONSTRAINT payroll_discount_carries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: payroll_discount_carries payroll_discount_carries_origin_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_discount_carries
    ADD CONSTRAINT payroll_discount_carries_origin_period_id_fkey FOREIGN KEY (origin_period_id) REFERENCES public.payroll_periods(id) ON DELETE CASCADE;


--
-- Name: payroll_extras payroll_extras_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_extras
    ADD CONSTRAINT payroll_extras_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: payroll_extras payroll_extras_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_extras
    ADD CONSTRAINT payroll_extras_method_id_fkey FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE SET NULL;


--
-- Name: payroll_extras payroll_extras_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_extras
    ADD CONSTRAINT payroll_extras_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payroll_items payroll_items_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_items
    ADD CONSTRAINT payroll_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: payroll_items payroll_items_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_items
    ADD CONSTRAINT payroll_items_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.payroll_periods(id) ON DELETE CASCADE;


--
-- Name: payroll_payments payroll_payments_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_payments
    ADD CONSTRAINT payroll_payments_method_id_fkey FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE SET NULL;


--
-- Name: payroll_payments payroll_payments_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_payments
    ADD CONSTRAINT payroll_payments_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payroll_payments payroll_payments_payroll_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_payments
    ADD CONSTRAINT payroll_payments_payroll_item_id_fkey FOREIGN KEY (payroll_item_id) REFERENCES public.payroll_items(id) ON DELETE CASCADE;


--
-- Name: payroll_period_correction_items payroll_period_correction_items_correction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_correction_items
    ADD CONSTRAINT payroll_period_correction_items_correction_id_fkey FOREIGN KEY (correction_id) REFERENCES public.payroll_period_corrections(id) ON DELETE CASCADE;


--
-- Name: payroll_period_correction_items payroll_period_correction_items_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_correction_items
    ADD CONSTRAINT payroll_period_correction_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: payroll_period_corrections payroll_period_corrections_corrected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_corrections
    ADD CONSTRAINT payroll_period_corrections_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES public.users(id);


--
-- Name: payroll_period_corrections payroll_period_corrections_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_period_corrections
    ADD CONSTRAINT payroll_period_corrections_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.payroll_periods(id) ON DELETE CASCADE;


--
-- Name: payroll_periods payroll_periods_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_periods
    ADD CONSTRAINT payroll_periods_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voucher_requests voucher_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_requests
    ADD CONSTRAINT voucher_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: voucher_requests voucher_requests_cash_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_requests
    ADD CONSTRAINT voucher_requests_cash_shift_id_fkey FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id) ON DELETE SET NULL;


--
-- Name: voucher_requests voucher_requests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_requests
    ADD CONSTRAINT voucher_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: voucher_requests voucher_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_requests
    ADD CONSTRAINT voucher_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_denominations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_denominations ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_registers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_shift_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_shift_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_shift_recounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_shift_recounts ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_payouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_taxes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_taxes ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: password_resets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_methods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_discount_carries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_discount_carries ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_extras; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_extras ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_period_correction_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_period_correction_items ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_period_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_period_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: password_resets pol_password_resets_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_password_resets_sede_isolation ON public.password_resets TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = password_resets.user_id) AND (u.sede_id = public.current_sede_id()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = password_resets.user_id) AND (u.sede_id = public.current_sede_id())))));


--
-- Name: payroll_discount_carries pol_payroll_discount_carries_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_payroll_discount_carries_sede_isolation ON public.payroll_discount_carries USING (true) WITH CHECK (true);


--
-- Name: payroll_extras pol_payroll_extras_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_payroll_extras_sede_isolation ON public.payroll_extras USING (true) WITH CHECK (true);


--
-- Name: payroll_period_correction_items pol_payroll_period_correction_items_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_payroll_period_correction_items_sede_isolation ON public.payroll_period_correction_items USING (true) WITH CHECK (true);


--
-- Name: payroll_period_corrections pol_payroll_period_corrections_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_payroll_period_corrections_sede_isolation ON public.payroll_period_corrections USING (true) WITH CHECK (true);


--
-- Name: roles pol_roles_readonly; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_roles_readonly ON public.roles FOR SELECT TO authenticated USING (true);


--
-- Name: sessions pol_sessions_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_sessions_sede_isolation ON public.sessions TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = sessions.user_id) AND (u.sede_id = public.current_sede_id()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = sessions.user_id) AND (u.sede_id = public.current_sede_id())))));


--
-- Name: system_settings pol_system_settings_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_system_settings_sede_isolation ON public.system_settings USING (true) WITH CHECK (true);


--
-- Name: user_roles pol_user_roles_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_user_roles_sede_isolation ON public.user_roles TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = user_roles.user_id) AND (u.sede_id = public.current_sede_id()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = user_roles.user_id) AND (u.sede_id = public.current_sede_id())))));


--
-- Name: users pol_users_sede_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pol_users_sede_isolation ON public.users TO authenticated USING ((sede_id = public.current_sede_id())) WITH CHECK ((sede_id = public.current_sede_id()));


--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: sedes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sedes ENABLE ROW LEVEL SECURITY;

--
-- Name: services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: voucher_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voucher_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: voucher_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voucher_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: FUNCTION cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_close_shift_atomic(p_shift_id uuid, p_closed_by uuid, p_closed_at timestamp with time zone, p_close jsonb, p_counts jsonb, p_collection_counts jsonb) TO service_role;


--
-- Name: FUNCTION cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_invoice_payment_atomic(p_shift_id uuid, p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_set_shift boolean, p_mark_paid boolean, p_collection jsonb) TO service_role;


--
-- Name: FUNCTION cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_open_shift_atomic(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb) TO service_role;


--
-- Name: FUNCTION cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_recount_shift_atomic(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb) TO service_role;


--
-- Name: FUNCTION change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.change_user_password(p_user_id uuid, p_password_hash text, p_current_token_hash text, p_expected_password_hash text) TO service_role;


--
-- Name: FUNCTION confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_password_reset(p_token_hash text, p_password_hash text, p_now timestamp with time zone) TO service_role;


--
-- Name: FUNCTION create_user_with_role(p_user jsonb, p_role_codes text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_user_with_role(p_user jsonb, p_role_codes text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_user_with_role(p_user jsonb, p_role_codes text[]) TO service_role;


--
-- Name: FUNCTION current_sede_id(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.current_sede_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_sede_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_sede_id() TO service_role;


--
-- Name: FUNCTION deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.deduct_stock_atomic(p_user_id uuid, p_reason text, p_items jsonb) TO service_role;


--
-- Name: FUNCTION discard_created_user(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.discard_created_user(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.discard_created_user(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION ensure_user_has_role(p_user_id uuid, p_role_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ensure_user_has_role(p_user_id uuid, p_role_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_user_has_role(p_user_id uuid, p_role_code text) TO service_role;


--
-- Name: FUNCTION invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_annul_atomic(p_invoice_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_motivo text, p_expected_status text, p_items jsonb) TO service_role;


--
-- Name: FUNCTION invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_create_atomic(p_user_id uuid, p_cash_shift_id uuid, p_idempotency_key text, p_invoice jsonb, p_items jsonb, p_taxes jsonb, p_payments jsonb, p_out_reason text, p_out_items jsonb) TO service_role;


--
-- Name: FUNCTION invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_emitted_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) TO service_role;


--
-- Name: FUNCTION invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_items_atomic(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb) TO service_role;


--
-- Name: FUNCTION invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_split_payment_atomic(p_invoice_id uuid, p_shift_id uuid, p_user_id uuid, p_closed_at timestamp with time zone, p_mark_paid boolean, p_portions jsonb) TO service_role;


--
-- Name: FUNCTION payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.payroll_apply_atomic(p_period_id uuid, p_items jsonb, p_voucher_ids uuid[], p_carry_ids uuid[]) TO service_role;


--
-- Name: FUNCTION payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.payroll_correct_period_atomic(p_period_id uuid, p_correction jsonb, p_items jsonb) TO service_role;


--
-- Name: FUNCTION payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.payroll_delete_period_atomic(p_period_id uuid, p_to_approved uuid[], p_to_pending uuid[]) TO service_role;


--
-- Name: FUNCTION replace_user_roles(p_user_id uuid, p_role_codes text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.replace_user_roles(p_user_id uuid, p_role_codes text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_user_roles(p_user_id uuid, p_role_codes text[]) TO service_role;


--
-- Name: FUNCTION upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.upsert_employee_atomic(p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text) TO service_role;


--
-- PostgreSQL database dump complete
--

