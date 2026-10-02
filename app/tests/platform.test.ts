import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/src/features/auth/service";
import { listPlatformSedesAction } from "@/src/features/platform/actions";
import { listPlatformSedes, requirePlatformAdmin } from "@/src/features/platform/service";

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
  /** Simula 068 sin aplicar: `select` con la columna falla con 42703. */
  sinColumnaNomina: false,
  /** Fallo genérico de la base (no es columna faltante). */
  fail: false,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "token-de-prueba" }) }),
}));

vi.mock("@/src/features/auth/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/auth/service")>();
  return { ...actual, getSessionUser: async () => sessionStub.current };
});

/**
 * Doble mínimo de PostgREST: la lectura encadena `select().order().order()` y
 * resuelve contra las filas sembradas. Modela lo único que importa acá:
 *   * `reads` cuenta lecturas reales de `sedes` (la guarda no debe producir una).
 *   * `order` ordena como lo pide el servicio y `select` proyecta las columnas
 *     pedidas: la relectura sin la 068 no puede devolver la fecha que no pidió.
 *   * `sinColumnaNomina` reproduce el 42703 de la 068 sin aplicar, que la
 *     lectura degrada a «sin configurar» releyendo sin la columna.
 */
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => {
    const from = (table: string) => {
      let columnas: string[] = [];
      const ordenes: string[] = [];
      const resultado = (): { data: unknown; error: unknown } => {
        if (table !== "sedes") return { data: [], error: null };
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };
        if (columnas.includes("payroll_start_date") && dbStub.sinColumnaNomina) {
          return {
            data: null,
            error: {
              code: "42703",
              message: "column sedes.payroll_start_date does not exist",
            },
          };
        }
        // PostgREST aplica el orden pedido y PROYECTA las columnas del `select`:
        // la relectura sin la 068 no puede traer la fecha que no pidió.
        const ordenadas = [...dbStub.sedes].sort((a, b) => {
          for (const columna of ordenes) {
            const izq = String(a[columna] ?? "");
            const der = String(b[columna] ?? "");
            if (izq !== der) return izq < der ? -1 : 1;
          }
          return 0;
        });
        const filas =
          columnas.length === 0
            ? ordenadas
            : ordenadas.map((fila) =>
                Object.fromEntries(columnas.map((columna) => [columna, fila[columna]])),
              );
        return { data: filas, error: null };
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
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(resultado()).then(onFulfilled, onRejected),
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
  dbStub.sinColumnaNomina = false;
  dbStub.fail = false;
  sessionStub.current = null;
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

// ------------------------------------------------------------- estructura ---

const APP_ROOT = process.cwd();
const PAGE_FILE = "app/plataforma/page.tsx";
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
    expect(body).not.toContain("resolveSede");
    expect(body).not.toContain(".eq(");

    // Control negativo: la frontera del negocio sí aparece cuando existe.
    const sintetico = `export async function listPlatformSedes(actor: PlatformActor) {
  const sede = resolveSede(actor.sedeId);
  return db.from("sedes").select("*").eq("sede_id", sede);
}`;
    expect(functionBody(sintetico, "listPlatformSedes")).toContain("resolveSede");
    expect(functionBody(sintetico, "listPlatformSedes")).toContain(".eq(");
  });

  it("la pantalla distingue la sede del sistema por la marca, no por el nombre", () => {
    const page = readSource(PAGE_FILE);
    expect(page).toContain("is_platform");
    expect(hardcodesPlatformName(page)).toBe(false);

    // Control negativo: el nombre literal en la pantalla se reporta.
    expect(hardcodesPlatformName('const nombre = "Plataforma (sistema)";')).toBe(true);
  });
});
