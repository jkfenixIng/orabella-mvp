-- 074_sede_less_constraints.sql — las unicidades y la exclusión dejan de
-- depender de `sede_id`, ANTES de que la columna se borre.
--
-- MOTIVO DEL ARCHIVO
--
-- La 073 relajó `sede_id NOT NULL` en dieciocho tablas. Ese fue el paso
-- correcto y necesario, pero dejó una trampa viva que este archivo cierra.
--
-- En PostgreSQL un `NULL` NO satisface ni una restricción `UNIQUE` ni un
-- `EXCLUDE`: la comparación con `NULL` da `UNKNOWN`, y lo único que se exige
-- para que la fila se acepte es que no haya dos filas que choquen. Por eso la
-- columna ya nulable hace que TODAS las Guarantee que hoy llevan `sede_id` como
-- elemento se apaguen en silencio a partir de la primera fila sin sede:
--
--   * seis `UNIQUE` compuestas —el código repetido de cada catálogo, el SKU,
--     el consecutivo de factura, el nombre de caja, la denominación y el
--     impuesto— dejan de separar dos filas que hoy sí se separan;
--   * `uq_employees_sede_code` deja de separar dos empleados con el mismo
--     código;
--   * `uq_invoices_sede_idempotency_key` deja de separar dos facturas con la
--     misma marca de idempotencia: la carrera que esa índice existe para
--     cerrar vuelve a poder tener dos ganadores, y el 23505 que el servicio traduce en
--     «devuelva la existente» ya no llega nunca;
--   * `ex_payroll_periods_no_overlap`, que compara `sede_id` con `=`, deja de
--     excluir: dos períodos de nómina de la misma cadencia podrían compartir
--     días y un día se nominaría dos veces.
--
-- Nada de eso se ve en los datos: no hay error, no hay aviso, sólo una fila
-- más. Y el orden de la serie lo hace inevitable. La unidad que borra la
-- columna (M3c) sólo puede correr cuando NADIE la escribe; mientras la app
-- siga mandándola, una fila sin sede es improbable pero no imposible (un
-- escritor crudo, un script, una llamada RPC con la lista de columnas
-- incompleta). Esta unidad pone las restricciones en su forma FINAL —de una
-- sola columna— ahora, mientras TODAS las filas todavía tienen sede, que es el
-- único momento en que la operación es barata y verificable: sin datos que
-- mover, sin duplicados que resolver, sin nada que decidir.
--
-- QUÉ HACE ESTE ARCHIVO: SÓLO ESO
--
-- Diez objetos, cada uno reescrito sin `sede_id` y con todos sus demás
-- elementos intactos. Ningún otro cambio: no se escribe, no se borra y no se
-- reescribe ninguna fila.
--
--   Objeto (nombre real, leído en las migraciones)         De              A
--   -------------------------------------------------------- -------------- ----------------
--   `tax_configs_sede_id_code_name_key` (003)               (sede_id,code,  UNIQUE (code,
--                                                           name)          name)
--   `payment_methods_sede_id_code_key` (003)                (sede_id,code)  UNIQUE (code)
--   `products_sede_id_sku_key` (004)                        (sede_id,sku)   UNIQUE (sku)
--   `invoices_sede_id_consecutive_number_key` (005)         (sede_id,       UNIQUE
--                                                           consecutive_   (consecutive_
--                                                           number)        number)
--   `cash_registers_sede_id_name_key` (006)                 (sede_id,name)  UNIQUE (name)
--   `cash_denominations_sede_id_value_key` (010)            (sede_id,value) UNIQUE (value)
--   `uq_employees_sede_code` (003, parcial)                 (sede_id,       (employee_code),
--                                                           employee_code) mismo WHERE
--   `uq_invoices_sede_idempotency_key` (041, parcial)       (sede_id,       (idempotency_key),
--                                                           idempotency_   mismo WHERE
--                                                           key)
--   `uq_payroll_draft_per_range` (007, parcial)             (sede_id,start  (start_date,
--                                                           _date,end_     end_date), mismo
--                                                           date)          WHERE
--   `ex_payroll_periods_no_overlap` (063, EXCLUDE)          (sede_id,       (coalesce(frequency,
--                                                           coalesce(fre   ''), daterange(…
--                                                           quency,''),    …)) — MISMO NOMBRE
--                                                           daterange(…))
--
-- LA REGLA DE LOS NOMBRES (y por qué hay dos criterios y no uno)
--
--   * Las seis PRIMERAS son restricciones `UNIQUE` escritas en línea dentro del
--     `CREATE TABLE`, así que su nombre NO lo eligió una persona: lo derivó
--     PostgreSQL de las columnas (`<tabla>_<columnas>_key`). Derivan del
--     contenido, y el contenido cambió: dejar `tax_configs_sede_id_code_name_key`
--     sobre una definición `UNIQUE (code, name)` pondría una etiqueta falsa en
--     el catálogo y haría que cualquier `\d` mintiera. Se renombran al nombre
--     que PostgreSQL habría derivado de las columnas nuevas.
--   * Los cuatro ÚLTIMOS tienen nombre explícito elegido a mano (`uq_*`, `ex_*`).
--     Se quedan como están: son citados por nombre en migraciones anteriores
--     (003, 007, 041, 063), y el de la exclusión es un CONTRATO de ejecución —
--     `src/features/payroll/service.ts` mapea el SQLSTATE 23P01 a
--     `PERIOD_OVERLAP`, y un nombre distinto rompería el manejo del solape en
--     nómina en silencio. Este archivo no cambia ningún nombre elegido a mano.
--
-- LO QUE ESTE ARCHIVO NO TOCA, Y POR QUÉ IMPORTA QUE SIGA EN PIE
--
--   * `uq_commission_rule` (016), el único otro índice único que empieza por
--     `sede_id`: `(sede_id, item_type, item_id, employee_id)`. NO se reescribe
--     aquí, y la razón es una dependencia del código, no una excepción de
--     estilo: `src/features/commissions/service.ts` (línea 114) sube la regla
--     con `upsert(…, { onConflict: "sede_id,item_type,item_id,employee_id" })`.
--     PostgREST convierte eso en un `ON CONFLICT (sede_id, item_type, item_id,
--     employee_id)`, y la inferencia de `ON CONFLICT` exige que el conjunto de
--     columnas coincida EXACTAMENTE con el de un índice único: al quitarle la
--     sede, ese `upsert` deja de tenerConstraint que lo satisfaga y falla con
--     42P10 («there is no unique or exclusion constraint matching the ON
--     CONFLICT specification») en cada alta y edición de regla de comisión.
--     Cambiar el índice aquí dejaría el negocio de comisiones roto hoy. El
--     cambio correcto es el otro orden: primero el `onConflict` del servicio a
--     `"item_type,item_id,employee_id"`, después el índice. Queda anotado acá
--     para que la unidad que deje de escribir `sede_id` lo traiga consigo; la
--     fila sin sede seguiría evadiendo ese índice, que es exactamente el
--     riesgo que este archivo cierra en los otros diez.
--   * Los índices NO únicos por sede (`idx_*_sede_id`, `idx_products_sede_name`,
--     `idx_products_sede_sku`, `idx_invoices_sede_consecutive`,
--     `idx_commission_rules_lookup`, `idx_payroll_periods_sede_status`): no son
--     garantías de nada. Un índice sobre una columna nula no deduplica ni
--     acepta filas: sólo deja de ser un atajo. Sobreviven a la columna como
--     cualquier otro índice, y se limpian con ella.
--   * Las CLAVES FORÁNEAS a `sedes`: siguen atando la fila a una sede real. Este
--     archivo no las toca.
--   * Las COLUMNAS, su tipo, su nulabilidad y sus claves foráneas.
--   * Los `CHECK` de cada tabla, las funciones, los disparadores y los RPC.
--   * Las POLÍTICAS de seguridad por fila: la sección 5 de este archivo las
--     documenta; ninguna se cambia.
--   * `supabase/test-bootstrap.sql`, que es un volcado independiente y que ya
--     va por detrás de la 041. Este archivo no lo modifica y tampoco está
--     pensado para aplicarse sobre una base construida sólo con ese volcado
--     (necesita el esquema hasta la 073: `payroll_periods.frequency` no existe
--     ahí).
--
-- ORDEN DE EJECUCIÓN Y POR QUÉ ES ESTE
--
--   1. El PRE-VUELO, primero y sólo de lectura. Tiene que abortar sobre un
--      esquema intacto: si el archivo se detiene, que se detenga antes de tocar
--      el primer objeto. Aborta nombrando las filas y NO borra ni fusiona
--      nada: decidir qué hacer con un duplicado es del dueño.
--   2. La EXCLUSIÓN, después del pre-vuelo y antes que las unicidades. Es el
--      único objeto cuyo nombre es un contrato de ejecución (el 23P01 que
--      nómina traduce), así que se deja puesto y verificado lo primero; si
--      falla, las nueve reescrituras siguientes ni siquierathm se intentaron.
--   3. Las seis `UNIQUE` y los tres índices parciales, al final. Cada uno es un
--      par `DROP … IF EXISTS` + `ADD`/`CREATE` independiente, y ninguno de sus
--      nombres lo resuelve el código, así que el orden entre ellos es de
--      lectura, no de dependencia.
--
-- ADITIVO, IDEMPOTENTE Y RE-EJECUTABLE
--
-- Aditivo en el sentido de que no borra datos: quita una restricción y la
-- vuelve a poner. Idempotente: cada paso es `… IF EXISTS` seguido de un
-- `ADD`/`CREATE` de la definición final, de modo que una segunda corrida
-- deja el esquema igual (mismo criterio que 063 y que 038 para los `CHECK`).
-- Donde el nombre cambió se sueltan LOS DOS nombres antes de volver a
-- declararlo, para que una corrida interrumpida no deje una definición vieja
-- con el nombre nuevo.
--
-- NOTA OPERATIVA: EL EDITOR SQL DE SUPABASE CONFIRMA SENTENCIA POR SENTENCIA
--
-- Pegado en el editor de la consola (que confirma cada sentencia por separado,
-- sin transacción que las agrupe), un fallo a mitad del archivo deja el
-- esquema a medias: el pre-vuelo ya pasó, algunos objetos ya están en su forma
-- final y otros siguen compuestos. Eso es seguro —el estado intermedio es
-- «algunas garantías ya sin sede», que es estrictamente mejor que «ninguna sin
-- sede» y nunca peor que el estado de partida— y se corrige volviendo a
-- correr el archivo entero: cada paso es `IF EXISTS` + aditivo y el pre-vuelo
-- vuelve a evaluarse sobre los datos que ya están. Lo que NO se debe hacer es
-- dejar el archivo a medias y seguir: la exclusión de nómina queda en el mismo
-- nombre siempre, pero su definición sólo es la final después de la segunda
-- sentencia de la sección 3.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. PRE-VUELO: nueve colisiones y un solape, antes de cambiar nada
-- ===================================================================== ---
--
-- Patrón de 035 (`035_payroll_period_proration.sql`), que es el que evita el
-- 23P01 sin nombre: PostgreSQL abortaría el `ADD CONSTRAINT` con un mensaje
-- que no dice qué filas chocan. Acá se listan primero, y el archivo no cambia
-- ni una fila para convertirlas en un índice válido: la decisión de qué fila
-- sobra (borrarla, corregir su clave, ajustar sus fechas) es del dueño.
--
-- Cada consulta devuelve NULL cuando no hay choques, o un texto con hasta
-- CINCO grupos en conflicto y los `id` de cada fila. Las filas que el índice
-- parcial no cubre (código de empleado vacío, marca de idempotencia nula,
-- período ya cerrado) quedan fuera de su chequeo, igual que quedan fuera del
-- índice: el pre-vuelo replica el `WHERE` exacto de cada índice parcial, no
-- una versión aproximada.
DO $$
DECLARE
  v_ch      record;
  v_detalle text;
  v_tocados integer := 0;
  v_informe text := '';
BEGIN
  FOR v_ch IN
    SELECT *
      FROM (VALUES
        -- Las seis UNIQUE compuestas que pasan a ser de una sola columna.
        ('tax_configs_sede_id_code_name_key -> UNIQUE (code, name)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT code || E' / ' || name || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.tax_configs
                GROUP BY code, name
               HAVING count(*) > 1
                ORDER BY code, name
                LIMIT 5) s$q$),
        ('payment_methods_sede_id_code_key -> UNIQUE (code)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT code || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.payment_methods
                GROUP BY code
               HAVING count(*) > 1
                ORDER BY code
                LIMIT 5) s$q$),
        ('products_sede_id_sku_key -> UNIQUE (sku)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT sku || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.products
                GROUP BY sku
               HAVING count(*) > 1
                ORDER BY sku
                LIMIT 5) s$q$),
        ('invoices_sede_id_consecutive_number_key -> UNIQUE (consecutive_number)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT consecutive_number::text || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.invoices
                GROUP BY consecutive_number
               HAVING count(*) > 1
                ORDER BY consecutive_number
                LIMIT 5) s$q$),
        ('cash_registers_sede_id_name_key -> UNIQUE (name)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT name || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.cash_registers
                GROUP BY name
               HAVING count(*) > 1
                ORDER BY name
                LIMIT 5) s$q$),
        ('cash_denominations_sede_id_value_key -> UNIQUE (value)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT value::text || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.cash_denominations
                GROUP BY value
               HAVING count(*) > 1
                ORDER BY value
                LIMIT 5) s$q$),
        -- Los tres índices parciales, con SU WHERE exacto.
        ('uq_employees_sede_code -> (employee_code, WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '''')',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT employee_code || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.employees
                WHERE employee_code IS NOT NULL AND btrim(employee_code) <> ''
                GROUP BY employee_code
               HAVING count(*) > 1
                ORDER BY employee_code
                LIMIT 5) s$q$),
        ('uq_invoices_sede_idempotency_key -> (idempotency_key, WHERE idempotency_key IS NOT NULL)',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT idempotency_key::text || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.invoices
                WHERE idempotency_key IS NOT NULL
                GROUP BY idempotency_key
               HAVING count(*) > 1
                ORDER BY idempotency_key
                LIMIT 5) s$q$),
        ('uq_payroll_draft_per_range -> (start_date, end_date, WHERE status = 'borrador')',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT start_date::text || E' a ' || end_date::text || E' -> filas ' || string_agg(id::text, ', ' ORDER BY id) AS detalle
                 FROM public.payroll_periods
                WHERE status = 'borrador'
                GROUP BY start_date, end_date
               HAVING count(*) > 1
                ORDER BY start_date, end_date
                LIMIT 5) s$q$),
        -- La exclusión: dos períodos de la MISMA cadencia con días en común.
        ('ex_payroll_periods_no_overlap -> (coalesce(frequency, '''') x daterange(start_date, end_date, '[]''))',
         $q$SELECT nullif(string_agg(detalle, E' ; '), '') FROM (
               SELECT coalesce(a.frequency, '(sin cadencia)') || E': ' || a.id::text
                      || E' [' || a.start_date::text || E' a ' || a.end_date::text || E'] x '
                      || b.id::text || E' [' || b.start_date::text || E' a ' || b.end_date::text || E']'
                      || E' (estado ' || coalesce(a.status, '?') || E' / ' || coalesce(b.status, '?') || E')' AS detalle
                 FROM public.payroll_periods a
                 JOIN public.payroll_periods b
                   ON coalesce(a.frequency, '') = coalesce(b.frequency, '')
                  AND a.id < b.id
                  AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
                ORDER BY a.start_date, b.start_date
                LIMIT 5) s$q$)
      ) AS t(etiqueta, consulta)
  LOOP
    EXECUTE v_ch.consulta INTO v_detalle;

    IF v_detalle IS NOT NULL THEN
      v_tocados := v_tocados + 1;
      v_informe := v_informe || E'\n  * ' || v_ch.etiqueta || ': ' || v_detalle;
    END IF;
  END LOOP;

  IF v_tocados > 0 THEN
    RAISE EXCEPTION E'migración 074 ABORTADA: % definición(es) no se pueden escribir sin `sede_id` porque los datos de hoy ya las violan. No se borró, no se fusionó y no se reescribió ninguna fila, y ningún objeto del esquema fue tocado.\n  QUÉ HACER: revise cada grupo listado, decida cuál fila conserva la clave (corrija su código, su SKU, su número, su marca o sus fechas, o borre la fila sobrante si de verdad sobra) y vuelva a correr el archivo completo. La exclusión de nómina no se negocia: dos períodos de la misma cadencia NO pueden compartir días, así que un solape se resuelve cerrando uno de los dos períodos, no ajustando la fecha de los dos.\n  Definiciones que chocan:%',
      v_tocados, v_informe
      USING ERRCODE = '23514',
            HINT = 'Cada objeto que este archivo reescribe tiene hoy su elemento `sede_id`; sin él, la garantía es GLOBAL a la instalación. Los choques listados son filas que hoy coexisten porque `sede_id` las separaba, y que sin `sede_id` serían la misma fila dos veces.';
  END IF;
END $$;

-- ===================================================================== ---
-- 2. `ex_payroll_periods_no_overlap`: MISMO NOMBRE, sin `sede_id`
-- ===================================================================== ---
--
-- `btree_gist` es la extensión contrib que le da a `gist` los operadores que
-- necesita: sin ella `gist` no sabe comparar `text` (el cubo de cadencia) ni
-- `daterange` (el rango de días). La creó la 035 y sigue instalada; la línea es
-- idempotente y deja este archivo con su dependencia DECLARADA en vez de
-- heredada.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Un día se nomina una sola vez DENTRO DE LA MISMA CADENCIA. Lo que define la
-- garantía son los dos elementos que quedan —el cubo de cadencia y el rango
-- inclusivo de días— y ninguno de los dos se toca. Lo que sale es `sede_id`,
-- que en una instalación de una sola sede era un elemento redundante: como
-- elemento de una exclusión, `sede_id WITH =` sobre una columna NULABLE se
-- apaga solo (NULL no es igual a nada), de modo que en cuanto existiera una
-- fila sin sede la garantía se iba sin ruido. Quitándolo ahora, la fila sin
-- sede —que hoy no existe— seguiría formando parte de la garantía en vez de escapar.
--
-- MISMO NOMBRE, y no por gusto: `src/features/payroll/service.ts` traduce el
-- SQLSTATE 23P01 a `PERIOD_OVERLAP`, y ese mapeo es por CÓDIGO, no por nombre —
-- pero la identidad del objeto (`pg_constraint.conname`) es lo que el
-- diagnóstico y los comentarios del dominio (`src/features/payroll/README.md`)
-- usan para hablar de la garantía, y un nombre distinto haría que el dominio
-- y la base dejaran de hablar del mismo objeto. 063 ya la reemplazó en el
-- mismo nombre cuando le agregó la cadencia; este archivo repite el patrón.
ALTER TABLE public.payroll_periods
  DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap;

ALTER TABLE public.payroll_periods
  ADD CONSTRAINT ex_payroll_periods_no_overlap
  EXCLUDE USING gist (
    coalesce(frequency, '') WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

COMMENT ON CONSTRAINT ex_payroll_periods_no_overlap ON public.payroll_periods IS
  'F1: un día se nomina una sola vez DENTRO DEL MISMO CICLO (074). Dos períodos de la MISMA cadencia no pueden compartir días: el rango es inclusivo y la cadencia se compara con coalesce(frequency, '''') para que los períodos sin cadencia (NULL) sigan siendo mutuamente excluyentes entre sí. Ciclos distintos (semanal y mensual) sí pueden superponerse. El elemento `sede_id` se retiró en 074 porque, siendo la columna nulable, dejaba de participar en la comparación (NULL no es igual a nada) y la garantía se perdía en silencio; la instalación es de una sola sede, así que el elemento era redundante.';

-- ===================================================================== ---
-- 3. Las seis UNIQUE compuestas, sin `sede_id`
-- ===================================================================== ---
--
-- Cada bloque suelta el nombre viejo (el derivado por PostgreSQL de las
-- columnas con sede) y el nombre nuevo (el que la misma versión de PostgreSQL
-- derivaría de las columnas sin sede), y recién ahí declara la restricción.
-- Soltar los dos antes de declarar es lo que hace la segunda corrida idéntica
-- a la primera y lo que impide que una corrida interrumpida deje una
-- definición compuesta con el nombre nuevo.
--
-- Lo que se conserva de cada una, además de las columnas: el nombre de la
-- tabla, el nombre de la restricción en su forma derivada correcta, y —en las
-- que lo tienen— el `COMMENT` de columna que explica la regla de negocio. La
-- regla no cambia: en una instalación de una sola sede, «único por sede» y
-- «único» son la misma frase.

-- ADM-06: los impuestos configurables. El código sigue siendo la lista
-- cerrada (IVA/ICA/Rete/otro) por el CHECK, no por el índice.
ALTER TABLE public.tax_configs
  DROP CONSTRAINT IF EXISTS tax_configs_sede_id_code_name_key,
  DROP CONSTRAINT IF EXISTS tax_configs_code_name_key;

ALTER TABLE public.tax_configs
  ADD CONSTRAINT tax_configs_code_name_key UNIQUE (code, name);

COMMENT ON COLUMN public.tax_configs.code IS
  'ADM-06: tipo de impuesto de la lista cerrada del CHECK (IVA, ICA, Rete, otro). UNIQUE (code, name) —sin sede desde 074, porque la instalación es de una sola sede— impide repetir un impuesto con el mismo nombre.';

-- ADM-07: los métodos de pago. El CHECK de la lista cerrada no se toca.
ALTER TABLE public.payment_methods
  DROP CONSTRAINT IF EXISTS payment_methods_sede_id_code_key,
  DROP CONSTRAINT IF EXISTS payment_methods_code_key;

ALTER TABLE public.payment_methods
  ADD CONSTRAINT payment_methods_code_key UNIQUE (code);

-- INV-01: el SKU. El servicio lo normaliza (trim + mayúsculas) antes de
-- escribirlo, así que la unicidad real es sobre el SKU ya normalizado.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_sede_id_sku_key,
  DROP CONSTRAINT IF EXISTS products_sku_key;

ALTER TABLE public.products
  ADD CONSTRAINT products_sku_key UNIQUE (sku);

COMMENT ON COLUMN public.products.sku IS
  'INV-01: SKU único (UNIQUE sku; la unicidad por sede de 004 se cerró a una sola columna en 074 porque la instalación es de una sola sede). El servicio lo normaliza (trim + mayúsculas) antes de guardar.';

-- FAC-05: el consecutivo. La fila del contador ya no es por sede (072 la mudó a
-- system_settings), así que el único que lo protege es este UNIQUE.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_sede_id_consecutive_number_key,
  DROP CONSTRAINT IF EXISTS invoices_consecutive_number_key;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_consecutive_number_key UNIQUE (consecutive_number);

COMMENT ON COLUMN public.invoices.consecutive_number IS
  'FAC-05: consecutivo sin huecos ni duplicados. Se reserva con next_invoice_number() (que desde 072 bloquea la fila ''invoice_sequence'' de system_settings) e inserta inmediatamente; UNIQUE (consecutive_number) —sin sede desde 074, porque la instalación es de una sola sede— impide el duplicado.';

-- CAJ-04: el nombre de la caja. 006 sembraba una «Caja única» por sede; con la
-- instalación de una sola sede queda una fila y el nombre es su identidad.
ALTER TABLE public.cash_registers
  DROP CONSTRAINT IF EXISTS cash_registers_sede_id_name_key,
  DROP CONSTRAINT IF EXISTS cash_registers_name_key;

ALTER TABLE public.cash_registers
  ADD CONSTRAINT cash_registers_name_key UNIQUE (name);

-- CASH: la denominación. `value` es la clave del conteo; el `kind` sigue siendo
-- un dato descriptivo y no forma parte de la unicidad (mismo criterio que antes).
ALTER TABLE public.cash_denominations
  DROP CONSTRAINT IF EXISTS cash_denominations_sede_id_value_key,
  DROP CONSTRAINT IF EXISTS cash_denominations_value_key;

ALTER TABLE public.cash_denominations
  ADD CONSTRAINT cash_denominations_value_key UNIQUE (value);

COMMENT ON TABLE public.cash_denominations IS
  'CASH: denominaciones de efectivo para el conteo por denominación. UNIQUE (value) desde 074 (antes `sede_id` + `value`, y la instalación es de una sola sede).';

-- ===================================================================== ---
-- 4. Los tres índices únicos parciales, sin `sede_id`
-- ===================================================================== ---
--
-- Mismo nombre, mismo `WHERE` EXACTO, una columna menos. El `WHERE` se copia
-- al carácter: es lo que decide qué filas entran al índice, y cambiarlo ahí
-- cambiaría el alcance de la garantía sin que nadie lo pidiera.
--
-- Mismo nombre porque son nombres elegidos a mano (`uq_*`), citados por nombre
-- en las migraciones que los crearon (003, 007, 041) y en los comentarios de
-- columna que explican la regla. Este archivo no cambia ningún nombre
-- elegido a mano: sólo le saca una columna.

-- ADM-03: código interno del empleado. Parcial: vacío o nulo se puede
-- repetir (hay personal sin código); con valor, único en la instalación.
DROP INDEX IF EXISTS public.uq_employees_sede_code;

CREATE UNIQUE INDEX uq_employees_sede_code
  ON public.employees (employee_code)
  WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';

-- 041: la marca de idempotencia de la factura. Parcial: la marca nula (filas
-- históricas) queda fuera y no deduplica nada, que es lo que la marca de la
-- carrera necesita. Sin `sede_id`, una misma marca ya no puede abrirse dos
-- veces en dos sedes distintas.
DROP INDEX IF EXISTS public.uq_invoices_sede_idempotency_key;

CREATE UNIQUE INDEX uq_invoices_sede_idempotency_key
  ON public.invoices (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 007: un solo borrador por rango de fechas. Sigue siendo la barrera final
-- ante la carrera de «abrir el mismo rango dos veces»; el servicio la rechaza
-- antes con PERIOD_DRAFT_EXISTS.
DROP INDEX IF EXISTS public.uq_payroll_draft_per_range;

CREATE UNIQUE INDEX uq_payroll_draft_per_range
  ON public.payroll_periods (start_date, end_date)
  WHERE status = 'borrador';

-- ===================================================================== ---
-- 5. LAS POLÍTICAS DE SEGURIDAD POR FILA (documentación: no se cambian)
-- ===================================================================== ---
--
-- Estas políticas comparan `sede_id` con `public.current_sede_id()` (008), que
-- devuelve el `uuid` del claim `app_metadata.sede_id` o NULL. Una comparación
-- con NULL da FALSE, no TRUE: una fila sin sede es INVISIBLE para un cliente
-- `authenticated`, en `USING` (no se lee) y en `WITH CHECK` (no se escribe).
-- Sobre las tablas que este archivo toca, son estas:
--
--   * `pol_tax_configs_sede_isolation`, `pol_payment_methods_sede_isolation`,
--     `pol_products_sede_isolation`, `pol_invoices_sede_isolation`,
--     `pol_cash_registers_sede_isolation` (008) y
--     `pol_cash_denominations_sede_isolation` (017): `sede_id =
--     current_sede_id()` directo.
--   * `pol_employees_sede_isolation` y `pol_payroll_periods_sede_isolation`
--     (008): directo, sobre los otros dos objetos reescritos.
--
-- Y heredan el mismo efecto, por el `EXISTS` sobre la sede del padre:
-- `pol_invoice_items_sede_isolation`, `pol_invoice_taxes_sede_isolation`,
-- `pol_invoice_payments_sede_isolation` (vía `invoices`),
-- `pol_payroll_items_sede_isolation` y `pol_payroll_payments_sede_isolation`
-- (vía `payroll_periods`) y `pol_user_roles_sede_isolation`,
-- `pol_sessions_sede_isolation`, `pol_password_resets_sede_isolation` (vía
-- `users`).
--
-- POR QUÉ ESTO NO ES UN CAMBIO DE ESTA UNIDAD, SINO UNA CONSTATACIÓN
--
-- La aplicación NO depende de esas políticas: todo su tráfico sale por
-- `createAdminClient()` (`src/shared/lib/supabase/server.ts`), que usa
-- `service_role` y hace bypass de RLS por diseño. El cliente que sí evalúa
-- RLS (`createClient()` del mismo archivo, con la anon key y las cookies) no
-- lo importa nadie, y el propio archivo lo dice: «Hoy NO lo importa nadie […]
-- las políticas por sede del esquema NO se evalúan nunca». Por lo tanto,
-- dejar o no dejar `sede_id` en las políticas no cambia lo que la aplicación
-- ve ni lo que puede escribir, y este archivo no las toca.
--
-- Lo que SÍ conviene que quede escrito para el dueño: si algún día la app
-- migra a RLS (el camino que ese mismo archivo describe), el día en que una
-- fila quede sin sede esa fila se vuelve invisible para el cliente JWT, que es
-- un modo de falla distinto al de este archivo —no es una garantía que se
-- apague, es una fila que desaparece— y eso hay que resolverlo en la misma
-- unidad que introduce las filas sin sede, no después.

-- ===================================================================== ---
-- 6. Cómo verifica el dueño (sólo lectura)
-- ===================================================================== ---
--
-- Las consultas siguientes NO cambian nada: se copian y se ejecutan tal cual en
-- el editor de la consola.

-- 6.1 Las seis UNIQUE: cada tabla debe mostrar UNA restricción y con las
--     columnas sin sede. `conkey` se traduce con `pg_get_constraintdef`, que
--     imprime la definición tal como la entiende PostgreSQL.
--   SELECT conrelid::regclass AS tabla, conname, pg_get_constraintdef(oid) AS definicion
--     FROM pg_constraint
--    WHERE conrelid IN ('public.tax_configs'::regclass, 'public.payment_methods'::regclass,
--                       'public.products'::regclass, 'public.invoices'::regclass,
--                       'public.cash_registers'::regclass, 'public.cash_denominations'::regclass)
--      AND contype = 'u'
--    ORDER BY conrelid::regclass::text, conname;

-- 6.2 Los índices: los tres parciales, su nombre y su `WHERE`.
--   SELECT indexname, indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname IN ('uq_employees_sede_code', 'uq_invoices_sede_idempotency_key',
--                        'uq_payroll_draft_per_range')
--    ORDER BY indexname;

-- 6.3 La exclusión: UNA fila con ese nombre, y su definición con los DOS
--     elementos y con `sede_id` ausente.
--   SELECT conname, pg_get_constraintdef(oid) AS definicion
--     FROM pg_constraint
--    WHERE conrelid = 'public.payroll_periods'::regclass
--      AND conname = 'ex_payroll_periods_no_overlap';

-- 6.4 Que no quedó ningún índice único ni exclusión que empiece por `sede_id`
--     fuera del caso declarado de `uq_commission_rule` (016), que sigue
--     compuesto a propósito porque `commissions/service.ts` infiere su
--     `ON CONFLICT` con las cuatro columnas.
--   SELECT indexname, indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexdef LIKE 'CREATE UNIQUE%'
--      AND indexdef LIKE '%(sede_id%'
--    ORDER BY indexname;

--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE contype = 'x'
--      AND pg_get_constraintdef(oid) LIKE '%sede_id%';

-- 6.5 Que las claves foráneas a `sedes` siguen en pie, con su nombre: son las
--     que impiden que una fila quede apuntando a una sede que no existe.
--   SELECT c.conname AS clave, cl.relname AS tabla
--     FROM pg_constraint c
--     JOIN pg_class cl ON cl.oid = c.conrelid
--     JOIN pg_namespace n ON n.oid = cl.relnamespace
--     JOIN unnest(c.conkey) AS k(attnum) ON true
--     JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
--    WHERE c.contype = 'f'
--      AND n.nspname = 'public'
--      AND a.attname = 'sede_id'
--    ORDER BY cl.relname, c.conname;

-- 6.6 Prueba funcional con filas de prueba (nunca con las reales): dos
--     períodos de la misma cadencia con un día en común deben fallar con
--     23P01; dos facturas con el mismo consecutivo también.

-- ===================================================================== ---
-- 7. Cómo se revierte
-- ===================================================================== ---
--
-- Es la operación inversa, objeto por objeto. Se anota completa para que la
-- vuelta atrás no dependa de que nadie recuerde la lista.
--
--   -- La exclusión, en el mismo nombre (075 o el archivo que corresponda):
--   ALTER TABLE public.payroll_periods
--     DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap;
--   ALTER TABLE public.payroll_periods
--     ADD CONSTRAINT ex_payroll_periods_no_overlap
--     EXCLUDE USING gist (
--       sede_id WITH =,
--       coalesce(frequency, '') WITH =,
--       daterange(start_date, end_date, '[]') WITH &&
--     );
--
--   -- Las seis UNIQUE compuestas:
--   ALTER TABLE public.tax_configs
--     DROP CONSTRAINT IF EXISTS tax_configs_code_name_key,
--     ADD CONSTRAINT tax_configs_sede_id_code_name_key UNIQUE (sede_id, code, name);
--   ALTER TABLE public.payment_methods
--     DROP CONSTRAINT IF EXISTS payment_methods_code_key,
--     ADD CONSTRAINT payment_methods_sede_id_code_key UNIQUE (sede_id, code);
--   ALTER TABLE public.products
--     DROP CONSTRAINT IF EXISTS products_sku_key,
--     ADD CONSTRAINT products_sede_id_sku_key UNIQUE (sede_id, sku);
--   ALTER TABLE public.invoices
--     DROP CONSTRAINT IF EXISTS invoices_consecutive_number_key,
--     ADD CONSTRAINT invoices_sede_id_consecutive_number_key UNIQUE (sede_id, consecutive_number);
--   ALTER TABLE public.cash_registers
--     DROP CONSTRAINT IF EXISTS cash_registers_name_key,
--     ADD CONSTRAINT cash_registers_sede_id_name_key UNIQUE (sede_id, name);
--   ALTER TABLE public.cash_denominations
--     DROP CONSTRAINT IF EXISTS cash_denominations_value_key,
--     ADD CONSTRAINT cash_denominations_sede_id_value_key UNIQUE (sede_id, value);
--
--   -- Los tres índices parciales, cada uno con su WHERE original:
--   DROP INDEX IF EXISTS public.uq_employees_sede_code;
--   CREATE UNIQUE INDEX uq_employees_sede_code
--     ON public.employees (sede_id, employee_code)
--     WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';
--   DROP INDEX IF EXISTS public.uq_invoices_sede_idempotency_key;
--   CREATE UNIQUE INDEX uq_invoices_sede_idempotency_key
--     ON public.invoices (sede_id, idempotency_key)
--     WHERE idempotency_key IS NOT NULL;
--   DROP INDEX IF EXISTS public.uq_payroll_draft_per_range;
--   CREATE UNIQUE INDEX uq_payroll_draft_per_range
--     ON public.payroll_periods (sede_id, start_date, end_date)
--     WHERE status = 'borrador';
--
-- PRECONDICIÓN DE LA VUELTA ATRÁS (sólo lectura): tiene que dar 0 en cada una,
-- porque volver a componer por sede es legítimo sólo si ninguna fila quedó sin
-- sede. Las dos que importan son las que 073 dejó nulables:
--
--   SELECT count(*) FROM public.invoices WHERE sede_id IS NULL;  -- 0
--   SELECT count(*) FROM public.payroll_periods WHERE sede_id IS NULL;  -- 0
--   SELECT count(*) FROM public.employees WHERE sede_id IS NULL;  -- 0