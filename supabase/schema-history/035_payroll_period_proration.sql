-- 035_payroll_period_proration.sql — PR1: el fijo se prorratea por los DÍAS del
-- período y un día no se puede nominar dos veces.
--
-- MOTIVO
--
-- `calculatePayroll` (src/features/payroll/service.ts) pagaba
-- `roundMoney(employee.salary_fixed)` en CADA período, y `salary_fixed` es un
-- valor MENSUAL (003_admin.sql: "Salario fijo mensual"). Cuatro cierres
-- semanales de septiembre pagaban 4 × el sueldo: sin error, sin aviso y sin
-- señal de auditoría. La pantalla incluso lo sugería ("empiece el día siguiente
-- al último período"), que es correcto como serie semanal y como defecto de
-- dinero no.
--
-- La aplicación ya prorratea (`prorateFixedSalary` en
-- src/features/payroll/schemas.ts): el fijo de un período es la porción del
-- sueldo mensual que corresponde a sus días. Este archivo cierra la otra mitad
-- del problema: la prorata sólo SUMA el sueldo si los períodos NO comparten
-- días, y hasta ahora la única barrera en la base era un índice único parcial
-- sobre la tupla EXACTA (sede_id, start_date, end_date) de los borradores
-- (007_payroll.sql). Dos rangos adyacentes o cruzados pasaban sin ruido: la
-- misma semana dos veces, 1 día de solape, un rango que contiene a otro. La
-- aplicación no es una barrera contra la concurrencia, así que la barrera va
-- acá.
--
-- DECISIÓN (y su precio): la restricción cubre TODOS los estados, no sólo los
-- borradores. La regla del dueño es que un DÍA se nomina una sola vez, y el
-- riesgo de plata no distingue estados: un borrador abierto sobre días de un
-- período CERRADO vuelve a pagar días que ya se pagaron (el cerrado no se puede
-- recalcular). Elegir "sólo borradores" dejaría el agujero exactamente donde el
-- dinero ya salió. Además, PostgreSQL no admite restricciones de exclusión
-- parciales: "sólo borradores" no es expresable con esta herramienta (haría
-- falta un trigger).
-- Precio explícito: rehacer una nómina sobre los MISMOS días queda bloqueado,
-- incluso si el período previo está cerrado. Es el comportamiento buscado
-- —reabrir los mismos días sin corregir el período anterior es pagarlos otra
-- vez—; corregir un período cerrado es un procedimiento propio y auditable
-- (como el reconteo de turno de 033), no un segundo rango encima. Los rangos
-- ADYACENTES (fin 2026-09-07 / inicio 2026-09-08) siguen permitidos: no
-- comparten ningún día, y son la serie semanal legal del mes.
--
-- QUÉ HACER SI YA HAY FILAS SOLAPADAS
--
-- La restricción NO se puede crear con datos que la violen (PostgreSQL rechaza
-- el ALTER con 23P01). Este archivo detecta el caso ANTES y aborta con un
-- mensaje que lista los pares en conflicto (fechas y estado de cada uno). No
-- borra, no reescribe y no desactiva nada: decide el dueño. Producción todavía
-- no está en vivo, así que se espera que las filas de prueba solapadas sean
-- descartables; el paso es revisar los pares que el error lista, quedarse con el
-- período que corresponde (borrar el duplicado o ajustar sus fechas) y volver a
-- correr la migración.
--
-- IDEMPOTENTE: la extensión y la restricción están guardadas (`IF NOT EXISTS` y
-- una consulta a `pg_constraint`), así que volver a correr el archivo no hace
-- nada. No toca datos: no borra (`DELETE`), no actualiza (`UPDATE`) y no
-- reescribe filas.
--
-- NOTA: `uq_payroll_draft_per_range` (007) queda como está. La restricción de
-- exclusión lo subsume (misma tupla ⇒ solape), pero el servicio todavía mapea
-- su 23505 a PERIOD_DRAFT_EXISTS y borrar DDL existente está fuera del alcance
-- de este cambio; se puede retirar en un archivo propio más adelante.

-- `btree_gist` aporta el operador `=` de `sede_id` al índice gist que sostiene
-- la exclusión (sin él, gist no sabe comparar uuid). Es una extensión contrib:
-- si el rol de la migración no puede crearla, ESTE es el punto donde el archivo
-- falla y no queda nada a medias (la extensión se crea antes de tocar la tabla).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Pre-vuelo: sin esto, el ALTER de abajo fallaría con 23P01 y un mensaje de
-- PostgreSQL que no dice QUÉ filas chocan ni QUÉ hacer. Acá se listan.
DO $$
DECLARE
  conflict_count integer;
  conflict_sample text;
BEGIN
  SELECT count(*)
    INTO conflict_count
    FROM public.payroll_periods a
    JOIN public.payroll_periods b
      ON a.sede_id = b.sede_id
     AND a.id < b.id
     AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');

  IF conflict_count > 0 THEN
    -- Muestra acotada (10 pares): el mensaje tiene que ser legible.
    SELECT string_agg(
             format('%s [%s .. %s] %s  x  %s [%s .. %s] %s',
                    sample.id_a, sample.start_a, sample.end_a, sample.status_a,
                    sample.id_b, sample.start_b, sample.end_b, sample.status_b),
             E'\n  ')
      INTO conflict_sample
      FROM (
        SELECT a.id AS id_a, a.start_date AS start_a, a.end_date AS end_a, a.status AS status_a,
               b.id AS id_b, b.start_date AS start_b, b.end_date AS end_b, b.status AS status_b
          FROM public.payroll_periods a
          JOIN public.payroll_periods b
            ON a.sede_id = b.sede_id
           AND a.id < b.id
           AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
         ORDER BY a.start_date, b.start_date
         LIMIT 10
      ) AS sample;

    RAISE EXCEPTION E'migración 035 ABORTADA: % par(es) de períodos de nómina de la misma sede ya comparten días, y la restricción de exclusión no se puede crear con datos que la violen (PostgreSQL responde 23P01). No se borró ni se reescribió ninguna fila.\n  QUÉ HACER: revise los pares listados, quédese con el período que corresponde (borre el duplicado o ajuste sus fechas) y vuelva a correr la migración.\n  Pares en conflicto (hasta 10):\n  %',
      conflict_count, conflict_sample
      USING ERRCODE = '23514',
            HINT = 'Un día se nomina una sola vez: dos períodos de la misma sede no pueden compartir días, en ningún estado.';
  END IF;
END $$;

-- La barrera: exclusión por sede y rango de días INCLUSIVO. Cubre también el
-- UPDATE —mover un período sobre días ya nominados choca igual que un INSERT— y
-- a cualquier escritor (API, SQL a mano, otro proceso), no sólo al servicio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.payroll_periods'::regclass
       AND conname = 'ex_payroll_periods_no_overlap'
  ) THEN
    ALTER TABLE public.payroll_periods
      ADD CONSTRAINT ex_payroll_periods_no_overlap
      EXCLUDE USING gist (
        sede_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT ex_payroll_periods_no_overlap ON public.payroll_periods IS
  'PR1: un día se nomina una sola vez. Dos períodos de la misma sede no pueden compartir días, en ningún estado (un período cerrado también pagó esos días). El servicio lo rechaza antes con PERIOD_OVERLAP y un mensaje con el rango en conflicto; esta restricción es la barrera ante carreras (23P01).';
