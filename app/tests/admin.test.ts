import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areEmployeeCodesConflicting,
  checkPayCoherence,
  employeeSchema,
  isEmployeeCodeMissing,
  normalizeEmployeeCode,
  paymentMethodSchema,
  sedeSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
} from "@/src/features/admin/schemas";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import { AdminError, setUserRoles } from "@/src/features/admin/service";

const SEDE_A = "11111111-1111-4111-8111-111111111111";
const SEDE_B = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "55555555-5555-4555-8555-555555555555";

// ---------------------------------------------------------------- dobles ---

/**
 * Doble mínimo de PostgREST para el reemplazo de roles (CO-2).
 *
 * Modela lo único que importa aquí y que el servicio NO puede cambiar desde el
 * cliente:
 *   * `.from(tabla).delete()` / `.insert()` son requests INDEPENDIENTES: cada
 *     uno confirma por su cuenta (PostgREST no ofrece multi-statement por
 *     request; la nota ya existe en el README de facturación para
 *     `createInvoice`). Entre dos de ellos no hay transacción posible.
 *   * `rpc(nombre, args)` es UNA sentencia: corre entera dentro de una sola
 *     transacción del servidor, así que o aplica todo o no aplica nada. Esa
 *     garantía es de PostgreSQL (BEGIN … COMMIT/ROLLBACK), no de este doble:
 *     el doble sólo la imita (calcula el estado nuevo y lo confirma al final).
 *
 * Lo que las pruebas fijan del CÓDIGO es la forma de la llamada (un solo rpc,
 * cero escrituras sueltas sobre `user_roles`) y la invariante observable: tras
 * cualquier fallo el usuario conserva el conjunto viejo, nunca ninguno.
 */
const postgrest = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Escrituras sueltas por `.from()`: "user_roles.delete", "user_roles.insert". */
  singleWrites: [] as string[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Fallo inyectable en una escritura puntual (el caso del hallazgo). */
  failWrite: null as null | {
    table: string;
    op: "insert" | "delete";
    error: { code: string; message: string };
  },
  /** El rpc responde éxito pero sin aplicar nada (control negativo). */
  rpcAppliesNothing: false,
  /** Retiene el rpc en vuelo hasta `liberar()` (prueba de concurrencia). */
  hold: false,
  pendientes: [] as Array<() => void>,
  liberar: () => {
    for (const resolver of postgrest.pendientes.splice(0)) resolver();
  },
}));

const ROLES_CATALOGO = [
  { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", code: "admin" },
  { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", code: "empleado" },
  { id: "cccccccc-3333-4333-8333-cccccccccccc", code: "caja" },
];

type Filtro = { column: string; values: unknown[] };

function cumpleFiltros(row: Record<string, unknown>, filtros: Filtro[]): boolean {
  return filtros.every((filtro) => filtro.values.includes(row[filtro.column]));
}

function memoryRows(table: string): Array<Record<string, unknown>> {
  return postgrest.rows[table] ?? [];
}

function codeDeRol(roleId: string): string {
  return String(memoryRows("roles").find((rol) => rol.id === roleId)?.code ?? "");
}

/**
 * Modelo del RPC: una sola sentencia, una sola transacción. El estado nuevo se
 * calcula antes de confirmarlo; cualquier fallo devuelve el error sin haber
 * tocado ninguna fila (el DELETE interno también se revierte).
 */
function aplicarRpc(fn: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
  if (fn !== "replace_user_roles") {
    return {
      data: null,
      error: { code: "PGRST202", message: `no existe la función ${fn}` },
    };
  }
  if (postgrest.rpcAppliesNothing) return { data: [], error: null };

  const userId = String(args.p_user_id);
  const pedidos = [...new Set((args.p_role_codes ?? []) as string[])];

  if (!memoryRows("users").some((usuario) => usuario.id === userId)) {
    return { data: null, error: { code: "P0001", message: "USER_NOT_FOUND" } };
  }

  const aplicados = memoryRows("roles").filter((rol) => pedidos.includes(String(rol.code)));
  if (pedidos.length === 0 || aplicados.length !== pedidos.length) {
    return { data: null, error: { code: "P0001", message: "ROLE_NOT_FOUND" } };
  }

  if (postgrest.failWrite?.table === "user_roles" && postgrest.failWrite.op === "insert") {
    return { data: null, error: postgrest.failWrite.error };
  }

  postgrest.rows.user_roles = [
    ...memoryRows("user_roles").filter((fila) => fila.user_id !== userId),
    ...aplicados.map((rol) => ({ user_id: userId, role_id: rol.id })),
  ];
  return { data: aplicados.map((rol) => String(rol.code)).sort(), error: null };
}

function createStubClient() {
  const from = (table: string) => {
    const filtros: Filtro[] = [];
    let modo: "select" | "delete" | "insert" = "select";
    let payload: unknown;
    let ejecutado: { data: unknown; error: unknown } | null = null;

    const run = (): { data: unknown; error: unknown } => {
      if (ejecutado) return ejecutado;
      const filas = memoryRows(table);

      if (modo === "delete") {
        postgrest.singleWrites.push(`${table}.delete`);
        if (postgrest.failWrite?.table === table && postgrest.failWrite.op === "delete") {
          ejecutado = { data: null, error: postgrest.failWrite.error };
          return ejecutado;
        }
        postgrest.rows[table] = filas.filter((fila) => !cumpleFiltros(fila, filtros));
        ejecutado = { data: null, error: null };
        return ejecutado;
      }

      if (modo === "insert") {
        postgrest.singleWrites.push(`${table}.insert`);
        if (postgrest.failWrite?.table === table && postgrest.failWrite.op === "insert") {
          ejecutado = { data: null, error: postgrest.failWrite.error };
          return ejecutado;
        }
        const valores = (Array.isArray(payload) ? payload : [payload]) as Array<
          Record<string, unknown>
        >;
        // FK real de 002_auth.sql: user_roles.user_id -> users.id.
        if (
          table === "user_roles" &&
          valores.some((fila) => !memoryRows("users").some((usuario) => usuario.id === fila.user_id))
        ) {
          ejecutado = { data: null, error: { code: "23503", message: "viola la FK de users" } };
          return ejecutado;
        }
        postgrest.rows[table] = [...filas, ...valores];
        ejecutado = { data: null, error: null };
        return ejecutado;
      }

      ejecutado = { data: filas.filter((fila) => cumpleFiltros(fila, filtros)), error: null };
      return ejecutado;
    };

    const query: Record<string, unknown> = {
      select: () => query,
      delete: () => {
        modo = "delete";
        return query;
      },
      insert: (values?: unknown) => {
        modo = "insert";
        payload = values;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filtros.push({ column, values: [value] });
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filtros.push({ column, values });
        return query;
      },
      or: () => query,
      is: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      single: () => Promise.resolve(run()),
      maybeSingle: () => {
        const resultado = run();
        return Promise.resolve({
          data: (resultado.data as Array<Record<string, unknown>> | null)?.[0] ?? null,
          error: resultado.error,
        });
      },
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return query;
  };

  const rpc = (fn: string, args: Record<string, unknown>) => {
    postgrest.rpcCalls.push({ fn, args });
    if (postgrest.hold) {
      return new Promise((resolve) => {
        postgrest.pendientes.push(() => resolve(aplicarRpc(fn, args)));
      });
    }
    return Promise.resolve(aplicarRpc(fn, args));
  };

  return { from, rpc };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createStubClient(),
}));

// -------------------------------------------------- reemplazo atómico ---

describe("admin: reemplazo de roles atómico (ADM-04 / CO-2)", () => {
  function sembrar(codes: string[]): void {
    postgrest.rows.users = [
      { id: USUARIO_ID, sede_id: SEDE_A, full_name: "Ana Rojas", id_number: "99" },
    ];
    postgrest.rows.roles = ROLES_CATALOGO.map((rol) => ({ ...rol }));
    postgrest.rows.user_roles = codes.map((code) => ({
      user_id: USUARIO_ID,
      role_id: ROLES_CATALOGO.find((rol) => rol.code === code)?.id,
    }));
  }

  function rolesPersistidos(): string[] {
    return memoryRows("user_roles")
      .filter((fila) => fila.user_id === USUARIO_ID)
      .map((fila) => codeDeRol(String(fila.role_id)))
      .sort();
  }

  beforeEach(() => {
    postgrest.rows = {};
    postgrest.singleWrites.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.failWrite = null;
    postgrest.rpcAppliesNothing = false;
    postgrest.hold = false;
    postgrest.pendientes.length = 0;
  });

  it("un fallo de la escritura no deja al usuario sin roles", async () => {
    sembrar(["empleado"]);
    postgrest.failWrite = {
      table: "user_roles",
      op: "insert",
      error: { code: "23503", message: "escritura rechazada" },
    };

    await expect(
      setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] }),
    ).rejects.toBeInstanceOf(AdminError);

    // NUNCA cero roles: el usuario conserva el conjunto viejo.
    expect(rolesPersistidos()).toEqual(["empleado"]);
  });

  it("un reemplazo exitoso deja exactamente el conjunto pedido", async () => {
    sembrar(["empleado"]);

    const resultado = await setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] });

    expect(resultado).toEqual({ user_id: USUARIO_ID, roles: ["admin"] });
    expect(rolesPersistidos()).toEqual(["admin"]);
  });

  it("dos reemplazos simultáneos no mezclan conjuntos", async () => {
    sembrar(["empleado"]);

    // El rpc queda EN VUELO hasta liberarlo: así los dos reemplazos se solapan
    // de verdad y la prueba mira el resultado final, no el orden de llegada.
    postgrest.hold = true;
    const primero = setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const segundo = setUserRoles({ user_id: USUARIO_ID, roles: ["caja"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Un solo statement por reemplazo, y los dos escritores a la vez.
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual([
      "replace_user_roles",
      "replace_user_roles",
    ]);
    expect(postgrest.singleWrites).toEqual([]);

    postgrest.liberar();
    const [a, b] = await Promise.allSettled([primero, segundo]);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    // Serializados uno tras otro: el último gana. Nunca la unión ni el vacío.
    expect(rolesPersistidos()).toEqual(["caja"]);
  });

  it("rol inexistente en el catálogo: rechaza y conserva los roles actuales", async () => {
    sembrar(["empleado"]);
    postgrest.rows.roles = ROLES_CATALOGO.filter((rol) => rol.code !== "caja").map((rol) => ({
      ...rol,
    }));

    await expect(setUserRoles({ user_id: USUARIO_ID, roles: ["caja"] })).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
    });

    expect(rolesPersistidos()).toEqual(["empleado"]);
  });

  it("usuario inexistente: rechaza con NOT_FOUND y no escribe nada", async () => {
    postgrest.rows.users = [];
    postgrest.rows.roles = ROLES_CATALOGO.map((rol) => ({ ...rol }));
    postgrest.rows.user_roles = [];

    await expect(setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });

    expect(memoryRows("user_roles")).toEqual([]);
  });

  it("control negativo: el reemplazo viaja en UNA sentencia, no en un delete + insert sueltos", async () => {
    sembrar(["empleado"]);

    await setUserRoles({ user_id: USUARIO_ID, roles: ["caja"] });

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["replace_user_roles"]);
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("control negativo: si la base no aplicó ningún rol, el servicio no reporta éxito", async () => {
    sembrar(["empleado"]);
    postgrest.rpcAppliesNothing = true;

    await expect(
      setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] }),
    ).rejects.toBeInstanceOf(AdminError);

    expect(rolesPersistidos()).toEqual(["empleado"]);
  });
});

function baseEmployee(overrides: Record<string, unknown> = {}) {
  return {
    sede_id: SEDE_A,
    full_name: "Carolina Rojas",
    document: "123456",
    pay_type: "fijo",
    salary_fixed: 1000000,
    ...overrides,
  };
}

describe("admin schemas: sede", () => {
  it("acepta sede con nombre y rechaza nombre vacío", () => {
    expect(sedeSchema.safeParse({ name: "Sede principal" }).success).toBe(true);
    expect(sedeSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("admin schemas: empleado y pay_type coherente (ADM-08)", () => {
  it("fijo exige salary_fixed y rechaza comisión", () => {
    expect(baseEmployee().pay_type).toBe("fijo");
    expect(employeeSchema.safeParse(baseEmployee()).success).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ full_name: "A" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ full_name: "  " })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ payout_mode: "quincenal" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ email: "no-es-correo" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ birth_date: "mañana" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ birth_date: "2999-01-01" })).success).toBe(false);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ payout_mode: "inmediato", email: "a@b.co", birth_date: "1990-05-01" }),
      ).success,
    ).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ salary_fixed: null })).success).toBe(false);
    expect(
      employeeSchema.safeParse(baseEmployee({ commission_percent: 10 })).success,
    ).toBe(false);
  });

  it("porcentaje exige commission_percent y rechaza fijo", () => {
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 15 })).success,
    ).toBe(true);
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "porcentaje", salary_fixed: null })).success,
    ).toBe(false);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "porcentaje", salary_fixed: 500000, commission_percent: 15 }),
      ).success,
    ).toBe(false);
  });

  it("mixto exige ambos montos", () => {
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "mixto", salary_fixed: 800000, commission_percent: 10 }),
      ).success,
    ).toBe(true);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "mixto", salary_fixed: null, commission_percent: 10 }),
      ).success,
    ).toBe(false);
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "mixto", salary_fixed: 800000 })).success,
    ).toBe(false);
  });

  it("rechaza comisión fuera de 0–100 y salario negativo", () => {
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 101 }),
      ).success,
    ).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ salary_fixed: -1 })).success).toBe(false);
  });

  it("checkPayCoherence describe cada caso", () => {
    expect(checkPayCoherence({ pay_type: "fijo", salary_fixed: 1, commission_percent: null })).toBeNull();
    expect(checkPayCoherence({ pay_type: "fijo", salary_fixed: null, commission_percent: null })).not.toBeNull();
    expect(
      checkPayCoherence({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 5 }),
    ).toBeNull();
    expect(
      checkPayCoherence({ pay_type: "mixto", salary_fixed: 1, commission_percent: 5 }),
    ).toBeNull();
  });
});

describe("admin schemas: birth_date futura según el día de Bogotá", () => {
  // 2026-09-25T01:00:00Z = 2026-09-24 20:00 en Bogotá (UTC-05:00): el día UTC
  // ya es el 25, pero en Bogotá todavía es el 24.
  it("rechaza el 25 y acepta el 24 cuando en Bogotá todavía es el 24", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T01:00:00.000Z"));
    try {
      expect(employeeSchema.safeParse(baseEmployee({ birth_date: "2026-09-25" })).success).toBe(
        false,
      );
      expect(employeeSchema.safeParse(baseEmployee({ birth_date: "2026-09-24" })).success).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("admin: unicidad parcial de employee_code (ADM-03)", () => {
  it("vacío/nulo/espacios se normalizan a null (repetible)", () => {
    expect(normalizeEmployeeCode(null)).toBeNull();
    expect(normalizeEmployeeCode(undefined)).toBeNull();
    expect(normalizeEmployeeCode("")).toBeNull();
    expect(normalizeEmployeeCode("   ")).toBeNull();
    expect(normalizeEmployeeCode(" EMP-01 ")).toBe("EMP-01");
    expect(isEmployeeCodeMissing("")).toBe(true);
    expect(isEmployeeCodeMissing("EMP-01")).toBe(false);
  });

  it("dos códigos con valor iguales en la misma sede colisionan", () => {
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_A, codeB: "EMP-01" }),
    ).toBe(true);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_A, codeB: "EMP-02" }),
    ).toBe(false);
  });

  it("vacíos nunca colisionan y sedes distintas nunca colisionan", () => {
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "", sedeIdB: SEDE_A, codeB: "" }),
    ).toBe(false);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: null, sedeIdB: SEDE_A, codeB: "EMP-01" }),
    ).toBe(false);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_B, codeB: "EMP-01" }),
    ).toBe(false);
  });

  it("el esquema acepta código vacío (repetible por sede)", () => {
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: "" })).success).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: null })).success).toBe(true);
  });
});

describe("admin schemas: servicio min<=max (ADM-05)", () => {
  function baseService(overrides: Record<string, unknown> = {}) {
    return {
      sede_id: SEDE_A,
      name: "Corte",
      price: 50000,
      duracion_min: 30,
      duracion_max: 60,
      ...overrides,
    };
  }

  it("acepta rango válido e igual (min == max)", () => {
    expect(serviceSchema.safeParse(baseService()).success).toBe(true);
    expect(serviceSchema.safeParse(baseService({ duracion_min: 45, duracion_max: 45 })).success).toBe(
      true,
    );
  });

  it("rechaza min > max y valores negativos", () => {
    expect(serviceSchema.safeParse(baseService({ duracion_min: 90, duracion_max: 60 })).success).toBe(
      false,
    );
    expect(serviceSchema.safeParse(baseService({ price: -1 })).success).toBe(false);
    expect(serviceSchema.safeParse(baseService({ duracion_min: -5 })).success).toBe(false);
  });
});

describe("admin schemas: impuestos y métodos (ADM-06/ADM-07)", () => {
  it("percent acepta 0–100 y rechaza fuera de rango", () => {
    const base = { sede_id: SEDE_A, code: "IVA", name: "IVA general" };
    expect(taxConfigSchema.safeParse({ ...base, percent: 19 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 0 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 100 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: -1 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, percent: 101 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, code: "OTRO", percent: 5 }).success).toBe(false);
  });

  it("solo acepta códigos del catálogo Colombia", () => {
    const base = { sede_id: SEDE_A, name: "Nequi" };
    for (const code of ["efectivo", "transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"]) {
      expect(paymentMethodSchema.safeParse({ ...base, code }).success).toBe(true);
    }
    expect(paymentMethodSchema.safeParse({ ...base, code: "bitcoin" }).success).toBe(false);
    expect(paymentMethodSchema.safeParse({ ...base, code: "PSE" }).success).toBe(false);
  });

  it("setUserRoles exige un solo rol válido (ADM-04)", () => {
    expect(
      setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["admin"] }).success,
    ).toBe(true);
    expect(
      setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["empleado", "caja"] }).success,
    ).toBe(false);
    expect(setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: [] }).success).toBe(false);
    expect(setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["dueño"] }).success).toBe(false);
  });
});

describe("admin: requireSedeRole y resolveSede (puros)", () => {
  it("admin pasa el gate de escritura; empleado/caja no", () => {
    expect(() => requireSedeRole(["admin"], ["admin"])).not.toThrow();
    expect(() => requireSedeRole(["empleado", "caja"], ["empleado", "caja"])).not.toThrow();
    try {
      requireSedeRole(["empleado"], ["admin"]);
      expect.unreachable("debió lanzar FORBIDDEN");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("FORBIDDEN");
      expect((error as AdminError).status).toBe(403);
    }
  });

  it("resolveSede usa la sede de la sesión y rechaza sede ajena", () => {
    expect(resolveSede(SEDE_A)).toBe(SEDE_A);
    expect(resolveSede(SEDE_A, SEDE_A)).toBe(SEDE_A);
    expect(() => resolveSede(SEDE_A, SEDE_B)).toThrowError(AdminError);
  });
});

describe("migración 039_atomic_role_replacement.sql (CO-2)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "039_atomic_role_replacement.sql"),
    "utf8",
  );

  it("crea la función de reemplazo que el servicio llama por rpc", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.replace_user_roles");
    expect(sql).toContain("p_user_id uuid, p_role_codes text[]");
    expect(sql).toContain("RETURNS text[]");
  });

  it("toma el lock de la fila del usuario ANTES de escribir el reemplazo", () => {
    const lock = sql.indexOf("FOR UPDATE");
    const borrado = sql.indexOf("DELETE FROM public.user_roles");
    const insercion = sql.indexOf("INSERT INTO public.user_roles");

    expect(lock, "falta el candado de la fila del usuario").toBeGreaterThan(-1);
    expect(borrado).toBeGreaterThan(lock);
    expect(insercion).toBeGreaterThan(borrado);
  });

  it("aborta si no quedó exactamente el conjunto validado (nunca cero roles)", () => {
    // La red dentro de la transacción: sin ella, el reemplazo que no escribe
    // nada confirmaría el DELETE y dejaría al usuario sin ningún rol.
    expect(sql).toContain("GET DIAGNOSTICS v_filas = ROW_COUNT");
    expect(sql).toContain("v_codes IS NULL");
    expect(sql).toContain("cardinality(v_codes) = 0");
    expect(sql).toContain("v_filas <> cardinality(v_codes)");
    expect(sql).toContain("RAISE EXCEPTION 'ROLE_NOT_FOUND'");
    expect(sql).toContain("RAISE EXCEPTION 'USER_NOT_FOUND'");
  });

  it("rechaza el arreglo vacío y los códigos desconocidos", () => {
    expect(sql).toContain("cardinality(p_role_codes) = 0");
    expect(sql).toContain("v_desconocidos > 0");
  });

  it("no borra ni reescribe filas de datos existentes", () => {
    // Se miran SENTENCIAS (ancladas al inicio de línea), no la prosa del
    // encabezado, que justamente explica qué no hace el archivo.
    expect(sql).not.toMatch(/^\s*DELETE FROM public\.(users|roles)\b/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\.(users|roles|user_roles)\b/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
  });

  it("es idempotente, con search_path fijo y sin DEFINER", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain("ALTER FUNCTION public.replace_user_roles(uuid, text[]) SET search_path = public");
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM anon");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, text[]) FROM authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.replace_user_roles(uuid, text[]) TO service_role",
    );
  });

  it("declara que el agente no la ejecutó", () => {
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

describe("migración 003_admin.sql (T3)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "003_admin.sql"), "utf8");

  it("crea las 5 tablas con triggers set_updated_at", () => {
    for (const table of ["sedes", "employees", "services", "tax_configs", "payment_methods"]) {
      expect(sql).toContain(`CREATE TABLE public.${table}`);
      expect(sql).toContain(`ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("set_updated_at()");
  });

  it("declara la unicidad parcial de employee_code solo con valor", () => {
    expect(sql).toContain("uq_employees_sede_code");
    expect(sql).toContain("WHERE employee_code IS NOT NULL");
  });

  it("vuelve users.sede_id NOT NULL con FK tras asignar la sede inicial", () => {
    expect(sql).toContain("Sede principal");
    expect(sql).toContain("ALTER COLUMN sede_id SET NOT NULL");
    expect(sql).toContain("fk_users_sede");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    for (const policy of [
      "pol_sedes_sede_isolation",
      "pol_employees_sede_isolation",
      "pol_services_sede_isolation",
      "pol_tax_configs_sede_isolation",
      "pol_payment_methods_sede_isolation",
    ]) {
      expect(sql).toContain(`CREATE POLICY ${policy}`);
    }
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("seed: 6 métodos de pago + IVA 19% e ICA inactivos", () => {
    for (const code of ["efectivo", "transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"]) {
      expect(sql).toContain(code);
    }
    expect(sql).toContain("'IVA'");
    expect(sql).toContain("19");
    expect(sql).toContain("'ICA'");
  });
});
