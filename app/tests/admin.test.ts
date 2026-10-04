import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areEmployeeCodesConflicting,
  checkPayCoherence,
  employeeSchema,
  isEmployeeCodeMissing,
  normalizeEmployeeCode,
  payFrequencySchema,
  paymentMethodSchema,
  sedeSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
} from "@/src/features/admin/schemas";
import {
  isRoleCode,
  isSedeAssignableRole,
  roleCodeSchema,
  type RoleCode,
} from "@/src/features/auth/schemas";
import { requireSedeRole, type SedeRole } from "@/src/shared/lib/sede";
import { AdminError, setUserRoles, upsertEmployee } from "@/src/features/admin/service";
import * as adminActions from "@/src/features/admin/actions";

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
  /**
   * CL-15: fallo inyectable en CUALQUIER escritura de una tabla (insert,
   * upsert o delete). Es el mismo punto de fallo para el `upsert` suelto de la
   * implementación vieja y para la escritura de adentro de la función de 054,
   * así que UNA prueba describe el mismo fallo en las dos.
   */
  failWriteTabla: null as null | { table: string; error: { code: string; message: string } },
  /**
   * CL-15: intercalado de otro escritor justo ANTES de la primera escritura de
   * la operación (el `upsert` suelto viejo o la sentencia de 054): es el punto
   * exacto de la carrera de unicidad del alta.
   */
  antesDeEscribir: null as null | (() => void),
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
  { id: "dddddddd-4444-4444-8444-dddddddddddd", code: "superadmin" },
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
  const dir = join(process.cwd(), "supabase", "schema-history");
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
  if (fn === "upsert_employee_atomic") return aplicarUpsertEmpleadoAtomico(args);
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

/**
 * Modelo de `upsert_employee_atomic` (054, CL-15): UNA sentencia, UNA
 * transacción. El estado nuevo se calcula ENTERO —usuario, rol y legajo— antes
 * de confirmarlo, así que un fallo inyectado en cualquiera de las tres
 * escrituras no deja NINGUNA fila: ni el usuario, ni el rol, ni el legajo. Eso
 * es exactamente lo que el cliente no podía garantizar con tres requests.
 *
 * La red de seguridad de roles (040) es PARTE de la misma sentencia: por eso ya
 * no viaja como un rpc aparte, y por eso el lock de la fila del usuario —el
 * mismo de `replace_user_roles`— sigue serializando a los dos escritores.
 */
function aplicarUpsertEmpleadoAtomico(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const empleado = (args.p_employee ?? {}) as Record<string, unknown>;
  const crear = (args.p_create_user ?? null) as Record<string, unknown> | null;
  let usuarios = memoryRows("users");
  let rolesDelUsuario = memoryRows("user_roles");
  let userId = args.p_user_id ? String(args.p_user_id) : null;

  if (crear) {
    // Unicidad REAL de 002_auth.sql (`users.id_number` y `users.email`).
    if (usuarios.some((fila) => fila.id_number === crear.id_number)) {
      return { data: null, error: { code: "P0001", message: "USER_EXISTS" } };
    }
    if (crear.email && usuarios.some((fila) => fila.email === crear.email)) {
      return { data: null, error: { code: "P0001", message: "USER_EXISTS" } };
    }
    if (postgrest.failWriteTabla?.table === "users") {
      return { data: null, error: postgrest.failWriteTabla.error };
    }
    userId = `usuario-generado-${usuarios.length + 1}`;
    // AUTH-01: la clave inicial es el documento y el cambio es obligatorio.
    usuarios = [...usuarios, { ...crear, id: userId, must_change_password: true }];
  } else if (!userId || !usuarios.some((fila) => fila.id === userId)) {
    return { data: null, error: { code: "P0001", message: "USER_NOT_FOUND" } };
  }

  // 040 dentro de la misma sentencia: el `NOT EXISTS` es la intención literal
  // de la red ("sólo si no tiene NINGÚN rol"), no "agregá este rol".
  const pedido = String(args.p_role_code ?? "");
  const rol = memoryRows("roles").find((fila) => fila.code === pedido);
  if (!rol) return { data: null, error: { code: "P0001", message: "ROLE_NOT_FOUND" } };
  if (!rolesDelUsuario.some((fila) => fila.user_id === userId) && !postgrest.ensureAppliesNothing) {
    rolesDelUsuario = [...rolesDelUsuario, { user_id: userId, role_id: rol.id }];
  }

  const fallo =
    postgrest.failWriteTabla?.table === "employees"
      ? postgrest.failWriteTabla.error
      : postgrest.failWrite?.table === "employees"
        ? postgrest.failWrite.error
        : null;
  if (fallo) return { data: null, error: fallo };

  // Red de seguridad final: la sentencia no puede confirmar un usuario sin
  // ningún rol (`requireSedeRole` lo rechazaría en toda la aplicación).
  if (!rolesDelUsuario.some((fila) => fila.user_id === userId)) {
    return { data: null, error: { code: "P0001", message: "ROLE_NOT_FOUND" } };
  }

  // Recién acá se CONFIRMA: hasta este punto no se tocó ninguna fila.
  const fila = {
    ...empleado,
    id: `empleado-generado-${memoryRows("employees").length + 1}`,
    user_id: userId,
    is_active: empleado.is_active ?? true,
    payout_mode: empleado.payout_mode ?? "nomina",
  };
  postgrest.rows.users = usuarios;
  postgrest.rows.user_roles = rolesDelUsuario;
  postgrest.rows.employees = [...memoryRows("employees"), fila];
  return { data: { ...fila }, error: null };
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
        postgrest.antesDeEscribir?.();
        postgrest.singleWrites.push(`${table}.delete`);
        if (postgrest.failWrite?.table === table && postgrest.failWrite.op === "delete") {
          ejecutado = { data: null, error: postgrest.failWrite.error };
          return ejecutado;
        }
        if (postgrest.failWriteTabla?.table === table) {
          ejecutado = { data: null, error: postgrest.failWriteTabla.error };
          return ejecutado;
        }
        postgrest.rows[table] = filas.filter((fila) => !cumpleFiltros(fila, filtros));
        ejecutado = { data: null, error: null };
        return ejecutado;
      }

      if (modo === "insert") {
        postgrest.antesDeEscribir?.();
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
        postgrest.antesDeEscribir?.();
        postgrest.singleWrites.push(`${table}.upsert`);
        if (postgrest.failWriteTabla?.table === table) {
          ejecutado = { data: null, error: postgrest.failWriteTabla.error };
          return ejecutado;
        }
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
      if (fn === "ensure_user_has_role" || fn === "upsert_employee_atomic") {
        postgrest.antesDeEscribirRol?.();
      }
      postgrest.antesDeEscribir?.();
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
      // El embed que resuelve PostgREST (`roles(code)`): es lo que lee la
      // lectura previa del servicio para saber qué roles tiene HOY el usuario.
      roles: { code },
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

  it("G1: un admin de sede NO puede otorgar `superadmin`: rechaza y no escribe", async () => {
    sembrar(["empleado"]);

    await expect(
      setUserRoles({ user_id: USUARIO_ID, roles: ["superadmin"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    // La puerta se cerró ANTES del rpc: no hay sentencia ni escritura suelta.
    expect(postgrest.rpcCalls).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
    expect(rolesPersistidos()).toEqual(["empleado"]);
  });

  it("G1: un admin de sede NO puede quitarle `superadmin` a quien lo tiene: rechaza y no escribe", async () => {
    sembrar(["superadmin"]);

    await expect(
      setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(postgrest.rpcCalls).toEqual([]);
    expect(rolesPersistidos()).toEqual(["superadmin"]);
  });
});

function baseEmployee(overrides: Record<string, unknown> = {}) {
  return {
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

describe("admin schemas: cadencia de pago del empleado (F2)", () => {
  it("acepta las tres cadencias, null y la clave ausente; rechaza cualquier otro valor", () => {
    for (const cadencia of ["semanal", "quincenal", "mensual"]) {
      expect(
        employeeSchema.safeParse(baseEmployee({ pay_frequency: cadencia })).success,
        `debería aceptar ${cadencia}`,
      ).toBe(true);
    }
    // `null` es «sin cadencia definida»: un valor LEGAL, no un hueco.
    expect(employeeSchema.safeParse(baseEmployee({ pay_frequency: null })).success).toBe(true);
    // La clave ausente también: es el estado de todo legajo anterior a F2.
    expect(employeeSchema.safeParse(baseEmployee()).success).toBe(true);

    for (const invalida of ["diario", "Semanal", "semanal ", "quincenal (x)", "", 4, true]) {
      expect(
        employeeSchema.safeParse(baseEmployee({ pay_frequency: invalida })).success,
        `debería rechazar ${JSON.stringify(invalida)}`,
      ).toBe(false);
    }
  });

  it("el catálogo del esquema es el cerrado de la columna y no admite null por sí solo", () => {
    for (const cadencia of ["semanal", "quincenal", "mensual"]) {
      expect(payFrequencySchema.safeParse(cadencia).success, cadencia).toBe(true);
    }
    expect(payFrequencySchema.safeParse("diario").success).toBe(false);
    expect(payFrequencySchema.safeParse(null).success).toBe(false);
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

  it("dos códigos con valor iguales colisionan", () => {
    // Sin sedes: `074` recreó `uq_employees_sede_code` sobre `(employee_code)`
    // con el mismo WHERE, así que el choque se decide sólo por el código.
    expect(areEmployeeCodesConflicting({ codeA: "EMP-01", codeB: "EMP-01" })).toBe(true);
    expect(areEmployeeCodesConflicting({ codeA: "EMP-01", codeB: "EMP-02" })).toBe(false);
  });

  it("vacíos nunca colisionan", () => {
    expect(areEmployeeCodesConflicting({ codeA: "", codeB: "" })).toBe(false);
    expect(areEmployeeCodesConflicting({ codeA: null, codeB: "EMP-01" })).toBe(false);
    expect(areEmployeeCodesConflicting({ codeA: "EMP-01", codeB: undefined })).toBe(false);
  });

  it("el esquema acepta código vacío (repetible en la instalación)", () => {
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: "" })).success).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: null })).success).toBe(true);
  });
});

describe("admin schemas: servicio min<=max (ADM-05)", () => {
  function baseService(overrides: Record<string, unknown> = {}) {
    return {
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
    const base = { code: "IVA", name: "IVA general" };
    expect(taxConfigSchema.safeParse({ ...base, percent: 19 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 0 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 100 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: -1 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, percent: 101 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, code: "OTRO", percent: 5 }).success).toBe(false);
  });

  it("solo acepta códigos del catálogo Colombia", () => {
    const base = { name: "Nequi" };
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

describe("admin: requireSedeRole (puro)", () => {
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
});

describe("migración 039_atomic_role_replacement.sql (CO-2)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "039_atomic_role_replacement.sql"),
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
    join(process.cwd(), "supabase", "schema-history", "040_ensure_user_has_role.sql"),
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

    await upsertEmployee(baseEmployee(), SEDE_A);

    // El empleado sí se creó: la prueba corre por la red de seguridad.
    expect(memoryRows("employees")).toHaveLength(1);
    expect(rolesPersistidos()).toEqual(["admin"]);
    expect(escriturasDeRoles()).toEqual([]);
    // La decisión viaja en UNA sentencia del servidor: desde CL-15 esa
    // sentencia es la del alta completa (`upsert_employee_atomic`, 054), que
    // lleva adentro la red de seguridad de 040. La propiedad que se fija —una
    // sola sentencia, cero escrituras sueltas de `user_roles`— es la misma.
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["upsert_employee_atomic"]);
  });

  it("a quien YA es `empleado` no se le vuelve a insertar el rol", async () => {
    sembrar(["empleado"]);

    await upsertEmployee(baseEmployee(), SEDE_A);

    expect(rolesPersistidos()).toEqual(["empleado"]);
    expect(escriturasDeRoles()).toEqual([]);
  });

  it("a quien NO tiene ningún rol igual se le asigna `empleado` (la intención sobrevive)", async () => {
    sembrar([]);

    await upsertEmployee(baseEmployee(), SEDE_A);

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

    await upsertEmployee(baseEmployee(), SEDE_A);

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
    const empleado = upsertEmployee(baseEmployee(), SEDE_A);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reemplazo = setUserRoles({ user_id: USUARIO_ID, roles: ["admin"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn).sort()).toEqual([
      "replace_user_roles",
      "upsert_employee_atomic",
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

    await upsertEmployee(baseEmployee(), SEDE_A);

    // La red vieja leía una columna de `user_roles` para decidir; esa lectura
    // es la mitad del read-then-insert que CO-4 cierra, así que ya no existe.
    expect(postgrest.selects.filter((select) => select.table === "user_roles")).toEqual([]);
    expect(escriturasDeRoles()).toEqual([]);
    // La red viaja DENTRO de la sentencia del alta (054), no como un rpc propio.
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["upsert_employee_atomic"]);
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
      fn: "upsert_employee_atomic",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
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

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
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

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
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

    await upsertEmployee(baseEmployee(), SEDE_A);

    expect(rolesPersistidos()).toEqual(["empleado"]);
    expect(escriturasDeRoles()).toEqual([]);
  });

  it("un fallo REAL de la escritura de la red sí se propaga (no queda en un console.error)", async () => {
    sembrar([]);
    postgrest.failRpc = {
      fn: "upsert_employee_atomic",
      error: { code: "42501", message: "permission denied for function upsert_employee_atomic" },
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
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

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
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
    await upsertEmployee(baseEmployee(), SEDE_A);

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

    await upsertEmployee(baseEmployee({ id: EMPLEADO_ID, employee_code: "EMP-01" }), SEDE_A);

    expect(postgrest.selects.filter((select) => select.table === "user_roles")).toEqual([]);
    expect(escriturasDeRoles()).toEqual([]);
    expect(rolesPersistidos()).toEqual(["admin"]);
    // Tampoco llama la función de la red: al actualizar, los roles no se tocan.
    expect(postgrest.rpcCalls).toEqual([]);
  });
});

describe("migración 003_admin.sql (T3)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "schema-history", "003_admin.sql"), "utf8");

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

// ---------------------------------------------------------------------------
// CL-15: el alta de empleado deja de poder quedar a medias.
//
// `upsertEmployee` escribía el usuario (si no existía), le aseguraba un rol
// (040) y DESPUÉS insertaba el legajo: tres requests de PostgREST, tres
// transacciones distintas, porque PostgREST no ofrece multi-statement por
// request. Un fallo en el medio dejaba un usuario con login y rol pero SIN
// legajo. El par de escrituras pasa a ser UNA sentencia del servidor
// (`upsert_employee_atomic`, migración 054), que lleva adentro la red de
// seguridad de 040.
// ---------------------------------------------------------------------------

describe("admin: alta de empleado atómica (CL-15 / ADM-02)", () => {
  function sembrarSinUsuario(): void {
    postgrest.rows = {};
    postgrest.rows.users = [];
    postgrest.rows.roles = ROLES_CATALOGO.map((rol) => ({ ...rol }));
    postgrest.rows.user_roles = [];
    postgrest.rows.employees = [];
  }

  /** El usuario de acceso ya existe (vínculo automático por documento). */
  function sembrarConUsuarioVinculado(): void {
    sembrarSinUsuario();
    postgrest.rows.users = [
      { id: USUARIO_ID, sede_id: SEDE_A, id_number: "123456", full_name: "Carolina Rojas" },
    ];
  }

  function usuarios(): Array<Record<string, unknown>> {
    return memoryRows("users");
  }

  /** Roles persistidos (las pruebas de este bloque tienen a lo sumo un usuario). */
  function rolesPersistidos(): string[] {
    return memoryRows("user_roles")
      .map((fila) => codeDeRol(String(fila.role_id)))
      .sort();
  }

  function escriturasSueltas(): string[] {
    return postgrest.singleWrites.filter(
      (escritura) =>
        escritura.startsWith("users.") ||
        escritura.startsWith("user_roles.") ||
        escritura.startsWith("employees."),
    );
  }

  beforeEach(() => {
    postgrest.singleWrites.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.selects.length = 0;
    postgrest.failWrite = null;
    postgrest.failWriteTabla = null;
    postgrest.failRead = null;
    postgrest.failRpc = null;
    postgrest.antesDeEscribir = null;
    postgrest.antesDeEscribirRol = null;
    postgrest.rpcAppliesNothing = false;
    postgrest.ensureAppliesNothing = false;
  });

  it("un fallo del legajo no deja usuario con login y rol pero SIN legajo", async () => {
    sembrarSinUsuario();
    postgrest.failWriteTabla = {
      table: "employees",
      error: { code: "42501", message: "permission denied for table employees" },
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    // EL HALLAZGO: el usuario creado, con su rol, y sin legajo que lo respalde.
    // Sin transacción, esas dos escrituras ya estaban confirmadas.
    expect(usuarios()).toEqual([]);
    expect(rolesPersistidos()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  it("con un usuario YA vinculado, un fallo del legajo no le deja el rol igual", async () => {
    sembrarConUsuarioVinculado();
    postgrest.failWriteTabla = {
      table: "employees",
      error: { code: "42501", message: "permission denied for table employees" },
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    // El usuario previo NO se toca (no es nuestro) y tampoco se le otorga nada.
    expect(usuarios()).toHaveLength(1);
    expect(rolesPersistidos()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  it("un fallo al crear el usuario no deja legajo suelto", async () => {
    sembrarSinUsuario();
    postgrest.failWriteTabla = {
      table: "users",
      error: { code: "42501", message: "permission denied for table users" },
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(usuarios()).toEqual([]);
    expect(rolesPersistidos()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  it("el alta viaja en UNA sentencia: cero escrituras sueltas", async () => {
    sembrarSinUsuario();

    const fila = await upsertEmployee(baseEmployee(), SEDE_A);

    expect(fila.full_name).toBe("Carolina Rojas");
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["upsert_employee_atomic"]);
    expect(escriturasSueltas()).toEqual([]);
    expect(usuarios()).toHaveLength(1);
    expect(rolesPersistidos()).toEqual(["empleado"]);
    expect(memoryRows("employees")).toHaveLength(1);
  });

  it("una carrera perdida contra el índice del código sigue dando EMPLOYEE_CODE_TAKEN", async () => {
    sembrarSinUsuario();
    postgrest.failWriteTabla = {
      table: "employees",
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uq_employees_sede_code"',
      },
    };

    await expect(
      upsertEmployee(baseEmployee({ employee_code: "EMP-01" }), SEDE_A),
    ).rejects.toMatchObject({
      code: "EMPLOYEE_CODE_TAKEN",
      status: 409,
      // La unicidad del código es de la INSTALACIÓN (074 quitó la sede del
      // índice): el mensaje no puede prometer un alcance por sede.
      message: "El código de empleado ya existe.",
    });

    // Nada a medias: ni usuario, ni rol, ni legajo.
    expect(usuarios()).toEqual([]);
    expect(rolesPersistidos()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  it("documento repetido por carrera: la unicidad de users se conserva", async () => {
    sembrarSinUsuario();
    postgrest.antesDeEscribir = () => {
      postgrest.rows.users = [
        { id: "otro", sede_id: SEDE_B, id_number: "123456", full_name: "Otra sede" },
      ];
    };

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(usuarios()).toHaveLength(1); // el de la carrera, no el nuestro
    expect(rolesPersistidos()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  it("un rol desconocido en el catálogo no deja el legajo escrito", async () => {
    sembrarSinUsuario();
    postgrest.rows.roles = ROLES_CATALOGO.filter((rol) => rol.code !== "empleado").map(
      (rol) => ({ ...rol }),
    );

    await expect(upsertEmployee(baseEmployee(), SEDE_A)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });

    expect(usuarios()).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
    expect(escriturasSueltas()).toEqual([]);
  });
});

describe("migración 054_identity_atomic.sql: la función del alta de empleado (CL-15)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "054_identity_atomic.sql"),
    "utf8",
  );

  it("crea la función que el alta de empleado llama por rpc", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.upsert_employee_atomic");
    expect(sql).toContain("p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text");
    expect(sql).toContain("RETURNS jsonb");
  });

  it("escribe el usuario, su rol y el legajo en la MISMA sentencia", () => {
    const insercionEmpleado = sql.indexOf("INSERT INTO public.employees");
    expect(insercionEmpleado).toBeGreaterThan(-1);
    expect(sql.indexOf("INSERT INTO public.users")).toBeLessThan(insercionEmpleado);
    expect(sql.indexOf("public.ensure_user_has_role")).toBeLessThan(insercionEmpleado);
    expect(sql).toContain("FOR UPDATE");
    // La red de seguridad es la de 040, no una copia: una sola dueña de la
    // invariante "un rol por usuario".
    expect(sql).toContain("PERFORM public.ensure_user_has_role");
  });

  it("aborta en vez de confirmar un legajo sin usuario con rol", () => {
    expect(sql).toContain("RAISE EXCEPTION 'EMPLOYEE_INVALID'");
    expect(sql).toContain("RAISE EXCEPTION 'USER_NOT_FOUND'");
    expect(sql).toContain("RAISE EXCEPTION 'USER_EXISTS'");
    expect(sql).toContain("GET DIAGNOSTICS");
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    const firma = "public.upsert_employee_atomic(jsonb, uuid, jsonb, text)";
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM authenticated`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${firma} TO service_role`);
  });
});

/* ==========================================================================
   Admin: cada campo numérico de las secciones pasa por SU máscara (guarda)

   `inputMode="numeric"`/`"decimal"` son pistas del teclado, no validaciones:
   una letra llegaba al estado. Los montos (base de caja, denominación,
   salario, topes de vales) pasan por `stripMoneyInput` y los porcentajes
   (comisión del empleado, impuesto) por `stripPercentageInput`, que conserva
   los decimales. Esta guarda falla si alguien vuelve a leer el valor crudo.
   ========================================================================== */
describe("admin: los campos numéricos de las secciones pasan por su máscara (guarda de fuente)", () => {
  const sectionPath = (file: string): string =>
    join(process.cwd(), "app", "admin", "admin-sections", file);
  const cash = readFileSync(sectionPath("cash-section.tsx"), "utf8");
  const employees = readFileSync(sectionPath("employees-section.tsx"), "utf8");
  const taxes = readFileSync(sectionPath("taxes-section.tsx"), "utf8");
  const vales = readFileSync(sectionPath("vales-section.tsx"), "utf8");

  /**
   * Bloque `onChange={...}` cuyo cuerpo contiene `anchor`; `occurrence` elige
   * la aparición cuando el ancla se repite. Devuelve "" si el ancla no existe,
   * para que la guarda falle en vez de pasar sola.
   */
  function onChangeBlock(text: string, anchor: string, occurrence = 0): string {
    let at = -1;
    let from = 0;
    for (let i = 0; i <= occurrence; i += 1) {
      at = text.indexOf(anchor, from);
      if (at === -1) return "";
      from = at + anchor.length;
    }
    const start = text.lastIndexOf("onChange={", at);
    if (start === -1) return "";
    let depth = 0;
    for (let i = start + "onChange=".length; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return text.slice(start);
  }

  /** El campo lleva la máscara y NO además el valor crudo. */
  function assertMasked(block: string, mask: string, raw: string): void {
    expect(block).not.toBe("");
    expect(block).toContain(`strip${mask}Input(event.target.value)`);
    expect(block).not.toContain(raw);
  }

  it("piso anti-vacío: las cuatro secciones se leyeron de verdad", () => {
    expect(cash.length).toBeGreaterThan(5_000);
    expect(employees.length).toBeGreaterThan(5_000);
    expect(taxes.length).toBeGreaterThan(3_000);
    expect(vales.length).toBeGreaterThan(5_000);
    expect(cash).toContain("stripMoneyInput");
    expect(taxes).toContain("stripPercentageInput");
  });

  it("la nueva base de caja usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(cash, 'placeholder="Nueva base"'),
      "Money",
      "[row.id]: event.target.value",
    );
    expect(cash).toContain('value={formatMoneyInput(baseDrafts[row.id] ?? "")}');
  });

  it("el valor de la nueva denominación usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(cash, "setNewValue(stripMoneyInput"),
      "Money",
      "setNewValue(event.target.value)",
    );
    expect(cash).toContain("value={formatMoneyInput(newValue)}");
  });

  it("el salario fijo usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(employees, 'placeholder="1400000"'),
      "Money",
      "salary_fixed: event.target.value",
    );
    expect(employees).toContain("value={formatMoneyInput(form.salary_fixed)}");
  });

  it("el % de comisión del empleado usa la máscara de porcentaje", () => {
    assertMasked(
      onChangeBlock(employees, 'placeholder="30"'),
      "Percentage",
      "commission_percent: event.target.value",
    );
  });

  it("el % del impuesto usa la máscara de porcentaje", () => {
    assertMasked(
      onChangeBlock(taxes, "stripPercentageInput(event.target.value)"),
      "Percentage",
      "percent: event.target.value",
    );
  });

  it("el tope semanal de vales usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(vales, 'placeholder="500000"'),
      "Money",
      "setMaxWeek(event.target.value)",
    );
    expect(vales).toContain("value={formatMoneyInput(maxWeek)}");
  });

  it("el tope diario de vales usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(vales, 'placeholder="200000"', 0),
      "Money",
      "setMaxDay(event.target.value)",
    );
    expect(vales).toContain("value={formatMoneyInput(maxDay)}");
  });

  it("el tope propio por día usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(vales, 'placeholder="200000"', 1),
      "Money",
      "[day]: event.target.value",
    );
    expect(vales).toContain('value={formatMoneyInput(perDayValues[day] ?? "")}');
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake = `<input onChange={(event) => setNewValue(event.target.value)} />`;
    const block = onChangeBlock(fake, "setNewValue(");
    expect(block).not.toBe("");
    // Sin el cable a la máscara, la misma guarda falla.
    expect(block).not.toContain("stripMoneyInput(event.target.value)");
    expect(block).toContain("setNewValue(event.target.value)");
    // Sin el ancla no hay bloque: la guarda falla en vez de pasar sola.
    expect(onChangeBlock(fake, "no-existe:")).toBe("");
  });
});

/* ==========================================================================
   F2: la cadencia de pago del empleado

   El alta y la edición divergen en el camino de escritura: la EDICIÓN usa el
   `upsert` suelto de PostgREST (escribe las columnas POR NOMBRE), y el ALTA usa
   el rpc `upsert_employee_atomic` (054), que escribía una LISTA DE COLUMNAS
   FIJA e ignoraba la cadencia en silencio. Por eso F2 trae una migración (065)
   que reemplaza la función con la misma firma y le agrega la clave.
   ========================================================================== */
describe("admin: la cadencia de pago se persiste y viaja por el legajo (F2)", () => {
  /** El legajo que existía antes de F2: sin cadencia. */
  const EDIT_ID = "66666666-6666-4666-8666-666666666666";

  function sembrarLegajos(): void {
    postgrest.rows = {};
    postgrest.rows.users = [];
    postgrest.rows.roles = ROLES_CATALOGO.map((rol) => ({ ...rol }));
    postgrest.rows.user_roles = [];
    postgrest.rows.employees = [];
  }

  beforeEach(() => {
    sembrarLegajos();
    postgrest.singleWrites.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.selects.length = 0;
    postgrest.failRpc = null;
    postgrest.failWrite = null;
    postgrest.failWriteTabla = null;
    postgrest.failRead = null;
    postgrest.hold = false;
  });

  it("el alta escribe la cadencia en el legajo y la devuelve en la fila", async () => {
    const fila = await upsertEmployee(baseEmployee({ pay_frequency: "semanal" }), SEDE_A);

    expect(fila.pay_frequency).toBe("semanal");
    expect(memoryRows("employees")[0]?.pay_frequency).toBe("semanal");
    // Viaja DENTRO de `p_employee`: el rpc es la única escritura del alta.
    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["upsert_employee_atomic"]);
    expect(postgrest.rpcCalls[0]?.args.p_employee).toMatchObject({ pay_frequency: "semanal" });
    expect(postgrest.singleWrites).toEqual([]);
  });

  it("null es un valor legal: el legajo queda sin cadencia y la clave igual viaja", async () => {
    const fila = await upsertEmployee(baseEmployee({ pay_frequency: null }), SEDE_A);

    expect(fila.pay_frequency).toBeNull();
    expect(memoryRows("employees")[0]?.pay_frequency).toBeNull();
    expect(postgrest.rpcCalls[0]?.args.p_employee).toMatchObject({ pay_frequency: null });
  });

  it("sin la clave también queda en null: la cadencia no se inventa ni se hereda", async () => {
    const fila = await upsertEmployee(baseEmployee(), SEDE_A);

    expect(fila.pay_frequency).toBeNull();
    expect(memoryRows("employees")[0]?.pay_frequency).toBeNull();
  });

  it("la edición persiste la cadencia por el upsert suelto (el alta no se llama)", async () => {
    postgrest.rows.employees = [
      {
        id: EDIT_ID,
        sede_id: SEDE_A,
        user_id: null,
        full_name: "Carolina Rojas",
        document: "123456",
        pay_type: "fijo",
        pay_frequency: null,
        salary_fixed: 1000000,
        is_active: true,
      },
    ];

    const fila = await upsertEmployee(baseEmployee({ id: EDIT_ID, pay_frequency: "quincenal" }), SEDE_A);

    expect(fila.pay_frequency).toBe("quincenal");
    expect(memoryRows("employees")[0]?.pay_frequency).toBe("quincenal");
    // La edición no crea usuarios ni roles: es UNA escritura suelta.
    expect(postgrest.rpcCalls).toEqual([]);
    expect(postgrest.singleWrites).toContain("employees.upsert");
  });

  it("un valor fuera del catálogo se rechaza ANTES de escribir: ni rpc, ni upsert, ni fila", async () => {
    await expect(upsertEmployee(baseEmployee({ pay_frequency: "diario" }), SEDE_A)).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
    });

    expect(postgrest.rpcCalls).toEqual([]);
    expect(postgrest.singleWrites).toEqual([]);
    expect(memoryRows("employees")).toEqual([]);
  });

  // ---- guardas de fuente: el select, la migración y la UI -----------------
  const serviceSource = readFileSync(
    join(process.cwd(), "src", "features", "admin", "service.ts"),
    "utf8",
  );
  const employeesSection = readFileSync(
    join(process.cwd(), "app", "admin", "admin-sections", "employees-section.tsx"),
    "utf8",
  );
  const migration065 = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "065_employee_pay_frequency.sql"),
    "utf8",
  );

  /** Columnas de la constante `EMPLOYEE_SELECT` real. */
  function employeeSelectColumns(source: string): string[] {
    const match = source.match(/const EMPLOYEE_SELECT =\s*"([^"]*)"/);
    if (!match) return [];
    return match[1].split(",").map((columna) => columna.trim());
  }

  /** Valores del catálogo de cadencias de la UI (el `""` es «Sin definir»). */
  function cadenceValues(source: string): string[] {
    const block = source.match(/const PAY_FREQUENCY_OPTIONS = \[([\s\S]*?)\] as const;/);
    if (!block) return [];
    return [...block[1].matchAll(/value: "([^"]*)"/g)].map((match) => match[1]);
  }

  /** Columnas del INSERT del legajo dentro de `upsert_employee_atomic`. */
  function insertedEmployeeColumns(sql: string): string[] {
    const insert = sql.match(/INSERT INTO public\.employees\s*\(([\s\S]*?)\)\s*\n\s*VALUES/);
    if (!insert) return [];
    return insert[1].split(",").map((columna) => columna.trim());
  }

  /** El SQL fuera del cuerpo PL/pgSQL (donde vive la migración de datos). */
  function outsideFunctionBody(sql: string): string {
    return sql.replace(/\$\$[\s\S]*?\$\$/g, "");
  }

  it("el select de empleados LEE la cadencia: sin eso, la fila volvería sin ella", () => {
    expect(employeeSelectColumns(serviceSource)).toContain("pay_frequency");
  });

  it("la UI ofrece la cadencia en el alta y la edición, con la fracción en dinero y «Sin definir»", () => {
    // El `""` es «Sin definir»: deja la columna en NULL y conserva el cálculo de hoy.
    expect(cadenceValues(employeesSection)).toEqual(["", "semanal", "quincenal", "mensual"]);
    expect(employeesSection).toContain("value={form.pay_frequency}");
    expect(employeesSection).toContain(
      "setForm({ ...form, pay_frequency: event.target.value })",
    );
    // Alta: el formulario nace en «Sin definir». Edición: se hidrata de la fila.
    expect(employeesSection).toMatch(/pay_frequency: "",\s*\n\s*salary_fixed: "",/);
    expect(employeesSection).toContain("pay_frequency: row.pay_frequency ?? \"\",");
    // La ayuda dice en DINERO qué paga cada cadencia y qué significa no elegir.
    expect(employeesSection).toContain("mensual / 4");
    expect(employeesSection).toContain("mensual / 2");
    expect(employeesSection).toContain("mes completo");
    expect(employeesSection).toContain("conserva el cálculo de hoy");
    // El detalle también la muestra.
    expect(employeesSection).toContain("{payFrequencyLabel(dialogRow.pay_frequency)}");
  });

  it("«Sin definir» viaja como null: nunca se manda la cadena vacía a la base", () => {
    expect(employeesSection).toContain(
      'pay_frequency: form.pay_frequency === "" ? null : form.pay_frequency,',
    );
  });

  it("la migración 065 reemplaza la función con la MISMA firma y le agrega la cadencia", () => {
    expect(migration065).toContain("CREATE OR REPLACE FUNCTION public.upsert_employee_atomic(");
    expect(migration065).toContain(
      "p_employee jsonb, p_user_id uuid, p_create_user jsonb, p_role_code text",
    );
    expect(migration065).toContain("RETURNS jsonb");
    // La clave es OPCIONAL y su valor PRESENTE se valida contra el catálogo cerrado.
    expect(migration065).toContain("p_employee ? 'pay_frequency'");
    expect(migration065).toContain("NOT IN ('semanal', 'quincenal', 'mensual')");
    // Se ESCRIBE en el legajo y se DEVUELVE en la fila.
    expect(insertedEmployeeColumns(migration065)).toContain("pay_frequency");
    expect(migration065).toContain("'pay_frequency', v_fila.pay_frequency");
    // El contrato de la función (search_path, ACL, COMMENT) se re-emite.
    const firma = "public.upsert_employee_atomic(jsonb, uuid, jsonb, text)";
    expect(migration065).toContain(
      `ALTER FUNCTION ${firma} SET search_path = public;`,
    );
    expect(migration065).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    expect(migration065).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM anon`);
    expect(migration065).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM authenticated`);
    expect(migration065).toContain(`GRANT EXECUTE ON FUNCTION ${firma} TO service_role`);
    expect(migration065).toContain(`COMMENT ON FUNCTION ${firma} IS`);
  });

  it("la 065 no migra datos ni toca la columna (eso es la 063) y declara que no se ejecutó", () => {
    const sqlSinComentarios = migration065
      .split("\n")
      .filter((linea) => !linea.trimStart().startsWith("--"))
      .join("\n");
    // Fuera del cuerpo de la función no hay una sola sentencia de datos ni DDL
    // de tabla: los legajos existentes quedan con su cadencia como está.
    const fueraDelCuerpo = outsideFunctionBody(sqlSinComentarios);
    expect(fueraDelCuerpo).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(fueraDelCuerpo).not.toMatch(/\bALTER TABLE\b/);
    expect(fueraDelCuerpo).not.toMatch(/\bDROP\b/);
    // Idempotente: reemplaza, no crea otra sobrecarga.
    expect(sqlSinComentarios).not.toMatch(/^CREATE FUNCTION/m);
    expect(migration065).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("control negativo de los detectores de fuente (no son sellos de goma)", () => {
    expect(employeeSelectColumns('const EMPLOYEE_SELECT =\n  "id, full_name";')).not.toContain(
      "pay_frequency",
    );
    expect(cadenceValues("<select></select>")).toEqual([]);
    expect(
      cadenceValues('const PAY_FREQUENCY_OPTIONS = [{ value: "diario", label: "Diario" }] as const;'),
    ).toEqual(["diario"]);
    expect(insertedEmployeeColumns("INSERT INTO public.employees (sede_id) VALUES (1);")).not.toContain(
      "pay_frequency",
    );
    expect(insertedEmployeeColumns("SELECT 1;")).toEqual([]);
    // La migración falsa (sin la clave) NO pasa el detector de la escritura.
    expect(
      insertedEmployeeColumns(
        "INSERT INTO public.employees (sede_id)\n  VALUES ((x)::uuid)",
      ),
    ).not.toContain("pay_frequency");
    // Y la UI no estrena las primitivas ni los roles que otras guardas pinean.
    expect(employeesSection).not.toMatch(/\brole\s*=\s*["'{]/);
    expect(employeesSection).not.toMatch(/<Badge\b/);
    expect(employeesSection).not.toMatch(/<Alert\b/);
  });
});

// ---------------------------------------------------- plataforma (G1) ---

describe("roles: vocabulario de plataforma (G1)", () => {
  it("roleCodeSchema acepta `superadmin` y sigue rechazando un código desconocido", () => {
    expect(roleCodeSchema.safeParse("superadmin").success).toBe(true);
    expect(roleCodeSchema.safeParse("dueño").success).toBe(false);
    expect(isRoleCode("superadmin")).toBe(true);
    expect(isRoleCode("dueño")).toBe(false);
  });

  it("el espejo `SedeRole` es estructuralmente idéntico a `RoleCode` (ida y vuelta compilan)", () => {
    const desdeEspejo: SedeRole[] = ["admin", "empleado", "caja", "superadmin"];
    const comoCodigos: RoleCode[] = desdeEspejo;
    const vuelta: SedeRole[] = comoCodigos;
    expect(vuelta).toContain("superadmin");
  });

  it("setUserRolesSchema acepta el código; es el SERVICIO quien lo rechaza", () => {
    // El esquema (en admin/schemas, fuera del alcance de G1) no puede estrecharse
    // acá: por eso la puerta real es el servicio.
    expect(
      setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["superadmin"] }).success,
    ).toBe(true);
    expect(setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["dueño"] }).success).toBe(false);
  });

  it("la lista asignable desde sede excluye el rol de plataforma", () => {
    expect(isSedeAssignableRole("admin")).toBe(true);
    expect(isSedeAssignableRole("empleado")).toBe(true);
    expect(isSedeAssignableRole("caja")).toBe(true);
    expect(isSedeAssignableRole("superadmin")).toBe(false);
  });
});

describe("admin: la UI de usuarios no ofrece el rol de plataforma (guarda de fuente, G1)", () => {
  const fuente = readFileSync(
    join(process.cwd(), "app", "admin", "admin-sections", "users-section.tsx"),
    "utf8",
  );

  it("construye la lista asignable filtrando `superadmin` y la usa en los radios", () => {
    expect(fuente).toContain(
      'ROLE_OPTIONS.filter((option) => option.value !== "superadmin")',
    );
    expect(fuente).toContain("ASSIGNABLE_ROLE_OPTIONS.map(");
    // La lista cruda del panel NO se vuelve a ofrecer en esta pantalla
    // (cuidado con el prefijo: `ASSIGNABLE_ROLE_OPTIONS.map` contiene esa
    // subcadena, por eso se exige que NO venga precedida de `ASSIGNABLE_`).
    expect(fuente).not.toMatch(/(?<!ASSIGNABLE_)ROLE_OPTIONS\.map\(/);
  });
});

describe("migración 069_superadmin_role.sql (G1)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "069_superadmin_role.sql"),
    "utf8",
  );
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("ensancha el CHECK por su nombre real, con el cuarto código", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS roles_code_check");
    expect(sql).toContain("ADD CONSTRAINT roles_code_check");
    expect(sql).toContain("CHECK (code IN ('admin', 'empleado', 'caja', 'superadmin'))");
    expect(raw).toContain("roles_code_check");
  });

  it("inserta la fila del catálogo de forma idempotente", () => {
    expect(sql).toContain("INSERT INTO public.roles (code, description)");
    expect(sql).toContain("'superadmin'");
    expect(sql).toContain("ON CONFLICT (code) DO NOTHING");
  });

  it("es idempotente, no migra datos y toca solo el catálogo", () => {
    expect(sql.match(/\bINSERT INTO\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/public\.(users|user_roles|sessions)/);
    expect(sql).not.toMatch(/\bADD COLUMN\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it("declara el nombre real de la constraint, la numeración libre y que no se ejecutó", () => {
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});

// ---------------------------------------- nombres de sede únicos (G2) ---

describe("migración 070_sedes_unique_name.sql (G2)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "070_sedes_unique_name.sql"),
    "utf8",
  );
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  /**
   * Destino del índice único, en una sola línea. Es el detector que usan las
   * pruebas de abajo: si el CREATE desapareciera, dejara de ser único o dejara
   * de normalizar el nombre, devuelve `null` u otra cosa y la prueba cae.
   */
  function destinoIndiceUnicoSede(fuente: string): string | null {
    const destino = fuente.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_sedes_name\s+ON public\.sedes\s*\(([^;]*?)\);/s,
    );
    return destino ? destino[1].replace(/\s+/g, " ").trim() : null;
  }

  it("crea, una sola vez, un índice único sobre el nombre normalizado", () => {
    expect(destinoIndiceUnicoSede(sql)).toBe("lower(btrim(name))");
    expect(sql.match(/CREATE UNIQUE INDEX\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CREATE INDEX\b/);
  });

  it("aborta antes de crear el índice si ya hay nombres repetidos y los lista", () => {
    // El pre-vuelo agrupa por la MISMA clave normalizada y cuenta.
    expect(sql).toContain("GROUP BY lower(btrim(name))");
    expect(sql).toContain("HAVING count(*) > 1");
    // El mensaje dice que aborta, que no toca filas y qué hacer.
    expect(sql).toContain("migración 070 ABORTADA");
    expect(sql).toMatch(/renombre las sedes repetidas/i);
    expect(sql).toContain("No se borró, renombró ni fusionó ninguna fila");
    // Aborta con excepción; no es un aviso que siga de largo.
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("es re-ejecutable y no toca datos ni otras tablas", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_sedes_name");
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE\b/im);
    // Sólo `sedes`: ninguna otra tabla del esquema entra en una sentencia.
    expect(sql).toMatch(/public\.sedes\b/);
    expect(sql).not.toMatch(/public\.(users|employees|roles|user_roles|sessions)\b/);
  });

  it("declara el motivo, la numeración libre y que no se ejecutó", () => {
    expect(raw).toContain("Plataforma (sistema)");
    expect(raw).toContain("lower(btrim(name))");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("control negativo: el detector no es un sello de goma", () => {
    // Un índice sobre `name` crudo (sin normalizar) NO pasa el detector: es
    // justo la debilidad que 070 corrige.
    const sinNormalizar =
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_sedes_name ON public.sedes (name);\n";
    expect(destinoIndiceUnicoSede(sinNormalizar)).toBe("name");
    expect(destinoIndiceUnicoSede(sinNormalizar)).not.toBe("lower(btrim(name))");
    // Sin el CREATE (archivo ausente o recortado), el detector devuelve null.
    expect(destinoIndiceUnicoSede("SELECT 1;\n")).toBeNull();
    // Y un índice NO único tampoco cuenta como la barrera.
    expect(
      destinoIndiceUnicoSede(
        "CREATE INDEX IF NOT EXISTS uq_sedes_name ON public.sedes (lower(btrim(name)));\n",
      ),
    ).toBeNull();
  });
});

// -------------------------------------- G5: las sedes salen del alcance ---

/**
 * G5 cierra los dos agujeros que el negocio tenía sobre la instalación:
 * `listSedesAction` (guardada solo por `requireSession`, así que CUALQUIER rol
 * logueado listaba todas las sedes) y `upsertSedeAction` (guardada por
 * `requireAdminSession`, así que el admin de CUALQUIER sede creaba y editaba
 * sedes, incluida la fila de la sede del sistema).
 *
 * El mapa de consumidores salió vacío —ni una sola referencia en la app— así que
 * no hubo que reubicar ninguna pantalla: se eliminaron. La instalación pasó a la
 * superficie de plataforma, que desde la decisión de UNA SOLA SEDE sólo configura
 * la instalación (la fecha de la nómina): ya no hay lista de sedes ni alta que
 * reubicar, y el alta de una segunda sede no es una operación que la instalación
 * admita.
 *
 * El bloque afirma las DOS mitades del cierre: que las acciones ya no se
 * exportan (lo que un admin de sede tenía alcanzable como endpoint POST, porque
 * `"use server"` convierte cada export en uno) y que el módulo del negocio ya no
 * tiene con qué leer ni escribir la tabla `sedes`.
 *
 * LO QUE EL NEGOCIO CONSERVA (decisión del dueño, 2026-10-01): el admin de la
 * sede sigue administers su gente —usuarios y roles de SU sede— y el rol de
 * plataforma no se otorga ni se quita desde acá (`setUserRoles` rechaza ambas
 * direcciones). Lo que se retiró fue la ESTRUCTURA de sedes, no la gestión de
 * personas.
 */
describe("G5: el admin de una sede ya no lista ni escribe sedes", () => {
  const acciones = readFileSync(join(process.cwd(), "src", "features", "admin", "actions.ts"), "utf8");
  const servicio = readFileSync(join(process.cwd(), "src", "features", "admin", "service.ts"), "utf8");

  /** Código sin comentarios: una puerta citada al documentar el cierre no cuenta. */
  function sinComentarios(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("las dos acciones desaparecieron del módulo alcanzable", () => {
    for (const nombre of ["listSedesAction", "upsertSedeAction"]) {
      expect(
        nombre in adminActions,
        `${nombre} sigue exportada: "use server" la deja alcanzable como endpoint POST`,
      ).toBe(false);
      expect(acciones).not.toContain(`export async function ${nombre}`);
    }
  });

  it("sus funciones de servicio también (no se \"re-ubicaron\" con otro nombre)", () => {
    for (const nombre of ["upsertSede", "listSedes", "fetchSedes", "SedeRow"]) {
      // `String.raw` y no una plantilla pelada: en una plantilla normal `\s`
      // vale `s`, así que el patrón compilado era `export s+(?:async s+...)` y
      // NUNCA podía encontrar una declaración exportada (guarda que no puede
      // fallar). Con `String.raw` el `\s` llega crudo al motor como clase de
      // espacio, que es lo que el detector afirma detectar.
      const declaracion = new RegExp(
        String.raw`export\s+(?:async\s+function|const|function|interface|type)\s+${nombre}\b`,
      );
      expect(servicio, `admin/service.ts todavía declara ${nombre}`).not.toMatch(declaracion);
      // Sin comentarios: el aviso que documenta el cierre NOMBRA a las funciones
      // que se quitaron, y nombrarlas al explicar no es declararlas.
      expect(sinComentarios(acciones)).not.toContain(nombre);
    }
  });

  it("el negocio ya no alcanza la tabla `sedes` ni su etiqueta de caché", () => {
    expect(sinComentarios(servicio)).not.toContain('from("sedes")');
    expect(sinComentarios(acciones)).not.toContain("catalog:sedes");
    expect(sinComentarios(acciones)).not.toContain('from("sedes")');
  });

  it("lo que sí tiene consumidores se quedó: usuarios y roles de la propia sede", () => {
    // Control de sobre-eliminación: estas dos tienen pantalla que las llama
    // (`app/admin/admin-tabs.tsx` y `app/admin/admin-sections/users-section.tsx`)
    // y siguen siendo del admin de su sede. La decisión del dueño (2026-10-01) es
    // explícita: la estructura de sedes se retiró, la gestión de personas no.
    for (const nombre of ["listSedeUsersAction", "setUserRolesAction"]) {
      expect(nombre in adminActions, `${nombre} no debía tocarse`).toBe(true);
    }
    // Y la pestaña que las monta sigue viva: la retirada fue la de las sedes, no
    // la de la gestión de usuarios.
    const pestañas = readFileSync(join(process.cwd(), "app", "admin", "admin-tabs.tsx"), "utf8");
    expect(pestañas).toContain("UsersSection");
  });

  it("el esquema de la fila de sede queda declarado, con su prueba", () => {
    const schemas = readFileSync(
      join(process.cwd(), "src", "features", "admin", "schemas.ts"),
      "utf8",
    );
    expect(schemas).toContain("export const sedeSchema");
    // Su último consumidor era el ALTA de sedes en la plataforma, que se retiró
    // con la decisión de una sola sede: el esquema queda declarado pero sin
    // consumidor en producción, y quitarlo (o conservarlo para la unidad que
    // elimina la tabla) es de esa unidad, no de ésta.
    expect(schemas).toContain("export type SedeInput");
  });
});

// ------------------------- M3b: `sede_id` deja de ser obligatoria ----------

/**
 * Sentencias que la unidad 073 NO puede escribir, con la etiqueta con la que se
 * reporta la infracción. Se prueban contra el archivo COMPLETO, comentarios
 * incluidos: esta unidad es aditiva y su prosa tiene que poder NOMBRAR lo que
 * no hace, pero al nombrarlo lo hace con palabras, nunca con una sentencia.
 *
 * La excepción es `DROP NOT NULL`, que es justamente el cambio: cada patrón
 * exige la palabra que sigue a `DROP`, así que `DROP NOT NULL` no casa con
 * ninguno de ellos.
 */
const PROHIBIDAS_073: ReadonlyArray<{ etiqueta: string; patron: RegExp }> = [
  { etiqueta: "DROP COLUMN", patron: /\bDROP\s+COLUMN\b/i },
  { etiqueta: "DROP CONSTRAINT", patron: /\bDROP\s+CONSTRAINT\b/i },
  { etiqueta: "DROP INDEX", patron: /\bDROP\s+INDEX\b/i },
  { etiqueta: "DROP POLICY", patron: /\bDROP\s+POLICY\b/i },
  { etiqueta: "DROP TABLE", patron: /\bDROP\s+TABLE\b/i },
  { etiqueta: "DROP SCHEMA", patron: /\bDROP\s+SCHEMA\b/i },
  { etiqueta: "FOREIGN KEY", patron: /\bFOREIGN\s+KEY\b/i },
  { etiqueta: "REFERENCES", patron: /\bREFERENCES\b/i },
  { etiqueta: "INSERT", patron: /\bINSERT\b/i },
  { etiqueta: "UPDATE", patron: /\bUPDATE\b/i },
  { etiqueta: "DELETE", patron: /\bDELETE\b/i },
  { etiqueta: "TRUNCATE", patron: /\bTRUNCATE\b/i },
  { etiqueta: "MERGE", patron: /\bMERGE\b/i },
  { etiqueta: "DEFAULT", patron: /\bDEFAULT\b/i },
  // Mayúsculas, porque sólo puede ser el nombre de la fila del sistema: si
  // aparece, alguien metió una sentencia de datos sobre ella.
  { etiqueta: "SEDE", patron: /\bSEDE\b/ },
];

/** Las infracciones del archivo, en el orden en que se declararon. */
function infracciones073(fuente: string): string[] {
  return PROHIBIDAS_073.filter((p) => p.patron.test(fuente)).map((p) => p.etiqueta);
}

/** Cada `DROP` del archivo, con el objeto que le sigue: la única forma admitida es `NOT NULL`. */
function dropsDe073(fuente: string): string[] {
  return [...fuente.matchAll(/\bDROP\b((?:\s+\w+)*)/gi)].map((m) =>
    m[1].trim().replace(/\s+/g, " ").toUpperCase(),
  );
}

/**
 * Las tablas cuya `sede_id` es OBLIGATORIA, derivadas de las migraciones y no
 * de una lista escrita a mano: cada `CREATE TABLE` se lee con su cuerpo para
 * clasificar la declaración de la columna, y cada `SET NOT NULL` posterior
 * corrige la clasificación (es lo que convierte `users` de nulable en
 * obligatoria en 003_admin.sql).
 *
 * Los comentarios se quitan antes de leer: la sección de reversión de 073
 * repite el `SET NOT NULL` de las dieciocho tablas como texto comentado, y sin
 * esta limpieza el archivo se declararía a sí mismo como el origen del
 * esquema.
 */
function esquemaSedeObligatoria(): {
  obligatorias: string[];
  porClavePrimaria: string[];
  yaNulables: string[];
} {
  const dir = join(process.cwd(), "supabase", "schema-history");
  const obligatorias = new Set<string>();
  const porClavePrimaria = new Set<string>();
  const yaNulables = new Set<string>();
  for (const archivo of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const texto = readFileSync(join(dir, archivo), "utf8")
      .split("\n")
      .map((linea) => linea.split("--")[0])
      .join("\n");
    for (const bloque of texto.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g,
    )) {
      const tabla = bloque[1];
      const declaracion = bloque[2]
        .split("\n")
        .map((linea) => linea.trim())
        .find((linea) => /^sede_id\b/.test(linea));
      if (!declaracion) continue;
      if (/^sede_id\s+uuid\s+PRIMARY KEY\b/i.test(declaracion)) porClavePrimaria.add(tabla);
      else if (/^sede_id\s+uuid\s+NOT\s+NULL\b/i.test(declaracion)) obligatorias.add(tabla);
      else yaNulables.add(tabla);
    }
    for (const [, tabla] of texto.matchAll(
      /ALTER TABLE public\.([a-z0-9_]+)\s+ALTER COLUMN sede_id SET NOT NULL/g,
    )) {
      yaNulables.delete(tabla);
      obligatorias.add(tabla);
    }
  }
  const orden = (a: string, b: string) => a.localeCompare(b);
  return {
    obligatorias: [...obligatorias].sort(orden),
    porClavePrimaria: [...porClavePrimaria].sort(orden),
    yaNulables: [...yaNulables].sort(orden),
  };
}

describe("migración 073_sede_id_nullable.sql (M3b)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "073_sede_id_nullable.sql"),
    "utf8",
  );
  /** El archivo sin comentarios: lo que el runner envía a la base. */
  const sql = raw
    .split("\n")
    .filter((linea) => !linea.trimStart().startsWith("--"))
    .join("\n");
  const esquema = esquemaSedeObligatoria();

  it("el esquema tiene dieciocho sedes obligatorias, dos por clave primaria y una ya nulable", () => {
    // La lista de la migración tiene que seguir al ESQUEMA. Si una migración
    // futura añade una tabla con `sede_id` obligatoria, esta cuenta se mueve y
    // la comparación exacta de la prueba siguiente falla pidiendo la línea nueva.
    expect(esquema.obligatorias).toHaveLength(18);
    // Las dos que son clave primaria NO son relajables sin quitar la clave, que
    // es justo lo que esta unidad prohíbe; y 072 ya decidió que las borra M3c.
    expect(esquema.porClavePrimaria).toEqual(["invoice_sequences", "voucher_settings"]);
    // Y la única que nació nulable a propósito (008_hardening.sql).
    expect(esquema.yaNulables).toEqual(["audit_logs"]);
  });

  it("relaja `sede_id` en cada tabla que la exigía, y en ninguna más", () => {
    for (const tabla of esquema.obligatorias) {
      expect(sql, `${tabla} sigue con la sede obligatoria`).toContain(
        `ALTER TABLE public.${tabla} ALTER COLUMN sede_id DROP NOT NULL;`,
      );
    }
    const tocadas = [...new Set([...sql.matchAll(/ALTER TABLE public\.([a-z0-9_]+)/g)].map((m) => m[1]))];
    expect(tocadas.sort((a, b) => a.localeCompare(b))).toEqual(esquema.obligatorias);
  });

  it("sólo contiene las dieciocho relajaciones: ni una sentencia más", () => {
    const sentencias = sql
      .split("\n")
      .map((linea) => linea.trim())
      .filter(Boolean);
    expect(sentencias).toHaveLength(18);
    for (const sentencia of sentencias) {
      expect(sentencia).toMatch(/^ALTER TABLE public\.[a-z0-9_]+ ALTER COLUMN sede_id DROP NOT NULL;$/);
    }
  });

  it("no borra nada, no escribe filas, no inventa valores por omisión ni toca a la sede", () => {
    // Contra el archivo COMPLETO, comentarios incluidos: la prosa puede decir
    // «no borra la columna», pero no puede traer una sentencia que sí lo haga.
    expect(infracciones073(raw)).toEqual([]);
    // Y el único `DROP` del archivo es el de la nulabilidad.
    expect([...new Set(dropsDe073(raw))]).toEqual(["NOT NULL"]);
  });

  it("declara el motivo, las tres que quedan fuera, la reversión y que no se ejecutó", () => {
    expect(raw).toContain("una sola sede");
    expect(raw).toContain("ADITIVO, REVERSIBLE E IDEMPOTENTE");
    // Las tres exclusiones, nombradas con el motivo de cada una.
    expect(raw).toContain("invoice_sequences");
    expect(raw).toContain("voucher_settings");
    expect(raw).toContain("audit_logs");
    expect(raw).toContain("CLAVE PRIMARIA");
    // La reversión, sentencia por sentencia.
    expect(raw).toContain("ALTER TABLE public.users ALTER COLUMN sede_id SET NOT NULL;");
    expect(raw).toContain(
      "ALTER TABLE public.payroll_discount_carries ALTER COLUMN sede_id SET NOT NULL;",
    );
    // Las consultas de sólo lectura: la de nulabilidad por tabla y la que deja
    // ver que las claves foráneas siguen puestas.
    expect(raw).toContain("information_schema.columns");
    expect(raw).toContain("is_nullable");
    expect(raw).toContain("pg_constraint");
    // Nombres reales de los objetos que esta unidad NO toca: citarlos en la
    // prosa es dejar constancia de que se conservaron.
    expect(raw).toContain("fk_users_sede");
    expect(raw).toContain("uq_payroll_draft_per_range");
    expect(raw).toContain("ex_payroll_periods_no_overlap");
    // La línea de casa: el archivo no se ejecutó contra una base.
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("control negativo: el detector no es un sello de goma", () => {
    const original = "ALTER TABLE public.users ALTER COLUMN sede_id DROP NOT NULL;";

    // La infracción que abre la unidad: quitar la clave foránea en vez de relajar
    // la columna. Deja filas apuntando a una sede que ya no se valida.
    const sinClaveForanea = raw.replace(original, "ALTER TABLE public.users DROP CONSTRAINT fk_users_sede;");
    expect(sinClaveForanea).not.toBe(raw);
    expect(infracciones073(sinClaveForanea)).toContain("DROP CONSTRAINT");
    // El `DROP` aunque no lo nombre la lista también vuelve culpable al archivo.
    expect(dropsDe073(sinClaveForanea).filter((d) => d !== "NOT NULL")).toEqual([
      "CONSTRAINT FK_USERS_SEDE",
    ]);

    // Las otras tres formas de romper la misma promesa.
    expect(infracciones073(raw.replace(original, "ALTER TABLE public.users DROP COLUMN sede_id;"))).toContain(
      "DROP COLUMN",
    );
    expect(infracciones073(raw.replace(original, "INSERT INTO public.users (email) VALUES ('x@x.com');"))).toContain(
      "INSERT",
    );
    expect(
      infracciones073(raw.replace(original, "ALTER TABLE public.users ALTER COLUMN sede_id SET DEFAULT NULL;")),
    ).toContain("DEFAULT");

    // Y el archivo bueno no tiene infracciones: el detector sólo señala de más
    // cuando hay algo que señalar.
    expect(infracciones073(raw)).toEqual([]);
  });

  it("control negativo: una tabla que se queda obligatoria rompe la lista", () => {
    const sinProductos = raw.replace(
      "ALTER TABLE public.products ALTER COLUMN sede_id DROP NOT NULL;",
      "",
    );
    const tocadas = [
      ...sinProductos.matchAll(/ALTER TABLE public\.([a-z0-9_]+) ALTER COLUMN sede_id DROP NOT NULL;/g),
    ].map((m) => m[1]);
    expect(tocadas).not.toContain("products");
    expect(tocadas).toHaveLength(17);
  });
});

// ----------------- M3b-bis: las unicidades ya no dependen de la sede --------

/**
 * Una unicidad que hoy lleva `sede_id` como elemento, LEÍDA DE LAS MIGRACIONES
 * y no de una lista escrita a mano.
 *
 * La lista no se escribe a propósito: si esta unidad la escribiera a mano, el
 * día en que una migración nueva declare otra unicidad por sede la prueba
 * seguiría verde sobre una base que ya tiene la nueva. Al derivarla, esa
 * migración hace fallar la comparación del inventario y obliga a decidir.
 */
interface UnicidadConSede {
  /** `constraint` = `UNIQUE (…)` en línea; `index` = `CREATE UNIQUE INDEX`. */
  forma: "constraint" | "index";
  tabla: string;
  /** El nombre REAL del objeto en el catálogo, como existe hoy. */
  nombre: string;
  /** Columnas en orden, `sede_id` incluida. */
  columnas: string[];
  /** Las mismas columnas sin `sede_id`: la forma final que 074 debe dejar. */
  sinSede: string[];
  /** El `WHERE` del índice parcial, EXACTO como está escrito; `null` si no es parcial. */
  where: string | null;
  /** La migración que lo declaró. */
  origen: string;
}

/** Una exclusión `EXCLUDE USING gist`, leída del disco. */
interface ExclusionesConSede {
  nombre: string;
  /** Elementos uno por uno, sin partir dentro de un `(` … `)`. */
  elementos: string[];
  origen: string;
}

/**
 * Parte una lista de columnas o de elementos de exclusión por las comas de
 * NIVEL SUPERIOR. Sin esto, `daterange(start_date, end_date, '[]')` se rompería
 * en tres trozos y `uq_sedes_name (lower(btrim(name)))` en dos.
 */
function separarPorComas(cuerpo: string): string[] {
  const partes: string[] = [];
  let actual = "";
  let profundidad = 0;
  for (const caracter of cuerpo) {
    if (caracter === "(") profundidad += 1;
    if (caracter === ")") profundidad -= 1;
    if (caracter === "," && profundidad === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += caracter;
  }
  if (actual.trim()) partes.push(actual);
  return partes.map((parte) => parte.replace(/\s+/g, " ").trim());
}

/** Un solo espacio entre palabras, para comparar SQL sin depender del formato. */
function normalizar(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const DIR_MIGRACIONES = join(process.cwd(), "supabase", "schema-history");

/**
 * Las migraciones que la 074 tiene DELANTE: las numeradas por debajo de ella, en
 * orden. NO las de después, y el corte es deliberado.
 *
 * La 074 reescribe el inventario que existía cuando se corrió. Una migración
 * posterior que declare otra unicidad o exclusión por sede —o que vuelva a
 * declarar un objeto que la 074 ya reescribió— no es un defecto de la 074: es de
 * la unidad que le corresponda, y la 074 no puede soltar un objeto que no existía
 * cuando se aplicó. Sin este corte, la 075 que ya está en el disco —y cualquier
 * 076— puede voltear el inventario derivado y hacer caer una guarda que está
 * correcta, con un mensaje que señala a la 074 un defecto que no tiene.
 *
 * El corte conserva la alarma para lo que sí es alarma: cualquier unicidad o
 * exclusión por sede declarada ANTES de la 074 y que la 074 no reescriba sigue
 * haciendo fallar la prueba.
 */
function migracionesPrevias(): string[] {
  return readdirSync(DIR_MIGRACIONES)
    .filter((n) => n.endsWith(".sql") && n < "074_")
    .sort();
}

/**
 * El SQL sin comentarios: lo que el runner envía a la base. Se parte por línea y
 * se corta en el `--`, como el lector de 073, para que un objeto citado en la
 * prosa de una migración no se confunda con el objeto declarado.
 */
function sqlDeMigracion(fuente: string): string {
  return fuente
    .split("\n")
    .map((linea) => linea.split("--")[0])
    .join("\n");
}

/** Toda unicidad o exclusión que lleva `sede_id` como elemento. */
function unicidadesYExclusionesConSede(): {
  unicidades: UnicidadConSede[];
  exclusiones: ExclusionesConSede[];
} {
  // Una migración posterior puede re-declarar un objeto con otro cuerpo —la 063
  // reemplazó la exclusión de la 035 y le agregó la cadencia—, y gana la ÚLTIMA
  // declaración, que es la que está vigente en el catálogo. Se indexa por nombre
  // por eso: 035 y 063 usan el mismo.
  const unicas = new Map<string, UnicidadConSede>();
  const exclusiones = new Map<string, ExclusionesConSede>();

  for (const archivo of migracionesPrevias()) {
    const texto = sqlDeMigracion(readFileSync(join(DIR_MIGRACIONES, archivo), "utf8"));

    // (a) `UNIQUE (…)` escrito en línea dentro del `CREATE TABLE`: su nombre NO
    //     lo eligió una persona, lo derivó PostgreSQL de las columnas. Ese
    //     nombre derivado es el que hay que soltar en 074.
    for (const bloque of texto.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g,
    )) {
      const tabla = bloque[1];
      for (const linea of bloque[2].split("\n")) {
        const declarado = linea.match(/^\s*UNIQUE\s*\(([^)]*)\)/i);
        if (!declarado) continue;
        const columnas = separarPorComas(declarado[1]);
        if (!columnas.includes("sede_id")) continue;
        unicas.set(`${tabla}_${columnas.join("_")}_key`, {
          forma: "constraint",
          tabla,
          nombre: `${tabla}_${columnas.join("_")}_key`,
          columnas,
          sinSede: columnas.filter((columna) => columna !== "sede_id"),
          where: null,
          origen: archivo,
        });
      }
    }

    // (b) `CREATE UNIQUE INDEX`: nombre elegido a mano, columnas y `WHERE`.
    for (const declarado of texto.matchAll(
      /CREATE UNIQUE INDEX (?:IF NOT EXISTS )?([a-z0-9_]+)\s+ON public\.([a-z0-9_]+)\s*\(([^)]*)\)\s*(WHERE\b[^;]*)?;/g,
    )) {
      const [, nombre, tabla, columnasCrudas, whereCrudo] = declarado;
      const columnas = separarPorComas(columnasCrudas);
      if (!columnas.includes("sede_id")) continue;
      unicas.set(nombre, {
        forma: "index",
        tabla,
        nombre,
        columnas,
        sinSede: columnas.filter((columna) => columna !== "sede_id"),
        where: whereCrudo ? normalizar(whereCrudo) : null,
        origen: archivo,
      });
    }

    // (c) `EXCLUDE USING gist (…)`, con el nombre que su migración le dio.
    for (const declarado of texto.matchAll(
      /ADD CONSTRAINT ([a-z0-9_]+)\s+EXCLUDE USING gist\s*\(([^;]*)\);/g,
    )) {
      const elementos = separarPorComas(declarado[2]);
      if (!elementos.some((elemento) => /^sede_id\b/.test(elemento))) continue;
      exclusiones.set(declarado[1], { nombre: declarado[1], elementos, origen: archivo });
    }
  }

  return { unicidades: [...unicas.values()], exclusiones: [...exclusiones.values()] };
}

/** El nombre que PostgreSQL deriva de un `UNIQUE (…)`. */
function nombreDerivado(tabla: string, columnas: string[]): string {
  return `${tabla}_${columnas.join("_")}_key`;
}

/**
 * Lo que 074 DEBE dejar de un objeto, en forma de texto normalizado. Es la
 * misma forma que se le inyecta a los controles negativos: el motor es uno solo,
 * así que un control negativo que pasa es un defecto real del detector.
 */
function formaFinal(objeto: UnicidadConSede): {
  soltar: string;
  declarar: RegExp;
  esperado: string;
} {
  if (objeto.forma === "constraint") {
    const nuevo = nombreDerivado(objeto.tabla, objeto.sinSede);
    return {
      soltar: `DROP CONSTRAINT IF EXISTS ${objeto.nombre}`,
      declarar: new RegExp(String.raw`ADD CONSTRAINT ${nuevo}\s+UNIQUE\s*\(([^)]*)\)`, "i"),
      esperado: `ADD CONSTRAINT ${nuevo} UNIQUE (${objeto.sinSede.join(", ")})`,
    };
  }
  return {
    soltar: `DROP INDEX IF EXISTS public.${objeto.nombre}`,
    declarar: new RegExp(
      String.raw`CREATE UNIQUE INDEX ${objeto.nombre}\s+ON public\.${objeto.tabla}\s*\(([^)]*)\)(\s*WHERE\b[^;]*)?;`,
      "i",
    ),
    esperado: `CREATE UNIQUE INDEX ${objeto.nombre} ON public.${objeto.tabla} (${objeto.sinSede.join(", ")})`,
  };
}

/**
 * El motor de la guarda: devuelve una lista de FALTAS (vacía = el archivo
 * cumple). Trabaja sobre el TEXTO del archivo, no sobre el disco, para que los
 * controles negativos puedan inyectarle un 074 sintético.
 */
function revisarSedeLess(
  fuente: string,
  esperado: { unicidades: UnicidadConSede[]; exclusiones: ExclusionesConSede[] },
): string[] {
  const sql = normalizar(sqlDeMigracion(fuente)).toLowerCase();
  const falta: string[] = [];

  // (0) Nada que destruya: esta unidad quita una restricción y la repone.
  const destructivas: Array<[string, RegExp]> = [
    ["DELETE", /\bdelete\b/i],
    ["UPDATE", /\bupdate\b/i],
    ["TRUNCATE", /\btruncate\b/i],
    ["DROP COLUMN", /\bdrop\s+column\b/i],
    ["DROP TABLE", /\bdrop\s+table\b/i],
    ["DROP POLICY", /\bdrop\s+policy\b/i],
  ];
  for (const [etiqueta, patron] of destructivas) {
    if (patron.test(fuente)) falta.push(`sentencia destructiva ${etiqueta}`);
  }

  // (1) Cada unicidad por sede queda reescrita sin `sede_id`, con el resto igual.
  for (const objeto of esperado.unicidades) {
    const { soltar, declarar, esperado: definicionEsperada } = formaFinal(objeto);
    if (!sql.includes(soltar.toLowerCase())) {
      falta.push(`${objeto.nombre}: no se suelta`);
      continue;
    }
    const hallada = declarar.exec(sql);
    if (!hallada) {
      falta.push(`${objeto.nombre}: no se vuelve a declarar`);
      continue;
    }
    const declarada = normalizar(hallada[0]);
    const columnas = separarPorComas(hallada[1]);
    if (columnas.join(", ") !== objeto.sinSede.join(", ")) {
      falta.push(
        `${objeto.nombre}: columnas ${columnas.join(", ")} en vez de ${objeto.sinSede.join(", ")}`,
      );
      continue;
    }
    // `sede_id` no puede quedar como COLUMNA. El nombre del objeto sí puede
    // contenerlo —`uq_invoices_sede_idempotency_key` es un nombre ELEGIDO, no
    // derivado de las columnas—, así que la comparación es sobre el cuerpo con
    // el nombre puesto aparte.
    const cuerpo = declarada
      .replaceAll(objeto.nombre, "")
      .replaceAll(nombreDerivado(objeto.tabla, objeto.sinSede), "");
    if (cuerpo.includes("sede_id")) {
      falta.push(`${objeto.nombre}: la definición todavía nombra sede_id`);
    }
    if (!declarada.startsWith(definicionEsperada.toLowerCase())) {
      falta.push(`${objeto.nombre}: la definición no es la esperada (${declarada})`);
    }
    // El `WHERE` de un parcial se copia al carácter: es lo que decide qué filas
    // entran al índice, y cambiarlo cambia el alcance de la garantía.
    if (objeto.where !== null) {
      const whereHallado = hallada[2] ? normalizar(hallada[2]) : "";
      if (whereHallado.toLowerCase() !== objeto.where.toLowerCase()) {
        falta.push(`${objeto.nombre}: WHERE ${whereHallado} en vez de ${objeto.where}`);
      }
    }
  }

  // (2) La exclusión: MISMO nombre y exactamente los elementos que quedan.
  for (const objeto of esperado.exclusiones) {
    if (!sql.includes(`drop constraint if exists ${objeto.nombre}`.toLowerCase())) {
      falta.push(`${objeto.nombre}: no se suelta`);
      continue;
    }
    const declarada = new RegExp(
      String.raw`ADD CONSTRAINT ([a-z0-9_]+)\s+EXCLUDE USING gist\s*\(([^;]*)\);`,
      "i",
    ).exec(sql);
    if (!declarada) {
      falta.push(`${objeto.nombre}: no se vuelve a declarar`);
      continue;
    }
    if (declarada[1].toLowerCase() !== objeto.nombre.toLowerCase()) {
      falta.push(
        `${objeto.nombre}: renombrada a ${declarada[1]} (el nombre es un contrato de ejecución)`,
      );
    }
    const elementos = separarPorComas(declarada[2]);
    const esperados = objeto.elementos.filter((elemento) => !/^sede_id\b/.test(elemento));
    if (elementos.length !== esperados.length) {
      falta.push(`${objeto.nombre}: ${elementos.length} elementos en vez de ${esperados.length}`);
    }
    if (elementos.join(" | ").toLowerCase() !== esperados.join(" | ").toLowerCase()) {
      falta.push(
        `${objeto.nombre}: elementos ${elementos.join(" | ")} en vez de ${esperados.join(" | ")}`,
      );
    }
  }

  return falta;
}

/**
 * Un delimitador de cadena con `$`: `$$` o `$etiqueta$`. Es la forma EXACTA que
 * acepta el léxico de PostgreSQL —una `$` suelta, o una pegada al identificador,
 * no encierran nada— y por eso es la única forma que este archivo debe usar.
 */
const DELIMITADOR_DOLLAR = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/;

/** Todos los delimitadores bien formados que el archivo declara, en orden. */
function etiquetasDollar(sql: string): string[] {
  return sql.match(/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/g) ?? [];
}

/** Un delimitador con `$` que apareció dentro de un literal de comilla simple. */
interface LitoTragado {
  /** La línea del delimitador tragado. */
  linea: number;
  /** La línea donde se abrió el literal que lo tragó. */
  abre: number;
  etiqueta: string;
}

/** Una comilla que CIERRA un literal y delante de la cual queda un identificador. */
interface ComillaPegada {
  /** La línea de la comilla que cierra el literal. */
  linea: number;
  /** El identificador pegado: la palabra que se quedó fuera del literal. */
  palabra: string;
}

/**
 * El motor de la guarda de literales: devuelve una lista de FALTAS (vacía = el
 * archivo cumple). Trabaja sobre el TEXTO, como `revisarSedeLess`, para que los
 * controles negativos puedan inyectarle un 074 sintético.
 *
 * Exige cinco cosas, y las cinco importan por un motivo DISTINTO —las dos
 * primeras son la misma familia de errata de etiqueta, las dos siguientes son las
 * que impedían que el archivo se analizara, y la quinta es la que la paridad no
 * puede ver:
 *
 *   * que cada `$` abra o cierre un delimitador BIEN FORMADO (`$$` o
 *     `$etiqueta$`): un `s$q$` deja la `$` pegada al identificador, que es
 *     justo la errata que empalma el cuerpo de una consulta con el de la otra;
 *   * que dentro de una cadena CON etiqueta no aparezca OTRA: un `$$` ahí es
 *     un delimitador que no cierra nada. El anidamiento sólo se admite dentro
 *     del `$$` del bloque `DO`, que es donde las consultas `$q$` viven;
 *   * que cada etiqueta distinta aparezca un número PAR de veces, que es el
 *     emparejamiento: un par impar significa un literal sin terminar, y el
 *     archivo entero deja de analizarse en la sentencia donde se abre;
 *   * que dentro del cuerpo de cada `DO $$ … $$` no quede un literal de COMILLA
 *     SIMPLE sin cerrar. Ésa es la que rompía el archivo: una comilla de menos en
 *     la etiqueta de una fila del `VALUES` cierra el literal antes de tiempo, el
 *     paréntesis de la fila se consume de más, y el analizador llega a la
 *     consulta que sigue esperando `LOOP`.
 *   * y —en TODO el archivo, no sólo en los bloques `DO`— que ninguna comilla
 *     que CIERRA un literal lleve un identificador pegado detrás. Es la quinta
 *     porque las otras cuatro no la ven: una comilla sin doblar que abre una
 *     palabra por dentro sigue dejando el número de comillas PAR, así que el
 *     conteo, la paridad y el «literal sin cerrar» dan el archivo por bueno
 *     mientras la base responde 42601. El detalle de por qué la posición del
 *     signo es la única señal está en `contarLiteralesSimples`.
 */
function revisarLiterales(fuente: string): string[] {
  const sql = sqlDeMigracion(fuente);
  const falta: string[] = [];
  const lineaDe = (pos: number) => sql.slice(0, pos).split("\n").length;
  const abiertas: Array<{ etiqueta: string; linea: number; desde: number }> = [];
  const cuerposDo: Array<{ desde: number; hasta: number }> = [];

  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "$") {
      i += 1;
      continue;
    }
    const cierre = DELIMITADOR_DOLLAR.exec(sql.slice(i));
    if (!cierre) {
      falta.push(`línea ${lineaDe(i)}: \`$\` suelta, no abre ni cierra un delimitador`);
      i += 1;
      continue;
    }
    const etiqueta = cierre[0];
    const previa = i > 0 ? sql[i - 1] : "";
    if (/[A-Za-z0-9_]/.test(previa)) {
      falta.push(
        `línea ${lineaDe(i)}: \`${previa}${etiqueta}\` — la etiqueta no puede ir pegada a un identificador; cierre con \`${etiqueta}\``,
      );
      i += etiqueta.length;
      continue;
    }
    const abierta = abiertas[abiertas.length - 1];
    if (abierta && abierta.etiqueta !== etiqueta && abierta.etiqueta !== "$$") {
      falta.push(
        `línea ${lineaDe(i)}: \`${etiqueta}\` dentro de la cadena \`${abierta.etiqueta}\` abierta en la línea ${abierta.linea}`,
      );
      i += etiqueta.length;
      continue;
    }
    if (abierta && abierta.etiqueta === etiqueta) {
      // El cuerpo del `DO $$ … $$` se vuelve a recorrer como PL/pgSQL más abajo,
      // y empieza DESPUÉS del delimitador de apertura: si el recorrido arrancara
      // en él, el propio `$$` se tragaría el cuerpo entero como una cadena opaca
      // y no habría nada que contar.
      if (etiqueta === "$$") {
        cuerposDo.push({ desde: abierta.desde + etiqueta.length, hasta: i });
      }
      abiertas.pop();
    } else {
      abiertas.push({ etiqueta, linea: lineaDe(i), desde: i });
    }
    i += etiqueta.length;
  }
  for (const abierta of abiertas) {
    falta.push(`línea ${abierta.linea}: la cadena \`${abierta.etiqueta}\` nunca se cierra`);
  }

  // Y el conteo por etiqueta: par es emparejada, impar es un literal colgado.
  const conteo = new Map<string, number>();
  for (const etiqueta of etiquetasDollar(sql)) {
    conteo.set(etiqueta, (conteo.get(etiqueta) ?? 0) + 1);
  }
  for (const [etiqueta, veces] of conteo) {
    if (veces % 2 !== 0) falta.push(`\`${etiqueta}\` aparece ${veces} veces y no queda emparejada`);
  }

  // Y los literales simples del cuerpo de cada `DO $$ … $$`.
  for (const cuerpo of cuerposDo) {
    const simples = contarLiteralesSimples(sql, cuerpo.desde, cuerpo.hasta);
    for (const pegada of simples.pegadas) {
      falta.push(
        `línea ${pegada.linea}: la comilla que cierra el literal deja pegada la palabra \`${pegada.palabra}\` — en un literal hay que doblarla (\`''${pegada.palabra}''\`); así la palabra se sale del literal y PostgreSQL responde 42601`,
      );
    }
    for (const tragado of simples.tragados) {
      falta.push(
        `línea ${tragado.linea}: el literal de comilla simple que abre en la línea ${tragado.abre} se tragó el delimitador \`${tragado.etiqueta}\` — el lector perdió la cuenta en ese punto`,
      );
    }
    for (const linea of simples.sinCerrar) {
      falta.push(
        `línea ${linea}: el literal de comilla simple que abre aquí no se cierra antes del final del bloque \`DO $$ … $$\``,
      );
    }
  }

  // Y la misma regla FUERA de los bloques `DO`: un literal suelto —un
  // `COMMENT`, un `RAISE`, una sentencia de nivel superior— también puede
  // perder una comilla al medio, y ahí no hay bloque que lo revise. En este
  // recorrido los cuerpos con `$$` son opacos, así que lo ya contado arriba no
  // aparece dos veces.
  const exterior = contarLiteralesSimples(sql, 0, sql.length);
  for (const pegada of exterior.pegadas) {
    falta.push(
      `línea ${pegada.linea}: la comilla que cierra el literal deja pegada la palabra \`${pegada.palabra}\` — en un literal hay que doblarla (\`''${pegada.palabra}''\`); así la palabra se sale del literal y PostgreSQL responde 42601`,
    );
  }

  return falta;
}

/**
 * Recorre el texto COMO PL/pgSQL y cuenta los literales de comilla simple: las
 * comillas dobladas `''` son una comilla DENTRO del literal, no un cierre, y un
 * literal con `$` es contenido opaco que se salta entero. Es lo que permite
 * distinguir un literal bien cerrado de uno que se tragó el resto del cuerpo.
 *
 * Deja tres rastros, y los tres son del mismo defecto leído de tres maneras:
 *
 *   * `tragados`: un delimitador con `$` apareció DENTRO de un literal simple.
 *     En este bloque ninguna construcción legítima lo hace —las consultas `$q$`
 *     están fuera de todo literal— así que es la línea exacta donde el lector
 *     perdió la cuenta, que no es la misma que la del final del litigio;
 *   * `sinCerrar`: el bloque terminó con un literal abierto;
 *   * `pegadas`: una comilla que CIERRA un literal tiene un identificador pegado
 *     detrás. Es el rastro que la paridad NO ve, y por eso hace falta: en
 *     `'… WHERE status = 'borrador')'` hay CUATRO comillas —un número par, un
 *     conteo parejo, ningún literal sin cerrar— y sin embargo `borrador` queda
 *     FUERA del literal, como identificador suelto, que es exactamente lo que
 *     PostgreSQL rechaza con 42601.
 *
 * POR QUÉ LA POSICIÓN DEL SIGNO ES LA SEÑAL. En el léxico de PostgreSQL la
 * comilla que abre va DESPUÉS del prefijo (`E'…'`, `B'…'`, `X'…'`, `U&'…'`) y la
 * que cierra va al final del literal, nunca pegada a nada: ningún constructor
 * continúa con una letra, un dígito o un `_` sin separador. Así que una
 * comilla de cierre seguida de `[A-Za-z0-9_$]` no es una forma rara de escribir
 * un literal: es la única forma que tiene una comilla Suelta de cerrar donde
 * debía seguir abierta, con la palabra de adentro escapada por delante. Y el
 * otro lado —la apertura— NO se puede usar para esto, porque `E'…'` pega una
 * letra a la comilla de apertura en cada literal con escapes de este archivo.
 * Lo que se reporta es la PALABRA entera pegada, no una letra: el mensaje dice
 * qué escribir (`''palabra''`) sin que el lector tenga que volver al archivo.
 *
 * `desde`/`hasta` son posiciones en `sql`, y las líneas que devuelve son de `sql`.
 */
function contarLiteralesSimples(
  sql: string,
  desde: number,
  hasta: number,
): {
  abiertos: number;
  cerrados: number;
  tragados: LitoTragado[];
  sinCerrar: number[];
  pegadas: ComillaPegada[];
} {
  const lineaDe = (pos: number) => sql.slice(0, pos).split("\n").length;
  const tragados: LitoTragado[] = [];
  const sinCerrar: number[] = [];
  const pegadas: ComillaPegada[] = [];
  let dentro = false;
  let abierta = 0;
  let abiertos = 0;
  let cerrados = 0;

  let i = desde;
  while (i < hasta) {
    const ch = sql[i];
    if (dentro && ch === "$") {
      const delim = DELIMITADOR_DOLLAR.exec(sql.slice(i, hasta));
      if (delim) {
        tragados.push({ linea: lineaDe(i), abre: abierta, etiqueta: delim[0] });
        const cierre = sql.indexOf(delim[0], i + delim[0].length);
        i = cierre === -1 || cierre > hasta ? hasta : cierre + delim[0].length;
        continue;
      }
    }
    if (!dentro && ch === "-" && sql[i + 1] === "-") {
      const salto = sql.indexOf("\n", i);
      i = salto === -1 || salto > hasta ? hasta : salto + 1;
      continue;
    }
    if (!dentro && ch === "$") {
      const delim = DELIMITADOR_DOLLAR.exec(sql.slice(i, hasta));
      if (delim) {
        const cierre = sql.indexOf(delim[0], i + delim[0].length);
        i = cierre === -1 || cierre > hasta ? hasta : cierre + delim[0].length;
        continue;
      }
    }
    if (ch === "'") {
      if (dentro && sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      dentro = !dentro;
      if (dentro) {
        abiertos += 1;
        abierta = lineaDe(i);
      } else {
        cerrados += 1;
        // La comilla que acaba de cerrar: si detrás viene un identificador, la
        // palabra se salió del literal. Se registra acá, y no al final, porque
        // la posición del signo es lo único que distingue el defecto del par
        // de comillas bien formado que lo contiene.
        const pegado = /^[A-Za-z0-9_$]+/.exec(sql.slice(i + 1, hasta));
        if (pegado) pegadas.push({ linea: lineaDe(i), palabra: pegado[0] });
      }
    }
    i += 1;
  }
  if (dentro) sinCerrar.push(abierta);
  return { abiertos, cerrados, tragados, sinCerrar, pegadas };
}

describe("migración 074_sede_less_constraints.sql (M3b)", () => {
  const raw = readFileSync(join(DIR_MIGRACIONES, "074_sede_less_constraints.sql"), "utf8");
  const sql = sqlDeMigracion(raw);
  const derivado = unicidadesYExclusionesConSede();

  /**
   * El único índice único por sede que 074 NO toca, y la razón: el `upsert` de
   * `src/features/commissions/service.ts` infiere su `ON CONFLICT` con las
   * CUATRO columnas, y la inferencia exige coincidencia exacta. Sin `sede_id` en
   * el índice, ese `upsert` falla con 42P10 en cada alta y edición de regla. El
   * cambio correcto es el otro orden: primero el `onConflict` del servicio,
   * después el índice.
   */
  const ENLISTADO = "uq_commission_rule";
  const objetos = derivado.unicidades.filter((u) => u.nombre !== ENLISTADO);
  const esperado = { unicidades: objetos, exclusiones: derivado.exclusiones };

  it("el inventario derivado de las migraciones es el conocido", () => {
    // Si una migración futura declara otra unicidad o exclusión por sede, esta
    // comparación falla pidiendo el nombre nuevo: es la alarma que obliga a
    // decidir si esta unidad —o la que corresponda— tiene que reescribirla.
    expect(derivado.unicidades.map((u) => u.nombre).sort()).toEqual([
      "cash_denominations_sede_id_value_key",
      "cash_registers_sede_id_name_key",
      "invoices_sede_id_consecutive_number_key",
      "payment_methods_sede_id_code_key",
      "products_sede_id_sku_key",
      "tax_configs_sede_id_code_name_key",
      "uq_commission_rule",
      "uq_employees_sede_code",
      "uq_invoices_sede_idempotency_key",
      "uq_payroll_draft_per_range",
    ]);
    expect(derivado.exclusiones.map((e) => e.nombre)).toEqual([
      "ex_payroll_periods_no_overlap",
    ]);
  });

  it("deriva del disco las nueve unicidades que 074 reescribe", () => {
    expect(objetos).toHaveLength(9);
    // El origen se cita uno por uno para que una definición movida de archivo se
    // note en la prueba, y no en la base.
    expect(objetos.map((o) => `${o.origen}:${o.nombre}`)).toEqual([
      "003_admin.sql:tax_configs_sede_id_code_name_key",
      "003_admin.sql:payment_methods_sede_id_code_key",
      "003_admin.sql:uq_employees_sede_code",
      "004_inventory.sql:products_sede_id_sku_key",
      "005_billing.sql:invoices_sede_id_consecutive_number_key",
      "006_cash.sql:cash_registers_sede_id_name_key",
      "007_payroll.sql:uq_payroll_draft_per_range",
      "010_cash_denominations.sql:cash_denominations_sede_id_value_key",
      "041_invoice_idempotency.sql:uq_invoices_sede_idempotency_key",
    ]);
    // Y todas llevan `sede_id` hoy: eso es exactamente lo que 074 les quita.
    for (const objeto of objetos) expect(objeto.columnas).toContain("sede_id");
    // Los tres parciales traen su `WHERE`, que hay que conservar al carácter.
    expect(objetos.filter((o) => o.where !== null).map((o) => o.nombre)).toEqual([
      "uq_employees_sede_code",
      "uq_payroll_draft_per_range",
      "uq_invoices_sede_idempotency_key",
    ]);
  });

  it("074 reescribe cada una sin sede_id, conservando el resto y el WHERE", () => {
    expect(revisarSedeLess(raw, esperado)).toEqual([]);
  });

  it("la exclusión conserva el nombre y deja exactamente los dos elementos", () => {
    const origen = derivado.exclusiones[0];
    // Leída del disco: hoy son `sede_id` + el cubo de cadencia + el rango.
    expect(origen.origen).toBe("063_nomina_frecuencias.sql");
    expect(origen.elementos).toEqual([
      "sede_id WITH =",
      "coalesce(frequency, '') WITH =",
      "daterange(start_date, end_date, '[]') WITH &&",
    ]);

    const declarada = new RegExp(
      String.raw`ADD CONSTRAINT ex_payroll_periods_no_overlap\s+EXCLUDE USING gist\s*\(([^;]*)\);`,
      "i",
    ).exec(normalizar(sql));
    expect(declarada).not.toBeNull();
    expect(separarPorComas(declarada![1])).toEqual([
      "coalesce(frequency, '') WITH =",
      "daterange(start_date, end_date, '[]') WITH &&",
    ]);
    // Ni un `sede_id` suelto, ni un tercer elemento disfrazado.
    expect(normalizar(sql)).not.toContain("sede_id WITH =");
    expect(normalizar(sql).match(/WITH (=|&&)/g) ?? []).toHaveLength(2);
    // Y el nombre no cambió: es el que el dominio y el mapeo 23P01 →
    // PERIOD_OVERLAP usan para hablar de la garantía.
    expect(raw).toContain("DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap;");
    // Contado sobre el SQL SIN comentarios: la sección de reversión repite la
    // declaración como texto comentado y no es una segunda declaración.
    expect(normalizar(sql).match(/ADD CONSTRAINT ex_payroll_periods_no_overlap/g) ?? []).toHaveLength(1);
  });

  it("el pre-vuelo existe, va primero y aborta en vez de borrar", () => {
    const preVuelo = sql.indexOf("DO $$");
    const primeraCaida = sql.search(/\bDROP\s+(CONSTRAINT|INDEX)\b/i);
    expect(preVuelo).toBeGreaterThan(-1);
    expect(preVuelo).toBeLessThan(primeraCaida);

    // Aborta nombrando las filas y|elevation qué hacer: no reescribe nada.
    expect(raw).toContain("RAISE EXCEPTION");
    expect(raw).toContain("ABORTADA");
    expect(raw).toContain("No se borró, no se fusionó y no se reescribió ninguna fila");
    expect(raw).toContain("vuelva a correr el archivo completo");

    // Y chequea los diez puntos: cada objeto reescrito y el solape de nómina.
    for (const objeto of objetos) {
      expect(raw, `el pre-vuelo no chequea ${objeto.nombre}`).toContain(objeto.nombre);
    }
    expect(raw).toContain("ex_payroll_periods_no_overlap -> (coalesce(frequency");
  });

  it("no borra ni reescribe datos, y cada DROP es sobre un objeto conocido", () => {
    for (const sentencia of [
      /\bDELETE\b/i,
      /\bUPDATE\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+POLICY\b/i,
    ]) {
      expect(raw).not.toMatch(sentencia);
    }
    // Cada `DROP` del archivo (contada la prosa, que repite la reversión) suelta
    // un objeto de la lista: el nombre viejo o el que deriva de las columnas sin
    // sede. Nada más se suelta en este archivo.
    const conocidos = new Set<string>([
      ...objetos.map((o) => o.nombre),
      ...objetos
        .filter((o) => o.forma === "constraint")
        .map((o) => nombreDerivado(o.tabla, o.sinSede)),
      "ex_payroll_periods_no_overlap",
    ]);
    // Dieciséis nombres: los nueve de hoy, los seis que deriva PostgreSQL de las
    // columnas sin sede, y el de la exclusión.
    expect(conocidos.size).toBe(16);
    for (const caida of raw.matchAll(/\bDROP\s+CONSTRAINT\s+IF EXISTS\s+([a-z0-9_]+)/gi)) {
      expect([...conocidos]).toContain(caida[1]);
    }
    for (const caida of raw.matchAll(/\bDROP\s+INDEX\s+IF EXISTS\s+(?:public\.)?([a-z0-9_]+)/gi)) {
      expect([...conocidos]).toContain(caida[1]);
    }
    // Y hay de las dos clases: la exclusión y las nueve unicidades.
    expect([...raw.matchAll(/\bDROP\s+CONSTRAINT\b/gi)].length).toBeGreaterThan(1);
    expect([...raw.matchAll(/\bDROP\s+INDEX\b/gi)].length).toBeGreaterThan(1);
  });

  it("el índice que queda compuesto está declarado como tal, con su motivo", () => {
    // La excepción es explícita y con su razón: si alguien la mueve sin leerla,
    // la guardia de abajo y el comentario la señalan.
    expect(raw).toContain("uq_commission_rule");
    expect(raw).toContain('onConflict: "sede_id,item_type,item_id,employee_id"');
    expect(raw).toContain("src/features/commissions/service.ts");
    expect(raw).toContain("42P10");
    expect(normalizar(sql)).not.toMatch(/\bDROP\s+INDEX\s+IF EXISTS\s+public\.uq_commission_rule/i);
  });

  it("declara el motivo, el orden, la nota del editor SQL y que no se ejecutó", () => {
    expect(raw).toContain("una sola sede");
    expect(raw).toContain("ADITIVO, IDEMPOTENTE Y RE-EJECUTABLE");
    expect(raw).toContain("CONFIRMA SENTENCIA POR SENTENCIA");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    // Las consultas de sólo lectura.
    expect(raw).toContain("pg_get_constraintdef");
    expect(raw).toContain("pg_indexes");
  });

  it("control negativo: una UNIQUE que conserva sede_id queda señalada", () => {
    // La forma obvia: el nombre viejo vuelve con sus dos columnas.
    const conSede = raw.replace(
      "ADD CONSTRAINT products_sku_key UNIQUE (sku);",
      "ADD CONSTRAINT products_sede_id_sku_key UNIQUE (sede_id, sku);",
    );
    expect(conSede).not.toBe(raw);
    // El archivo mutado ya no declara la forma final que este objeto debe dejar.
    expect(revisarSedeLess(conSede, esperado).join(" | ")).toContain("no se vuelve a declarar");

    // Y la sutil: el nombre nuevo correcto, la columna de más.
    const conSedeMisma = raw.replace(
      "ADD CONSTRAINT products_sku_key UNIQUE (sku);",
      "ADD CONSTRAINT products_sku_key UNIQUE (sede_id, sku);",
    );
    const falta = revisarSedeLess(conSedeMisma, esperado).join(" | ");
    expect(falta).toContain("columnas sede_id, sku en vez de sku");
  });

  it("control negativo: la exclusión renombrada queda señalada", () => {
    const renombrada = raw
      .replace(
        "DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap;",
        "DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap_sede;",
      )
      .replace(
        "ADD CONSTRAINT ex_payroll_periods_no_overlap\n  EXCLUDE USING gist",
        "ADD CONSTRAINT ex_payroll_periods_no_overlap_sede\n  EXCLUDE USING gist",
      );
    expect(renombrada).not.toBe(raw);
    const falta = revisarSedeLess(renombrada, esperado).join(" | ");
    expect(falta).toContain("ex_payroll_periods_no_overlap");
    expect(falta).toContain("contrato de ejecución");
  });

  it("control negativo: un WHERE de parcial alterado queda señalado", () => {
    // El `WHERE` decide qué filas entran al índice: aflojarlo metería filas que
    // la garantía excluye a propósito (un empleado sin código, una factura sin
    // marca). Es el cambio que el detector tiene que ver aunque las columnas
    // estén perfectitas.
    const aflojado = raw.replace(
      "WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';",
      "WHERE employee_code IS NOT NULL;",
    );
    expect(aflojado).not.toBe(raw);
    expect(revisarSedeLess(aflojado, esperado).join(" | ")).toContain(
      "WHERE where employee_code is not null",
    );
  });

  it("cada literal del archivo está bien formado y emparejado", () => {
    expect(revisarLiterales(raw)).toEqual([]);
    // Y no pasa en vacío: el archivo declara UN bloque `DO $$` y DIEZ consultas
    // `$q$`, o sea veinte delimitadores. Es el conteo que la paridad protege.
    const etiquetas = etiquetasDollar(sql);
    expect(etiquetas.filter((e) => e === "$$")).toHaveLength(2);
    expect(etiquetas.filter((e) => e === "$q$")).toHaveLength(20);
  });

  it("ninguna comilla cierra un literal dejando una palabra pegada (074 y 075)", () => {
    // La clase que la paridad NO ve: un número PAR de comillas con una palabra
    // escapada por delante. Se recorre el archivo entero —no sólo el bloque
    // `DO`— porque un literal suelto (`COMMENT`, `RAISE`, sentencia de nivel
    // superior) pierde la comilla igual de fácil. 075 entra por el mismo motor:
    // sus literales viven en el `RAISE` del pre-vuelo, y sus consultas de sólo
    // lectura son comentarios que el lector ni toca.
    const con075 = readFileSync(
      join(DIR_MIGRACIONES, "075_commission_rule_install_key.sql"),
      "utf8",
    );
    expect(revisarLiterales(raw), "074").toEqual([]);
    expect(revisarLiterales(con075), "075").toEqual([]);

    // Y la etiqueta de la fila del borrador sigue MOSTRANDO la palabra entre
    // comillas: lo que se dobló es el signo, no el texto.
    expect(raw).toContain("WHERE status = ''borrador'')',");
  });

  it("control negativo: una comilla sin doblar que escapa una palabra queda señalada", () => {
    // El defecto de la 074 reinyectado tal cual: la etiqueta de la fila del
    // borrador vuelve a llevar `status = 'borrador'` con la comilla Suelta.
    const reinfectado = raw.replace(
      "WHERE status = ''borrador'')',",
      "WHERE status = 'borrador')',",
    );
    expect(reinfectado).not.toBe(raw);
    const falta = revisarLiterales(reinfectado).join(" | ");
    // Lo nombra por la palabra que se salió del literal y por su línea, que es
    // más útil que un conteo: dice QUÉ corregir y DÓNDE.
    expect(falta).toContain("deja pegada la palabra `borrador`");
    expect(falta).toContain("línea 256");
    // Y ÉSTA es la prueba de que la paridad sola no alcanza: la línea rota tiene
    // CUATRO comillas —un número PAR—, así que el conteo queda parejo, ningún
    // literal queda abierto y ninguna de las otras reglas se activa. La única
    // falla es la de la posición del signo.
    const lineaRota = reinfectado.split("\n")[255];
    expect(lineaRota).toContain("status = 'borrador'");
    expect(lineaRota.match(/'/g)).toHaveLength(4);
    expect(revisarLiterales(reinfectado)).toHaveLength(1);
    expect(falta).not.toContain("no se cierra antes del final");

    // Y el detector no dispara con lo único que PostgreSQL SÍ permite pegado a
    // una comilla: el prefijo de la que ABRE (`E'…'`, `B'…'`, `X'…'`). La regla
    // mira el cierre, y el cierre nunca lleva prefijo.
    const conPrefijo = raw.replace(
      "    EXECUTE v_ch.consulta INTO v_detalle;",
      "    v_informe := v_informe || E'\\n  ';\n    EXECUTE v_ch.consulta INTO v_detalle;",
    );
    expect(conPrefijo).not.toBe(raw);
    expect(revisarLiterales(conPrefijo)).toEqual([]);
  });

  it("control negativo: una etiqueta pegada al identificador queda señalada", () => {
    // La errata exacta que estuvo en el archivo: el cierre queda `s$q$)` en vez
    // de `$q$)`, y desde ahí el cuerpo se empalma con la consulta que sigue.
    const conErrata = raw.replace("LIMIT 5)$q$),", "LIMIT 5) s$q$),");
    expect(conErrata).not.toBe(raw);
    const falta = revisarLiterales(conErrata).join(" | ");
    expect(falta).toContain("la etiqueta no puede ir pegada a un identificador");
  });

  it("control negativo: un literal sin cerrar y un $ suelto quedan señalados", () => {
    // Una etiqueta de más: `$q$` queda con una apertura y un cierre —que es par—
    // pero el cuerpo que sigue se lleva por delante el resto del archivo.
    const descolgado = raw.replace("END $$;", "$q$");
    expect(descolgado).not.toBe(raw);
    expect(revisarLiterales(descolgado).join(" | ")).toContain("nunca se cierra");

    // Y una `$` que no forma delimitador: el error más chato de todos.
    const suelta = raw.replace("DO $$", "DO $");
    expect(suelta).not.toBe(raw);
    expect(revisarLiterales(suelta).join(" | ")).toContain("`$` suelta");
  });

  it("control negativo: un literal simple sin cerrar queda señalado por su línea", () => {
    // El defecto que REALMENTE impedía que el archivo se analizara, reinyectado
    // tal cual: la etiqueta de la fila de la exclusión pierde la comilla que
    // dobla la de `'[]'`, el literal cierra antes de tiempo y el resto del
    // cuerpo queda desincronizado hasta el final del bloque.
    const sinComilla = raw.replace("end_date, ''[]''))',", "end_date, '[]''))',");
    expect(sinComilla).not.toBe(raw);
    const falta = revisarLiterales(sinComilla).join(" | ");
    expect(falta).toContain("literal de comilla simple");
    // Y nombra la línea donde el literal quedó abierto, que es la 266.
    expect(falta).toContain("línea 266");
  });

  it("control negativo: el lector de PL/pgSQL no confunde las comillas dobladas", () => {
    // Las comillas dobladas `''` SON una comilla dentro del literal: contarlas
    // como cierre y apertura haría que un literal bien cerrado pareciera roto.
    const dobladas = raw.replace(
      "    EXECUTE v_ch.consulta INTO v_detalle;",
      "    v_informe := v_informe || '''';\n    EXECUTE v_ch.consulta INTO v_detalle;",
    );
    expect(dobladas).not.toBe(raw);
    expect(revisarLiterales(dobladas)).toEqual([]);

    // Y un literal simple a medio cerrar en ese mismo punto sí se ve.
    const aMedio = raw.replace(
      "    EXECUTE v_ch.consulta INTO v_detalle;",
      "    v_informe := v_informe || 'a medio cerrar;\n    EXECUTE v_ch.consulta INTO v_detalle;",
    );
    expect(revisarLiterales(aMedio).join(" | ")).toContain("literal de comilla simple");
  });

  it("control negativo: el detector no es un sello de goma", () => {
    expect(revisarSedeLess(raw, esperado)).toEqual([]);
    expect(revisarSedeLess("", esperado).length).toBeGreaterThan(0);
  });
});
