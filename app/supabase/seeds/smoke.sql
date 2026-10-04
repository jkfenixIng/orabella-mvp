-- smoke.sql — Datos de humo para la PRIMERA liquidación de nómina en PRUEBAS.
--
-- QUÉ ES: un seed ADITIVO sobre `catalog.sql` + `acceptance.sql`. Deja la
-- instalación en el punto exacto en que el dueño puede generar su primera
-- liquidación OPERANDO la aplicación (diálogo «Abrir período»), sin sembrar
-- ningún período, turno, factura ni vale: eso es justamente el smoke test.
--
-- POR QUÉ NO PARTE DE `acceptance.sql`: `acceptance.sql` es el fixture del
-- criterio §11 y su propio encabezado declara que los turnos, facturas,
-- PERÍODOS y vales «se crean por UI/flujos». Editarlo cambiaría ese contrato y
-- haría que la aceptación dependiera de datos de humo. Este archivo vive
-- aparte, se aplica después, y no modifica una sola línea del fixture.
--
-- INTERLOCK — SÓLO PRUEBAS. La fecha de arranque de la nómina
-- (`sedes.payroll_start_date`) es CONFIGURACIÓN del negocio, no un dato: fijarla
-- en la base real declare que nada anterior existe para el sistema
-- (`src/features/payroll/schemas.ts:1122`, `isRangeBeforePayrollStart`) y deja
-- ciclos sin liquidar sin poder abrirlos. Por eso la PRIMERA sentencia aborta
-- antes de escribir si la sesión no es la de PRUEBAS.
--
--   La identidad se mide con `current_user`, NO con el `user=` del conninfo:
--   Supavisor (el pooler) mapea el rol con sufijo de proyecto al rol `postgres`
--   de la base, así que dentro de la sesión PRUEBAS `current_user` es `postgres`
--   y NUNCA el string `postgres.<ref>`. El predicado acepta las DOS formas
--   (la del conninfo y la que la sesión realmente trae) y rechaza cualquier
--   otro rol. Como `postgres` no distingue un proyecto de otro, la segunda
--   condición exige la huella del fixture de aceptación (dominio reservado
--   `ejemplo.co`): una instalación de producción con datos reales no la tiene.
--
-- IDEMPOTENTE: se puede correr las veces que haga falta sin duplicar nada y sin
-- pisar lo que el dueño haya cambiado a mano en la UI — las dos escrituras sólo
-- tocan lo que está SIN configurar (`pay_frequency IS NULL`,
-- `payroll_start_date IS NULL`), y la asignación de cadencias es determinista
-- (misma fila ⇒ misma cadencia en cada corrida). No toca sueldos, porcentajes,
-- catálogos, caja, ni métodos de pago.
--
-- PARA APLICAR (PRUEBAS; la credencial NUNCA va en la línea de comandos, sale
-- del archivo de conexión y se lee en la sesión):
--
--   psql "$(cat ~/orabella-db/pruebas.conninfo)" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seeds/smoke.sql
--
-- Orden: migraciones → `catalog.sql` → `acceptance.sql` → este archivo.

-- ============================================================ 1. INTERLOCK ===
DO $$
BEGIN
  -- Condición 1 · identidad de la conexión. `postgres` es lo que el pooler de
  -- PRUEBAS deja en la sesión; el string con el ref del proyecto es el `user=`
  -- del conninfo (una conexión directa, no pooleada). Cualquier otro rol —la
  -- misma cadena con otro ref, `service_role`, un rol de app— aborta acá.
  IF current_user <> ALL (ARRAY['postgres', 'postgres.vmnyxhoqnpqwumynlbun']) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = format(
        'Este seed es SÓLO de la base de PRUEBAS (proyecto vmnyxhoqnpqwumynlbun) y esta sesión se conectó como "%". No se escribió nada. Conéctese con el pooler de pruebas: psql "$(cat ~/orabella-db/pruebas.conninfo)" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seeds/smoke.sql',
        current_user
      );
  END IF;

  -- Condición 2 · huella de la instalación de pruebas: el fixture de aceptación
  -- (`acceptance.sql`) siembra los 10 usuarios ficticios en el dominio RESERVADO
  -- `ejemplo.co`. Es una condición de datos, no de credencial: una instalación
  -- real no la cumple. Es complementsaria de la 1 porque `postgres` —el rol que
  -- deja el pooler— no distingue un proyecto de otro.
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE email LIKE '%@ejemplo.co') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Este seed es SÓLO de la base de PRUEBAS: esta instalación no tiene el fixture de aceptación (usuarios ficticios @ejemplo.co). No se escribió nada.';
  END IF;
END
$$;

-- ============================================== 2. CADENCIAS DE LOS 10 ACTIVOS ===
-- `pay_frequency` es la cadencia ACORDADA con el empleado y es la lista cerrada
-- `semanal | quincenal | mensual` (`src/features/payroll/schemas.ts:30`
-- `payFrequencySchema`, el mismo catálogo del CHECK `chk_employees_pay_frequency`).
-- Sin cadencia, `pendingPayrollSettlements` (`schemas.ts:1331`) salta al
-- empleado (`normalizePayFrequency(...) === null`, regla 1): el aviso de
-- pendientes no lo contaría y su ciclo no se pagaría nunca.
--
-- El reparto cumple las dos condiciones del dato de humo:
--   · las TRES cadencias tienen al menos un empleado activo, y
--   · dentro de UNA sola cadencia —`semanal`— están los TRES `pay_type`
--     (`fijo` Lucía, `porcentaje` Andrés, `mixto` Carolina), así el mismo ciclo
--     ejercita el fijo, el porcentaje y el mixto de una vez. `quincenal` también
--     los tiene (Diego `porcentaje`, Paola `mixto`, Marco `fijo`).
-- `payout_mode` NO se toca: no decide quién entra a un período (eso es la
-- cadencia, `schemas.ts:817` `periodExcludesEmployeeByCadence`, aplicada en
-- `service.ts:1800` `payableRoster`); sólo `no_aplica` vacía el detalle de
-- comisión (`schemas.ts:469`).
--
-- Idempotente y sin pisar la UI: sólo escribe donde la cadencia AÚN NO está.
-- La fila se ubica por `users.id_number`, la misma llave con la que `acceptance.sql`
-- siembra los empleados (`ON CONFLICT (user_id)`), así que el destino no depende
-- del uuid. Sueldos y porcentajes no se tocan.
UPDATE public.employees e
SET pay_frequency = m.pay_frequency
FROM public.users u
JOIN (VALUES
  -- semanal: se le suma la-fijo a los dos que ya trae (Andrés `porcentaje`,
  -- Carolina `mixto`) para que la cadencia tenga los tres tipos de pago.
  ('10000005', 'semanal'),   -- Lucía Herrera · Recepcionista · fijo
  -- quincenal: los tres tipos también, para probar la exclusión por cadencia
  -- (un quincenal NO cobra en el ciclo semanal, aunque se solapen a propósito).
  ('10000002', 'quincenal'), -- Diego Mejía · Estilista · porcentaje
  ('10000003', 'quincenal'), -- Paola Cifuentes · Manicurista · mixto
  ('10000006', 'quincenal'), -- Marco Ospina · Auxiliar · fijo
  -- mensual: el resto de la planta.
  ('10000007', 'mensual'),   -- Elena Vargas · Cajera · fijo
  ('10000008', 'mensual'),   -- Jorge Ramírez · Cajero · fijo
  ('10000009', 'mensual'),   -- Natalia Pardo · Colorista · mixto
  ('10000013', 'mensual')    -- Sonia Morales · Estilista senior · mixto
) AS m(id_number, pay_frequency) ON m.id_number = u.id_number
WHERE e.user_id = u.id
  AND e.is_active
  AND e.pay_frequency IS NULL;

-- ============================ 3. FECHA DE ARRANQUE DE LA NÓMINA (F10) ============
-- `sedes.payroll_start_date` es el PISO de la historia de nómina de la sede
-- (F10). Sin ella, y sin períodos, `pendingPayrollSettlements` devuelve `[]`
-- (`schemas.ts:1331`: sin piso no hay de dónde recorrer ciclos) y `openPayrollPeriod`
-- (`service.ts:704`) no tiene contra qué recortar el primer ciclo.
--
-- LA FECHA ES RELATIVA A `current_date`, nunca un literal: un literal envejece y
-- deja de producir ciclos pendientes. Se deriva con la MISMA aritmética que el
-- código, no con una cuenta propia:
--
--   E = último sábado YA cerrado = `lastCompletedCycleEndDate(current_date)`
--       (`schemas.ts:978`): el sábado EN o ANTES de `current_date - 1`, es decir
--       el sábado estrictamente anterior a la fecha de referencia.
--       En SQL: `current_date - 1 - ((dow(current_date - 1) + 1) % 7)`.
--
--   ARRANQUE = E - 17 días.
--
-- POR QUÉ 17. El detector camina hacia atrás desde E en saltos de
-- `calendarCycleDaysForFrequency` (`schemas.ts:897`): 7 días `semanal`,
-- 14 `quincenal`, 28 `mensual`; el ciclo k termina en `E - k·días` y arranca en
-- `E - k·días - (días-1)`; se detiene cuando el cierre es ANTERIOR al arranque
-- (`isRangeBeforePayrollStart`, `schemas.ts:1122`) y reporta como máximo
-- `PENDING_SETTLEMENT_LIMIT = 3` ciclos por cadencia (`schemas.ts:1229`).
--
--   Con ARRANQUE = E - 17, para las TRES cadencias:
--     · el ciclo k=2 contiene la fecha (E-20 < E-17 <= E-14), así que se
--       RECORTA a ella: es el PRIMER ciclo de la cadencia y lo resuelve
--       `resolveOpenPayrollRange` (`schemas.ts:1182`) pagándolo con la
--       prorrata de ciclo parcial de F5 (`cycleProrationFactor`,
--       `schemas.ts:1081`), que es el caso interesante del smoke test;
--     · hay al menos un ciclo cerrado pendiente en cada cadencia:
--       semanal 3 (k=0,1,2), quincenal 2 (k=0,1), mensual 1 (k=0, recortado);
--     · ningún ciclo anterior al arranque se ofrece ni se puede abrir.
--   -(k=3) `semanal` cerraría en E-21 < E-17 → el recorrido se detiene ahí, que
--   es exactamente la regla de F10.
--
-- Idempotente y sin pisar la UI: sólo escribe donde la fecha AÚN NO está; si el
-- dueño la fijó a mano desde la pantalla, este seed la conserva y no la pisa.
UPDATE public.sedes
SET payroll_start_date = (
      (current_date - 1 - ((EXTRACT(DOW FROM (current_date - 1))::int + 1) % 7)) - 17
    )::date,
    updated_at = now()
WHERE payroll_start_date IS NULL;
