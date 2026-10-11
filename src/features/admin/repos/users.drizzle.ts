import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { callRpc } from "@/src/shared/db/rpc";
import { employees, roles, userRoles, users } from "@/src/shared/db/schema";
import type { EmployeeCatalogRow } from "./catalogs";
import type { AdminUsersRepo, EmployeeAtomicWrite, EmployeeWrite, NewEmployeeUser, SedeUserRecord } from "./users";

const EMPLOYEE_COLUMNS = {
  id: employees.id,
  user_id: employees.userId,
  full_name: employees.fullName,
  employee_code: employees.employeeCode,
  document: employees.document,
  phone: employees.phone,
  position: employees.position,
  payout_mode: employees.payoutMode,
  email: employees.email,
  birth_date: employees.birthDate,
  pay_type: employees.payType,
  pay_frequency: employees.payFrequency,
  salary_fixed: employees.salaryFixed,
  commission_percent: employees.commissionPercent,
  is_active: employees.isActive,
};

function employeeRow(row: { [K in keyof EmployeeCatalogRow]: unknown }): EmployeeCatalogRow {
  return {
    ...(row as EmployeeCatalogRow),
    salary_fixed: row.salary_fixed === null ? null : Number(row.salary_fixed),
    commission_percent: row.commission_percent === null ? null : Number(row.commission_percent),
  };
}

/** Only keys sent by the PostgREST payload: defaults and update omissions match it. */
function employeeSet(write: EmployeeWrite): typeof employees.$inferInsert {
  return {
    id: write.id,
    userId: write.user_id,
    fullName: write.full_name,
    employeeCode: write.employee_code,
    document: write.document,
    phone: write.phone,
    position: write.position,
    ...(write.payout_mode !== undefined ? { payoutMode: write.payout_mode } : {}),
    email: write.email,
    birthDate: write.birth_date,
    payType: write.pay_type,
    payFrequency: write.pay_frequency,
    salaryFixed: write.salary_fixed,
    commissionPercent: write.commission_percent,
    ...(write.is_active !== undefined ? { isActive: write.is_active } : {}),
  } as typeof employees.$inferInsert;
}

async function run<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new DbQueryError(toDbError(error));
  }
}

export function drizzleAdminUsersRepo(db: Database): AdminUsersRepo {
  return {
    listSedeUsers: (sedeId) =>
      run(() =>
        db
          .select({ id: users.id, sede_id: users.sedeId, full_name: users.fullName, id_number: users.idNumber })
          .from(users)
          .where(or(eq(users.sedeId, sedeId), isNull(users.sedeId)))
          .orderBy(asc(users.fullName), asc(users.id)) as Promise<SedeUserRecord[]>,
      ),
    roleEmbeds: (userIds) =>
      run(async () => {
        const rows = await db
          .select({ user_id: userRoles.userId, code: roles.code })
          .from(userRoles)
          .leftJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, userIds));
        return rows.map((row) => ({ user_id: row.user_id, roles: row.code === null ? null : { code: row.code } }));
      }),
    userRoleEmbeds: (userId) =>
      run(async () => {
        const rows = await db
          .select({ code: roles.code })
          .from(userRoles)
          .leftJoin(roles, eq(roles.id, userRoles.roleId))
          .where(eq(userRoles.userId, userId));
        return rows.map((row) => ({ roles: row.code === null ? null : { code: row.code } }));
      }),
    findUserByDocument: (document) =>
      run(async () => (await db.select({ id: users.id }).from(users).where(eq(users.idNumber, document)).limit(1))[0] ?? null),
    employeeForUser: (userId, exceptId) =>
      run(() =>
        db
          .select({ id: employees.id })
          .from(employees)
          .where(exceptId ? and(eq(employees.userId, userId), ne(employees.id, exceptId)) : eq(employees.userId, userId))
          .limit(1),
      ),
    employeeCodeConflicts: (code, exceptId) =>
      run(() =>
        db
          .select({ id: employees.id })
          .from(employees)
          .where(exceptId ? and(eq(employees.employeeCode, code), ne(employees.id, exceptId)) : eq(employees.employeeCode, code))
          .limit(1),
      ),
    upsertEmployeeAtomic: (write: EmployeeAtomicWrite, userId: string | null, createUser: NewEmployeeUser | null, roleCode: "empleado") =>
      run(() =>
        callRpc<EmployeeCatalogRow | null>(db, "upsert_employee_atomic", [
          { value: write, cast: "jsonb" },
          { value: userId, cast: "uuid" },
          { value: createUser, cast: "jsonb" },
          { value: roleCode, cast: "text" },
        ]),
      ),
    upsertEmployee: (write) =>
      run(async () => {
        const rows = await db
          .insert(employees)
          .values(employeeSet(write))
          .onConflictDoUpdate({ target: employees.id, set: employeeSet(write) })
          .returning(EMPLOYEE_COLUMNS);
        return rows[0] ? employeeRow(rows[0]) : null;
      }),
    replaceUserRoles: (userId, roleCodes) =>
      run(() =>
        callRpc<unknown>(db, "replace_user_roles", [
          { value: userId, cast: "uuid" },
          { value: roleCodes, cast: "text[]" },
        ]),
      ),
  };
}
