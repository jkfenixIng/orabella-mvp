# Datos de humo para PRUEBAS: la primera liquidación posible

## Objective

Dejar PRUEBAS en un estado donde la **primera liquidación de nómina se pueda generar
operando la aplicación** —que es lo que el dueño va a probar a mano— sin inventar reglas de
negocio y sin acercarse a PRODUCCIÓN.

El smoke test funcional era el pendiente declarado de `esquema-mono-sede-y-archivo-unico.md`
(«Next step»). Al intentarlo aparecieron los tres defectos de código de
`smoke-test-defectos-1.md` y, detrás de ellos, **un estado de datos que no alcanza**: el
dueño no puede generar la primera liquidación.

## Problem

### Lo que ya está (medido en PRUEBAS)

`sedes` 1 fila activa («Sede principal»), `users` 10, `user_roles` 10, `employees` 10
(10 activos), `services` 4, `products` 3, `payment_methods` 6, `tax_configs` 2,
`cash_registers` 1 (base 300000), `cash_denominations` 11, `system_settings` 5, `roles` 4.
Todo eso lo dejó `seeds/catalog.sql` + `seeds/acceptance.sql`, que son idempotentes y
declaran su alcance: *«Este seed deja la BASE (sede, catálogos, empleados, caja lista); los
turnos, facturas, periodos y vales se crean por UI/flujos»*.

Los empleados ya tienen `pay_type`, `salary_fixed` y `commission_percent` (Carolina fijo
1500000, Paola mixto 800000+20%, Andrés porcentaje 35%, etc.) — el fixture de aceptación los
siembra y no hay que tocarlos.

### Lo que falta, y por qué cada cosa falta

1. **`sedes.payroll_start_date` = NULL.** Es la causa directa de que no se pueda liquidar.
   F10 (migración 068) define esa fecha como el piso de la historia de la nómina: sin fecha
   **y** sin períodos, `pendingPayrollSettlements` devuelve `[]` —no hay desde dónde recorrer
   ciclos— y el diálogo «Abrir período» no ofrece ninguno. Está medido: `payroll_periods` = 0.
2. **`employees.pay_frequency` está NULL en 9 de los 10.** `pendingPayrollSettlements` salta
   a todo empleado sin cadencia (`normalizePayFrequency(...) === null`), así que con la fecha
   configurada el aviso solo ofrecería un ciclo con un empleado: no hay liquidación que valga
   la pena probar. Solo Andrés (Barbero, `porcentaje` 35%) tiene `semanal`, y `payout_mode`
   `inmediato`; el resto está en `nomina`.
3. **`voucher_settings` = 0 filas.** Se decide abajo si entra en el alcance.
4. **`commission_rules` = 0 filas.** No bloquea: la comisión por porcentaje de empleado ya
   vive en `employees.commission_percent`.

### Lo que NO falta (y no se toca)

Servicios, productos con stock inicial (y `TN-250` por debajo del mínimo, a propósito), los 6
métodos de pago, los 2 impuestos, las 11 denominaciones y la caja con su base. Los turnos,
las facturas y los **períodos** se crean por UI: ese es justamente el smoke test.

## Design

- **Un seed nuevo y separado, no una edición del fixture de aceptación.**
  `seeds/acceptance.sql` es el fixture del criterio §11 y declara explícitamente que los
  períodos se crean por flujo. Cambiarlo alteraría ese contrato. El archivo nuevo es
  **aditivo** sobre esa base: `app/supabase/seeds/smoke.sql`.
- **Interlock que impide correrlo en PRODUCCIÓN.** La primera sentencia del archivo falla si
  el usuario de conexión no es el de PRUEBAS (`current_user` en la conexión del pooler lleva
  el ref del proyecto). Un archivo que fija la fecha de arranque de la nómina **no debe poder
  aplicarse nunca** a la base real: la fecha es configuración del negocio, no dato de prueba.
- **Idempotente y re-ejecutable**, con la misma convención del fixture: `ON CONFLICT` /
  `DO UPDATE` / `WHERE NOT EXISTS`. Se puede correr dos veces sin duplicar ni pisar lo que el
  dueño haya cambiado a mano en la UI.
- **Las cadences son dato de prueba ficticio**, como los sueldos que ya trae el fixture: se
  reparten para que **las tres cadencias** tengan al menos un empleado activo y para que los
  tres `pay_type` (`fijo`, `porcentaje`, `mixto`) estén representados dentro de una misma
  cadencia. No se cambia ningún sueldo ni porcentaje existente.
- **La fecha de arranque se calcula relativa a `current_date`**, no fija: un valor fijo
  envejece y deja de producir ciclos pendientes. Tiene que rendir **al menos un ciclo cerrado
  pendiente por cadencia**, y el primero de cada cadencia **recortado** (contiene la fecha de
  arranque), que es el camino de la prorrata de F5 — así el smoke test ejercita el caso
  interesante y no solo el ciclo completo.
- **`voucher_settings`**: entra **solo si el código lo exige** para que la primera liquidación
  funcione; si entra, sus valores salen de los defaults que el propio código declara, nunca de
  un número nuevo inventado. Si el código no necesita la fila, queda fuera y se anota.

## Scope

Un archivo de seed nuevo y su aplicación a PRUEBAS. **Nada de esquema, nada de código de
aplicación, nada de PRODUCCIÓN.** Los tres defectos de código son la unidad vecina
(`smoke-test-defectos-1.md`) y sus superficies de archivo son disjuntas de este.

## Tasks

- [x] **U5** — `app/supabase/seeds/smoke.sql`: el interlock de PRUEBAS, las cadencias, la
      fecha de arranque relativa y (si el código lo exige) los ajustes de vales.
- [x] **U6** — Aplicarlo a PRUEBAS y verificar por lectura: la fecha, las cadencias, y los
      ciclos pendientes que F10 deriva con esa fecha.
- [x] **U7** — Gate: `npm test` no se toca, pero el seed se prueba con una segunda aplicación
      (idempotencia) y el interlock se prueba en negativo contra el usuario de PRODUCCIÓN sin
      conectarse a esa base.
- [x] **U8** — Commit del seed con su documentación.

## Checks

- El seed corre dos veces sin duplicar ni pisar cambios hechos por UI.
- Con el usuario de PRODUCCIÓN el seed **aborta antes de escribir** (verificado sin conectarse
  a esa base: la guarda se evalúa sobre `current_user` de la sesión).
- La fecha, las tres cadencias y los ciclos pendientes quedan a la vista por lectura.
- Ninguna sentencia del archivo toca PRODUCCIÓN ni contiene credenciales.

## Verification evidence

**El archivo**: `app/supabase/seeds/smoke.sql`, **2 sentencias** (interlock, cadencias).

> **Corregido el 2026-10-06**: esta línea decía «**3** sentencias (interlock, cadencias, fecha)».
> La tercera la quitó `4b9103f` junto con su prosa: el seed **no escribe** `sedes.payroll_start_date`,
> porque esa fecha dejó de ser configuración — la declara la primera liquidación.

**Aplicado dos veces** a PRUEBAS con `psql -v ON_ERROR_STOP=1 --single-transaction`:

| | 1ª corrida | 2ª corrida |
| --- | --- | --- |
| salida | `DO` / `UPDATE 8` / `UPDATE 1` | `DO` / `UPDATE 0` / `UPDATE 0` |

> La columna del `UPDATE 1` es histórica: esa sentencia (`sedes.payroll_start_date`) ya no existe
> en el archivo (`4b9103f`). Hoy el seed tiene **2 sentencias** y escribe sólo cadencias.

**Lectura de vuelta** (verificada por el orquestador, no solo reportada):
`sedes.payroll_start_date` = **2026-09-16** · empleados **sin cadencia = 0**
(semanal 3, quincenal 3, mensual 4) · `payroll_periods` = **0** (intacto: los períodos
los crea la prueba) · sueldos, porcentajes y `payout_mode` sin cambios.

> **Anotado el 2026-10-06**: la fecha de esa lectura de vuelta **ya no la escribe nadie**.
> `4b9103f` quitó del seed la sentencia que la escribía, y F10 convirtió el arranque en un HECHO
> DERIVADO: lo declara la primera liquidación y después sale de `payrollHistoryFloor`
> (`min(payroll_periods.start_date)`). Medido tras el reset del 2026-10-06: la columna está
> **NULL** y `payroll_periods` en 0. La línea queda como lo que fue: el estado de aquel día.

> **Corrección (2026-10-06)** — de la unidad `odd/tasks/reset-pruebas-nomina.md`.
> El `UPDATE 8` de la 1ª corrida y el `semanal 3 / 0 sin cadencia` de la lectura de vuelta
> no miden lo mismo: la `VALUES` de U5 cubre **8** id_numbers (no trae `10000001` ni
> `10000004`), así que el seed escribió 8 filas. El `semanal 3` y el `0 sin cadencia`
> salieron de **ediciones manuales en la UI del 2026-10-04** —21:35:33 (Carolina, que además
> quedó `mixto` 60%) y 21:37:56 (Andrés)—: las 8 filas del seed comparten un `updated_at` de
> lote (`2026-10-04 22:03:22`) y esas dos tienen el suyo. La lectura documentó un estado
> **observado** como si fuera **producido**. Las cifras de arriba quedan como se escribieron.
> El seed ya cubre los **10** id_numbers, así que una instalación limpia produce el reparto
> declarado sin ninguna edición manual.
>
> **Y la prosa del seed también estaba mintiendo, en una cadencia que nadie había medido**:
> declaraba que los tres `pay_type` convivían en `semanal` (`fijo` Lucía, `porcentaje` Andrés,
> `mixto` Carolina). Medido sobre la base recién reconstruida, la cadencia que los ejercita es
> **`quincenal`** (Marco `fijo`, Paola `mixto`, Diego `porcentaje`), y `semanal` es Lucía + Andrés
> + Carolina, con dos tipos. Corregida la prosa y agregadas las dos filas que faltaban, el seed
> quedó medido contra la base el 2026-10-06: **1ª corrida `UPDATE 2`, 2ª corrida `UPDATE 0`**, y la
> lectura de vuelta da `semanal 3` (`fijo`, `porcentaje`), `quincenal 3` (`fijo`, `mixto`,
> `porcentaje`), `mensual 4`, **0 sin cadencia**.

**Idempotencia**: los conteos después de la 1ª y de la 2ª corrida son idénticos
(sedes 1, employees 10, users 10, system_settings 5, payroll_periods 0) y el
`updated_at` de la sede no cambió en la segunda — la segunda corrida no escribió una fila.

**Aritmética de la fecha**, derivada de `lastCompletedCycleEndDate` (`schemas.ts:1124`):
`ARRANQUE = E − 17`, con `E` el último sábado cerrado. Es la única ventana que deja
pendientes en **las tres** cadencias y recorta el primer ciclo de cada una:

| cadencia | días | pendientes | primer ciclo (recortado) |
| --- | --- | --- | --- |
| semanal | 7 | 3 | 16-09 → 19-09 (4 d, factor 4/7) |
| quincenal | 14 | 2 | 16-09 → 19-09 (4 d, factor 4/15) |
| mensual | 28 | 1 | 16-09 → 10-03 (18 d, factor 18/30) |

> **Anotado el 2026-10-06 — esta tabla mide un diseño que ya no rige.** Sus cuentas suponen un
> `ARRANQUE` **configurado** (16-09), y hoy el arranque es un hecho derivado de los períodos que
> la primera liquidación declara (F10, `resolveOpenPayrollRange`). Con `payroll_periods` en **0**
> —el estado de una instalación recién sembrada— no hay piso: el recorrido de
> `pendingPayrollSettlements` se topa al `limit` por cadencia, así que los pendientes son **3 por
> cadencia (9 en total)**, cada uno pidiendo declarar la fecha. Los recortes «factor 4/7» y
> «4/15» sí siguen siendo el comportamiento del primer ciclo, porque el recorte lo resuelve el
> rango, no la fecha.

**Interlock, en negativo**: el predicado rechaza `postgres.otroref` y `service_role`, y
acepta las dos formas de la sesión de PRUEBAS. No se abrió ninguna conexión a otra base.

### Correcciones al diseño que hizo la ejecución

1. **`current_user` no es lo que yo supuse.** Medido en PRUEBAS: la sesión trae
   `postgres`, **no** `postgres.vmnyxhoqnpqwumynlbun` — Supavisor mapea el rol con sufijo de
   proyecto al rol `postgres` de la base. Un interlock escrito como yo lo pedí (comparar
   contra el ref) **habría abortado en PRUEBAS misma**. El predicado acepta entonces las dos
   formas y exige una segunda condición de datos.
2. **Riesgo residual, dicho sin adornos**: el rol `postgres` no distingue un proyecto de
   otro y la sesión no expone ningún identificador de proyecto. Lo que separa PRUEBAS de
   PRODUCCIÓN es la **huella del fixture** (`%ejemplo.co`, hoy 10/10). Cubre el accidente
   realista —pegar el comando en la terminal equivocada: producción tiene cuentas reales y
   aborta— pero **no** cubriría una producción sembrada con el mismo fixture. No se probó en
   negativo contra PRODUCCIÓN porque eso exigía conectarse, que es justo lo prohibido.
3. **`voucher_settings` no era necesaria.** El código lee las cuatro claves `voucher_*` de
   **`system_settings`** (`service.ts:3275`), no la tabla legacy; y en PRUEBAS esas claves ya
   estaban configuradas **a mano por el dueño**. Sembrar la tabla vieja habría creado una
   segunda fuente de verdad que nadie lee.

## Progress

| Unidad | Commit |
| --- | --- |
| U5 · U6 · U7 · U8 | `d46c35d` |

## Follow-up declarado

Cuando la fecha de arranque de la nómina deje de ser configuración y pase a nacer de la
primera liquidación (decisión del dueño, 2026-10-04: «la fecha de inicio puede ser
automática y no por un superadmin»), **la tercera sentencia de este seed se retira**: deja de
existir la columna que escribe. Las cadencias (la segunda sentencia) siguen haciendo falta,
porque una cadencia es un acuerdo con el empleado, no una configuración de arranque.

## Lo que NO se hace acá

- **La cuenta `superadmin`**: la crea el dueño con su propia clave
  (`SUPERADMIN_PASSWORD='...' npm run create:superadmin`, entrada por `/plataforma`). El
  reset la borró y el script, por diseño, no admite clave por defecto.
- **Los tres defectos de código**: unidad vecina ya en vuelo.
- **La copia de usuario que nombra la sede**: inventario en `copia-sede-inventario.md`,
  esperando la decisión de vocabulario del dueño.

## Route declaration

Escritura de datos **sobre PRUEBAS**, autorizada explícitamente por el dueño
(«puedes integrarla a pruebas y hago esa prueba de humo»). PRODUCCIÓN no se toca: el archivo
lleva un interlock que lo impide.
