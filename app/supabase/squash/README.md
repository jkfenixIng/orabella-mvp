# Squash del esquema — manual del operador

Este archivo es el procedimiento que se sigue **antes** de que exista
`app/supabase/migrations/001_orabella_schema.sql`. No es documentación del
esquema: es la lista ordenada de pasos que produce el archivo único, con los
comandos exactos y las comprobaciones que tienen que salir limpias.

Alcance de este manual:

- el proyecto vive en `D:/u/orabella` y la aplicación en `D:/u/orabella/app`;
- la fuente es una base con el historial completo aplicado (serie 001-077; 76
  archivos en `app/supabase/schema-history/`, la 032 nunca existió);
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
permisos, y por eso hay una segunda pasada explícita para ellos (2.4).

---

## 2. Los comandos, en orden

Cada paso depende del anterior. No se salta ninguno.

Los bloques de este manual son **bash** (en esta máquina, el bash de Git, que es
donde están `psql`, `pg_dump` y `createdb` del PostgreSQL 18).

Si la terminal es PowerShell, ninguno de esos bloques se puede copiar tal cual:
`export`, `read -rs`, `$(…)`, `<<'SQL'`, `sed`/`grep`/`diff <(…)` y
`{ } > tmp && mv` no existen ahí. El equivalente de cada comando está en la
**sección 7**, en el mismo orden y con los mismos parámetros. El paso 2.2 (la
clave) tiene su forma propia en 7.2.

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
  exige (43 en el archivo actual). Por eso el paso 2.4.
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

grep -cE "^(REVOKE|GRANT) " "$WORK/pruebas.acl.sql"     # el archivo único se queda con 43 de ellos
```

Lo que se transcribe y lo que no:

- **Sí**: los `REVOKE`/`GRANT` que el historial redactó sobre `anon`,
  `authenticated`, `PUBLIC` y `service_role` (los de `008_hardening.sql`,
  `017_hardening_round2.sql`, `018_hardening_followup.sql` y los posteriores).
  Salen aquí como permisos efectivos sobre el objeto.
- **No**: los permisos por defecto que la plataforma concede al crear una tabla.
  Esos los aplica el propio proyecto y no son parte del archivo. La cuenta del
  punto 3.2 es la que confirma que la transcripción quedó en su sitio justo: el
  archivo único actual tiene **43** (`grep -cE "^(REVOKE|GRANT) "` da 43, con 21
  `REVOKE` y 22 `GRANT`), y una cuenta mucho mayor delata permisos por defecto
  colados.

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
grep -c "^CREATE POLICY "         supabase/test-bootstrap.sql     # 10
grep -n "seeds/acceptance.sql"    supabase/test-bootstrap.sql
```

Las dos cifras salen del archivo único y solo de él: `seeds/acceptance.sql` es
dato y no declara ninguna tabla ni ninguna política, así que no suma a ninguna de
las dos. Las **10** políticas, y no las 37 de una etapa anterior, son las que
declara el estado POST-077: las políticas por sede que la 074 y la 077 retiraron ya
no están en el archivo.

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

Este bloque se ejecuta **dos veces**: contra la base con el historial aplicado y
contra `squash_check`. Las dos columnas `encontrado` tienen que ser idénticas, y
cada `encontrado` tiene que estar en la columna `esperado`.

Los valores esperados son los que declara el encabezado de
`001_orabella_schema.sql`, y son **exactos**, no aproximados: ese encabezado es el
inventario del volcado, y las cifras se corrigen junto con el archivo. Si el
historial recibe una migración nueva, se actualizan las dos columnas y el
encabezado, en el mismo commit.

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

Sobre los números esperados: son los del encabezado del archivo único y no se
reinterpretan. Las cifras que bajaron de golpe respecto de una etapa anterior son
las que la 077 tocó —`policies` de 37 a 10, `fk` de 85 a 56, `unique_constraint`
de 6 a 13 y `rls_enabled` de 35 a 36— y las que subieron también están
anotadas: `check` 128 y `triggers` 21. Lo exigible sin ambigüedad es doble: que las
dos bases coincidan entre sí, y que la cifra exacta quede anotada en el encabezado
de `001_orabella_schema.sql` para que las verificaciones siguientes tengan un
valor de comparación estable.

`REVOKE`/`GRANT` no son objetos del catálogo, así que su conteo es sobre el
archivo, no sobre la base:

```bash
grep -cE "^(REVOKE|GRANT) " supabase/migrations/001_orabella_schema.sql   # 43
grep -c "^COMMENT ON "        supabase/migrations/001_orabella_schema.sql   # 139
```

### 3.3 Firma, seguridad y `search_path` de las 28 funciones

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
# esperado: 1

PGPASSWORD= psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d squash_check -c "
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos,
       array_to_string(p.proconfig, ', ') AS opciones
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
 ORDER BY 1;"
# esperado, exactamente esta y nada más:
#   current_sede_id  ()   SET search_path = public
```

Era **2** hasta la 077. La segunda era `write_audit_log(uuid, uuid, text, text,
text, jsonb)`, el helper `SECURITY DEFINER` que escribía en `audit_logs`; la 077
lo borró por no tener llamadores, junto con sus permisos. Que aquí haya **una** y
no dos es el estado correcto, no una pérdida: si esta consulta devolviera 2, estaría
mirando una base con la 077 sin aplicar.

Ninguna función `SECURITY DEFINER` puede salir sin `search_path` fijo. Las otras
27 son `INVOKER`, que es el valor por defecto: en la columna `seguridad` de
`$WORK/funciones.txt` tienen que aparecer como `INVOKER (por defecto)`.

Sobre el archivo, no sobre la base:

```bash
grep -n "SECURITY INVOKER" supabase/migrations/001_orabella_schema.sql   # debe imprimir nada
grep -n "SECURITY DEFINER" supabase/migrations/001_orabella_schema.sql   # debe imprimir 1 línea
```

### 3.4 La regla

**Cualquier discrepancia bloquea el reset.** No hay "diferencias menores" ni
"esto se ajusta a mano después": si el diff no está vacío, si un conteo no
coincide, si aparece más de una función `DEFINER` o alguna sin `search_path`, se
vuelve al paso 2.3 y se repite. La secuencia segura es: dump → archivo →
verificación en base vacía → diff limpio → recién entonces reset.

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
- **el procedimiento de construcción con su diff profundo contra una base
  reconstruida**: el volcado sale de una base con la serie 001-077 aplicada, y se
  contrasta contra el catálogo. Un archivo editado a mano no sobrevive a esa
  comparación, porque el procedimiento vuelve a construirlo desde la fuente.

Consecuencia práctica, escrita para que nadie la descubra tarde: el archivo único
**no está cubierto por la suite**. La suite cubre la serie y vigila un puñado de
invariantes del archivo; el resto del archivo está cubierto por el diff de
construcción, que corre aparte. Un cambio al `001_orabella_schema.sql` no se
verifica con `npm test`.

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

Los bloques de las secciones 2 y 3 están escritos en **bash**. Esta sección es la
traducción de cada comando a **PowerShell** (Windows), para ejecutar el mismo
procedimiento desde `PS D:\u\orabella\app>` sin cambiar el orden ni las
comprobaciones.

**Lo que no cambia entre los dos shells.** Solo cambia la forma de escribir el
comando, nunca lo que hay que hacer:

- el **orden**: 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6, y después 3.1 → 3.2 → 3.3;
- la **regla de pre-vuelo**: el punto 3 completo se ejecuta **antes** de tocar
  la base; si una comprobación falla, no se resetea, se vuelve al 2.3;
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

Equivalente de 2.3: el `pg_dump` estructural **con** `--no-privileges`.

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

Equivalente de 2.4: el **mismo** volcado **sin** `--no-privileges`. La diferencia
con 7.3 es exactamente una bandera, y es la que recupera los `REVOKE`/`GRANT`.

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
