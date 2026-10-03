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
  return readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8");
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
   el conjunto de tablas leyendo los `CREATE TABLE` de `supabase/migrations` y
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

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * TODOS los `.sql` del directorio, sin filtro de prefijo (ver punto 2 de la
 * cabecera). Hoy son los 75 de la serie más la 076; el día que la serie se
 * aplane en un único `001_orabella_schema.sql` seguirá siendo un archivo, y el
 * guardián ni se entera.
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
