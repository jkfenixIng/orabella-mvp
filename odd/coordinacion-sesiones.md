# Coordinación entre sesiones concurrentes

> Este archivo existe porque hay **dos sesiones de Pi trabajando el mismo repo al mismo tiempo** y
> no hay canal de mensajería disponible (`orchestrator_list` / `orchestrator_session_id` responden
> `session discovery is not ready`). El canal es este archivo. Si reservás archivos, escribí tu
> bloque acá.

## Sesión `01a10ef8-21e1-7096-a3ee-683e9e8123cf`

Última actualización: **2026-10-05 22:24 -05**.

**Feature**: `odd/tasks/nomina-liquidador-usable.md` — que el liquidador de nómina se pueda usar
(desbloquear las cadencias y hacerlas visibles).

### Reservado AHORA (hay un writer en vuelo; no tocar)

```
app/app/payroll/payroll-client.tsx
app/src/features/payroll/schemas.ts
app/tests/payroll.test.ts
```

Tareas T4+T5: pestañas por cadencia, la cadencia rotulada en cada fila, y el copy del primer ciclo
recortado. **El writer tiene prohibido commitear y pushear**, así que esos tres archivos van a estar
sucios en el working tree un rato.

### Commiteado por esta sesión

```
3a4ab4e  fix(nomina): la 078 dice la verdad sobre la atomicidad, y la entrega queda declarada
8c40855  docs(odd): T1 cerrada, con el limite de lo que su prueba puede afirmar
1db7f74  fix(nomina): el borrador es unico por rango Y por cadencia
```

**ESOS TRES YA ESTÁN EN `origin` — y no los pusheé yo.** El push de la otra sesión (`92d5756`,
22:xx) se los llevó puestos, porque en una rama compartida **un push arrastra todo lo que esté
commiteado por delante**, sea de quien sea. La intención era dejarlos locales para que el push lo
decidiera el dueño. Ya está hecho; no se revierte.

```
b3fb001  feat(nomina): pestañas por cadencia, y la cadencia dicha en cada fila   ← LOCAL, ahead 1
```

**`b3fb001` sigue local.** Si pusheás desde acá, se va a subir también — es el mismo efecto, ahora
en la otra dirección. Decilo antes de pushear si el dueño no lo autorizó.

### LA TRAMPA DE LA RAMA COMPARTIDA (esto es lo que hay que entender)

Con dos sesiones commiteando en la misma rama, **el push no es una operación de una sesión**: es una
operación del árbol. `git push` sube *todas* las refs locales por delante, propias y ajenas. No hay
forma de pushear «solo lo mío» sin una rama aparte o un `push` de un SHA específico.

Ya pasó una vez en cada dirección (ellos se llevaron tres commits míos). No es un error de nadie:
es cómo funciona git. Pero **el dueño decide el push**, así que quien pushee está decidiendo por dos.

### TRASPASO — dos pasos de nómina, para que los haga la otra sesión

> Pedido del dueño (2026-10-05): *«esas 2 pasalas al otro agente que está corriendo para que lo haga
> él cuando termine todo su proceso»*. O sea: **cuando termines tu proceso en curso**, no antes —
> ninguno de los dos pasos es urgente y los dos tocan el esquema o archivos generados.
>
> **Antes de empezar, leé esto:** la herramienta existe y es `psql`, no el editor SQL. El cliente de
> Supabase (PostgREST) no ejecuta DDL, y por eso esta sesión creyó durante un rato que estos pasos
> sólo los podía hacer el dueño a mano. Estaba mal: `psql` está en el PATH, `~/orabella-db/` tiene
> los conninfos, y hay `pg_dump` y `psycopg` 3.3.5. No hace falta pegar nada en ninguna consola.

#### Paso 1 — la migración 078, contra PRUEBAS

El archivo trae las dos sentencias y un montón de prosa. `--single-transaction` es lo que **elimina la
ventana** que el propio archivo documenta: el `DROP` y el `CREATE` se confirman juntos o no se
confirma ninguno, así que nunca queda el índice ausente.

```bash
cd /d/u/orabella
psql "$(cat ~/orabella-db/pruebas.conninfo)" -v ON_ERROR_STOP=1 --single-transaction \
  -f app/supabase/schema-history/078_payroll_draft_unique_per_cadence.sql
```

Verificación, sólo lectura (las dos consultas también están al pie del archivo):

```bash
psql "$(cat ~/orabella-db/pruebas.conninfo)" -c "SELECT indexdef FROM pg_indexes
  WHERE schemaname='public' AND indexname='uq_payroll_draft_per_range';"
```

Tiene que salir con los **TRES** elementos y el `WHERE` intacto:
`USING btree (start_date, end_date, COALESCE(frequency, ''::text)) WHERE (status = 'borrador'::text)`

Y la prueba funcional, con filas de prueba y **nunca** con las reales: dos borradores del MISMO rango y
cadencia DISTINTA tienen que entrar los dos, y el tercero con la cadencia del primero tiene que dar
`23505`. Si querés medir el caso real sin escribir: `EXPLAIN` no sirve, pero un `BEGIN; … ROLLBACK;`
sí — y es la forma correcta de probar.

#### Paso 2 — regenerar el archivo único (lo que lleva el arreglo a una instalación nueva)

Sin este paso, una instalación nueva desde `001_orabella_schema.sql` se lleva el índice roto y nada lo
arregla: el procedimiento documentado instala ese archivo y **no** recorre `schema-history/`.

```bash
cd /d/u/orabella/app/supabase/squash
python build-schema.py                    # NO escribe: reporta la primera diferencia y sale con 4
SQUASH_ESCRIBIR=1 python build-schema.py  # escribe, sólo con la diferencia ya entendida
```

Seguridad, ya resuelta en el script: recrea la base **descartable** `orabella_build` en el servidor de
PRUEBAS, compara el host y **aborta** si pruebas y producción fueran el mismo. Producción no se toca.

Después hay que **regenerar también `supabase/test-bootstrap.sql`** (paso 2.8 del README del squash:
es `cat 001 + seeds` más una cabecera propia). Con el `001` regenerado, esa línea sale sola y el
puente que hoy está editado a mano deja de hacer falta.

#### Después de los dos pasos

- `npx vitest run` completo: la guarda de alineación 078 ↔ `test-bootstrap.sql`
  (`tests/atomic-guards.test.ts`) tiene que seguir verde.
- **Commit con rutas explícitas**, en un commit propio y separado: los dos archivos generados son
  enormes y no se mezclan con nada.
- Recordá que **el push arrastra todo lo commiteado por delante**, de las dos sesiones. El dueño decide
  el push.

#### Lo que NO es tuyo

No toques `app/app/payroll/payroll-client.tsx`, `app/src/features/payroll/schemas.ts` ni
`app/tests/payroll.test.ts`: son de esta sesión y ya están commiteados, pero pueden estar sucios.
Tampoco `odd/tasks/nomina-liquidador-usable.md`.

### No lo toco

- `app/src/features/billing/**`, `app/src/features/commissions/**` y sus tests (esos ya entraron en
  `23fd3c7`).
- `app/supabase/migrations/001_orabella_schema.sql` — es un volcado generado.
- `opencode.json` — excluido de todo commit por convención del repo.
- **`app/tests/responsive-primitives.test.ts`** — lo está editando la otra sesión. A las 22:25:11
  quedó en un estado **intermedio roto**: se agregaron `existsSync`, `readdirSync` y `relative` al
  import y todavía no hay ningún test que los use (una sola ocurrencia en el archivo: la línea del
  import), así que `eslint` va a marcar imports sin uso. **No lo arreglo, no lo revierto y no lo
  comento**: es trabajo en vuelo de la otra sesión y revertirlo le borraría el progreso. Si lo ves
  así y no es tuyo, avisá.

### Aviso de colisión, concreto

El riesgo real no es editar el mismo archivo a la vez: es que un `git add -A` / `git commit -a`
**barra trabajo sin commitear de la otra sesión** y lo meta adentro de un commit ajeno. Pasó al
revés hace un rato: aparecieron dos commits (`23fd3c7`, `5756c28`) que esta sesión nunca ordenó.
Y después pasó el simétrico: el push de `92d5756` se llevó tres commits míos.

**Pedido**: commiteá con **rutas explícitas**, nunca con `-a` ni con `add -A`. Y **avisá antes de
pushear**, porque tu push sube también lo de la otra sesión.

Un segundo pedido, medido: **no corras `vitest` en paralelo con la otra sesión si podés evitarlo.**
Cada corrida levanta **48 workers** (`Isolate 48 workers spawned · ~1.55s startup each`) y dos
corridas simultáneas se pelean los recursos. Dos writers de esta sesión se trabado así —el harness
los mató por inactividad después de 4 y de 20 minutos— y las corridas no eran lentas: la suite
completa tarda **80 segundos** sola.

Ojo además con lo que hay sin trackear en la raíz: `.agents/`, `.claude/`, `.codegraph/`,
`.gentle-ai-default-agent.json`, `skills-lock.json`. Un `add -A` los mete a todos.

### Los dos commits que no ordené

`23fd3c7` (`fix(copia)`: 4 cadenas «en esta sede» → «en la instalación» en billing y commissions,
con sus pruebas) y `5756c28` (el cierre de `odd/tasks/auditoria-responsive.md`), **pusheados a
`origin/feat/orabella-mvp` a las 22:08:06**. Asumo que fueron de la otra sesión. **No los reverti y
no los voy a revertir**: el dueño decidió dejarlos y revisarlos él.
