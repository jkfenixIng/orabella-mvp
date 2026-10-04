-- 075_commission_rule_install_key.sql — la regla de comisión se identifica en
-- TODA la instalación: un (ítem × empleado) es una sola regla, sin sede.
--
-- MOTIVO DEL ARCHIVO
--
-- `commission_rules` declara desde 016 el único índice único que quedaba
-- compuesto por sede: `uq_commission_rule (sede_id, item_type, item_id,
-- employee_id)`. La 074 cerró el mismo problema en los otros nueve objetos —
-- las unicidades dejan de depender de `sede_id` ANTES de que la columna se
-- borre— y dejó este último índice deliberadamente fuera, con el motivo escrito
-- en su propio encabezado:
--
--   `src/features/commissions/service.ts` sube la regla con
--   `upsert(…, { onConflict: "sede_id,item_type,item_id,employee_id" })`.
--   PostgREST lo convierte en un `ON CONFLICT (sede_id, item_type, item_id,
--   employee_id)` y la INFERENCIA de `ON CONFLICT` exige que el conjunto de
--   columnas coincida EXACTAMENTE con el de un índice único: sin `sede_id` en el
--   índice, ese `upsert` se queda sin constraint que lo satisfaga y falla con
--   42P10 en cada alta y cada edición de regla.
--
-- O sea: el índice NO se puede reescribir antes que el código. Al revés de lo
-- que parece intuitivo, la regla de orden de esta serie es
--
--   ÍNDICE (o su equivalente) PRIMERO, CÓDIGO DESPUÉS,
--
-- y este archivo es el primer paso de esa pareja: declara la garantía nueva sin
-- quitar la vieja, y el cambio del `onConflict` a `"item_type,item_id,
-- employee_id"` viene con él en la misma unidad. La 074 aplicó la misma
-- disciplina (el índice se reescribió cuando su código ya no dependía de la
-- columna) y las dos mitades tienen que quedar escritas juntas: una de ellas
-- sola deja el esquema y el código hablando de índices distintos.
--
-- POR QUÉ ESTE ARCHIVO NO QUITA `uq_commission_rule`
--
-- Es la parte del trabajo que parece una omisión y no lo es. Quitarla acá rompe
-- el negocio de comisiones, por una ventana de despliegue y no por una decisión
-- de diseño:
--
--   * La migración se aplica a la base; el código se despliega después. Entre
--     una cosa y la otra hay una base con el índice viejo DROPEADO y una
--     versión desplegada que sigue mandando
--     `ON CONFLICT (sede_id, item_type, item_id, employee_id)`. Cada alta y
--     cada edición de regla muere con 42P10, sin fila y sin mensaje de negocio.
--   * Un rollback de despliegue deja el síntoma en el lado opuesto: código
--     nuevo (`item_type,item_id,employee_id`) contra un esquema al que este
--     archivo todavía no se le aplicó, y el mismo 42P10.
--
-- Un índice único que sobra no estorba: `uq_commission_rule` y
-- `uq_commission_rule_install_key` dicen hoy lo MISMO sobre las filas que
-- existen (todas con sede, desde que 073 relajó la columna), así que ninguno de
-- los dos admite un duplicado ni lo oculta. Lo que sí hace un índice de más es
-- mantener en pie una etiqueta falsa sobre el catálogo y, peor, un
-- `ON CONFLICT` viejo que nadie está usando. Eso se limpia en la migración
-- final de una sola sede (M3c), que es la única que puede hacerlo sin ventana:
-- para entonces `sede_id` no se escribe ni se lee, así que no queda ningún
-- `onConflict` que lo nombre.
--
-- QUÉ HACE ESTE ARCHIVO: SÓLO ESO
--
--   * Un pre-vuelo de sólo lectura que aborta nombrando las filas si el índice
--     nuevo no se puede escribir con los datos de hoy.
--   * Un índice único: `uq_commission_rule_install_key (item_type, item_id,
--     employee_id)`, que es el conjunto de columnas que el `upsert` del
--     servicio infiere con la 075 ya escrita en el código.
--   * El `COMMENT ON INDEX` que deja escrito, en el catálogo y no sólo acá, qué
--     es este objeto y qué pasa con el otro.
--
-- No hay ninguna otra sentencia: no se escribe, no se borra y no se reescribe
-- ninguna fila; no se toca `commission_payouts`, ni el índice NO único de
-- búsqueda `idx_commission_rules_lookup (sede_id, item_type, item_id)`, ni las
-- columnas, ni sus `CHECK`, ni sus claves foráneas, ni las políticas. Ese
-- índice de búsqueda se limpia con la columna en M3c, no acá: seguir usándolo
-- como atajo por sede es correcto mientras la columna exista.
--
-- EL NOMBRE, Y POR QUÉ NO ES EL VIEJO
--
-- `uq_commission_rule` describe una regla POR SEDE; este describe una regla
-- POR INSTALACIÓN. Son objetos distintos con la misma clase (`uq_*`, la
-- convención del repo para los índices únicos con nombre elegido a mano) y
-- por eso nombre distinto: dejar el nombre viejo sobre una definición sin sede
-- pondría una etiqueta falsa en el catálogo, haría que cualquier `\d` mintiera
-- y volvería indistinguible el objeto que 074 dejó a propósito del que esta
-- unidad crea. Mismo criterio que la 074 con las seis restricciones cuyo nombre
-- deriva PostgreSQL de las columnas.
--
-- ADITIVO, IDEMPOTENTE Y RE-EJECUTABLE
--
-- Aditivo: agrega un índice y nada más; ninguna fila cambia y ninguna deja de
-- poder leerse. Idempotente y re-ejecutable: el índice se suelta por su nombre con
-- `DROP INDEX IF EXISTS` y se vuelve a declarar con la definición final, así que
-- una segunda corrida deja el esquema igual y una corrida interrumpida no deja
-- una definición vieja con el nombre nuevo (mismo criterio que 074 en sus tres
-- índices parciales).
--
-- NOTA OPERATIVA: EL EDITOR SQL DE SUPABASE CONFIRMA SENTENCIA POR SENTENCIA
--
-- Pegado en el editor de la consola, un fallo entre el pre-vuelo y el
-- `CREATE UNIQUE INDEX` deja la base sin la garantía nueva. Eso es SEGURO —
-- el índice viejo sigue en pie y el código viejo sigue funcionando— y se
-- corrige volviendo a correr el archivo entero: el pre-vuelo vuelve a evaluarse
-- sobre los datos que ya están y el paso del índice es aditivo.
--
-- NUMERACIÓN: 075 es el siguiente libre (la serie llega a
-- `074_sede_less_constraints.sql`). Este archivo NO renumera ni toca ningún
-- archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. PRE-VUELO: sin esto, el `CREATE UNIQUE INDEX` de abajo fallaría con
--    23505 y un mensaje que no dice QUÉ reglas chocan ni QUÉ hacer.
-- ===================================================================== ---
--
-- Patrón de 070 y de 074: primero se listan los choques, después se declara el
-- índice. Acá no se borra, no se fusiona y no se reescribe ninguna fila —
-- decidir cuál regla sobra (borrarla, corregir su ítem o su empleado) es del
-- dueño—: el archivo sólo se detiene antes de tocar el primer objeto.
--
-- El pre-vuelo corre sobre el conjunto SIN `sede_id` (que es el del índice
-- nuevo). Hoy no puede encontrar nada: mientras toda fila tenga sede, dos
-- filas con el mismo (ítem, empleado) en sedes distintas ya violan
-- `uq_commission_rule` y no pueden existir. Se escribe igual, y por la misma
-- razón por la que 074 no lo saltó: `sede_id` es nulable desde 073, así que la
-- fila sin sede —un escritor crudo, un script, una llamada RPC con la lista de
-- columnas incompleta— es improbable pero no imposible, y cuando llegue no debe
-- encontrarse con un índice que no se puede crear.
DO $$
DECLARE
  v_chocan integer;
  v_detalle text;
BEGIN
  SELECT count(*)
    INTO v_chocan
    FROM (
      SELECT 1
        FROM public.commission_rules
       GROUP BY item_type, item_id, employee_id
      HAVING count(*) > 1
    ) AS d;

  IF v_chocan > 0 THEN
    -- Detalle acotado y legible: la clave que choca y las filas que la
    -- comparten, con su id y su sede, para que el dueño sepa cuál corregir.
    SELECT string_agg(
             format('  %s × %s × %s — %s fila(s): %s', d.item_type, d.item_id, d.employee_id,
                    d.repetidas, d.filas),
             E'\n' ORDER BY d.item_type, d.item_id, d.employee_id)
      INTO v_detalle
      FROM (
        SELECT item_type, item_id, employee_id,
               count(*) AS repetidas,
               string_agg(format('%s [sede %s]', id, coalesce(sede_id::text, '(sin sede)')), ', ' ORDER BY created_at, id) AS filas
          FROM public.commission_rules
         GROUP BY item_type, item_id, employee_id
        HAVING count(*) > 1
      ) AS d;

    RAISE EXCEPTION E'migración 075 ABORTADA: % combinación(es) de (ítem, empleado) tienen MÁS DE UNA regla, y el índice único de la instalación no se puede crear con datos que lo violan (PostgreSQL responde 23505). No se borró, no se fusionó y no se reescribió ninguna fila, y ningún objeto del esquema fue tocado.\n  QUÉ HACER: revise cada grupo listado, decida qué regla se conserva (corrija su ítem o su empleado, o borre la fila sobrante si de verdad sobra) y vuelva a correr el archivo completo.\n  Reglas repetidas:\n%',
      v_chocan, v_detalle
      USING ERRCODE = '23505',
            HINT = 'Sin sede, «una regla por sede» y «una regla por instalación» son la misma frase: la garantía pasa a ser GLOBAL. Los choques listados son reglas que hoy coexisten porque `sede_id` las separaba.';
  END IF;
END $$;

-- ===================================================================== ---
-- 2. La garantía nueva: un (ítem × empleado) es UNA regla en la instalación
-- ===================================================================== ---
--
-- Otro nombre, sin `sede_id`, con los otros tres elementos intactos. Es el
-- conjunto exacto que el `upsert` de `src/features/commissions/service.ts`
-- infiere en su `onConflict` desde esta unidad, y por eso el nombre NO puede
-- ser el de 016: los dos objetos conviven durante la ventana de despliegue y
-- tienen que poder distinguirse en el catálogo.
--
-- La regla de negocio no cambia: en una instalación de una sola sede, «único
-- por sede» y «único» son la misma frase. Lo que cambia es que la fila sin sede
-- —que hoy no existe, pero que 073 volvió posible— pasa a formar parte de la
-- garantía en vez de escapar de ella en silencio.
DROP INDEX IF EXISTS public.uq_commission_rule_install_key;

CREATE UNIQUE INDEX uq_commission_rule_install_key
  ON public.commission_rules (item_type, item_id, employee_id);

COMMENT ON INDEX public.uq_commission_rule_install_key IS
  'COM: un (ítem × empleado) es UNA sola regla en toda la instalación (075). Reemplaza a `uq_commission_rule` (016), que además de `sede_id` ya no forma parte de la garantía desde que la columna es nulable (073): los tres elementos de este son los que infiere el `onConflict` del `upsert` en `src/features/commissions/service.ts`, y la coincidencia tiene que ser exacta o PostgreSQL responde 42P10. `uq_commission_rule` sigue en pie hasta la migración final de una sola sede (M3c), que lo quita con `DROP INDEX IF EXISTS public.uq_commission_rule;` en la misma unidad que borra la columna.';

-- ===================================================================== ---
-- 3. LO QUE FALTA: EL ÍNDICE VIEJO, Y DÓNDE ESTÁ ANOTADO
-- ===================================================================== ---
--
-- Lo que este archivo NO borra y hay que borrar después, en la migración final
-- de una sola sede (la que quita la columna `sede_id`, M3c), junto con los
-- demás índices por sede (`idx_commission_rules_lookup` incluido):
--
--   DROP INDEX IF EXISTS public.uq_commission_rule;
--
-- Por qué allá y no acá: mientras `sede_id` exista y el servicio pueda
-- desplegarse con el `onConflict` viejo, quitar el índice abre la ventana de
-- 42P10 descrita en el encabezado. En M3c ya no la hay, porque nadie escribe ni
-- infiere la columna.
--
-- DÓNDE ESTÁ ANOTADO, para que no se pierda (tres lugares, uno por unidad):
--
--   * Acá, sección 3.
--   * En `074_sede_less_constraints.sql`, en el apartado «LO QUE ESTE ARCHIVO
--     NO TOCA, Y POR QUÉ IMPORTA QUE SIGA EN PIE», que es donde nació la
--     excepción.
--   * En el encabezado de `src/features/commissions/service.ts`, junto al
--     `onConflict` de este mismo cambio.
--
-- Mientras siga en pie: los dos índices dicen lo mismo sobre las filas de hoy,
-- y el viejo no se puede usar para inferir un `ON CONFLICT` sin sede (42P10),
-- así que su presencia es inocua: no admite ni oculta duplicados, cuesta un
-- índice y una etiqueta vieja.

-- ===================================================================== ---
-- 4. Cómo verifica el dueño (sólo lectura)
-- ===================================================================== ---
--
-- Las consultas siguientes NO cambian nada: se copian y se ejecutan tal cual en
-- el editor de la consola.

-- 4.1 Los dos índices de `commission_rules`, con su nombre y su definición: el
--     viejo (cuatro columnas) tiene que estar Y el nuevo (tres), porque entre
--     este archivo y M3c los dos conviven.
--   SELECT indexname, indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND tablename = 'commission_rules'
--    ORDER BY indexname;

-- 4.2 Que la definición del nuevo es exactamente la que infiere el `upsert`:
--     `item_type, item_id, employee_id`, en ese orden, y sin `sede_id`.
--   SELECT indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname = 'uq_commission_rule_install_key';
--
--   -- Debe salir: CREATE UNIQUE INDEX uq_commission_rule_install_key
--   --   ON public.commission_rules USING btree (item_type, item_id, employee_id)

-- 4.3 Que no queda ningún (ítem, empleado) repetido bajo la clave nueva: tiene
--     que dar 0. Es la misma condición que el pre-vuelo, para confirmar DESPUÉS
--     de que el índice está puesto.
--   SELECT item_type, item_id, employee_id, count(*)
--     FROM public.commission_rules
--    GROUP BY item_type, item_id, employee_id
--   HAVING count(*) > 1;   -- 0 filas

-- 4.4 Que el `COMMENT` del índice nuevo está (es el contrato del objeto, y es
--     donde se lee por qué el viejo sigue en pie).
--   SELECT obj_description('public.uq_commission_rule_install_key'::regclass, 'pg_class');
--
--   SELECT obj_description('public.uq_commission_rule'::regclass, 'pg_class');

-- 4.5 Prueba funcional, con filas de prueba y NUNCA con las reales: guardar dos
--     veces la MISMA regla (mismo ítem y mismo empleado) tiene que devolver la
--     misma fila —`upsert` con `onConflict: "item_type,item_id,employee_id"`— y
--     no crear una segunda. Un INSERT directo de esa pareja tiene que fallar con
--     23505.

-- ===================================================================== ===
-- 5. Cómo se revierte
-- ===================================================================== ---
--
--   DROP INDEX IF EXISTS public.uq_commission_rule_install_key;
--
-- Vuelve el esquema al de antes de este archivo: `uq_commission_rule` nunca se
-- quitó, así que el `onConflict` del código previo al de esta unidad sigue
-- teniendo contra qué inferirse. La vuelta atrás NO requiere que el `onConflict`
-- vuelva a las cuatro columnas para que el esquema sea coherente (los dos
-- objetivos son válidos contra los dos índices), pero desplegar el código viejo
-- con el objetivo nuevo SÍ falla con 42P10: el orden vuelve a ser código primero.