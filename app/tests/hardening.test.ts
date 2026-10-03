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

describe("el squash: `001_orabella_schema.sql` es el archivo vivo (squash de la serie)", () => {
  it("es el ÚNICO archivo de migración que queda, y el directorio no tiene un segundo", () => {
    // El patrón de nombre es el de la serie: `0NN_nombre.sql`. Con el squash
    // aplicado tiene que quedar UNO, y ese es el que se aplica a una base nueva.
    //
    // AGREGAR UNA MIGRACIÓN NUEVA EXIGE ACTUALIZAR ESTA PRUEBA. Si algún día
    // aparece un `002_lo_que_sea.sql` en `supabase/migrations`, esta cuenta va a
    // decir 2 y va a CAER, y que caiga es lo que se quiere: la serie ya no es
    // un archivo y hay que decidir a mano qué se hace con ella —volver a
    // aplastar en el archivo único, o dejar de leer el historial y apuntar los
    // guardiánes de arriba al squash—, no dejar que un segundo archivo se cuele
    // en silencio. El número es la decisión, no un número que se actualiza solo.
    const porNombre = readdirSync(SQUASH_DIR)
      .filter((nombre) => /^0\d\d_.*\.sql$/.test(nombre))
      .sort();
    expect(porNombre).toEqual([SQUASH_NAME]);
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
