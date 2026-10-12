import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, buildAuditPayload, writeAudit } from "@/src/shared/lib/audit";
import {
  MemoryRateLimiter,
  isExternalRateLimitConfigured,
  isRateLimited,
  recordRateFailure,
  resetRateLimit,
} from "@/src/shared/lib/rate-limit";

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), "supabase", "schema-history", name), "utf8");
}

describe("audit payload (T8, sin red)", () => {
  it("construye el payload con metadata por defecto {}", () => {
    const payload = buildAuditPayload({
      user_id: "user-1",
      action: AUDIT_ACTIONS.INVOICE_ANNULLED,
      entity: "invoices",
      entity_id: "inv-1",
    });
    expect(payload).toEqual({
      user_id: "user-1",
      action: "invoice.annulled",
      entity: "invoices",
      entity_id: "inv-1",
      metadata: {},
    });
    // La instalación es una sola: la sede dejó de ser parte del rastro y el
    // payload no la lleva NI con la clave presente.
    expect(payload).not.toHaveProperty("sede_id");
  });

  it("el login fallido de un documento desconocido deja rastro completo (sin sede)", () => {
    // El caso que antes escribía `sede_id` NULL: el documento no existe, así que
    // no hay usuario ni sede que nombrar. El rastro tiene que salir IGUAL de
    // completo —qué pasó, sobre qué y por qué— y sin el campo que ya no existe.
    const payload = buildAuditPayload({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: "users",
      entity_id: "999",
      metadata: { reason: "unknown_or_inactive" },
    });
    expect(payload).toEqual({
      user_id: null,
      action: "auth.login_failed",
      entity: "users",
      entity_id: "999",
      metadata: { reason: "unknown_or_inactive" },
    });
    expect(payload).not.toHaveProperty("sede_id");
  });

  it("cubre las acciones críticas del vocabulario T8", () => {
    expect(Object.values(AUDIT_ACTIONS)).toEqual(
      expect.arrayContaining([
        "auth.login_failed",
        "auth.login_locked",
        "auth.password_changed",
        "invoice.annulled",
        "cash.shift_closed",
        "payroll.calculated",
        "payroll.closed",
        "voucher.approved",
      ]),
    );
  });

  // Timeout amplio: el primer import dinámico de next/headers + supabase-js
  // es pesado en este entorno; lo que se valida es que nunca lanza.
  it("writeAudit nunca lanza sin backend (devuelve written:false)", async () => {
    const saved = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const result = await writeAudit({
        user_id: "user-1",
        action: AUDIT_ACTIONS.SHIFT_CLOSED,
        entity: "cash_shifts",
        entity_id: "shift-1",
        metadata: { base_incompleta: true },
      });
      expect(result).toEqual({ written: false });
    } finally {
      if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.anon !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.anon;
      if (saved.service !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.service;
    }
  }, 20000);
});

describe("rate-limit compartido T8 (fallback memoria, sin red)", () => {
  const savedUpstash = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  function withoutUpstash() {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  function restoreUpstash() {
    if (savedUpstash.url !== undefined) process.env.UPSTASH_REDIS_REST_URL = savedUpstash.url;
    if (savedUpstash.token !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = savedUpstash.token;
  }

  it("sin Upstash no hay backend externo", () => {
    withoutUpstash();
    try {
      expect(isExternalRateLimitConfigured()).toBe(false);
    } finally {
      restoreUpstash();
    }
  });

  it("fallback: 5 fallos bloquean y reset libera (async)", async () => {
    withoutUpstash();
    const budget = { maxAttempts: 5, windowMs: 15 * 60 * 1000, namespace: "t8-test-login" };
    try {
      for (let i = 0; i < 4; i += 1) {
        expect(await isRateLimited(`doc-fallback-${i % 2}`, budget)).toBe(false);
        await recordRateFailure("doc-fallback", budget);
      }
      expect(await isRateLimited("doc-fallback", budget)).toBe(false);
      const outcome = await recordRateFailure("doc-fallback", budget);
      expect(outcome.blocked).toBe(true);
      expect(await isRateLimited("doc-fallback", budget)).toBe(true);
      await resetRateLimit("doc-fallback", budget);
      expect(await isRateLimited("doc-fallback", budget)).toBe(false);
    } finally {
      restoreUpstash();
    }
  });

  it("MemoryRateLimiter conserva la interfaz T2 (sync)", () => {
    const limiter = new MemoryRateLimiter();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("abc", now);
    expect(limiter.isBlocked("abc", now)).toBe(true);
    expect(MemoryRateLimiter.normalize("  abc ")).toBe("abc");
  });
});

describe("migración 008_hardening.sql (T8)", () => {
  const sql = readMigration("008_hardening.sql");

  it("define current_sede_id() leyendo app_metadata.sede_id del JWT", () => {
    expect(sql).toContain("current_sede_id");
    expect(sql).toContain("app_metadata");
    expect(sql).toContain("auth.jwt()");
  });

  it("crea audit_logs con las columnas TRA-01", () => {
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("audit_logs");
    expect(sql).toContain("entity_id");
    expect(sql).toContain("metadata jsonb");
  });

  it("revoca las políticas permisivas temporales de T2–T7", () => {
    for (const policy of [
      "pol_sedes_sede_isolation",
      "pol_products_sede_isolation",
      "pol_invoices_sede_isolation",
      "pol_cash_shifts_sede_isolation",
      "pol_payroll_periods_sede_isolation",
      "pol_voucher_requests_sede_isolation",
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${policy}`);
    }
    expect(sql).not.toMatch(/FOR ALL USING \(true\)/);
  });

  it("documenta el Auth Hook custom access token con app_metadata.sede_id", () => {
    expect(sql).toContain("custom_access_token_hook");
    expect(sql).toContain("app_metadata,sede_id");
  });

  it("documenta la excepción funcional de roles (catálogo global)", () => {
    expect(sql).toContain("pol_roles_readonly");
  });
});

describe("seed de aceptación §11 (T8)", () => {
  const seed = readFileSync(join(process.cwd(), "supabase", "seeds", "acceptance.sql"), "utf8");

  it("es idempotente (ON CONFLICT / NOT EXISTS)", () => {
    expect(seed).toContain("ON CONFLICT DO NOTHING");
    expect(seed).toContain("NOT EXISTS");
  });

  it("deja sede, 10 empleados (Sonia '13' mixta), 4 servicios, 3 productos", () => {
    expect(seed).toContain("Sede principal");
    expect(seed).toContain("'13'");
    expect(seed).toContain("mixto");
    expect(seed).toContain("duracion_min");
    expect(seed).toContain("SH-500");
  });

  it("activa IVA 19% de prueba, deja ICA inactivo y 6 métodos de pago", () => {
    expect(seed).toContain("'IVA', 'IVA general', 19, true");
    expect(seed).toContain("'ICA', 'ICA', 0, false");
    expect(seed).toContain("bre-b");
  });

  it("deja base_configurada y register listo sin turnos", () => {
    expect(seed).toContain("base_configurada");
    expect(seed).toContain("Caja única");
    expect(seed).not.toMatch(/INSERT INTO public\.cash_shifts/);
  });
});

/* ==========================================================================
   Guardián estructural de RLS: toda tabla que crea la serie lo activa.

   `033_closed_shift_recount.sql` creó `public.cash_shift_recounts` sin
   `ENABLE ROW LEVEL SECURITY` y sin política: la única de las 36 tablas en ese
   estado, y la tercera reincidencia de un defecto que `017_hardening_round2.sql`
   ya había cerrado por escrito para las dos tablas hermanas de caja. La
   migración `076_cash_shift_recounts_rls.sql` lo corrige, pero una corrección
   puntual no evita el cuarto caso: hace falta que el hueco sea IMPOSIBLE de
   volver a abrir.

   Este bloque es esa imposibilidad. No lleva ninguna lista escrita a mano: deriva
   el conjunto de tablas leyendo los `CREATE TABLE` de `supabase/schema-history` y
   exige que cada una tenga su `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` en
   algún punto de la serie. Una tabla creada mañana sin RLS hace caer la suite
   sola, y cae nombrando la tabla, no con un número de versión que haya que
   perseguir.

   Tres decisiones que sostienen la eficacia del guardián:

   1. SE DERIVA, NO SE INVENTA. Una lista escrita a mano se queda corta en
      cuanto se crea la tabla 37, y ahí el guardián deja de guardar silencio y
      empieza a dar una falsa garantía.

   2. EL FILTRO DE NOMBRE NO FILTRA. Se leen TODOS los `.sql` del directorio, sin
      exigir el patrón `NNN_`. El riesgo real de este tipo de comprobación no es
      que falle: es que PASE POR VACÍO. Un filtro de nombres demasiado estrecho
      deriva cero tablas, la comparación "ninguna sin RLS" sale limpia y la
      protección aparente es nula. La aserción anti-vacío del bloque es la que
      convierte un paso en falso en un paso en rojo.

   3. LA PROSA NO CUENTA COMO ESQUEMA. Los comentarios se borran antes de mirar,
      y el barrido respeta los cuerpos delimitados por `$$`: un `-- CREATE TABLE
      public.fantasma` dentro del cuerpo de una función es texto de función, no
      una tabla, y un `CREATE TABLE` real citado en un comentario no crea nada.
   ========================================================================== */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "schema-history");

/**
 * TODOS los `.sql` del directorio, sin filtro de prefijo (ver punto 2 de la
 * cabecera). Son los 76 de la serie.
 *
 * POR QUÉ ESTE DIRECTORIO: la serie se aplanó en `supabase/migrations/001_orabella_schema.sql`
 * y sus 76 archivos se movieron intactos a `supabase/schema-history`. Este
 * guardián deriva el catálogo de tablas de la SERIE y su veredicto tiene que
 * seguir siendo el mismo de antes —las mismas 36 tablas, el mismo veredicto
 * sobre RLS—, así que lee el historial, donde los 76 siguen teniendo los mismos
 * nombres. La prueba de que el archivo único esté completo la da el bloque del
 * squash de más abajo, que sí lee `supabase/migrations`; leer el historial no
 * exime al dump de nada, sólo deja de hacer que este barrido dependa de él.
 */
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/**
 * Apertura de un cuerpo dollar-quoted: `$$` o `$etiqueta$`. Se reconoce sólo al
 * abrir; su contenido se copia tal cual, sin borrar nada de dentro.
 */
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

function matchDollarTag(sql: string, at: number): string | null {
  DOLLAR_TAG_RE.lastIndex = at;
  const match = DOLLAR_TAG_RE.exec(sql);
  return match ? match[0] : null;
}

/**
 * El SQL sin comentarios y sin prosa.
 *
 * Borra `--` hasta el fin de línea y `/* ... *\/`, pero SÓLO fuera de un cuerpo
 * dollar-quoted: dentro de un `CREATE FUNCTION ... $$ ... $$` un guion es SQL, no
 * un comentario, y borrarlo dejaría la función truncada y sus tablas fantasma
 * desaparecidas del conteo. La serie actual no tiene comentarios de bloque, pero
 * el dump de `pg_dump` que producirá el archivo único sí, y a futuro conviene
 * que el guardián no dependa de esa casualidad.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      out += "\n";
      i = newline === -1 ? n : newline + 1;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      out += " ";
      i = close === -1 ? n : close + 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Nombre de tabla normalizado a `esquema.tabla` en minúscula. El esquema se
 * conserva porque el invariante es por tabla dentro de un esquema, no por
 * nombre suelto.
 *
 * El grupo del esquema llega con su punto final (`public.`), que se quita antes
 * de componer la clave: sin eso, `public.` + `.` + nombre da `public..nombre` y
 * la comparación con el `ENABLE` —que sí construye la clave bien— no empareja
 * nunca. Es el tipo de falla que sólo aparece cuando se compara, por eso el
 * control negativo del guardián compara contra la clave exacta.
 */
function tableKey(schema: string | undefined, name: string): string {
  const bare = name.replace(/"/g, "").trim().toLowerCase();
  const ns = (schema ?? "").replace(/"/g, "").trim().replace(/\.$/, "").toLowerCase();
  return ns.length > 0 ? `${ns}.${bare}` : bare;
}

/** `CREATE TABLE [IF NOT EXISTS] [esquema.]nombre` — la serie y el dump de `pg_dump`. */
const CREATE_TABLE_RE =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?((?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\s*\.\s*)?((?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"))/gi;

/** `ALTER TABLE [IF EXISTS] [ONLY] [esquema.]nombre ENABLE ROW LEVEL SECURITY`. */
const ENABLE_RLS_RE =
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\s*\.\s*)?((?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"))\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi;

function collectCreatedTables(sql: string): string[] {
  const found: string[] = [];
  const body = stripSqlComments(sql);
  CREATE_TABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE_RE.exec(body)) !== null) {
    found.push(tableKey(match[1], match[2]));
  }
  return found;
}

function collectRlsEnabledTables(sql: string): string[] {
  const found: string[] = [];
  const body = stripSqlComments(sql);
  ENABLE_RLS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENABLE_RLS_RE.exec(body)) !== null) {
    found.push(tableKey(match[1], match[2]));
  }
  return found;
}

/**
 * Claves con las que puede aparecer el `ENABLE` de una tabla: la calificada tal
 * como se creó, y —si se creó o se activó sin esquema o con otro— la desnuda y la
 * de `public`. Evita un falso positivo cuando una migración califica el nombre y
 * otra no.
 */
function rlsCandidates(key: string): string[] {
  const dot = key.indexOf(".");
  if (dot === -1) return [key, `public.${key}`];
  return [key, key.slice(dot + 1)];
}

/** Tablas creadas sin ningún `ENABLE ROW LEVEL SECURITY` en la serie. */
function tablesWithoutRls(created: ReadonlySet<string>, enabled: ReadonlySet<string>): string[] {
  return [...created]
    .filter((key) => !rlsCandidates(key).some((candidate) => enabled.has(candidate)))
    .sort();
}

/** Recorre un conjunto de fuentes SQL y devuelve las tablas sin RLS. */
function offendersIn(sources: ReadonlyArray<string>): string[] {
  const created = new Set<string>();
  const enabled = new Set<string>();
  for (const sql of sources) {
    for (const key of collectCreatedTables(sql)) created.add(key);
    for (const key of collectRlsEnabledTables(sql)) enabled.add(key);
  }
  return tablesWithoutRls(created, enabled);
}

/**
 * EXCEPCIONES al invariante, a la vista y con motivo escrito.
 *
 * Hoy está VACÍA y tiene que seguir vacía: no hay ninguna tabla de la serie a la
 * que no se le pueda activar RLS, y una excepción sin motivo no es una excepción
 * —es una puerta que alguien abrió y cerró con llave. Agregar una entrada aquí es
 * deliberado y rompe la suite a propósito (`excepciones son vacías o con motivo`),
 * de modo que la excepción nunca aparece por descuido.
 *
 * Si algún día una tabla de verdad no admite RLS (una vista materializada, un
 * objeto que no es `relkind 'r'`, una tabla que vive fuera de `public`), la
 * entrada debe traer la evidencia en el motivo y una prueba que la respalde. No se
 * permite el atajo de allowlistar en silencio.
 */
const RLS_EXEMPTIONS: ReadonlyArray<{ tabla: string; motivo: string }> = [];

/** Margen para las pruebas que LEEN el disco; ver el mismo argumento en atomic-guards. */
const MIGRATION_SCAN_TIMEOUT_MS = 30_000;

const SERIES_SOURCES = MIGRATION_FILES.map((name) =>
  readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
);
const SERIES_TABLES = new Set(SERIES_SOURCES.flatMap(collectCreatedTables));
const SERIES_RLS = new Set(SERIES_SOURCES.flatMap(collectRlsEnabledTables));

describe("RLS en toda tabla creada por la serie (fix-076)", () => {
  it("anti-vacío: el recorrido deriva un catálogo real de tablas", () => {
    // Esta es la aserción que hace útiles a todas las demás. Si el recorrido del
    // directorio se rompe —un filtro de nombres demasiado estrecho, una ruta mal
    // emparentada, el directorio vacío— la derivación devuelve cero tablas, la
    // comparación "ninguna sin RLS" sale limpia y la suite pasa sin comprobar
    // nada. Aquí ese paso en falso se vuelve paso en rojo.
    expect(MIGRATION_FILES.length).toBeGreaterThan(40);
    expect(SERIES_TABLES.size).toBeGreaterThanOrEqual(30);
    for (const known of [
      "public.users",
      "public.sedes",
      "public.cash_shifts",
      "public.cash_shift_counts",
      "public.cash_shift_recounts",
      "public.audit_logs",
      "public.invoice_sequences",
      "public.commission_rules",
    ]) {
      expect(SERIES_TABLES, known).toContain(known);
    }
    // Y el detector del `ENABLE` ve texto real, no cero: las dos tablas que
    // `017` arregló tienen que estar entre las que encuentra.
    expect(SERIES_RLS.has("public.cash_denominations")).toBe(true);
    expect(SERIES_RLS.has("public.cash_shift_counts")).toBe(true);
  }, MIGRATION_SCAN_TIMEOUT_MS);

  it("ninguna tabla creada por la serie queda sin ENABLE ROW LEVEL SECURITY", () => {
    // El invariante. Si esto falla, el mensaje NOMBRA la tabla que falta: no hay
    // número de versión que perseguir ni lectura manual que hacer.
    expect(offendersIn(SERIES_SOURCES)).toEqual([]);
  }, MIGRATION_SCAN_TIMEOUT_MS);

  it("la 076 activa el RLS de cash_shift_recounts y no abre ninguna política", () => {
    const sql = readMigration("076_cash_shift_recounts_rls.sql");
    expect(collectRlsEnabledTables(sql)).toContain("public.cash_shift_recounts");
    // Deny-all es la postura deliberada: activar RLS SIN política deja la tabla
    // cerrada para anon/authenticated y abierta para service_role. Una política
    // en esta migración no sería una mejora, sería una regresión.
    const cuerpo = stripSqlComments(sql);
    expect(cuerpo).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(cuerpo).not.toMatch(/\bUSING\s*\(\s*true\s*\)/i);
  });

  it("no hay excepciones silenciadas, y una excepción futura tendría que justificarse", () => {
    // Sin allowlist. Hoy NO hay ninguna tabla de la serie a la que no se le pueda
    // activar RLS, así que la lista tiene que seguir vacía: una excepción sin
    // motivo escrito no es una excepción, es una puerta que alguien abrió y
    // volvió a cerrar sin dejar rastro.
    expect(RLS_EXEMPTIONS).toEqual([]);
    // El recorrido siguiente es el CONTRATO para el día que alguien agregue una
    // entrada, y por diseño no ejecuta nada mientras la lista esté vacía: una
    // tabla que no exista en la serie, o un motivo de menos de una línea, no
    // cuentan como excepción.
    for (const excepcion of RLS_EXEMPTIONS) {
      expect(SERIES_TABLES, excepcion.tabla).toContain(excepcion.tabla);
      expect(excepcion.motivo.length, excepcion.tabla).toBeGreaterThanOrEqual(60);
    }
  }, MIGRATION_SCAN_TIMEOUT_MS);

  // ---------------------------------------------------------------------
  // Controles del detector. Un guardián que nunca falla no es un guardián: sin
  // estas pruebas, un `offenders` vacío podría significar "todo bien" o
  // "el detector está roto", que se ven iguales.
  // ---------------------------------------------------------------------

  it("control negativo del guardián: una tabla sintética sin el ENABLE queda marcada", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS public.tabla_de_prueba (id uuid PRIMARY KEY);",
      "-- un ENABLE comentado no activa nada:",
      "-- ALTER TABLE public.tabla_de_prueba ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE public.cash_denominations ENABLE ROW LEVEL SECURITY;",
    ].join("\n");
    expect(offendersIn([sql])).toEqual(["public.tabla_de_prueba"]);
  });

  it("control negativo del guardián: la misma tabla con el ENABLE no se marca", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS public.tabla_de_prueba (id uuid PRIMARY KEY);",
      "ALTER TABLE public.tabla_de_prueba ENABLE ROW LEVEL SECURITY;",
    ].join("\n");
    expect(offendersIn([sql])).toEqual([]);
  });

  it("el guardián ATRAPA el defecto real: la serie sin la 076 marca cash_shift_recounts", () => {
    // Se reconstruye el estado previo a la 076 y se exige que el guardián lo
    // rechace, nombrando la tabla. Si esto saliera limpio, el guardián no
    // protegería el defecto que motiva esta unidad.
    const antesDeLa076 = MIGRATION_FILES.filter(
      (name) => name !== "076_cash_shift_recounts_rls.sql",
    ).map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    expect(offendersIn(antesDeLa076)).toEqual(["public.cash_shift_recounts"]);
  }, MIGRATION_SCAN_TIMEOUT_MS);

  it("la prosa no cuenta: el CREATE TABLE comentado de 033 no crea la tabla 'y'", () => {
    // `033_closed_shift_recount.sql` explica en un comentario que sus
    // `CREATE TABLE IF NOT EXISTS` son idempotentes. Leída como código, esa frase
    // crearía una tabla llamada `y`. No la crea: es un comentario.
    expect(collectCreatedTables(readMigration("033_closed_shift_recount.sql"))).not.toContain(
      "public.y",
    );
  });

  it("el cuerpo $$ no se vacía: un -- CREATE TABLE dentro de una función no crea nada", () => {
    // Al revés del control anterior: dentro de un cuerpo dollar-quoted el `--` es
    // SQL, no comentario, y borrarlo dejaría la función truncada. Este control
    // ata el comportamiento de las dos puntas a la vez.
    const sql = [
      "CREATE FUNCTION public.prueba() RETURNS void AS $$",
      "BEGIN",
      "  -- CREATE TABLE public.fantasma (id uuid);",
      "  RAISE NOTICE 'privado';",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "CREATE TABLE public.real (id uuid PRIMARY KEY);",
      "ALTER TABLE public.real ENABLE ROW LEVEL SECURITY;",
    ].join("\n");
    expect(collectCreatedTables(sql)).not.toContain("public.fantasma");
    expect(offendersIn([sql])).toEqual([]);
  });

  it("sobrevive al archivo único: la serie concatenada deriva lo mismo que archivo por archivo", () => {
    // La pregunta del squash, ejecutada en vez de supuesta: si un día las 76
    // migraciones son un solo `001_orabella_schema.sql`, ¿el patrón sigue
    // funcionando? La derivación es POR CONTENIDO y no por versión, así que la
    // respuesta tiene que ser que sí: las mismas tablas, el mismo veredicto.
    const archivoUnico = SERIES_SOURCES.join("\n");
    expect(new Set(collectCreatedTables(archivoUnico))).toEqual(SERIES_TABLES);
    expect(new Set(collectRlsEnabledTables(archivoUnico))).toEqual(SERIES_RLS);
    expect(offendersIn([archivoUnico])).toEqual([]);
  }, MIGRATION_SCAN_TIMEOUT_MS);
});

/* ==========================================================================
   Guardián del SQUASH: `001_orabella_schema.sql` es el artefacto vivo.

   Los 76 archivos de la serie se movieron intactos a `supabase/schema-history`
   —de ahí leen los guardiánes de arriba— y `supabase/migrations` quedó con UN
   solo archivo, el volcado completo. Eso cambia quién manda: mientras la serie
   fueron 76 archivos, el último que escribía una tabla era el que definía el
   esquema y el RLS lo cubría migración por migración. Ahora el que manda es
   este archivo, y no hay ningún guardián que lo proteja: nada impide que la
   próxima migración se escriba en `migrations/`, que el squash vuelva a ser dos
   archivos, o que un objeto se pierda al regenerarlo. Este bloque es esa
   protección.

   DESDE 002: 001 ya está aplicado en producción y no se edita, así que un
   cambio posterior va en una migración numerada nueva (`002_portable_platform.sql`
   fue la primera). La prueba del directorio las acepta una por una, en orden
   estricto, y exige que no declaren tablas, políticas ni permisos: los conteos
   de 001 siguen siendo los del esquema.

   POR QUÉ AQUÍ Y NO EN `atomic-guards.test.ts`: los dos archivos hacen lo mismo
   —leer SQL como TEXTO y derivar hechos del esquema— pero este bloque ya tiene
   las dos piezas que un guardián del volcado necesita y que en el otro archivo
   no están: el `stripSqlComments` que respeta los cuerpos dollar-quoted (sin él,
   un `CREATE TABLE` en prosa dentro de una función contaría como tabla) y el
   bloque de RLS, que es el guardián estructural de la serie y el que primero
   va a pedir cuenta de cualquier tabla que este archivo deje de declarar.

   QUÉ NO HACE: no vuelve a derivar el catálogo de tablas. Eso ya lo hace el
   guardián de RLS de arriba sobre la serie, y el inventario sale IDÉNTICO. Aquí
   se mira el volcado por lo que es —un artefacto único, contable y cerrado—.
   ========================================================================== */

/** El directorio vivo: el que se aplica a una base nueva. */
const SQUASH_DIR = join(process.cwd(), "supabase", "migrations");
const SQUASH_NAME = "001_orabella_schema.sql";
const SQUASH_SQL = readFileSync(join(SQUASH_DIR, SQUASH_NAME), "utf8");
// Git blob SHA-1 at the user's required base commit 13c477b. This is a strict
// no-touch regression guard for the applied 001 and portable 002 migrations.
const BASE_SHA_001 = "b00a917d4e3c5f6683dc2bcf9a092fe762a7acd5";
const BASE_SHA_002 = "65e6a3ad89b3164545b5436ccb3e9f58ab61d485";
/** 003 as committed at 6d0d38d: 004 is a new file and must not edit 003. */
const BASE_SHA_003 = "d42592f55717b6b991b115589d6fee01c864ab8e";
// SHA-256 of the exact file bytes from 7138fde, the pre-006 integration base.
const BASE_SHA256_004 = "dbc796e2eeaf06db88519c03cd7952d841f4f442c9f4c104da10bae18f350c5a";
const BASE_SHA256_005 = "7755a739fc1ea2bd65d5e04ac798e8c15f2eae69da743bc387cd3b4cf055ba7d";

/**
 * El volcado como ESQUEMA, sin prosa.
 *
 * Son dos filtros, y el segundo es el que importa aquí. El primero borra `--` y
 * `/* ... *\/` con el `stripSqlComments` de arriba (respetando los cuerpos
 * `$$`). El segundo borra los `COMMENT ON`: en un volcado de `pg_dump` la
 * documentación viaja como sentencias `COMMENT ON`, no como comentarios de
 * fuente, así que el filtro anterior NO las ve — y son las que citan el
 * `employees.sede_id` que la 077 borró. Contarlas como código daría por vivo un
 * objeto que ya no existe.
 *
 * La forma del volcado es la de `pg_dump`: una sentencia por línea, y las 139
 * `COMMENT ON` terminan en `';` al fin de línea. Por eso el filtro es anclado a
 * la línea completa y no un barrido hasta el primer `;`: 60 de esas 139 prosa
 * llevan un `;` ADENTRO del texto y el barrido las cortaría por la mitad,
 * dejando prosa suelta en el medio del SQL.
 */
function squashSchemaSql(): string {
  return stripSqlComments(SQUASH_SQL).replace(/^COMMENT ON[^\n]*$/gm, "");
}

/** Las tablas que declaran una columna `sede_id`, leída de su propio `CREATE TABLE`. */
function tablasConColumnaSede(sql: string): string[] {
  const conSede: string[] = [];
  for (const bloque of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g,
  )) {
    const declaraSede = bloque[2]
      .split("\n")
      .some((linea) => /^\s*sede_id\b/.test(linea));
    if (declaraSede) conSede.push(`public.${bloque[1]}`);
  }
  return conSede.sort();
}

/**
 * Las migraciones posteriores al squash, ACEPTADAS una por una. 001 ya está
 * aplicado en producción y no se edita: lo que cambia después va en un archivo
 * numerado nuevo, y entra en esta lista a mano, con su decisión escrita en
 * `supabase/squash/README.md` (5.3).
 */
const MIGRACIONES_POSTERIORES = ["002_portable_platform.sql", "003_payment_method_arqueo.sql", "004_inventory_literal_search.sql", "005_cop_whole_peso.sql", "006_installation_owner.sql", "007_money_cap_policy.sql", "008_inactive_payment_method_arqueo.sql", "009_cash_opening_bounds.sql", "010_inventory_catalog_page.sql"] as const;

/**
 * Top-level statements of a SQL file, comments removed. Splits on `;` only
 * outside single-quoted literals and dollar-quoted bodies, so a `;` inside a
 * COMMENT text or a function body never cuts a statement.
 */
function sqlStatements(sql: string): string[] {
  const body = stripSqlComments(sql);
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "$") {
      // Own matcher: `matchDollarTag` anchors with `^`, which under the sticky
      // flag only matches at offset 0.
      const tag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
      tag.lastIndex = i;
      const found = tag.exec(body)?.[0] ?? null;
      if (found !== null) {
        const close = body.indexOf(found, i + found.length);
        const end = close === -1 ? body.length : close + found.length;
        current += body.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === "'") {
      let end = i + 1;
      while (end < body.length && !(body[end] === "'" && body[end + 1] !== "'")) end += body[end] === "'" ? 2 : 1;
      current += body.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) statements.push(current.trim().replace(/\s+/g, " "));
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim().replace(/\s+/g, " "));
  return statements;
}

/** The objects 003 is authorized to touch, and nothing else. */
const OBJ_003 = {
  functions: "(?:payment_method_code_immutable|cash_open_shift_atomic|cash_open_shift_atomic_legacy|cash_recount_shift_atomic|cash_recount_shift_atomic_legacy|voucher_is_cash_out|enforce_voucher_cash_out_state|cash_shift_method_expected_balance|enforce_cash_method_minimum|enforce_commission_cash_method_minimum|enforce_voucher_cash_method_minimum|enforce_collection_move_minimum|lock_invoice_edit_payment_balances|invoice_edit_items_atomic|invoice_edit_emitted_atomic)",
  triggers:
    "(?:trg_payment_methods_code_immutable ON public\\.payment_methods|trg_voucher_requests_cash_out_state ON public\\.voucher_requests|trg_invoice_payments_balance_guard ON public\\.invoice_payments|trg_payments_balance_guard ON public\\.payments|trg_commission_payouts_balance_guard ON public\\.commission_payouts|trg_voucher_requests_balance_guard ON public\\.voucher_requests)",
  constraints: "(?:payment_methods_code_check|payment_methods_code_format_check|payment_methods_arqueo_mode_check|payment_methods_arqueo_coherent_check)",
};

/**
 * EXPLICIT allowlist of 003: one anchored pattern per authorized object and
 * action. A statement that matches none of them is unauthorized, even if its
 * verb is legitimate elsewhere in the file (e.g. another ALTER TABLE action on
 * payment_methods, a grant to another role, a second table).
 */
const ALLOWLIST_003: ReadonlyArray<[string, RegExp]> = [
  ["transaction", /^(?:BEGIN|COMMIT)$/],
  ["payment_methods: add arqueo_mode", /^ALTER TABLE public\.payment_methods ADD COLUMN IF NOT EXISTS arqueo_mode text$/],
  ["payment_methods: backfill arqueo_mode", /^UPDATE public\.payment_methods SET arqueo_mode = CASE [^;]* END WHERE arqueo_mode IS NULL$/],
  ["payment_methods: arqueo_mode NOT NULL", /^ALTER TABLE public\.payment_methods ALTER COLUMN arqueo_mode SET NOT NULL$/],
  [
    "payment_methods: drop the six-code CHECK and 003's own constraints",
    new RegExp(`^ALTER TABLE public\\.payment_methods DROP CONSTRAINT IF EXISTS ${OBJ_003.constraints}(?:, DROP CONSTRAINT IF EXISTS ${OBJ_003.constraints})*$`),
  ],
  [
    "payment_methods: add 003's CHECKs",
    new RegExp(`^ALTER TABLE public\\.payment_methods ADD CONSTRAINT ${OBJ_003.constraints} CHECK \\(.*\\)(?:, ADD CONSTRAINT ${OBJ_003.constraints} CHECK \\(.*\\))*$`),
  ],
  ["payment_methods: one denominations method", /^CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_methods_single_denominations ON public\.payment_methods \(\(true\)\) WHERE arqueo_mode = 'denominations'$/],
  ["cash_shift_method_balances: table", /^CREATE TABLE IF NOT EXISTS public\.cash_shift_method_balances \(/],
  ["cash_shift_method_balances: RLS", /^ALTER TABLE public\.cash_shift_method_balances ENABLE ROW LEVEL SECURITY$/],
  [
    "comments",
    /^COMMENT ON (?:TABLE public\.cash_shift_method_balances|FUNCTION public\.cash_open_shift_atomic\(uuid, uuid, numeric, jsonb\)|FUNCTION public\.(?:invoice_edit_items_atomic|invoice_edit_emitted_atomic)\(uuid, uuid, integer, text, jsonb\)) IS '/,
  ],
  [
    "rename of 001's two invoice edit RPCs (only these, inside DO)",
    /^DO \$\$ BEGIN IF to_regprocedure\('public\.(invoice_edit_items_atomic|invoice_edit_emitted_atomic)_legacy\(uuid,uuid,integer,text,jsonb\)'\) IS NULL THEN ALTER FUNCTION public\.\1\(uuid, uuid, integer, text, jsonb\) RENAME TO \1_legacy; END IF; END; \$\$$/,
  ],
  [
    "edit RPC legacy bodies keep 001's ACL (PUBLIC revoked, service_role only)",
    /^(?:REVOKE ALL ON FUNCTION public\.(?:invoice_edit_items_atomic|invoice_edit_emitted_atomic)_legacy\(uuid, uuid, integer, text, jsonb\) FROM PUBLIC|GRANT ALL ON FUNCTION public\.(?:invoice_edit_items_atomic|invoice_edit_emitted_atomic)_legacy\(uuid, uuid, integer, text, jsonb\) TO service_role)$/,
  ],
  [
    "rename of 001's opener (only this, inside DO)",
    /^DO \$\$ BEGIN IF to_regprocedure\('public\.cash_open_shift_atomic_legacy\(uuid,uuid,numeric,jsonb\)'\) IS NULL THEN ALTER FUNCTION public\.cash_open_shift_atomic\(uuid, uuid, numeric, jsonb\) RENAME TO cash_open_shift_atomic_legacy; END IF; END; \$\$$/,
  ],
  [
    "rename of 001's recount (only this, inside DO)",
    /^DO \$\$ BEGIN IF to_regprocedure\('public\.cash_recount_shift_atomic_legacy\(uuid,uuid,jsonb,jsonb\)'\) IS NULL THEN ALTER FUNCTION public\.cash_recount_shift_atomic\(uuid, uuid, jsonb, jsonb\) RENAME TO cash_recount_shift_atomic_legacy; END IF; END; \$\$$/,
  ],
  ["functions", new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${OBJ_003.functions}\\(`)],
  ["drop own triggers", new RegExp(`^DROP TRIGGER IF EXISTS ${OBJ_003.triggers}$`)],
  [
    "trigger: code immutability + arqueo sync",
    /^CREATE TRIGGER trg_payment_methods_code_immutable BEFORE INSERT OR UPDATE ON public\.payment_methods FOR EACH ROW EXECUTE FUNCTION public\.payment_method_code_immutable\(\)$/,
  ],
  [
    "trigger: commission balance guard",
    /^CREATE TRIGGER trg_commission_payouts_balance_guard BEFORE INSERT OR UPDATE OF amount, method_code, cash_shift_id ON public\.commission_payouts FOR EACH ROW EXECUTE FUNCTION public\.enforce_commission_cash_method_minimum\(\)$/,
  ],
  [
    "trigger: voucher balance guard",
    /^CREATE TRIGGER trg_voucher_requests_balance_guard BEFORE INSERT OR UPDATE OF amount, method_code, cash_shift_id, status, approved_by ON public\.voucher_requests FOR EACH ROW EXECUTE FUNCTION public\.enforce_voucher_cash_method_minimum\(\)$/,
  ],
  [
    "trigger: voucher cash-out state invariant",
    /^CREATE TRIGGER trg_voucher_requests_cash_out_state BEFORE INSERT OR UPDATE OF status, approved_by, method_code, cash_shift_id ON public\.voucher_requests FOR EACH ROW EXECUTE FUNCTION public\.enforce_voucher_cash_out_state\(\)$/,
  ],
  [
    "trigger: invoice collection move guard",
    /^CREATE TRIGGER trg_invoice_payments_balance_guard BEFORE UPDATE OF amount, method_code, cash_shift_id ON public\.invoice_payments FOR EACH ROW EXECUTE FUNCTION public\.enforce_collection_move_minimum\(\)$/,
  ],
  [
    "trigger: drawer collection move guard",
    /^CREATE TRIGGER trg_payments_balance_guard BEFORE UPDATE OF amount, method_code, cash_shift_id, invoice_id ON public\.payments FOR EACH ROW EXECUTE FUNCTION public\.enforce_collection_move_minimum\(\)$/,
  ],
  ["revoke from PUBLIC", new RegExp(`^REVOKE ALL ON FUNCTION public\\.${OBJ_003.functions}\\([a-z, ]*\\) FROM PUBLIC$`)],
  [
    "revoke the internal legacy RPCs from service_role",
    /^REVOKE ALL ON FUNCTION public\.(?:cash_open_shift_atomic_legacy\(uuid, uuid, numeric, jsonb\)|cash_recount_shift_atomic_legacy\(uuid, uuid, jsonb, jsonb\)) FROM service_role$/,
  ],
  [
    "grant the three public RPCs to service_role",
    /^GRANT ALL ON FUNCTION public\.(?:cash_open_shift_atomic\(uuid, uuid, numeric, jsonb\)|cash_recount_shift_atomic\(uuid, uuid, jsonb, jsonb\)|cash_shift_method_expected_balance\(uuid, text\)|lock_invoice_edit_payment_balances\(uuid, jsonb\)|invoice_edit_items_atomic\(uuid, uuid, integer, text, jsonb\)|invoice_edit_emitted_atomic\(uuid, uuid, integer, text, jsonb\)) TO service_role$/,
  ],
];

/** Statements of 003 outside its allowlist, plus privileged DDL hidden in a function body. */
function unauthorized003(sql: string): string[] {
  const offenders: string[] = [];
  for (const statement of sqlStatements(sql)) {
    if (!ALLOWLIST_003.some(([, allowed]) => allowed.test(statement))) {
      offenders.push(statement.slice(0, 140));
      continue;
    }
    // A function body executes what it says: it may not hide DDL or grants.
    if (/^CREATE OR REPLACE FUNCTION/.test(statement) && sentenciasProhibidas(statement).length > 0) {
      offenders.push(`${statement.slice(0, 80)} … ${sentenciasProhibidas(statement).join(", ")}`);
    }
  }
  return offenders;
}

/** 004 can define exactly one literal search function, its ACL and its comment. */
const SEARCH_004 = "public.search_products_literal(text, integer, integer)";
const ALLOWLIST_004: ReadonlyArray<[string, RegExp]> = [
  ["transaction", /^(?:BEGIN|COMMIT)$/],
  ["literal search function", /^CREATE OR REPLACE FUNCTION public\.search_products_literal\( p_query text, p_limit integer, p_offset integer DEFAULT 0 \) RETURNS TABLE \(/],
  ["revoke PUBLIC/anon/authenticated", /^REVOKE ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) FROM (?:PUBLIC|anon|authenticated)$/],
  ["grant service_role", /^GRANT ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) TO service_role$/],
  ["function comment", /^COMMENT ON FUNCTION public\.search_products_literal\(text, integer, integer\) IS '/],
];

/**
 * 004's body is deliberately a narrow read-only program. Checking its prefix
 * was insufficient: everything after RETURNS TABLE was effectively free. Keep
 * the clauses that define the function contract explicit, then reject every
 * write/privilege/dynamic-SQL escape hatch inside the dollar-quoted body.
 */
/** Whitespace/comment-insensitive representation of 004's intended function body. */
function canonical004Body(body: string): string {
  // The body contains no SQL string literal with `--`; stripping these comments
  // makes a review-only explanation unable to relax the executable contract.
  return body.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

const EXPECTED_004_BODY = canonical004Body(`
DECLARE
  v_escape constant text := chr(92);
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  v_pattern := '%' || replace(
    replace(
      replace(coalesce(p_query, ''), v_escape, v_escape || v_escape),
      '%', v_escape || '%'
    ),
    '_', v_escape || '_'
  ) || '%';
  RETURN QUERY
  SELECT
    p.id, p.sku, p.name, p.description, p.stock_qty, p.min_stock,
    p.cost_price, p.sale_price, p.commission_value, p.is_active
  FROM public.products AS p
  WHERE p.name ILIKE v_pattern ESCAPE v_escape
     OR p.sku ILIKE v_pattern ESCAPE v_escape
  ORDER BY p.name ASC, p.id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
`);

function invalid004Function(statement: string): string[] {
  const failures: string[] = [];
  const header = /^CREATE OR REPLACE FUNCTION public\.search_products_literal\( p_query text, p_limit integer, p_offset integer DEFAULT 0 \) RETURNS TABLE \( id uuid, sku text, name text, description text, stock_qty integer, min_stock integer, cost_price numeric, sale_price numeric, commission_value numeric, is_active boolean \) LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public' AS \$\$/;
  if (!header.test(statement)) failures.push("exact signature, SECURITY INVOKER or search_path");
  const body = /AS \$\$([\s\S]*)\$\$$/.exec(statement)?.[1];
  if (body === undefined) {
    failures.push("missing dollar-quoted body");
  } else if (canonical004Body(body) !== EXPECTED_004_BODY) {
    // The body is an allowlist, not a blacklist: any extra statement (DML,
    // DDL, grants, SET ROLE, CALL, PERFORM, dynamic SQL...) changes it.
    failures.push("non-canonical read-only function body");
  }
  return failures;
}

function unauthorized004(sql: string): string[] {
  const offenders: string[] = [];
  const statements = sqlStatements(sql);
  let literalFunctionCount = 0;
  const revokedRoles = new Set<string>();
  let grantCount = 0;
  for (const statement of statements) {
    if (!ALLOWLIST_004.some(([, allowed]) => allowed.test(statement))) {
      offenders.push(statement.slice(0, 140));
      continue;
    }
    if (/^CREATE OR REPLACE FUNCTION/.test(statement)) {
      literalFunctionCount += 1;
      const invalid = invalid004Function(statement);
      if (invalid.length > 0) offenders.push(`${statement.slice(0, 80)} … ${invalid.join(", ")}`);
    }
    const revoke = /^REVOKE ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) FROM (PUBLIC|anon|authenticated)$/.exec(statement);
    if (revoke) revokedRoles.add(revoke[1]);
    if (/^GRANT ALL ON FUNCTION public\.search_products_literal/.test(statement)) grantCount += 1;
  }
  // Full migrations that define 004 must contain exactly its explicit ACL.
  const expectedRevokes = ["PUBLIC", "anon", "authenticated"];
  if (literalFunctionCount > 0 && (literalFunctionCount !== 1 || grantCount !== 1 || expectedRevokes.some((role) => !revokedRoles.has(role)) || revokedRoles.size !== expectedRevokes.length)) {
    offenders.push(`004 cardinality function=${literalFunctionCount} revoke=${[...revokedRoles].sort().join(",")} grant=${grantCount}`);
  }
  return offenders;
}

/** The whole 004 file: allowlisted statements AND exactly one function, ACL pair and comment. */
function invalid004File(sql: string): string[] {
  const offenders = unauthorized004(sql);
  const statements = sqlStatements(sql);
  const count = (pattern: RegExp) => statements.filter((statement) => pattern.test(statement)).length;
  const shape: Array<[string, number]> = [
    ["CREATE search_products_literal", count(/^CREATE OR REPLACE FUNCTION public\.search_products_literal\(/)],
    ["REVOKE PUBLIC", count(/^REVOKE ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) FROM PUBLIC$/)],
    ["REVOKE anon", count(/^REVOKE ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) FROM anon$/)],
    ["REVOKE authenticated", count(/^REVOKE ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) FROM authenticated$/)],
    ["GRANT service_role", count(/^GRANT ALL ON FUNCTION public\.search_products_literal\(text, integer, integer\) TO service_role$/)],
    ["COMMENT", count(/^COMMENT ON FUNCTION public\.search_products_literal\(text, integer, integer\) IS '/)],
  ];
  for (const [label, found] of shape) if (found !== 1) offenders.push(`004 expects exactly one ${label}, found ${found}`);
  return offenders;
}

/**
 * Lo que una migración posterior NO puede hacer, con la marca que lo nombra.
 * Se aplica sobre el SQL ya sin comentarios y sin literales de cadena (la prosa
 * de un `COMMENT ON` no es una sentencia); los cuerpos `$$` sí se miran, porque
 * un `DO $$ ... DROP ... $$` ejecuta lo que dice.
 */
const PATRONES_PROHIBIDOS: Array<[string, RegExp]> = [
  ["CREATE TABLE", /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/i],
  ["CREATE UNLOGGED TABLE", /\bCREATE\s+UNLOGGED\s+TABLE\b/i],
  ["CREATE POLICY", /\bCREATE\s+POLICY\b/i],
  ["ALTER POLICY", /\bALTER\s+POLICY\b/i],
  ["GRANT/REVOKE", /\b(?:GRANT|REVOKE)\b/i],
  ["DROP", /\bDROP\b/i],
  ["ALTER TABLE", /\bALTER\s+TABLE\b/i],
  ["OWNER TO", /\bOWNER\s+TO\b/i],
  ["ROW LEVEL SECURITY", /\bROW\s+LEVEL\s+SECURITY\b/i],
];

/** Las marcas de `PATRONES_PROHIBIDOS` que aparecen en el SQL (sin comentarios). */
function sentenciasProhibidas(sinComentarios: string): string[] {
  const sinLiterales = sinComentarios.replace(/'(?:[^']|'')*'/g, "''");
  return PATRONES_PROHIBIDOS.filter(([, patron]) => patron.test(sinLiterales)).map(([marca]) => marca);
}

describe("el squash: `001_orabella_schema.sql` es el archivo vivo (squash de la serie)", () => {
  it("001 abre la serie, y cada migración posterior es una decisión explícita y en orden", () => {
    // El patrón de nombre es el de la serie: `0NN_nombre.sql`. 001 es el squash
    // y va primero; después vienen SOLO las migraciones de la lista de arriba.
    //
    // AGREGAR UNA MIGRACIÓN NUEVA EXIGE ACTUALIZAR ESTA PRUEBA. Un `003_*.sql`
    // que aparezca sin entrar en `MIGRACIONES_POSTERIORES` la hace CAER, y que
    // caiga es lo que se quiere: ningún archivo se cuela en silencio. El número
    // es la decisión, no un número que se actualiza solo.
    const porNombre = readdirSync(SQUASH_DIR)
      .filter((nombre) => /^0\d\d_.*\.sql$/.test(nombre))
      .sort();
    expect(porNombre).toEqual([SQUASH_NAME, ...MIGRACIONES_POSTERIORES]);

    // Orden ESTRICTO de los números asignados: no se reutiliza un hueco de una
    // migración retirada; el orden de aplicación sigue siendo el de nombre.
    const numbers = porNombre.map((nombre) => Number(nombre.slice(0, 3)));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((left, right) => left - right));
  });

  it("002 stays narrow, 003 is restricted, and 004 contains only the literal search RPC", () => {
    const sql002 = stripSqlComments(readFileSync(join(SQUASH_DIR, "002_portable_platform.sql"), "utf8"));
    expect(sentenciasProhibidas(sql002), "002_portable_platform.sql").toEqual([]);
    expect(sql002.trim(), "002_portable_platform.sql").toMatch(/^BEGIN;[\s\S]*COMMIT;$/);

    const sql003 = readFileSync(join(SQUASH_DIR, "003_payment_method_arqueo.sql"), "utf8");
    expect(stripSqlComments(sql003).trim(), "003_payment_method_arqueo.sql").toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(unauthorized003(sql003), "003_payment_method_arqueo.sql").toEqual([]);
    // 003's unavoidable privileged operations are only its named objects.
    expect(stripSqlComments(sql003)).toMatch(/CREATE TABLE IF NOT EXISTS public\.cash_shift_method_balances/);
    expect(stripSqlComments(sql003)).toMatch(/ALTER TABLE public\.payment_methods/);
    expect(stripSqlComments(sql003)).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(stripSqlComments(sql003)).not.toMatch(/\bDROP\s+TABLE\b/i);

    const sql004 = readFileSync(join(SQUASH_DIR, "004_inventory_literal_search.sql"), "utf8");
    const body004 = stripSqlComments(sql004);
    expect(body004.trim(), "004_inventory_literal_search.sql").toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(invalid004File(sql004), "004_inventory_literal_search.sql").toEqual([]);
    expect(sqlStatements(sql004).filter((statement) => /^CREATE OR REPLACE FUNCTION/.test(statement))).toHaveLength(1);
    expect(body004).toMatch(/SECURITY INVOKER/);
    expect(body004).toMatch(/SET search_path TO 'public'/);
    expect(body004).not.toMatch(/SECURITY DEFINER|\bEXECUTE\b|format\s*\(/i);
    // LIKE with an explicit ESCAPE, the escape doubled first, then % and _.
    expect(body004.match(/ILIKE v_pattern ESCAPE v_escape/g)).toHaveLength(2);
    expect(body004).toMatch(/replace\(coalesce\(p_query, ''\), v_escape, v_escape \|\| v_escape\)/);
    expect(body004).toMatch(/'%', v_escape \|\| '%'/);
    expect(body004).toMatch(/'_', v_escape \|\| '_'/);
    expect(body004).toMatch(/ORDER BY p\.name ASC, p\.id ASC/);
    expect(body004).toMatch(/least\(greatest\(coalesce\(p_limit, 50\), 1\), 500\)/);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql004).toContain(`REVOKE ALL ON FUNCTION ${SEARCH_004} FROM ${role};`);
    }
    expect(sql004).toContain(`GRANT ALL ON FUNCTION ${SEARCH_004} TO service_role;`);
  });

  it("005 enforces whole-peso guards with fixed search_path, invoker security and closed ACLs", () => {
    const sql005 = readFileSync(join(SQUASH_DIR, "005_cop_whole_peso.sql"), "utf8");
    const body = stripSqlComments(sql005);
    expect(body.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    for (const fn of ["assert_cop_whole_peso", "assert_cop_whole_peso_settings"]) {
      expect(body).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?SECURITY INVOKER[\\s\\S]*?SET search_path TO 'public'`));
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        expect(sql005).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM ${role};`);
      }
      expect(sql005).toContain(`GRANT ALL ON FUNCTION public.${fn}() TO service_role;`);
    }
    expect(body).toContain("COP_WHOLE_PESO_REQUIRED");
    expect(body).toContain("('employees', ARRAY['salary_fixed'])");
    expect(body).toContain("IS NOT DISTINCT FROM");
    expect(body).toContain("CREATE OR REPLACE VIEW public.cop_legacy_cents_audit");
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql005).toContain(`REVOKE ALL ON public.cop_legacy_cents_audit FROM ${role};`);
    }
    expect(sql005).toContain("GRANT SELECT ON public.cop_legacy_cents_audit TO service_role;");
    expect(body).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\s+ON public\.cop_legacy_cents_audit/i);
  });

  it("009 restricts the opening wrapper and its invoker callee to service_role", () => {
    const sql009 = readFileSync(join(SQUASH_DIR, "009_cash_opening_bounds.sql"), "utf8");
    const statements = sqlStatements(sql009);
    expect(stripSqlComments(sql009).trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(statements.find((statement) => /^CREATE OR REPLACE FUNCTION public\.cash_open_shift_atomic\(/.test(statement))).not.toMatch(/SECURITY DEFINER/);
    for (const fn of ["cash_open_shift_atomic", "cash_open_shift_atomic_legacy"]) {
      const signature = `public.${fn}(uuid, uuid, numeric, jsonb)`;
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM ${role}`);
      }
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    }
    expect(statements.filter((statement) => /^GRANT\b/.test(statement))).toHaveLength(2);
  });

  it("010 is one read-only invoker catalog RPC restricted to service_role", () => {
    const sql010 = readFileSync(join(SQUASH_DIR, "010_inventory_catalog_page.sql"), "utf8");
    const body = stripSqlComments(sql010);
    const statements = sqlStatements(sql010);
    const signature = "public.inventory_catalog_page(text, text, integer, integer)";
    expect(body.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(statements.filter((statement) => /^CREATE OR REPLACE FUNCTION/.test(statement))).toHaveLength(1);
    expect(body).toMatch(/SECURITY INVOKER/);
    expect(body).toMatch(/SET search_path TO 'public'/);
    expect(body).not.toMatch(/SECURITY DEFINER|format\s*\(|\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(body.match(/ILIKE v_pattern ESCAPE v_escape/g)).toHaveLength(2);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM ${role}`);
    }
    expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    expect(statements.filter((statement) => /^GRANT\b/.test(statement))).toHaveLength(1);
  });

  it("004's guard inspects the WHOLE function, not only its prefix (mutations of the real file)", () => {
    const real = readFileSync(join(SQUASH_DIR, "004_inventory_literal_search.sql"), "utf8");
    const mutate = (from: string, to: string) => {
      expect(real, `fixture anchor: ${from}`).toContain(from);
      return real.replace(from, to);
    };
    const bodyEnd = "  OFFSET v_offset;\n";
    // Every `bodyInjection` keeps header, signature, SECURITY INVOKER,
    // search_path, predicates, order and clamps intact. It can only fail because
    // the complete-body allowlist sees the extra executable statement.
    const bodyInjection = (label: string, statement: string): [string, string] => [
      label,
      mutate(bodyEnd, `${bodyEnd}  ${statement}\n`),
    ];
    const bodyMutations: Array<[string, string]> = [
      bodyInjection("DELETE in the body", "DELETE FROM public.products;"),
      bodyInjection("UPDATE in the body", "UPDATE public.products SET name = 'x';"),
      bodyInjection("INSERT in the body", "INSERT INTO public.audit_logs (action, entity, entity_id) VALUES ('a', 'b', 'c');"),
      bodyInjection("MERGE in the body", "MERGE INTO public.products p USING public.products q ON false WHEN NOT MATCHED THEN DO NOTHING;"),
      bodyInjection("COPY in the body", "COPY public.products TO '/tmp/x';"),
      bodyInjection("TRUNCATE in the body", "TRUNCATE public.products;"),
      bodyInjection("GRANT in the body", "GRANT ALL ON public.products TO anon;"),
      bodyInjection("DROP in the body", "DROP TABLE public.audit_logs;"),
      bodyInjection("ALTER in the body", "ALTER TABLE public.products ADD COLUMN injected text;"),
      bodyInjection("CREATE TABLE in the body", "CREATE TABLE public.injected (id uuid);"),
      bodyInjection("LOCK TABLE in the body", "LOCK TABLE public.products IN ACCESS EXCLUSIVE MODE;"),
      bodyInjection("CALL in the body", "CALL public.some_procedure();"),
      bodyInjection("PERFORM set_config role in the body", "PERFORM set_config('role', 'postgres', true);"),
      bodyInjection("second RETURN QUERY public.users", "RETURN QUERY SELECT u.id, u.id::text, u.full_name, NULL::text, 0, 0, NULL::numeric, NULL::numeric, NULL::numeric, true FROM public.users u;"),
      bodyInjection("SET ROLE in the body", "SET ROLE postgres;"),
      bodyInjection("SET LOCAL ROLE in the body", "SET LOCAL ROLE service_role;"),
      bodyInjection("dynamic EXECUTE in the body", "EXECUTE 'SELECT 1';"),
      bodyInjection("format() in the body", "PERFORM format('%s', 1);"),
    ];
    for (const [label, sql] of bodyMutations) {
      expect(invalid004Function(sqlStatements(sql).find((statement) => /^CREATE OR REPLACE FUNCTION/.test(statement)) ?? ""), label).toContain("non-canonical read-only function body");
    }
    const mutations: Array<[string, string]> = [
      ...bodyMutations,
      ["SECURITY DEFINER in the CREATE", mutate("SECURITY INVOKER", "SECURITY DEFINER")],
      ["SECURITY INVOKER removed", mutate("SECURITY INVOKER\n", "")],
      ["search_path widened", mutate("SET search_path TO 'public'", "SET search_path TO 'public', 'pg_temp'")],
      ["predicate changed", mutate("OR p.sku ILIKE v_pattern ESCAPE v_escape", "OR true")],
      ["limit clamp removed", mutate("least(greatest(coalesce(p_limit, 50), 1), 500)", "p_limit")],
      ["escape order changed", mutate("v_escape, v_escape || v_escape", "v_escape, v_escape")],
      ["an extra column in RETURNS TABLE", mutate("  is_active boolean\n)", "  is_active boolean,\n  password_hash text\n)")],
      ["a second, alternative function", mutate("REVOKE ALL ON FUNCTION", "CREATE OR REPLACE FUNCTION public.search_products_any(p text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE ALL ON FUNCTION")],
      ["another function name with the same body", mutate("FUNCTION public.search_products_literal(\n", "FUNCTION public.search_products_other(\n")],
      ["the REVOKE removed", mutate("REVOKE ALL ON FUNCTION public.search_products_literal(text, integer, integer) FROM PUBLIC;\n", "")],
      ["the GRANT duplicated", mutate("TO service_role;\n", "TO service_role;\nGRANT ALL ON FUNCTION public.search_products_literal(text, integer, integer) TO service_role;\n")],
      ["the CREATE removed", real.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;\n/, "")],
    ];
    for (const [label, sql] of mutations) {
      expect(invalid004File(sql), label).not.toEqual([]);
    }
    // Positive control: the real file passes, and harmless formatting does too.
    expect(invalid004File(real)).toEqual([]);
    expect(invalid004File(real.replace(/\n {2}/g, "\n    ").replace(/-- Escape[^\n]*\n/, ""))).toEqual([]);
  });

  it("004's allowlist rejects any other object, grant or DDL (negative fixtures)", () => {
    const wrap = (statement: string) => `BEGIN;\n${statement}\nCOMMIT;`;
    const unauthorized = [
      "CREATE OR REPLACE FUNCTION public.search_products(p_query text) RETURNS SETOF public.products LANGUAGE sql AS $$ SELECT * FROM public.products $$;",
      "CREATE OR REPLACE FUNCTION public.search_products_literal(p_query text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
      "CREATE OR REPLACE FUNCTION public.search_products_literal( p_query text, p_limit integer, p_offset integer DEFAULT 0 ) RETURNS TABLE (id uuid) LANGUAGE plpgsql AS $$ BEGIN DROP TABLE public.products; END; $$;",
      "CREATE OR REPLACE FUNCTION public.search_products_literal( p_query text, p_limit integer, p_offset integer DEFAULT 0 ) RETURNS TABLE (id uuid) LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT ' || p_query; END; $$;",
      "CREATE OR REPLACE FUNCTION public.search_products_literal( p_query text, p_limit integer, p_offset integer DEFAULT 0 ) RETURNS TABLE (id uuid) LANGUAGE plpgsql AS $$ BEGIN GRANT ALL ON public.products TO anon; END; $$;",
      `GRANT ALL ON FUNCTION ${SEARCH_004} TO anon;`,
      `GRANT ALL ON FUNCTION ${SEARCH_004} TO authenticated;`,
      `GRANT ALL ON FUNCTION ${SEARCH_004} TO PUBLIC;`,
      `REVOKE ALL ON FUNCTION ${SEARCH_004} FROM service_role;`,
      "GRANT SELECT ON public.products TO anon;",
      "REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM service_role;",
      `ALTER FUNCTION ${SEARCH_004} SECURITY DEFINER;`,
      `ALTER FUNCTION ${SEARCH_004} OWNER TO anon;`,
      `DROP FUNCTION ${SEARCH_004};`,
      "CREATE INDEX idx_products_name_trgm ON public.products (name);",
      "CREATE TABLE public.search_cache (id uuid);",
      "ALTER TABLE public.products ADD COLUMN search text;",
      "CREATE POLICY p ON public.products USING (true);",
      "CREATE TRIGGER trg_x BEFORE INSERT ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
      "COMMENT ON TABLE public.products IS 'x';",
      "DO $$ BEGIN DROP TABLE public.products; END; $$;",
      "UPDATE public.products SET name = 'x';",
      "DELETE FROM public.products;",
    ];
    // The exact signature prefix the OLD rule accepted, followed by a harmful
    // body or clause. Every one of these passed the prefix-only allowlist.
    const prefix =
      "CREATE OR REPLACE FUNCTION public.search_products_literal( p_query text, p_limit integer, p_offset integer DEFAULT 0 ) RETURNS TABLE ( id uuid, sku text, name text, description text, stock_qty integer, min_stock integer, cost_price numeric, sale_price numeric, commission_value numeric, is_active boolean )";
    const invoker = "LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'";
    unauthorized.push(
      `${prefix} ${invoker} AS $$ BEGIN DELETE FROM public.products; END; $$;`,
      `${prefix} ${invoker} AS $$ BEGIN UPDATE public.products SET name = 'x'; END; $$;`,
      `${prefix} ${invoker} AS $$ BEGIN INSERT INTO public.products (sku, name) VALUES ('x', 'y'); END; $$;`,
      `${prefix} ${invoker} AS $$ BEGIN SET ROLE postgres; END; $$;`,
      `${prefix} LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN; END; $$;`,
      `${prefix} ${invoker} AS $$ BEGIN RETURN QUERY EXECUTE format('SELECT * FROM %I', p_query); END; $$;`,
    );
    for (const statement of unauthorized) {
      expect(unauthorized004(wrap(statement)), statement).not.toEqual([]);
    }
    // The old prefix-only rule really accepted those harmful statements.
    const prefixOnly = /^CREATE OR REPLACE FUNCTION public\.search_products_literal\( p_query text, p_limit integer, p_offset integer DEFAULT 0 \) RETURNS TABLE \(/;
    expect(unauthorized.slice(-6).every((statement) => prefixOnly.test(sqlStatements(wrap(statement))[1]))).toBe(true);
    for (const statement of [
      `REVOKE ALL ON FUNCTION ${SEARCH_004} FROM PUBLIC;`,
      `REVOKE ALL ON FUNCTION ${SEARCH_004} FROM anon;`,
      `REVOKE ALL ON FUNCTION ${SEARCH_004} FROM authenticated;`,
      `GRANT ALL ON FUNCTION ${SEARCH_004} TO service_role;`,
      `COMMENT ON FUNCTION ${SEARCH_004} IS 'x';`,
    ]) {
      expect(unauthorized004(wrap(statement)), statement).toEqual([]);
    }
  });

  it("003's allowlist rejects anything outside its named objects and actions (negative fixtures)", () => {
    const wrap = (statement: string) => `BEGIN;\n${statement}\nCOMMIT;`;
    const unauthorized: string[] = [
      // Other actions on the authorized table.
      "ALTER TABLE public.payment_methods DROP COLUMN fee_percent;",
      "ALTER TABLE public.payment_methods DROP CONSTRAINT payment_methods_code_key;",
      "ALTER TABLE public.payment_methods DISABLE ROW LEVEL SECURITY;",
      "ALTER TABLE public.payment_methods OWNER TO anon;",
      // Any other table.
      "ALTER TABLE public.users ADD COLUMN x int;",
      "CREATE TABLE public.otra (id uuid PRIMARY KEY);",
      "CREATE TABLE IF NOT EXISTS public.cash_shift_method_balances_v2 (id uuid);",
      "ALTER TABLE public.cash_shift_method_balances DISABLE ROW LEVEL SECURITY;",
      // Grants beyond the two RPCs to service_role.
      "GRANT ALL ON FUNCTION public.cash_shift_method_expected_balance(uuid, text) TO anon;",
      "GRANT ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) TO service_role;",
      "GRANT SELECT ON public.cash_shift_method_balances TO authenticated;",
      // Drops.
      "DROP TABLE public.cash_shift_method_balances;",
      "DROP FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb);",
      "DROP TRIGGER IF EXISTS trg_commission_payouts_cap ON public.commission_payouts;",
      "DROP POLICY pol_roles_readonly ON public.roles;",
      // Policies and foreign functions/triggers.
      "CREATE POLICY p ON public.cash_shift_method_balances USING (true);",
      "CREATE OR REPLACE FUNCTION public.current_sede_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;",
      "CREATE TRIGGER trg_x BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
      // DDL hidden inside an authorized function body executes too.
      "CREATE OR REPLACE FUNCTION public.enforce_cash_method_minimum(p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'x'; DROP TABLE public.users; END; $$;",
      // An anonymous block other than the single authorized rename.
      "DO $$ BEGIN DROP TABLE public.users; END; $$;",
      // The collection/voucher guards: only their exact table, events and function.
      "CREATE TRIGGER trg_payments_balance_guard BEFORE DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();",
      "CREATE TRIGGER trg_invoice_payments_balance_guard BEFORE UPDATE OF amount ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();",
      "CREATE TRIGGER trg_voucher_requests_cash_out_state BEFORE UPDATE ON public.voucher_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
      "DROP TRIGGER IF EXISTS trg_invoice_payments_cap ON public.invoice_payments;",
      "GRANT ALL ON FUNCTION public.voucher_is_cash_out(text, uuid, text, uuid) TO service_role;",
      "GRANT ALL ON FUNCTION public.enforce_collection_move_minimum() TO anon;",
      "ALTER TABLE public.invoice_payments DISABLE TRIGGER trg_invoice_payments_balance_guard;",
      "ALTER TABLE public.payments DISABLE TRIGGER trg_payments_balance_guard;",
      "CREATE TRIGGER trg_payments_balance_guard BEFORE UPDATE OF amount ON public.payments FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();",
      "CREATE TRIGGER trg_invoice_payments_balance_guard BEFORE UPDATE OF amount, cash_shift_id ON public.invoice_payments FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();",
      // The edit-RPC versioning: only these two renames, no other 001 RPC, no wider grants.
      "DO $$ BEGIN IF to_regprocedure('public.invoice_annul_atomic_legacy(uuid,uuid,integer,text,jsonb)') IS NULL THEN ALTER FUNCTION public.invoice_annul_atomic(uuid, uuid, integer, text, jsonb) RENAME TO invoice_annul_atomic_legacy; END IF; END; $$;",
      "DO $$ BEGIN IF to_regprocedure('public.invoice_edit_items_atomic_legacy(uuid,uuid,integer,text,jsonb)') IS NULL THEN ALTER FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) RENAME TO invoice_edit_items_atomic_legacy; END IF; END; $$;",
      "CREATE OR REPLACE FUNCTION public.invoice_annul_atomic(p uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;",
      "GRANT ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) TO anon;",
      "GRANT ALL ON FUNCTION public.invoice_edit_items_atomic_legacy(uuid, uuid, integer, text, jsonb) TO authenticated;",
      "GRANT ALL ON FUNCTION public.lock_invoice_edit_payment_balances(uuid, jsonb) TO PUBLIC;",
      "ALTER FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) SECURITY DEFINER;",
      // Data changes outside the backfill.
      "UPDATE public.payment_methods SET arqueo_mode = 'none';",
      "DELETE FROM public.payment_methods;",
    ];
    for (const statement of unauthorized) {
      expect(unauthorized003(wrap(statement)), statement).toHaveLength(1);
    }
    // Positive control: authorized statements pass, so the empty list above is meaningful.
    for (const statement of [
      "ALTER TABLE public.payment_methods ADD COLUMN IF NOT EXISTS arqueo_mode text;",
      "GRANT ALL ON FUNCTION public.cash_shift_method_expected_balance(uuid, text) TO service_role;",
      "DROP TRIGGER IF EXISTS trg_voucher_requests_balance_guard ON public.voucher_requests;",
    ]) {
      expect(unauthorized003(wrap(statement)), statement).toEqual([]);
    }
  });

  it("001-005 are not modified by this change (byte-identical to the integration base)", () => {
    for (const [name, sha] of [
      ["001_orabella_schema.sql", BASE_SHA_001],
      ["002_portable_platform.sql", BASE_SHA_002],
      ["003_payment_method_arqueo.sql", BASE_SHA_003],
    ] as const) {
      const text = readFileSync(join(SQUASH_DIR, name));
      // Git's blob hash is "blob <byteLength>\\0" followed by the bytes.
      const actual = createHash("sha1").update(`blob ${text.length}\0`).update(text).digest("hex");
      expect(actual, name).toBe(sha);
    }
    for (const [name, sha] of [
      ["004_inventory_literal_search.sql", BASE_SHA256_004],
      ["005_cop_whole_peso.sql", BASE_SHA256_005],
    ] as const) {
      const actual = createHash("sha256").update(readFileSync(join(SQUASH_DIR, name))).digest("hex");
      expect(actual, name).toBe(sha);
    }
  });

  it("el detector de sentencias prohibidas CAZA cada patrón (control negativo)", () => {
    // Si una de estas líneas pasa sin marca, la guarda de arriba no protege nada.
    const casos: Array<[string, string]> = [
      ["CREATE TABLE public.x (id int);", "CREATE TABLE"],
      ["CREATE UNLOGGED TABLE public.x (id int);", "CREATE UNLOGGED TABLE"],
      ["create temp table x (id int);", "CREATE TABLE"],
      ["CREATE POLICY p ON public.users USING (true);", "CREATE POLICY"],
      ["ALTER POLICY pol_users_sede_isolation ON public.users TO PUBLIC;", "ALTER POLICY"],
      ["GRANT ALL ON public.users TO anon;", "GRANT/REVOKE"],
      ["BEGIN; REVOKE ALL ON FUNCTION public.current_sede_id() FROM service_role;", "GRANT/REVOKE"],
      ["DROP POLICY pol_roles_readonly ON public.roles;", "DROP"],
      ["DROP FUNCTION IF EXISTS public.current_sede_id();", "DROP"],
      ["ALTER TABLE public.users ADD COLUMN x int;", "ALTER TABLE"],
      ["ALTER FUNCTION public.current_sede_id() OWNER TO anon;", "OWNER TO"],
      ["ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;", "ROW LEVEL SECURITY"],
      ["ALTER TABLE ONLY public.users NO FORCE ROW LEVEL SECURITY;", "ROW LEVEL SECURITY"],
    ];
    for (const [fragmento, marca] of casos) {
      expect(sentenciasProhibidas(stripSqlComments(fragmento)), fragmento).toContain(marca);
    }
    // Y no es de goma: la prosa entre comillas y los comentarios no cuentan.
    expect(sentenciasProhibidas(stripSqlComments("-- DROP TABLE x\nCOMMENT ON FUNCTION f() IS 'no hace DROP ni GRANT';"))).toEqual([]);
  });

  it("002 deja `current_sede_id()` sin `auth.jwt()` y con los mismos atributos que 001", () => {
    const sql = stripSqlComments(readFileSync(join(SQUASH_DIR, "002_portable_platform.sql"), "utf8")).replace(
      /^COMMENT ON[^\n]*$/gm,
      "",
    );
    // Sin dependencia del esquema `auth` en SQL ejecutable (la prosa de `COMMENT ON` no cuenta).
    expect(sql).not.toMatch(/\bauth\s*\./);
    // Lee lo mismo que `auth.jwt()` de Supabase.
    expect(sql).toContain("current_setting('request.jwt.claims', true)");
    expect(sql).toContain("current_setting('request.jwt.claim', true)");
    // Misma cabecera que 001: firma, lenguaje, volatilidad, definer y search_path.
    const cabecera = /CREATE FUNCTION public\.current_sede_id\(\) RETURNS uuid\s+LANGUAGE sql STABLE SECURITY DEFINER\s+SET search_path TO 'public'/;
    expect(squashSchemaSql()).toMatch(cabecera);
    expect(sql.replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION")).toMatch(cabecera);
  });

  it("el archivo declara las 36 tablas y las 10 políticas de la serie, sin prosa de más", () => {
    // Los conteos son de DECLARACIONES sobre el SQL sin comentarios ni
    // `COMMENT ON`: 36 `CREATE TABLE public.` y 10 `CREATE POLICY`. Salen del
    // volcado, no de una lista escrita a mano, y son los números que el guardián
    // de RLS de arriba ya conoce sobre la serie: si el squash dejara de declarar
    // una tabla, esta prueba se cuelga antes de que nadie mire el archivo.
    const sql = squashSchemaSql();
    expect(sql.match(/CREATE TABLE public\./g)).toHaveLength(36);
    expect(sql.match(/\bCREATE POLICY\b/g)).toHaveLength(10);
  });

  it("`sede_id` es columna sólo de `public.users`", () => {
    // 077 quitó la columna de sede de todas las tablas menos `users`, que la
    // conserva como el anclaje de la cuenta a la instalación de una sola sede.
    // La derivación es por contenido —cada `CREATE TABLE` y sus líneas— para que
    // la lista siga siendo la que el archivo declara y no la que alguien
    // recuerda. Una tabla con la columna de vuelta aparece sola en el fallo.
    expect(tablasConColumnaSede(squashSchemaSql())).toEqual(["public.users"]);
  });

  it("`payroll_apply_atomic` se declara una sola vez, y con los cuatro argumentos de la serie", () => {
    // Una segunda declaración del mismo nombre con otra firma es la forma
    // silenciosa de romper el `POST /rest/v1/rpc/payroll_apply_atomic`: el
    // cliente manda cuatro argumentos y la base cobra la otra. Se cuentan las
    // DECLARACIONES (`CREATE FUNCTION`), no las menciones: el `COMMENT ON`, el
    // `REVOKE` y el `GRANT` nombran la función sin declararla, y están fuera
    // del conteo a propósito.
    const declaraciones = [
      ...squashSchemaSql().matchAll(/CREATE FUNCTION public\.payroll_apply_atomic\s*\(([^)]*)\)/g),
    ];
    expect(declaraciones).toHaveLength(1);
    // Los cuatro, en orden. El cuarto lleva su `DEFAULT`: es el que hace que el
    // cliente pueda mandar tres y que la 047 siga siendo la que se aplica.
    expect(declaraciones[0][1].split(",").map((argumento) => argumento.trim())).toEqual([
      "p_period_id uuid",
      "p_items jsonb",
      "p_voucher_ids uuid[]",
      "p_carry_ids uuid[] DEFAULT '{}'::uuid[]",
    ]);
  });

  it("`next_invoice_number` se declara sin argumentos", () => {
    // 072 lo dejó sin parámetros porque la fila del contador es la clave
    // `invoice_sequence` de `system_settings`: no hay de qué elegir. Un
    // `p_sede_id uuid` de vuelta aquí haría que la llamada sin argumentos
    // fallara contra la base, así que la firma se mira con su lista de
    // argumentos VACÍA y no por coincidencia de texto.
    const declaraciones = [
      ...squashSchemaSql().matchAll(
        /CREATE FUNCTION public\.next_invoice_number\s*\(([^)]*)\)\s*RETURNS\s+(\w+)/g,
      ),
    ];
    expect(declaraciones).toHaveLength(1);
    expect(declaraciones[0][1].trim()).toBe("");
    expect(declaraciones[0][2]).toBe("integer");
  });

  it("no queda ninguna referencia a `employees.sede_id` fuera de comentarios", () => {
    // La columna no existe desde 077: `upsert_employee_atomic` no la escribe ni
    // la exige. Cualquier `employees.sede_id` que sobreviva en el SQL —una
    // condición, un `INSERT`, un índice— es código roto contra el catálogo, y
    // el error sólo aparece en producción, cuando alguien guarda un empleado.
    expect(squashSchemaSql()).not.toMatch(/employees\s*\.\s*sede_id/);

    // CONTROL del guardián: el texto SÍ está en el archivo, dos veces, y las dos
    // en prosa —una línea `--` y un `COMMENT ON`. Sin esta prueba, la de arriba
    // podría estar en verde porque el objeto se renombró o porque el filtro
    // borró el archivo entero; en verde tiene que significar UNA cosa: la
    // referencia es solo comentario.
    const menciones = SQUASH_SQL.match(/employees\.sede_id/g) ?? [];
    expect(menciones).toHaveLength(2);
    for (const linea of SQUASH_SQL.split("\n").filter((una) => una.includes("employees.sede_id"))) {
      const esComentario = linea.trimStart().startsWith("--") || linea.startsWith("COMMENT ON");
      expect(esComentario, linea.slice(0, 60)).toBe(true);
    }
  });
});
