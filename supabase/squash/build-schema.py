#!/usr/bin/env python
"""Rehace `app/supabase/migrations/001_orabella_schema.sql` desde cero, en una
base DESCARTABLE del servidor de PRUEBAS, y comprueba que el resultado sea el
archivo COMITEADO byte a byte.

Que hace, en orden:
  1. (Re)crea la base temporal `orabella_build` en el SERVIDOR de pruebas.
  1b. Aplica la FIXTURE DE PLATAFORMA (`auth.jwt()`) DESPUES de crear la base
     y ANTES de la migracion 001, y comprueba que `btree_gist` se puede crear
     con el usuario del pooler (la 035 y la 074 la necesitan).
  2. Aplica la SERIE HISTORICA `app/supabase/schema-history/*.sql` en orden
     alfabetico, uno por uno, con `psql -v ON_ERROR_STOP=1
     --single-transaction`, y se detiene en el primero que falle reportando
     archivo, linea y mensaje.  La serie vive en `schema-history/` porque el
     archivo unico ya la REEMPLAZO en `migrations/`; este script la aplica, no
     la lee de ahi.
  3. Vuelca el esquema con `pg_dump --schema-only --no-owner --exclude-schema=auth`
     (SIN `--no-privileges`, para que sobrevivan los REVOKE y GRANT de funciones).
     Se EXCLUYE `auth` porque el destino ya lo tiene: un archivo unico que
     declarara `CREATE SCHEMA auth` no se podria aplicar en ningun proyecto
     Supabase.
  4. Verifica el volcado como texto y lo contrasta contra el catalogo.
  5. ENSAMBLA el archivo unico: el ENCABEZADO, que vive aparte y revisable en
     `app/supabase/squash/schema-header.sql` (188 lineas, prosa, no se genera),
     seguido del CUERPO del volcado, literal salvo las ocho lineas que el
     encabezado enumera como descartadas (el banner, la vacia que lo sigue, el
     `\\restrict` con su clave de sesion y el `\\unrestrict` con la suya, con sus
     dos lineas vacias).  Compara el sha256 de lo ensamblado con el del archivo
     COMITEADO (`git show HEAD:app/supabase/migrations/001_orabella_schema.sql`)
     y con el del archivo en el arbol de trabajo.

Que NO hace, por diseno:
  * No se conecta a produccion. El conninfo de produccion solo se lee para
    COMPARAR el host y abortar si el de pruebas fuera el mismo.
  * No modifica la base de pruebas: se conecta a `postgres` unicamente como
    servidor para crear y descartar `orabella_build`.
  * No toca el historial de migraciones, y la 077 solo se aplica a la base
    temporal.
  * No AJUSTA el archivo unico para que coincida con lo que produjo.  Si los dos
    sha256 difieren, el script IMPRIME por que y se detiene: la causa se
    investiga; el archivo commiteado no se reescribe para callar al verificador.
    Solo escribe dentro del repositorio un archivo byte-identico al que ya esta
    (o uno que no existe todavia), y escribir un contenido distinto exige
    `SQUASH_ESCRIBIR=1`.
  * Lo demas que produce queda FUERA del repositorio, en `~/orabella-db/`: la
    copia de la fixture y el volcado. La fixture revisable vive en el repo
    (`app/supabase/squash/_platform_fixture.sql`) y solo se lee.

La clave viaja en el conninfo y llega a `psql` / `pg_dump` por el entorno
(PGPASSWORD), nunca en una linea de comandos.

Si una migracion falla, el script se detiene en ella y NO produce ningun
volcado, salvo que se pida explicitamente el modo provisional:

  SQUASH_PROVISIONAL=1 python app/supabase/squash/build-schema.py

Ese modo vuelca el estado ALCANZADO HASTA LA FALLA en un archivo con
PROVISIONAL en el nombre y lo verifica igual, para poder revisar la frontera de
plataforma sin esperar al arreglo. No parchea la migracion, no la saltea y no
reintenta: el archivo provisional no es nunca la fuente del archivo unico, y por
eso en ese modo NO se ensambla el archivo unico.

Uso:  python app/supabase/squash/build-schema.py
"""

from __future__ import annotations

import glob
import hashlib
import os
import re
import subprocess
import sys
import time

import psycopg
from psycopg.conninfo import conninfo_to_dict

# --- Rutas ------------------------------------------------------------------

# El script vive en app/supabase/squash/, asi que el repo se sube tres niveles.
AQUI = os.path.dirname(os.path.abspath(__file__))            # app/supabase/squash
SUPABASE_DIR = os.path.dirname(AQUI)                          # app/supabase
APP_DIR = os.path.dirname(SUPABASE_DIR)                      # app
REPO = os.path.dirname(APP_DIR)                              # raiz del repo

# La serie historica ya NO esta en migrations/ (el archivo unico la reemplazo):
# se aplica desde schema-history/, en el mismo orden alfabetico de siempre.
SERIE_DIR = os.path.join(SUPABASE_DIR, "schema-history")

# El encabezado del archivo unico vive aparte y se revisa aparte: 188 lineas de
# prosa que describen de donde sale el esquema y que NO se generan. El script lo
# concatena con el cuerpo del volcado, sin reescribirlo.
HEADER_PATH = os.path.join(AQUI, "schema-header.sql")

# Lo que este script ensambla. Es el unico archivo del repo que escribe, y solo
# cuando el contenido coincide byte a byte con el que ya esta ahi.
TARGET_REL = os.path.join("app", "supabase", "migrations", "001_orabella_schema.sql")
TARGET_PATH = os.path.join(REPO, TARGET_REL)

HOME = os.path.expanduser("~")
DB_DIR = os.path.join(HOME, "orabella-db")
TEST_CONNINFO = os.path.join(DB_DIR, "pruebas.conninfo")
PROD_CONNINFO = os.path.join(DB_DIR, "prod.conninfo")
BUILD_DB = "orabella_build"
DUMP_PATH = os.path.join(DB_DIR, "esquema-final.sql")

# El ensamblado se escribe primero aqui, FUERA del repo, y recien ahi se decide
# si el archivo del repo se toca. asi una diferencia nunca deja el arbol a medias.
ENSAMBLADO_PATH = os.path.join(DB_DIR, "esquema-001-ensamblado.sql")

# Fixture de plataforma: la fuente revisable esta en el repo; aqui se copia al
# directorio de trabajo (fuera del repo) y se aplica desde ahi.
FIXTURE_REPO = os.path.join(REPO, "app", "supabase", "squash", "_platform_fixture.sql")
FIXTURE_WORK = os.path.join(DB_DIR, "_platform_fixture.sql")

# Esquemas que la plataforma de destino YA tiene. Si alguno apareciera declarado
# en el archivo unico, este no se podria aplicar en un proyecto Supabase real.
ESQUEMAS_PLATAFORMA = ("auth", "storage", "vault", "extensions", "graphql",
                       "realtime", "pgbouncer")

# --- Utilidades -------------------------------------------------------------


def die(msg: str, code: int = 2) -> None:
    print("\n[ABORTA] " + msg, flush=True)
    sys.exit(code)


def titulo(n: str) -> None:
    print("\n" + "=" * 78)
    print(n)
    print("=" * 78, flush=True)


def read_conninfo(path: str) -> dict:
    if not os.path.isfile(path):
        die("no existe el conninfo: " + path)
    with open(path, encoding="utf-8") as fh:
        d = conninfo_to_dict(fh.read().strip())
    d["password"] = d.get("password", "")  # la clave vive aqui, no se imprime
    return d


def dsn_para(d: dict, dbname: str) -> str:
    """Conninfo con otra base, sin la clave: es lo unico que se puede imprimir."""
    return "host=%s port=%s dbname=%s user=%s" % (
        d.get("host", ""), d.get("port", ""), dbname, d.get("user", ""))


def pg_env(d: dict, dbname: str) -> dict:
    """Entorno de libpq: la clave va en PGPASSWORD, no en la linea de comandos."""
    env = dict(os.environ)
    mapa = {
        "host": "PGHOST",
        "port": "PGPORT",
        "user": "PGUSER",
        "dbname": "PGDATABASE",
        "password": "PGPASSWORD",
        "sslmode": "PGSSLMODE",
        "connect_timeout": "PGCONNECT_TIMEOUT",
    }
    for k, v in d.items():
        if k in mapa and v:
            env[mapa[k]] = str(v)
    env["PGDATABASE"] = dbname
    env["PGAPPNAME"] = "squash-build"
    # Sin esto, psql escribe sus mensajes en la codepage de la consola de
    # Windows y los acentos del mensaje de error salen como '?'.
    env["PGCLIENTENCODING"] = "UTF8"
    return env


def conectar(d: dict, dbname: str) -> psycopg.Connection:
    return psycopg.connect(
        dsn_para(d, dbname),
        password=d.get("password", ""),
        autocommit=True,
        connect_timeout=30,
        application_name="squash-build",
    )


def q(cn: psycopg.Connection, query: str, params=None) -> list:
    """Ejecuta y devuelve filas; en un comando sin resultado devuelve []."""
    with cn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall() if cur.description else []


# --- 1. Base temporal -------------------------------------------------------


def recrear_base(d: dict) -> None:
    titulo("1. BASE TEMPORAL `%s` EN EL SERVIDOR DE PRUEBAS" % BUILD_DB)
    with conectar(d, "postgres") as cn:
        ver = q(cn, "SELECT version()")[0][0]
        print("  servidor   : " + ver.split(" on ")[0])
        print("  base usada : " + q(cn, "SELECT current_database()")[0][0])
        q(cn, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
              "WHERE datname = %s AND pid <> pg_backend_pid()", (BUILD_DB,))
        # WITH (FORCE) cierra las conexiones que el pooler mantenga abiertas; el
        # DROP puede necesitar un par de intentos porque el pooler reconecta
        # entre uno y otro.
        for intento in range(1, 6):
            try:
                q(cn, "DROP DATABASE IF EXISTS " + BUILD_DB + " WITH (FORCE)")
                break
            except psycopg.errors.ObjectInUse:
                if intento == 5:
                    raise
                print("  intento %d: la base sigue en uso; se reintenta" % intento)
                time.sleep(3)
        q(cn, "CREATE DATABASE " + BUILD_DB)
        print("  DROP DATABASE IF EXISTS + CREATE DATABASE: OK (reproducible)")


# --- 1b. Fixture de plataforma y btree_gist ---------------------------------


def correr_psql(ruta: str, env: dict, etiqueta: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction",
         "-E", "-f", ruta],
        env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


def aplicar_fixture(d: dict) -> None:
    titulo("1b. FIXTURE DE PLATAFORMA (antes de la 001, y fuera del volcado)")
    if not os.path.isfile(FIXTURE_REPO):
        die("no existe la fixture revisable: " + FIXTURE_REPO)
    with open(FIXTURE_REPO, encoding="utf-8") as fh:
        cuerpo = fh.read()
    if "CREATE SCHEMA IF NOT EXISTS auth" not in cuerpo:
        die("la fixture no declara el esquema auth; revisesla antes de correr esto")
    if "NULL::jsonb" not in cuerpo:
        die("la fixture no devuelve NULL::jsonb desde auth.jwt(); revisesla")
    with open(FIXTURE_WORK, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(cuerpo)
    print("  fuente (repo, solo lectura): " + FIXTURE_REPO)
    print("  copia  (fuera del repo)   : " + FIXTURE_WORK)
    print("  bytes                      : %d" % os.path.getsize(FIXTURE_WORK))

    env = pg_env(d, BUILD_DB)
    proc = correr_psql(FIXTURE_WORK, env, "fixture")
    if proc.returncode != 0:
        print((proc.stdout or "") + (proc.stderr or ""))
        die("la fixture de plataforma fallo con codigo %d" % proc.returncode)
    print("  psql -v ON_ERROR_STOP=1 --single-transaction : OK")

    with conectar(d, BUILD_DB) as cn:
        objs = q(cn, """SELECT n.nspname, p.proname
                          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'auth'""")
        print("  esquema `auth` existe ; objetos dentro: " +
              (", ".join("%s.%s" % (r[0], r[1]) for r in objs) or "ninguno"))
        print("  `auth.jwt()` devuelve NULL::jsonb: " + str(q(
            cn, "SELECT auth.jwt() IS NULL")[0][0]))


def verificar_btree_gist(d: dict) -> None:
    """La 035 y la 074 ejecutan CREATE EXTENSION btree_gist.  Si el usuario del
    pooler no puede crearla, el historial se frena ahi; mejor saberlo antes."""
    titulo("1c. btree_gist CON EL USUARIO DEL POOLER (la 035 y la 074 la crean)")
    with conectar(d, BUILD_DB) as cn:
        print("  rol efectivo : " + q(cn, "SELECT current_user")[0][0])
        print("  superusuario : " + str(q(
            cn, "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")[0][0]))
    try:
        with conectar(d, BUILD_DB) as cn:
            q(cn, "CREATE EXTENSION IF NOT EXISTS btree_gist")
            fila = q(cn, """SELECT n.nspname, e.extname
                             FROM pg_extension e JOIN pg_namespace n
                               ON n.oid = e.extnamespace
                            WHERE e.extname = 'btree_gist'""")
            print("  CREATE EXTENSION IF NOT EXISTS btree_gist : OK  (esquema %s)"
                  % fila[0][0])
    except psycopg.Error as exc:
        msg = re.sub(r"(?i)(password|pwd)\s*=\s*\S+", r"\\1=***", str(exc))
        print("  CREATE EXTENSION btree_gist : FALLA -> " + msg.strip().split("\n")[0])
        die("btree_gist no se puede crear con el usuario del pooler; "
            "las migraciones 035 y 074 no podrian aplicarse.")


# --- 2. Migraciones ---------------------------------------------------------

RE_ERROR = re.compile(
    r"psql:(?P<archivo>.+?):(?P<linea>\d+):\s+(?P<sev>ERROR|FATAL|PANIC):\s+(?P<msg>.*)"
)


def aplicar_migraciones(d: dict) -> tuple[list, dict | None]:
    """Devuelve (resultados, fallo). `fallo` es None si todas salieron bien."""
    titulo("2. SERIE HISTORICA, UNA POR UNA (psql -v ON_ERROR_STOP=1)")
    archivos = sorted(glob.glob(os.path.join(SERIE_DIR, "*.sql")))
    if not archivos:
        die("no hay migraciones en " + SERIE_DIR)
    env = pg_env(d, BUILD_DB)
    resultados: list[dict] = []
    print("  %d archivos en %s\n" % (len(archivos), SERIE_DIR), flush=True)

    for ruta in archivos:
        nombre = os.path.basename(ruta)
        t0 = time.monotonic()
        proc = correr_psql(ruta, env, nombre)
        ms = (time.monotonic() - t0) * 1000
        salida = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode == 0:
            resultados.append({"archivo": nombre, "ok": True, "ms": ms})
            print("  OK    %-42s %6.0f ms" % (nombre, ms), flush=True)
            continue

        errores = [x for x in RE_ERROR.finditer(salida)
                   if x.group("sev") in ("ERROR", "FATAL", "PANIC")]
        ult = errores[-1] if errores else None
        print("  FALLA %-42s" % nombre, flush=True)
        print("\n  --- salida de psql (%s) ---" % nombre)
        print(salida.rstrip() if salida.strip() else "(sin salida)")
        print("  --- fin de la salida ---")
        if ult:
            print("\n  ARCHIVO : %s" % ult.group("archivo"))
            print("  LINEA   : %s  (la linea que reporta psql)" % ult.group("linea"))
            print("  MENSAJE : %s" % ult.group("msg"))
            origen = buscar_en_migracion(nombre, ult.group("msg"))
            print("\n  VEREDICTO DE ESTA MIGRACION: abortada por su propia guarda (o por el")
            print("  error de arriba). NO se forzo, NO se parcheo y NO se aplico NINGUNA")
            print("  migracion posterior (--single-transaction revirtio todo lo suyo).")
            if origen:
                print("  la expresion que dispara el error esta escrita en el archivo,")
                print("  linea %d (psql reporta el fin del bloque DO $$...$$):" % origen)
                with open(os.path.join(SERIE_DIR, nombre), encoding="utf-8") as fh:
                    linea = fh.read().splitlines()[origen - 1]
                print("      %s" % linea.strip()[:160])
        else:
            print("\n  psql termino con codigo %d sin linea de error reconocible"
                  % proc.returncode)
            origen = 0
        resultados.append({"archivo": nombre, "ok": False, "ms": ms})
        return resultados, {"archivo": nombre,
                            "linea": ult.group("linea") if ult else "?",
                            "mensaje": ult.group("msg") if ult else "(sin mensaje)",
                            "origen": origen}
    return resultados, None


def buscar_en_migracion(nombre: str, mensaje: str) -> int:
    """Localiza la linea del archivo donde esta escrito el SQL que el error nombra.

    Sirve para distinguir la linea que psql reporta (el fin del bloque
    DO $$...$$) de la linea donde el SQL realmente esta escrito. Solo informa:
    no modifica la migracion.
    """
    ruta = os.path.join(SERIE_DIR, nombre)
    if not os.path.isfile(ruta):
        return 0
    with open(ruta, encoding="utf-8") as fh:
        lineas = fh.read().splitlines()
    m = re.search(r"column\s+([\w.]+)\s+does not exist", mensaje)
    if not m:
        return 0
    columna = m.group(1).split(".")[-1]
    for n, linea in enumerate(lineas, 1):
        if linea.lstrip().startswith("--"):
            continue
        if re.search(r"\b%s\b" % re.escape(columna), linea):
            return n
    return 0


# --- 3. Volcado -------------------------------------------------------------


def volcar(d: dict, ruta_dump: str) -> None:
    titulo("3. VOLCADO DEL ESQUEMA")
    cmd = ["pg_dump", "--schema-only", "--no-owner",
           "--exclude-schema=" + ESQUEMAS_PLATAFORMA[0],  # auth
           "--file", ruta_dump]
    proc = subprocess.run(cmd, env=pg_env(d, BUILD_DB), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print((proc.stdout or "") + (proc.stderr or ""))
        die("pg_dump fallo con codigo %d" % proc.returncode)
    ver = subprocess.run(["pg_dump", "--version"], capture_output=True, text=True)
    with open(ruta_dump, "rb") as fh:
        crudo = fh.read()
    if crudo[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in crudo[:2048]:
        die("el volcado no es texto plano UTF-8 (se usa --file justamente para evitarlo)")
    print("  comando : " + " ".join(cmd))
    print("          (SIN --no-privileges: se conservan los REVOKE y GRANT de funciones)")
    print("          (--exclude-schema=auth: el destino ya trae el esquema de plataforma)")
    print("  destino : " + ruta_dump)
    print("  bytes   : %d" % len(crudo))
    print("  lineas  : %d" % crudo.count(b"\n"))
    print("  cliente : " + ver.stdout.strip())
    print("  sha256  : " + hashlib.sha256(crudo).hexdigest())
    print("          (el volcado NO tiene sha estable: su linea `\\restrict` lleva una")
    print("           clave aleatoria por sesion. La que se compara es la del archivo")
    print("           ensamblado, no la de este volcado.)")


# --- 4. Ensamblado del archivo unico ----------------------------------------

BS = chr(92)          # la barra invertida, sin escribirla en un literal
MARCA_CUERPO = "-- Dumped from database version"


def leer_encabezado() -> str:
    """El encabezado son 188 lineas de prosa, revisables aparte. Este script las
    CONCATENA: no las escribe, no las reordena y no las corrige. Solo comprueba
    que sigan siendo un encabezado (todo comentario) y que no arrastren un
    metacomando de psql."""
    if not os.path.isfile(HEADER_PATH):
        die("no existe el encabezado del archivo unico: " + HEADER_PATH)
    with open(HEADER_PATH, encoding="utf-8", newline="") as fh:
        texto = fh.read()
    if not texto.endswith("\n"):
        die("el encabezado no termina en salto de linea; concatenaria el cuerpo "
            "en la misma linea")
    intruso = [l for l in texto.splitlines() if l.strip() and not l.lstrip().startswith("--")]
    if intruso:
        die("el encabezado tiene %d linea(s) que no son comentario; el archivo "
            "unico se arma de dos piezas y esta tiene que ser prosa: %r"
            % (len(intruso), intruso[0][:80]))
    # MENCIONAR los metacomandos en la prosa esta bien (el encabezado explica
    # que se descartan); lo que no puede es LLEVARLOS: una linea que empiece por
    # el metacomando ensuciaria el archivo con una orden que otros clientes no
    # conocen.
    metalineas = [l for l in texto.splitlines()
                  if l.lstrip().startswith(BS + "restrict")
                  or l.lstrip().startswith(BS + "unrestrict")]
    if metalineas:
        die("el encabezado trae %d linea(s) de metacomando \\restrict/"
            "\\unrestrict; eso pertenece al volcado" % len(metalineas))
    if MARCA_CUERPO in texto:
        die("el encabezado ya trae la linea de version del volcado; el cuerpo "
            "empezaria dos veces")
    return texto


def recortar_volcado(volcado: str) -> tuple:
    """Quita del volcado SOLO lo que el encabezado del archivo unico declara que
    se descarta: el banner inicial, y los metacomandos `\\restrict` y
    `\\unrestrict` de psql 18 con la clave aleatoria que los acompana.

    Devuelve (cuerpo, lineas_descartadas, detalle). Lo demas se conserva
    literal: no se reordena, no se normaliza y no se toca una sola palabra.
    """
    lineas = volcado.splitlines(keepends=True)
    restrict = [i for i, l in enumerate(lineas) if l.startswith(BS + "restrict ")]
    unrestrict = [i for i, l in enumerate(lineas) if l.startswith(BS + "unrestrict ")]
    if len(restrict) != 1 or len(unrestrict) != 1:
        die("el volcado tiene %d lineas `\\restrict` y %d `\\unrestrict`; se "
            "esperaba 1 y 1. Sin ese par no se puede recortar y el ensamblado "
            "no seria el archivo commiteado." % (len(restrict), len(unrestrict)))
    if unrestrict[0] <= restrict[0]:
        die("el `\\unrestrict` aparece antes que el `\\restrict`; el volcado no "
            "tiene la forma que el encabezado del archivo unico describe")
    # La linea del `\restrict` y la vacia que la sigue se caen: el cuerpo arranca
    # en la linea siguiente, la del `-- Dumped from database version`.
    ini = restrict[0] + 2
    if ini >= unrestrict[0]:
        die("el volcado se acabaria antes de empezar")
    cuerpo = "".join(lineas[ini:unrestrict[0]])
    if not cuerpo.startswith(MARCA_CUERPO):
        die("el recorte no arrancaria en la linea de version; el archivo unico "
            "commiteado empieza el cuerpo en `%s`" % MARCA_CUERPO)
    detalle = [
        "lineas 1 a %d: el banner `--` / `-- PostgreSQL database dump` / `--`, la"
        " vacia, y el metacomando `\\restrict` con su clave de sesion"
        % (restrict[0] + 1),
        "linea %d: la vacia que sigue al `\\restrict`" % (restrict[0] + 2),
        "lineas %d a %d: el `\\unrestrict` correspondiente y la vacia del final"
        % (unrestrict[0] + 1, len(lineas)),
    ]
    descartadas = ini + (len(lineas) - unrestrict[0])
    return cuerpo, descartadas, detalle


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def leer_commiteado() -> bytes | None:
    """El archivo tal como esta en git, para comparar. Solo LECTURA: `git show`
    no toca el indice ni el arbol de trabajo."""
    try:
        proc = subprocess.run(
            ["git", "-C", REPO, "show", "HEAD:" + TARGET_REL.replace(os.sep, "/")],
            capture_output=True)
    except OSError as exc:
        print("  no se pudo ejecutar git (%s); se sigue sin comparar contra HEAD" % exc)
        return None
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        print("  git show HEAD:%s no devolvio nada (%s); se sigue sin comparar"
              % (TARGET_REL, err[-1] if err else "sin mensaje"))
        return None
    return proc.stdout


def primera_diferencia(a: bytes, b: bytes) -> tuple:
    """(linea 1-based, linea de A, linea de B) de la primera linea distinta."""
    la, lb = a.decode("utf-8", "replace").splitlines(), b.decode("utf-8", "replace").splitlines()
    for i in range(max(len(la), len(lb))):
        xa = la[i] if i < len(la) else "(fin del archivo)"
        xb = lb[i] if i < len(lb) else "(fin del archivo)"
        if xa != xb:
            return i + 1, xa, xb
    return 0, "", ""


def explicar_diferencia(referencia: bytes, nuevo: bytes) -> None:
    """Dice en QUE parte difieren: el encabezado o el cuerpo. Sin esto el
    veredicto es solo 'los sha no coinciden', que no alcanza para nada."""
    corte = MARCA_CUERPO.encode()
    ia = referencia.find(corte)
    ib = nuevo.find(corte)
    if ia != ib:
        print("  el archivo ensamblado no tiene el mismo punto de corte entre")
        print("  encabezado y cuerpo: git lo tiene en el byte %s, lo nuevo en %s."
              % (ia, ib))
        return
    print("  el ENCABEZADO (las %d lineas previas al cuerpo) coincide: %s"
          % (referencia[:ia].count(b"\n"), referencia[:ia] == nuevo[:ib]))
    ca, cb = referencia[ia:], nuevo[ib:]
    linea, xa, xb = primera_diferencia(ca, cb)
    print("  el CUERPO difiere en su linea %d de %d." % (linea, ca.count(b"\n")))
    print("     commiteado: %s" % xa.strip()[:150])
    print("     ensamblado : %s" % xb.strip()[:150])


def ensamblar(ruta_dump: str) -> dict:
    titulo("4. ENSAMBLADO DEL ARCHIVO UNICO: ENCABEZADO + CUERPO DEL VOLCADO")
    with open(ruta_dump, encoding="utf-8", newline="") as fh:
        volcado = fh.read()
    encabezado = leer_encabezado()
    cuerpo, descartadas, detalle = recortar_volcado(volcado)
    lineas_dump = volcado.count("\n")

    print("  encabezado : " + HEADER_PATH)
    print("              %d lineas, %d bytes (prosa; no la genera este script)"
          % (encabezado.count("\n"), len(encabezado.encode("utf-8"))))
    print("  volcado    : %s" % ruta_dump)
    print("              %d lineas" % lineas_dump)
    print("  DESCARTADO del volcado (y nada mas):")
    for d in detalle:
        print("     - " + d)
    print("              %d lineas descartadas, %d conservadas"
          % (descartadas, cuerpo.count("\n")))
    print("              (el `\\restrict` y el `\\unrestrict` no son SQL: son lo que")
    print("               psql 18 emite alrededor del volcado. Un cliente que no")
    print("               los conozca aborta la carga.)")

    ensamblado = (encabezado + cuerpo).encode("utf-8")
    with open(ENSAMBLADO_PATH, "wb") as fh:
        fh.write(ensamblado)
    print("  ensamblado : " + ENSAMBLADO_PATH)
    print("              %d bytes, %d lineas"
          % (len(ensamblado), ensamblado.count(b"\n")))

    commiteado = leer_commiteado()
    en_arbol = None
    if os.path.isfile(TARGET_PATH):
        with open(TARGET_PATH, "rb") as fh:
            en_arbol = fh.read()

    print()
    print("  %-46s %s" % ("sha256 del archivo ENSAMBLADO (este script)", sha(ensamblado)))
    if commiteado is not None:
        print("  %-46s %s" % ("sha256 del archivo COMMITEADO (git show HEAD:)",
                              sha(commiteado)))
    if en_arbol is not None:
        print("  %-46s %s" % ("sha256 del archivo EN EL ARBOL DE TRABAJO", sha(en_arbol)))
    else:
        print("  %-46s (no existe todavia)" % "sha256 del archivo EN EL ARBOL DE TRABAJO")

    veredicto = "IDENTICO"
    if commiteado is not None and ensamblado != commiteado:
        veredicto = "DIFIERE"
    if en_arbol is not None and ensamblado != en_arbol:
        veredicto = "DIFIERE (respecto del arbol de trabajo)"
    if commiteado is None and en_arbol is None:
        veredicto = "SIN COMPARACION (no hay HEAD ni archivo)"
    print()
    print("  VEREDICTO CONTRA LO COMMITEADO: " + veredicto)

    if veredicto.startswith("DIFIERE"):
        print()
        print("  POR QUE. Esto NO se arregla moviendo el archivo commiteado: el")
        print("  archivo commiteado es el que dice la verdad, y un procedimiento que")
        print("  produce otra cosa no es un procedimiento. Se lee la diferencia:")
        if commiteado is not None:
            explicar_diferencia(commiteado, ensamblado)
        if en_arbol is not None and en_arbol != ensamblado:
            linea, xa, xb = primera_diferencia(en_arbol, ensamblado)
            print("  contra el archivo del arbol de trabajo, la primera diferencia")
            print("  esta en la linea %d:" % linea)
            print("     arbol   : %s" % xa.strip()[:150])
            print("     ensamblado: %s" % xb.strip()[:150])
        print()
        print("  El ensamblado completo quedo en " + ENSAMBLADO_PATH)
        print("  para poder compararlo con `diff` sin tocar el repo.")
        if not os.environ.get("SQUASH_ESCRIBIR"):
            print()
            print("[ABORTA] no se escribe " + TARGET_REL)
            print("  El archivo commiteado se deja como esta. Para reemplazarlo a")
            print("  proposito, con la diferencia ya entendida:")
            print("     SQUASH_ESCRIBIR=1 python " + os.path.basename(__file__))
            sys.exit(4)
        print()
        print("  *** SQUASH_ESCRIBIR=1: se va a escribir " + TARGET_REL + " ***")
        print("  Eso cambia el archivo commiteado; el commit que lo accompany tiene")
        print("  que decir POR QUE el volcado de ahora difiere del anterior.")

    if en_arbol == ensamblado:
        print("  el archivo del arbol de trabajo ya es IDENTICO: no se escribe nada")
        print("  (escribirlo seria un no-op) y `git status` sigue limpio.")
    else:
        with open(TARGET_PATH, "wb") as fh:
            fh.write(ensamblado)
        estado = "no existia y se creo" if en_arbol is None else "se reemplazo"
        print("  se escribio " + TARGET_PATH + "  (%s, %d bytes)"
              % (estado, len(ensamblado)))
    print("  El archivo unico queda como: ENCABEZADO (schema-header.sql) + CUERPO")
    print("  (el volcado menos el banner y los dos metacomandos de psql 18).")

    return {"sha_ensamblado": sha(ensamblado),
            "sha_commiteado": sha(commiteado) if commiteado is not None else "(sin HEAD)",
            "sha_arbol": sha(en_arbol) if en_arbol is not None else "(no existe)",
            "veredicto": veredicto}


# --- 5. Verificacion --------------------------------------------------------


def limpiar(texto: str) -> list[str]:
    """Deja el volcado sin comentarios, sin literales y sin cuerpos de funcion.

    Lo que se busca (`sede_id`, `current_sede_id`) tiene que aparecer en
    DECLARACIONES ejecutables: la prosa de los COMMENT y el codigo dentro de
    los cuerpos $$...$$ se narran o se ejecutan como bloque, no declaran objetos.
    """
    t = re.sub(r"--[^\n]*", "", texto)
    t = re.sub(r"\$([A-Za-z_]\w*)?\$.*?\$\1\$", "''", t, flags=re.S)
    t = re.sub(r"'(?:[^']|'')*'", "''", t)
    return t.splitlines()


RE_CUERPO = re.compile(r"\$([A-Za-z_]\w*)?\$.*?\$\1\$", re.S)
RE_DECL_SCHEMA = re.compile(
    r"^CREATE\s+(?:OR REPLACE\s+)?(?:UNIQUE\s+)?[A-Z ]*?([a-z_][a-z0-9_]*)\s*\.", re.I)
RE_PLAT_QUALIFICADO = re.compile(
    r"\b(%s)\s*\." % "|".join(ESQUEMAS_PLATAFORMA))


def verificar_plataforma(pruebas: dict, texto: str, limpio: list[str]) -> None:
    """Regla 2 del encargo: el archivo unico NO declara plataforma, pero SI
    conserva las referencias a `auth.jwt()` dentro de cuerpos de `public`."""
    titulo("5b. LA FRONTERA DE PLATAFORMA EN EL VOLCADO")

    print("  a) el volcado NO debe declarar objetos de plataforma")
    decl = [l for l in limpio if re.match(r"^CREATE\s+", l, re.I)]
    esquemas = sorted({m.group(1) for l in decl
                       for m in [RE_DECL_SCHEMA.match(l)] if m})
    intruders = [s for s in esquemas if s in ESQUEMAS_PLATAFORMA]
    print("     esquemas declarados por el volcado : %s" % (", ".join(esquemas) or "(ninguno)"))
    print("     de ellos, de plataforma             : %s" % (", ".join(intruders) or "ninguno"))
    intrusos_txt = [l for l in limpio if RE_PLAT_QUALIFICADO.search(l)]
    print("     lineas ejecutables que califican un objeto de plataforma: %d"
          % len(intrusos_txt))
    for l in intrusos_txt[:10]:
        print("       | " + l.strip()[:150])
    for lit in ("CREATE SCHEMA auth", "CREATE OR REPLACE FUNCTION auth.",
                "CREATE FUNCTION auth.", "COMMENT ON SCHEMA auth",
                "ALTER DEFAULT PRIVILEGES IN SCHEMA auth"):
        n = len(re.findall(re.escape(lit), texto, re.I))
        print("     %-38s -> %d" % (lit, n))
    ok_excluye = not intruders and not intrusos_txt and not re.search(
        r"CREATE\s+SCHEMA\s+(%s)\b" % "|".join(ESQUEMAS_PLATAFORMA), texto, re.I)
    print("     VEREDICTO: " + ("excluido por completo" if ok_excluye
                               else "FUGA DE PLATAFORMA EN EL VOLCADO"))

    print()
    print("  b) el volcado SI debe conservar las referencias a auth.jwt()")
    cuerpos = "".join(m.group(0) for m in RE_CUERPO.finditer(texto))
    en_cuerpo = len(re.findall(r"auth\.jwt\(\)", cuerpos))
    total = len(re.findall(r"auth\.jwt\(\)", texto))
    print("     `auth.jwt()` en el volcado             : %d" % total)
    print("     ...de las cuales, dentro de cuerpos $$ : %d" % en_cuerpo)
    print("     VEREDICTO: " + ("todas dentro de cuerpos de funciones de public"
                               if total > 0 and total == en_cuerpo
                               else "REVISAR: hay una referencia fuera de un cuerpo"))

    print()
    print("  c) el cuerpo de public.current_sede_id() debe ser IDENTICO al del historial")
    # La ultima migracion que DECLARA la funcion es la que manda; las posteriores
    # solo le cambian atributos o permisos. Se busca en toda la serie, en
    # orden, y se toma la ultima definicion con cuerpo.
    definicion = None
    for ruta in sorted(glob.glob(os.path.join(SERIE_DIR, "*.sql"))):
        with open(ruta, encoding="utf-8") as fh:
            txt = fh.read()
        for m in re.finditer(
                r"CREATE OR REPLACE FUNCTION public\.current_sede_id\(\).*?AS \$(\w*)\$",
                txt, re.S):
            ini = m.end()
            fin = txt.index("$" + m.group(1) + "$", ini)
            definicion = (os.path.basename(ruta), txt[:ini].count("\n") + 1,
                          txt[ini:fin])
    if definicion is None:
        print("     no se encontro ninguna definicion de current_sede_id() en el historial")
    else:
        archivo, linea, cuerpo = definicion
        print("     ultima definicion del cuerpo: %s (linea %d)"
              % (archivo, linea))
        print("     cuerpo del historial:")
        for l in cuerpo.rstrip().splitlines():
            print("       | " + l)
        print("     ...presente en el volcado, texto integro e identico: %s"
              % (cuerpo in texto))
        if cuerpo not in texto:
            print("     NO coincide. El volcado usa las mismas comillas monetarias")
            print("     con otra etiqueta (`$_$` en vez de `$$`), asi que la comparacion")
            print("     es sobre el CUERPO, no sobre los delimitadores.")

    print()
    print("  d) catalogo de la base temporal")
    with conectar(pruebas, BUILD_DB) as cn:
        q(cn, "SET default_transaction_read_only = on")
        nsp = [r[0] for r in q(cn, "SELECT nspname FROM pg_namespace "
                                  "WHERE nspname NOT LIKE 'pg\\_%%' AND "
                                  "nspname <> 'information_schema' ORDER BY 1")]
        print("     esquemas no sistematicos en la base: %s" % ", ".join(nsp))
        auth_obj = q(cn, """SELECT 'funcion', p.proname FROM pg_proc p
                            JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'auth'
                          UNION ALL
                          SELECT 'relacion', c.relname FROM pg_class c
                            JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'auth'
                          UNION ALL
                          SELECT 'tipo', t.typname FROM pg_type t
                            JOIN pg_namespace n ON n.oid = t.typnamespace
                           WHERE n.nspname = 'auth' ORDER BY 1""")
        print("     objetos dentro de `auth` en la base (fixture): " +
              (", ".join("%s %s" % (r[0], r[1]) for r in auth_obj) or "ninguno"))
        roles = [r[0] for r in q(cn, """SELECT rolname FROM pg_roles
                                         WHERE rolname IN ('anon','authenticated',
                                                           'service_role')
                                         ORDER BY 1""")]
        print("     roles de plataforma disponibles (los necesitan los GRANT): %s"
              % (", ".join(roles) or "NINGUNO"))
        ext = q(cn, """SELECT e.extname, n.nspname FROM pg_extension e
                         JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1""")
        print("     extensiones instaladas: " +
              ", ".join("%s (esquema %s)" % (r[0], r[1]) for r in ext))
    print("     (la fixture vive solo en la base temporal; el volcado la excluyo)")


def main() -> None:
    # La consola de Windows es cp1252 y los mensajes traen acentos y comillas
    # angulares: sin esto, imprimir el error de una migracion revienta.
    for flujo in (sys.stdout, sys.stderr):
        try:
            flujo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    os.makedirs(DB_DIR, exist_ok=True)

    titulo("0. CREDENCIALES Y GUARDAS")
    pruebas = read_conninfo(TEST_CONNINFO)
    produccion = read_conninfo(PROD_CONNINFO)
    if (pruebas.get("host") == produccion.get("host")
            or pruebas.get("user") == produccion.get("user")):
        die("el conninfo de pruebas coincide con el de produccion; no se sigue.")
    for etiqueta, d in (("pruebas", pruebas), ("produccion", produccion)):
        if d.get("dbname") == BUILD_DB:
            die("la base descartable %s aparece como dbname del conninfo de %s; "
                "el script se DROP/CREATE y no puede tocar una base de servicio."
                % (BUILD_DB, etiqueta))
    print("  pruebas     : " + dsn_para(pruebas, pruebas.get("dbname", "postgres")))
    print("  produccion  : " + dsn_para(produccion, "postgres") +
          "   <- solo para comparar; no se conecta")
    print("  host de pruebas != host de produccion : OK")
    print("  base temporal : " + BUILD_DB + "  (descartable, en el servidor de pruebas)")
    print("  dump a escribir: " + DUMP_PATH)

    recrear_base(pruebas)
    aplicar_fixture(pruebas)
    verificar_btree_gist(pruebas)
    resultados, fallo = aplicar_migraciones(pruebas)

    ruta_dump = DUMP_PATH
    if fallo:
        titulo("2b. PRIMERA MIGRACION FALLIDA")
        print("  ARCHIVO            : %s" % fallo["archivo"])
        print("  LINEA (psql)       : %s" % fallo["linea"])
        print("  MENSAJE            : %s" % fallo["mensaje"])
        print("  LINEA en el archivo donde esta escrito el SQL: %s"
              % (fallo["origen"] or "(no se pudo localizar)"))
        print("  aplicadas antes    : %d (todas OK)"
              % sum(1 for r in resultados if r["ok"]))
        print("  posteriores         : NINGUNA (no se intento ninguna)")
        if not os.environ.get("SQUASH_PROVISIONAL"):
            print("\n[ABORTA] no se produjo ningun volcado. Se detiene en el primer fallo,")
            print("sin forzar ni parchear la migracion. Para volcar de todos modos el")
            print("estado alcanzado como ARTEFACTO PROVISIONAL de revision (con nombre y")
            print("banner propios, jamas como fuente del archivo unico):")
            print("     SQUASH_PROVISIONAL=1 python " + os.path.basename(__file__))
            sys.exit(3)
        ultima = [r["archivo"] for r in resultados if r["ok"]][-1][:3]
        ruta_dump = os.path.join(DB_DIR, "esquema-%s-PROVISIONAL.sql" % ultima)
        print("\n  *** MODO PROVISIONAL ACTIVADO (SQUASH_PROVISIONAL=1) ***")
        print("  El volcado de abajo describe el estado HASTA LA FALLA: las %d"
              % sum(1 for r in resultados if r["ok"]))
        print("  migraciones que si salieron bien, la ultima %s." % ultima)
        print("  NO es el esquema final, NO es la fuente del archivo unico, y no debe")
        print("  prometer los objetos que %s crea." % fallo["archivo"])
        print("  Solo sirve para revisar la frontera de plataforma y los conteos.")
        print("  ruta: " + ruta_dump)

    volcar(pruebas, ruta_dump)

    ensamblado_info = None
    if fallo:
        print()
        print("  [NOTA] Modo provisional: NO se ensambla el archivo unico. Este volcado")
        print("  describe el estado hasta el fallo, y el archivo unico se arma solo con")
        print("  el volcado de una corrida donde las %d migraciones salieron bien."
              % sum(1 for r in resultados if r["ok"]))
    else:
        ensamblado_info = ensamblar(ruta_dump)

    titulo("3b. LISTA ORDENADA DE MIGRACIONES APLICADAS")
    for i, r in enumerate(resultados, 1):
        print("  %2d. %-42s %s  %6.0f ms"
              % (i, r["archivo"], "OK   " if r["ok"] else "FALLA", r["ms"]))
    print("  total: %d aplicadas OK, %d fallidas"
          % (sum(1 for r in resultados if r["ok"]),
             sum(1 for r in resultados if not r["ok"])))

    with open(ruta_dump, encoding="utf-8") as fh:
        texto = fh.read()
    limpio = limpiar(texto)

    with conectar(pruebas, BUILD_DB) as cn:
        # Los conteos del catalogo tienen que ser comparables con los del
        # volcado: pg_dump NO vuelca los objetos que pertenecen a una extension
        # (solo su `CREATE EXTENSION`), y las extensiones instaladas aqui caen
        # en el esquema `public`. Por eso se excluyen del lado del catalogo.
        no_ext = ("NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e"
                  " ON e.oid = d.refobjid WHERE d.classid = '%s'::regclass"
                  " AND d.objid = %s AND d.deptype = 'e')")
        cat = {
            "tablas": q(cn, "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
                            "ON n.oid=c.relnamespace WHERE n.nspname='public' "
                            "AND c.relkind IN ('r','p') AND " + no_ext % ("pg_class", "c.oid"))[0][0],
            "vistas": q(cn, "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
                            "ON n.oid=c.relnamespace WHERE n.nspname='public' "
                            "AND c.relkind IN ('v','m')")[0][0],
            "funciones": q(cn, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n "
                               "ON n.oid=p.pronamespace WHERE n.nspname='public' AND "
                               + no_ext % ("pg_proc", "p.oid"))[0][0],
            # El mismo conteo SIN el filtro de extension, para que el texto de
            # la aclaracion se imprima con los numeros reales y no los tenga
            # escritos a mano (que es como se vuelve viejo).
            "funciones_bruto": q(cn, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n "
                                     "ON n.oid=p.pronamespace WHERE n.nspname='public'")[0][0],
            "politicas": q(cn, "SELECT count(*) FROM pg_policy pol JOIN pg_class c "
                               "ON c.oid=pol.polrelid JOIN pg_namespace n "
                               "ON n.oid=c.relnamespace WHERE n.nspname='public'")[0][0],
            # Un indice que sostiene una PK, una UNIQUE o una EXCLUDE sale en el
            # volcado como parte del `ADD CONSTRAINT`, no como `CREATE INDEX`.
            "indices": q(cn, "SELECT count(*) FROM pg_index i JOIN pg_class c "
                             "ON c.oid=i.indexrelid JOIN pg_namespace n "
                             "ON n.oid=c.relnamespace WHERE n.nspname='public' "
                             "AND NOT EXISTS (SELECT 1 FROM pg_constraint k "
                             "WHERE k.conindid = i.indexrelid)")[0][0],
            "indices_bruto": q(cn, "SELECT count(*) FROM pg_index i JOIN pg_class c "
                                    "ON c.oid=i.indexrelid JOIN pg_namespace n "
                                    "ON n.oid=c.relnamespace WHERE n.nspname='public'")[0][0],
            # Los CHECK salen INLINE dentro del `CREATE TABLE`; el resto, en un
            # `ALTER TABLE ONLY ... ADD CONSTRAINT`.
            "cons_alter": q(cn, "SELECT count(*) FROM pg_constraint con JOIN pg_namespace n "
                                "ON n.oid=con.connamespace WHERE n.nspname='public' "
                                "AND con.contype IN ('p','u','f','x')")[0][0],
            "cons_check": q(cn, "SELECT count(*) FROM pg_constraint con JOIN pg_namespace n "
                                "ON n.oid=con.connamespace WHERE n.nspname='public' "
                                "AND con.contype = 'c'")[0][0],
        }
        cat["restricciones"] = cat["cons_alter"] + cat["cons_check"]
        cat["rls"] = q(cn, "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
                            "ON n.oid=c.relnamespace WHERE n.nspname='public' "
                            "AND c.relkind IN ('r','p') AND c.relrowsecurity")[0][0]
        col_db = q(cn, """SELECT table_name FROM information_schema.columns
                          WHERE table_schema='public' AND column_name='sede_id'
                          ORDER BY 1""")
        func_db = q(cn, """SELECT p.proname FROM pg_proc p JOIN pg_namespace n
                           ON n.oid=p.pronamespace
                          WHERE n.nspname='public' AND p.prosrc ~ '\\msede_id\\M'
                          ORDER BY 1""")
        pol_sede = q(cn, """SELECT pol.polname, pol.polrelid::regclass::text FROM pg_policy pol
                             WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'sede_id'
                                OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'sede_id'
                             ORDER BY 1""")
        pol_cur = q(cn, """SELECT pol.polname, pol.polrelid::regclass::text FROM pg_policy pol
                           WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'current_sede_id'
                              OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'current_sede_id'
                           ORDER BY 1""")
        exclusiones = q(cn, """SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
                              WHERE contype='x' ORDER BY conname""")
        tabs = [r[0] for r in q(cn, """SELECT c.relname FROM pg_class c JOIN pg_namespace n
                                       ON n.oid=c.relnamespace WHERE n.nspname='public'
                                       AND c.relkind IN ('r','p') ORDER BY 1""")]
        filas = []
        for t in tabs:
            filas.append((t, q(cn, 'SELECT count(*) FROM public."%s"' % t)[0][0]))

    titulo("5. CONTEO DEL %s: VOLCADO (texto) vs CATALOGO (base)"
           % ("ESQUEMA FINAL" if not fallo
              else "ESTADO PROVISIONAL (solo las %d migraciones aplicadas)"
                   % sum(1 for r in resultados if r["ok"])))
    n_tablas_txt = len(re.findall(r"^CREATE TABLE ", texto, re.M))
    n_func_txt = len(re.findall(r"^CREATE (?:OR REPLACE )?FUNCTION ", texto, re.M))
    n_pol_txt = len(re.findall(r"^CREATE POLICY ", texto, re.M))
    n_idx_txt = len(re.findall(r"^CREATE (?:UNIQUE )?INDEX ", texto, re.M))
    n_add_txt = len(re.findall(r"^\s*ADD CONSTRAINT ", texto, re.M))
    n_check_txt = len(re.findall(r"CONSTRAINT \w+ CHECK", texto))
    n_con_txt = n_add_txt + n_check_txt
    n_acl_txt = len(re.findall(r"^(?:GRANT|REVOKE) ", texto, re.M))
    print("  %-28s %9s %9s" % ("objeto", "volcado", "catalogo"))
    for nombre, t_, c_ in [
        ("tablas", n_tablas_txt, cat["tablas"]),
        ("funciones (sin extension)", n_func_txt, cat["funciones"]),
        ("politicas RLS", n_pol_txt, cat["politicas"]),
        ("indices sinPk/UNIQUE/EXCLUDE", n_idx_txt, cat["indices"]),
        ("ADD CONSTRAINT (p/u/f/x)", n_add_txt, cat["cons_alter"]),
        ("CHECK inline en CREATE TABLE", n_check_txt, cat["cons_check"]),
        ("restricciones (total)", n_con_txt, cat["restricciones"]),
    ]:
        print("  %-28s %9d %9d%s" % (nombre, t_, c_,
                                      "" if t_ == c_ else "   <-- REVISAR"))
    print("  %-28s %9d %9s" % ("GRANT/REVOKE", n_acl_txt, "n/d"))
    print("  %-28s %9s %9d" % ("RLS habilitadas", "n/d", cat["rls"]))
    print("  %-28s %9s %9d" % ("vistas", "n/d", cat["vistas"]))
    print("  %-28s %9s %9d  (los %d restantes sostienen una PK, una UNIQUE o una EXCLUDE,"
          % ("indices en total", "n/d", cat["indices_bruto"],
             cat["indices_bruto"] - cat["indices"]))
    print("  %-28s %9s %9s  por eso salen como ADD CONSTRAINT, no como CREATE INDEX)"
          % ("", "", ""))
    print("  aclaracion de conteos: el volcado NO incluye los objetos que pertenecen")
    print("  a una extension (solo su `CREATE EXTENSION`), y aqui `btree_gist` esta")
    print("  instalada en el esquema `public`: por eso `funciones` compara %d contra"
          % cat["funciones"])
    print("  %d y no contra las %d del catalogo sin filtrar."
          % (cat["funciones"], cat["funciones_bruto"]))

    verificar_plataforma(pruebas, texto, limpio)

    titulo("6. REFERENCIAS A `sede_id` Y `current_sede_id` EN EL VOLCADO")
    refs = [(i, l) for i, l in enumerate(limpio, 1) if re.search(r"\bsede_id\b", l)]
    objetos = set()
    for _, l in refs:
        objetos.update(re.findall(r"\bpublic\.(\w+)\b", l))
    print("  lineas del volcado (sin comentarios, literales ni cuerpos $$) que")
    print("  nombran `sede_id`: %d" % len(refs))
    print("  objetos de esquema que aparecen en esas lineas: " + ", ".join(sorted(objetos)))
    print("  detalle:")
    for i, l in refs:
        print("    %6d | %s" % (i, l.strip()[:150]))
    intrusos = sorted(objetos - {"users", "sedes", "current_sede_id"})
    print("  veredicto: " + ("solo `public.users` (y `public.sedes` como destino de la FK)"
                             if not intrusos else "REFERENCIAS FUERA DE users: " + ", ".join(intrusos)))
    if intrusos and fallo:
        print("  LEE ESTO ANTES DE CONCLUIR NADA: la %s no llego a aplicarse, y es"
              % fallo["archivo"])
        print("  justamente la migracion que borra `sede_id` de todo lo que no sea")
        print("  `users`. Este volcado provisional todavia las tiene, asi que este")
        print("  veredicto es el ESPERADO para el estado al que llego la corrida; no")
        print("  dice nada sobre el esquema final.")

    print()
    cur_sede = [(i, l) for i, l in enumerate(limpio, 1)
                if re.search(r"\bcurrent_sede_id\b", l)]
    print("  lineas del volcado que nombran `current_sede_id()`: %d" % len(cur_sede))
    for i, l in cur_sede:
        print("    %6d | %s" % (i, l.strip()[:150]))

    decl_sede = sorted(re.findall(r"^CREATE TABLE (public\.\w+)\s*\(", texto, re.M))
    con_sede = []
    for t in decl_sede:
        ini = texto.index("CREATE TABLE " + t + " (")
        fin = texto.index("\n);", ini)
        if re.search(r"^\s*sede_id\b", texto[ini:fin], re.M):
            con_sede.append(t)
    print("\n  tablas que el volcado DECLARA con columna `sede_id`: " +
          (", ".join(con_sede) or "ninguna"))
    print("  columnas `sede_id` segun el catalogo: " + ", ".join(r[0] for r in col_db))
    print("  funciones cuyo cuerpo nombra `sede_id`: " + ", ".join(r[0] for r in func_db))
    print("  politicas que nombran `sede_id`: " +
          ", ".join("%s ON %s" % (r[0], r[1]) for r in pol_sede))
    print("  politicas que llaman `current_sede_id()`: " +
          ", ".join("%s ON %s" % (r[0], r[1]) for r in pol_cur))

    titulo("7. LAS DOS COMPROBACIONES EXIGIDAS")
    print("  a) ex_payroll_periods_no_overlap")
    if exclusiones:
        for r in exclusiones:
            print("     %s = %s" % (r[0], r[1]))
    else:
        print("     NO EXISTE ninguna restriccion EXCLUDE")
    en_dump = [(i, l) for i, l in enumerate(limpio, 1)
               if "ex_payroll_periods_no_overlap" in l]
    if en_dump:
        for i, l in en_dump:
            print("     volcado linea %d: %s" % (i, l.strip()[:160]))
    else:
        print("     NO aparece en el volcado")
    print("  b) users.sede_id")
    print("     catalogo: %s" % ("presente" if "users" in [r[0] for r in col_db] else "AUSENTE"))
    print("     volcado : %s" % ("presente" if "public.users" in con_sede
                                 else "AUSENTE"))

    titulo("8. FILAS: EL VOLCADO DESCRIBE ESTRUCTURA, NO DATOS")
    no_vacias = [(t, n) for t, n in filas if n]
    print("  tablas public : %d" % len(filas))
    print("  filas totales : %d" % sum(n for _, n in filas))
    print("  tablas con filas: " +
          (", ".join("%s=%d" % x for x in no_vacias) if no_vacias else "ninguna (0 en todas)"))
    print()
    print("  esas filas las SIEMBRA el propio historial (INSERT ... ON CONFLICT de")
    print("  denominaciones, formas de pago, configs de IVA, catálogo de roles,")
    print("  sede unica y system_settings). No son datos de negocio.")
    print("  Lo que exige el encargo es que el ARCHIVO no las lleve, y eso se")
    print("  comprueba sobre el texto del volcado:")
    for etiqueta, patron in [
        ("INSERT", r"^INSERT INTO "),
        ("COPY ... FROM stdin", r"^COPY "),
        ("SELECT ... datos", r"^SELECT .* FROM public\."),
    ]:
        print("     %-22s -> %d" % (etiqueta, len(re.findall(patron, texto, re.M))))
    print("     `generate_series`/seed en cuerpos: %d (no son datos, son funciones)"
          % len(re.findall(r"generate_series", texto)))
    print("  VEREDICTO: el volcado es estructura pura; las filas viven solo en la")
    print("  base temporal, que es descartable.")

    titulo("9. RESUMEN")
    print("  base temporal : %s (servidor de pruebas; descartable)" % BUILD_DB)
    print("  fixture       : %s  (aplicada antes de la 001; NO va en el volcado)"
          % FIXTURE_WORK)
    print("  serie         : %d migraciones de %s, %d aplicadas OK, %d fallida(s)"
          % (len(resultados), SERIE_DIR,
             sum(1 for r in resultados if r["ok"]),
             sum(1 for r in resultados if not r["ok"])))
    print("  volcado       : %s" % ruta_dump)
    print("  esquema       : %d tablas, %d funciones, %d politicas, %d indices, %d restricciones"
          % (cat["tablas"], cat["funciones"], cat["politicas"], cat["indices"],
             cat["restricciones"]))
    if ensamblado_info:
        print("  archivo unico : " + TARGET_REL)
        print("    sha256 ensamblado por esta corrida : " + ensamblado_info["sha_ensamblado"])
        print("    sha256 commiteado (git show HEAD:) : " + ensamblado_info["sha_commiteado"])
        print("    sha256 en el arbol de trabajo      : " + ensamblado_info["sha_arbol"])
        print("    veredicto                          : " + ensamblado_info["veredicto"])
    if fallo:
        print("\n  [AVISO] el volcado de arriba es PROVISIONAL: describe el estado hasta")
        print("  %s, que abortó. El esquema final exige ademas esa migracion."
              % fallo["archivo"])


if __name__ == "__main__":
    main()