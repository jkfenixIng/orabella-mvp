-- 066_payroll_carry_delete_fks.sql — PAY-01: borrar un borrador con historia de
-- deuda deja de fallar con un error interno; las dos FK a `payroll_periods` de
-- `payroll_discount_carries` recuperan su `ON DELETE`.
--
-- MOTIVO DEL ARCHIVO (el `NO ACTION` de 061 era deliberado y era INCORRECTO)
--
-- La 061 creó `payroll_discount_carries` con DOS referencias a
-- `payroll_periods` SIN `ON DELETE`:
--
--     origin_period_id  uuid NOT NULL REFERENCES public.payroll_periods (id)
--     applied_period_id uuid NULL     REFERENCES public.payroll_periods (id)
--
-- y lo justificó en su propio encabezado: "un período no se borra en esta
-- aplicación". Esa premisa es FALSA. El borrado de un período en BORRADOR
-- existe y es una operación de primera clase: `payroll_delete_period_atomic`
-- (048), invocado por `deletePayrollPeriod`, y su paso 1.7 ejecuta
-- `DELETE FROM public.payroll_periods` dentro de la transacción. Las otras dos
-- FK al período —`payroll_items.period_id` (007) y
-- `payroll_period_corrections.period_id` (037)— sí son `ON DELETE CASCADE`.
-- Las dos de la deuda eran las ÚNICAS sin `ON DELETE`: con deuda de por medio,
-- Postgres levantaba `23503` (violación de FK), la transacción se revertía
-- ENTERA y el borrado moría con el mensaje genérico `INTERNAL: Error interno.`
-- (`toRpcDeletePeriodError` no tiene rama para `23503`, y no puede tenerla: acá
-- el `23503` no es una carrera que haya que traducir a un conflicto de negocio,
-- es un esquema que bloquea una operación legítima). Se reproduce con UN solo
-- vale mayor que el bruto del empleado en el período: el sobrante crea la deuda
-- y el borrador deja de poder borrarse.
--
-- Las DOS FK pueden dispararlo, y por eso se corrigen las dos:
--   * un borrador que PRODUJO deuda (`origin_period_id`) — el sobrante de un
--     vale que el período no pudo descontar (061/064);
--   * un borrador que CONSUMIÓ deuda (`applied_period_id`) — la absorción de una
--     deuda anterior dentro de `other_discounts` (062/064).
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
-- Reemplaza las dos FK por su versión con `ON DELETE`. NO toca la tabla, sus
-- columnas, sus CHECK, sus índices, su RLS, ninguna función ni ninguna otra FK.
-- NO migra datos: ninguna fila cambia de valor.
--
-- SEMÁNTICA QUE RESTAURA CADA CLÁUSULA
--
--   * `origin_period_id` → `ON DELETE CASCADE`. La deuda que el borrador
--     PRODUJO desaparece CON el borrador, y es correcto: la MISMA transacción
--     revierte los vales que la causaron, así que la deuda se queda sin causa.
--     Conservarla sería una deuda sin vale que la explique; devolverla a
--     pendiente, una deuda que nadie generó.
--   * `applied_period_id` → `ON DELETE SET NULL`. La deuda que el borrador había
--     CONSUMIDO vuelve a PENDIENTE: borrar los ítems deshace la absorción, y el
--     período de ORIGEN sigue existiendo, así que un ciclo POSTERIOR la volverá
--     a aplicar. No se pierde: se posterga.
--
-- POR QUÉ `SET NULL` NO ES UNA OPCIÓN PARA `origin_period_id`
--
-- `origin_period_id` es `NOT NULL`: `SET NULL` violaría la columna. Y no es un
-- límite arbitrario — el origen es la TRAZABILIDAD de la deuda: una deuda sin
-- origen no se puede explicar ni aplicar (el cálculo sólo aplica deudas cuyo
-- período de origen es anterior). `applied_period_id` sí es nullable (NULL =
-- PENDIENTE), y ése es exactamente el estado al que hay que volver.
--
-- NOMBRES DE LAS RESTRICCIONES
--
-- Las dos FK se declararon en línea en la 061, sin nombre explícito, así que
-- Postgres les asignó el nombre por defecto `<tabla>_<columna>_fkey`:
-- `payroll_discount_carries_origin_period_id_fkey` y
-- `payroll_discount_carries_applied_period_id_fkey`. La 064 sólo agregó la
-- columna `origin_kind` y no renombró ninguna, así que ésos son los nombres
-- vigentes. Acá se vuelven a declarar con el MISMO nombre para que el archivo
-- sea re-ejecutable sin acumular restricciones.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
-- dejan el esquema idéntico en cada corrida. El runner de Supabase aplica el
-- archivo en una transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 066 es el siguiente libre (la serie llega a
-- `065_employee_pay_frequency.sql`); este archivo NO renumera ni toca ningún
-- archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La FK de ORIGEN: la deuda que el borrador PRODUJO cae con el borrador
-- ===================================================================== ---

ALTER TABLE public.payroll_discount_carries
  DROP CONSTRAINT IF EXISTS payroll_discount_carries_origin_period_id_fkey;

ALTER TABLE public.payroll_discount_carries
  ADD CONSTRAINT payroll_discount_carries_origin_period_id_fkey
  FOREIGN KEY (origin_period_id) REFERENCES public.payroll_periods (id)
  ON DELETE CASCADE;

-- ===================================================================== ---
-- 2. La FK de APLICACIÓN: la deuda que el borrador CONSUMIÓ vuelve a PENDIENTE
-- ===================================================================== ---

ALTER TABLE public.payroll_discount_carries
  DROP CONSTRAINT IF EXISTS payroll_discount_carries_applied_period_id_fkey;

ALTER TABLE public.payroll_discount_carries
  ADD CONSTRAINT payroll_discount_carries_applied_period_id_fkey
  FOREIGN KEY (applied_period_id) REFERENCES public.payroll_periods (id)
  ON DELETE SET NULL;
