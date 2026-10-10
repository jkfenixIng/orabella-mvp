/**
 * Port of the admin catalogs that are plain table reads/writes (tax configs,
 * payment methods, the bounded employee list), their supabase-js adapter and
 * the selector — same pattern as `./services.ts`.
 *
 * `supabaseCatalogsRepo` holds the requests the service sent before the
 * extraction, unchanged. `./catalogs.drizzle.ts` is loaded with import() only
 * when DB_ENGINE=postgres. Both throw `DbQueryError` on a database failure.
 *
 * Out of this port on purpose (still supabase-js in the service): reads with
 * the `roles(code)` embed, the `upsert_employee_atomic` / `replace_user_roles`
 * RPCs, the `.or()` user listing and the paged/maybeSingle employee reads.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import type { ArqueoMode } from "../schemas";

export interface TaxConfigRow {
  id: string;
  code: string;
  name: string;
  percent: number;
  is_active: boolean;
}

export interface PaymentMethodRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  /** Derived compatibility flag: `arqueo_mode !== "none"` (003 trigger). */
  arqueable: boolean;
  arqueo_mode: ArqueoMode;
  fee_percent: number;
}

export interface EmployeeCatalogRow {
  id: string;
  user_id: string | null;
  full_name: string;
  employee_code: string | null;
  document: string;
  phone: string | null;
  position: string | null;
  payout_mode: string;
  email: string | null;
  birth_date: string | null;
  pay_type: string;
  pay_frequency: string | null;
  salary_fixed: number | null;
  commission_percent: number | null;
  is_active: boolean;
}

type TaxRow = TaxConfigRow;
type PaymentRow = PaymentMethodRow;
export interface TaxWrite {
  id?: string;
  code: string;
  name: string;
  percent: number;
  is_active?: boolean;
}
export interface PaymentMethodFields {
  name: string;
  is_active?: boolean;
  arqueo_mode?: PaymentRow["arqueo_mode"];
  fee_percent?: number;
}
export interface PaymentMethodInsert extends PaymentMethodFields {
  code: string;
  arqueo_mode: PaymentRow["arqueo_mode"];
}
export interface CatalogsRepo {
  listTaxes(limit: number): Promise<TaxRow[]>;
  upsertTax(row: TaxWrite): Promise<TaxRow | null>;
  listPaymentMethods(limit: number): Promise<PaymentRow[]>;
  findPaymentMethod(id: string): Promise<Pick<PaymentRow, "code"> | null>;
  updatePaymentMethod(id: string, fields: PaymentMethodFields): Promise<PaymentRow | null>;
  insertPaymentMethod(row: PaymentMethodInsert): Promise<PaymentRow | null>;
  listEmployees(limit: number): Promise<EmployeeCatalogRow[]>;
  /** One employee by id; `null` when there is none (maybeSingle). */
  findEmployee(id: string): Promise<EmployeeCatalogRow | null>;
}
const TAX = "id, code, name, percent, is_active";
const PAYMENT = "id, code, name, is_active, arqueable, arqueo_mode, fee_percent";
const EMPLOYEE =
  "id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, pay_frequency, salary_fixed, commission_percent, is_active";

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

export function supabaseCatalogsRepo(db: SupabaseClient): CatalogsRepo {
  return {
    async listTaxes(limit) {
      const { data, error } = await db.from("tax_configs").select(TAX).order("code").order("id").limit(limit);
      if (error) fail(error);
      return (data ?? []) as TaxRow[];
    },
    async upsertTax(row) {
      const { data, error } = await db.from("tax_configs").upsert(row, { onConflict: "id" }).select(TAX).single();
      if (error) fail(error);
      return (data ?? null) as TaxRow | null;
    },
    async listPaymentMethods(limit) {
      const { data, error } = await db.from("payment_methods").select(PAYMENT).order("code").limit(limit);
      if (error) fail(error);
      return (data ?? []) as PaymentRow[];
    },
    async findPaymentMethod(id) {
      const { data, error } = await db.from("payment_methods").select("code").eq("id", id).maybeSingle();
      if (error) fail(error);
      return (data ?? null) as Pick<PaymentRow, "code"> | null;
    },
    async updatePaymentMethod(id, fields) {
      const { data, error } = await db
        .from("payment_methods")
        .update(fields)
        .eq("id", id)
        .select(PAYMENT)
        .single();
      if (error) fail(error);
      return (data ?? null) as PaymentRow | null;
    },
    async insertPaymentMethod(row) {
      const { data, error } = await db.from("payment_methods").insert(row).select(PAYMENT).single();
      if (error) fail(error);
      return (data ?? null) as PaymentRow | null;
    },
    async listEmployees(limit) {
      const { data, error } = await db.from("employees").select(EMPLOYEE).order("full_name").order("id").limit(limit);
      if (error) fail(error);
      return (data ?? []) as EmployeeCatalogRow[];
    },
    async findEmployee(id) {
      const { data, error } = await db.from("employees").select(EMPLOYEE).eq("id", id).maybeSingle();
      if (error) fail(error);
      return (data ?? null) as EmployeeCatalogRow | null;
    },
  };
}

/** The adapter for the configured engine; dependencies load only on demand. */
export async function catalogsRepo(): Promise<CatalogsRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleCatalogsRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./catalogs.drizzle"),
    ]);
    return drizzleCatalogsRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseCatalogsRepo(createAdminClient());
}
