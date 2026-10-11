/**
 * Direct PostgreSQL adapter of the admin catalogs port (`./catalogs.ts`).
 * SERVER ONLY, loaded with import() only when DB_ENGINE=postgres; the
 * database is injected so the tests run it against PGlite.
 *
 * Writes send only the keys the supabase-js payload carries, so column
 * defaults and the 003 trigger on `payment_methods` (immutable code,
 * `arqueable` derived from `arqueo_mode`) act exactly as they do behind
 * PostgREST. Their RAISE EXCEPTION reaches the service as a `DbQueryError`
 * with the SQLSTATE and message unchanged.
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import type { PagedResponse } from "@/src/shared/lib/paged";
import { employees, paymentMethods, taxConfigs } from "@/src/shared/db/schema";
import type {
  CatalogsRepo,
  EmployeeCatalogRow,
  PaymentMethodFields,
  PaymentMethodRow,
  TaxConfigRow,
} from "./catalogs";

const TAX_COLUMNS = {
  id: taxConfigs.id,
  code: taxConfigs.code,
  name: taxConfigs.name,
  percent: taxConfigs.percent,
  is_active: taxConfigs.isActive,
};

const PAYMENT_METHOD_COLUMNS = {
  id: paymentMethods.id,
  code: paymentMethods.code,
  name: paymentMethods.name,
  is_active: paymentMethods.isActive,
  arqueable: paymentMethods.arqueable,
  arqueo_mode: paymentMethods.arqueoMode,
  fee_percent: paymentMethods.feePercent,
};

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

/** numeric reaches the domain as a number, never as the driver's text. */
const numericValue = (value: unknown) => (typeof value === "number" ? value : Number(value));
const nullableNumericValue = (value: unknown) => (value === null || value === undefined ? null : numericValue(value));

function toTaxRow(row: { [K in keyof TaxConfigRow]: unknown }): TaxConfigRow {
  return { ...(row as TaxConfigRow), percent: numericValue(row.percent) };
}

function toPaymentMethodRow(row: { [K in keyof PaymentMethodRow]: unknown }): PaymentMethodRow {
  return { ...(row as PaymentMethodRow), fee_percent: numericValue(row.fee_percent) };
}

function toEmployeeRow(row: { [K in keyof EmployeeCatalogRow]: unknown }): EmployeeCatalogRow {
  return {
    ...(row as EmployeeCatalogRow),
    salary_fixed: nullableNumericValue(row.salary_fixed),
    commission_percent: nullableNumericValue(row.commission_percent),
  };
}

/** Only the keys present in `fields`, renamed to the Drizzle columns. */
function paymentMethodSet(fields: PaymentMethodFields) {
  return {
    name: fields.name,
    ...(fields.is_active !== undefined ? { isActive: fields.is_active } : {}),
    ...(fields.arqueo_mode !== undefined ? { arqueoMode: fields.arqueo_mode } : {}),
    ...(fields.fee_percent !== undefined ? { feePercent: fields.fee_percent } : {}),
  };
}

async function run<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new DbQueryError(toDbError(error));
  }
}

export function drizzleCatalogsRepo(db: Database): CatalogsRepo {
  return {
    listTaxes: (limit) =>
      run(async () => {
        const rows = await db.select(TAX_COLUMNS).from(taxConfigs).orderBy(asc(taxConfigs.code), asc(taxConfigs.id)).limit(limit);
        return rows.map(toTaxRow);
      }),
    upsertTax: (write) =>
      run(async () => {
        const rows = await db
          .insert(taxConfigs)
          .values({
            ...(write.id ? { id: write.id } : {}),
            code: write.code,
            name: write.name,
            percent: write.percent,
            ...(write.is_active !== undefined ? { isActive: write.is_active } : {}),
          })
          .onConflictDoUpdate({
            target: taxConfigs.id,
            set: {
              code: sql.raw("excluded.code"),
              name: sql.raw("excluded.name"),
              percent: sql.raw("excluded.percent"),
              ...(write.is_active !== undefined ? { isActive: sql.raw("excluded.is_active") } : {}),
            },
          })
          .returning(TAX_COLUMNS);
        return rows[0] ? toTaxRow(rows[0]) : null;
      }),
    listPaymentMethods: (limit) =>
      run(async () => {
        const rows = await db
          .select(PAYMENT_METHOD_COLUMNS)
          .from(paymentMethods)
          .orderBy(asc(paymentMethods.code))
          .limit(limit);
        return rows.map(toPaymentMethodRow);
      }),
    findPaymentMethod: (id) =>
      run(async () => {
        const rows = await db
          .select({ code: paymentMethods.code })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, id))
          .limit(2);
        // maybeSingle(): more than one row is an error, never the first one.
        if (rows.length > 1) throw { code: "PGRST116", message: "JSON object requested, multiple rows returned" };
        return rows[0] ?? null;
      }),
    updatePaymentMethod: (id, fields) =>
      run(async () => {
        const rows = await db
          .update(paymentMethods)
          .set(paymentMethodSet(fields))
          .where(eq(paymentMethods.id, id))
          .returning(PAYMENT_METHOD_COLUMNS);
        if (rows.length === 0) {
          throw { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "0 rows" };
        }
        return toPaymentMethodRow(rows[0]);
      }),
    insertPaymentMethod: (write) =>
      run(async () => {
        const rows = await db
          .insert(paymentMethods)
          .values({ code: write.code, ...paymentMethodSet(write), arqueoMode: write.arqueo_mode })
          .returning(PAYMENT_METHOD_COLUMNS);
        return rows[0] ? toPaymentMethodRow(rows[0]) : null;
      }),
    listEmployees: (limit) =>
      run(async () => {
        const rows = await db.select(EMPLOYEE_COLUMNS).from(employees).orderBy(asc(employees.fullName), asc(employees.id)).limit(limit);
        return rows.map(toEmployeeRow);
      }),
    findEmployee: (id) =>
      run(async () => {
        // The primary key makes a second row impossible; maybeSingle semantics = row or null.
        const rows = await db.select(EMPLOYEE_COLUMNS).from(employees).where(eq(employees.id, id)).limit(1);
        return rows[0] ? toEmployeeRow(rows[0]) : null;
      }),
    employeesPage: async (from, to): Promise<PagedResponse<EmployeeCatalogRow> & { count: null }> => {
      try {
        const rows = await db
          .select(EMPLOYEE_COLUMNS)
          .from(employees)
          .orderBy(asc(employees.fullName), asc(employees.id))
          .offset(from)
          .limit(to - from + 1);
        return { data: rows.map(toEmployeeRow), error: null, count: null };
      } catch (error) {
        return { data: null, error: toDbError(error), count: null };
      }
    },
  };
}
