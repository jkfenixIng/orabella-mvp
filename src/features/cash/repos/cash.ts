/**
 * Cash data port, its supabase-js adapter and the engine selector.
 *
 * Every method returns the `{ data, error }` (or `{ count, error }`) result the
 * service already read from PostgREST, so business decisions (`23505`,
 * `23514`, `P0001` trigger messages, `PGRST116`, paged-read failures) stay in
 * `../service.ts` and behave the same on both engines. Money arithmetic, the
 * arqueo, validation, authorization and domain errors stay in the service; the
 * four monetary writes stay PostgreSQL functions (one statement = one unit of
 * work). One operation uses ONE repository: engines are never mixed.
 *
 * Intentional total orders (both engines): `id` tie-breakers on registers
 * (created_at, id), the open shift (opened_at DESC, id DESC), the last closed
 * shift (closed_at DESC, opened_at DESC, id DESC), the day view (opened_at, id;
 * still exactly 50 rows), the history (opened_at DESC, id DESC), the mirror
 * lookup of a repeated collection (id) and the counts of one phase (id). Every
 * paged source keeps its `id` order (the pagination order of CL-21).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import type { PagedResponse } from "@/src/shared/lib/paged";

export type CashDbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };
export type CashResult<T> = { data: T | null; error: CashDbError | null };
export type CashCount = { count: number | null; error: CashDbError | null };
export type CashPage<T> = Promise<PagedResponse<T>>;

export interface DenominationWrite {
  id?: string;
  kind: "billete" | "moneda";
  value: number;
  is_active?: boolean;
}

export interface DrawerPaymentWrite {
  cash_shift_id: string;
  invoice_id: null;
  method_id: string;
  method_code: string;
  amount: number;
  user_id: string;
  idempotency_key: string;
}

export interface MirrorLookup {
  invoiceId: string;
  shiftId: string;
  methodCode: string;
  amount: number;
}

export interface OpenShiftArgs { registerId: string; openedBy: string; openingBase: number; counts: unknown }
export interface CloseShiftArgs { shiftId: string; closedBy: string; closedAt: string; close: unknown; counts: unknown; collectionCounts: unknown }
export interface RecountShiftArgs { shiftId: string; recountedBy: string; recount: unknown; counts: unknown }
export interface InvoicePaymentArgs {
  shiftId: string;
  invoiceId: string;
  userId: string;
  closedAt: string;
  setShift: boolean;
  markPaid: boolean;
  collection: unknown;
}

export interface CashRepo {
  // catalog
  listActiveDenominations<T>(): Promise<CashResult<T[]>>;
  upsertDenomination<T>(write: DenominationWrite): Promise<CashResult<T>>;
  deleteDenomination(id: string): Promise<CashResult<null>>;
  listRegisters<T>(): Promise<CashResult<T[]>>;
  getRegister<T>(id: string): Promise<CashResult<T>>;
  firstActiveRegister<T>(): Promise<CashResult<T>>;
  ensureDefaultRegister<T>(write: { name: string; base_configurada: number }): Promise<CashResult<T>>;
  updateRegisterBase<T>(id: string, base: number): Promise<CashResult<T>>;
  // shifts
  getOpenShift<T>(): Promise<CashResult<T>>;
  getShift<T>(id: string): Promise<CashResult<T>>;
  openShiftIdsForRegister(registerId: string): Promise<CashResult<Array<{ id: string }>>>;
  lastClosedShiftForRegister(registerId: string): Promise<CashResult<{ id: string; base_left: number | null }>>;
  listShiftCounts(shiftId: string, phase: string): Promise<CashResult<Array<{ method_code: string; amount: number | string }>>>;
  findRecountId(shiftId: string): Promise<CashResult<{ id: string }>>;
  userFullName(id: string): Promise<CashResult<{ full_name: string | null }>>;
  userNames(ids: string[]): Promise<CashResult<Array<{ id: string; full_name: string }>>>;
  // payments and idempotency
  findPaymentByIdempotency<T>(shiftId: string, key: string): Promise<CashResult<T>>;
  insertPaymentWithoutInvoice<T>(write: DrawerPaymentWrite): Promise<CashResult<T>>;
  findInvoicePaymentByIdempotency<T>(invoiceId: string, key: string): Promise<CashResult<T[]>>;
  findInvoicePaymentMirror<T>(lookup: MirrorLookup): Promise<CashResult<T>>;
  // 003 method balances
  methodBalance(shiftId: string, methodCode: string): Promise<CashResult<{ opening_base: number | string }>>;
  listShiftMethodBalances(shiftId: string): Promise<CashResult<Array<{ method_code: string; opening_base: number | string }>>>;
  expectedMethodBalance(shiftId: string, methodCode: string): Promise<CashResult<number>>;
  // arqueo sources: one `range(from, to)` page each, in `id` order
  voucherOutColumns(): Promise<boolean>;
  shiftCountsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  payoutsByShiftsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  vouchersByShiftsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  invoicePaymentsByShiftsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  invoicesByShiftsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  historicInvoicePaymentsPage<T>(invoiceIds: string[], from: number, to: number): CashPage<T>;
  recountsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  drawerPaymentsPage<T>(shiftId: string, from: number, to: number): CashPage<T>;
  shiftPayoutsPage<T>(shiftId: string, from: number, to: number): CashPage<T>;
  drawerPaymentsByShiftsPage<T>(shiftIds: string[], from: number, to: number): CashPage<T>;
  // monetary units of work (PostgreSQL functions)
  openShiftAtomic<T>(args: OpenShiftArgs): Promise<CashResult<T>>;
  closeShiftAtomic<T>(args: CloseShiftArgs): Promise<CashResult<T>>;
  recountShiftAtomic<T>(args: RecountShiftArgs): Promise<CashResult<T>>;
  invoicePaymentAtomic<T>(args: InvoicePaymentArgs): Promise<CashResult<T>>;
  // views
  dayShifts<T>(from: string, to: string): Promise<CashResult<T[]>>;
  historyCount(from: string, to: string): Promise<CashCount>;
  historyPage<T>(from: string, to: string, offset: number, limit: number): Promise<CashResult<T[]>>;
}

export const DAY_VIEW_LIMIT = 50;
export const REGISTER_SELECT = "id, name, base_configurada, is_active";
export const SHIFT_SELECT =
  "id, cash_register_id, opened_by, closed_by, opened_at, closed_at, opening_base, expected_cash, counted_cash, base_left, cash_withdrawn, base_difference, status, observation";
export const PAYMENT_SELECT = "id, cash_shift_id, invoice_id, method_id, method_code, amount, user_id, created_at";
export const DENOMINATION_SELECT = "id, kind, value, is_active";
export const INVOICE_PAYMENT_KEY_SELECT =
  "id, invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id, created_at, idempotency_key";
export const RECOUNT_SELECT =
  "id, shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn, previous_base_difference, counted_cash, base_left, cash_withdrawn, base_difference, reason, recounted_by, recounted_at";

// 028 (method_code/cash_shift_id on voucher_requests) may be missing in an old
// Supabase database: only a "column absent" answer is cached. DB_ENGINE=postgres
// runs on 001-004, where the columns always exist.
let voucherOutColumns: boolean | null = null;

const page = <T>(query: PromiseLike<unknown>) => query as unknown as CashPage<T>;
const result = <T>(query: PromiseLike<unknown>) => query as unknown as Promise<CashResult<T>>;

export function supabaseCashRepo(db: SupabaseClient): CashRepo {
  return {
    listActiveDenominations: () =>
      result(db.from("cash_denominations").select(DENOMINATION_SELECT).eq("is_active", true).order("value", { ascending: false })),
    upsertDenomination: (write) =>
      result(db.from("cash_denominations").upsert(write, { onConflict: "id" }).select(DENOMINATION_SELECT).single()),
    deleteDenomination: (id) => result(db.from("cash_denominations").delete().eq("id", id)),
    listRegisters: () => result(db.from("cash_registers").select(REGISTER_SELECT).order("created_at").order("id")),
    getRegister: (id) => result(db.from("cash_registers").select(REGISTER_SELECT).eq("id", id).maybeSingle()),
    firstActiveRegister: () =>
      result(db.from("cash_registers").select(REGISTER_SELECT).eq("is_active", true).order("created_at").order("id").limit(1).maybeSingle()),
    ensureDefaultRegister: (write) => result(db.from("cash_registers").insert(write).select(REGISTER_SELECT).single()),
    updateRegisterBase: (id, base) =>
      result(db.from("cash_registers").update({ base_configurada: base }).eq("id", id).select(REGISTER_SELECT).single()),
    getOpenShift: () =>
      result(
        db
          .from("cash_shifts")
          .select(SHIFT_SELECT)
          .eq("status", "abierto")
          .order("opened_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    getShift: (id) => result(db.from("cash_shifts").select(SHIFT_SELECT).eq("id", id).maybeSingle()),
    openShiftIdsForRegister: (registerId) =>
      result(db.from("cash_shifts").select("id").eq("cash_register_id", registerId).eq("status", "abierto").limit(1)),
    lastClosedShiftForRegister: (registerId) =>
      result(
        db
          .from("cash_shifts")
          .select("id, base_left")
          .eq("cash_register_id", registerId)
          .eq("status", "cerrado")
          .order("closed_at", { ascending: false })
          .order("opened_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    listShiftCounts: (shiftId, phase) =>
      result(db.from("cash_shift_counts").select("method_code, amount").eq("shift_id", shiftId).eq("phase", phase).order("id")),
    findRecountId: (shiftId) => result(db.from("cash_shift_recounts").select("id").eq("shift_id", shiftId).maybeSingle()),
    userFullName: (id) => result(db.from("users").select("full_name").eq("id", id).maybeSingle()),
    userNames: (ids) => result(db.from("users").select("id, full_name").in("id", ids)),
    findPaymentByIdempotency: (shiftId, key) =>
      result(db.from("payments").select(PAYMENT_SELECT).eq("cash_shift_id", shiftId).eq("idempotency_key", key).limit(1).maybeSingle()),
    insertPaymentWithoutInvoice: (write) => result(db.from("payments").insert(write).select(PAYMENT_SELECT).single()),
    findInvoicePaymentByIdempotency: (invoiceId, key) =>
      result(db.from("invoice_payments").select(INVOICE_PAYMENT_KEY_SELECT).eq("invoice_id", invoiceId).eq("idempotency_key", key)),
    findInvoicePaymentMirror: ({ invoiceId, shiftId, methodCode, amount }) =>
      result(
        db
          .from("payments")
          .select(PAYMENT_SELECT)
          .eq("invoice_id", invoiceId)
          .eq("cash_shift_id", shiftId)
          .eq("method_code", methodCode)
          .eq("amount", amount)
          .order("id")
          .limit(1)
          .maybeSingle(),
      ),
    methodBalance: (shiftId, methodCode) =>
      result(db.from("cash_shift_method_balances").select("opening_base").eq("cash_shift_id", shiftId).eq("method_code", methodCode).maybeSingle()),
    listShiftMethodBalances: (shiftId) =>
      result(db.from("cash_shift_method_balances").select("method_code, opening_base").eq("cash_shift_id", shiftId).order("method_code")),
    expectedMethodBalance: (shiftId, methodCode) =>
      result(db.rpc("cash_shift_method_expected_balance", { p_shift_id: shiftId, p_method_code: methodCode })),
    async voucherOutColumns() {
      if (voucherOutColumns === null) {
        const probe = await db.from("voucher_requests").select("method_code, cash_shift_id").limit(1);
        if (!probe.error) voucherOutColumns = true;
        else if (/method_code|cash_shift_id/i.test(String((probe.error as { message?: string }).message ?? ""))) voucherOutColumns = false;
      }
      return voucherOutColumns !== false;
    },
    shiftCountsPage: (shiftIds, from, to) =>
      page(db.from("cash_shift_counts").select("shift_id, phase, method_code, amount").in("shift_id", shiftIds).order("id").range(from, to)),
    payoutsByShiftsPage: (shiftIds, from, to) =>
      page(db.from("commission_payouts").select("cash_shift_id, method_code, amount").in("cash_shift_id", shiftIds).order("id").range(from, to)),
    vouchersByShiftsPage: (shiftIds, from, to) =>
      page(
        db
          .from("voucher_requests")
          .select("cash_shift_id, approved_by, status, method_code, amount")
          .in("cash_shift_id", shiftIds)
          .order("id")
          .range(from, to),
      ),
    invoicePaymentsByShiftsPage: (shiftIds, from, to) =>
      page(db.from("invoice_payments").select("invoice_id, cash_shift_id, method_code, amount").in("cash_shift_id", shiftIds).order("id").range(from, to)),
    invoicesByShiftsPage: (shiftIds, from, to) =>
      page(db.from("invoices").select("id, cash_shift_id").in("cash_shift_id", shiftIds).order("id").range(from, to)),
    historicInvoicePaymentsPage: (invoiceIds, from, to) =>
      page(
        db
          .from("invoice_payments")
          .select("invoice_id, method_code, amount")
          .in("invoice_id", invoiceIds)
          .is("cash_shift_id", null)
          .order("id")
          .range(from, to),
      ),
    recountsPage: (shiftIds, from, to) =>
      page(db.from("cash_shift_recounts").select(RECOUNT_SELECT).in("shift_id", shiftIds).order("id").range(from, to)),
    drawerPaymentsPage: (shiftId, from, to) =>
      page(db.from("payments").select("amount, method_code").eq("cash_shift_id", shiftId).is("invoice_id", null).order("id").range(from, to)),
    shiftPayoutsPage: (shiftId, from, to) =>
      page(db.from("commission_payouts").select("method_code, amount").eq("cash_shift_id", shiftId).order("id").range(from, to)),
    drawerPaymentsByShiftsPage: (shiftIds, from, to) =>
      page(
        db
          .from("payments")
          .select("cash_shift_id, amount, method_code")
          .in("cash_shift_id", shiftIds)
          .is("invoice_id", null)
          .order("id")
          .range(from, to),
      ),
    openShiftAtomic: (args) =>
      result(
        db.rpc("cash_open_shift_atomic", {
          p_register_id: args.registerId,
          p_opened_by: args.openedBy,
          p_opening_base: args.openingBase,
          p_counts: args.counts,
        }),
      ),
    closeShiftAtomic: (args) =>
      result(
        db.rpc("cash_close_shift_atomic", {
          p_shift_id: args.shiftId,
          p_closed_by: args.closedBy,
          p_closed_at: args.closedAt,
          p_close: args.close,
          p_counts: args.counts,
          p_collection_counts: args.collectionCounts,
        }),
      ),
    recountShiftAtomic: (args) =>
      result(
        db.rpc("cash_recount_shift_atomic", {
          p_shift_id: args.shiftId,
          p_recounted_by: args.recountedBy,
          p_recount: args.recount,
          p_counts: args.counts,
        }),
      ),
    invoicePaymentAtomic: (args) =>
      result(
        db.rpc("cash_invoice_payment_atomic", {
          p_shift_id: args.shiftId,
          p_invoice_id: args.invoiceId,
          p_user_id: args.userId,
          p_closed_at: args.closedAt,
          p_set_shift: args.setShift,
          p_mark_paid: args.markPaid,
          p_collection: args.collection,
        }),
      ),
    dayShifts: (from, to) =>
      result(
        db
          .from("cash_shifts")
          .select(SHIFT_SELECT)
          .gte("opened_at", from)
          .lte("opened_at", to)
          .order("opened_at")
          .order("id")
          .limit(DAY_VIEW_LIMIT),
      ),
    historyCount: (from, to) =>
      db.from("cash_shifts").select("id", { count: "exact", head: true }).gte("opened_at", from).lte("opened_at", to) as unknown as Promise<CashCount>,
    historyPage: (from, to, offset, limit) =>
      result(
        db
          .from("cash_shifts")
          .select(SHIFT_SELECT)
          .gte("opened_at", from)
          .lte("opened_at", to)
          .order("opened_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + limit - 1),
      ),
  };
}

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function cashRepo(): Promise<CashRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleCashRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./cash.drizzle"),
    ]);
    return drizzleCashRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseCashRepo(createAdminClient());
}
