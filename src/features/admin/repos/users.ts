/**
 * Port of the admin user management (installation users, their roles, the
 * employee link checks and the two identity RPCs), its supabase-js adapter
 * and the selector — same pattern as `./catalogs.ts`.
 *
 * `supabaseAdminUsersRepo` keeps the requests the service sent before the
 * extraction (76acb65), with two intentional changes applied on BOTH engines:
 *   - the sede of `listSedeUsers` travels as a double-quoted PostgREST literal
 *     (the unquoted value let `,` `)` `"` inject logic-tree syntax); Drizzle
 *     binds it as a typed parameter;
 *   - its order gains the `id` tie-breaker: `full_name` alone was not total.
 *
 * `upsert_employee_atomic` and `replace_user_roles` remain the transactional
 * unit on both engines. `./users.drizzle.ts` is loaded with import() only when
 * DB_ENGINE=postgres. Both throw `DbQueryError` (SQLSTATE and message kept).
 * SECRETS: the new account's password hash is an RPC parameter; `toDbError`
 * never copies Drizzle's "params:" text and the service never forwards it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import type { RoleCode } from "@/src/features/auth/schemas";
import type { EmployeeCatalogRow } from "./catalogs";

export interface SedeUserRecord {
  id: string;
  sede_id: string | null;
  full_name: string;
  id_number: string;
}

/** One `user_roles` row with its many-to-one `roles(code)` embed: object or null. */
export interface UserRoleEmbed {
  user_id: string;
  roles: { code: string } | null;
}

/** `p_employee` of `upsert_employee_atomic` and the legajo columns of an edit. */
export interface EmployeeAtomicWrite {
  full_name: string;
  employee_code: string | null;
  document: string;
  phone: string | null;
  position: string | null;
  payout_mode?: string;
  email: string | null;
  birth_date: string | null;
  pay_type: string;
  pay_frequency: string | null;
  salary_fixed: number | null;
  commission_percent: number | null;
  is_active?: boolean;
}

export interface EmployeeWrite extends EmployeeAtomicWrite {
  id: string;
  user_id: string | null;
}

/** `p_create_user` of `upsert_employee_atomic`. */
export interface NewEmployeeUser {
  sede_id: string;
  email: string | null;
  phone: string | null;
  id_type: "CC";
  id_number: string;
  password_hash: string;
  full_name: string;
}

export interface AdminUsersRepo {
  /** Users of the installation plus the ones without sede, ordered by full_name, id. */
  listSedeUsers(sedeId: string): Promise<SedeUserRecord[]>;
  roleEmbeds(userIds: string[]): Promise<UserRoleEmbed[]>;
  /** `roles(code)` of one user (no user_id in the row, like the PostgREST read). */
  userRoleEmbeds(userId: string): Promise<Array<Pick<UserRoleEmbed, "roles">>>;
  findUserByDocument(document: string): Promise<{ id: string } | null>;
  employeeForUser(userId: string, exceptId?: string): Promise<Array<{ id: string }>>;
  employeeCodeConflicts(code: string, exceptId?: string): Promise<Array<{ id: string }>>;
  upsertEmployeeAtomic(write: EmployeeAtomicWrite, userId: string | null, createUser: NewEmployeeUser | null, roleCode: "empleado"): Promise<EmployeeCatalogRow | null>;
  upsertEmployee(write: EmployeeWrite): Promise<EmployeeCatalogRow | null>;
  /** `replace_user_roles`: the applied codes (text[]). */
  replaceUserRoles(userId: string, roleCodes: RoleCode[]): Promise<unknown>;
}

const USER = "id, sede_id, full_name, id_number";
const EMPLOYEE_SELECT =
  "id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, pay_frequency, salary_fixed, commission_percent, is_active";

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

/** A PostgREST logic-tree value as data: double-quoted, `\` and `"` escaped. */
export function quotePostgrestLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function supabaseAdminUsersRepo(db: SupabaseClient): AdminUsersRepo {
  return {
    async listSedeUsers(sedeId) {
      const { data, error } = await db
        .from("users")
        .select(USER)
        .or(`sede_id.eq.${quotePostgrestLiteral(sedeId)},sede_id.is.null`)
        .order("full_name")
        .order("id");
      if (error) fail(error);
      return (data ?? []) as SedeUserRecord[];
    },
    async roleEmbeds(userIds) {
      const { data, error } = await db.from("user_roles").select("user_id, roles(code)").in("user_id", userIds);
      if (error) fail(error);
      return (data ?? []) as unknown as UserRoleEmbed[];
    },
    async userRoleEmbeds(userId) {
      const { data, error } = await db.from("user_roles").select("roles(code)").eq("user_id", userId);
      if (error) fail(error);
      return (data ?? []) as unknown as Array<Pick<UserRoleEmbed, "roles">>;
    },
    async findUserByDocument(document) {
      const { data, error } = await db.from("users").select("id").eq("id_number", document).maybeSingle();
      if (error) fail(error);
      return (data ?? null) as { id: string } | null;
    },
    async employeeForUser(userId, exceptId) {
      const query = db.from("employees").select("id").eq("user_id", userId).limit(1);
      const { data, error } = exceptId ? await query.neq("id", exceptId) : await query;
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string }>;
    },
    async employeeCodeConflicts(code, exceptId) {
      const query = db.from("employees").select("id").eq("employee_code", code).limit(1);
      const { data, error } = exceptId ? await query.neq("id", exceptId) : await query;
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string }>;
    },
    async upsertEmployeeAtomic(write, userId, createUser, roleCode) {
      const { data, error } = await db.rpc("upsert_employee_atomic", {
        p_employee: write,
        p_user_id: userId,
        p_create_user: createUser,
        p_role_code: roleCode,
      });
      if (error) fail(error);
      return (data ?? null) as EmployeeCatalogRow | null;
    },
    async upsertEmployee(write) {
      const { data, error } = await db.from("employees").upsert(write, { onConflict: "id" }).select(EMPLOYEE_SELECT).single();
      if (error) fail(error);
      return (data ?? null) as EmployeeCatalogRow | null;
    },
    async replaceUserRoles(userId, roleCodes) {
      const { data, error } = await db.rpc("replace_user_roles", { p_user_id: userId, p_role_codes: roleCodes });
      if (error) fail(error);
      return data;
    },
  };
}

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function adminUsersRepo(): Promise<AdminUsersRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleAdminUsersRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./users.drizzle"),
    ]);
    return drizzleAdminUsersRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseAdminUsersRepo(createAdminClient());
}
