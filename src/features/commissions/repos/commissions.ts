/**
 * Port of the commissions data access, its supabase-js adapter and the engine
 * selector (same pattern as `src/features/inventory/repos/inventory.ts`).
 *
 * The repository only reads and writes rows: the commission rule resolution,
 * the pending arithmetic and the cash checks stay in the service. On both
 * engines the database keeps the money authority on the payout INSERT:
 * `trg_commission_payouts_balance_guard` (003, per-method minimum) and
 * `trg_commission_payouts_cap` (034, cumulative cap), each statement in its own
 * implicit transaction. No client-side transaction wraps them, so the lock
 * order those triggers take (cash_shifts -> balance row -> invoices) is never
 * inverted by an earlier lock held here.
 *
 * Phase 3b-3 intentional change on BOTH adapters: `id` tie-breakers make the
 * rule list (created_at, id) and the payout list (paid_at DESC, id DESC) total
 * orders. `./commissions.drizzle.ts` is loaded with import() only when
 * DB_ENGINE=postgres. Both adapters throw `DbQueryError` (SQLSTATE and message
 * kept, so the service keeps matching 23505 / P0001 / CASH_METHOD_* the same way).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import type { CommissionPayoutRow, CommissionRuleRow } from "../schemas";

export interface RuleWrite {
  id?: string;
  item_type: "producto" | "servicio";
  item_id: string;
  employee_id: string;
  percent: number | null;
  amount: number | null;
  is_active?: boolean;
}

export interface PayoutWrite {
  employee_id: string;
  invoice_id: string;
  cash_shift_id: string;
  method_code: string;
  base_subtotal: number;
  percent_applied: number | null;
  fixed_applied: number | null;
  earned_immediate: number;
  amount: number;
  paid_by: string;
  idempotency_key: string;
}

export interface InvoiceLine {
  item_type: string;
  product_id: string | null;
  service_id: string | null;
  qty: number;
  unit_price: number;
  subtotal: number;
  no_commission: boolean | null;
  commission_value: number | null;
  commission_percent_override: number | null;
}

export interface ActiveRule {
  item_type: string;
  item_id: string;
  percent: number | null;
  amount: number | null;
}

export interface CommissionRepo {
  /** Ordered by created_at, id. */
  listRules(filters: { item_type?: string; item_id?: string; employee_id?: string }): Promise<CommissionRuleRow[]>;
  itemExists(table: "products" | "services", id: string): Promise<boolean>;
  employeeExists(id: string): Promise<boolean>;
  employeeRate(id: string): Promise<{ pay_type: string; commission_percent: number | null } | null>;
  employeePayoutMode(id: string): Promise<string | null>;
  /** INSERT ... ON CONFLICT (item_type, item_id, employee_id) DO UPDATE of the sent keys. */
  upsertRule(write: RuleWrite): Promise<CommissionRuleRow | null>;
  deleteRule(id: string): Promise<{ id: string } | null>;
  invoiceStatus(id: string): Promise<{ id: string; status: string } | null>;
  invoiceLines(invoiceId: string, employeeId: string): Promise<InvoiceLine[]>;
  activeRules(employeeId: string): Promise<ActiveRule[]>;
  /** Amounts already paid immediately for the pair (the service sums them). */
  paidAmounts(invoiceId: string, employeeId: string): Promise<number[]>;
  findPayoutByKey(invoiceId: string, employeeId: string, idempotencyKey: string): Promise<CommissionPayoutRow | null>;
  insertPayout(write: PayoutWrite): Promise<CommissionPayoutRow | null>;
  /** Ordered by paid_at, id descending; at most 200. */
  listPayouts(filters: { employee_id?: string; invoice_id?: string; shift_id?: string }): Promise<CommissionPayoutRow[]>;
}

export const PAYOUT_LIST_LIMIT = 200;

// ---------------------------------------------------------------- supabase ---

const RULE_SELECT = "id, item_type, item_id, employee_id, percent, amount, is_active";
const PAYOUT_SELECT =
  "id, employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, percent_applied, fixed_applied, earned_immediate, amount, paid_by, paid_at";
const LINE_SELECT =
  "item_type, product_id, service_id, qty, unit_price, subtotal, no_commission, commission_value, commission_percent_override";

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

export function supabaseCommissionRepo(db: SupabaseClient): CommissionRepo {
  const one = async <T>(request: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> => {
    const { data, error } = await request;
    if (error) fail(error);
    return (data as T | null) ?? null;
  };
  const many = async <T>(request: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    const { data, error } = await request;
    if (error) fail(error);
    return (data ?? []) as T[];
  };
  return {
    listRules(filters) {
      let query = db.from("commission_rules").select(RULE_SELECT);
      if (filters.item_type) query = query.eq("item_type", filters.item_type);
      if (filters.item_id) query = query.eq("item_id", filters.item_id);
      if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
      return many(query.order("created_at").order("id"));
    },
    async itemExists(table, id) {
      return (await one(db.from(table).select("id").eq("id", id).maybeSingle())) !== null;
    },
    async employeeExists(id) {
      return (await one(db.from("employees").select("id").eq("id", id).maybeSingle())) !== null;
    },
    employeeRate: (id) => one(db.from("employees").select("pay_type, commission_percent").eq("id", id).maybeSingle()),
    async employeePayoutMode(id) {
      return (await one<{ payout_mode: string }>(db.from("employees").select("payout_mode").eq("id", id).maybeSingle()))?.payout_mode ?? null;
    },
    upsertRule(write) {
      const { id, is_active, ...rest } = write;
      const payload = { ...(id ? { id } : {}), ...rest, ...(is_active !== undefined ? { is_active } : {}) };
      // The installation key of migration 075 (uq_commission_rule_install_key).
      return one(db.from("commission_rules").upsert(payload, { onConflict: "item_type,item_id,employee_id" }).select(RULE_SELECT).single());
    },
    deleteRule: (id) => one(db.from("commission_rules").delete().eq("id", id).select("id").maybeSingle()),
    invoiceStatus: (id) => one(db.from("invoices").select("id, status").eq("id", id).maybeSingle()),
    invoiceLines: (invoiceId, employeeId) =>
      many(db.from("invoice_items").select(LINE_SELECT).eq("invoice_id", invoiceId).eq("employee_id", employeeId)),
    activeRules: (employeeId) =>
      many(db.from("commission_rules").select("item_type, item_id, percent, amount").eq("employee_id", employeeId).eq("is_active", true)),
    async paidAmounts(invoiceId, employeeId) {
      const rows = await many<{ amount: number | string }>(
        db.from("commission_payouts").select("amount").eq("invoice_id", invoiceId).eq("employee_id", employeeId),
      );
      return rows.map((row) => Number(row.amount));
    },
    findPayoutByKey: (invoiceId, employeeId, idempotencyKey) =>
      one(
        db
          .from("commission_payouts")
          .select(PAYOUT_SELECT)
          .eq("invoice_id", invoiceId)
          .eq("employee_id", employeeId)
          .eq("idempotency_key", idempotencyKey)
          .limit(1)
          .maybeSingle(),
      ),
    insertPayout: (write) => one(db.from("commission_payouts").insert(write).select(PAYOUT_SELECT).single()),
    listPayouts(filters) {
      let query = db.from("commission_payouts").select(PAYOUT_SELECT);
      if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
      if (filters.invoice_id) query = query.eq("invoice_id", filters.invoice_id);
      if (filters.shift_id) query = query.eq("cash_shift_id", filters.shift_id);
      return many(query.order("paid_at", { ascending: false }).order("id", { ascending: false }).limit(PAYOUT_LIST_LIMIT));
    },
  };
}

// ---------------------------------------------------------------- selector ---

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function commissionsRepo(): Promise<CommissionRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleCommissionRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./commissions.drizzle"),
    ]);
    return drizzleCommissionRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseCommissionRepo(createAdminClient());
}
