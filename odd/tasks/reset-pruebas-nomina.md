# Reset de PRUEBAS desde el artefacto, y la base lista para probar nómina

## Objective

Devolver **PRUEBAS** al estado que produce el artefacto vigente —`001_orabella_schema.sql`
regenerado en `8512020`— y dejarla en el punto exacto en que la primera liquidación de nómina se
puede probar operando la aplicación.

## Autorización

El dueño eligió la **opción 2** («Reset de PRUEBAS desde el artefacto + reseed») el **2026-10-06
18:59**, después de ver la medición que refutaba la premisa «falta un reset». Autoriza el vaciado
de `public` en PRUEBAS, con la pérdida declarada:

| Qué se pierde | Detalle |
| --- | --- |
| Datos operados a mano | 2 facturas, 1 vale, 0 pagos, sesiones |
| Claves de las 2 cuentas ya usadas | Carolina y Jorge vuelven a clave = documento con cambio forzado |
| — | 448 filas vivas en `public` en total |

## Lo que NO se toca (y por eso el procedimiento es el ensayado)

- El esquema `public` **no se borra**: su `nspacl` y sus `pg_default_acl` sobreviven. Ése es el
  motivo del procedimiento `reset-public-sin-borrar-esquema.sql` (§8 del README del squash), y no
  el `DROP SCHEMA public CASCADE` que le costó a PRUEBAS las default privileges de
  `supabase_admin` en el reset de 2026-10-03.
- Esos privilegios **no se recuperan** con este procedimiento (§8.6). Siguen siendo deuda de
  plataforma.
- Ningún otro esquema (`auth`, `extensions`, ...) ni los roles de la plataforma.

## Procedimiento autoritativo

`app/supabase/squash/README.md` §8.2. Orden exacto, cada paso en una transacción:

1. `reset-public-sin-borrar-esquema.sql -v DROP_BTREE_GIST=0`
2. `001_orabella_schema.sql`
3. `seeds/catalog.sql`
4. `seeds/acceptance.sql` — el fixture §11; sin él, el interlock del seed de humo aborta (condición
   de datos: usuarios `@ejemplo.co`)
5. `seeds/smoke.sql` — cadencias de los 10 activos

## Tareas

- [x] **T1** — Volcado de seguridad: `~/orabella-db/pruebas-antes-del-reset-20261006-190122.sql`
  (**429.733 bytes**, esquema + datos de `public`), tomado antes de cualquier DDL.
- [x] **T2** — Vaciado con `DROP_BTREE_GIST=0`: exit 0. `nspacl` y las 3 filas de `pg_default_acl`
  **idénticos** antes y después (`diff linea-base-acl-antes.txt linea-base-acl-despues.txt` vacío).
  `public` quedó con **0 relaciones, 0 funciones propias, 0 tipos propios**. Los 8 esquemas de
  plataforma intactos.
- [x] **T3** — `001_orabella_schema.sql` con `--single-transaction`: exit 0, 0 errores. El archivo
  no trae `BEGIN`/`COMMIT` propios (0 ocurrencias), así que la transacción externa es la única.
- [x] **T4** — `catalog.sql` → `acceptance.sql` → `smoke.sql`, cada uno `--single-transaction`:
  los tres exit 0. El seed de humo escribió **`UPDATE 8`**.
- [x] **T5** — `reset-verificacion.sql` con `roles_default_esperados='postgres'`:
  **15 OK, 0 FALLA**, exit 0. Conteos vivos: 36 tablas, 36 con RLS, 10 políticas, 0 períodos de
  nómina, 10 usuarios, índice `uq_payroll_draft_per_range` **CON CADENCIA**, 0 facturas / 0 vales /
  0 pagos / 0 turnos, `sedes.payroll_start_date` = NULL (columna sin uso).

  **Alarma mía, refutada al medirla**: creí que el reset se había llevado el esquema
  `graphql_public` (las dos listas decían 8 y 7). No: la §11 del verificador es una *allowlist* de
  7 esquemas de plataforma y `graphql_public` no está en ella. La consulta viva da **8**. Comparé
  dos consultas distintas como si midieran el mismo conjunto.

- [x] **T6** — Verificación independiente (read-only) delegada, contra los entregables y no contra
  el informe del ejecutor: **`muxcird7-1-ibin`, sin un solo FAIL**.

  | Check independiente | Veredicto |
  | --- | --- |
  | Esquema vivo == artefacto | 36 tablas / 36 con RLS / 10 políticas == 36/36/10 declaradas en el `001`; 28 funciones y 113 índices reconciliados uno a uno; 0 tipos propios |
  | Índice de borradores | vivo == `001_orabella_schema.sql:7163` |
  | Producto del seed | `null=2, semanal=1, quincenal=3, mensual=4`; el `VALUES` cubre 8 ids; `acceptance.sql` **no tiene** `pay_frequency` en ninguno de sus commits |
  | Hallazgo del T5 | **CONFIRMADO**, con un discriminador mejor que el mío |
  | Volcado de T1 | restaurable (36 `COPY`, 21 con filas), 429.733 bytes |
  | ACL | idéntico carácter por carácter contra la línea base |
  | Falsificación | ninguna tabla/función/tipo/fila que el artefacto + los seeds no pudieran producir |

  **El discriminador que no tenía**: las **8** filas del seed comparten un único `updated_at` de lote
  (`2026-10-04 22:03:22.147536+00`), y las dos manuales tienen el suyo (21:35:33 / 21:37:56). Un
  lote de seed y dos escrituras sueltas, medido por timestamp.

  **Me corrigió a mí, dos veces**: (a) mi lista de tablas que «ningún seed escribe» omitía
  `inventory_movements`, que `acceptance.sql:151/159/167` sí siembra (3 filas) — espec mía
  incompleta, no deriva de base; (b) declaró **no demostrables desde los logs** dos cosas que yo
  di por hechas: que cada paso fuera en su propia transacción y el orden exacto (todos los
  timestamps son 19:03; el orden se infiere porque `acceptance` necesita el `sedes` de `catalog`).

  **Y una tercera que no es del reset**: el `FALLA` de las default privileges de `supabase_admin`
  sólo pasó porque declamé `roles_default_esperados='postgres'`. Es la verdad de PRUEBAS y la deuda
  del §8.6 del README, no un resultado del vaciado.
- [x] **T7** — Entregado: la app apunta a PRUEBAS y vive (`/login` 200, `/payroll` 307 a login
  porque `sessions` quedó vacía), 313 filas vivas contra 448 antes, y el smoke de nómina quedó al
  alcance del dueño (0 períodos = estado de primera liquidación, 9 avisos: 3 por cadencia).

## Hallazgo abierto (T5): el seed declara un reparto que su SQL no produce

Estado real tras el reset, medido: `mensual=4`, `quincenal=3`, **`semanal=1`**, **`NULL=2`**
(Andrés Quintero y Carolina Rojas, sin cadencia).

Pero el encabezado de `seeds/smoke.sql` afirma lo contrario: que en `semanal` quedan los tres
`pay_type` («`fijo` Lucía, `porcentaje` Andrés, `mixto` Carolina») y que a esa cadencia «se le suma
la-fijo a los dos que **ya trae**». La evidencia medida dice:

| Evidencia | Medición |
| --- | --- |
| Filas del `VALUES` de cadencias | **8**, y ninguna es `10000001` ni `10000004` — en `HEAD` **y** en `d46c35d` |
| `acceptance.sql` | su `INSERT` de empleados **no tiene** `pay_frequency` |
| El volcado previo (T1) | esos dos tenían `semanal` con `updated_at` **2026-10-04 21:35:33 / 21:37:56**, horas después del seed (00:46:35) |

Lectura: el estado «semanal 3, 0 sin cadencia» **nunca lo produjo el seed** — lo produjo trabajo
manual en la UI el 2026-10-04 por la tarde, y tanto la prosa del seed como el «estado final» de
`odd/tasks/datos-humo-pruebas.md:112` documentaron ese estado **observado** como si fuera
**producido**. Es la clase de defecto que el propio commit `4b9103f` declaró: «nada mide el seed en
tiempo de ejecución».

Consecuencia funcional, sin dramatizar: la condición que importa —un ciclo que ejercite `fijo`,
`porcentaje` y `mixto`— **se cumple igual en `quincenal`** (Marco fijo, Diego porcentaje, Paola
mixto). Lo que no se cumple es el nombre de la cadencia que la prosa declara, y los dos empleados
sin cadencia quedan **fuera de todo aviso de pendientes** (regla 1 de `pendingPayrollSettlements`).

**Decisión pendiente del dueño**: dejar la prosa como deuda declarada, corregir el `VALUES` para
que el seed produzca lo que declara, o además meter una verificación que mida el seed **en
ejecución** (la deuda que el propio `4b9103f` declaró: «nada mide el seed en tiempo de ejecución»).

**Decisión tomada el 2026-10-06**: corregir el seed. Y una segunda decisión, porque el `mixto` no
se podía producir desde el fixture: `acceptance.sql:75` siembra a Carolina Rojas como **`fijo`,
1.5M, sin comisión**, y el `mixto` 60% que la prosa le atribuía era **otra edición manual** del
mismo minuto (21:35:33) que se llevó el reset. Se eligió el arreglo que **no inventa ningún dato
de negocio**: los 10 con cadencia, y la prosa nombra **`quincenal`** —la cadencia que ya ejercita
`fijo`+`porcentaje`+`mixto`— en vez de `semanal`.

**Lo que el dueño tiene que saber**: el reset se llevó ese `mixto` 60% de Carolina. El fixture la
siembra `fijo` y sin comisión, así que su liquidación **no va a llevar comisión** hasta que se
reponga en la UI. El seed no lo repone por decisión explícita (sería pisar lo que la UI cambia).

## Corrección del seed (T8–T9)

`app/supabase/seeds/smoke.sql`: el `VALUES` de cadencias pasa de **8 a 10 filas**
(`('10000004','semanal')` Andrés, `('10000001','semanal')` Carolina) y la prosa deja de afirmar lo
que el SQL no produce. La única línea funcional del cambio son esas dos filas: el diff sin
comentarios agrega dos líneas y **no quita ninguna**, y el bloque
`WHERE e.user_id = u.id AND e.is_active AND e.pay_frequency IS NULL` queda **byte a byte idéntico**
(la idempotencia y el contrato de no pisar la UI siguen en pie).

`odd/tasks/datos-humo-pruebas.md`: corregido su registro —el `UPDATE 8` y el «semanal 3 / 0 sin
cadencia» del mismo bloque no podían ser ciertos a la vez— con nota fechada, más dos prosa
vencidas que encontró el writer: la línea que declaraba «3 sentencias (interlock, cadencias,
fecha)» cuando `4b9103f` había quitado la tercera, y el `UPDATE 1` de la tabla de corridas, que ya
no existe. U5–U8 quedaron tildadas contra `git log` (`d46c35d`, `403068a`), no de memoria.

- [x] **T8** — Worker `muxcynp9-2-koxy`: las dos filas y la prosa. Reportó además las dos prosa
  vencidas del doc, que se corrigieron en la misma unidad por ser el mismo defecto a cuatro líneas.
- [x] **T9** — Re-aplicado a PRUEBAS: 1ª corrida **`UPDATE 2`**, 2ª corrida **`UPDATE 0`**. Reparto
  vivo: `semanal 3` (fijo, porcentaje) · `quincenal 3` (**fijo, mixto, porcentaje**) · `mensual 4` ·
  **0 sin cadencia**.
- [x] **T10** — Verificación independiente del efecto: `muxd4v1z-3-7x4z`, read-only. **PASS en el
  núcleo**: 2 sentencias (`:51` interlock, `:103` UPDATE), el `VALUES` cubre exactamente los 10
  id_numbers del fixture con los nombres que `acceptance.sql:32–43` les da, el guard
  `WHERE … pay_frequency IS NULL` (`:123-125`) intacto, ninguna sentencia escribe `pay_type`,
  `salary_fixed`, `commission_percent`, `payout_mode` ni `sedes.payroll_start_date` (esos tokens
  sólo aparecen en comentarios), y la base viva confirma `null_cad=0` con `quincenal` como la
  **única** cadencia con los tres tipos.

  **Cuatro residuos que encontró, todos pagados**: (1) `datos-humo-pruebas.md:119` seguía
  afirmando `payroll_start_date = 2026-09-16` sin anotar, y hoy es **NULL**; (2) la sección de
  «Aritmética de la fecha» presuponía un `ARRANQUE` configurado que nadie escribe; (3) **U8 estaba
  tildada con el arreglo sin commitear** — se paga con el commit de esta unidad; (4) **cuatro
  referencias de línea driftadas** en la prosa del seed: `schemas.ts:1331` → **1604**,
  `schemas.ts:817` → **927**, `service.ts:1800` → **1778** y `schemas.ts:978` → **1124** (esta
  última la encontré yo midiendo, no la reportó el verificador). Las cuatro las verifiqué con
  `grep` sobre el código, no copiando su informe.

  **No confirmable, declarado**: que los logs de las dos corridas vengan de esta versión del
  archivo contra esta base (son texto plano sin firma), y la idempotencia general a partir de una
  sola repetición observada. Lo que sí queda probado por estructura es el guard `IS NULL`, que es
  el que la garantiza.

## Criterio de cierre

PRUEBAS = producto del `001` vigente + los tres seeds, con 0 períodos de nómina (estado de primera
liquidación) y las tres cadencias pobladas. Si algo no cierra, el reset queda revertido por
transacción y se reporta sin adornos.

## Riesgos

- **Bloqueo por conexiones vivas.** El dev server de :3000 está corriendo contra PRUEBAS: si deja
  una transacción abierta, el `DROP` espera un `ACCESS EXCLUSIVE` que nunca llega. Señal: el paso 2
  se cuelga. Remedio: parar el dev server y reintentar (la transacción fallida no deja nada a medias).
- **El procedimiento es idempotente y transaccional**, así que un fallo a mitad no deja la base a
  medio vaciar.
- **`must_change_password`**: tras el reseed, la primera entrada obliga a cambiar la clave (AUTH-01).
  Es el comportamiento del fixture, no un efecto del reset.

## Rollback

El volcado de T1 es la única vuelta atrás real: el reset no tiene deshacer, y las default
privileges de `supabase_admin` no se reponen desde `postgres`.
