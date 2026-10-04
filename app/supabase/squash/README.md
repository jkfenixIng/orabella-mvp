# Squash del esquema — manual del operador

Este archivo es el procedimiento del squash. `app/supabase/migrations/001_orabella_schema.sql`
ya existe y está commiteado: lo que este manual describe es cómo se **vuelve a
producir**, y la diferencia es que ahora ese procedimiento es un script
(`app/supabase/squash/build-schema.py`) que se corre, y que al terminar
compara el resultado con el archivo commiteado sha256 contra sha256.

No es documentación del esquema: es el procedimiento que lo produce, con sus
requisitos, sus comandos exactos y las comprobaciones que tienen que salir
limpias.

Alcance de este manual:

- el proyecto vive en `D:/u/orabella` y la aplicación en `D:/u/orabella/app`;
- la fuente es la serie histórica completa aplicada sobre una base **descartable**
  (serie 001-077; 76 archivos en `app/supabase/schema-history/`, la 032 nunca
  existió), no el estado en que esté la base de PRUEBAS (ver 3.1);
- el resultado es un solo archivo aplicado: `001_orabella_schema.sql`, y el
  historial queda en `app/supabase/schema-history/` como respaldo y como
  explicación (punto 6).

---

## 1. Qué es el squash y por qué el dump es la fuente

El squash reemplaza el historial de migraciones —que es un registro de
reescrituras, no un estado— por un único archivo que declara el esquema tal como
está hoy. Reescribir el historial a mano no es viable: en la serie completa hay
156 declaraciones de función que colapsan en **28**, 63 declaraciones de política
que colapsan en **10**, y restricciones de exclusión de las que sobrevive **1**,
además de cientos de objetos que se crean, se alteran y se vuelven a declarar. Por
eso la fuente del archivo único es un `pg_dump --schema-only` de una base con la
serie aplicada: el volcado no interpreta el historial, describe el resultado, de
modo que lo sustituye sin que nadie tenga que reconstruir por lectura qué
declaración sobrevive al final. Lo único que no sale de un `--schema-only` son los
permisos, y por eso el volcado del procedimiento va **sin** `--no-privileges`
(2.4): los `REVOKE` y `GRANT` de las funciones son parte del objeto.

---

## 2. El procedimiento vigente: un comando

El squash ya no se hace a mano. Lo hace **un script commiteado y
reproducible**: `app/supabase/squash/build-schema.py`. Corre la serie completa
sobre una base DESCARTABLE del servidor de PRUEBAS, la vuelca, ensambla el
archivo único y —esto es lo que lo hace un procedimiento y no un juego— **compara
el resultado con el archivo commiteado, sha256 contra sha256**.

Los bloques de este manual son **bash** (en esta máquina, el bash de Git). Si la
terminal es PowerShell, el bloque de la sección 7 es el equivalente comando a
comando; pero el procedimiento, su orden y sus verificaciones son los mismos, y
el script no necesita traducción porque es Python nativo de Windows.

### 2.1 El comando

```bash
cd D:/u/orabella
python app/supabase/squash/build-schema.py
```

Códigos de salida, porque un procedimiento que no dice cómo falla no es un
procedimiento:

| código | qué pasó |
| --- | --- |
| `0` | todo salió bien **y** el archivo ensamblado es idéntico al commiteado |
| `2` | se abortó una guarda: credenciales, prod == pruebas, encabezado inválido, volcado con otra forma |
| `3` | una migración falló y no se pidió el modo provisional: **no** se produjo volcado |
| `4` | lo ensamblado **no** coincide con el archivo commiteado, y sin `SQUASH_ESCRIBIR=1` no se escribe nada |

### 2.2 Requisitos

- **`~/orabella-db/pruebas.conninfo`**: la credencial de PRUEBAS, en formato
  conninfo de libpq (`host`, `port`, `dbname`, `user`, `password`). Vive FUERA
  del repo y no se pega en ningún lado: el script la lee, y la clave llega a
  `psql` y a `pg_dump` por el entorno (`PGPASSWORD`), nunca en una línea de
  comandos. Es la clave de la base de datos (Dashboard → Settings → Database →
  DB password), no la `service_role` ni la `anon`.
- **`~/orabella-db/prod.conninfo`**: la de producción, leída **solo** para
  comparar `host` y `user` con la de pruebas. Si coinciden, el script aborta sin
  conectarse a nada. Con esto, un conninfo mal puesto no puede convertir una
  corrida de ensayo en una escritura sobre producción.
- **Cliente PostgreSQL 18.3 en `PATH`** (`psql` y `pg_dump`). El archivo
  commiteado lo emitió esa versión; con otra, cambian las cabeceras de sección y
  la comparación sha256 falla por el cliente, no por el esquema.
- **Python 3.11 con `psycopg` 3** (`pip install "psycopg[binary]"`). Es el mismo
  intérprete nativo de Windows; el script usa `os.path.expanduser("~")` para el
  directorio de trabajo, así que no depende de `/tmp`.
- **`app/supabase/squash/_platform_fixture.sql`**: el stub descartable de
  `auth.jwt()`. El script lo **copia** a `~/orabella-db/_platform_fixture.sql` y
  lo aplica ahí, antes de la 001. En el repo solo se lee.
- **La base descartable `orabella_build`**, en el servidor de PRUEBAS. No hace
  falta crearla: el script hace `DROP DATABASE IF EXISTS ... WITH (FORCE)` +
  `CREATE DATABASE` en cada corrida, que es lo que la hace reproducible.

### 2.3 Lo que hay en `app/supabase/squash/`

| archivo | qué es |
| --- | --- |
| `build-schema.py` | el procedimiento: construye, vuelca, ensambla y compara |
| `schema-header.sql` | las 188 líneas de prosa del encabezado del archivo único. **No se genera**: se concatena tal cual. Cambia cuando cambia el inventario o la explicación, y el cambio se escribe a mano y se revisa como prosa |
| `_platform_fixture.sql` | el stub de `auth.jwt()`, descartable, para que el historial compile en una base nueva |
| `README.md` | este manual |

La serie histórica ya **no** está en `app/supabase/migrations/`: está en
`app/supabase/schema-history/`, y de ahí la lee y la aplica el script.

### 2.4 Qué hace, paso a paso

1. **Guardas.** Lee los dos conninfo, verifica que el host y el usuario de
   pruebas no sean los de producción, y que `orabella_build` no sea el
   `dbname` de ninguno de los dos.
2. **Base temporal.** `DROP DATABASE IF EXISTS orabella_build WITH (FORCE)` +
   `CREATE DATABASE`, conectándose a `postgres` únicamente como servidor.
3. **Fixture de plataforma.** Copia `_platform_fixture.sql` fuera del repo, lo
   aplica con `psql -v ON_ERROR_STOP=1 --single-transaction`, y comprueba que
   `auth.jwt()` devuelve `NULL::jsonb`.
4. **`btree_gist`.** Verifica que el usuario del pooler puede crearla: la 035 y la
   074 la necesitan, y que el historial se frene ahí se sabe antes.
5. **Serie histórica.** Aplica `app/supabase/schema-history/*.sql` en orden
   alfabético, **uno por uno**, cada uno con su propia transacción y
   `ON_ERROR_STOP=1`, y se detiene en el primero que falle reportando archivo,
   línea y mensaje. No parchea nada, no saltea nada, no reintenta.
6. **Volcado.** `pg_dump --schema-only --no-owner --exclude-schema=auth` — **sin
   `--no-privileges`**, porque los `REVOKE` y `GRANT` de las funciones son parte
   del objeto. Se excluye `auth` porque el destino ya lo tiene.
7. **Verificaciones del volcado** (secciones 3.3 a 3.6 de este manual).
8. **Ensamblado.** `app/supabase/squash/schema-header.sql` + el cuerpo del
   volcado, y la comparación sha256 contra `git show HEAD:...` (sección 3.2).
9. **Resumen.** Los dos sha256, el veredicto y los conteos.

### 2.5 Las guardas: por qué PRUEBAS y PRODUCCIÓN no se tocan

- El conninfo de **producción** se abre, se lee y se cierra. No hay ninguna
  llamada a él después: si `host` o `user` coinciden con los de pruebas, se aborta
  antes de crear nada.
- A **PRUEBAS** solo se entra para crear y descartar `orabella_build`, y para
  leer el catálogo de esa base temporal. La base de servicio `postgres` se usa
  como servidor de administración, no se modifica.
- El volcado sale de `orabella_build`, no de PRUEBAS: aunque el `--file` apuntara
  mal, el esquema que se describe es el que el script acaba de construir.
- `schema-header.sql`, `_platform_fixture.sql` y `app/supabase/schema-history/`
  se abren **en lectura**. El script no tiene ninguna ruta de escritura sobre
  ellos.

### 2.6 El ensamblado: encabezado + cuerpo, y las ocho líneas que se descartan

`app/supabase/migrations/001_orabella_schema.sql` son dos piezas, y solo dos:

- el **encabezado**: las 188 líneas de `app/supabase/squash/schema-header.sql`,
  byte a byte como están. Es prosa, no SQL: se escribe a mano y se revisa como
  prosa; el script la concatena y no la toca.
- el **cuerpo**: el volcado entero (8.100 líneas) menos **ocho** líneas, y solo
  ocho:

  | líneas del volcado | qué son |
  | --- | --- |
  | 1 a 5 | el banner `--` / `-- PostgreSQL database dump` / `--`, la vacía, y el metacomando `\restrict` con su clave aleatoria de sesión |
  | 6 | la vacía que sigue al `\restrict` |
  | 8.099 | el `\unrestrict` correspondiente |
  | 8.100 | la vacía del final |

  `\restrict` y `\unrestrict` no son SQL: es lo que psql 18 emite alrededor de un
  volcado para que no interprete como metacomando lo que en realidad son
  literales. Un cliente que no los conozca aborta la carga, y el archivo se
  aplica con otros clientes y con versiones anteriores de `psql`. La clave que
  los acompaña es un token aleatorio por sesión, no información del esquema.

  Resultado: 188 + 8.092 = **8.280 líneas**, 368.743 bytes. Nada más se quita,
  nada se reordena y nada se escribe a mano.

Lo que el script produce, y dónde:

| archivo | qué es |
| --- | --- |
| `~/orabella-db/esquema-final.sql` | el volcado crudo, con su `\restrict` y su banner |
| `~/orabella-db/esquema-001-ensamblado.sql` | el archivo único ensamblado, copia de trabajo |
| `app/supabase/migrations/001_orabella_schema.sql` | **solo** si el ensamblado coincide byte a byte con lo que ya está |

Cuando el ensamblado es idéntico al archivo del repo, el script no escribe
nada: escribirlo sería un no-op y `git status` sigue limpio.

### 2.7 Los dos modos que no son el normal

**Modo provisional** — solo para revisar una frontera de plataforma sin esperar
al arreglo:

```bash
SQUASH_PROVISIONAL=1 python app/supabase/squash/build-schema.py
```

Vuelca el estado **alcanzado hasta la falla** en un archivo con `PROVISIONAL` en
el nombre, con su banner propio, y lo verifica igual. No parchea la migración, no
la saltea y no reintenta. **En ese modo no se ensambla el archivo único**: un
volcado provisional nunca es la fuente de nada.

**Forzar la escritura** — solo con la diferencia ya entendida:

```bash
SQUASH_ESCRIBIR=1 python app/supabase/squash/build-schema.py
```

Sin esta variable, si los sha256 difieren, el script imprime la primera línea
que difiere, dice si la diferencia está en el encabezado o en el cuerpo, deja el
ensamblado en `~/orabella-db/` para poder compararlo con `diff`, y **no escribe
el archivo commiteado**. Ver 3.2.

### 2.8 Regenerar `app/supabase/test-bootstrap.sql`

Esto el script **no** lo hace, porque no es parte del esquema: es el bootstrap
completo (esquema + seeds), y en esta unidad otro writer está sobre los seeds.
Cuando toque rehacerlo, se hace por concatenación, en el mismo orden en que el
runner los aplicaría, sobre el archivo único **ya** generado:

```bash
cd D:/u/orabella/app
SQUASH=supabase/migrations/001_orabella_schema.sql
TMP="$(mktemp)"
{
  echo "-- test-bootstrap.sql — generado, no editado a mano."
  echo "-- Orden: 001_orabella_schema.sql y luego seeds/acceptance.sql."
  echo "-- Regenerar con el paso 2.8 de supabase/squash/README.md."
  echo
  cat "$SQUASH"
  echo
  echo "-- ================= seeds/acceptance.sql ================="
  cat supabase/seeds/acceptance.sql
} > "$TMP" && mv "$TMP" supabase/test-bootstrap.sql
```

Y la comprobación de que quedó entero:

```bash
grep -c "^CREATE TABLE public\."  supabase/test-bootstrap.sql     # 36
grep -c "^CREATE POLICY "         supabase/test-bootstrap.sql     # 10
grep -n "seeds/acceptance.sql"    supabase/test-bootstrap.sql
```

Las dos cifras salen del archivo único y solo de él: `seeds/acceptance.sql` es
dato y no declara ninguna tabla ni ninguna política, así que no suma a ninguna.
Las **10** políticas, y no las 37 de una etapa anterior, son las que declara el
estado POST-077.

### 2.9 `app/supabase/seeds/acceptance.sql` no se toca

Este seed es **dato**, no esquema: sede, catálogos, empleados y caja lista, con
nombres ficticios. El squash no lo incluye, el bootstrap lo concatena tal cual, y
su contenido no se edita. Prueba de que sigue intacto:

```bash
git -C D:/u/orabella diff --stat -- app/supabase/seeds/acceptance.sql
```

La salida tiene que estar **vacía**.

---

## 3. Verificación obligatoria

La verifica el script, en sus pasos 7 a 9. No hay ritual aparte que hacer a mano
antes de dar por bueno el archivo: correr el script ES la verificación, y su
código de salida lo dice.

### 3.1 Por qué el ensayo ya no es un volcado desde PRUEBAS

Antes el manual volcaba el esquema **desde la base de PRUEBAS** y comparaba ese
volcado contra una base reconstruida en local (`squash_check`). Ese procedimiento
se descartó, y no por gusto:

- **PRUEBAS estaba atrasada respecto de la 017**, así que su esquema no era el
  estado final: el ensayo describía otra base, y una comparación contra otra base
  no probaba nada sobre el archivo único.
- Volcar de una base de servicio significa que el resultado depende del estado
  que ese servicio tenga **en ese momento**. Una corrida de hoy y otra de mañana
  pueden dar archivos distintos sin que cambie una línea de la serie.
- Reconstruir en local exigía una instalación de PostgreSQL que esta máquina no
  tiene, y aun así el diff final era indirecto.

Lo que se usa en su lugar es una **base descartable construida desde la serie**:
`orabella_build` se crea y se tira en cada corrida, se siembra con las 76
migraciones de `app/supabase/schema-history/` y se vuelca. El ensayo es el
procedimiento mismo, y el resultado depende del historial, no del estado de
nadie. La base de PRUEBAS solo aporta el servidor y la credencial.

### 3.2 La comparación que decide: sha256

El script imprime los tres hashes y el veredicto:

```
sha256 del archivo ENSAMBLADO (este script)    5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5
sha256 del archivo COMMITEADO (git show HEAD:) 5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5
sha256 del archivo EN EL ARBOL DE TRABAJO      5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5

VEREDICTO CONTRA LO COMMITEADO: IDENTICO
```

Y en el resumen:

```
sha256 ensamblado por esta corrida : 5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5
sha256 commiteado (git show HEAD:) : 5daaca1ea3c320d493bd3178b76f216ca91d5a84dd17cf8b824d86e642acc7b5
veredicto                          : IDENTICO
```

Ese SHA-256 es el del archivo único en `HEAD` (`95d21e7`), con su encabezado de
188 líneas y su cuerpo de 8.092. Es el mismo que imprimiría cualquiera:

```bash
git show HEAD:app/supabase/migrations/001_orabella_schema.sql | sha256sum
```

**Si difieren, no se ajusta el archivo commiteado para que coincida.** El archivo
commiteado es el que dice la verdad: un procedimiento que produce otra cosa no es
un procedimiento, y "cambiar el archivo hasta que el hash dé" convierte la
verificación en una tautología. Lo que se hace es:

1. Leer el diagnóstico que imprime el script: dice si la diferencia está en el
   **encabezado** o en el **cuerpo**, y en qué línea del cuerpo.
2. Si está en el encabezado, la causa es `schema-header.sql`: el inventario
   cambió, o alguien regeneró la prosa. Va en el commit, con su cuenta.
3. Si está en el cuerpo, la causa es el historial o el cliente: una migración
   cambió, o el `pg_dump` que se usó no era el 18.3. **Nunca** se "corrige"
   editando el archivo único a mano.
4. Con la causa entendida, y solo entonces, `SQUASH_ESCRIBIR=1` si corresponde.

El volcado intermedio (`~/orabella-db/esquema-final.sql`) **no** tiene sha
estable: su línea `\restrict` lleva una clave aleatoria por sesión. El que se
compara es el del archivo ensamblado.

### 3.3 Conteos por tipo, con los números esperados

El script imprime el volcado contra el catálogo y marca `<-- REVISAR` en lo que
no cuadra. Los valores esperados son los que declara el encabezado del archivo
único, y son **exactos**: ese encabezado es el inventario.

| tipo | esperado | dónde se comprueba |
| --- | --- | --- |
| extensiones | 2 (`btree_gist`, `pgcrypto`) | paso 5 del script, `extensiones instaladas` |
| tablas | 36 | paso 5, `tablas` |
| funciones (sin extensión) | 28 | paso 5, `funciones (sin extension)` |
| políticas RLS | 10 | paso 5, `politicas RLS` |
| índices (sin PK/UNIQUE/EXCLUDE) | 65 | paso 5, `indices sinPk/UNIQUE/EXCLUDE` |
| restricciones PRIMARY KEY | 34 | paso 5, `restricciones (total)` desglosado |
| FOREIGN KEY | 56 | ídem |
| UNIQUE | 13 | ídem |
| EXCLUDE | 1 | paso 7, `a) ex_payroll_periods_no_overlap` |
| CHECK en línea | 128 | paso 5, `CHECK inline en CREATE TABLE` |
| disparadores | 21 | paso 5, y en el encabezado |
| tablas con RLS | 36 | paso 5, `RLS habilitadas` |
| `COMMENT ON` | 139 | `grep -c "^COMMENT ON "` sobre el archivo |
| `GRANT`/`REVOKE` | 43 (21 + 22) | `grep -cE "^(REVOKE\|GRANT) "` sobre el archivo |

Dos aclaraciones que el script ya imprime, y que conviene no volver a descubrir:

- **Un índice que sostiene una PK, una UNIQUE o una EXCLUDE no sale como
  `CREATE INDEX`**: sale dentro del `ADD CONSTRAINT`. Por eso `indices` compara 65
  y no los 81 del catálogo.
- **El volcado no incluye los objetos que pertenecen a una extensión** (solo su
  `CREATE EXTENSION`), y `btree_gist` queda instalada en `public` en la base
  temporal: por eso `funciones` compara 28 contra 28 y no contra las 30 del
  catálogo sin filtrar.

Los dos `grep` sobre el archivo único:

```bash
grep -cE "^(REVOKE|GRANT) " app/supabase/migrations/001_orabella_schema.sql   # 43
grep -c "^COMMENT ON "        app/supabase/migrations/001_orabella_schema.sql   # 139
```

### 3.4 La frontera de plataforma

Lo que el paso 7 del script tiene que imprimir:

- **ningún** objeto de plataforma declarado: cero `CREATE SCHEMA auth`, cero
  `CREATE FUNCTION auth.`, cero `COMMENT ON SCHEMA auth`, cero `ALTER DEFAULT
  PRIVILEGES IN SCHEMA auth`, y el único esquema declarado es `public`.
- las **referencias** a `auth.jwt()` conservadas: las 2 aparecen dentro de
  cuerpos `$$`, ninguna suelta. Un volcado captura texto, no comportamiento: la
  referencia sobrevive, la declaración no.
- el cuerpo de `public.current_sede_id()` idéntico al del historial: la última
  definición con cuerpo es la de `008_hardening.sql`, y el script la imprime
  entera y la busca, texto íntegro, dentro del volcado.

### 3.5 Las dos comprobaciones exigidas, y la caída de `sede_id`

El paso 7 las deja cerradas:

```
a) ex_payroll_periods_no_overlap   ...presenta en el volcado
b) users.sede_id                   catalogo: presente   volcado: presente
```

El paso 6 recorre el volcado sin comentarios, literales ni cuerpos `$$`, y lista
cada línea que nombra `sede_id` y `current_sede_id`, con el objeto al que
pertenece. El veredicto tiene que ser: `sede_id` solo aparece en `public.users`
(y `public.sedes` como destino de la FK). Cualquier otra tabla en la lista es una
fuga de la etapa anterior a la 074 y la 077.

### 3.6 Estructura pura: el volcado no lleva datos

El paso 8 cuenta, sobre el texto del volcado:

| patrón | esperado |
| --- | --- |
| `^INSERT INTO ` | 0 |
| `^COPY ` | 0 |
| `^SELECT .* FROM public.` | 0 |
| `generate_series` (dentro de cuerpos) | > 0, y son funciones, no datos |

Las filas que la serie siembra —denominaciones, formas de pago, configs de IVA,
catálogo de roles, sede única, `system_settings`— viven en la base temporal, que
es descartable. El archivo único es estructura.

### 3.7 La regla

**Cualquier discrepancia bloquea.** No hay "diferencias menores" ni "esto se ajusta
a mano después":

- si una migración falla, se busca por qué en el historial; no se parchea el
  archivo único para que carga;
- si un conteo no coincide, no se anota el número nuevo: se busca el objeto que
  falta o sobra;
- si el sha256 del ensamblado no es el del commiteado, **el archivo commiteado no
  se toca** hasta que la causa esté entendida (3.2);
- si aparece una función `SECURITY DEFINER` sin `search_path` fijo, o aparecen
  más de las que el inventario espera, se vuelve al historial.

La secuencia segura es: serie sobre base descartable → volcado → ensamblado →
sha256 idéntico al commiteado → recién entonces, commit.

---

## 4. Lista estructural para quien autorice `001_orabella_schema.sql`

### 4.1 Las secciones, en orden

El archivo se respeta el **orden del dump**. Reordenar entre secciones que llevan
dependencia rompe la carga sin que el error sea obvio, así que las secciones se
reconocen, no se reescriben. Este es el orden esperado, y el orden real que
emita el `pg_dump` del propietario manda sobre él:

1. **Encabezado.** Qué es, de qué base salió, con qué versión de `pg_dump`, en qué
   fecha, y los conteos exactos del punto 3.3 ya anotados.
2. **`SET` de contexto y transacción.** El preámbulo que emite `pg_dump`
   (`set_config('search_path', '', false)`, `BEGIN`/`COMMIT`). No se quita.
3. **Extensiones** — 2: `pgcrypto` y `btree_gist`.
4. **Tipos y dominios**, si el dump trae alguno.
5. **Tablas** — 36, cada una con su
   `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` en la posición que el dump los
   deje respecto de ella (no se separan del bloque de su tabla). Las **10**
   políticas RLS van donde el dump las deje: no están una por tabla, porque desde
   la 074 y la 077 las políticas por sede desaparecieron.
6. **Secuencias** propias y sus `ALTER SEQUENCE ... OWNED BY`.
7. **Restricciones** — 34 `PRIMARY KEY`, 56 `FOREIGN KEY`, 128 `CHECK`, 13
   `UNIQUE`, 1 `EXCLUDE`, con los cuatro modos de borrado que pide el inventario:
   `ON DELETE CASCADE`, `SET NULL`, `RESTRICT` y el sin cláusula. Son 104
   restricciones de tabla en total: los 128 `CHECK` van en línea dentro del
   `CREATE TABLE`, no como `ALTER TABLE ... ADD CONSTRAINT`.
8. **Índices** — 16 únicos y 49 simples, 65 en total.
9. **Funciones** — 28.
10. **Disparadores** — 21.
11. **Permisos** — los `REVOKE`/`GRANT` del paso 2.4 (43: 21 `REVOKE` y 22
    `GRANT`), y `ALTER DEFAULT PRIVILEGES` si el dump trae alguno.
12. **`COMMENT ON`** — los 139, todos.

Reglas de orden que no se rompen:

- Una `CREATE FUNCTION`, un `CREATE TRIGGER`, un `CREATE POLICY` o un
  `ALTER TABLE ... ADD CONSTRAINT` **jamás** se adelanta a la `CREATE TABLE` del
  objeto del que depende. Si hace falta mover algo, se comprueba en base vacía
  (3.1) antes de seguir.
- Los `COMMENT ON` sí se pueden reubicar: no llevan dependencia.
- **`ALTER TABLE ONLY`** se conserva tal cual. Quitarle el `ONLY` cambia cuándo se
  toman bloqueos en tablas hijas, y además rompe las expresiones regulares de
  `tests/admin.test.ts`, que leen el disco.
- El archivo asume el esquema **vacío**: no lleva `IF NOT EXISTS` sobre las
  tablas ni `DROP`. El reset y `test-bootstrap.sql` arrancan de cero, y por eso
  es correcto.

### 4.2 La función `SECURITY DEFINER`

Exactamente una, y no por gusto:

- `public.current_sede_id()` — la leen las políticas RLS por sede; corre con el
  ejecutor de la política, así que necesita `DEFINER` y `SET search_path = public`
  fijo.

Hubo dos hasta la 077. La segunda era
`public.write_audit_log(uuid, uuid, text, text, text, jsonb)`, que escribía en
`audit_logs` (append-only), y la 077 la borró al quedarse sin llamadores, con sus
permisos. Si al volcar aparece una segunda, la base de la que se volcó tiene una
077 sin aplicar.

Las otras **27** son `INVOKER`, que es el DEFAULT. Por eso el archivo **no
puede** llevar un `SECURITY INVOKER` explícito en ninguna de ellas: `pg_dump`
solo emite `SECURITY DEFINER` cuando la función lo es, así que una línea
`SECURITY INVOKER` en el archivo significa que alguien la escribió a mano. La
comprobación es el `grep` del punto 3.3, y tiene que salir vacío.

### 4.3 La política que se omite, y por qué

`pol_movements_sede_isolation` (`004_inventory.sql:164`) **no** va en el archivo.
Era `FOR ALL ... USING (true) WITH CHECK (true)`, un permiso temporal que
`008_hardening.sql` revocó y reemplazó por dos políticas más estrechas:

- `pol_movements_sede_select` (`008_hardening.sql:206`) — `FOR SELECT`,
  `USING (sede_id = public.current_sede_id())`
- `pol_movements_sede_insert` (`008_hardening.sql:210`) — `FOR INSERT`,
  `WITH CHECK (sede_id = public.current_sede_id())`

El motivo es que la política de `004` está **superada**, no perdida: reintroducirla
dejaría `inventory_movements` con un `USING (true)` abierto, que es exactamente la
clase de defecto que `008_hardening.sql` cerró en 20 tablas. Se omite por esa
razón y por ninguna otra; si al volcar la base aparece, es señal de que PRUEBAS no
tiene el historial completo aplicado, y eso se arregla en la base antes de volver
a volcar.

Verificación:

```bash
grep -n "pol_movements_sede_isolation" supabase/migrations/001_orabella_schema.sql   # nada
grep -n "pol_movements_sede_select\|pol_movements_sede_insert" supabase/migrations/001_orabella_schema.sql   # 1 y 1
```

### 4.4 Los tres marcadores `-- fix-060`, verbatim

`tests/atomic-guards.test.ts` cuenta líneas cuyo `trim()` sea **exactamente**
esto, y espera **3**:

```sql
-- fix-060: esperados ANTES del INSERT
```

Requisitos, todos a la vez:

- texto idéntico, sin tildes y sin cambiar ni una palabra: la línea completa
  después de `trim()` es esa y solo esa;
- comentario de **línea completa**: empieza con `--` al inicio de la línea (con
  la sangría que tenga). Un `--` al final de una línea de código no cuenta, y la
  prueba además borra los comentarios antes de buscar las sentencias;
- exactamente **3** ocurrencias en el archivo. Las citas en prosa que se
  mencionen con acentos graves no interfieren, siempre que no sean la línea
  exacta — y en este archivo no hacen falta: están las tres y solo las tres;
- posición: cada marcador va **inmediatamente antes** de su par
  `SELECT jsonb_array_length(...) INTO v_esperados;` + `INSERT`, dentro de
  `invoice_create_atomic`. Los tres pares, en el orden del cuerpo:

```sql
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.invoice_items ...

  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_taxes) INTO v_esperados;

  INSERT INTO public.invoice_taxes ...

  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_payments) INTO v_esperados;

  INSERT INTO public.invoice_payments ...
```

El orden no es cosmético. En PL/pgSQL `GET DIAGNOSTICS x = ROW_COUNT` mide la
**última sentencia ejecutada**, y un `SELECT ... INTO` también es una sentencia:
si el `SELECT` queda entre el `INSERT` y el `GET DIAGNOSTICS`, la red mide el
`SELECT`, `v_escritos` queda en 1 y la emisión falla con `ITEM_MISMATCH` en cuanto
un grupo trae dos o más elementos. Es el defecto que corrigió la 060, y el squash
no puede perderlo.

Los tres marcadores están en el archivo actual, en las líneas 2533, 2570 y 2604, y
salen del volcado sin tocar nada: un `pg_dump` arrastra los comentarios `--` del
cuerpo de la función como texto, así que viaja con él. Si un volcado viniera sin
ellos, se agregan a mano en esta posición exacta y el `grep` de arriba tiene que
dar 3 igual.

### 4.5 Lo que no se toca en el dump

No se borra ningún objeto que el dump declare, ni se "simplifica" ninguna
declaración. Borrar a mano columnas, predicados RLS o referencias foráneas de un
dump es la clase de error que el squash existe para quitar de en medio (ver punto
6). Si algo sobra, sobra porque el dump se equivoca, y entonces se corrige la
base y se vuelve a volcar.

---

## 5. Pruebas: a dónde leen y por qué

Esta sección describe **lo que se hizo**, no un plan. El plan que se escribió
primero —repuntar las pruebas al archivo único y reescribir sus formas para
tolerar las del volcado— **no se siguió**, y 5.2 explica por qué.

Resumen: los **70 sitios** de prueba que leían `supabase/migrations/<nombre>.sql`
se repuntaron a `supabase/schema-history/<nombre>.sql`, cambiando **solo el nombre
del directorio**, sin tocar una sola aserción. La suite quedó verde con **1958
pruebas** (1952 previas + 6 nuevas, las de 5.3).

### 5.1 Lo que se cambió, exactamente

El squash movió la serie con `git mv` a `app/supabase/schema-history/` (76
archivos, historia de git intacta) y dejó `supabase/migrations/` con un único
archivo. Eso rompe cualquier lectura que hiciese
`readFileSync("supabase/migrations/077_drop_sede_id.sql")`: el `ENOENT` se produce
al **coleccionar** el módulo, y una prueba que no llegó a ejecutarse no informa
nada del defecto que tenía que detectar.

Los 70 sitios, por archivo de `app/tests/`:

| Archivo | Sitios repuntados |
|---|---|
| `admin.test.ts` | 11 |
| `atomic-guards.test.ts` | 1: la constante `MIGRATIONS_DIR`, que el archivo usa en el `readdirSync` y en cada lectura por nombre |
| `auth.test.ts` | 2 |
| `billing.test.ts` | 10 |
| `cash.test.ts` | 12 |
| `commission-mode.test.ts` | 1 |
| `commissions.test.ts` | 3 |
| `inventory.test.ts` | 5 |
| `payroll.test.ts` | 23 |
| `hardening.test.ts` | 2: los helpers que leen la serie |

Además, `hardening.test.ts` ganó el bloque de la guarda nueva (5.3), y
`atomic-guards.test.ts` ganó el párrafo que explica en el encabezado del archivo
por qué lee el historial.

Lo que **no** se tocó: ni una aserción, ni un regex, ni un `describe`, ni nada en
`src/`, ni `app/supabase/test-bootstrap.sql`, ni
`app/supabase/migrations/001_orabella_schema.sql`.

Las derivaciones siguen dando lo mismo porque la serie no cambió de contenido:

- `atomic-guards.test.ts` sigue con `toBeGreaterThan(40)` —lee `schema-history` y
  encuentra 76— y sigue buscando `052_invoice_create_atomic.sql` y
  `060_fix_invoice_create_guards.sql` por su nombre;
- sigue exigiendo **3** marcadores `-- fix-060: esperados ANTES del INSERT`, cada
  uno inmediatamente antes de su `SELECT jsonb_array_length(...) INTO`, con el
  `GET DIAGNOSTICS` después del `INSERT` (punto 4.4);
- `admin.test.ts` sigue derivando columnas reales, nulabilidad, unicidades y
  exclusiones desde los mismos archivos, y el campo `origen` de sus mensajes de
  fallo sigue llevando el nombre de archivo de la serie.

### 5.2 Por qué el historial y no el volcado

**Las pruebas de este repo no hablan con una base de datos.** Reconstruyen el
esquema leyendo el SQL **como texto** y derivando hechos de ese texto: qué
columnas declara una tabla, cuáles son `NOT NULL`, qué unicidades y exclusiones hay
y qué elementos lleva cada una, en qué orden aparecen las redes de conteo respecto
del `INSERT`. No hay `psql`, ni fixture, ni conexión: el artefacto ES la entrada.

El historial no se borró: **se movió**. Los 76 archivos están en
`app/supabase/schema-history/` con sus nombres intactos, así que apuntar allí deja
el inventario derivado **idéntico** y la suite sigue midiendo exactamente lo mismo
que antes del squash. Ese era el requisito, y por eso es la vía que se tomó.

Apuntar al volcado, en cambio, obligaba a reescribir decenas de regex, porque el
volcado escribe formas que la serie nunca usó. Contadas sobre
`001_orabella_schema.sql`:

| En la serie | En el volcado | Dónde duele |
|---|---|---|
| `CREATE OR REPLACE FUNCTION` — en el volcado hay **0** | `CREATE FUNCTION` | todo `toContain("CREATE OR REPLACE FUNCTION ...")` de `auth.test.ts` |
| firma en una línea | firma multilínea, con sangría de 4 espacios | todo `toContain` de firma literal |
| `ON public.t (cols)` | `USING btree` en medio, en los 65 índices | el regex de `CREATE UNIQUE INDEX` de `admin.test.ts` |
| `ALTER TABLE public.t ADD CONSTRAINT` | `ALTER TABLE ONLY`, en 104 líneas | el regex de restricciones, y el `not.toMatch(/^\s*ALTER TABLE/im)` sobre el archivo entero |
| comentarios `--` en el cuerpo | `COMMENT ON` como SENTENCIA, 139 en total | cualquier derivación por contenido: la prosa se cuela como código |

El riesgo real de ese camino no era que las pruebas **fallaran**: es que para
hacerlas pasar hay que **ensuciar lo que miden**. Un
`not.toMatch(/^\s*ALTER TABLE/im)` sobre el archivo entero es cierto sobre `054`
—una migración que no toca el esquema— y falso sobre el volcado, que trae 104
`ALTER TABLE ONLY` legítimos; pasarlo exige acotar la aserción a una región que hoy
no está acotada, y una región mal acotada es una pérdida silenciosa de cobertura.
Ese tipo de reescritura se hace de a una, se revisa de a una, y no hay forma
automática de demostrar que la prueba siguiente mide lo mismo que la anterior.

Repuntar el directorio tiene en cambio una propiedad que vale más que todas las
demás: **si una aserción se rompió al cambiar la ruta, se ve en el diff**. El diff
es una línea, la línea es el directorio, y no hay nada que interpretar.

### 5.3 La guarda nueva del archivo único

Repuntar todo al historial deja al archivo único **sin nadie que lo vigile**: ya no
hay un guardián que lo lea. El bloque `describe("el squash: ...")` de
`app/tests/hardening.test.ts` es esa vigilancia, y son **6 pruebas nuevas** —las 6
que suman las 1958—:

1. **`001_orabella_schema.sql` es el único archivo de `migrations/` que cumple
   `/^0\d\d_.*\.sql$/`.** El `readdirSync` del directorio vivo se filtra con el
   patrón de nombre de la serie y tiene que dar `[SQUASH_NAME]`, nada más.
   > **AGREGAR UNA MIGRACIÓN NUEVA OBLIGA A ACTUALIZAR ESTA PRUEBA.** Si un día
   > aparece un `002_lo_que_sea.sql`, la cuenta da 2 y la prueba **cae**, y que
   > caiga es lo que se quiere: la serie ya no es un archivo y hay que decidir a
   > mano qué se hace —volver a compactar en el archivo único, o dejar de leer el
   > historial— en vez de dejar que un segundo archivo se cuele en silencio. El
   > número es una decisión, no un número que se actualiza solo.
2. **36 `CREATE TABLE public.` y 10 `CREATE POLICY`.** Los conteos son de
   *declaraciones* sobre el SQL sin comentarios ni `COMMENT ON` (5.3 explica por
   qué ese segundo filtro es necesario), y salen del archivo, no de una lista
   escrita a mano.
3. **`sede_id` es columna sólo de `public.users`.** La derivación es por
   contenido —cada `CREATE TABLE` y sus líneas—, así que la lista es la que el
   archivo declara. Una tabla con la columna de vuelta aparece sola en el fallo.
4. **`payroll_apply_atomic` se declara una sola vez, y con los cuatro argumentos de
   la serie**, en orden, el cuarto con su `DEFAULT`. Se cuentan las
   *declaraciones* (`CREATE FUNCTION`), no las menciones: el `COMMENT ON`, el
   `REVOKE` y el `GRANT` nombran la función sin declararla.
5. **`next_invoice_number` se declara sin argumentos** y devuelve `integer`, con la
   lista de argumentos vacía y no por coincidencia de texto.
6. **No queda ninguna referencia a `employees.sede_id` fuera de comentarios.** La
   columna no existe desde la 077; cualquier `employees.sede_id` que sobreviva en
   SQL ejecutable es código roto contra el catálogo. La prueba incluye su
   **control**: el texto sí aparece en el archivo, dos veces, y las dos en prosa
   —una línea `--` y un `COMMENT ON`—, y el conteo se exige. Sin ese control la
   aserción podría estar en verde porque el objeto se renombró, o porque el filtro
   borró el archivo entero.

El filtro que comparten las seis es `squashSchemaSql()`: `stripSqlComments` —que
respeta los cuerpos dollar-quoted, sin él un `CREATE TABLE` en prosa dentro de una
función contaría como tabla— más el borrado de las líneas `^COMMENT ON ...$`. El
anclaje a la línea completa no es cosmético: en un volcado de `pg_dump` la
documentación viaja como sentencias de una línea que terminan en `';`, y 60 de esas
139 prosa llevan un `;` **adentro** del texto, así que un barrido hasta el primer
`;` las cortaría por la mitad y dejaría prosa suelta en medio del SQL.

### 5.4 La brecha residual, sin maquillarla

**Las pruebas que leen `schema-history/` NO detectan una edición manual de
`001_orabella_schema.sql`.** Si alguien edita el volcado a mano —borra una
política, deja una columna o rompe una firma—, el historial no se entera y las
1952 pruebas de la serie siguen en verde. Eso no es un defecto que se pueda
arreglar repuntando: es la consecuencia directa de haber elegido el historial, y
es el precio de esa elección.

Lo que sí lo detecta, y solo eso:

- **la guarda de invariantes de 5.3**, que mira el archivo único y afirma sus
  conteos y sus formas concretas: 36 tablas, 10 políticas, `sede_id` sólo en
  `users`, una sola declaración de `payroll_apply_atomic` con sus cuatro
  argumentos, `next_invoice_number()` sin argumentos, ninguna referencia ejecutable
  a `employees.sede_id`; y
- **el procedimiento de construcción con su comparación byte a byte**: correr
  `python app/supabase/squash/build-schema.py` (sección 2) vuelve a construir el
  archivo desde la fuente y compara su sha256 con el del archivo commiteado
  (3.2). Un archivo editado a mano no sobrevive a esa comparación, porque el
  procedimiento lo vuelve a construir desde la serie.

Consecuencia práctica, escrita para que nadie la descubra tarde: el archivo único
**no está cubierto por la suite**. La suite cubre la serie y vigila un puñado de
invariantes del archivo; el resto del archivo está cubierto por el procedimiento
de construcción, que corre aparte. Un cambio al `001_orabella_schema.sql` no se
verifica con `npm test`: se verifica con el script, y su veredicto es
`IDENTICO` o no es nada.

### 5.5 La trampa de los helpers que devuelven texto vacío

Hay helpers de prueba que leen con `existsSync` y **devuelven `""` si el archivo no
existe**: `deployedPayrollCapBody()` y `deployedNextInvoiceNumberBody()` en
`app/tests/payroll.test.ts`, y varios bloques con la forma literal
`existsSync(path) ? readFileSync(path, "utf8") : ""` —la 036, la 037 y la 071 en ese
mismo archivo.

Es **deliberado**, y el motivo está escrito en el código: en RED el archivo todavía
no existe, y el fallo tiene que ser **la aserción** de cada prueba, no un error de
colección que oculte los otros huecos del bloque.

Hoy eso es seguro por dos razones, y las dos importan:

1. Cada uno de esos bloques tiene al menos una aserción **positiva** (`toContain`)
   que falla con texto vacío. El piso anti-vacío está, y es lo que convierte la
   lectura tolerante en una lectura segura.
2. Los 76 archivos **sí existen** en `schema-history/`, así que la lectura
   tolerante hoy lee el archivo de verdad.

**La trampa, para quien mueva esos tests:** un `not.toMatch` —o cualquier
`not.*`— evaluado sobre texto vacío **siempre pasa**. Si esos bloques se repuntan a
un directorio donde el archivo no exista, las aserciones **negativas** se vuelven
pases vacíos: pruebas que no pueden fallar, en verde, sin que nada lo advierta. El
síntoma es una suite que pasa por el motivo equivocado, que es peor que una que
falla.

Regla para quien repunte una lectura tolerante:

- si el bloque tiene una aserción positiva, el repunte es seguro y el piso sigue
  haciendo su trabajo;
- si el bloque **sólo** tiene aserciones negativas, hay que garantizarla. O se
  añade el piso —`expect(sql.length).toBeGreaterThan(N)`, o un `toContain` de una
  sentencia que el archivo tiene que traer—, o se vuelve a `readFileSync` directo y
  se acepta que un archivo ausente se muestre como `ENOENT` en la colección: un
  error de colección visible es infinitamente preferible a un `not.toMatch` que
  pasa siempre.

---

## 6. La caída de `sede_id` y el estado que declara el archivo único

**La instalación de una sola sede ya ocurrió, y el archivo único la refleja.** No
hay un `002_*.sql` pendiente, y no se va a escribir uno.

La secuencia real fue esta:

- `074_sede_less_constraints.sql` sacó `sede_id` de las unicidades y de la
  exclusión: en una instalación de una sola sede, `sede_id` como elemento de
  unicidad es redundante.
- `077_drop_sede_id.sql` borró la columna de todas las tablas menos `public.users`,
  que la conserva como el anclaje de la cuenta a la instalación. Retiró también
  `public.write_audit_log(...)`, el helper `SECURITY DEFINER` sin llamadores que
  quedaba desde la 008 —y con él el número de funciones `DEFINER` bajó de 2 a 1,
  que es lo que el punto 3.3 ya refleja.
- El archivo único se construyó **después**, sobre una base con la serie 001-077
  aplicada. Por eso declara el estado POST-077 sin que nadie editara el volcado a
  mano: `sede_id` es columna sólo de `public.users`, y las 10 políticas que quedan
  son las que no dependían de la sede.

Es exactamente lo que el orden defendía, resuelto por la vía corta: el historial es
el que dice **por qué**, y el volcado el que dice **qué queda**. La diferencia
entre el antes y el después está en archivos que se leen enteros —`074` y `077`—,
y el archivo único no tiene que mentir sobre el estado intermedio porque nunca lo
codificó.

Y esa es también la razón por la que no se edita el volcado a mano (punto 4.5):
quitar `sede_id` de un `pg_dump` con las manos es justo la clase de error que el
squash existe para quitar de en medio, y la serie 001-077 ya lo hizo con sentencias
que se leen y se revisan una por una.

Dos consecuencias sobre el punto 5, porque son las que el plan descartado daba por
hechas:

- **No hay corte `n < "002_"` que ajustar.** El barrido de `admin.test.ts` sigue con
  el corte que tenía y lee `schema-history/`.
- **No hay `toBeGreaterThan(40)` que pasar a `1`.** `atomic-guards.test.ts` sigue
  leyendo el historial y sigue contando los 76 archivos. La cuenta de "en
  `migrations/` hay un solo archivo" la lleva la prueba 1 de 5.3, que es donde
  tiene que estar: es una afirmación sobre el directorio **vivo**, no sobre el
  historial.

---

## 7. Equivalentes en PowerShell

**Esta sección es un apéndice, no el procedimiento.** El procedimiento vigente es
el de la sección 2: un comando, `python app/supabase/squash/build-schema.py`, que
además se ejecuta igual desde PowerShell porque es Python. Lo que sigue se
conserva porque tiene valor real —traducir los comandos a `PS D:\u\orabella\app>`,
y dejar escrito cómo se hacía a mano el variante con banderas y base local— pero
**no compite con el script**: es el procedimiento anterior, el que se descartó
porque volcaba desde PRUEBAS (ver 3.1). Si algo de aquí contradice a la sección
2, manda la sección 2.

Los bloques de las secciones 2 y 3 están escritos en **bash**. Esta sección es la
traducción de cada comando a **PowerShell** (Windows), para ejecutar el mismo
procedimiento desde `PS D:\u\orabella\app>` sin cambiar el orden ni las
comprobaciones.

**Lo que no cambia entre los dos shells.** Solo cambia la forma de escribir el
comando, nunca lo que hay que hacer:

- el **orden**: los pasos del script, en el orden en que él los ejecuta (2.4);
- la **regla de pre-vuelo**: las verificaciones de la sección 3 se ejecutan
  **antes** de tocar la base; si una falla, no se resetea, se vuelve al script;
- los **números esperados**, que son los del encabezado de
  `001_orabella_schema.sql` y no se reinterpretan: 36 tablas, 10 políticas, 28
  funciones, 2 extensiones, 34 PK, 56 FK, 128 CHECK, 13 `UNIQUE`, 16 índices
  únicos, 49 simples, 1 exclusión, 21 triggers, 36 tablas con RLS, 43
  `REVOKE`/`GRANT`, 139 `COMMENT ON`, y exactamente **1** función
  `SECURITY DEFINER` con `search_path` fijo (era 2 antes de la 077);
- la **regla del reset**: un reset solo es sin pérdida si el diff de esquema
  sale **VACÍO**. Con diferencias, no se resetea.

Las diferencias que sí son propias de PowerShell y conviene no confundir con
cambios de procedimiento están señaladas en cada bloque: el carácter de
continuación de línea es el acento grave (`` ` ``) y no la barra invertida, el
here-document se resuelve con una cadena multilínea, y la redirección `>` escribe
UTF-16, por lo que ningún `.sql` se genera con `>` ni con `Out-File`.

### 7.0 Requisitos: el cliente en PATH

`pg_dump`, `psql` y `createdb` tienen que estar en el PATH de la sesión, igual que
en bash. En Windows vienen del instalador de PostgreSQL 18. Si la instalación es
la estándar, la carpeta es `C:\Program Files\PostgreSQL\18\bin`:

```powershell
Get-Command pg_dump, psql, createdb -ErrorAction SilentlyContinue |
  Select-Object Name, Source
```

Si la lista sale vacía, se agrega la carpeta **solo a esta sesión** (no modifica
el PATH del sistema, y no requiere instalar nada):

```powershell
$env:Path = "$env:Path;C:\Program Files\PostgreSQL\18\bin"
Get-Command pg_dump, psql, createdb
pg_dump --version
```

Ese `pg_dump --version` es el que hay que anotar: los dos `pg_dump` del 3.1 tienen
que salir del **mismo cliente** en ambos shell, porque versiones distintas cambian
las cabeceras de sección y marcan diferencias que no son de esquema.

Nota de codificación, aplicada a todos los bloques de esta sección: los archivos
del proyecto y la salida de `pg_dump` son UTF-8, y `Get-Content` sin
`-Encoding` los lee con la página de códigos del sistema y los convierte en
basura. Por eso los `Get-Content` de aquí llevan `-Encoding utf8`, y los archivos
SQL que se generan se escriben con `[System.IO.File]::WriteAllText` y un
`UTF8Encoding($false)` explícito, que es el equivalente de `>` en bash.

### 7.1 Preparación: carpeta de trabajo

Equivalente de 2.1. `$Work` es una variable de sesión: si se cierra la terminal,
se pierde, y eso es lo correcto.

```powershell
Set-Location D:\u\orabella\app
New-Item -ItemType Directory -Force -Path 'supabase/squash/_verif' | Out-Null
$Work = 'supabase/squash/_verif'
```

`New-Item -Force` sobre un directorio que ya existe no falla y no borra su
contenido, que es el equivalente de `mkdir -p`. `_verif/` sigue siendo
desechable y **no** se agrega al índice.

### 7.2 La credencial y la regla de seguridad

Equivalente de 2.2, con la postura de seguridad explícita porque es la parte que
más caro sale si se copia mal.

**La regla, para los dos shells:** la clave de la base **no** se escribe en este
documento, ni en un archivo del repositorio, ni en una transcripción (chat, ticket,
captura, correo), ni como texto plano en un comando. Tampoco se pone en una URI
de conexión ni en `--dbname` con la clave embebida: eso la deja visible en la
lista de procesos para cualquier usuario de la máquina.

Las dos vías del 2.2 funcionan igual en PowerShell:

- **Vía A — `pgpass.conf`, recomendada.** La clave nunca pasa por la línea de
  comandos, ni por el historial, ni por el entorno. Es el mismo archivo que en
  bash; en Windows la ruta es `%APPDATA%\postgresql\pgpass.conf`. Se puede abrir
  con el Bloc de notas **fuera del repositorio** y escribir una línea con el
  formato `host:port:base:usuario:clave`. Si además hay una base local para el
  paso 3.1, conviene añadir su línea en el mismo archivo
  (`localhost:5432:squash_check:postgres:CLAVE_LOCAL`), para que los comandos
  locales no dependan del entorno.

  En Windows el permiso no se pone con `chmod`: libpq en Windows no interpreta los
  bits POSIX, así que el archivo debe quedar accesible solo a la cuenta de la
  sesión. Se quita la herencia del objeto y se concede lectura solo al usuario
  actual:

  ```powershell
  New-Item -ItemType Directory -Force -Path "$env:APPDATA\postgresql" | Out-Null
  notepad "$env:APPDATA\postgresql\pgpass.conf"

  # Tras escribir la línea: solo la cuenta actual puede leerla.
  icacls "$env:APPDATA\postgresql\pgpass.conf" /inheritance:r /grant:r "$($env:USERNAME):(R)"
  icacls "$env:APPDATA\postgresql\pgpass.conf"
  ```

  Con la vía A no hay que leer la clave en la sesión, y no hay nada que olvidar
  antes de los pasos con base local. Es la que evita toda la superficie de error
  del punto siguiente.

- **Vía B — entorno, solo si no se puede escribir `pgpass.conf`.** La forma de
  bash es `read -rs`; en PowerShell es `Read-Host -AsSecureString`, que devuelve
  la clave sin dibujarla en pantalla:

  ```powershell
  $segura = Read-Host 'Clave de la base PRUEBAS (no se escribe en pantalla)' -AsSecureString
  $env:PGPASSWORD = [System.Net.NetworkCredential]::new('', $segura).Password
  Remove-Variable segura
  ```

  Esa es la forma que se ejecuta. La que **no** se ejecuta nunca es
  `$env:PGPASSWORD = 'CLAVE'` escrita a mano: es exactamente el error que hay que
  evitar, porque un comando tecleado queda en el historial de la sesión. La clave
  entra por el prompt, que no se registra en ese historial.

  La conversión de `SecureString` a texto usa
  `[System.Net.NetworkCredential]::new('', $segura).Password` porque es la llamada
  más corta que hace exactamente eso. Las otras dos se descartan a propósito:
  `[System.Runtime.InteropServices.Marshal]::PtrToStringBSTR` daría el mismo texto
  pero obliga además a liberar el BSTR a mano, sin ventaja ninguna; y
  `ConvertTo-SecureString` / `ConvertFrom-SecureString` son para **guardar** la
  clave cifrada en disco, que es justamente lo que este manual no hace. La
  protección real aquí es que la pulsación no se ve en pantalla y no entra en el
  historial; que el destino —`$env:PGPASSWORD`— sea texto plano es inevitable,
  porque es donde `libpq` la lee.

  Antes de cualquier paso con base local (3.1 en adelante) hay que quitarla del
  entorno, igual que en el 2.2. En PowerShell la forma más simple es desvincular
  la variable, en vez de dejarla vacía:

  ```powershell
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  ```

  Ponerla a `''` la deja definida y vacía, y de eso depende el comportamiento
  del cliente ante una cadena vacía; desvincularla no deja duda. Y si el servidor
  local llega a pedir contraseña, esa es la clave local, no la de PRUEBAS: entra
  por su línea en `pgpass.conf` o por un prompt propio.

Parámetros de conexión (mismos valores que en el 2.2, sin la clave dentro):

```powershell
$PRUEBAS_HOST = 'db.xxxxxxxxxxxx.supabase.co'
$PRUEBAS_PORT = '5432'
$PRUEBAS_DB   = 'postgres'
$PRUEBAS_USER = 'postgres'
$env:PGSSLMODE = 'require'
```

Los valores se pasan a `pg_dump` y `psql` **expandidos**, tal como están en los
bloques de esta sección: `--host=$PRUEBAS_HOST`, sin comillas alrededor del `=`
— `--host="$PRUEBAS_HOST"` no es otra cosa que la cadena literal
`$PRUEBAS_HOST`, y la conexión falla.

Siguen valiendo las dos advertencias del 2.2: la clave es la de la **base de
datos** (Dashboard → Settings → Database → Connection string → DB password), no
la `service_role` ni la `anon`; y la conexión es la directa o el pooler de
**sesión** (puerto `5432`), nunca el `6543` de transacción.

### 7.3 Volcado del esquema desde PRUEBAS

Procedimiento **anterior**, conservado como referencia: volcar de la base de
servicio en vez de de una base descartable. El vigente es el paso 6 del script
(2.4), que vuelca `orabella_build` y **sin** `--no-privileges`. Este bloque es el
`pg_dump` estructural **con** `--no-privileges`.

```powershell
pg_dump `
  --host=$PRUEBAS_HOST --port=$PRUEBAS_PORT `
  --username=$PRUEBAS_USER --dbname=$PRUEBAS_DB `
  --schema-only `
  --no-owner `
  --no-privileges `
  --file="$Work/pruebas.dump.sql"
```

El acento grave al final de la línea es la continuación; la barra invertida de
bash no sirve. Las banderas son las mismas, en el mismo orden y con el mismo
significado, así que las notas de 2.3 aplican sin cambios: `--no-privileges`
deja fuera los `GRANT`/`REVOKE` (por eso está el 7.4), `--no-owner` quita el
`ALTER ... OWNER TO`, y **no** se añade `--no-comments`.

`--file=` sigue siendo obligatorio en vez de `>`: la redirección de PowerShell
escribe el archivo en UTF-16 y el SQL resultante no se puede aplicar. Es la misma
razón que en bash, y el `pg_dump --file` la evita.

Comprobación inmediata, equivalente a los tres comandos de 2.3:

```powershell
pg_dump --version

# Equivalente de: grep -n "CREATE EXTENSION" "$WORK/pruebas.dump.sql"
Select-String -LiteralPath "$Work/pruebas.dump.sql" -Pattern 'CREATE EXTENSION'

# Equivalente de: grep -c "^CREATE TABLE public\." "$WORK/pruebas.dump.sql"
# esperado: 36
(Select-String -LiteralPath "$Work/pruebas.dump.sql" -Pattern '^CREATE TABLE public\.').Count
```

`Select-String` devuelve un objeto por línea y `.Count` da el recuento, así que
sustituye a `grep -c` sin cambiar el número esperado.

### 7.4 Segunda pasada: los permisos

Procedimiento **anterior**, conservado como referencia: la segunda pasada con la
que se transcribían los permisos a mano. El vigente es el paso 6 del script
(2.4), que hace **un solo** volcado **sin** `--no-privileges`. La diferencia con
7.3 es exactamente una bandera, y es la que recupera los `REVOKE`/`GRANT`.

```powershell
pg_dump `
  --host=$PRUEBAS_HOST --port=$PRUEBAS_PORT `
  --username=$PRUEBAS_USER --dbname=$PRUEBAS_DB `
  --schema-only `
  --no-owner `
  --file="$Work/pruebas.acl.sql"

# Equivalente de: grep -cE "^(REVOKE|GRANT) " "$WORK/pruebas.acl.sql"
# el archivo único se queda con 43 de ellos
(Select-String -LiteralPath "$Work/pruebas.acl.sql" -Pattern '^(REVOKE|GRANT) ').Count
```

`-Pattern` es una expresión regular, así que `^(REVOKE|GRANT) ` no necesita
`-E`. Y las dos reglas de transcripción del 2.4 siguen igual: se copian solo los
permisos que el historial declara a mano sobre `anon`, `authenticated`, `PUBLIC` y
`service_role`; los permisos por defecto de la plataforma no entran, y una cuenta
muy por encima de 43 los delata.

### 7.5 Regenerar `app/supabase/test-bootstrap.sql`

Equivalente de 2.5. El bloque de concatenación de bash usa `mktemp`, `{}` y `&&`;
en PowerShell se arma el contenido en una variable y se escribe con UTF-8 **sin
BOM**, que es el equivalente de `cat` + `>`:

```powershell
Set-Location D:\u\orabella\app

$Squash = 'supabase/migrations/001_orabella_schema.sql'
$Seed   = 'supabase/seeds/acceptance.sql'
$Destino = 'supabase/test-bootstrap.sql'
$Temporal = 'supabase/test-bootstrap.sql.tmp'

$contenido = @(
  '-- test-bootstrap.sql — generado, no editado a mano.'
  '-- Orden: 001_orabella_schema.sql y luego seeds/acceptance.sql.'
  '-- Regenerar con el paso 2.5 de supabase/squash/README.md.'
  ''
  (Get-Content -LiteralPath $Squash -Raw -Encoding utf8)
  ''
  '-- ================= seeds/acceptance.sql ================='
  (Get-Content -LiteralPath $Seed -Raw -Encoding utf8)
) -join "`n"

[System.IO.File]::WriteAllText($Temporal, $contenido, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $Temporal -Destination $Destino -Force
```

Se escribe primero a un temporal y luego se mueve sobre el destino, igual que el
`> "$TMP" && mv "$TMP"` del 2.5: así el destino nunca queda a medio escribir si
algo falla. `UTF8Encoding($false)` es lo que evita el BOM, y el BOM es lo que
`Set-Content`/`Out-File` meterían sin pedirlo. El separador `"`n"` deja el archivo
en LF, igual que en bash; si se prefiere CRLF en Windows, es `"`r`n"` y no cambia
la semántica del SQL.

Y las tres comprobaciones del 2.5:

```powershell
# esperado: 36
(Select-String -LiteralPath $Destino -Pattern '^CREATE TABLE public\.').Count
# esperado: 10
(Select-String -LiteralPath $Destino -Pattern '^CREATE POLICY ').Count
Select-String -LiteralPath $Destino -Pattern 'seeds/acceptance.sql'
```

Si `001_orabella_schema.sql` todavía no existe, esto se ejecuta **después** de
redactar ese archivo, igual que en el 2.5.

### 7.6 `app/supabase/seeds/acceptance.sql` no se toca

El comando del 2.6 ya es portable tal cual, porque `git` no es una construcción de
shell:

```powershell
git -C D:/u/orabella diff --stat -- app/supabase/seeds/acceptance.sql
```

La salida tiene que estar **vacía**, igual que en bash.

### 7.7 Diff de esquema: la base actual contra el dump

Equivalente de 3.1. Las dos comprobaciones, con las mismas banderas por los dos
lados, y la misma regla: el reset solo es sin pérdida si el diff sale vacío.

```powershell
Set-Location D:\u\orabella\app
$Work = 'supabase/squash/_verif'

# (a) el lado que se va a reemplazar: la base PRUEBAS viva, mismas banderas
#     que en el 7.3
pg_dump --host=$PRUEBAS_HOST --port=$PRUEBAS_PORT `
  --username=$PRUEBAS_USER --dbname=$PRUEBAS_DB `
  --schema-only --no-owner --no-privileges `
  --file="$Work/vivo.sql"

# (b) el lado reconstruido: el dump aplicado sobre una base VACÍA.
#     En PostgreSQL local basta una base nueva; no se toca PRUEBAS.
#     La clave de PRUEBAS sale del entorno: no se manda al servidor local.
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
createdb -h localhost -U postgres squash_check
psql -h localhost -U postgres -d squash_check -v ON_ERROR_STOP=1 `
  -f "$Work/pruebas.dump.sql"
pg_dump -h localhost -U postgres -d squash_check `
  --schema-only --no-owner --no-privileges `
  --file="$Work/reconstruida.sql"
```

El `Remove-Item Env:\PGPASSWORD` va **antes** de los tres comandos locales, y es
el equivalente del `PGPASSWORD=` vacío del 2.3/3.1: desvincular la variable es
más fuerte que dejarla vacía y no depende de cómo el cliente interprete una cadena
vacía. El `-ErrorAction SilentlyContinue` está porque, si se optó por la vía A,
la variable nunca existió y sin ese parámetro PowerShell lanzaría un error. `-v
ON_ERROR_STOP=1` en `psql` sigue siendo obligatorio, por la misma razón: sin él,
un error a media carga se pierde en el scroll y la base queda a medio esquema, que
es un diff que miente.

Normalización antes de comparar, equivalente de la función `norm()` del 3.1:

```powershell
function norm([string]$ruta) {
  Get-Content -LiteralPath $ruta -Encoding utf8 |
    Where-Object { $_ -notmatch '^-- Dumped from database version' } |
    Where-Object { $_ -notmatch '^-- Dumped by pg_dump version' } |
    Where-Object { $_ -notmatch '^-- Started on ' } |
    Where-Object { $_ -notmatch '^-- Completed on ' } |
    ForEach-Object { $_ -replace '\s+$', '' } |
    Where-Object { $_ -ne '' }
}

[System.IO.File]::WriteAllLines("$Work/a.norm", @(norm "$Work/vivo.sql"), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllLines("$Work/b.norm", @(norm "$Work/reconstruida.sql"), [System.Text.UTF8Encoding]::new($false))
```

El `@(...)` es solo para forzar un arreglo aunque la normalización devuelva una
sola línea. Se escribe en UTF-8 sin BOM porque son archivos de comparación, no
SQL que se vaya a aplicar.

Comparación, equivalente del bloque `diff -u` + la comprobación de tamaño del 3.1:

```powershell
$diff = Compare-Object (Get-Content "$Work/a.norm") (Get-Content "$Work/b.norm") -SyncWindow 5000

if ($diff) {
  Write-Host "BLOQUEADO: el diff no está vacío ($($diff.Count) líneas)"
  $diff | Select-Object -First 60 | Format-Table -AutoSize
} else {
  Write-Host 'OK: diff vacío, el dump describe la base completa'
}
```

`Compare-Object` con `-SyncWindow` cubre el mismo caso que `diff -u`: si el diff
solo reordena sentencias —los OID cambian al restaurar y `pg_dump` ordena parte
de los objetos por OID— el emparejamiento por ventana lo absorbe y la
comparación sale vacía. Cualquier línea que mencione un nombre de objeto, un tipo
o una columna es una diferencia real, no ruido de orden.

`Format-Table` solo es para que las 60 líneas premières se lean; `Select-Object
-First 60` es el tope de lectura, igual que el `head -60` del 3.1.

Cuando el diff no está vacío pero solo reordena, la comparación por multiconjunto
—el `sort` de cada lado que el 3.1 muestra como ruido de orden— tiene aquí forma
directa, porque `Compare-Object` no necesita sustitución de proceso:

```powershell
$a = Get-Content "$Work/a.norm" | Sort-Object
$b = Get-Content "$Work/b.norm" | Sort-Object

$desorden = Compare-Object $a $b
if ($desorden) {
  Write-Host "REVISAR: $($desorden.Count) diferencias que no son de orden"
  $desorden | Select-Object -First 40
} else {
  Write-Host 'OK: mismas sentencias, distinto orden'
}
```

### 7.8 Conteos por tipo

Equivalente de 3.2. El here-document `cat > "$WORK/conteos.sql" <<'SQL'` se
resuelve con una cadena multilínea de PowerShell: `@'` … `'@` es literal, así
que el SQL se copia **exactamente** como está, sin que PowerShell toque nada
dentro. Los números esperados son los mismos del 3.2 y no se reinterpretan.

```powershell
$Sql = @'
SELECT tipo, esperado, encontrado,
       CASE WHEN encontrado = esperado THEN 'OK' ELSE 'MISMATCH' END AS veredicto
FROM (
  SELECT 'extensiones'::text AS tipo, 2 AS esperado, count(*) AS encontrado
    FROM pg_extension WHERE extname IN ('pgcrypto','btree_gist')
  UNION ALL
  SELECT 'tablas', 36, count(*)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  UNION ALL
  SELECT 'funciones', 28, count(*)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'pk', 34, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'p'
  UNION ALL
  SELECT 'fk', 56, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f'
  UNION ALL
  SELECT 'check', 128, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'
  UNION ALL
  SELECT 'unique_constraint', 13, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'u'
  UNION ALL
  SELECT 'unique_index', 16, count(*)
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND i.indisunique
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
  UNION ALL
  SELECT 'plain_index', 49, count(*)
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
  UNION ALL
  SELECT 'exclusion', 1, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'x'
  UNION ALL
  SELECT 'triggers', 21, count(*)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'rls_enabled', 36, count(*)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  UNION ALL
  SELECT 'policies', 10, count(*) FROM pg_policies WHERE schemaname = 'public'
) t ORDER BY tipo;
'@

$Work = 'supabase/squash/_verif'
[System.IO.File]::WriteAllText("$Work/conteos.sql", $Sql, [System.Text.UTF8Encoding]::new($false))
```

El `WriteAllText` con `UTF8Encoding($false)` sustituye al `cat >` y es necesario:
`Set-Content -Encoding utf8` en Windows PowerShell 5.1 añade BOM, y `psql` no
debe encontrarse un BOM al empezar el archivo.

Primera lectura, contra PRUEBAS (misma forma que en el 3.2, con `-f` en vez del
redirección):

```powershell
psql -v ON_ERROR_STOP=1 -f "$Work/conteos.sql" `
  -h $PRUEBAS_HOST -p $PRUEBAS_PORT -U $PRUEBAS_USER -d $PRUEBAS_DB
```

Después la comparación. Los dos `psql` de abajo se ejecutan **por separado** a
propósito: el primero va contra PRUEBAS, el segundo contra la base local, y entre
uno y otro sale del entorno la clave de PRUEBAS. Es el orden que evita mandarle
esa clave al servidor local.

```powershell
# (1) salida de PRUEBAS, sin encabezados: una línea por tipo, terminada en |OK o |MISMATCH
psql -v ON_ERROR_STOP=1 -q -t -A -F '|' -f "$Work/conteos.sql" `
  -h $PRUEBAS_HOST -p $PRUEBAS_PORT -U $PRUEBAS_USER -d $PRUEBAS_DB |
  Set-Content -LiteralPath "$Work/conteos.pruebas.txt" -Encoding utf8

# (2) desde aquí, base local: la clave de PRUEBAS sale del entorno
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

psql -v ON_ERROR_STOP=1 -q -t -A -F '|' -f "$Work/conteos.sql" `
  -h localhost -U postgres -d squash_check |
  Set-Content -LiteralPath "$Work/conteos.check.txt" -Encoding utf8
```

Si se está por la **vía B** de credenciales, ese `Remove-Item` es el que impide
que `libpq` mande la clave de PRUEBAS al servidor local, igual que el `PGPASSWORD=`
vacío del bash. Con la **vía A** no hay nada en el entorno que quitar, y por eso
lleva `-ErrorAction SilentlyContinue`: sin él, `Remove-Item` sobre una variable
inexistente lanza un error que no es un problema.

El `Set-Content` de estos dos `.txt` es aceptable aunque no escriba sin BOM: son
archivos de **comparación**, no SQL que se aplique, y un BOM igual en los dos
lados no altera el resultado del diff. Si aun así se quiere el archivo idéntico
al de bash, `Set-Content -Encoding ascii` también sirve, porque esta salida es
ASCII.

Comparación de las dos columnas, y las dos preguntas cerradas sobre el veredicto:

```powershell
# Equivalente de: diff -u conteos.pruebas.txt conteos.check.txt
# Debe imprimir NADA: las dos bases tienen que coincidir entre sí.
Compare-Object `
  (Get-Content "$Work/conteos.pruebas.txt") `
  (Get-Content "$Work/conteos.check.txt") `
  -SyncWindow 200

# Equivalente de: grep -v "|OK$" conteos.pruebas.txt
# Debe imprimir NADA: cualquier línea que no termine en |OK es una discrepancia.
Select-String -LiteralPath "$Work/conteos.pruebas.txt" -Pattern '\|OK$' -CaseSensitive -NotMatch
Select-String -LiteralPath "$Work/conteos.check.txt"    -Pattern '\|OK$' -CaseSensitive -NotMatch
```

El `Compare-Object` con `-SyncWindow` cubre el mismo caso que el `diff -u` del
3.1, porque la consulta trae `ORDER BY tipo` y las dos salidas salen ordenadas
igual: la comparación es línea a línea directa y cualquier diferencia es real.

Los `REVOKE`/`GRANT` y los `COMMENT ON` no son objetos del catálogo, así que su
conteo es sobre el archivo, igual que en el 3.2:

```powershell
$Final = 'supabase/migrations/001_orabella_schema.sql'
(Select-String -LiteralPath $Final -Pattern '^(REVOKE|GRANT) ').Count   # 43
(Select-String -LiteralPath $Final -Pattern '^COMMENT ON ').Count      # 139
```

### 7.9 Firma, seguridad y `search_path` de las 28 funciones

Equivalente de 3.3. El `-c "…"` del bash con comillas dobles se reemplaza por una
cadena multilínea literal, porque el SQL contiene comillas simples y comas, y en
PowerShell el entrecomillado de un argumento nativo es propenso a errores. La
cadena se pasa como variable y el resultado se escribe con `Set-Content` en vez de
`>`, por el UTF-16.

```powershell
$Work = 'supabase/squash/_verif'

$Query = @'
SELECT p.proname AS nombre,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER (por defecto)' END AS seguridad,
       coalesce(array_to_string(p.proconfig, ', '), '(sin SET)') AS opciones,
       p.prorettype::regtype::text AS retorna
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
 ORDER BY p.proname, argumentos;
'@

psql -v ON_ERROR_STOP=1 -x `
  -h $PRUEBAS_HOST -p $PRUEBAS_PORT -U $PRUEBAS_USER -d $PRUEBAS_DB `
  -c $Query |
  Set-Content -LiteralPath "$Work/funciones.txt" -Encoding utf8
```

Y las dos preguntas cerradas sobre seguridad, contra la base reconstruida. Aquí
la clave de PRUEBAS también sale del entorno antes de tocar el servidor local, y
las dos consultas van sobre `squash_check`:

```powershell
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

$Definers = @'
SELECT count(*) AS definers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef;
'@

psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d squash_check -c $Definers
# esperado: 1

$Detalle = @'
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos,
       array_to_string(p.proconfig, ', ') AS opciones
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
 ORDER BY 1;
'@

psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d squash_check -c $Detalle
# esperado, exactamente esta y nada más:
#   current_sede_id  ()   SET search_path = public
```

Los dos `grep` finales sobre el archivo, equivalentes a los del 3.3:

```powershell
$Final = 'supabase/migrations/001_orabella_schema.sql'
# debe imprimir nada
Select-String -LiteralPath $Final -Pattern 'SECURITY INVOKER'
# debe imprimir 1
(Select-String -LiteralPath $Final -Pattern 'SECURITY DEFINER').Count
```

Las tres reglas del 3.3 no cambian por estar en PowerShell: ninguna función
`SECURITY DEFINER` puede salir sin `search_path` fijo, las otras 27 aparecen como
`INVOKER (por defecto)` en `funciones.txt`, y una línea `SECURITY INVOKER` en el
archivo significa que alguien la escribió a mano. Con `Select-String` el conteo
del `SECURITY DEFINER` sale en una línea; con `Select-String` a secas se ve la línea
completa, que es lo que se quiere para el `SECURITY INVOKER` (vacío). Que haya
**una** sola `DEFINER` es el estado POST-077: `write_audit_log` ya no existe
(punto 6).

### 7.10 Lo que no cambia, otro vez

Lo mismo que al abrir la sección, y es lo que hay que revisar al final:

- el orden de los pasos, sin saltos;
- el punto 3 completo **antes** de cualquier reset;
- los conteos esperados tal cual están escritos arriba;
- **el reset solo procede si el diff de esquema sale vacío**. Con diferencias, no
  se resetea: se corrige el archivo y se vuelve al 2.3, como en el 3.4.

Y una advertencia de shell, no de procedimiento: `grep` cuenta líneas con
`-c`, y `Select-String` devuelve una coincidencia por línea, así que los números
deben coincidir con los del bash. Si alguno no coincide, el problema casi nunca es
el conteo: es que se está mirando un archivo distinto del que se generó.
