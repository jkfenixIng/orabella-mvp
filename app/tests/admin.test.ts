import { readFileSync, readdirSync } from "node:fs";
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
import { AdminError, setUserRoles, upsertEmployee } from "@/src/features/admin/service";

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
  /** `select()` pedidos: { tabla, columnas } (CO-3: la columna leída importa). */
  selects: [] as Array<{ table: string; columns: string }>,
  /** Fallo de lectura inyectable en una tabla (PostgREST devuelve error). */
  failRead: null as null | { table: string; error: { code: string; message: string } },
  /**
   * Intercalado de otro escritor: se llama justo antes de que la red escriba
   * el rol, es decir entre la decisión y la escritura —el punto exacto de la
   * carrera—. Se dispara tanto antes del insert suelto de la implementación
   * vieja como antes del rpc de la nueva, así que la MISMA prueba describe el
   * mismo intercalado en ambas.
   */
  antesDeEscribirRol: null as null | (() => void),
  /** El rpc responde éxito pero sin aplicar nada (control negativo). */
  rpcAppliesNothing: false,
  /**
   * Fallo inyectable en un rpc puntual: con la red de seguridad ya dentro de
   * una función, un timeout o un permiso denegado llegan por acá y no por
   * `failRead`/`failWrite` (el cliente ya no lee ni escribe `user_roles` de
   * forma suelta).
   */
  failRpc: null as null | { fn: string; error: { code: string; message: string } },
  /** `ensure_user_has_role` responde éxito sin aplicar nada (control negativo). */
  ensureAppliesNothing: false,
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

/**
 * Columnas REALES de las tablas que toca esta ruta, leídas de las migraciones
 * (nunca de una lista escrita a mano). El doble las usa para RECHAZAR un
 * `select` sobre una columna inexistente, como lo hace PostgREST: sin eso la
 * prueba no podría reproducir el defecto de CO-3, porque `user_roles` no tiene
 * `id` (su PK es `(user_id, role_id)`, `002_auth.sql`).
 */
const COLUMNAS_REALES: Record<string, Set<string>> = (() => {
  const tablas = ["users", "roles", "user_roles", "employees"];
  const porTabla: Record<string, Set<string>> = Object.fromEntries(
    tablas.map((tabla) => [tabla, new Set<string>()]),
  );
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const archivo of readdirSync(dir).filter((nombre) => nombre.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, archivo), "utf8");
    for (const tabla of tablas) {
      const cuerpo = sql.match(
        new RegExp(`CREATE TABLE public\\.${tabla}\\s*\\(([\\s\\S]*?)\\n\\);`),
      )?.[1];
      for (const linea of (cuerpo ?? "").split("\n")) {
        const columna = linea
          .split("--")[0]
          .match(/^\s{2}([a-z_][a-z0-9_]*)\s+(uuid|text|boolean|integer|timestamptz|numeric|date)\b/);
        if (columna) porTabla[tabla].add(columna[1]);
      }
      for (const alter of sql.matchAll(new RegExp(`ALTER TABLE public\\.${tabla}\\b[\\s\\S]*?;`, "g"))) {
        for (const agregada of alter[0].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/g)) {
          porTabla[tabla].add(agregada[1]);
        }
      }
    }
  }
  return porTabla;
})();

function columnasReales(tabla: string): Set<string> {
  return COLUMNAS_REALES[tabla] ?? new Set<string>();
}

/** Columnas que un `select()` pide y la tabla NO tiene (PostgREST: 42703). */
function columnasDesconocidas(tabla: string, columns: string): string[] {
  const reales = columnasReales(tabla);
  if (reales.size === 0) return [];
  return columns
    .split(",")
    .map((columna) => columna.trim())
    .filter((columna) => columna.length > 0 && !columna.includes("(") && !reales.has(columna));
}

type Filtro = { column: string; values: unknown[]; negate?: boolean };

function cumpleFiltros(row: Record<string, unknown>, filtros: Filtro[]): boolean {
  return filtros.every((filtro) =>
    filtro.negate
      ? !filtro.values.includes(row[filtro.column])
      : filtro.values.includes(row[filtro.column]),
  );
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
/**
 * Modelo de `ensure_user_has_role` (CO-4): también UNA sentencia, UNA
 * transacción. El lock de la fila del usuario no se imita esperando: el doble
 * sólo confirma el estado nuevo al final, así que dos llamadas simultáneas se
 * resuelven una después de la otra —igual que la transacción real, que
 * serializa por el lock—. Lo que la prueba fija del código es que la red de
 * seguridad ya no decide desde el cliente.
 */
function aplicarEnsure(args: Record<string, unknown>): { data: unknown; error: unknown } {
  const userId = String(args.p_user_id);
  const pedido = String(args.p_role_code ?? "");

  if (!memoryRows("users").some((usuario) => usuario.id === userId)) {
    return { data: null, error: { code: "P0001", message: "USER_NOT_FOUND" } };
  }

  const rol = memoryRows("roles").find((fila) => fila.code === pedido);
  if (!rol) return { data: null, error: { code: "P0001", message: "ROLE_NOT_FOUND" } };
  if (postgrest.ensureAppliesNothing) return { data: [], error: null };

  // La intención de la red: sólo escribe si el usuario NO tiene NINGÚN rol.
  const existentes = memoryRows("user_roles").filter((fila) => fila.user_id === userId);
  if (existentes.length === 0) {
    postgrest.rows.user_roles = [
      ...memoryRows("user_roles"),
      { user_id: userId, role_id: rol.id },
    ];
  }

  // Post-condición real: el conjunto que quedó, no el que se pidió.
  const resultantes = memoryRows("user_roles")
    .filter((fila) => fila.user_id === userId)
    .map((fila) => codeDeRol(String(fila.role_id)))
    .sort();
  return { data: resultantes, error: null };
}

function aplicarRpc(fn: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
  if (postgrest.failRpc?.fn === fn) return { data: null, error: postgrest.failRpc.error };
  if (fn === "ensure_user_has_role") return aplicarEnsure(args);
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
    let modo: "select" | "delete" | "insert" | "upsert" = "select";
    let payload: unknown;
    let columnas: string | undefined;
    let onConflict: string | undefined;
    let ejecutado: { data: unknown; error: unknown } | null = null;

    const run = (): { data: unknown; error: unknown } => {
      if (ejecutado) return ejecutado;
      let filas = memoryRows(table);

      // Fallo de lectura inyectable: lo que se prueba es que un error de
      // lectura NUNCA se convierta en "el usuario no tiene roles".
      if (modo === "select" && postgrest.failRead?.table === table) {
        ejecutado = { data: null, error: postgrest.failRead.error };
        return ejecutado;
      }

      // PostgREST falla la request COMPLETA si el `select` pide una columna que
      // la tabla no tiene (42703): no devuelve filas vacías.
      if (columnas) {
        const inexistentes = columnasDesconocidas(table, columnas);
        if (inexistentes.length > 0) {
          ejecutado = {
            data: null,
            error: {
              code: "42703",
              message: `column ${table}.${inexistentes.join(", ")} does not exist`,
            },
          };
          return ejecutado;
        }
      }

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
        if (table === "user_roles") {
          postgrest.antesDeEscribirRol?.();
          // El otro escritor pudo REEMPLAZAR el arreglo de filas: el insert
          // real lee las filas confirmadas al momento de escribir, no la
          // foto tomada antes del intercalado.
          filas = memoryRows(table);
        }
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
        // PK real de 002_auth.sql: (user_id, role_id). Un segundo insert de la
        // misma fila es 23505, no una fila duplicada inventada.
        if (
          table === "user_roles" &&
          valores.some((nueva) =>
            filas.some(
              (fila) => fila.user_id === nueva.user_id && fila.role_id === nueva.role_id,
            ),
          )
        ) {
          ejecutado = {
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint \"user_roles_pkey\"" },
          };
          return ejecutado;
        }
        postgrest.rows[table] = [...filas, ...valores];
        ejecutado = { data: null, error: null };
        return ejecutado;
      }

      if (modo === "upsert") {
        postgrest.singleWrites.push(`${table}.upsert`);
        const nuevas = (Array.isArray(payload) ? payload : [payload]) as Array<
          Record<string, unknown>
        >;
        const clave = onConflict ?? "id";
        const escritas: Array<Record<string, unknown>> = [];
        for (const nueva of nuevas) {
          // `id` lo genera la base (gen_random_uuid): el doble lo inventa para
          // que la fila devuelta tenga identidad, como en el servidor.
          const completa: Record<string, unknown> = {
            ...nueva,
            id: nueva.id ?? `generado-${filas.length + escritas.length + 1}`,
          };
          const previa = filas.findIndex((fila) => fila[clave] === completa[clave]);
          if (previa >= 0) filas[previa] = { ...filas[previa], ...completa };
          else filas.push(completa);
          escritas.push(completa);
        }
        postgrest.rows[table] = filas;
        ejecutado = { data: escritas, error: null };
        return ejecutado;
      }

      ejecutado = { data: filas.filter((fila) => cumpleFiltros(fila, filtros)), error: null };
      return ejecutado;
    };

    const query: Record<string, unknown> = {
      select: (columns?: string) => {
        if (columns) {
          columnas = columns;
          postgrest.selects.push({ table, columns });
        }
        return query;
      },
      delete: () => {
        modo = "delete";
        return query;
      },
      insert: (values?: unknown) => {
        modo = "insert";
        payload = values;
        return query;
      },
      upsert: (values?: unknown, options?: { onConflict?: string }) => {
        modo = "upsert";
        payload = values;
        onConflict = options?.onConflict;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filtros.push({ column, values: [value] });
        return query;
      },
      neq: (column: string, value: unknown) => {
        filtros.push({ column, values: [value], negate: true });
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
      single: () => {
        const resultado = run();
        const primera = (resultado.data as Array<Record<string, unknown>> | null)?.[0] ?? null;
        return Promise.resolve({ data: primera, error: resultado.error });
      },
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
    const ejecutar = () => {
      // El intercalado de la carrera ocurre justo antes de que la red escriba.
      if (fn === "ensure_user_has_role") postgrest.antesDeEscribirRol?.();
      return aplicarRpc(fn, args);
    };
    if (postgrest.hold) {
      return new Promise((resolve) => {
        postgrest.pendientes.push(() => resolve(ejecutar()));
      });
    }
    return Promise.resolve(ejecutar());
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
    postgrest.selects.length = 0;
    postgrest.failWrite = null;
    postgrest.failRead = null;
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

describe("migración 040_ensure_user_has_role.sql (CO-4)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "040_ensure_user_has_role.sql"),
    "utf8",
  );

  it("crea la función que la red de seguridad llama por rpc", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.ensure_user_has_role");
    expect(sql).toContain("p_user_id uuid, p_role_code text");
    expect(sql).toContain("RETURNS text[]");
  });

  it("toma el lock de la fila del usuario ANTES de escribir el rol", () => {
    const lock = sql.indexOf("FOR UPDATE");
    const insercion = sql.indexOf("INSERT INTO public.user_roles");

    expect(lock, "falta el candado de la fila del usuario").toBeGreaterThan(-1);
    expect(insercion).toBeGreaterThan(lock);
    // El mismo lock que 039: es lo que serializa a los dos escritores de roles.
    expect(sql).toContain("FROM public.users u");
  });

  it("escribe SÓLO si el usuario no tiene ningún rol (la intención de la red)", () => {
    expect(sql).toContain("AND NOT EXISTS (");
    expect(sql).toContain("SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id");
  });

  it("valida el rol y aborta sin aplicar un subconjunto silencioso", () => {
    expect(sql).toContain("RAISE EXCEPTION 'ROLE_NOT_FOUND'");
    expect(sql).toContain("RAISE EXCEPTION 'USER_NOT_FOUND'");
    expect(sql).toContain("IF v_rol IS NULL THEN");
  });

  it("devuelve el conjunto final y aborta si quedó vacío (nunca cero roles)", () => {
    expect(sql).toContain("GET DIAGNOSTICS v_filas = ROW_COUNT");
    expect(sql).toContain("v_tenia_roles AND v_filas <> 0");
    expect(sql).toContain("NOT v_tenia_roles AND v_filas <> 1");
    expect(sql).toContain("array_agg(r.code ORDER BY r.code)");
    expect(sql).toContain("cardinality(v_resultantes) = 0");
    expect(sql).toContain("RETURN v_resultantes");
  });

  it("no borra ni reescribe filas de datos existentes", () => {
    // Se miran SENTENCIAS (ancladas al inicio de línea), no la prosa del
    // encabezado, que justamente explica qué no hace el archivo.
    expect(sql).not.toMatch(/^\s*DELETE FROM public\./im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
  });

  it("es idempotente, con search_path fijo y sin DEFINER", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain(
      "ALTER FUNCTION public.ensure_user_has_role(uuid, text) SET search_path = public",
    );
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM anon");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.ensure_user_has_role(uuid, text) FROM authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.ensure_user_has_role(uuid, text) TO service_role",
    );
  });

  it("declara que el agente no la ejecutó", () => {
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

// -------------------------- red de seguridad de roles al crear (CO-3) ---
describe("admin: red de seguridad de roles al crear empleado (CO-3)", () => {
  const EMPLEADO_ID = "99999999-9999-4999-8999-999999999999";

  /**
   * El usuario de acceso existe con el documento del empleado: el vínculo es
   * automático por documento, así que esta es la ruta real de `upsertEmployee`
   * y no la de crear usuario.
   */
  function sembrar(roles: string[]): void {
    postgrest.rows.users = [
      { id: USUARIO_ID, sede_id: SEDE_A, id_number: "123456", full_name: "Carolina Rojas" },
    ];
    postgrest.rows.roles = ROLES_CATALOGO.map((rol) => ({ ...rol }));
    postgrest.rows.user_roles = roles.map((code) => ({
      user_id: USUARIO_ID,
      role_id: ROLES_CATALOGO.find((rol) => rol.code === code)?.id,
    }));
    postgrest.rows.employees = [];
  }

  function rolesPersistidos(): string[] {
    return memoryRows("user_roles")
      .filter((fila) => fila.user_id === USUARIO_ID)
      .map((fila) => codeDeRol(String(fila.role_id)))
      .sort();
  }

  function escriturasDeRoles(): string[] {
    return postgrest.singleWrites.filter((escritura) => escritura.startsWith("user_roles."));
  }

  beforeEach(() => {
    postgrest.rows = {};
    postgrest.singleWrites.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.selects.length = 0;
    postgrest.failWrite = null;
    postgrest.failRead = null;
    postgrest.rpcAppliesNothing = false;
    postgrest.failRpc = null;
    postgrest.ensureAppliesNothing = false;
    postgrest.antesDeEscribirRol = null;
    postgrest.hold = false;
    postgrest.pendientes.length = 0;
  });

  it("a quien ya tiene OTRO rol no se le agrega `empleado` (un rol por usuario)", async () => {
    sembrar(["admin"]);

    await upsertEmployee(baseEmployee());

    // El empleado sí se creó: la prueba corre por la red de seguridad.
    expect(memoryRows("employees")).toHaveLength(1);
    expect(rolesPersistidos()).toEqual(["admin"]);
    expect(escriturasDeRoles()).toEqual([]);
    // La decisión viaja en UNA sentencia: la función del servidor.
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["ensure_user_has_role"]);
  });

  it("a quien YA es `empleado` no se le vuelve a insertar el rol", async () => {
    sembrar(["empleado"]);

    await upsertEmployee(baseEmployee());

    expect(rolesPersistidos()).toEqual(["empleado"]);
    expect(escriturasDeRoles()).toEqual([]);
  });

  it("a quien NO tiene ningún rol igual se le asigna `empleado` (la intención sobrevive)", async () => {
    sembrar([]);

    await upsertEmployee(baseEmployee());

    expect(rolesPersistidos()).toEqual(["empleado"]);
  });

  it("carrera red-de-seguridad + reemplazo: nunca dos roles (CO-4)", async () => {
    sembrar([]);
    // El intercalado del hallazgo, en su punto exacto: la red ya decidió
    // "este usuario no tiene ningún rol" y TODAVÍA no escribió, cuando otro
    // escritor (`setUserRoles` → `replace_user_roles`) confirma `admin`.
    postgrest.antesDeEscribirRol = () => {
      postgrest.rows.user_roles = [
        { user_id: USUARIO_ID, role_id: ROLES_CATALOGO.find((rol) => rol.code === "admin")?.id },
      ];
    };

    await upsertEmployee(baseEmployee());

    // El modelo del proyecto es UN rol por usuario (`setUserRolesSchema` exige
    // `.length(1)`): quedar con `admin` + `empleado` es el defecto, no un
    // detalle. Gana el conjunto del otro escritor, porque la red ya no agrega
    // nada cuando el usuario tiene algún rol.
    expect(rolesPersistidos()).toEqual(["admin"]);
  });

  it("carrera simultánea red-de-seguridad + reemplazo: un conjunto, nunca la unión", async () => {
    sembrar([]);

    // Los dos rpc quedan EN VUELO a la vez: el resultado final se mira después
    // de liberarlos, no el orden de llegada.
    postgrest.hold = true;
    const empleado = upsertEmployee(baseEmployee());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reemplazo = setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn).sort()).toEqual([
      "ensure_user_has_role",
      "replace_user_roles",
    ]);
    expect(escriturasDeRoles()).toEqual([]);

    postgrest.liberar();
    const [a, b] = await Promise.allSettled([empleado, reemplazo]);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    // Serializados por el lock de la fila del usuario: el conjunto final es
    // uno de los dos, jamás `admin` + `empleado`.
    expect(rolesPersistidos()).toHaveLength(1);
  });

  it("la red ya no lee ni escribe `user_roles` desde el cliente: la decisión es del servidor", async () => {
    sembrar([]);

    await upsertEmployee(baseEmployee());

    // La red vieja leía una columna de `user_roles` para decidir; esa lectura
    // es la mitad del read-then-insert que CO-4 cierra, así que ya no existe.
    expect(postgrest.selects.filter((select) => select.table === "user_roles")).toEqual([]);
    expect(escriturasDeRoles()).toEqual([]);
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["ensure_user_has_role"]);
    // Y ninguna lectura que quede puede pedir una columna inexistente (CO-3):
    // `user_roles` no tiene `id` (PK compuesta (user_id, role_id), 002_auth.sql).
    expect(columnasReales("user_roles").has("id")).toBe(false);
    for (const lectura of postgrest.selects) {
      const reales = columnasReales(lectura.table);
      if (reales.size === 0) continue;
      for (const columna of lectura.columns.split(",")) {
        expect(reales.has(columna.trim()), `se lee «${columna}», que no existe`).toBe(true);
      }
    }
  });

  it("un fallo de la red NO otorga rol: falla cerrado y sin escribir", async () => {
    sembrar([]);
    postgrest.failRpc = {
      fn: "ensure_user_has_role",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };

    await expect(upsertEmployee(baseEmployee())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    // No se otorga nada y tampoco queda un empleado escrito a medias: la red
    // corre ANTES de la escritura del empleado.
    expect(rolesPersistidos()).toEqual([]);
    expect(escriturasDeRoles()).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("usuario inexistente: aborta con INTERNAL y sin escribir nada", async () => {
    sembrar([]);
    // El usuario desaparece entre el vínculo por documento y la red: la
    // función del servidor no puede dejar el rol, así que aborta.
    postgrest.antesDeEscribirRol = () => {
      postgrest.rows.users = [];
    };

    await expect(upsertEmployee(baseEmployee())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(rolesPersistidos()).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("rol desconocido en el catálogo: aborta con INTERNAL y sin escribir nada", async () => {
    sembrar([]);
    // El catálogo se siembra en 002_auth.sql: si `empleado` falta, el problema
    // es de datos y se reporta, en vez de dejar a la persona sin acceso.
    postgrest.rows.roles = ROLES_CATALOGO.filter((rol) => rol.code !== "empleado").map((rol) => ({
      ...rol,
    }));

    await expect(upsertEmployee(baseEmployee())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(rolesPersistidos()).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("carrera con otro otorgamiento del MISMO rol: ni falla ni duplica (la PK ya no es el mecanismo)", async () => {
    sembrar([]);
    // Otro escritor deja `empleado` justo antes de la red: la PK
    // `(user_id, role_id)` ya no puede chocar, porque la función sólo escribe
    // si el usuario no tiene NINGÚN rol.
    postgrest.antesDeEscribirRol = () => {
      postgrest.rows.user_roles = [
        {
          user_id: USUARIO_ID,
          role_id: ROLES_CATALOGO.find((rol) => rol.code === "empleado")?.id,
        },
      ];
    };

    await upsertEmployee(baseEmployee());

    expect(rolesPersistidos()).toEqual(["empleado"]);
    expect(escriturasDeRoles()).toEqual([]);
  });

  it("un fallo REAL de la escritura de la red sí se propaga (no queda en un console.error)", async () => {
    sembrar([]);
    postgrest.failRpc = {
      fn: "ensure_user_has_role",
      error: { code: "42501", message: "permission denied for function ensure_user_has_role" },
    };

    await expect(upsertEmployee(baseEmployee())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(rolesPersistidos()).toEqual([]);
  });

  it("control negativo: si la base no dejó ningún rol, el servicio no reporta éxito", async () => {
    sembrar([]);
    // El rpc contesta sin error pero sin haber aplicado nada: el conjunto
    // devuelto (vacío) es la post-condición real y contradice la promesa de la
    // red, así que no puede terminar en un alta "exitosa".
    postgrest.ensureAppliesNothing = true;

    await expect(upsertEmployee(baseEmployee())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(rolesPersistidos()).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("un conjunto viejo de dos roles no rompe la red (no se reporta un falso fallo)", async () => {
    sembrar(["admin", "empleado"]);

    // La red reporta el conjunto que la base DEVOLVIÓ, sin asumir que tiene un
    // solo rol: un usuario arrastrado por el bug viejo se deja como está.
    await upsertEmployee(baseEmployee());

    expect(rolesPersistidos()).toEqual(["admin", "empleado"]);
    expect(escriturasDeRoles()).toEqual([]);
  });

  it("control negativo: al actualizar un empleado la red no lee ni escribe roles", async () => {
    sembrar(["admin"]);
    postgrest.rows.employees = [
      {
        id: EMPLEADO_ID,
        sede_id: SEDE_A,
        user_id: USUARIO_ID,
        employee_code: "EMP-01",
        document: "123456",
      },
    ];

    await upsertEmployee(baseEmployee({ id: EMPLEADO_ID, employee_code: "EMP-01" }));

    expect(postgrest.selects.filter((select) => select.table === "user_roles")).toEqual([]);
    expect(escriturasDeRoles()).toEqual([]);
    expect(rolesPersistidos()).toEqual(["admin"]);
    // Tampoco llama la función de la red: al actualizar, los roles no se tocan.
    expect(postgrest.rpcCalls).toEqual([]);
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
