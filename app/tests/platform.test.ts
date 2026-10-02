import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/src/features/auth/service";
import {
  createPlatformSedeAction,
  listPlatformSedesAction,
  listPlatformSedeUsersAction,
  setPlatformPayrollStartDateAction,
  setPlatformSedeUserRolesAction,
} from "@/src/features/platform/actions";
import {
  createPlatformSede,
  listPlatformSedes,
  listPlatformSedeUsers,
  requirePlatformAdmin,
  setPlatformPayrollStartDate,
  setPlatformSedeUserRoles,
  type PlatformActor,
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
  /** Usuarios sembrados por sede (G5). */
  users: [] as Array<Record<string, unknown>>,
  /** Filas de `user_roles` aplanadas: `{ user_id, code }` (G5). */
  user_roles: [] as Array<{ user_id: string; code: string }>,
  /** Lecturas reales contra la base: 0 prueba que la guarda rechazó antes. */
  reads: 0,
  /** Escrituras reales contra `sedes` por `update`: 0 prueba que no se editó. */
  writes: 0,
  /** Altas reales contra `sedes` por `insert`. */
  inserts: 0,
  /** Llamadas al rpc atómico de reemplazo de roles (039). */
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Simula 068 sin aplicar: `select` con la columna falla con 42703. */
  sinColumnaNomina: false,
  /** Fallo genérico de la base (no es columna faltante). */
  fail: false,
  /** Fallo inyectable en el rpc (P0001 y compañía). */
  failRpc: null as null | { code: string; message: string },
  /** El rpc responde éxito pero sin aplicar el conjunto pedido. */
  rpcAppliesNothing: false,
  /** Secuencia para los ids de las sedes creadas. */
  nextId: 0,
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
 * Doble mínimo de PostgREST: la lectura de sedes encadena
 * `select().order().order()` y resuelve contra las filas sembradas; la escritura
 * encadena `update().eq().select().maybeSingle()` y muta la fila sembrada.
 * Modela lo único que importa acá:
 *   * `reads`/`writes`/`inserts`/`rpcs` cuentan accesos reales (la guarda no debe
 *     producir uno).
 *   * `order` ordena como lo pide el servicio y `select` proyecta las columnas
 *     pedidas: la relectura sin la 068 no puede devolver la fecha que no pidió.
 *   * `eq("id", …)` acota a la sede pedida y `maybeSingle` responde esa fila (o
 *     `null`): la escritura nunca puede alcanzar una sede distinta de la elegida.
 *   * `sinColumnaNomina` reproduce el 42703 de la 068 sin aplicar, que la
 *     lectura degrada a «sin configurar» releyendo sin la columna y que la
 *     escritura traduce a un mensaje accionable.
 *   * `insert` en `sedes` RESPETA el índice `uq_sedes_name` de la 070 sobre
 *     `lower(btrim(name))`: no es un interruptor sino el modelo de la base, así
 *     que un nombre repetido produce el 23505 real, con su código y su mensaje.
 *   * `rpc("replace_user_roles", …)` es UNA sentencia: aplica el conjunto entero
 *     o nada, igual que la función 039 con su transacción y su candado.
 */
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => {
    const from = (table: string) => {
      let columnas: string[] = [];
      const ordenes: string[] = [];
      const filtros: Record<string, unknown> = {};
      let filtroId: string | null = null;
      let escrito: Record<string, unknown> | null = null;
      let insertado: Record<string, unknown> | null = null;
      /** El `insert` chocó con `uq_sedes_name`: la fila se devuelve con 23505. */
      let insertadoDuplicado = false;

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

      /** `user_roles` no se proyecta columna por columna: trae `roles(code)`. */
      const filasDeUserRoles = (): Array<Record<string, unknown>> => {
        const pedidos = filtros.__in as string[] | undefined;
        return dbStub.user_roles
          .filter((fila) =>
            pedidos !== undefined
              ? pedidos.includes(fila.user_id)
              : fila.user_id === filtros.user_id,
          )
          .map((fila) => ({ user_id: fila.user_id, roles: { code: fila.code } }));
      };

      const resultadoLista = (): { data: unknown; error: unknown } => {
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };

        if (table === "sedes") {
          if (tieneColumnaNomina() && dbStub.sinColumnaNomina) return { data: null, error: errorColumna() };
          return { data: proyectar(ordenar(dbStub.sedes)), error: null };
        }
        if (table === "users") {
          const deLaSede = dbStub.users.filter(
            (fila) =>
              (filtros.sede_id === undefined || fila.sede_id === filtros.sede_id) &&
              (filtros.id === undefined || fila.id === filtros.id),
          );
          return { data: proyectar(ordenar(deLaSede)), error: null };
        }
        if (table === "user_roles") return { data: filasDeUserRoles(), error: null };
        return { data: [], error: null };
      };

      const resultadoFila = (): { data: unknown; error: unknown } => {
        dbStub.reads += 1;
        if (dbStub.fail) return { data: null, error: { code: "XX000", message: "fallo simulado" } };

        if (table === "sedes") {
          if (tieneColumnaNomina() && dbStub.sinColumnaNomina) return { data: null, error: errorColumna() };
          const fila = filaObjetivo();
          if (fila === null) return { data: null, error: null };
          // La escritura se APLICA al resolver: `eq("id", …)` es lo único que la
          // acota, igual que en PostgREST.
          if (escrito !== null) Object.assign(fila, escrito);
          return { data: proyectar([fila])[0], error: null };
        }
        if (table === "users") {
          const fila = dbStub.users.find((item) => item.id === filtros.id) ?? null;
          if (fila === null) return { data: null, error: null };
          return { data: proyectar([fila])[0], error: null };
        }
        return { data: null, error: null };
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
        insert: (payload: Record<string, unknown>) => {
          if (table === "sedes") {
            dbStub.inserts += 1;
            const fila: Record<string, unknown> = {
              address: null,
              phone: null,
              is_active: true,
              ...payload,
              id: `sede-nueva-${(dbStub.nextId += 1)}`,
            };
            // 070: `uq_sedes_name` es UNIQUE sobre `lower(btrim(name))`, así que
            // el espaciado y las mayúsculas no esquivan el choque.
            const normalizado = String(fila.name).trim().toLowerCase();
            const repetido = dbStub.sedes.some(
              (existente) => String(existente.name).trim().toLowerCase() === normalizado,
            );
            if (repetido) {
              insertadoDuplicado = true;
              return query;
            }
            dbStub.sedes.push(fila);
            insertado = fila;
          }
          return query;
        },
        eq: (columna: string, valor: string) => {
          filtros[columna] = valor;
          if (columna === "id") filtroId = valor;
          return query;
        },
        in: (columna: string, valores: string[]) => {
          filtros[`__in_${columna}`] = valores;
          if (columna === "user_id") filtros.__in = valores;
          return query;
        },
        maybeSingle: () => Promise.resolve(resultadoFila()),
        single: () =>
          Promise.resolve(
            insertadoDuplicado
              ? {
                  data: null,
                  error: {
                    code: "23505",
                    message: 'duplicate key value violates unique constraint "uq_sedes_name"',
                  },
                }
              : insertado === null
                ? { data: null, error: null }
                : { data: proyectar([insertado])[0], error: null },
          ),
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(resultadoLista()).then(onFulfilled, onRejected),
      };
      return query;
    };

    /**
     * `replace_user_roles` (039) es UNA sentencia con transacción y candado:
     * reemplaza el conjunto entero o no aplica nada. Acá se imita ese efecto
     * observable —nunca un DELETE y un INSERT sueltos— para que la post-condición
     * del servicio se pueda ejercitar.
     */
    const rpc = (fn: string, args: Record<string, unknown>) => {
      if (fn !== "replace_user_roles") {
        return Promise.resolve({ data: null, error: { code: "42883", message: "no such function" } });
      }
      dbStub.rpcs.push({ fn, args });
      if (dbStub.failRpc) return Promise.resolve({ data: null, error: dbStub.failRpc });
      if (dbStub.rpcAppliesNothing) return Promise.resolve({ data: [], error: null });
      const userId = args.p_user_id as string;
      const codes = (args.p_role_codes as string[]) ?? [];
      dbStub.user_roles = dbStub.user_roles.filter((fila) => fila.user_id !== userId);
      for (const code of codes) dbStub.user_roles.push({ user_id: userId, code });
      return Promise.resolve({ data: [...codes].sort(), error: null });
    };

    return { from, rpc };
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

const USUARIO_CENTRO_ADMIN = "aaaaaaa1-1111-4111-8111-aaaaaaaaaaaa";
const USUARIO_CENTRO_CAJA = "aaaaaaa2-2222-4222-8222-aaaaaaaaaaaa";
const USUARIO_NORTE = "bbbbbbb1-3333-4333-8333-bbbbbbbbbbbb";
const USUARIO_PLATAFORMA = "ccccccc1-4444-4444-8444-cccccccccccc";

/** Dos usuarios en Centro y uno en Norte: la lista es cross-sede y debe notarlo. */
function sembrarUsuarios(): void {
  dbStub.users = [
    { id: USUARIO_CENTRO_CAJA, sede_id: SEDE_CENTRO, full_name: "Carla Caja", id_number: "101" },
    {
      id: USUARIO_CENTRO_ADMIN,
      sede_id: SEDE_CENTRO,
      full_name: "Andrés Admin",
      id_number: "102",
    },
    { id: USUARIO_NORTE, sede_id: SEDE_NORTE, full_name: "Nina Norte", id_number: "103" },
    {
      id: USUARIO_PLATAFORMA,
      sede_id: SEDE_PLATAFORMA,
      full_name: "Dueña de la plataforma",
      id_number: "001",
    },
  ];
  dbStub.user_roles = [
    { user_id: USUARIO_CENTRO_ADMIN, code: "empleado" },
    { user_id: USUARIO_CENTRO_CAJA, code: "caja" },
    { user_id: USUARIO_NORTE, code: "admin" },
    { user_id: USUARIO_PLATAFORMA, code: "superadmin" },
  ];
}

beforeEach(() => {
  dbStub.sedes = [];
  dbStub.users = [];
  dbStub.user_roles = [];
  dbStub.reads = 0;
  dbStub.writes = 0;
  dbStub.inserts = 0;
  dbStub.rpcs = [];
  dbStub.sinColumnaNomina = false;
  dbStub.fail = false;
  dbStub.failRpc = null;
  dbStub.rpcAppliesNothing = false;
  dbStub.nextId = 0;
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
    // Sin comentarios: la frontera citada al documentar la función (y la de las
    // funciones vecinas de G5) no es una llamada. El defecto que este chequeo
    // persigue es CÓDIGO.
    expect(stripComments(body)).not.toContain("resolveSede");
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

/* --------------------------------------------------------------------------
   G5 — la plataforma ADMINISTRA la instalación: crea sedes y decide quién
   administra cada una.

   Las dos mitades del bloque, con el método de casa:

   1. COMPORTAMIENTO — el alta y el reemplazo de roles contra el doble de
      PostgREST, que modela el índice `uq_sedes_name` (070) y la sentencia
      atómica `replace_user_roles` (039). Fija lo que la unidad promete: el
      duplicado NO se puede crear, el `id` del cuerpo NO edita, el conjunto
      asignable es el de sede (el rol de plataforma no se otorga ni se quita), un
      usuario de otra sede es un 403, y las dos mutaciones dejan auditoría con el
      cambio concreto.
   2. ESTRUCTURA — los archivos reales se leen del disco (mismo patrón que
      `tests/action-guards.test.ts`), con control negativo por predicado.
   -------------------------------------------------------------------------- */

const NOMBRE_PLATAFORMA = "Plataforma (sistema)";

describe("plataforma: el alta de una sede (G5)", () => {
  it("crea la sede con la fila de `003_admin.sql` y la devuelve", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({
      name: "Sur",
      address: "Calle 1 #2-3",
      phone: "3001234567",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      name: "Sur",
      address: "Calle 1 #2-3",
      phone: "3001234567",
      is_active: true,
    });
    expect(dbStub.inserts).toBe(1);
    // La sede existe de verdad en la tabla: no es una respuesta de mentira.
    expect(dbStub.sedes.map((sede) => sede.name)).toContain("Sur");
  });

  it("una sede sin dirección ni teléfono guarda `null`, no una cadena vacía", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ name: "Sur", address: null, phone: null });

    expect(result.success).toBe(true);
    expect(dbStub.sedes.find((sede) => sede.name === "Sur")).toMatchObject({
      address: null,
      phone: null,
    });
  });

  it("un `id` en el cuerpo NO edita: la sede se crea y las demás quedan intactas", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ id: SEDE_CENTRO, name: "Nueva" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // El `id` ni siquiera llega a la escritura (el esquema lo omite).
    expect(result.data.id).not.toBe(SEDE_CENTRO);
    expect(dbStub.sedes.find((sede) => sede.id === SEDE_CENTRO)?.name).toBe("Centro");
    expect(dbStub.inserts).toBe(1);
    expect(dbStub.writes).toBe(0);
  });

  it("un nombre repetido se rechaza con el error de casa que NOMBRA la sede", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ name: "Norte" });

    expect(result).toMatchObject({ success: false, code: "SEDE_NAME_TAKEN" });
    if (result.success) return;
    // El mensaje nombra la sede que ya existe: un "ya existe" sin decir cuál no
    // le sirve a quien está creando.
    expect(result.message).toContain("Norte");
    // No se escribió nada ni se auditó un alta que no ocurrió.
    expect(dbStub.sedes).toHaveLength(3);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("el choque es el de la 070: también con otras mayúsculas y espaciado", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ name: "  norte  " });

    // El índice es UNIQUE sobre `lower(btrim(name))`: el doble lo modela, así que
    // la normalización se verifica acá y no en un comentario.
    expect(result).toMatchObject({ success: false, code: "SEDE_NAME_TAKEN" });
    expect(dbStub.sedes).toHaveLength(3);
  });

  it("la fila de la sede del sistema NO se puede crear dos veces", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ name: NOMBRE_PLATAFORMA });

    expect(result).toMatchObject({ success: false, code: "SEDE_NAME_TAKEN" });
    if (result.success) return;
    expect(result.message).toContain(NOMBRE_PLATAFORMA);
    expect(dbStub.sedes.filter((sede) => sede.name === NOMBRE_PLATAFORMA)).toHaveLength(1);
  });

  it("la auditoría del alta lleva el actor, la sede nueva y los datos del nombre", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    await createPlatformSedeAction({ name: "Sur", address: null, phone: "3001234567" });

    expect(AUDIT_ACTIONS.PLATFORM_SEDE_CREATED).toBe("platform.sede_created");
    expect(auditStub.entries).toHaveLength(1);
    const entrada = auditStub.entries[0];
    expect(entrada.action).toBe("platform.sede_created");
    expect(entrada.entity).toBe("sedes");
    expect(entrada.user_id).toBe("u-plataforma");
    expect(entrada.sede_id).toBe(entrada.entity_id);
    expect(entrada.metadata).toEqual({
      name: "Sur",
      address: null,
      phone: "3001234567",
      is_active: true,
    });
  });

  it("un nombre vacío no escribe ni audita", async () => {
    sembrarSedes();
    asSession(["superadmin"]);

    const result = await createPlatformSedeAction({ name: "   " });

    expect(result).toMatchObject({ success: false, code: "VALIDATION" });
    expect(dbStub.inserts).toBe(0);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("un admin de sede NO crea sedes: FORBIDDEN y NADA escrito", async () => {
    sembrarSedes();
    asSession(["admin"]);

    const result = await createPlatformSedeAction({ name: "Sur" });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(result).not.toHaveProperty("data");
    // El rechazo es ANTES de tocar la base: ni lectura, ni escritura.
    expect(dbStub.reads).toBe(0);
    expect(dbStub.inserts).toBe(0);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("el alta misma re-aplica el rol (no depende del llamador)", async () => {
    sembrarSedes();

    await expect(
      createPlatformSede(
        { name: "Sur" },
        { userId: "u", sedeId: SEDE_PLATAFORMA, roles: ["admin"] },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dbStub.inserts).toBe(0);
  });
});

describe("plataforma: los usuarios de una sede y sus roles (G5)", () => {
  it("lista los usuarios de la sede ELEGIDA, con su rol, y no los de otra", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await listPlatformSedeUsersAction({ sede_id: SEDE_CENTRO });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Orden por nombre; los de Norte y los de la fila del sistema no aparecen.
    expect(result.data.map((row) => row.id)).toEqual([USUARIO_CENTRO_ADMIN, USUARIO_CENTRO_CAJA]);
    expect(result.data.map((row) => row.full_name)).toEqual(["Andrés Admin", "Carla Caja"]);
    expect(result.data[0].roles).toEqual(["empleado"]);
    expect(result.data[1].roles).toEqual(["caja"]);
  });

  it("es una lectura cross-sede: pide la sede pedida, no la del actor", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    // El actor está anclado a la fila del sistema y pide los usuarios de NORTE.
    const result = await listPlatformSedeUsersAction({ sede_id: SEDE_NORTE });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((row) => row.id)).toEqual([USUARIO_NORTE]);
  });

  it("asigna `admin`: el reemplazo es una sola llamada al rpc atómico", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_CAJA,
      roles: ["admin"],
    });

    expect(result).toEqual({
      success: true,
      data: { sede_id: SEDE_CENTRO, user_id: USUARIO_CENTRO_CAJA, roles: ["admin"] },
    });
    // UNA sentencia (039), no un DELETE + un INSERT sueltos.
    expect(dbStub.rpcs).toEqual([
      {
        fn: "replace_user_roles",
        args: { p_user_id: USUARIO_CENTRO_CAJA, p_role_codes: ["admin"] },
      },
    ]);
    expect(dbStub.user_roles.filter((fila) => fila.user_id === USUARIO_CENTRO_CAJA)).toEqual([
      { user_id: USUARIO_CENTRO_CAJA, code: "admin" },
    ]);
  });

  it("la auditoría del cambio dice qué roles tenía y cuáles quedan", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_ADMIN,
      roles: ["admin"],
    });

    expect(AUDIT_ACTIONS.PLATFORM_SEDE_ROLES_SET).toBe("platform.sede_roles_set");
    expect(auditStub.entries).toHaveLength(1);
    expect(auditStub.entries[0]).toMatchObject({
      sede_id: SEDE_CENTRO,
      user_id: "u-plataforma",
      action: "platform.sede_roles_set",
      entity: "users",
      entity_id: USUARIO_CENTRO_ADMIN,
      metadata: { previous_roles: ["empleado"], new_roles: ["admin"] },
    });
  });

  it("quitar `admin` es dejar el rol que sí corresponde, y queda auditado", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_NORTE,
      user_id: USUARIO_NORTE,
      roles: ["empleado"],
    });

    expect(result.success).toBe(true);
    expect(auditStub.entries[0]?.metadata).toEqual({
      previous_roles: ["admin"],
      new_roles: ["empleado"],
    });
  });

  it("otorgar el rol de plataforma desde acá se rechaza: NADA se escribe", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_CAJA,
      roles: ["superadmin"],
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(result).not.toHaveProperty("data");
    // Ni una lectura, ni una llamada al rpc: el rechazo es ANTES de la base.
    expect(dbStub.reads).toBe(0);
    expect(dbStub.rpcs).toEqual([]);
    expect(auditStub.entries).toHaveLength(0);
    // Y el rol del usuario sigue siendo el que tenía.
    expect(dbStub.user_roles.filter((fila) => fila.user_id === USUARIO_CENTRO_CAJA)).toEqual([
      { user_id: USUARIO_CENTRO_CAJA, code: "caja" },
    ]);
  });

  it("un usuario de OTRA sede se rechaza con el 403 de casa", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_NORTE,
      roles: ["admin"],
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(dbStub.rpcs).toEqual([]);
    expect(auditStub.entries).toHaveLength(0);
    expect(dbStub.user_roles.filter((fila) => fila.user_id === USUARIO_NORTE)).toEqual([
      { user_id: USUARIO_NORTE, code: "admin" },
    ]);
  });

  it("un usuario que no existe no llega al rpc", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: "99999999-9999-4999-8999-999999999999",
      roles: ["admin"],
    });

    expect(result).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(dbStub.rpcs).toEqual([]);
  });

  it("la fila de la plataforma no se administra a sí misma", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_PLATAFORMA,
      user_id: USUARIO_PLATAFORMA,
      roles: ["admin"],
    });

    // El reconocimiento es por el anclaje (`fila.id === actor.sedeId`), no por el
    // nombre de la fila: renombrarla no abre la puerta.
    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(dbStub.reads).toBe(0);
    expect(dbStub.rpcs).toEqual([]);
  });

  it("no se le puede arrancar el rol a una cuenta de plataforma", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["superadmin"]);

    // Un usuario que ya tiene un rol NO asignable desde sede queda fuera del
    // reemplazo: es la misma defensa que aplica `setUserRoles` en el negocio.
    dbStub.users.push({
      id: "ddddddd1-5555-4555-8555-dddddddddddd",
      sede_id: SEDE_CENTRO,
      full_name: "Cuenta de plataforma",
      id_number: "777",
    });
    dbStub.user_roles.push({
      user_id: "ddddddd1-5555-4555-8555-dddddddddddd",
      code: "superadmin",
    });

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: "ddddddd1-5555-4555-8555-dddddddddddd",
      roles: ["empleado"],
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(dbStub.rpcs).toEqual([]);
    expect(auditStub.entries).toHaveLength(0);
  });

  it("si el rpc responde sin aplicar nada, NO es un éxito", async () => {
    sembrarSedes();
    sembrarUsuarios();
    dbStub.rpcAppliesNothing = true;
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_CAJA,
      roles: ["admin"],
    });

    expect(result).toMatchObject({ success: false, code: "INTERNAL" });
    // El usuario conserva el conjunto viejo: la post-condición no pasa por alto
    // un rpc "sin error" que no escribió nada.
    expect(dbStub.user_roles.filter((fila) => fila.user_id === USUARIO_CENTRO_CAJA)).toEqual([
      { user_id: USUARIO_CENTRO_CAJA, code: "caja" },
    ]);
  });

  it("el `USER_NOT_FOUND` del rpc se traduce a 404", async () => {
    sembrarSedes();
    sembrarUsuarios();
    dbStub.failRpc = { code: "P0001", message: "USER_NOT_FOUND" };
    asSession(["superadmin"]);

    const result = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_CAJA,
      roles: ["admin"],
    });

    expect(result).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(auditStub.entries).toHaveLength(0);
  });

  it("un admin de sede NO llega ni a la lista ni al cambio de roles", async () => {
    sembrarSedes();
    sembrarUsuarios();
    asSession(["admin"]);

    const listado = await listPlatformSedeUsersAction({ sede_id: SEDE_CENTRO });
    const cambio = await setPlatformSedeUserRolesAction({
      sede_id: SEDE_CENTRO,
      user_id: USUARIO_CENTRO_CAJA,
      roles: ["admin"],
    });

    expect(listado).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(cambio).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(dbStub.reads).toBe(0);
    expect(dbStub.rpcs).toEqual([]);
  });

  it("las dos funciones re-aplican el rol por sí mismas", async () => {
    sembrarSedes();
    sembrarUsuarios();
    const actor = {
      userId: "u",
      sedeId: SEDE_PLATAFORMA,
      roles: ["admin"],
    } satisfies PlatformActor;

    await expect(
      listPlatformSedeUsers({ sede_id: SEDE_CENTRO }, actor),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      setPlatformSedeUserRoles(
        { sede_id: SEDE_CENTRO, user_id: USUARIO_CENTRO_CAJA, roles: ["admin"] },
        actor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dbStub.reads).toBe(0);
  });
});

describe("plataforma: estructura de la administración de sedes (G5)", () => {
  const servicio = readSource(SERVICE_FILE);
  const acciones = readSource("src/features/platform/actions.ts");
  const isla = readSource(CLIENT_FILE);

  it("las tres funciones re-aplican el rol y no usan la frontera del negocio", () => {
    for (const nombre of [
      "createPlatformSede",
      "listPlatformSedeUsers",
      "setPlatformSedeUserRoles",
    ]) {
      const body = functionBody(servicio, nombre);
      expect(body, `no se encontró \`${nombre}\` en el servicio`).not.toBe("");
      expect(stripComments(body)).toContain("PLATFORM_ROLES");
      expect(stripComments(body)).not.toContain("resolveSede");
    }

    // Control negativo: una función que resolviera la sede del actor se reporta.
    const sintetico = `export async function createPlatformSede(raw: unknown, actor: PlatformActor) {
  const sede = resolveSede(actor.sedeId);
  return db.from("sedes").insert({ name: raw }).eq("id", sede);
}`;
    expect(stripComments(functionBody(sintetico, "createPlatformSede"))).toContain("resolveSede");
  });

  it("el cuerpo del alta NO admite `id`: desde la plataforma no se edita una sede", () => {
    // El `id` se omite del esquema, así que ni siquiera llega a la escritura.
    expect(servicio).toContain("sedeSchema.omit({ id: true })");

    const campos = /const \{([^}]*)\} = parsed\.data;/.exec(
      stripComments(functionBody(servicio, "createPlatformSede")),
    );
    expect(campos, "no se encontró la lectura del cuerpo validado del alta").not.toBeNull();
    expect(campos?.[1], "el cuerpo del alta no puede leer un `id`").not.toContain("id");

    // Control negativo: leer el `id` se reporta, porque es justo lo que abriría
    // la edición por `upsert`.
    const sintetico = `export async function createPlatformSede(raw: unknown) {
  const parsed = createPlatformSedeSchema.safeParse(raw);
  const { name, id } = parsed.data;
  return db.from("sedes").upsert({ id, name });
}`;
    const leido = /const \{([^}]*)\} = parsed\.data;/.exec(stripComments(sintetico));
    expect(leido?.[1]).toContain("id");
  });

  it("el reemplazo de roles viaja en el rpc atómico, no en escrituras sueltas", () => {
    const body = stripComments(functionBody(servicio, "setPlatformSedeUserRoles"));
    expect(body).toContain('db.rpc("replace_user_roles"');
    // Un DELETE + un INSERT sueltos serían DOS sentencias sin transacción.
    expect(body).not.toContain('from("user_roles").insert');
    expect(body).not.toContain('from("user_roles").delete');
  });

  it("el conjunto asignable es el de sede: el rol de plataforma no se ofrece", () => {
    // El cuerpo acepta el catálogo completo (para poder responder 403 con el
    // motivo) y la puerta decide; el filtro es `isSedeAssignableRole`, la misma
    //derivación que usa el negocio.
    const body = stripComments(functionBody(servicio, "setPlatformSedeUserRoles"));
    expect(body).toContain("isSedeAssignableRole");
    expect(body).toContain("FORBIDDEN");

    // Y la pantalla no lo ofrece: su lista de opciones es la de sede.
    const opciones = /const OPCIONES_DE_ROL[\s\S]*?\n\];/.exec(stripComments(isla));
    expect(opciones, "no se encontró la lista de roles de la pantalla").not.toBeNull();
    expect(opciones?.[0]).not.toContain("superadmin");
    for (const valor of ["admin", "caja", "empleado"]) {
      expect(opciones?.[0], `la pantalla no ofrece el rol ${valor}`).toContain(`"${valor}"`);
    }
  });

  it("la pantalla reconoce la fila del sistema por la marca de dato, no por su nombre", () => {
    expect(hardcodesPlatformName(isla)).toBe(false);
    expect(hardcodesPlatformName(readSource(PAGE_FILE))).toBe(false);
    // La fila del sistema no ofrece ni nómina ni roles: se decide por `is_platform`.
    expect(stripComments(readSource(PAGE_FILE))).toContain("sede.is_platform");
  });

  it("las dos acciones de G5 quedan declaradas en el vocabulario cerrado", () => {
    expect(AUDIT_ACTIONS.PLATFORM_SEDE_CREATED).toBe("platform.sede_created");
    expect(AUDIT_ACTIONS.PLATFORM_SEDE_ROLES_SET).toBe("platform.sede_roles_set");
    expect(stripComments(acciones)).not.toContain("platform.sede_created");
    expect(stripComments(acciones)).not.toContain("platform.sede_roles_set");
  });

  it("no entran a ningún catálogo de alertas: son configuración, no desvíos", () => {
    for (const archivo of ["src/features/alerts/service.ts", "src/features/alerts/schemas.ts"]) {
      const fuente = readSource(archivo);
      expect(fuente, `${archivo} menciona una acción de G5`).not.toContain("PLATFORM_SEDE_CREATED");
      expect(fuente, `${archivo} menciona una acción de G5`).not.toContain("PLATFORM_SEDE_ROLES_SET");
      expect(fuente).not.toContain("platform.sede_created");
      expect(fuente).not.toContain("platform.sede_roles_set");
    }
  });
});
