import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/src/features/auth/service";
import * as platformActions from "@/src/features/platform/actions";
import { setPlatformPayrollStartDateAction } from "@/src/features/platform/actions";
import {
  readPlatformInstallation,
  requirePlatformAdmin,
  setPlatformPayrollStartDate,
  type PlatformActor,
} from "@/src/features/platform/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";

/* --------------------------------------------------------------------------
   La instalación es de UNA SOLA SEDE (decisión del dueño 2026-10-01).

   Lo que esta suite fija es el mundo que quedó después de retirar la
   estructura de sedes, con el mismo método de casa que los demás módulos:

   1. COMPORTAMIENTO — la lectura y la escritura reales, con la sesión y
      PostgREST simulados (`vi.mock` de `getSessionUser` y de
      `createAdminClient`). Sin red, sin Supabase. Fija lo que la unidad
      promete: la sede de la instalación es la única fila ACTIVA, el
      `sede_id` del cuerpo NO decide a quién se le escribe, y la guarda
      rechaza a todo el que no tenga el rol ANTES de leer una sola fila.
   2. ESTRUCTURA — los archivos reales se leen del disco (mismo patrón que
      `tests/action-guards.test.ts`), con control negativo por predicado: una
      guarda citada en un comentario, un nav sin el rol o un `resolveSede` en
      la escritura se reportan. Sin esto, los contratos serían decorativos.
   3. CIERRE — lo que la superficie de sedes ya no tiene (lista, alta, roles por
      sede), para que la retirement no se deshaga por una puerta que nadie
      recuerda cerrar.
   -------------------------------------------------------------------------- */

/** La sede de la instalación: la única fila activa. */
const SEDE = "11111111-1111-4111-8111-111111111111";
/**
 * Fila que NO es la instalación: la que dejó la versión anterior de esta capa.
 * Conserva su nombre de sistema a propósito — si algo la reconociera por el
 * nombre, la instalación seguiría siendo muchas sedes con otra etiqueta—.
 */
const SEDE_VIEJA = "00000000-0000-4000-8000-000000000001";
const NOMBRE_SEDE_VIEJA = "Plataforma (sistema)";

// ---------------------------------------------------------------- dobles ---

const sessionStub = vi.hoisted(() => ({ current: null as null | SessionUser }));

const dbStub = vi.hoisted(() => ({
  sedes: [] as Array<Record<string, unknown>>,
  /** Lecturas reales contra `sedes`: 0 prueba que la guarda rechazó antes. */
  reads: 0,
  /** Escrituras reales contra `sedes` por `update`. */
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
 * Doble mínimo de PostgREST para lo que la plataforma hace hoy: leer la fila
 * ACTIVA de `sedes` y escribir su fecha de nómina. Modela lo único que importa
 * acá:
 *   * `eq("is_active", true)` FILTRA de verdad: la sede de la instalación se
 *     elige por el dato, no por el nombre de la fila, y una fila inactiva tiene
 *     que quedar fuera.
 *   * `reads`/`writes` cuentan accesos reales (la guarda no debe producir uno).
 *   * `order` ordena como lo pide el servicio y `select` proyecta las columnas
 *     pedidas: la relectura sin la 068 no puede devolver la fecha que no pidió.
 *   * `eq("id", …)` acota la escritura y `maybeSingle` responde esa fila (o
 *     `null`): la escritura nunca puede alcanzar otra fila de la tabla.
 *   * `sinColumnaNomina` reproduce el 42703 de la 068 sin aplicar, que la
 *     lectura degrada a «sin configurar» releyendo sin la columna y que la
 *     escritura traduce a un mensaje accionable.
 */
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => {
    const from = (table: string) => {
      let columnas: string[] = [];
      const ordenes: string[] = [];
      const filtros: Record<string, unknown> = {};
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

      const cumpleFiltros = (fila: Record<string, unknown>) =>
        Object.entries(filtros).every(([columna, valor]) => fila[columna] === valor);

      const ordenar = (filas: Array<Record<string, unknown>>) =>
        [...filas].sort((a, b) => {
          for (const columna of ordenes) {
            const izq = String(a[columna] ?? "");
            const der = String(b[columna] ?? "");
            if (izq !== der) return izq < der ? -1 : 1;
          }
          return 0;
        });

      const filaObjetivo = () => dbStub.sedes.find((fila) => fila.id === filtroId) ?? null;

      const resultadoLista = (): { data: unknown; error: unknown } => {
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };
        if (table !== "sedes") return { data: [], error: null };
        if (tieneColumnaNomina() && dbStub.sinColumnaNomina) {
          return { data: null, error: errorColumna() };
        }
        const delFiltro = dbStub.sedes.filter(cumpleFiltros);
        return { data: proyectar(ordenar(delFiltro)), error: null };
      };

      const resultadoFila = (): { data: unknown; error: unknown } => {
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };
        if (table !== "sedes") return { data: null, error: null };
        if (tieneColumnaNomina() && dbStub.sinColumnaNomina) {
          return { data: null, error: errorColumna() };
        }
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
        eq: (columna: string, valor: unknown) => {
          filtros[columna] = valor;
          if (columna === "id") filtroId = valor as string;
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

/** Sesión simulada: la cuenta de plataforma anclada a la sede de la instalación. */
function asSession(roles: string[]): void {
  sessionStub.current = {
    user: { id: "u-plataforma", sede_id: SEDE },
    roles,
  } as unknown as SessionUser;
}

/** Actor de plataforma para llamar al servicio sin pasar por la sesión. */
function actorCon(roles: string[]): PlatformActor {
  return { userId: "u", roles } as unknown as PlatformActor;
}

/**
 * La instalación de una sola sede: su fila activa, con la fecha ya configurada.
 * La fila vieja queda sembrada en las pruebas que necesitan comprobar que no
 * cuenta como instalación.
 */
function sembrarInstalacion(sedes?: Array<Record<string, unknown>>): void {
  dbStub.sedes = sedes ?? [
    { id: SEDE, name: "Sede principal", is_active: true, payroll_start_date: "2026-01-01" },
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

// ------------------------------------------------ configuración de la instalación ---

describe("plataforma: la configuración de la instalación", () => {
  it("devuelve la sede activa con su fecha de nómina", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const instalacion = await readPlatformInstallation(actorCon(["superadmin"]));

    expect(instalacion).toEqual({
      id: SEDE,
      name: "Sede principal",
      is_active: true,
      payroll_start_date: "2026-01-01",
    });
    // Una sola lectura: la fila de la instalación, y ya.
    expect(dbStub.reads).toBe(1);
  });

  it("una fila que NO es la instalación no aparece, aunque se llame «Plataforma (sistema)»", async () => {
    // La fila que dejó la versión anterior de esta capa. Inactiva: no es la
    // instalación. El reconocimiento es por el DATO, así que su nombre —el que
    // antes la identificaba— no la devuelve a la pantalla.
    sembrarInstalacion([
      { id: SEDE, name: "Sede principal", is_active: true, payroll_start_date: "2026-01-01" },
      { id: SEDE_VIEJA, name: NOMBRE_SEDE_VIEJA, is_active: false, payroll_start_date: null },
    ]);
    asSession(["superadmin"]);

    const instalacion = await readPlatformInstallation(actorCon(["superadmin"]));

    expect(instalacion.id).toBe(SEDE);
    expect(instalacion.name).toBe("Sede principal");
  });

  it("sin la columna 068 (42703) la instalación queda «sin configurar»", async () => {
    sembrarInstalacion();
    dbStub.sinColumnaNomina = true;
    asSession(["superadmin"]);

    const instalacion = await readPlatformInstallation(actorCon(["superadmin"]));

    expect(instalacion.payroll_start_date).toBeNull();
    // Intento con la columna + relectura sin ella: la degradación es explícita.
    expect(dbStub.reads).toBe(2);
  });

  it("un fallo real de la base no se convierte en «sin configurar»", async () => {
    sembrarInstalacion();
    dbStub.fail = true;
    asSession(["superadmin"]);

    await expect(readPlatformInstallation(actorCon(["superadmin"]))).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
  });

  it("sin ninguna sede activa no hay configuración que leer", async () => {
    sembrarInstalacion([
      { id: SEDE_VIEJA, name: NOMBRE_SEDE_VIEJA, is_active: false, payroll_start_date: null },
    ]);

    await expect(readPlatformInstallation(actorCon(["superadmin"]))).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("con dos sedes activas NO elige una: nombra las dos y se detiene", async () => {
    sembrarInstalacion([
      { id: SEDE, name: "Sede principal", is_active: true, payroll_start_date: null },
      { id: SEDE_VIEJA, name: NOMBRE_SEDE_VIEJA, is_active: true, payroll_start_date: null },
    ]);

    const error = await readPlatformInstallation(actorCon(["superadmin"])).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "SEDE_AMBIGUA", status: 409 });
    expect((error as Error).message).toContain("Sede principal");
    expect((error as Error).message).toContain(NOMBRE_SEDE_VIEJA);
    // Nada escrito: decidir cuál es la instalación es del dueño.
    expect(dbStub.writes).toBe(0);
  });
});

// --------------------------------------------------------------- guarda ---

describe("plataforma: la guarda", () => {
  it("una sesión sin el rol recibe FORBIDDEN y NINGUNA lectura", async () => {
    sembrarInstalacion();
    asSession(["admin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: "2026-10-05" });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    // Sin `data`: ni un valor, ni siquiera vacío.
    expect(result).not.toHaveProperty("data");
    // Y la base no se tocó: la guarda rechaza antes de leer.
    expect(dbStub.reads).toBe(0);
    expect(dbStub.writes).toBe(0);
  });

  it("la guarda responde FORBIDDEN con estado 403", async () => {
    asSession(["admin"]);

    await expect(requirePlatformAdmin("token-de-prueba")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("la lectura misma rechaza un actor sin el rol (no depende del llamador)", async () => {
    sembrarInstalacion();

    await expect(readPlatformInstallation(actorCon(["admin"]))).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(dbStub.reads).toBe(0);
  });

  it("control positivo: `superadmin` lee la configuración de la instalación", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const actor = await requirePlatformAdmin("token-de-prueba");

    expect(actor).toMatchObject({ userId: "u-plataforma", roles: ["superadmin"] });
    await expect(readPlatformInstallation(actor)).resolves.toMatchObject({ id: SEDE });
  });
});

// -------------------------------------------------------------- escritura ---

describe("plataforma: la escritura de la fecha de nómina", () => {
  const NUEVA = "2026-10-05";

  it("configura la fecha de la instalación", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: NUEVA });

    expect(result).toEqual({
      success: true,
      data: { sede_id: SEDE, payroll_start_date: NUEVA },
    });
    expect(dbStub.sedes[0]?.payroll_start_date).toBe(NUEVA);
    // Dos accesos: la fila de la instalación (que es también el valor anterior) y
    // la fila devuelta por la escritura. Una escritura, y sólo sobre esa fila.
    expect(dbStub.reads).toBe(2);
    expect(dbStub.writes).toBe(1);
  });

  it("la sede objetivo NO la elige el llamador: un `sede_id` en el cuerpo se descarta", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({
      sede_id: SEDE_VIEJA,
      payroll_start_date: NUEVA,
    });

    expect(result).toMatchObject({ success: true, data: { sede_id: SEDE } });
    // La fila que el cuerpo nombraba queda intacta: la instalación es una, y la
    // resuelve el servidor.
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_VIEJA)?.payroll_start_date).toBeUndefined();
  });

  it("deja la auditoría con el actor, la sede objetivo (como entidad) y los DOS valores", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    await setPlatformPayrollStartDateAction({ payroll_start_date: NUEVA });

    // El vocabulario cerrado: la acción se lee como configuración de plataforma.
    expect(AUDIT_ACTIONS.PLATFORM_PAYROLL_START_DATE_SET).toBe("platform.payroll_start_date_set");
    expect(auditStub.entries).toHaveLength(1);
    expect(auditStub.entries[0]).toMatchObject({
      user_id: "u-plataforma",
      action: "platform.payroll_start_date_set",
      entity: "sedes",
      entity_id: SEDE,
      metadata: {
        previous_payroll_start_date: "2026-01-01",
        new_payroll_start_date: NUEVA,
      },
    });
    // La sede sigue nombrada —como la ENTIDAD que se reconfiguró—, pero ya no
    // viaja como columna propia.
    expect(auditStub.entries[0]).not.toHaveProperty("sede_id");
  });

  it("limpiarla con null vuelve a «sin configurar» y audita el anterior y el null", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: null });

    expect(result).toEqual({
      success: true,
      data: { sede_id: SEDE, payroll_start_date: null },
    });
    expect(dbStub.sedes[0]?.payroll_start_date).toBeNull();
    expect(auditStub.entries[0]?.metadata).toEqual({
      previous_payroll_start_date: "2026-01-01",
      new_payroll_start_date: null,
    });
  });

  it("una fecha con otra forma no escribe ni audita", async () => {
    sembrarInstalacion();
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: "05/10/2026" });

    expect(result).toMatchObject({ success: false, code: "VALIDATION" });
    expect(dbStub.writes).toBe(0);
    expect(dbStub.sedes[0]?.payroll_start_date).toBe("2026-01-01");
    expect(auditStub.entries).toHaveLength(0);
  });

  it("sin la migración 068 responde un mensaje accionable y no deja la fecha escrita", async () => {
    sembrarInstalacion();
    dbStub.sinColumnaNomina = true;
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: NUEVA });

    expect(result).toMatchObject({ success: false, code: "VALIDATION" });
    if (result.success) return;
    expect(result.message).toContain("068");
    // La base rechazó la sentencia: la fila conserva lo que tenía y no hay
    // auditoría de una fecha que no se escribió.
    expect(dbStub.sedes[0]?.payroll_start_date).toBe("2026-01-01");
    expect(auditStub.entries).toHaveLength(0);
  });

  it("sin ninguna sede activa no se escribe ni se audita", async () => {
    sembrarInstalacion([
      { id: SEDE_VIEJA, name: NOMBRE_SEDE_VIEJA, is_active: false, payroll_start_date: null },
    ]);
    asSession(["superadmin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: NUEVA });

    expect(result).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(dbStub.writes).toBe(0);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("un admin de sede NO puede cambiarla: FORBIDDEN y NADA escrito", async () => {
    sembrarInstalacion();
    asSession(["admin"]);

    const result = await setPlatformPayrollStartDateAction({ payroll_start_date: NUEVA });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    // El rechazo es ANTES de tocar la base: ni lectura, ni escritura.
    expect(dbStub.reads).toBe(0);
    expect(dbStub.writes).toBe(0);
    expect(dbStub.sedes[0]?.payroll_start_date).toBe("2026-01-01");
    expect(auditStub.entries).toHaveLength(0);
  });

  it("la escritura misma re-aplica el rol (no depende del llamador)", async () => {
    sembrarInstalacion();

    await expect(
      setPlatformPayrollStartDate({ payroll_start_date: NUEVA }, actorCon(["admin"])),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dbStub.reads).toBe(0);
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
const ACTIONS_FILE = "src/features/platform/actions.ts";

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

describe("plataforma: guardas de estructura", () => {
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

  it("la pantalla presenta LA INSTALACIÓN: un solo form, ninguno por sede", () => {
    const page = stripComments(readSource(PAGE_FILE));

    // La configuración se lee por el servidor con la guarda y llega por SSR.
    expect(page).toContain("readPlatformInstallation");
    expect(page).toContain("instalacion.name");
    // UNA isla de fecha, no una por sede: la instalación es una.
    const formularios = page.match(/<PlataformaPayrollStartDateForm/g) ?? [];
    expect(formularios, "la pantalla debe montar un único formulario").toHaveLength(1);
    // Y no hay ninguna estructura de sedes: ni la marca de la fila del sistema,
    // ni un recorrido de una lista de sedes.
    expect(page).not.toContain("is_platform");
    expect(page).not.toMatch(/\bsedes\.map\(/);
    expect(page).not.toContain("PlataformaCreateSedeForm");
    expect(page).not.toContain("PlataformaSedeRolesSection");

    // Control negativo: una lista de sedes se reporta.
    const conListaDeSedes = `
      <ul>{sedes.map((sede) => <li key={sede.id}>{sede.is_platform ? "x" : null}</li>)}</ul>
      <PlataformaSedeRolesSection sedeId={sede.id} sedeName={sede.name} />`;
    expect(/"is_platform"|\bsedes\.map\(|PlataformaSedeRolesSection/.test(conListaDeSedes)).toBe(
      true,
    );
  });

  it("la escritura no usa la frontera del negocio, re-aplica el rol y no recibe la sede", () => {
    const body = functionBody(readSource(SERVICE_FILE), "setPlatformPayrollStartDate");
    expect(body, "no se encontró `setPlatformPayrollStartDate` en el servicio").not.toBe("");
    // Sin comentarios: la frontera citada al documentar la función no es una
    // llamada. El defecto que este chequeo persigue es CÓDIGO.
    expect(stripComments(body)).not.toContain("resolveSede");
    expect(body).toContain("PLATFORM_ROLES");
    // El objetivo lo RESUELVE el servicio (la fila activa), no el cuerpo.
    expect(stripComments(body)).toContain("leerSedeDeLaInstalacion");

    // Control negativo: una escritura que resolviera la sede del actor se reporta.
    const sintetico = `export async function setPlatformPayrollStartDate(raw: unknown, actor: PlatformActor) {
  const sede = resolveSede(actor.sedeId);
  return db.from("sedes").update({}).eq("id", sede);
}`;
    expect(stripComments(functionBody(sintetico, "setPlatformPayrollStartDate"))).toContain(
      "resolveSede",
    );
  });

  it("la resolución de la instalación es por el dato activo, y no elige al azar", () => {
    const body = stripComments(functionBody(readSource(SERVICE_FILE), "leerSedeDeLaInstalacion"));

    // `is_active` y no el nombre: renombrar la fila no cambia qué es la
    // instalación, y una lista de nombres en el código sería una segunda fuente
    // de verdad para lo que la base ya dice.
    expect(body).toContain('.eq("is_active", true)');
    expect(body).toContain("SEDE_AMBIGUA");
    expect(body).toContain("NOT_FOUND");

    // Control negativo: reconocer la instalación por su nombre se reporta.
    const porNombre = `export async function leerSedeDeLaInstalacion(db) {
  const { data } = await db.from("sedes").select("*").eq("name", "Plataforma (sistema)");
  return data[0];
}`;
    expect(stripComments(functionBody(porNombre, "leerSedeDeLaInstalacion"))).toContain(
      '.eq("name"',
    );
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

    // El cuerpo NO lleva la sede: la instalación es una y la resuelve el servidor.
    expect(stripComments(isla)).not.toContain("sede_id");
  });
});

// ----------------------------------------------------------------- cierre ---

/**
 * Lo que la instalación de una sola sede retiró de esta capa. No es una prueba de
 * estilo: es el cierre de la retirement, con el mismo patrón que el bloque G5 de
 * `tests/admin.test.ts` para el negocio. Sin esto, volver a exportar la lista o
 * el alta no rompería nada.
 */
describe("plataforma: la superficie de sedes se retiró", () => {
  const servicio = readSource(SERVICE_FILE);
  const acciones = readSource(ACTIONS_FILE);
  const isla = stripComments(readSource(CLIENT_FILE));

  it("el módulo ya no declara ni exporta la lista, el alta ni los roles por sede", () => {
    for (const nombre of [
      "createPlatformSede",
      "listPlatformSedes",
      "listPlatformSedeUsers",
      "setPlatformSedeUserRoles",
      "PlatformSedeRow",
      "PlatformSedeUserRow",
      "CreatedSedeRow",
    ]) {
      const declaracion = new RegExp(
        String.raw`export\s+(?:async\s+function|const|function|interface|type)\s+${nombre}\b`,
      );
      expect(servicio, `platform/service.ts todavía declara ${nombre}`).not.toMatch(declaracion);
      expect(stripComments(acciones)).not.toContain(nombre);
      expect(isla).not.toContain(nombre);
    }
    // El esquema de la fila de sede no se re-declara acá: la plataforma ya no
    // escribe filas de `sedes`.
    expect(stripComments(servicio)).not.toContain("sedeSchema");
  });

  it("las acciones retiradas no quedan alcanzables como endpoint POST", () => {
    // `"use server"` convierte cada export en un endpoint POST: que no exista el
    // export es lo que cierra la puerta, no que la pantalla no la ofrezca.
    for (const nombre of [
      "listPlatformSedesAction",
      "createPlatformSedeAction",
      "listPlatformSedeUsersAction",
      "setPlatformSedeUserRolesAction",
    ]) {
      expect(
        nombre in platformActions,
        `${nombre} sigue exportada: "use server" la deja alcanzable como endpoint POST`,
      ).toBe(false);
      expect(acciones).not.toContain(`export async function ${nombre}`);
    }
    // La que queda es la única, y es la que la tabla de roles declara.
    expect(stripComments(acciones)).toContain("export async function setPlatformPayrollStartDateAction");
  });

  it("la superficie NO administra roles: ni los ofrece ni los escribe", () => {
    // La gestión de usuarios es del admin de la sede (`/admin`). Aquí no queda ni
    // la lista de roles que se ofrecían ni el reemplazo que los escribía.
    for (const rol of ["admin", "caja", "empleado", "superadmin"]) {
      expect(isla, `la isla todavía menciona el rol ${rol}`).not.toContain(`"${rol}"`);
    }
    expect(stripComments(servicio)).not.toContain("replace_user_roles");
    expect(stripComments(servicio)).not.toContain("OPCIONES_DE_ROL");
  });

  it("el vocabulario de auditoría sólo conserva la configuración que sigue existiendo", () => {
    expect(AUDIT_ACTIONS.PLATFORM_PAYROLL_START_DATE_SET).toBe("platform.payroll_start_date_set");
    // El alta de sedes y los roles por sede ya no tienen operación que auditar:
    // las acciones salen del vocabulario cerrado.
    expect(Object.values(AUDIT_ACTIONS)).not.toContain("platform.sede_created");
    expect(Object.values(AUDIT_ACTIONS)).not.toContain("platform.sede_roles_set");
    // Y las acciones que quedan no re-declaran el código a mano: lo toman del
    // vocabulario, para que no se desincronicen.
    expect(stripComments(acciones)).toContain("setPlatformPayrollStartDateAction");
    expect(stripComments(acciones)).not.toContain("platform.payroll_start_date_set");
  });

  it("no entra a ningún catálogo de alertas: es configuración, no un desvío", () => {
    for (const archivo of ["src/features/alerts/service.ts", "src/features/alerts/schemas.ts"]) {
      const fuente = readSource(archivo);
      expect(fuente, `${archivo} menciona la acción de plataforma`).not.toContain(
        "PLATFORM_PAYROLL_START_DATE_SET",
      );
      expect(fuente).not.toContain("platform.payroll_start_date_set");
    }
  });
});