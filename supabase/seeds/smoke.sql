-- smoke.sql — Datos de humo para la PRIMERA liquidación de nómina en PRUEBAS.
--
-- QUÉ ES: un seed ADITIVO sobre `catalog.sql` + `acceptance.sql`. Deja la
-- instalación en el punto exacto en que el dueño puede generar su primera
-- liquidación OPERANDO la aplicación (diálogo «Abrir período»), sin sembrar
-- ningún período, turno, factura ni vale: eso es justamente el smoke test.
--
-- QUÉ NO HACE: no escribe la fecha de arranque de la nómina. Esa fecha dejó de
-- ser CONFIGURACIÓN (vivía en `sedes.payroll_start_date`, que hoy no lee ni
-- escribe nadie) y pasó a ser un HECHO: la declara la PRIMERA liquidación,
-- dentro del diálogo «Abrir período», y de ahí en adelante el arranque se deriva
-- del período más antiguo (`payrollHistoryFloor`, el `min(start_date)` de los
-- períodos). Sembrarla por SQL sería escribir un valor que la aplicación ya no
-- consume.
--
-- POR QUÉ NO PARTE DE `acceptance.sql`: `acceptance.sql` es el fixture del
-- criterio §11 y su propio encabezado declara que los turnos, facturas,
-- PERÍODOS y vales «se crean por UI/flujos». Editarlo cambiaría ese contrato y
-- haría que la aceptación dependiera de datos de humo. Este archivo vive
-- aparte, se aplica después, y no modifica una sola línea del fixture.
--
-- INTERLOCK — SÓLO PRUEBAS. Lo único que este archivo escribe es la CADENCIA de
-- nómina acordada con los diez empleados del fixture de aceptación: sobre la
-- base real eso sería sobreescribir el dato del negocio de una instalación que
-- ya opera. Por eso la PRIMERA sentencia aborta antes de escribir si la sesión
-- no es la de PRUEBAS.
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
-- pisar lo que el dueño haya cambiado a mano en la UI: la escritura sólo toca
-- lo que está SIN configurar (`pay_frequency IS NULL`), y la asignación de
-- cadencias es determinista (misma fila ⇒ misma cadencia en cada corrida). No
-- toca sueldos, porcentajes, catálogos, caja, ni métodos de pago.
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
-- Sin cadencia, `pendingPayrollSettlements` (`schemas.ts:1604`) salta al
-- empleado (`normalizePayFrequency(...) === null`, regla 1): el aviso de
-- pendientes no lo contaría y su ciclo no se pagaría nunca.
--
-- El reparto cumple las dos condiciones del dato de humo:
--   · las TRES cadencias tienen al menos un empleado activo, y
--   · dentro de UNA sola cadencia —`quincenal`— están los TRES `pay_type`
--     (`fijo` Marco, `porcentaje` Diego, `mixto` Paola), así el mismo ciclo
--     ejercita el fijo, el porcentaje y el mixto de una vez. `semanal` trae tres
--     empleados y dos de los tres tipos (Lucía `fijo`, Andrés `porcentaje`,
--     Carolina `fijo`).
-- `payout_mode` NO se toca: no decide quién entra a un período (eso es la
-- cadencia, `schemas.ts:927` `periodExcludesEmployeeByCadence`, aplicada en
-- `service.ts:1778` `payableRoster`); sólo `no_aplica` vacía el detalle de
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
  -- semanal: tres empleados y dos tipos de pago (Lucía y Carolina `fijo`,
  -- Andrés `porcentaje`).
  ('10000005', 'semanal'),   -- Lucía Herrera · Recepcionista · fijo
  ('10000004', 'semanal'),   -- Andrés Quintero · Barbero · porcentaje
  ('10000001', 'semanal'),   -- Carolina Rojas · Administradora · fijo
  -- quincenal: los tres tipos, para probar la exclusión por cadencia
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
