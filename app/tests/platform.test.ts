import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/src/features/auth/service";
import {
  listPlatformSedesAction,
  setPlatformPayrollStartDateAction,
} from "@/src/features/platform/actions";
import {
  listPlatformSedes,
  requirePlatformAdmin,
  setPlatformPayrollStartDate,
} from "@/src/features/platform/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";

/* --------------------------------------------------------------------------
   G3a — superficie de plataforma y lista cross-sede de sedes.

   Dos bloques, con el mismo método de casa que los demás módulos:

   1. COMPORTAMIENTO — la lectura real, con la sesión y PostgREST simulados
      (`vi.mock` de `getSessionUser` y de `createAdminClient`). Sin red, sin
      Supabase. Fija lo que la unidad promete: la lectura NO está acotada a la
      sede del actor, marca la sede del sistema, y la guarda rechaza a todo el
      que no tenga el rol ANTES de leer una sola fila.
   2. ESTRUCTURA — los archivos reales se leen del disco (mismo patrón que
      `tests/action-guards.test.ts`), con control negativo por predicado: una
      guarda citada en un comentario, un nav sin el rol o un `resolveSede` en la
      lectura se reportan. Sin esto, los tres contratos serían decorativos.
   -------------------------------------------------------------------------- */

const SEDE_PLATAFORMA = "00000000-0000-4000-8000-000000000001";
const SEDE_CENTRO = "11111111-1111-4111-8111-111111111111";
const SEDE_NORTE = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------- dobles ---

const sessionStub = vi.hoisted(() => ({ current: null as null | SessionUser }));

const dbStub = vi.hoisted(() => ({
  sedes: [] as Array<Record<string, unknown>>,
  /** Lecturas reales contra `sedes`: 0 prueba que la guarda rechazó antes. */
  reads: 0,
  /** Escrituras reales contra `sedes`: 0 prueba que el rechazo no escribió. */
  writes: 0,
  /** Simula 068 sin aplicar: `select` con la columna falla con 42703. */
  sinColumnaNomina: false,
  /** Fallo genérico de la base (no es columna faltante). */
  fail: false,
}));

/** Entradas de auditoría capturadas: la unidad prueba lo que la fecha deja. */
const auditStub = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "token-de-prueba" }) }),
}));

vi.mock("@/src/features/auth/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/auth/service")>();
  return { ...actual, getSessionUser: async () => sessionStub.current };
});

/**
 * La auditoría se observa desde acá. `writeAudit` nunca lanza, así que su doble
 * solo captura la entrada y confirma la escritura; el resto del módulo
 * (`AUDIT_ACTIONS`) queda intacto para que la acción declarada sea la real.
 */
vi.mock("@/src/shared/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/shared/lib/audit")>();
  return {
    ...actual,
    writeAudit: async (entry: Record<string, unknown>) => {
      auditStub.entries.push(entry);
      return { written: true };
    },
  };
});

/**
 * Doble mínimo de PostgREST: la lectura encadena `select().order().order()` y
 * resuelve contra las filas sembradas; la escritura encadena
 * `update().eq().select().maybeSingle()` y muta la fila sembrada. Modela lo
 * único que importa acá:
 *   * `reads`/`writes` cuentan accesos reales (la guarda no debe producir uno).
 *   * `order` ordena como lo pide el servicio y `select` proyecta las columnas
 *     pedidas: la relectura sin la 068 no puede devolver la fecha que no pidió.
 *   * `eq("id", …)` acota a la sede pedida y `maybeSingle` responde esa fila (o
 *     `null`): la escritura nunca puede alcanzar una sede distinta de la elegida.
 *   * `sinColumnaNomina` reproduce el 42703 de la 068 sin aplicar, que la
 *     lectura degrada a «sin configurar» releyendo sin la columna y que la
 *     escritura traduce a un mensaje accionable.
 */
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => {
    const from = (table: string) => {
      let columnas: string[] = [];
      const ordenes: string[] = [];
      let filtroId: string | null = null;
      let escrito: Record<string, unknown> | null = null;

      const tieneColumnaNomina = () => columnas.includes("payroll_start_date");
      const errorColumna = () => ({
        code: "42703",
        message: "column sedes.payroll_start_date does not exist",
      });
      // PostgREST PROYECTA las columnas del `select`: la relectura sin la 068 no
      // puede traer la fecha que no pidió.
      const proyectar = (filas: Array<Record<string, unknown>>) =>
        columnas.length === 0
          ? filas
          : filas.map((fila) =>
              Object.fromEntries(columnas.map((columna) => [columna, fila[columna]])),
            );

      const filaObjetivo = () => dbStub.sedes.find((fila) => fila.id === filtroId) ?? null;

      const resultadoLista = (): { data: unknown; error: unknown } => {
        if (table !== "sedes") return { data: [], error: null };
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };
        if (tieneColumnaNomina() && dbStub.sinColumnaNomina) return { data: null, error: errorColumna() };
        const ordenadas = [...dbStub.sedes].sort((a, b) => {
          for (const columna of ordenes) {
            const izq = String(a[columna] ?? "");
            const der = String(b[columna] ?? "");
            if (izq !== der) return izq < der ? -1 : 1;
          }
          return 0;
        });
        return { data: proyectar(ordenadas), error: null };
      };

      const resultadoFila = (): { data: unknown; error: unknown } => {
        if (table !== "sedes") return { data: null, error: null };
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };
        if (tieneColumnaNomina() && dbStub.sinColumnaNomina) return { data: null, error: errorColumna() };
        const fila = filaObjetivo();
        if (fila === null) return { data: null, error: null };
        // La escritura se APLICA al resolver: `eq("id", …)` es lo único que la
        // acota, igual que en PostgREST.
        if (escrito !== null) Object.assign(fila, escrito);
        return { data: proyectar([fila])[0], error: null };
      };

      const query: Record<string, unknown> = {
        select: (columns: string) => {
          columnas = columns.split(",").map((columna) => columna.trim());
          return query;
        },
        order: (columna: string) => {
          ordenes.push(columna);
          return query;
        },
        update: (payload: Record<string, unknown>) => {
          escrito = payload;
          if (table === "sedes") dbStub.writes += 1;
          return query;
        },
        eq: (columna: string, valor: string) => {
          if (columna === "id") filtroId = valor;
          return query;
        },
        maybeSingle: () => Promise.resolve(resultadoFila()),
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(resultadoLista()).then(onFulfilled, onRejected),
      };
      return query;
    };
    return { from };
  },
}));

/** Sesión simulada: la cuenta de plataforma anclada a la sede del sistema (G2). */
function asSession(roles: string[]): void {
  sessionStub.current = {
    user: { id: "u-plataforma", sede_id: SEDE_PLATAFORMA },
    roles,
  } as unknown as SessionUser;
}

/** Tres sedes: dos del negocio y la del sistema, sembradas en desorden. */
function sembrarSedes(): void {
  dbStub.sedes = [
    { id: SEDE_CENTRO, name: "Centro", is_active: true, payroll_start_date: "2026-01-01" },
    {
      id: SEDE_PLATAFORMA,
      name: "Plataforma (sistema)",
      is_active: false,
      payroll_start_date: null,
    },
    { id: SEDE_NORTE, name: "Norte", is_active: true, payroll_start_date: null },
  ];
}

beforeEach(() => {
  dbStub.sedes = [];
  dbStub.reads = 0;
  dbStub.writes = 0;
  dbStub.sinColumnaNomina = false;
  dbStub.fail = false;
  sessionStub.current = null;
  auditStub.entries = [];
});

// -------------------------------------------------------------- lectura ---

describe("plataforma: la lista cross-sede (G3a)", () => {
  it("devuelve TODAS las sedes, no solo la del actor", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Orden determinista por nombre; el actor no acota el resultado.
    expect(result.data.map((sede) => sede.id)).toEqual([SEDE_CENTRO, SEDE_NORTE, SEDE_PLATAFORMA]);
    expect(result.data.filter((sede) => sede.id !== SEDE_PLATAFORMA)).toHaveLength(2);
    expect(dbStub.reads).toBe(1);
  });

  it("marca la sede del sistema y no la presenta como sede del negocio", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();
    if (!result.success) throw new Error("la lista debería estar disponible");

    const dePlataforma = result.data.filter((sede) => sede.is_platform);
    expect(dePlataforma).toHaveLength(1);
    expect(dePlataforma[0].id).toBe(SEDE_PLATAFORMA);
    expect(dePlataforma[0].is_active).toBe(false);

    // Las dos sedes del negocio NO quedan marcadas como del sistema.
    const negocio = result.data.filter((sede) => !sede.is_platform);
    expect(negocio.map((sede) => sede.id)).toEqual([SEDE_CENTRO, SEDE_NORTE]);
  });

  it("la sede del sistema se reconoce por su anclaje, no por su nombre", async () => {
    // Si el dueño renombrara la fila, la marca NO puede depender del texto: la
    // cuenta de plataforma está anclada a ella (G2) y eso es lo que la identifica.
    dbStub.sedes = [
      { id: SEDE_PLATAFORMA, name: "Nombre distinto", is_active: false, payroll_start_date: null },
      { id: SEDE_CENTRO, name: "Centro", is_active: true, payroll_start_date: null },
    ];
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();
    if (!result.success) throw new Error("la lista debería estar disponible");

    expect(result.data.filter((sede) => sede.is_platform).map((sede) => sede.id)).toEqual([
      SEDE_PLATAFORMA,
    ]);
  });

  it("la fecha de nómina viaja tal cual y `null` es «sin configurar»", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();
    if (!result.success) throw new Error("la lista debería estar disponible");

    const porId = new Map(result.data.map((sede) => [sede.id, sede]));
    expect(porId.get(SEDE_CENTRO)?.payroll_start_date).toBe("2026-01-01");
    expect(porId.get(SEDE_NORTE)?.payroll_start_date).toBeNull();
    expect(porId.get(SEDE_PLATAFORMA)?.payroll_start_date).toBeNull();
  });

  it("sin la columna 068 (42703), todas las sedes quedan «sin configurar»", async () => {
    sembrarSedes();
    dbStub.sinColumnaNomina = true;
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();
    if (!result.success) throw new Error("la lista debería estar disponible");

    expect(result.data.map((sede) => sede.payroll_start_date)).toEqual([null, null, null]);
    // Intento con la columna + relectura sin ella: la degradación es explícita.
    expect(dbStub.reads).toBe(2);
  });

  it("un fallo real de la base no se convierte en una lista vacía", async () => {
    sembrarSedes();
    dbStub.fail = true;
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();

    expect(result).toMatchObject({ success: false, code: "INTERNAL" });
  });
});

// --------------------------------------------------------------- guarda ---

describe("plataforma: la guarda (G3a)", () => {
  it("una sesión sin el rol recibe FORBIDDEN y NINGUNA sede", async () => {
    sembrarSedes();
    asSession(["admin"]);

    const result = await listPlatformSedesAction();

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    // Sin `data`: ni una fila, ni siquiera vacía.
    expect(result).not.toHaveProperty("data");
    // Y la base no se tocó: la guarda rechaza antes de leer.
    expect(dbStub.reads).toBe(0);
  });

  it("la guarda responde FORBIDDEN con estado 403", async () => {
    asSession(["admin"]);

    await expect(requirePlatformAdmin("token-de-prueba")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("la lectura misma rechaza un actor sin el rol (no depende del llamador)", async () => {
    sembrarSedes();

    await expect(
      listPlatformSedes({ userId: "u", sedeId: SEDE_PLATAFORMA, roles: ["admin"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dbStub.reads).toBe(0);
  });

  it("control positivo: `superadmin` recibe la lista completa", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await listPlatformSedesAction();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(3);
  });
});

// -------------------------------------------------------------- escritura ---

describe("plataforma: la escritura de la fecha de nómina (G3b)", () => {
  const NUEVA = "2026-10-05";

  it("configura la fecha de la sede ELEGIDA y deja intactas las demás", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_NORTE,
      payroll_start_date: NUEVA,
    });

    expect(result).toEqual({
      success: true,
      data: { sede_id: SEDE_NORTE, payroll_start_date: NUEVA },
    });
    // Solo la sede elegida cambia: la del actor y la otra sede quedan igual.
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_NORTE)?.payroll_start_date).toBe(NUEVA);
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_CENTRO)?.payroll_start_date).toBe(
      "2026-01-01",
    );
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_PLATAFORMA)?.payroll_start_date).toBeNull();
    expect(dbStub.writes).toBe(1);
  });

  it("deja la auditoría con el actor, la sede objetivo y los DOS valores", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    await setPlatformPayrollStartDateAction({ sede_id: SEDE_NORTE, payroll_start_date: NUEVA });

    // El vocabulario cerrado: la acción se lee como configuración de plataforma.
    expect(AUDIT_ACTIONS.PLATFORM_PAYROLL_START_DATE_SET).toBe("platform.payroll_start_date_set");
    expect(auditStub.entries).toHaveLength(1);
    expect(auditStub.entries[0]).toMatchObject({
      sede_id: SEDE_NORTE,
      user_id: "u-plataforma",
      action: "platform.payroll_start_date_set",
      entity: "sedes",
      entity_id: SEDE_NORTE,
      metadata: {
        previous_payroll_start_date: null,
        new_payroll_start_date: NUEVA,
      },
    });
  });

  it("el valor ANTERIOR es el de la sede objetivo, no el de la sede del actor", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    await setPlatformPayrollStartDateAction({ sede_id: SEDE_CENTRO, payroll_start_date: NUEVA });

    expect(auditStub.entries[0]?.metadata).toEqual({
      previous_payroll_start_date: "2026-01-01",
      new_payroll_start_date: NUEVA,
    });
  });

  it("limpiarla con null vuelve a «sin configurar» y audita el anterior y el null", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_CENTRO,
      payroll_start_date: null,
    });

    expect(result).toEqual({
      success: true,
      data: { sede_id: SEDE_CENTRO, payroll_start_date: null },
    });
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_CENTRO)?.payroll_start_date).toBeNull();
    expect(auditStub.entries[0]?.metadata).toEqual({
      previous_payroll_start_date: "2026-01-01",
      new_payroll_start_date: null,
    });
  });

  it("una fecha con otra forma no escribe y no audita", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_NORTE,
      payroll_start_date: "05/10/2026",
    });

    expect(result).toMatchObject({ success: false, code: "VALIDATION" });
    expect(dbStub.writes).toBe(0);
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_NORTE)?.payroll_start_date).toBeNull();
    expect(auditStub.entries).toHaveLength(0);
  });

  it("sin la migración 068 responde un mensaje accionable y no escribe", async () => {
    sembrarSedes();
    dbStub.sinColumnaNomina = true;
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_NORTE,
      payroll_start_date: NUEVA,
    });

    expect(result).toMatchObject({ success: false, code: "VALIDATION" });
    if (result.success) return;
    expect(result.message).toContain("068");
    expect(dbStub.writes).toBe(0);
  });

  it("una sede que no existe no se escribe ni se audita", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: "99999999-9999-4999-8999-999999999999",
      payroll_start_date: NUEVA,
    });

    expect(result).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(dbStub.writes).toBe(0);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("un admin de sede NO puede cambiarla: FORBIDDEN y NADA escrito", async () => {
    sembrarSedes();
    asSession(["admin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_CENTRO,
      payroll_start_date: NUEVA,
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(result).not.toHaveProperty("data");
    // El rechazo es ANTES de tocar la base: ni lectura, ni escritura.
    expect(dbStub.reads).toBe(0);
    expect(dbStub.writes).toBe(0);
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_CENTRO)?.payroll_start_date).toBe(
      "2026-01-01",
    );
    expect(auditStub.entries).toHaveLength(0);
  });

  it("la escritura misma re-aplica el rol (no depende del llamador)", async () => {
    sembrarSedes();

    await expect(
      setPlatformPayrollStartDate(
        { sede_id: SEDE_NORTE, payroll_start_date: NUEVA },
        { userId: "u", sedeId: SEDE_PLATAFORMA, roles: ["admin"] },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dbStub.writes).toBe(0);
  });
});

// ------------------------------------------------------------- estructura ---

const APP_ROOT = process.cwd();
const PAGE_FILE = "app/plataforma/page.tsx";
const CLIENT_FILE = "app/plataforma/plataforma-client.tsx";
const NAV_FILE = "src/shared/components/main-nav.tsx";
const HOME_FILE = "app/page.tsx";
const SERVICE_FILE = "src/features/platform/service.ts";

function readSource(file: string): string {
  return readFileSync(join(APP_ROOT, file), "utf8");
}

/** Código sin comentarios: una guarda o un nombre CITADO al explicar no cuenta. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** ¿El fuente abre el contrato llamando a la guarda de plataforma? */
function isGuardedByPlatform(source: string): boolean {
  return /\brequirePlatformAdmin\s*\(/.test(stripComments(source));
}

/**
 * ¿El fuente declara la entrada de nav `/plataforma` con `roles: ["superadmin"]`?
 * Se busca el bloque del objeto que arranca en `"/plataforma"` y se exige el rol
 * DENTRO de ese bloque: el href sin el rol (o con otro) no cuenta.
 */
function hasPlatformNavEntry(source: string): boolean {
  const code = stripComments(source);
  const marker = code.indexOf('"/plataforma"');
  if (marker === -1) return false;
  const end = code.indexOf("},", marker);
  const block = code.slice(marker, end === -1 ? undefined : end);
  return /roles:\s*\[\s*"superadmin"\s*\]/.test(block);
}

/** Cuerpo de una función exportada, hasta la siguiente exportación. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\nexport (?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** ¿El fuente escribe el nombre literal de la sede del sistema? */
function hardcodesPlatformName(source: string): boolean {
  return stripComments(source).includes("Plataforma (sistema)");
}

describe("plataforma: guardas de estructura (G3a)", () => {
  it("la página se guarda con requirePlatformAdmin", () => {
    expect(isGuardedByPlatform(readSource(PAGE_FILE))).toBe(true);

    // Control negativo: la guarda ausente o solo citada en un comentario no pasa.
    expect(isGuardedByPlatform("const session = await getSessionUser(token);")).toBe(false);
    expect(isGuardedByPlatform("// requirePlatformAdmin(token) queda para después")).toBe(false);
  });

  it("el nav declara /plataforma con roles [\"superadmin\"] en LAS DOS listas", () => {
    expect(hasPlatformNavEntry(readSource(NAV_FILE)), "main-nav.tsx").toBe(true);
    expect(hasPlatformNavEntry(readSource(HOME_FILE)), "app/page.tsx").toBe(true);

    // Control negativo: el href sin el rol (o con otro) no cuenta; el rol sin el
    // href, tampoco.
    expect(hasPlatformNavEntry('{ href: "/plataforma", roles: ["admin"] }')).toBe(false);
    expect(hasPlatformNavEntry('{ href: "/otra", roles: ["superadmin"] }')).toBe(false);
  });

  it("la lectura cross-sede no usa resolveSede ni filtra por sede", () => {
    const body = functionBody(readSource(SERVICE_FILE), "listPlatformSedes");
    expect(body, "no se encontró `listPlatformSedes` en el servicio").not.toBe("");
    // Sin comentarios: la frontera citada al documentar la función vecina
    // (G3b) no es una llamada. El defecto que este chequeo persigue es CÓDIGO.
    expect(stripComments(body)).not.toContain("resolveSede");
    expect(stripComments(body)).not.toContain(".eq(");

    // Control negativo: la frontera del negocio sí aparece cuando existe.
    const sintetico = `export async function listPlatformSedes(actor: PlatformActor) {
  const sede = resolveSede(actor.sedeId);
  return db.from("sedes").select("*").eq("sede_id", sede);
}`;
    expect(stripComments(functionBody(sintetico, "listPlatformSedes"))).toContain("resolveSede");
    expect(stripComments(functionBody(sintetico, "listPlatformSedes"))).toContain(".eq(");
  });

  it("la pantalla distingue la sede del sistema por la marca, no por el nombre", () => {
    const page = readSource(PAGE_FILE);
    expect(page).toContain("is_platform");
    expect(hardcodesPlatformName(page)).toBe(false);

    // Control negativo: el nombre literal en la pantalla se reporta.
    expect(hardcodesPlatformName('const nombre = "Plataforma (sistema)";')).toBe(true);
  });
});

describe("plataforma: estructura de la escritura (G3b)", () => {
  it("la escritura es una función de plataforma: no usa resolveSede y re-aplica el rol", () => {
    const body = functionBody(readSource(SERVICE_FILE), "setPlatformPayrollStartDate");
    expect(body, "no se encontró `setPlatformPayrollStartDate` en el servicio").not.toBe("");
    expect(body).not.toContain("resolveSede");
    expect(body).toContain("PLATFORM_ROLES");
    // La sede objetivo viaja ELEGIDA en el cuerpo: no se infiere de la sesión.
    expect(body).toContain("sede_id");

    // Control negativo: una escritura que resolviera la sede del actor se reporta.
    const sintetico = `export async function setPlatformPayrollStartDate(raw: unknown, actor: PlatformActor) {
  const sede = resolveSede(actor.sedeId);
  return db.from("sedes").update({}).eq("id", sede);
}`;
    expect(functionBody(sintetico, "setPlatformPayrollStartDate")).toContain("resolveSede");
  });

  it("la isla cliente pide la acción y no decide el permiso; la página sigue guardada", () => {
    const page = readSource(PAGE_FILE);
    const isla = readSource(CLIENT_FILE);

    // La página (servidor) monta la isla y conserva la guarda; la isla es cliente.
    expect(page).toContain("PlataformaPayrollStartDateForm");
    expect(page).not.toContain('"use client"');
    expect(isla).toContain('"use client"');

    // El éxito es EVENTO (toast) y la escritura va por la acción de plataforma.
    expect(isla).toContain("setPlatformPayrollStartDateAction");
    expect(isla).toContain("toast.success");

    // La isla tampoco reconoce la sede del sistema por su nombre.
    expect(hardcodesPlatformName(isla)).toBe(false);
  });
});
