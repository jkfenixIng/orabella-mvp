# Squash del esquema — manual del operador

Este archivo es el procedimiento que se sigue **antes** de que exista
`app/supabase/migrations/001_orabella_schema.sql`. No es documentación del
esquema: es la lista ordenada de pasos que produce el archivo único, con los
comandos exactos y las comprobaciones que tienen que salir limpias.

Alcance de este manual:

- el proyecto vive en `D:/u/orabella` y la aplicación en `D:/u/orabella/app`;
- la fuente es la base **PRUEBAS** del proyecto, con el historial completo
  aplicado (075 migraciones; 074 archivos en disco, la 032 nunca existió);
- el resultado es un solo archivo aplicado: `001_orabella_schema.sql`.

---

## 1. Qué es el squash y por qué el dump es la fuente

El squash reemplaza el historial de migraciones —que es un registro de
reescrituras, no un estado— por un único archivo que declara el esquema tal como
está hoy. Reescribir el historial a mano no es viable: en las 075 migraciones hay
53 definiciones de función que colapsan en 29, 59 políticas que colapsan en 37,
3 restricciones de exclusión de las que sobrevive 1, y cientos de objetos que se
crean, se alteran y se vuelven a declarar. Por eso la fuente del archivo único
es un `pg_dump --schema-only` de la base PRUEBAS: el dump no interpreta el
historial, describe el resultado, de modo que lo sustituye sin que nadie tenga
que reconstruir por lectura qué declaración sobrevive al final. Lo único que no
sale de un `--schema-only` son los permisos, y por eso hay una segunda pasada
explícita para ellos (2.4).

---

## 2. Los comandos, en orden

Cada paso depende del anterior. No se salta ninguno.

Los bloques de este manual son **bash** (en esta máquina, el bash de Git, que es
donde están `psql`, `pg_dump` y `createdb` del PostgreSQL 18). Lo único que hay
que traducir si se trabaja en PowerShell es el paso 2.2, que es el que maneja la
clave.

### 2.1 Preparación: carpeta de trabajo

```bash
cd D:/u/orabella/app
mkdir -p supabase/squash/_verif
WORK=supabase/squash/_verif
```

`_verif/` es desechable. `.gitignore` **no** tiene una regla para esa carpeta: no
la agregues al índice ni la subas.

### 2.2 La credencial, sin pegarla en el documento ni en el historial

La conexión se describe con variables de `libpq`, no con una URI en la línea de
comandos. Dos vías, en orden de preferencia.

**Vía A — `~/.pgpass` (recomendada).** `psql` y `pg_dump` la leen solos: la
clave no aparece ni en el historial ni en la lista de procesos.

```
# ~/.pgpass    (en Windows: %APPDATA%\postgresql\pgpass.conf)
# formato: host:port:base:usuario:clave
db.xxxxxxxxxxxx.supabase.co:5432:postgres:xxxxxxxx:CLAVE_DE_LA_BASE
```

La clave es la de la **base de datos** (Dashboard → Settings → Database →
Connection string → DB password). **No** es la `service_role` ni la `anon`: esas
son llaves de la API, no credenciales de PostgreSQL, y no sirven para conectar.

```bash
chmod 600 ~/.pgpass        # sólo en POSIX; libpq en Windows ignora los permisos
```

Usa la conexión directa o el pooler de **sesión** (puerto `5432`). Evita el
`6543` (transaction pooler) para `pg_dump`: corta la sesión entre sentencias y
el volcado queda abierto a esa variación.

**Vía B — Variable de entorno leída sin eco**, solo si no se puede escribir
`~/.pgpass`. Se escribe en la sesión actual; no se teclea `export
PGPASSWORD=...` a mano, porque eso sí queda en el historial.

```bash
read -rs -p "Clave de la base PRUEBAS (no se escribe en pantalla ni en el historial): " PGPASSWORD
echo
export PGPASSWORD
```

Parámetros de conexión (no contienen la clave):

```bash
PRUEBAS_HOST=db.xxxxxxxxxxxx.supabase.co
PRUEBAS_PORT=5432
PRUEBAS_DB=postgres
PRUEBAS_USER=postgres
export PRUEBAS_HOST PRUEBAS_PORT PRUEBAS_DB PRUEBAS_USER
export PGSSLMODE=require      # la conexión de la plataforma exige TLS
```

Si se optó por la vía B, `PGPASSWORD` queda exportada en esta sesión. **No
olvidarla antes de los pasos con base local (3.1):** `libpq` mandaría la clave de
PRUEBAS al servidor local. Cada comando local de este manual lleva `PGPASSWORD=`
vacío delante justamente por eso.

### 2.3 Volcado del esquema desde PRUEBAS

```bash
pg_dump \
  --host="$PRUEBAS_HOST" --port="$PRUEBAS_PORT" \
  --username="$PRUEBAS_USER" --dbname="$PRUEBAS_DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --file="$WORK/pruebas.dump.sql"
```

Notas de ese comando, porque cada bandera tiene una razón:

- `--schema-only`: sin datos. Es lo que se quiere; los datos no entran al squash.
- `--no-owner`: elimina el `ALTER ... OWNER TO` de cada objeto, que en una
  plataforma apunta al rol interno de la plataforma y no existe en el destino.
- `--no-privileges`: elimina los `GRANT`/`REVOKE`. **Consecuencia a tener en
  cuenta: el archivo resultante no trae ninguno**, y el inventario final sí los
  exige (~184). Por eso el paso 2.4.
- `--file=` en vez de `>`: la redirección de PowerShell escribe el archivo en
  UTF-16 y el SQL resultante no se puede aplicar. `pg_dump --file` no tiene ese
  problema.
- **No** añadas `--no-comments`: los `COMMENT ON` son parte del objeto y el
  inventario final los exige todos.

Comprobación inmediata de que el volcado salió como debía:

```bash
pg_dump --version                      # anota la versión del cliente en el encabezado
grep -n "CREATE EXTENSION" "$WORK/pruebas.dump.sql"
grep -c "^CREATE TABLE public\." "$WORK/pruebas.dump.sql"     # esperado: 36
```

### 2.4 Segunda pasada: los permisos

`--no-privileges` es lo correcto para el cuerpo del esquema, pero deja fuera los
`REVOKE`/`GRANT`, y el archivo único los necesita. Se hace el mismo volcado sin
esa bandera, y de ese segundo archivo se transcriben **solo** los permisos que el
historial declara a mano:

```bash
pg_dump \
  --host="$PRUEBAS_HOST" --port="$PRUEBAS_PORT" \
  --username="$PRUEBAS_USER" --dbname="$PRUEBAS_DB" \
  --schema-only \
  --no-owner \
  --file="$WORK/pruebas.acl.sql"

grep -cE "^(REVOKE|GRANT) " "$WORK/pruebas.acl.sql"     # el orden de magnitud esperado es ~184
```

Lo que se transcribe y lo que no:

- **Sí**: los `REVOKE`/`GRANT` que el historial redactó sobre `anon`,
  `authenticated`, `PUBLIC` y `service_role` (los de `008_hardening.sql`,
  `017_hardening_round2.sql`, `018_hardening_followup.sql` y los posteriores).
  Salen aquí como permisos efectivos sobre el objeto.
- **No**: los permisos por defecto que la plataforma concede al crear una tabla.
  Esos los aplica el propio proyecto y no son parte del archivo. La cuenta del
  punto 3.2 es la que confirma que la transcripción quedó en su sitio justo: si
  sale muy por encima de ~184, se colaron permisos por defecto.

### 2.5 Regenerar `app/supabase/test-bootstrap.sql`

El archivo actual está **desactualizado**: su encabezado declara
`Orden: 001 a 010`, o sea que instalaría un esquema de hace 32 migraciones. No
se arregla a mano; se regenera desde el mismo dump, por concatenación, en el
mismo orden en que el runner los aplicaría.

```bash
cd D:/u/orabella/app
SQUASH=supabase/migrations/001_orabella_schema.sql
TMP="$(mktemp)"
{
  echo "-- test-bootstrap.sql — generado, no editado a mano."
  echo "-- Orden: 001_orabella_schema.sql y luego seeds/acceptance.sql."
  echo "-- Regenerar con el paso 2.5 de supabase/squash/README.md."
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
grep -c "^CREATE POLICY "         supabase/test-bootstrap.sql     # 37
grep -n "seeds/acceptance.sql"    supabase/test-bootstrap.sql
```

Si `001_orabella_schema.sql` todavía no existe, este paso se ejecuta **después**
de redactar ese archivo, no antes.

### 2.6 `app/supabase/seeds/acceptance.sql` no se toca

Este seed es **dato**, no esquema: sede, catálogos, empleados y caja lista, con
nombres ficticios. El squash no lo incluye, el bootstrap lo concatena tal cual, y
su contenido no se edita en esta unidad. Prueba de que sigue intacto:

```bash
git -C D:/u/orabella diff --stat -- app/supabase/seeds/acceptance.sql
```

La salida tiene que estar **vacía**.

---

## 3. Verificación obligatoria antes de cualquier reset

Las cuatro comprobaciones de este punto se ejecutan **antes** de tocar nada. Si
una sola falla, no se resetea: se corrige el archivo y se vuelve a empezar desde
2.3.

Un reset solo es sin pérdida si el diff está vacío. Un dump cuyo contenido no
coincide con la base que iba a reemplazarse es exactamente el modo de fallo que
el squash existe para eliminar.

### 3.1 Diff de esquema: la base actual contra el dump

El dump tiene que describir la base tal como está, y el archivo final tiene que
poder reconstruirla. Se comprueba en las dos direcciones, volcando con las
**mismas** banderas por los dos lados (si a un lado se pasan privilegios y al
otro no, el diff no significa nada).

```bash
cd D:/u/orabella/app
WORK=supabase/squash/_verif

# (a) el lado que se va a reemplazar: la base PRUEBAS viva
pg_dump --host="$PRUEBAS_HOST" --port="$PRUEBAS_PORT" \
  --username="$PRUEBAS_USER" --dbname="$PRUEBAS_DB" \
  --schema-only --no-owner --no-privileges \
  --file="$WORK/vivo.sql"

# (b) el lado reconstruido: el dump aplicado sobre una base VACÍA.
#     En PostgreSQL local basta una base nueva; no se toca PRUEBAS.
#     PGPASSWORD= vacío: la clave de PRUEBAS no se manda al servidor local.
PGPASSWORD= createdb -h localhost -U postgres squash_check
PGPASSWORD= psql -h localhost -U postgres -d squash_check -v ON_ERROR_STOP=1 \
  -f "$WORK/pruebas.dump.sql"
PGPASSWORD= pg_dump -h localhost -U postgres -d squash_check \
  --schema-only --no-owner --no-privileges \
  --file="$WORK/reconstruida.sql"
```

`psql` con `-v ON_ERROR_STOP=1` es obligatorio: sin él, un error de sintaxis a
media carga se pierde en el scroll y la base queda a medio esquema, que es un
diff que miente.

Normalización antes de comparar (las cabeceras llevan fecha y versión, que no son
diferencias de esquema):

```bash
norm() {
  sed -e '/^-- Dumped from database version/d' \
      -e '/^-- Dumped by pg_dump version/d' \
      -e '/^-- Started on /d' \
      -e '/^-- Completed on /d' \
      -e 's/[[:space:]]\+$//' "$1" | grep -v '^$'
}
norm "$WORK/vivo.sql"         > "$WORK/a.norm"
norm "$WORK/reconstruida.sql" > "$WORK/b.norm"

diff -u "$WORK/a.norm" "$WORK/b.norm" > "$WORK/diff.txt" || true
if [ -s "$WORK/diff.txt" ]; then
  echo "BLOQUEADO: el diff no está vacío ($(wc -l < "$WORK/diff.txt") líneas)"
  head -60 "$WORK/diff.txt"
else
  echo "OK: diff vacío, el dump describe la base completa"
fi
```

Si el diff **solo** reordena sentencias —los OID cambian al restaurar, y
`pg_dump` ordena parte de los objetos por OID— la comparación por multiconjunto
descarta ese ruido (bash; la sustitución de proceso no existe en `cmd`):

```bash
diff -u <(sort "$WORK/a.norm") <(sort "$WORK/b.norm") || true
```

Que salga vacío ahí significa: mismas sentencias, distinto orden. Cualquier
línea que mencione un nombre de objeto, un tipo o una columna es una diferencia
real, no ruido de orden.

Los dos `pg_dump` deben salir del **mismo cliente**: anota
`pg_dump --version` y compáralo con el que genera el archivo final. Versiones
distintas cambian las cabeceras de sección y pueden marcar diferencias que no
son de esquema.

### 3.2 Conteos por tipo, con los números esperados

Este bloque se ejecuta **dos veces**: contra PRUEBAS y contra `squash_check`. Las
dos columnas `encontrado` tienen que ser idénticas, y cada `encontrado` tiene que
estar en la columna `esperado`.

```bash
cat > "$WORK/conteos.sql" <<'SQL'
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
  SELECT 'funciones', 29, count(*)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'pk', 36, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'p'
  UNION ALL
  SELECT 'fk', 85, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f'
  UNION ALL
  SELECT 'check', 95, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'
  UNION ALL
  SELECT 'unique_constraint', 6, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'u'
  UNION ALL
  SELECT 'unique_index', 17, count(*)
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND i.indisunique
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
  UNION ALL
  SELECT 'plain_index', 71, count(*)
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
  UNION ALL
  SELECT 'exclusion', 1, count(*)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'x'
  UNION ALL
  SELECT 'triggers', 20, count(*)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'rls_enabled', 35, count(*)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  UNION ALL
  SELECT 'policies', 37, count(*) FROM pg_policies WHERE schemaname = 'public'
) t ORDER BY tipo;
SQL
```

Primero la lectura, contra PRUEBAS:

```bash
psql -v ON_ERROR_STOP=1 -f "$WORK/conteos.sql" \
  -h "$PRUEBAS_HOST" -p "$PRUEBAS_PORT" -U "$PRUEBAS_USER" -d "$PRUEBAS_DB"
```

Después la comparación, con salida sin encabezados para que el diff sea legible
(`-t -A -F '|'` deja una línea por tipo, terminada en `|OK` o `|MISMATCH`):

```bash
psql -v ON_ERROR_STOP=1 -q -t -A -F '|' -f "$WORK/conteos.sql" \
  -h "$PRUEBAS_HOST" -p "$PRUEBAS_PORT" -U "$PRUEBAS_USER" -d "$PRUEBAS_DB" \
  > "$WORK/conteos.pruebas.txt"

psql -v ON_ERROR_STOP=1 -q -t -A -F '|' -f "$WORK/conteos.sql" \
  -h localhost -U postgres -d squash_check \
  > "$WORK/conteos.check.txt"

diff -u "$WORK/conteos.pruebas.txt" "$WORK/conteos.check.txt" || true

# Debe imprimir NADA: cualquier línea que no termine en |OK es una discrepancia.
grep -v "|OK$" "$WORK/conteos.pruebas.txt"
grep -v "|OK$" "$WORK/conteos.check.txt"
```

Sobre los números esperados: las cifras de `fk` (85), `check` (95) y
`REVOKE`/`GRANT` (~184) provienen de una lectura de auditoría y están anotadas
como aproximadas. Lo exigible sin ambigüedad es doble: que las dos bases coincidan
entre sí, y que la cifra exacta quede anotada en el encabezado de
`001_orabella_schema.sql` para que las verificaciones siguientes tengan un valor
de comparación estable.

`REVOKE`/`GRANT` no son objetos del catálogo, así que su conteo es sobre el
archivo, no sobre la base:

```bash
grep -cE "^(REVOKE|GRANT) " supabase/migrations/001_orabella_schema.sql
grep -c "^COMMENT ON "        supabase/migrations/001_orabella_schema.sql
```

### 3.3 Firma, seguridad y `search_path` de las 29 funciones

```bash
psql -v ON_ERROR_STOP=1 -x \
  -h "$PRUEBAS_HOST" -p "$PRUEBAS_PORT" -U "$PRUEBAS_USER" -d "$PRUEBAS_DB" \
  -c "
SELECT p.proname AS nombre,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER (por defecto)' END AS seguridad,
       coalesce(array_to_string(p.proconfig, ', '), '(sin SET)') AS opciones,
       p.prorettype::regtype::text AS retorna
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
 ORDER BY p.proname, argumentos;" > "$WORK/funciones.txt"
```

Y las dos preguntas cerradas sobre seguridad (contra la base reconstruida, que
es la que tiene que quedar con el archivo aplicado):

```bash
PGPASSWORD= psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d squash_check -c "
SELECT count(*) AS definers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef;"
# esperado: 2

PGPASSWORD= psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d squash_check -c "
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos,
       array_to_string(p.proconfig, ', ') AS opciones
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
 ORDER BY 1;"
# esperado, exactamente estas dos y nada más:
#   current_sede_id  ()                                          SET search_path = public
#   write_audit_log  (uuid, uuid, text, text, text, jsonb)       SET search_path = public
```

Ninguna función `SECURITY DEFINER` puede salir sin `search_path` fijo. Las otras
27 son `INVOKER`, que es el valor por defecto: en la columna `seguridad` de
`$WORK/funciones.txt` tienen que aparecer como `INVOKER (por defecto)`.

Sobre el archivo, no sobre la base:

```bash
grep -n "SECURITY INVOKER" supabase/migrations/001_orabella_schema.sql   # debe imprimir nada
grep -n "SECURITY DEFINER" supabase/migrations/001_orabella_schema.sql   # debe imprimir 2 líneas
```

### 3.4 La regla

**Cualquier discrepancia bloquea el reset.** No hay "diferencias menores" ni
"esto se ajusta a mano después": si el diff no está vacío, si un conteo no
coincide, si aparecen tres funciones `DEFINER` o una sin `search_path`, se vuelve
al paso 2.3 y se repite. La secuencia segura es: dump → archivo → verificación en
base vacía → diff limpio → recién entonces reset.

---

## 4. Lista estructural para quien autorice `001_orabella_schema.sql`

### 4.1 Las secciones, en orden

El archivo se respeta el **orden del dump**. Reordenar entre secciones que llevan
dependencia rompe la carga sin que el error sea obvio, así que las secciones se
reconocen, no se reescriben. Este es el orden esperado, y el orden real que
emita el `pg_dump` del propietario manda sobre él:

1. **Encabezado.** Qué es, de qué base salió, con qué versión de `pg_dump`, en qué
   fecha, y los conteos exactos del punto 3.2 ya anotados.
2. **`SET` de contexto y transacción.** El preámbulo que emite `pg_dump`
   (`set_config('search_path', '', false)`, `BEGIN`/`COMMIT`). No se quita.
3. **Extensiones** — 2: `pgcrypto` y `btree_gist`.
4. **Tipos y dominios**, si el dump trae alguno.
5. **Tablas** — 36, cada una con su `CREATE POLICY` y su
   `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` en la posición que el dump los
   deje respecto de ella (no se separan del bloque de su tabla).
6. **Secuencias** propias y sus `ALTER SEQUENCE ... OWNED BY`.
7. **Restricciones** — 36 `PRIMARY KEY`, ~85 `FOREIGN KEY`, ~95 `CHECK`, 6
   `UNIQUE`, 1 `EXCLUDE`, con los cuatro modos de borrado que pide el inventario:
   `ON DELETE CASCADE`, `SET NULL`, `RESTRICT` y el sin cláusula.
8. **Índices** — 17 únicos y 71 simples.
9. **Funciones** — 29.
10. **Disparadores** — 20.
11. **Permisos** — los `REVOKE`/`GRANT` transcritos del paso 2.4, y
    `ALTER DEFAULT PRIVILEGES` si el dump trae alguno.
12. **`COMMENT ON`** — todos.

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

### 4.2 Las dos funciones `SECURITY DEFINER`

Exactamente dos, y no por gusto:

- `public.current_sede_id()` — la leen las políticas RLS por sede; corre con el
  ejecutor de la política, así que necesita `DEFINER` y `SET search_path = public`
  fijo.
- `public.write_audit_log(uuid, uuid, text, text, text, jsonb)` — escribe en
  `audit_logs`, que es append-only.

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
no puede perderlo: si el dump no trae los marcadores (el dump no los genera), se
agregan a mano en esta posición exacta.

### 4.5 Lo que no se toca en el dump

No se borra ningún objeto que el dump declare, ni se "simplifica" ninguna
declaración. Borrar a mano columnas, predicados RLS o referencias foráneas de un
dump es la clase de error que el squash existe para quitar de en medio (ver punto
6). Si algo sobra, sobra porque el dump se equivoca, y entonces se corrige la
base y se vuelve a volcar.

---

## 5. Pruebas que hay que repuntar cuando el archivo exista

**Regla: se repunta, no se borra cobertura.** Cada aserción que se caiga tiene
que quedar equivalente leyendo `001_orabella_schema.sql`. Si una prueba desaparece
porque su objeto ya no existe, eso se documenta en el `describe`; no se elimina
el `describe`.

Lo común a las tres: `tests/atomic-guards.test.ts` y `tests/admin.test.ts` leen
`supabase/migrations` del disco, así que la ruta no cambia; cambian el nombre y
las formas que el regex tiene que tolerar. El dump escribe formas que el historial
no usaba, y en eso es donde fallan:

- `CREATE OR REPLACE FUNCTION` → el dump emite **`CREATE FUNCTION`**;
- la firma va multilínea, con sangría de 4 espacios, no en una línea;
- `ON public.tabla (cols)` → el dump pone **`USING btree`** en medio:
  `CREATE UNIQUE INDEX x ON public.t USING btree (cols)`;
- `ALTER TABLE public.t ADD CONSTRAINT` → el dump pone **`ALTER TABLE ONLY`**;
- `COMMENT` sobre la función → el dump emite `SET search_path` como cláusula de
  la función, no como parte del cuerpo.

### 5.1 `tests/atomic-guards.test.ts`

| Línea | Aserción actual | Qué pasa |
|---|---|---|
| 99 | `expect(MIGRATION_NAMES.length).toBeGreaterThan(40)` | `toBe(1)`: en `supabase/migrations` solo queda el squash. Sube a `toBe(2)` cuando aterrice el `002_*.sql` del punto 6. |
| 100 | `toContain("052_invoice_create_atomic.sql")` | `toContain("001_orabella_schema.sql")`. |
| 101 | `toContain("060_fix_invoice_create_guards.sql")` | se **fusiona** con la línea 100: un solo archivo, una sola aserción de presencia. No hay una segunda versión que verificar. Fusionar no es perder cobertura: la línea 100 sigue exigiendo que el archivo exista. |
| 142 | `for (const name of ["052_...", "060_..."])` | `for (const name of [SQUASH])`: el bucle queda con un solo nombre y las tres aserciones de abajo (`markerLines` a 3, `countAt < insertAt`, el `GET DIAGNOSTICS` posterior al `INSERT`) se evalúan contra el squash. Es la misma cobertura, sobre el archivo que queda. |
| 169 | `expect(diagnostics).toMatch(/\('060',\s*'functiondef'/)` | la versión deja de existir como número de migración: pasa a ser `001`. `toMatch(/\('001',\s*'functiondef'/)`. |
| 170 | `expect(diagnostics).toContain("'fix-060'")` | **sin cambio**: el marcador `fix-060` sigue en el cuerpo de `invoice_create_atomic`, y ese es justo el punto de la prueba. |

El cambio de la línea 169 tiene un acople que hay que ver al mismo tiempo:
`supabase/diagnostics/migraciones_faltantes.sql` necesita su fila del squash con
el mecanismo `functiondef` y el marcador `fix-060`, o el matcher queda mirando una
fila que no existe. La firma de `invoice_create_atomic` no cambia
(`uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb`).

Las líneas 105-113 (barrido de todas las migraciones buscando la forma invertida)
no cambian: leen el directorio entero y matchean tal cual sobre un solo archivo.

### 5.2 `tests/admin.test.ts`

Trece llamadas a `readFileSync` leen de `supabase/migrations`, y las trece son
este repunto. Las demás llamadas del archivo leen `src/`, `app/` o los `.tsx`
(secciones de administración) y no se tocan.

| Línea | Qué lee | Qué pasa |
|---|---|---|
| 127 | todas, para derivar columnas reales | sin cambio de ruta; el regex de `CREATE TABLE public.X (` sigue matcheando el dump |
| 965-966 | `039_atomic_role_replacement.sql` | apunta al squash |
| 1035-1036 | `040_ensure_user_has_role.sql` | apunta al squash |
| 1396 | `003_admin.sql` | apunta al squash |
| 1626-1627 | `054_identity_atomic.sql` | apunta al squash |
| 1909-1910 | `065_employee_pay_frequency.sql` | apunta al squash |
| 2087-2088 | `069_superadmin_role.sql` | apunta al squash |
| 2126-2127 | `070_sedes_unique_name.sql` | apunta al squash |
| 2364 | todas, para derivar `sede_id` obligatoria | sin cambio de ruta |
| 2397-2398 | `073_sede_id_nullable.sql` | apunta al squash |
| 2630 | todas, para derivar unicidades y exclusiones | **el regex tiene que aprender la forma del dump** |
| 3086 | `074_sede_less_constraints.sql` | apunta al squash |
| 3322 | `075_commission_rule_install_key.sql` | apunta al squash |

Cambios que no son solo cambiar la ruta:

- **Línea 2601**: el corte `n.endsWith(".sql") && n < "074_"` pasa a
  `n < "002_"`. Conserva exactamente la misma alarma: entra el squash, y el
  `002_*.sql` del punto 6 queda fuera, igual que antes la 075 quedaba fuera del
  corte de la 074.
- **Línea 2630 (derivación de unicidades y exclusiones)**: hoy busca tres formas
  —`UNIQUE (…)` en línea dentro del `CREATE TABLE` (2637), `CREATE UNIQUE INDEX`
  (2655) y `ADD CONSTRAINT … EXCLUDE USING gist` (2674). Contra el dump, la
  primera y la segunda no matchean nada: el dump no pone `UNIQUE (…)` en línea, y
  el `CREATE UNIQUE INDEX` lleva `USING btree` entre la tabla y las columnas. El
  regex de (b) tiene que tolerar `USING <método>`, y hace falta una forma nueva
  para `ALTER TABLE ONLY public.t ADD CONSTRAINT <nombre> UNIQUE (cols)` — que es
  como el dump declara las unicidades con nombre. Sin eso, la derivación devuelve
  **cero** objetos y la prueba falla por conteo, que es el comportamiento correcto:
  avisa en vez de fingir.
- **Líneas 3127-3136 (`origen`)**: el arreglo de nueve cadenas
  `"003_admin.sql:tax_configs_sede_id_code_name_key"` etc. pasa a tener el mismo
  origen para las nueve: `"001_orabella_schema.sql:<nombre>"`. Los nombres
  **cambian** a los que el dump va a declarar, que son los post-074, sin `sede_id`:
  `tax_configs_code_name_key`, `payment_methods_code_key`, `products_sku_key`,
  `invoices_consecutive_number_key`, `cash_registers_name_key`,
  `cash_denominations_value_key`, `uq_employees_sede_code`,
  `uq_invoices_sede_idempotency_key`, `uq_payroll_draft_per_range`.
- **Línea 3155-3156 (la exclusión)**: `expect(origen.origen).toBe("063_nomina_frecuencias.sql")`
  pasa a `toBe("001_orabella_schema.sql")`, y `elementos` deja de traer
  `sede_id WITH =`: el dump declara la exclusión post-074, que tiene **dos**
  elementos, `coalesce(frequency, '') WITH =` y
  `daterange(start_date, end_date, '[]') WITH &&`.

Lo que el bloque de la 074 pasa a afirmar, en una línea: la instalación es de una
sola sede, así que **ninguna** unicidad ni exclusión lleva `sede_id` como
elemento. Esa es la invariante que la 074 estableció, y sigue siendo verificable
contra el squash. La lista de nueve pasa a ser el inventario de las nueve que
quedan, todas sin sede.

### 5.3 `tests/auth.test.ts`

Dos bloques leen migraciones: `054_identity_atomic.sql` (líneas 1270-1315) y
`057_identity_password_cas.sql` (líneas 1350-1375). Los dos apuntan al squash, y
las formas cambian:

| Línea | Aserción actual | Qué pasa |
|---|---|---|
| 1270-1272 | lee `054_identity_atomic.sql` | apunta al squash |
| 1276-1281 | `toContain("CREATE OR REPLACE FUNCTION public.…")` (5 veces) | el dump emite `CREATE FUNCTION`: cada `toContain` pasa a buscar `CREATE FUNCTION public.…`. La cobertura no baja: sigue exigiendo que la función exista con ese nombre. |
| 1277, 1280 | firmas en una línea (`"p_token_hash text, p_password_hash text, p_now timestamptz"`) | el dump las escribe multilínea con 4 espacios. O se replica la multilínea exacta del dump, o —mejor— la aserción pasa a apoyarse en el volcado de firmas del punto 3.3 (`pg_get_function_identity_arguments`), que es immune al formato. |
| 1286-1293 | `FROM public.password_resets`, `UPDATE public.password_resets`, `GET DIAGNOSTICS v_filas = ROW_COUNT` | **sin cambio**: el dump conserva el cuerpo de la función tal cual |
| 1297, 1375 | `UPDATE public.sessions`, `AND revoked = false`, `SESSIONS_NOT_REVOKED` | sin cambio |
| 1315-1319 | `not.toMatch(/^\s*ALTER TABLE/im)` y `not.toMatch(/^\s*DROP/im)` sobre **el archivo entero** | **hay que acotarlas al cuerpo de la función.** El squash contiene `ALTER TABLE ONLY public.… ADD CONSTRAINT …` legítimos, así que la primera aserción falla sola si no se acota. Es la única que pierde su forma de leerse, no su contenido: lo que se quiere afirmar sigue siendo que la función no altera el esquema. |
| 1350-1352 | lee `057_identity_password_cas.sql` | apunta al squash |
| 1356-1358 | `DROP FUNCTION IF EXISTS public.change_user_password(uuid, text, text)` | el dump no lleva `DROP` (declara la versión vigente, la de cuatro parámetros). La aserción correcta sobre el dump es que `change_user_password` existe con **cuatro** parámetros incluido `p_expected_password_hash`; la versión sin CAS no es la que el dump declara. |
| 1361-1363 | firma de cuatro parámetros en tres líneas con `\n  ` | pasa a la multilínea del dump, o al volcado de firmas del punto 3.3 |

---

## 6. Orden respecto de la migración final de sede única

**El squash se escribe primero. La caída de columnas se escribe encima, como
`002_*.sql`.**

El orden inverso obliga a trabajar sobre el dump con las manos: `sede_id`
aparece en 18 columnas con `NOT NULL`, en 35 predicados de política y en
aproximadamente 25 referencias foráneas, y quitarlo a mano de un `pg_dump` es
justo la clase de error que el squash existe para eliminar — un objeto que se
olvida en un predicado deja una fila expuesta, y una referencia foránea que se
olvida rompe la carga en un punto que nadie lee hasta que ya está en producción.

En el orden correcto, el squash declara `sede_id` como está hoy, que es la
verdad, y el `002_*.sql` aplica encima el cambio de una sola sede: `DROP COLUMN`,
`DROP CONSTRAINT`, la reescritura de políticas. La diferencia entre el antes y el
después queda en un archivo que se lee entero, y el squash no tiene que mentir
sobre el estado intermedio.

Consecuencias prácticas de ese orden:

- `001_orabella_schema.sql` se verifica con el punto 3 **completo**, contra
  PRUEBAS. Es el estado que existe hoy y es el que se preserva.
- El `002_*.sql` se verifica después, contra `squash_check` con el squash ya
  aplicado encima, que es el estado al que se va a resetear.
- El repunto de `tests/admin.test.ts` se hace **dos veces**: primero contra el
  squash solo, y de nuevo cuando el `002_` aterrice, porque el corte
  `n < "002_"` y la lista de columnas con `sede_id` cambian de valor.
- El conteo de `toBeGreaterThan(40)` de `atomic-guards.test.ts` se ajusta a `1`
  con el squash solo y a `2` con el `002_` encima.
