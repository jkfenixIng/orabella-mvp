# Esquema mono-sede y archivo único de esquema

> **Reversión de una decisión previa (dueño, 2026-10-03).** El 2026-10-02 el dueño
> había evaluado el squash de migraciones y lo había **descartado** —es la unidad
> **M4** de `plataforma-super-admin.md`—. El 2026-10-03 lo revirtió: pidió que cada
> base lleve **una sola migración**. Este documento registra esa decisión, cómo se
> ejecutó y el procedimiento de reset que la acompaña. El pendiente de M3c (el
> borrado físico de la columna) también quedó cerrado acá.

## Objective
Que la instalación sea de **una sola sede, físicamente** —no solo en el código— y que
cada base de datos lleve **una sola migración** en lugar de una serie de 76 archivos.

Dos entregables concretos: `app/supabase/migrations/001_orabella_schema.sql` como el
esquema vigente, y las bases PRUEBAS y PRODUCCIÓN reseteadas con él, sin perder los
datos de configuración de producción.

## Problem

**La estructura multi sede seguía en los datos.** El código ya no tenía alcance por
sede desde el 2026-10-02 (M1, M2, M3a y M3b de `plataforma-super-admin.md`), pero la
columna `sede_id` seguía viva en **21 tablas** y 35-37 políticas de RLS la nombraban.
La `077_drop_sede_id.sql` era el paso irreversible que faltaba (M3c).

**PRUEBAS no servía de ensayo.** Estaba **atrasada respecto de la `017` vigente**: le
faltaban cuatro políticas (`pol_cash_denominations_sede_isolation`,
`pol_shift_counts_sede_isolation`, `pol_commission_rules_sede_isolation`,
`pol_commission_payouts_sede_isolation`) y el índice `idx_commission_rules_employee`,
y sus políticas de comisiones seguían permisivas (`USING (true)`). Aplicar la `077`
ahí habría validado contra un esquema que no es el de producción.

**El historial sembraba datos.** Varias migraciones insertaban filas de catálogo de
nivel superior: los roles (`002_auth.sql:55` y `069_superadmin_role.sql:63`), la sede
(`003_admin.sql:38`), la caja (`006_cash.sql:80`), las denominaciones
(`010_cash_denominations.sql:23`) y los ajustes (`072_system_settings.sql:209,226`).
Un `pg_dump --schema-only` **no lleva una sola fila**, así que un archivo generado así
deja los catálogos **vacíos**: sin `roles` la aplicación no resuelve permisos, sin la
fila de `sedes` el `users.sede_id` queda huérfano y sin `payment_methods` no se puede
cobrar.

## Decisiones del dueño

- **`users.sede_id` se conserva.** No es deuda ni una clave multi sede: (1) ancla la
  cuenta a la instalación única —la fila de `sedes` que la describe—, y (2) es el
  origen de `session.sedeId` en `src/features/auth/service.ts`, del que dependen las
  siete guardas de sesión. Con una sola sede su valor es constante y no acota nada.
  El razonamiento completo está en el bloque de alcance del encabezado de la `077`.
- **`current_sede_id()` se conserva** porque `pol_users_sede_isolation` la llama en su
  predicado y PostgreSQL registra la dependencia: borrarla tumbaba la migración.
- **El archivo único se GENERA desde un volcado del esquema real**, nunca se escribe a
  mano. Su cuerpo es copia byte a byte de la base que resulta de aplicar 001-077, así
  que **no puede haber deriva** entre lo que decían las migraciones y lo que queda
  instalado.
- **La serie histórica no se borra: se mueve.** Los 76 archivos viven ahora en
  `app/supabase/schema-history/`. Son el *porqué* de cada objeto y el respaldo para
  regenerar el archivo.
- **El reset vacía `public` sin borrarlo** (ver «El procedimiento de reset»).
- **Los datos de producción se trasladan**, no se descartan: la instalación tiene
  configuración real (2 usuarios con sus claves, 2 empleados, 4 servicios, 6 formas de
  pago, 2 impuestos, 11 denominaciones, 5 ajustes, 1 sede, 1 caja).

## Design

### El archivo único y el historial

| | |
| --- | --- |
| `app/supabase/migrations/001_orabella_schema.sql` | **el esquema vigente**: 8280 líneas = 188 de encabezado + 8092 de cuerpo |
| `app/supabase/schema-history/001…077` | los 76 archivos históricos, movidos con `git mv` (76 renombres, blob idéntico) |
| `app/supabase/seeds/catalog.sql` | el catálogo que el esquema no lleva: 30 filas en 7 tablas |
| `app/supabase/test-bootstrap.sql` | esquema + catálogo + aceptación, para una base de pruebas |

El archivo **no declara ningún objeto de plataforma** (ni `auth`, ni `storage`, ni
`vault`, ni `extensions`, ni `graphql`, ni `realtime`, ni `pgbouncer`), porque el
destino ya los tiene. Sí conserva las referencias a `auth.jwt()` **dentro del cuerpo**
de las funciones de `public`: en el destino esa función existe.

Se regenera **byte a byte** con `python app/supabase/squash/build-schema.py`, que
construye la base descartable aplicando la serie, vuelca y ensambla el archivo desde
`schema-header.sql`. Verificado: sha256
`5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5`, idéntico al
commiteado. La fixture `_platform_fixture.sql` es un stub descartable de `auth` para
que el historial compile en una base nueva; **no es una migración y jamás se aplica en
un destino**.

### Los tests leen el historial, no el volcado

Los tests de este repo **no hablan con una base de datos**: reconstruyen el esquema
leyendo las migraciones como texto y derivando hechos (columnas de una tabla,
nulabilidad, unicidades, orden de las redes de conteo). Como el historial **se movió y
no se borró**, repuntar los 70 sitios de lectura a `schema-history/` deja el inventario
derivado **idéntico**: se cambió el directorio y **no se tocó una sola aserción**.

Repuntarlos al volcado habría exigido reescribir decenas de expresiones regulares —el
volcado escribe `ALTER TABLE ONLY`, `USING btree` y `COMMENT ON` como sentencia— con
riesgo de cambiar sin querer **qué mide** cada prueba.

**La brecha residual, sin maquillar:** las pruebas que leen el historial **no detectan
una edición manual del archivo único**. Lo que la detecta es la guarda de invariantes
agregada en `app/tests/hardening.test.ts` (6 pruebas sobre el archivo vivo: que sea el
único `0NN_*.sql` de `migrations/`, 36 `CREATE TABLE public.`, 10 `CREATE POLICY`,
`sede_id` como columna solo en `public.users`, una sola declaración de
`payroll_apply_atomic` y de cuatro argumentos, `next_invoice_number()` sin argumentos,
y ninguna referencia a `employees.sede_id` fuera de prosa) y el procedimiento de
construcción con su comparación de sha256.

**Trampa advertida:** hay ayudantes de test que leen con `existsSync` y devuelven texto
vacío si el archivo falta. Es deliberado —así el fallo es la aserción y no un error de
colección— y hoy es seguro porque cada bloque tiene al menos una aserción **positiva**
que falla con texto vacío. Pero repuntar esos tests a un directorio donde el archivo no
exista convertiría las aserciones **negativas** (`not.toMatch`) en pases vacuos: una
prueba que no puede fallar.

### El catálogo es un seed, no esquema

`seeds/catalog.sql` reproduce lo que el historial sembraba, con los valores verbatim,
adaptado a mono-sede e idempotente. Verificado por **diff de datos** contra
`orabella_build` —la base que resulta de aplicar 001-077, o sea la definición de lo que
el historial sembraba—: **0 diferencias en 7 de 7 tablas**.

Dos tablas que el inventario inicial **no vio**: `payment_methods` (6) y `tax_configs`
(2) las siembra el historial **dentro de un bloque `DO` de la `003`**, con el `INSERT`
indentado. Un `grep` de `INSERT` al inicio de línea no las encuentra; aparecieron
barriendo las 36 tablas contra una base vacía. Sin ellas una base nueva no puede cobrar.

### El procedimiento de reset

**`DROP SCHEMA public CASCADE` NO es la forma correcta de resetear una base Supabase.**
El esquema `public` tiene ACL de plataforma y *default privileges*, y borrarlo se lleva
las de `supabase_admin` —6 filas en total: 3 de `postgres` y 3 de `supabase_admin`—,
que `postgres` **no puede recrear**: no es superusuario y `SET ROLE supabase_admin` está
denegado. Medido en PRUEBAS: **se perdieron y no hay forma de reponerlas por SQL**.

El procedimiento correcto **vacía `public` sin borrarlo**: tira las relaciones y las
funciones de adentro con `CASCADE`, deja el esquema en pie, y así **sobreviven el ACL y
todas las default privileges**. En PRODUCCIÓN sobrevivieron las de **los dos roles**.
Está documentado en la sección 8 de `app/supabase/squash/README.md` y verificado por
`app/supabase/squash/reset-verificacion.sql`.

Dos detalles que hacen la diferencia entre un procedimiento y una apuesta:

- **Todo corre en UNA transacción.** En PostgreSQL el DDL es transaccional, así que un
  fallo deja la base **intacta**. Pero `pg_dump` emite su propio `BEGIN`/`COMMIT` y ese
  `COMMIT` interno cerraría la transacción externa: se aplica una **copia del archivo
  sin esas dos líneas**, verificando que sea idéntica salvo ellas.
- **Las `default privileges` de `postgres` son las que hacen que `anon`,
  `authenticated` y `service_role` alcancen las tablas nuevas.** No hay `GRANT`
  explícitos en el volcado: el acceso lo concede la default privilege en el momento de
  crear cada tabla. Por eso se verifica el ACL de las 36 tablas después del reset.

## Scope
**Entra:** la `077` como borrado físico, el squash a un archivo, el catálogo como seed,
el repunte de los tests, el procedimiento de reset reproducible, y el reset de PRUEBAS
y PRODUCCIÓN con traslado de datos.

**No entra:** el modelo de sesión (las siete guardas y `session.sedeId` no se tocan), el
catálogo de roles como concepto de plataforma, ni el smoke test funcional de la
aplicación.

## Tasks
- **T1 — La `077`.** Borrado físico de `sede_id` en 20 tablas, 27 políticas y la
  re-emisión de 13 funciones, con pre-vuelo de tres bloques.
- **T2 — Los cuatro defectos del pre-vuelo.** Ver abajo: son la parte más didáctica.
- **T3 — El volcado y el archivo único**, generados desde una base descartable
  construida aplicando 001-077.
- **T4 — El catálogo y el bootstrap.**
- **T5 — El repunte de los 70 sitios de test** y la guarda del squash.
- **T6 — El procedimiento de reset**, ensayado con los datos reales de producción antes
  de tocar producción.
- **T7 — El reset de PRUEBAS y el de PRODUCCIÓN.**

### Los cuatro defectos de la `077`, que no se veían leyendo

| # | Defecto | Por qué no se veía |
| --- | --- | --- |
| 1 | La guarda de políticas consultaba `pg_policy.qual` y `pg_policy.with_check`, **columnas que no existen**: la vista `pg_policies` las publica con esos nombres, la tabla `pg_policy` las llama `polqual` y `polwithcheck`. Abortaba con `UndefinedColumn` **antes de tocar un objeto**. | El SQL es correcto salvo por dos palabras. Solo aparece al ejecutarlo. |
| 2 | Al grupo `OR` de esa misma guarda le faltaban **los paréntesis**. Como `AND` liga más fuerte que `OR`, la lista blanca se aplicaba solo a la segunda rama y las **27 políticas que la migración borra** entraban al mensaje como infractoras. | Es semántico y silencioso. Arreglar el defecto 1 **sin** arreglar este igual habría abortado, con un mensaje que culpaba al esquema de un defecto de la guarda. |
| 3 | La guarda de los topes de vales tenía un `RAISE EXCEPTION` con **dos marcadores `%` y un argumento**. PL/pgSQL valida los marcadores **al compilar** el bloque, así que rompía la migración **aunque la guarda nunca disparara**. | Se conservó el conteo de claves faltantes: reformular el mensaje era la vía fácil y perdía información útil al operador. |
| 4 | Una sobrecarga **obsoleta** `payroll_apply_atomic(uuid, jsonb, uuid[])` seguía viva. La `062` agregó un cuarto parámetro con `DEFAULT`; al **cambiar la firma**, el `CREATE OR REPLACE` creó una función **NUEVA** en vez de reemplazarla. Su cuerpo leía `employees.sede_id` y volvía **ambigua** cualquier llamada de tres argumentos. | Se borró con `DROP FUNCTION IF EXISTS`, siguiendo el precedente que la propia `077` usa con `next_invoice_number(uuid)`. **En PostgreSQL, `CREATE OR REPLACE` con firma distinta agrega una sobrecarga: cambiar la lista de parámetros es siempre `DROP` + `CREATE`.** |

Dos aparecieron al ejecutar, uno en una auditoría estática y uno en el volcado. La
auditoría que los buscó tuvo que corregirse dos veces: un patrón que exigía el prefijo
`E'` encontró 6 de 121 sentencias `RAISE`, y `\m` (inicio de palabra de PostgreSQL) **no
existe** en las expresiones regulares de Python, donde es `\b`. **Una verificación mal
escrita es peor que ninguna**, porque da tranquilidad falsa.

## Checks
- `npx tsc --noEmit` → 0 errores.
- `npx eslint .` → 0 errores (1 aviso preexistente en `app/app/error.tsx`).
- `npx vitest run` → **1958 pruebas en verde** (1952 previas + 6 nuevas de la guarda).
- El archivo único aplica con `ON_ERROR_STOP=1` y **0 errores** sobre una base limpia
  preparada como un Supabase real (extensiones en `extensions`).
- `python app/supabase/squash/build-schema.py` regenera el archivo con **sha256
  idéntico** al commiteado.
- Los 76 renombres del historial tienen **blob idéntico** (0/0 en `numstat`).

## Verification evidence

**El esquema final, en las dos bases:**

| | PRUEBAS | PRODUCCIÓN |
| --- | --- | --- |
| tablas | 36 | 36 |
| políticas | 10 (eran 35-37) | 10 |
| funciones de la aplicación | 28 | 28 |
| tablas con RLS | 36 | 36 |
| columna `sede_id` | **solo `users`** | **solo `users`** |
| sedes | 1, activa | 1, activa |
| `users.sede_id` nulos / huérfanos | 0 / 0 | 0 / 0 |
| `payroll_apply_atomic` | 1 firma, 4 argumentos | 1 firma, 4 argumentos |
| `next_invoice_number` | 1 firma, sin argumentos | 1 firma, sin argumentos |
| `anon` alcanza las tablas | 36 de 36 | 36 de 36 |
| `nspacl` de `public` | idéntico al de antes | idéntico al de antes |
| default privileges | **`postgres` sí; `supabase_admin` NO** | **los dos roles, intactas** |

**Los datos de PRODUCCIÓN, trasladados:** 12 tablas con conteos **idénticos** al antes
—`users` 2, `employees` 2, `sedes` 1, `services` 4, `payment_methods` 6, `tax_configs`
2, `cash_denominations` 11, `system_settings` 5, `roles` 4, `user_roles` 2,
`audit_logs` 3, `cash_registers` 1— y las **7 `sessions` no se trasladaron a propósito**,
porque son efímeras: los usuarios vuelven a entrar. El ensayo previo comparó además las
12 tablas **valor por valor**: idénticas, con `sede_id` como única columna descartada, y
el catálogo insertó **0 filas** porque los valores de producción ganaron.

**La API sigue funcionando:** PostgREST resuelve los RPC **por nombre de argumento**, así
que una firma puede existir y la llamada fallar igual. Se compararon los nombres de
parámetro del catálogo contra las claves que manda el código para los 13 RPC que usa la
aplicación: **coinciden**, incluidos los 9 de `invoice_create_atomic`.

## Progress
| Unidad | Commit |
| --- | --- |
| La `077`: el borrado físico | `0131652` |
| Los cuatro defectos del pre-vuelo | `ae3b38b` |
| El squash: archivo único, historial, tests | `95d21e7` |
| El catálogo y el bootstrap | `91e374e` |
| El procedimiento reproducible | `44ed1bc` |
| El manual del reset | `a1fbeb4` |
| Merge a `main` | `686606b` |

**M3c cerrado** (la columna ya no existe en ninguna base) y **M4 revertido y ejecutado**
(el squash se hizo). El pendiente de la fila inactiva `Plataforma (sistema)` quedó
**resuelto por el reset**: las dos bases tienen exactamente una sede, activa.

## Next step
- **Rotar las dos claves de Supabase expuestas durante la sesión** (acción del dueño).
  No es gratis: al rotar la clave de base cambia también la contraseña del pooler, así
  que hay que actualizar las variables de entorno de la aplicación o deja de conectar.
- **El smoke test funcional de la aplicación contra las bases reseteadas** —entrar, abrir
  caja, emitir una factura—: **no se hizo**. La base está verificada a nivel de esquema,
  permisos y firmas de RPC, pero eso no es lo mismo que probar la aplicación.
- **PRUEBAS quedó con las default privileges de `supabase_admin` perdidas** (se
  resetearon antes de tener el procedimiento que las preserva). No se pueden reponer por
  SQL: es una operación de plataforma. PRODUCCIÓN las conserva.

## Route declaration
Trabajo de esquema y de datos, con verificación contra las bases reales. La escritura
sobre PRUEBAS y PRODUCCIÓN fue autorizada explícitamente por el dueño, y PRODUCCIÓN
requirió una confirmación aparte en el momento de ejecutarla.
