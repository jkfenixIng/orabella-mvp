import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  assertShiftCloser,
  buildMethodViews,
  buildRecountRecord,
  closeShiftSchema,
  computeCashClose,
  dayBounds,
  dayViewSchema,
  expectedDigitalTotal,
  governingClose,
  HISTORY_PAGE_SIZE,
  historySchema,
  openShiftSchema,
  rangeBounds,
  recountShiftSchema,
  registerPaymentSchema,
  resolveClosingBase,
  resolveOpeningBase,
  roundMoney,
  moneyEquals,
  sumMethodMaps,
  sumMethodTotal,
  voucherOutByMethod,
  type CloseAmounts,
  type CloseShiftInput,
  type DayTotals,
  type MethodDifference,
  type OpenShiftInput,
  type RegisterPaymentInput,
  type ShiftCountInput,
  type VoucherCashOutInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import {
  listPaymentMethods,
  AdminError,
} from "@/src/features/admin/service";
import {
  BillingError,
  getInvoiceDetail,
  invoiceNetBalance,
  splitGrossCardFee,
  type InvoiceNetBalance,
  type InvoicePaymentRow,
} from "@/src/features/billing/service";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import { getShiftReviews } from "@/src/features/alerts/service";
import { assembleShiftRevision, type ShiftRevision } from "@/src/features/alerts/schemas";
import { unstable_cache } from "next/cache";
import { z } from "zod";

export class CashError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CashError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function cashDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

type DbClient = Awaited<ReturnType<typeof cashDb>>;

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Roles que pueden abrir/cobrar/cerrar (lectura: cualquier rol de la sede). */
const WRITER_ROLES: RoleCode[] = ["admin", "caja"];

/**
 * §10 Caja: escritura solo admin/caja de su sede; lectura cualquier
 * rol autenticado de su sede (las rutas y actions aplican este gate).
 */
export async function requireCashWriter(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new CashError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  try {
    requireSedeRole(session.roles, WRITER_ROLES);
  } catch (error) {
    if (error instanceof AdminError) {
      throw new CashError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!session.user.sede_id) {
    throw new CashError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

function toCashError(error: unknown): CashError {
  if (error instanceof CashError) return error;
  if (error instanceof AdminError) return new CashError(error.code, error.message, error.status);
  if (error instanceof BillingError) {
    if (error.code === "NOT_FOUND") return new CashError("INVOICE_NOT_FOUND", "Factura no encontrada.", 404);
    if (error.code === "FORBIDDEN") return new CashError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
    return new CashError(error.code, error.message, error.status);
  }
  if (error instanceof Error && error.message === "SHIFT_ALREADY_OPEN") {
    return new CashError(
      "SHIFT_ALREADY_OPEN",
      "Ya hay un turno abierto en esta caja. Ciérrelo antes de abrir otro.",
      409,
    );
  }
  if (error instanceof Error && error.message === "COUNT_REQUIRED") {
    return new CashError("COUNT_REQUIRED", "El conteo de efectivo es obligatorio para cerrar.", 400);
  }
  if (error instanceof Error && error.message === "SHIFT_NOT_OWNER") {
    return new CashError("SHIFT_NOT_OWNER", "Solo quien abrió el turno puede cerrarlo.", 403);
  }
  if (error instanceof Error && error.message === "OBSERVATION_REQUIRED") {
    return new CashError(
      "OBSERVATION_REQUIRED",
      "La base quedó incompleta: la observación es obligatoria.",
      422,
    );
  }
  return new CashError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------- filas ---

export interface CashRegisterRow {
  id: string;
  sede_id: string;
  name: string;
  base_configurada: number;
  is_active: boolean;
}

export interface CashShiftRow {
  id: string;
  cash_register_id: string;
  sede_id: string;
  opened_by: string;
  closed_by: string | null;
  opened_at: string;
  closed_at: string | null;
  opening_base: number;
  expected_cash: number;
  counted_cash: number | null;
  base_left: number | null;
  cash_withdrawn: number | null;
  base_difference: number | null;
  status: string;
  observation: string | null;
}

export interface CashPaymentRow {
  id: string;
  sede_id: string;
  cash_shift_id: string;
  invoice_id: string | null;
  method_id: string | null;
  method_code: string;
  amount: number;
  user_id: string | null;
  created_at: string;
}

const REGISTER_SELECT = "id, sede_id, name, base_configurada, is_active";
const SHIFT_SELECT =
  "id, cash_register_id, sede_id, opened_by, closed_by, opened_at, closed_at, opening_base, expected_cash, counted_cash, base_left, cash_withdrawn, base_difference, status, observation";
const PAYMENT_SELECT =
  "id, sede_id, cash_shift_id, invoice_id, method_id, method_code, amount, user_id, created_at";

export interface CashActor {
  userId: string;
  sedeId: string;
  roles?: RoleCode[];
}

export interface ShiftCountRow {
  id: string;
  shift_id: string;
  phase: "apertura" | "cierre" | "reconteo";
  method_code: string;
  denomination: number | null;
  quantity: number;
  amount: number;
}

export interface CashDenominationRow {
  id: string;
  sede_id: string;
  kind: "billete" | "moneda";
  value: number;
  is_active: boolean;
}

// ------------------------------------------------------------ denominaciones ---

/** Denominaciones activas de la sede (configurables desde el admin). */
async function fetchDenominations(sedeId: string): Promise<CashDenominationRow[]> {
  const db = await cashDb();
  const { data, error } = await db
    .from("cash_denominations")
    .select("id, sede_id, kind, value, is_active")
    .eq("sede_id", sedeId)
    .eq("is_active", true)
    .order("value", { ascending: false });
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as CashDenominationRow[];
}

export const listDenominations = unstable_cache(fetchDenominations, ["cash:denominations"], {
  tags: ["catalog:denominations"],
  revalidate: 3600,
});

/** Crea o ajusta una denominación (solo admin; el gate vive en actions). */
export async function upsertDenomination(raw: unknown, actor: CashActor): Promise<CashDenominationRow> {
  const parsed = z.object({
    id: z.uuid().optional(),
    kind: z.enum(["billete", "moneda"]),
    value: z.coerce.number().positive(),
    is_active: z.boolean().optional(),
  }).safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await cashDb();
  const payload = {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    sede_id: actor.sedeId,
    kind: parsed.data.kind,
    value: roundMoney(parsed.data.value),
    ...(parsed.data.is_active !== undefined ? { is_active: parsed.data.is_active } : {}),
  };
  const { data, error } = await db
    .from("cash_denominations")
    .upsert(payload, { onConflict: "id" })
    .select("id, sede_id, kind, value, is_active")
    .single();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return data as CashDenominationRow;
}

/** Elimina una denominación (solo admin; el gate vive en actions). */
export async function deleteDenomination(sedeId: string, id: string): Promise<void> {
  const db = await cashDb();
  const { error } = await db.from("cash_denominations").delete().eq("id", id).eq("sede_id", sedeId);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------ conteos ---

/**
 * Valida las líneas de conteo contra los métodos arqueables activos.
 * Efectivo por denominación (amount debe cuadrar con denom*qty);
 * digitales con total declarado. Devuelve totales por método.
 */
export async function checkCounts(
  sedeId: string,
  counts: ShiftCountInput[],
): Promise<Map<string, number>> {
  const methods = await listPaymentMethods(sedeId);
  const allowed = new Map(methods.filter((m) => m.is_active && m.arqueable).map((m) => [m.code, m]));
  const denominations = new Set((await listDenominations(sedeId)).map((d) => Number(d.value)));
  const byMethod = new Map<string, ShiftCountInput[]>();
  for (const line of counts) {
    const method = allowed.get(line.method_code);
    if (!method) {
      throw new CashError("VALIDATION", `Método no arqueable: ${line.method_code}.`, 400);
    }
    if (line.method_code === "efectivo") {
      if (line.denomination == null || !denominations.has(Number(line.denomination))) {
        throw new CashError("VALIDATION", "Denominación no configurada para esta sede.", 400);
      }
      if (!moneyEquals(line.amount, roundMoney(line.denomination * line.quantity))) {
        throw new CashError("COUNT_MISMATCH", "El detalle del efectivo no cuadra con el total.", 422);
      }
    } else if (line.denomination != null || line.quantity !== 1) {
      throw new CashError("VALIDATION", "Los métodos digitales se declaran con el total.", 400);
    }
    const group = byMethod.get(line.method_code) ?? [];
    group.push(line);
    byMethod.set(line.method_code, group);
  }
  for (const method of allowed.keys()) {
    if (!byMethod.has(method)) {
      throw new CashError("COUNT_REQUIRED", `Falta el conteo de ${method}.`, 400);
    }
  }
  const totals = new Map<string, number>();
  for (const line of counts) {
    totals.set(line.method_code, roundMoney((totals.get(line.method_code) ?? 0) + line.amount));
  }
  return totals;
}

/**
 * Totales por método de los conteos de varios turnos, separados por fase
 * (apertura, cierre y reconteo U3). Base del esperado digital acumulativo
 * (apertura + cobrado) y de la versión que gobierna un turno recontado.
 *
 * OJO: el reconteo se agrupa APARTE del cierre a propósito. Antes toda fase
 * distinta de `apertura` caía en `closed`; con `reconteo` en esa bolsa, las
 * líneas del reconteo se sumarían al cierre firmado y el arqueo contaría el
 * dinero dos veces.
 */
async function fetchCountTotals(
  db: DbClient,
  shiftIds: string[],
): Promise<
  Map<
    string,
    { open: Map<string, number>; closed: Map<string, number>; recount: Map<string, number> }
  >
> {
  const result = new Map<
    string,
    { open: Map<string, number>; closed: Map<string, number>; recount: Map<string, number> }
  >();
  if (shiftIds.length === 0) return result;
  const { data, error } = await db
    .from("cash_shift_counts")
    .select("shift_id, phase, method_code, amount")
    .in("shift_id", shiftIds);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  for (const row of (data ?? []) as Array<{
    shift_id: string;
    phase: string;
    method_code: string;
    amount: number | string;
  }>) {
    const entry = result.get(row.shift_id) ?? {
      open: new Map<string, number>(),
      closed: new Map<string, number>(),
      recount: new Map<string, number>(),
    };
    const target =
      row.phase === "apertura"
        ? entry.open
        : row.phase === "reconteo"
          ? entry.recount
          : entry.closed;
    target.set(row.method_code, roundMoney((target.get(row.method_code) ?? 0) + Number(row.amount)));
    result.set(row.shift_id, entry);
  }
  return result;
}

/**
 * Pagos inmediatos de comisión por turno y método (descuentan del
 * esperado digital en vistas y cierre).
 */
async function fetchPayoutTotals(
  db: DbClient,
  shiftIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (shiftIds.length === 0) return result;
  const { data, error } = await db
    .from("commission_payouts")
    .select("cash_shift_id, method_code, amount")
    .in("cash_shift_id", shiftIds);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  for (const row of (data ?? []) as Array<{
    cash_shift_id: string;
    method_code: string;
    amount: number | string;
  }>) {
    const byMethod = result.get(row.cash_shift_id) ?? new Map<string, number>();
    byMethod.set(row.method_code, roundMoney((byMethod.get(row.method_code) ?? 0) + Number(row.amount)));
    result.set(row.cash_shift_id, byMethod);
  }
  return result;
}

// 028 (method_code/cash_shift_id en voucher_requests) puede no estar aplicada
// en esta base: la primera consulta decide y se cachea. Sin las columnas
// simplemente no hay salidas por vale (el arqueo no se rompe). Un error
// distinto (red/permisos) no se cachea: la consulta real lo reporta.
let voucherOutColumns: boolean | null = null;

async function hasVoucherOutColumns(db: DbClient): Promise<boolean> {
  if (voucherOutColumns === null) {
    const probe = await db.from("voucher_requests").select("method_code, cash_shift_id").limit(1);
    if (!probe.error) {
      voucherOutColumns = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/method_code|cash_shift_id/i.test(message)) voucherOutColumns = false;
    }
  }
  return voucherOutColumns !== false;
}

/**
 * Salidas de caja por vales aprobados, por turno y método (descuentan del
 * esperado igual que los pagos inmediatos de comisión). Solo cuentan los
 * vales aprobados: un vale pendiente/rechazado NO toca caja (regla "no toca
 * caja hasta aprobar"). Si la migración 028 no está aplicada no hay salidas.
 */
async function fetchVoucherOutTotals(
  db: DbClient,
  shiftIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (shiftIds.length === 0) return result;
  if (!(await hasVoucherOutColumns(db))) return result;
  const { data, error } = await db
    .from("voucher_requests")
    .select("cash_shift_id, approved_by, method_code, amount")
    .in("cash_shift_id", shiftIds);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  const byShift = new Map<string, VoucherCashOutInput[]>();
  for (const row of (data ?? []) as Array<{
    cash_shift_id: string;
    approved_by: string | null;
    method_code: string | null;
    amount: number | string;
  }>) {
    const list = byShift.get(row.cash_shift_id) ?? [];
    list.push({ approved_by: row.approved_by, method_code: row.method_code, amount: row.amount });
    byShift.set(row.cash_shift_id, list);
  }
  for (const [shiftId, rows] of byShift) {
    const out = voucherOutByMethod(rows);
    if (out.size > 0) result.set(shiftId, out);
  }
  return result;
}

/**
 * Salidas en efectivo ya acumuladas en un turno (vales aprobados + comisiones
 * pagadas inmediatas en efectivo). Es la base del tope del 50% de la base de
 * apertura que vales y comisiones validan antes de pagar en efectivo.
 * Reutiliza exactamente la misma lógica del arqueo (fetchVoucherOutTotals +
 * fetchPayoutTotals), de modo que el tope y el cierre nunca divergen.
 */
export async function cashOutUsedInShift(shiftId: string): Promise<number> {
  const db = await cashDb();
  const [voucherOutMaps, payoutMaps] = await Promise.all([
    fetchVoucherOutTotals(db, [shiftId]),
    fetchPayoutTotals(db, [shiftId]),
  ]);
  const voucherOut = voucherOutMaps.get(shiftId) ?? new Map<string, number>();
  const payoutOut = payoutMaps.get(shiftId) ?? new Map<string, number>();
  return roundMoney((voucherOut.get("efectivo") ?? 0) + (payoutOut.get("efectivo") ?? 0));
}

/** Fila mínima del ledger de dinero del turno (`payments` / `invoice_payments`). */
export interface ShiftMoneyRow {
  amount: number | string;
  method_code: string;
}

/**
 * T0-a (C1): une los DOS ledgers del turno SIN solapar. Los movimientos de
 * cajón llegan filtrados a `invoice_id IS NULL` en la consulta (un pago con
 * factura ya vive en `invoice_payments`, el ledger del cobro de factura: su
 * fila espejo en `payments` duplicaba el efectivo del arqueo). Puro para
 * probarlo sin base de datos.
 */
export function mergeShiftMoney(
  drawerRows: ShiftMoneyRow[] | null | undefined,
  invoiceRows: ShiftMoneyRow[] | null | undefined,
): Array<{ amount: number; method_code: string }> {
  const merged: Array<{ amount: number; method_code: string }> = [];
  for (const row of drawerRows ?? []) {
    merged.push({ amount: Number(row.amount), method_code: row.method_code });
  }
  for (const row of invoiceRows ?? []) {
    merged.push({ amount: Number(row.amount), method_code: row.method_code });
  }
  return merged;
}

/** Suma del ledger del turno por método (base del arqueo). Puro. */
export function sumShiftMoneyByMethod(rows: ShiftMoneyRow[]): Map<string, number> {
  const byMethod = new Map<string, number>();
  for (const row of rows) {
    byMethod.set(
      row.method_code,
      roundMoney((byMethod.get(row.method_code) ?? 0) + Number(row.amount)),
    );
  }
  return byMethod;
}

/**
 * Cobros de factura del turno: total cobrado y número de FACTURAS distintas
 * (una factura puede tener varias porciones: cuentan como una). Puro, para
 * probar sin base de datos la parte pura del cierre (`invoicesTotal` /
 * `invoicesCount`).
 */
export function invoiceCollectionsSummary(
  rows: Array<{ invoice_id: string; amount: number | string }>,
): { total: number; count: number } {
  return {
    total: roundMoney(rows.reduce((acc, row) => acc + Number(row.amount), 0)),
    count: new Set(rows.map((row) => row.invoice_id)).size,
  };
}

/**
 * Cobros de factura por turno y método (lo que entra a caja por facturas).
 * Cada pago pertenece al turno ABIERTO al momento del cobro
 * (invoice_payments.cash_shift_id); los que quedaron sin turno se atribuyen
 * al turno de emisión de su factura. Sin N+1: 3 queries acotadas.
 *
 * T0-a (C1): la rama sin turno (`cash_shift_id IS NULL`) sigue viva a
 * propósito y es SEGURA: solo lee filas con `cash_shift_id` NULL, mientras la
 * consulta directa lee las de `cash_shift_id` no nulo, así que no puede solapar
 * consigo misma; y las filas de `invoice_payments` que lee están atadas a una
 * factura (`invoice_id NOT NULL`), mientras los lectores de `payments` suman
 * solo `invoice_id IS NULL`. La migración 031 materializa esta atribución en
 * `cash_shift_id` (idempotente, sin borrar filas); la rama queda como red de
 * seguridad para la ventana en que conviven código/migración y para las filas
 * que la migración no pudo atribuir (factura sin turno).
 */
async function fetchInvoicePaymentsByShift(
  db: DbClient,
  shiftIds: string[],
): Promise<Map<string, Array<{ invoice_id: string; method_code: string; amount: number }>>> {
  const result = new Map<string, Array<{ invoice_id: string; method_code: string; amount: number }>>();
  if (shiftIds.length === 0) return result;
  const push = (shiftId: string, row: { invoice_id: string; method_code: string; amount: number | string }) => {
    const list = result.get(shiftId) ?? [];
    list.push({ invoice_id: row.invoice_id, method_code: row.method_code, amount: Number(row.amount) });
    result.set(shiftId, list);
  };
  const { data: direct, error: directError } = await db
    .from("invoice_payments")
    .select("invoice_id, cash_shift_id, method_code, amount")
    .in("cash_shift_id", shiftIds);
  if (directError) throw new CashError("INTERNAL", "Error interno.", 500);
  for (const row of (direct ?? []) as Array<{
    invoice_id: string;
    cash_shift_id: string;
    method_code: string;
    amount: number | string;
  }>) {
    push(row.cash_shift_id, row);
  }
  const { data: invoices, error: invoicesError } = await db
    .from("invoices")
    .select("id, cash_shift_id")
    .in("cash_shift_id", shiftIds);
  if (invoicesError) throw new CashError("INTERNAL", "Error interno.", 500);
  const shiftByInvoice = new Map(
    ((invoices ?? []) as Array<{ id: string; cash_shift_id: string }>).map((row) => [row.id, row.cash_shift_id]),
  );
  if (shiftByInvoice.size === 0) return result;
  // C1: filas históricas sin turno atribuidas al turno de emisión de su
  // factura. Conjunto disjunto del directo (`cash_shift_id` no nulo) y de la
  // suma de `payments` (los lectores de `payments` excluyen `invoice_id`),
  // por lo que este dinero se cuenta exactamente una vez.
  const { data: nullShiftRows, error: legacyError } = await db
    .from("invoice_payments")
    .select("invoice_id, method_code, amount")
    .in("invoice_id", [...shiftByInvoice.keys()])
    .is("cash_shift_id", null);
  if (legacyError) throw new CashError("INTERNAL", "Error interno.", 500);
  for (const row of (nullShiftRows ?? []) as Array<{ invoice_id: string; method_code: string; amount: number | string }>) {
    const shiftId = shiftByInvoice.get(row.invoice_id);
    if (shiftId) push(shiftId, row);
  }
  return result;
}

/**
 * CL-10: las líneas de un conteo como DATO, listas para viajar al RPC que las
 * escribe. El servicio COMPUTA —qué métodos y qué denominaciones se cuentan
 * (`checkCounts`) y el monto ya redondeado de cada línea— y la función SQL sólo
 * INSERTA lo que recibe: el `shift_id` y la fase de cada fila los pone la
 * transacción que la escribe (`apertura`, `cierre` o `reconteo`), no el
 * llamador.
 *
 * Antes esto era `insertCounts`, que además de armar las filas abría su PROPIO
 * request de escritura contra `cash_shift_counts`. Esa escritura suelta era la
 * mitad de las TRES ventanas que CL-10 cierra: el turno (o el cierre, o el
 * reconteo) se escribía en un request y sus líneas en el siguiente, así que un
 * fallo entre los dos dejaba la operación firmada sin su evidencia.
 */
function countLines(counts: ShiftCountInput[]): Array<{
  method_code: string;
  denomination: number | null;
  quantity: number;
  amount: number;
}> {
  return counts.map((line) => ({
    method_code: line.method_code,
    denomination: line.denomination ?? null,
    quantity: line.quantity,
    amount: roundMoney(line.amount),
  }));
}

/**
 * U3: un reconteo tal como vive en `cash_shift_recounts`. Guarda las DOS
 * versiones: `previous_*` (el cierre firmado que se conserva) y los cuatro
 * montos corregidos, más quién, cuándo y por qué.
 */
export interface ShiftRecountRow {
  id: string;
  shift_id: string;
  previous_counted_cash: number;
  previous_base_left: number;
  previous_cash_withdrawn: number;
  previous_base_difference: number;
  counted_cash: number;
  base_left: number;
  cash_withdrawn: number;
  base_difference: number;
  reason: string;
  recounted_by: string;
  recounted_at: string;
}

/** Proyección de un reconteo para las vistas (nombre en vez de uuid). */
export interface ShiftRecountView {
  counted_cash: number;
  base_left: number;
  cash_withdrawn: number;
  base_difference: number;
  /** El cierre firmado original, tal como quedó en `cash_shifts`. */
  previous: CloseAmounts;
  reason: string;
  /** Nombre de quien recontó (null si el usuario ya no existe). */
  recounted_by: string | null;
  recounted_at: string;
}

const RECOUNT_SELECT =
  "id, shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn, previous_base_difference, counted_cash, base_left, cash_withdrawn, base_difference, reason, recounted_by, recounted_at";

/** Reconteos de los turnos pedidos, uno por turno (a lo sumo existe uno). */
async function fetchRecounts(
  db: DbClient,
  shiftIds: string[],
): Promise<Map<string, ShiftRecountRow>> {
  const result = new Map<string, ShiftRecountRow>();
  if (shiftIds.length === 0) return result;
  const { data, error } = await db
    .from("cash_shift_recounts")
    .select(RECOUNT_SELECT)
    .in("shift_id", shiftIds);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  for (const row of (data ?? []) as ShiftRecountRow[]) {
    result.set(row.shift_id, row);
  }
  return result;
}

/** Los cuatro montos corregidos de un reconteo, listos como `CloseAmounts`. */
function recountAmounts(row: ShiftRecountRow): CloseAmounts {
  return {
    counted_cash: roundMoney(Number(row.counted_cash)),
    base_left: roundMoney(Number(row.base_left)),
    cash_withdrawn: roundMoney(Number(row.cash_withdrawn)),
    base_difference: roundMoney(Number(row.base_difference)),
  };
}

/** Proyección del reconteo con las DOS versiones y quién/cuándo/por qué. */
function recountView(row: ShiftRecountRow, actorName: string | null): ShiftRecountView {
  return {
    ...recountAmounts(row),
    previous: {
      counted_cash: roundMoney(Number(row.previous_counted_cash)),
      base_left: roundMoney(Number(row.previous_base_left)),
      cash_withdrawn: roundMoney(Number(row.previous_cash_withdrawn)),
      base_difference: roundMoney(Number(row.previous_base_difference)),
    },
    reason: row.reason,
    recounted_by: actorName,
    recounted_at: row.recounted_at,
  };
}

/** Montos firmados de un turno (los de `cash_shifts`, sin reconteo). */
function signedAmounts(shift: CashShiftRow): CloseAmounts {
  return {
    counted_cash: roundMoney(Number(shift.counted_cash ?? 0)),
    base_left: roundMoney(Number(shift.base_left ?? 0)),
    cash_withdrawn: roundMoney(Number(shift.cash_withdrawn ?? 0)),
    base_difference: roundMoney(Number(shift.base_difference ?? 0)),
  };
}

/** Totales del último cierre (por método) para validar la apertura. */
async function previousCloseTotals(
  db: DbClient,
  registerId: string,
): Promise<{ baseLeft: number | null; byMethod: Map<string, number>; hasCounts: boolean } | null> {
  const { data: last, error: lastError } = await db
    .from("cash_shifts")
    .select("id, base_left")
    .eq("cash_register_id", registerId)
    .eq("status", "cerrado")
    .order("closed_at", { ascending: false })
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw new CashError("INTERNAL", "Error interno.", 500);
  if (!last) return null;
  // U3: si el último cierre fue recontado, la base que hereda el próximo turno
  // y los totales digitales contra los que se compara la apertura son los
  // CORREGIDOS; el cierre firmado sigue intacto en `cash_shifts` pero no
  // gobierna la cadena.
  const recountMap = await fetchRecounts(db, [(last as { id: string }).id]);
  const recountRow = recountMap.get((last as { id: string }).id) ?? null;
  const { data: counts, error: countsError } = await db
    .from("cash_shift_counts")
    .select("method_code, amount")
    .eq("shift_id", (last as { id: string }).id)
    .eq("phase", recountRow ? "reconteo" : "cierre");
  if (countsError) throw new CashError("INTERNAL", "Error interno.", 500);
  const byMethod = new Map<string, number>();
  for (const row of ((counts ?? []) as Array<{ method_code: string; amount: number | string }>)) {
    byMethod.set(row.method_code, roundMoney((byMethod.get(row.method_code) ?? 0) + Number(row.amount)));
  }
  return {
    baseLeft: recountRow ? Number(recountRow.base_left) : (last as { base_left: number | null }).base_left,
    byMethod,
    hasCounts: byMethod.size > 0,
  };
}

// --------------------------------------------------------------- registros ---

/** Lista las cajas de la sede (el MVP opera la "Caja única"). */
export async function listRegisters(sedeId: string): Promise<CashRegisterRow[]> {
  const db = await cashDb();
  const { data, error } = await db
    .from("cash_registers")
    .select(REGISTER_SELECT)
    .eq("sede_id", sedeId)
    .order("created_at");
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as CashRegisterRow[];
}

/**
 * Resuelve la caja: por id (verificando sede) o la única activa de la
 * sede. Si la sede aún no tiene caja (sede creada tras la migración),
 * la crea con base 200 000 (misma semilla que 006_cash.sql).
 */
async function resolveRegister(
  db: DbClient,
  sedeId: string,
  registerId?: string,
): Promise<CashRegisterRow> {
  if (registerId) {
    const { data, error } = await db
      .from("cash_registers")
      .select(REGISTER_SELECT)
      .eq("id", registerId)
      .maybeSingle();
    if (error) throw new CashError("INTERNAL", "Error interno.", 500);
    if (!data) throw new CashError("NOT_FOUND", "Caja no encontrada.", 404);
    const row = data as CashRegisterRow;
    try {
      resolveSede(sedeId, row.sede_id);
    } catch (error) {
      throw toCashError(error);
    }
    return row;
  }
  const { data, error } = await db
    .from("cash_registers")
    .select(REGISTER_SELECT)
    .eq("sede_id", sedeId)
    .eq("is_active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  if (data) return data as CashRegisterRow;
  const { data: created, error: createError } = await db
    .from("cash_registers")
    .insert({ sede_id: sedeId, name: "Caja única", base_configurada: 200000 })
    .select(REGISTER_SELECT)
    .single();
  if (createError || !created) throw new CashError("INTERNAL", "Error interno.", 500);
  return created as CashRegisterRow;
}

/** Turno abierto de la sede (uno a la vez por caja, CAJ-01). */
export async function getOpenShift(sedeId: string): Promise<CashShiftRow | null> {
  const db = await cashDb();
  const { data, error } = await db
    .from("cash_shifts")
    .select(SHIFT_SELECT)
    .eq("sede_id", sedeId)
    .eq("status", "abierto")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return (data as CashShiftRow | null) ?? null;
}

/** Turno abierto con nombre del que lo abrió (para validaciones de facturación). */
export async function getOpenShiftWithOpener(sedeId: string): Promise<(CashShiftRow & { opener_name: string | null }) | null> {
  // Dos queries simples a propósito: cash_shifts tiene DOS FK a users
  // (opened_by y closed_by) y PostgREST no desambigua `users!inner`.
  const shift = await getOpenShift(sedeId);
  if (!shift) return null;
  const db = await cashDb();
  const { data: user, error } = await db
    .from("users")
    .select("full_name")
    .eq("id", shift.opened_by)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return {
    ...shift,
    opener_name: (user as { full_name?: string | null } | null)?.full_name ?? null,
  };
}

async function getShiftOrThrow(db: DbClient, sedeId: string, id: string): Promise<CashShiftRow> {
  const { data, error } = await db
    .from("cash_shifts")
    .select(SHIFT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  if (!data) throw new CashError("NOT_FOUND", "Turno no encontrado.", 404);
  const row = data as CashShiftRow;
  try {
    resolveSede(sedeId, row.sede_id);
  } catch (error) {
    throw toCashError(error);
  }
  return row;
}

// ----------------------------------------------------------------- apertura ---

/**
 * CAJ-01: abre un turno con opening_base heredada (base_left del último
 * cierre o base_configurada si es el primero). El pre-arqueo NUNCA bloquea
 * la operación: las diferencias quedan registradas (y avisan a los
 * administradores, salvo en la primerísima apertura) y el turno abre igual
 * con la base del sistema. Rechaza si hay un turno abierto en la caja
 * (además del índice parcial, barrera ante carreras: 23505 → mismo error
 * de negocio).
 */
export interface OpenShiftResult {
  shift: CashShiftRow;
  mismatches: Array<{ method_code: string; expected: number; declared: number }>;
  firstOpen: boolean;
}

export async function openShift(raw: unknown, actor: CashActor): Promise<OpenShiftResult> {
  const parsed = openShiftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: OpenShiftInput = parsed.data;
  const db = await cashDb();
  try {
    const register = await resolveRegister(db, actor.sedeId, input.cash_register_id);

    const { data: open, error: openError } = await db
      .from("cash_shifts")
      .select("id")
      .eq("cash_register_id", register.id)
      .eq("status", "abierto")
      .limit(1);
    if (openError) throw new CashError("INTERNAL", "Error interno.", 500);
    assertNoOpenShift((open ?? []).length > 0);

    // U3: la base que hereda el turno sale de `previousCloseTotals`, que ya
    // prefiere el reconteo cuando el último cierre fue corregido. Una sola
    // lectura del último cierre para la cadena y para el chequeo digital.
    const prev = await previousCloseTotals(db, register.id);
    const openingBase = resolveOpeningBase(prev?.baseLeft ?? null, Number(register.base_configurada));

    // Pre-open count never blocks the operation: cash must match the base
    // the shift opens with (base_left from the last close, or
    // base_configurada on first open); digitals are checked against last
    // close totals only when they exist. Mismatches are recorded and alert
    // administrators (except on the very first open) while the shift opens
    // anyway so the business never stops.
    const declared = await checkCounts(actor.sedeId, input.counts);
    const isFirstOpen = prev === null;
    const mismatches: Array<{ method_code: string; expected: number; declared: number }> = [];
    const cashDeclared = declared.get("efectivo") ?? 0;
    if (!moneyEquals(cashDeclared, openingBase)) {
      mismatches.push({ method_code: "efectivo", expected: openingBase, declared: cashDeclared });
    }
    if (prev?.hasCounts) {
      for (const [code, total] of declared) {
        if (code === "efectivo") continue;
        const expected = prev.byMethod.get(code) ?? 0;
        if (!moneyEquals(total, expected)) {
          mismatches.push({ method_code: code, expected, declared: total });
        }
      }
    }
    // (open-mismatch audit is written after creation, filed against the shift)

    // CL-10: el turno y su arqueo de apertura son UNA sola escritura. Una
    // función SQL es UNA sentencia, y una sentencia corre ENTERA dentro de una
    // sola transacción del servidor (PostgREST no ofrece multi-statement por
    // request). Antes esto eran DOS requests —el INSERT del turno y después el
    // de sus líneas de conteo— y un fallo entre los dos dejaba el turno ABIERTO
    // sin su arqueo: la base con la que abrió el cajón sin respaldo por
    // denominación, el esperado digital del cierre sin su punto de partida, y el
    // desajuste de la apertura sin nada contra lo que compararse. El reintento
    // tampoco lo arreglaba: el índice parcial de 006 ya veía un turno abierto.
    // Ya no hay "mitad del camino" donde fallar.
    //
    // La ARITMÉTICA no se mueve: la base del turno sale de `resolveOpeningBase`
    // y cada línea del conteo de `checkCounts` (con su monto ya redondeado en
    // `countLines`); el RPC sólo ESCRIBE lo que recibe y devuelve el turno
    // escrito, con las mismas columnas que el servicio leía con SHIFT_SELECT.
    const { data: created, error: createError } = await db.rpc("cash_open_shift_atomic", {
      p_sede_id: actor.sedeId,
      p_register_id: register.id,
      p_opened_by: actor.userId,
      p_opening_base: openingBase,
      p_counts: countLines(input.counts),
    });
    if (createError) {
      // Carrera perdida contra uq_cash_shifts_open_per_register (23505, la
      // barrera final de la base) o contra el guardia de "un turno abierto por
      // caja" re-evaluado dentro de la transacción.
      const code = (createError as { code?: string }).code;
      const message = String((createError as { message?: string }).message ?? "");
      if (code === "23505" || message.includes("SHIFT_ALREADY_OPEN")) {
        throw new CashError(
          "SHIFT_ALREADY_OPEN",
          "Ya hay un turno abierto en esta caja. Ciérrelo antes de abrir otro.",
          409,
        );
      }
      throw new CashError("INTERNAL", "Error interno.", 500);
    }
    if (!created) throw new CashError("INTERNAL", "Error interno.", 500);
    const shift = created as CashShiftRow;
    // Filed against the created shift (not the register) so the shift's
    // review state can be joined from the day/history views.
    if (mismatches.length > 0 && !isFirstOpen) {
      await writeAudit({
        sede_id: actor.sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.SHIFT_OPEN_MISMATCH,
        entity: "cash_shifts",
        entity_id: shift.id,
        metadata: { opening_base: openingBase, mismatches },
      });
    }
    return { shift, mismatches, firstOpen: isFirstOpen };
  } catch (error) {
    throw toCashError(error);
  }
}

// -------------------------------------------------------------------- pagos ---

export interface PaymentResult {
  payment: CashPaymentRow;
  shift: CashShiftRow;
  invoice_id: string | null;
  invoice_status: string | null;
}

/**
 * CL-3: las filas de `invoice_payments` que YA se registraron con esa marca.
 *
 * La marca es un uuid que genera el LLAMADOR al empezar el intento de cobro y
 * que reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `registerPaymentSchema` (schemas.ts). El filtro es por
 * FACTURA: la marca se resuelve dentro de la factura que la usó (la que
 * identifica la petición), así que el lookup nunca puede devolver el cobro de
 * otra factura, y la misma marca en dos facturas distintas son dos operaciones
 * distintas. Es el mismo patrón que `findInvoicePaymentsByIdempotencyKey`
 * (billing/service.ts) y `findPayrollPaymentsByIdempotencyKey`
 * (payroll/service.ts).
 *
 * ACÁ NO ESTÁ LA ARRUGA DE "LA MARCA EN LA PRIMERA PORCIÓN": este camino escribe
 * UNA sola fila en `invoice_payments` (desde CL-14 la escribe la transacción de
 * la 053, y sigue siendo una sola: un objeto en `p_collection`, no un arreglo de
 * N porciones), así que la marca vive en esa única fila, el
 * índice único parcial de 042 nunca puede rechazar una operación legítima de
 * varias porciones, y no hay filas hermanas que enumerar: la fila que devuelve
 * este lookup ES la operación completa.
 */
async function findInvoicePaymentsByIdempotencyKey(
  db: DbClient,
  invoiceId: string,
  idempotencyKey: string,
): Promise<InvoicePaymentRow[]> {
  const { data, error } = await db
    .from("invoice_payments")
    .select(
      "id, invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id, created_at, idempotency_key",
    )
    .eq("invoice_id", invoiceId)
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as InvoicePaymentRow[];
}

/**
 * CL-3: el resultado de una repetición reconocida: lo que la operación YA
 * registró, sin escribir nada. El llamador recibe el MISMO `PaymentResult` que
 * le devolvió el intento que ganó, así que para él es un no-op exitoso y no un
 * error.
 *
 * Se arma con lo que la operación DEJÓ ESCRITO, no con lo que el llamador
 * repite: la repetición no es "una petición nueva con el mismo contenido" (eso
 * sería adivinar), es la MISMA operación, identificada por su marca.
 *
 *   * El turno es el que COBRÓ —el de la fila espejo—, no el que esté abierto
 *     ahora: si el llamador no mandó `cash_shift_id`, el turno abierto pudo
 *     cambiar entre el intento y su reintento, y reportar el nuevo sería mentir
 *     sobre dónde quedó el dinero.
 *   * La fila del libro de cajón (`payments`) se busca por las coordenadas que
 *     grabó la propia fila espejo —factura, turno, método y monto—, que es lo
 *     único que puede identificar ese intento: el libro de cajón NO tiene
 *     columna de marca (la 042 dejó esa puerta declarada fuera de su alcance).
 *     Es el COSTO DECLARADO de la forma elegida: si dos cobros legítimos de la
 *     misma factura, turno, método y monto conviven, el `id`/fecha que devuelve
 *     la repetición puede ser el de la hermana —los montos, la factura y el
 *     turno son los mismos—; la fila que MANDA es la espejo, que es la que suma
 *     el arqueo y la que lleva la marca.
 *   * El estado de la factura se RELEE ahora. Es lo único que la ganadora pudo
 *     cambiar después de la lectura de esta petición (la carrera), y devolverlo
 *     viejo sería reportar un estado que ya no es.
 *
 * Si el intento ganador dejó la fila espejo pero NO la del libro de cajón, esa
 * es exactamente la avería que CL-14 cerró: las dos filas se escriben en UNA
 * transacción, así que el intento original ya no puede producir ese estado. Lo
 * que sí puede es ENCONTRARLO: un cobro escrito ANTES de la 053 quedó con esa
 * mitad, y la repetición de su mismo envío tiene que seguir diciendo la verdad
 * sobre esa avería (el dinero está en la factura y en el arqueo, pero no en el
 * libro del turno) en vez de inventar un no-op exitoso sobre un estado roto.
 * Mismo desenlace, mismo código: `PAYMENT_ROLLBACK_FAILED`.
 */
async function repeatedCollectionResult(
  db: DbClient,
  actor: CashActor,
  invoiceId: string,
  winner: InvoicePaymentRow,
): Promise<PaymentResult> {
  const shiftId = winner.cash_shift_id;
  if (!shiftId) {
    // Un cobro de factura CON marca siempre queda atado a un turno: las dos
    // puertas que escriben la marca lo graban (esta, `shift.id`; el cobro
    // dividido, su turno de cobro). Sin turno no hay `PaymentResult` que
    // devolver, así que se grita en vez de inventar uno.
    throw new CashError("INTERNAL", "Error interno.", 500);
  }
  const detail = await getInvoiceDetail(actor.sedeId, invoiceId).catch((error) => {
    throw toCashError(error);
  });
  const shift = await getShiftOrThrow(db, actor.sedeId, shiftId);
  const { data, error } = await db
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("invoice_id", winner.invoice_id)
    .eq("cash_shift_id", shiftId)
    .eq("method_code", winner.method_code)
    .eq("amount", roundMoney(Number(winner.amount)))
    .limit(1)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  if (!data) {
    throw new CashError(
      "PAYMENT_ROLLBACK_FAILED",
      "El cobro quedó registrado en la factura y en el arqueo, pero no en el libro de caja del turno. No reintente: avise al administrador.",
      500,
    );
  }
  return {
    payment: data as CashPaymentRow,
    shift,
    invoice_id: invoiceId,
    invoice_status: detail.invoice.status,
  };
}

/**
 * CL-4: la fila del LIBRO DE CAJÓN (`payments`) que YA se registró con esa
 * marca, DENTRO DE ESE TURNO.
 *
 * La marca es un uuid que acuña el llamador al empezar el intento de pago y que
 * reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `registerPaymentSchema` (schemas.ts). El filtro es por
 * TURNO: la fila del libro pertenece a un turno (`cash_shift_id` es NOT NULL y
 * es el dueño del dinero), así que la marca se resuelve dentro del turno que la
 * usó, el lookup nunca puede devolver el pago de OTRO turno, y la misma marca
 * en dos turnos son dos operaciones. Es el mismo patrón que
 * `findInvoicePaymentsByIdempotencyKey` (acá arriba, y billing/service.ts) y
 * `findPayrollPaymentsByIdempotencyKey` (payroll/service.ts), con la clave de
 * esta tabla: la migración 043 eligió `(cash_shift_id, idempotency_key)` y este
 * lookup usa la MISMA clave, así que no puede devolver una fila que el índice
 * no habría bloqueado.
 *
 * SÓLO MIRA EL CAMINO SIN FACTURA, por construcción: las filas del camino con
 * factura quedan con la marca NULL (su identidad es la fila espejo de 042) y un
 * `eq("idempotency_key", mark)` nunca las ve. Es deliberado: mezclar en un
 * mismo índice las marcas de los dos caminos haría que la marca de un cobro de
 * factura pudiera leerse como "el pago de cajón ya está registrado".
 *
 * ACÁ NO ESTÁ LA ARRUGA DE "LA MARCA EN LA PRIMERA PORCIÓN" de 042: este
 * camino inserta UNA sola fila (una sentencia de un objeto, no un
 * `insert([...])` de N porciones), así que la marca vive en esa única fila, el
 * índice único parcial de 043 nunca puede rechazar una operación legítima y no
 * hay filas hermanas que enumerar: la fila que devuelve este lookup ES la
 * operación completa.
 */
async function findDrawerPaymentByIdempotencyKey(
  db: DbClient,
  shiftId: string,
  idempotencyKey: string,
): Promise<CashPaymentRow | null> {
  const { data, error } = await db
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("cash_shift_id", shiftId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  return (data as CashPaymentRow | null) ?? null;
}

/**
 * CL-4: el resultado de una repetición reconocida del camino SIN factura: lo
 * que la operación YA registró, sin escribir nada.
 *
 * El llamador recibe el MISMO `PaymentResult` que le devolvió el intento que
 * ganó —misma fila del libro, mismo turno, `invoice_id` e `invoice_status`
 * nulos, que es lo que este camino devuelve—, así que para él es un no-op
 * exitoso y no un error. El turno que se devuelve es el que COBRÓ: el único
 * que el lookup pudo encontrar, porque la marca se resuelve dentro del turno.
 */
function repeatedDrawerPaymentResult(payment: CashPaymentRow, shift: CashShiftRow): PaymentResult {
  return { payment, shift, invoice_id: null, invoice_status: null };
}

/**
 * CAJ-02: registra un pago contra el turno abierto (el indicado o el
 * único abierto de la sede). Método activo, monto > 0; si trae
 * invoice_id, la factura debe existir en la sede y no estar Anulada.
 *
 * Consolidación T5/T0-a: el cobro de factura vive en `invoice_payments` (el
 * ledger del cobro, con `cash_shift_id` = turno que COBRA) y se refleja en
 * `payments` (por turno, PRD §9.1, con `user_id`: el único rastro de quién
 * cobró). CL-14: el espejo, la fila de cajón y el ESTADO de la factura se
 * escriben en UNA transacción (`cash_invoice_payment_atomic`, migración 053),
 * así que ya no hay un "antes" y un "después" donde una falla pueda dejar el
 * dinero cobrado con la factura abierta —el huérfano invisible del Defecto 2 y
 * el estado parcial que quedaba para siempre—. Si el neto cobrado completa el
 * neto facturado, la factura pasa a Pagada y se vincula al turno
 * (`cash_shift_id`), dentro de esa misma transacción. Solo admin/caja (vía
 * requireCashWriter en rutas/actions).
 *
 * CL-3 (idempotencia): cuando el pago trae `invoice_id`, el cuerpo exige la
 * MARCA del intento (`idempotency_key`, migración 042: columna e índice único
 * parcial `(invoice_id, idempotency_key)` ya construidos para el cobro
 * dividido). Un reintento del MISMO envío devuelve lo que la operación ya
 * registró como un no-op EXITOSO en vez de cobrar dos veces. Es la puerta de
 * CAJA donde un reintento duplicaba dinero y la única que acepta montos
 * PARCIALES: el tope de 031 usa la misma aritmética y por eso tampoco la frena
 * (con 2 × entrante ≤ saldo, el reintento entra las dos veces). El cobro
 * dividido, en cambio, exige el saldo EXACTO: su reintento muere en esa
 * comprobación.
 *
 * QUÉ PASA CON UN PAGO SIN FACTURA (CL-4): la marca también es OBLIGATORIA y
 * ahora se mira. Esa fila vive sólo en `payments` y es la ÚNICA escritura de esa
 * operación, así que la columna y el índice único parcial de la migración 043
 * —`(cash_shift_id, idempotency_key)`— son su identidad. Antes de la 043 un
 * reintento escribía una SEGUNDA fila y los tres lectores del arqueo —que suman
 * `payments WHERE invoice_id IS NULL`— contaban el efectivo del turno dos
 * veces; no había tope que lo frenara, porque este camino no tiene obligación
 * contra la cual compararse.
 */
export async function registerPayment(raw: unknown, actor: CashActor): Promise<PaymentResult> {
  const parsed = registerPaymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: RegisterPaymentInput = parsed.data;
  // CL-3/CL-4: la marca del intento. El esquema la exige SIEMPRE
  // (`registerPaymentSchema`, con la MISMA definición para las cinco puertas
  // del dinero); esta es la SEGUNDA red —el patrón del CHECK de forma de la
  // 042 y de la 043— y además el único valor que usan el reconocimiento y la
  // escritura, así que no pueden separarse. Un pago sin marca se rechaza acá,
  // ANTES de leer nada y de escribir nada: sin marca no se puede reconocer una
  // repetición, y la ruta REST es justamente la superficie que reintenta.
  const mark = input.idempotency_key ?? "";
  if (!mark) {
    throw new CashError(
      "VALIDATION",
      "La marca de idempotencia es obligatoria para registrar un pago.",
      400,
    );
  }
  const db = await cashDb();
  try {
    const shift = input.cash_shift_id
      ? await getShiftOrThrow(db, actor.sedeId, input.cash_shift_id)
      : await getOpenShift(actor.sedeId).then((row) => {
          if (!row) {
            throw new CashError(
              "NO_OPEN_SHIFT",
              "No hay un turno abierto. Abra un turno antes de registrar pagos.",
              409,
            );
          }
          return row;
        });
    if (shift.status !== "abierto") {
      throw new CashError("SHIFT_CLOSED", "El turno ya está cerrado.", 409);
    }

    const methods = await listPaymentMethods(actor.sedeId).catch((error) => {
      throw toCashError(error);
    });
    const method = methods.find((row) => row.is_active && row.code === input.method_code);
    if (!method) {
      throw new CashError(
        "METHOD_INACTIVE",
        `El método de pago ${input.method_code} no está activo en esta sede.`,
        422,
      );
    }

    let invoiceStatus: string | null = null;
    let invoiceShiftId: string | null = null;
    let invoiceBalance: InvoiceNetBalance | null = null;

    // T0-a (Defecto 1): el monto de entrada es el BRUTO que el cliente entrega
    // (019: la porción guarda bruto y el arqueo suma bruto; el contrato de
    // `POST /api/v1/cash/payments` no cambia), así que el recargo se DERIVA de
    // él con el `fee_percent` del método cobrado (`payment_methods.fee_percent`:
    // el mismo snapshot que escribe billing al emitir). El bruto se redondea
    // UNA vez: la aritmética del servicio y las dos filas escritas
    // (`invoice_payments.amount` y `payments.amount`, numeric(12,2)) coinciden
    // al centavo, así el tope de 031 ve exactamente el neto que calculó el
    // servicio.
    const gross = roundMoney(input.amount);
    const feePercent = Math.max(0, Number(method.fee_percent) || 0);
    const cardFee = splitGrossCardFee(gross, feePercent);

    if (input.invoice_id) {
      const detail = await getInvoiceDetail(actor.sedeId, input.invoice_id).catch((error) => {
        throw toCashError(error);
      });
      if (detail.invoice.status === "Anulada") {
        throw new CashError("ANNUL_INVALID", "No se puede cobrar una factura anulada.", 409);
      }
      // CL-3: la MARCA, antes de la aritmética del saldo que decide y antes de
      // cualquier escritura. Un reintento del MISMO envío (doble clic, o el
      // navegador reenviando tras cortarse la red) trae la misma marca: se
      // devuelve lo que la operación ya registró, sin escribir nada.
      //
      // POR QUÉ ACÁ Y NO ANTES DEL TURNO: acá el turno no es sólo "quién cobra"
      // —a diferencia del cobro dividido, que mira la marca antes de sus guardas
      // de turno—, sino el DUEÑO del cobro (la fila espejo y la del libro de
      // cajón guardan `cash_shift_id`) y además el SELECTOR del turno (un
      // `cash_shift_id` ausente significa "el turno abierto"), así que el turno
      // y el método se resuelven primero. La contrapartida, declarada: un
      // reintento que llegue con el turno ya cerrado o con el método inactivo se
      // rechaza con SHIFT_CLOSED/METHOD_INACTIVE en vez de reconocerse; el caso
      // real del reintento —doble clic o corte de red, segundos después— tiene
      // el turno abierto y el método activo.
      //
      // Va DESPUÉS de la anulación a propósito, como en el cobro dividido: una
      // factura anulada no admite cobros, repetidos o no.
      //
      // POR QUÉ ANTES DEL SALDO: el tope de 031 y la comprobación del servicio
      // usan la MISMA aritmética (neto cobrado + neto nuevo ≤ neto facturado),
      // así que un reintento que llene el saldo moría con OVERPAID —un error por
      // una operación que SÍ se registró—. Mirando la marca antes, la repetición
      // se reconoce en vez de confundirse con un cobro nuevo.
      const repeated = await findInvoicePaymentsByIdempotencyKey(db, input.invoice_id, mark);
      if (repeated.length > 0) {
        return repeatedCollectionResult(db, actor, input.invoice_id, repeated[0]);
      }
      invoiceStatus = detail.invoice.status;
      invoiceShiftId = detail.invoice.cash_shift_id;
      // T0-a (Defecto 2): el saldo cobrable es NETO (total − surcharge, 019) y
      // la porción entra en neto (bruto − recargo). El bruto de un cobro con
      // tarjeta supera `invoices.total` cuando el recargo es de un cobro
      // POSTERIOR a la emisión: comparar el bruto contra el total rechazaba
      // como "sobrepago" un cobro legítimo. Mismo tope y tolerancia que el
      // trigger de 031 (0.009), que es la barrera real ante carreras.
      invoiceBalance = invoiceNetBalance({
        total: detail.invoice.total,
        surcharge: detail.invoice.surcharge,
        payments: detail.payments,
      });
      if (invoiceBalance.netCollected + cardFee.net - invoiceBalance.netBilled > 0.009) {
        throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);
      }
    }

    if (!input.invoice_id) {
      // CL-4: la MARCA del camino SIN factura, antes de la ÚNICA escritura de
      // este camino y antes de cualquier otra lectura que decida. Un reintento
      // del MISMO envío (doble clic, o el navegador reenviando tras cortarse la
      // red) trae la misma marca: se devuelve lo que la operación ya registró,
      // sin escribir nada y sin contar el efectivo del turno dos veces.
      //
      // POR QUÉ ACÁ Y NO ANTES DEL TURNO: el turno es el DUEÑO de la fila
      // (`cash_shift_id`) y el ALCANCE de la marca —la clave del índice de 043
      // es `(cash_shift_id, idempotency_key)`—, así que hay que resolverlo
      // primero. La contrapartida, declarada en la 043 como "LIMITACIÓN
      // DECLARADA": un reintento que llegue con el turno ya cerrado se rechaza
      // con SHIFT_CLOSED, y uno que llegue SIN `cash_shift_id` después de que
      // se cerró el turno original y se abrió otro se resuelve contra el turno
      // nuevo, no encuentra la marca ahí y escribe una segunda fila. El caso
      // real del reintento —segundos después— tiene el mismo turno abierto, y
      // ahí la marca SÍ reconoce.
      //
      // Va DESPUÉS de resolver el método a propósito (mismo orden que el camino
      // con factura, que también resuelve método antes): el método inactivo se
      // reporta como METHOD_INACTIVE, repetido o no.
      const repeated = await findDrawerPaymentByIdempotencyKey(db, shift.id, mark);
      if (repeated) return repeatedDrawerPaymentResult(repeated, shift);
    }

    // CL-14: el cobro de una factura es UNA transacción (migración 053). Antes
    // eran TRES requests contra PostgREST —la fila espejo (`invoice_payments`,
    // el dinero que suma el arqueo), la fila del libro de cajón (`payments`) y,
    // TERCERO, el estado de la factura— y el tercero no tenía compensación
    // ninguna: una falla ahí dejaba el dinero COBRADO (las dos filas escritas)
    // con la factura `Emitida` para siempre —el saldo cobrable quedó en cero,
    // así que ningún cobro posterior podía cerrarla, y el reintento del MISMO
    // envío, con la marca de la 042, era un no-op que devolvía la factura
    // abierta—.
    //
    // El PAR espejo+cajón se compensaba a mano y se gritaba
    // (`PAYMENT_ROLLBACK_FAILED`): esa compensación YA NO EXISTE, porque ya no
    // hace falta. `cash_invoice_payment_atomic` escribe los TRES grupos dentro
    // de la transacción de UNA sentencia —o ninguno—, y el desenlace observable
    // de una falla es el mismo que la compensación buscaba (NADA escrito), sin
    // un DELETE de dinero y sin ventana entre el rollback y el error.
    //
    // LA ARITMÉTICA NO SE MUEVE A SQL. Siguen acá, antes de llamar: el bruto
    // (`gross`, redondeado UNA vez con `roundMoney`), el reparto del recargo
    // (`splitGrossCardFee`), el saldo (`invoiceNetBalance`), su tope de 031, la
    // marca de la 042 y la decisión `Pagada` (`moneyEquals`, abajo). La función
    // escribe cada columna verbatim y no compara el cobrado contra el facturado
    // ni una vez.
    let writtenPayment: CashPaymentRow | null = null;
    if (input.invoice_id) {
      // Las DOS decisiones del estado, tomadas acá y enviadas como booleanos:
      //
      //   * enlazar la factura al turno que COBRA, sólo si no tenía turno (una
      //     factura emitida en el turno de A y cobrada en el de B pertenece al
      //     turno que cobra);
      //   * cerrarla, cuando el NETO cobrado cubre el neto facturado: con el
      //     recargo de un cobro POSTERIOR a la emisión el bruto supera `total`,
      //     así que comparar el bruto contra total dejaba en Emitida una factura
      //     con el neto ya completo.
      //
      // El recargo (`fee_percent` + `fee_amount`) viaja en el mismo objeto: es
      // lo que hace que `amount − fee_amount` sea el neto cobrado, que es lo que
      // suman el tope de 031, el saldo de la factura y el reporte del recargo.
      // Sin él, `fee_amount` tomaba su DEFAULT 0 y el recargo de la caja era
      // irrecuperable (T0-a, Defecto 1).
      const setShift = !invoiceShiftId;
      // `invoiceBalance !== null` es la guarda de TIPO: el saldo se resolvió en el
      // primer bloque de este camino, y TypeScript no correlaciona los dos `if`.
      const markPaid =
        invoiceStatus === "Emitida" &&
        invoiceBalance !== null &&
        moneyEquals(roundMoney(invoiceBalance.netCollected + cardFee.net), invoiceBalance.netBilled);
      // CL-3: la marca del intento en la ÚNICA fila espejo de este camino (una
      // sentencia de un objeto: la arruga de "la marca en la primera porción" de
      // 042 no aplica acá). Es la barrera final de la carrera, con el índice
      // único parcial de 042, que ahora corre DENTRO de la transacción.
      const { data: written, error: payError } = await db.rpc("cash_invoice_payment_atomic", {
        p_sede_id: actor.sedeId,
        p_shift_id: shift.id,
        p_invoice_id: input.invoice_id,
        p_user_id: actor.userId,
        p_set_shift: setShift,
        p_mark_paid: markPaid,
        p_collection: {
          method_id: method.id,
          method_code: method.code,
          amount: gross,
          fee_percent: feePercent,
          fee_amount: cardFee.fee,
          idempotency_key: mark,
        },
      });
      if (payError) {
        const code = (payError as { code?: string } | null)?.code;
        const message = String((payError as { message?: unknown } | null)?.message ?? "");
        // Las precondiciones que la transacción revalida ADENTRO sobre la fila
        // bloqueada —una factura Anulada, una factura que ya no está— salen con
        // su MENSAJE y con el MISMO SQLSTATE del tope de 031 (P0001), así que el
        // mensaje se mira ANTES que el código: si no, un cobro sobre una factura
        // anulada se leería como "se pasó del tope".
        if (message.includes("ANNUL_INVALID")) {
          throw new CashError("ANNUL_INVALID", "No se puede cobrar una factura anulada.", 409);
        }
        if (message.includes("INVOICE_NOT_FOUND")) {
          throw new CashError("INVOICE_NOT_FOUND", "Factura no encontrada.", 404);
        }
        if (message.includes("PAYMENT_INVALID") || message.includes("PAYMENT_MISMATCH")) {
          // Una entrada a medio formar o una red de conteo que no cuadró: es una
          // invariante rota del llamador o de la base, no un rechazo de negocio.
          throw new CashError("INTERNAL", "Error interno.", 500);
        }
        // Dos barreras pueden rechazar el INSERT del espejo, DENTRO de la
        // transacción, y el código lo dice: el tope de 031 (trigger BEFORE
        // INSERT → P0001) y el índice único parcial de identidad de la 042
        // (23505). El orden depende de cuál llegue primero —el trigger de fila
        // corre ANTES de la comprobación del índice—, así que las dos se atienden
        // igual: si la marca YA está registrada, esto es una repetición y la
        // respuesta es lo que dejó la ganadora.
        if (code === "23505" || code === "P0001") {
          // COSTO DECLARADO: acá no se quema ningún número (`invoice_payments`
          // no tiene consecutivo: su `id` es un uuid), lo que se pierde es la
          // transacción ABORTADA de la perdedora, que ya había leído el saldo. Se
          // prefiere eso —raro, y exige dos envíos con la misma marca
          // solapados— antes que cobrar dos veces. La factura tampoco pasa a
          // Pagada dos veces: el cierre va en la MISMA transacción que el espejo
          // y sólo escribe si el servicio lo decidió.
          const winner = await findInvoicePaymentsByIdempotencyKey(db, input.invoice_id, mark);
          if (winner.length > 0) {
            return repeatedCollectionResult(db, actor, input.invoice_id, winner[0]);
          }
          // Sin cobro con esa marca, el rechazo es el de siempre: el tope.
          if (code === "P0001") {
            throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);
          }
          throw new CashError("INTERNAL", "Error interno.", 500);
        }
        throw new CashError("INTERNAL", "Error interno.", 500);
      }
      // La transacción devuelve SU propia fila (el libro de cajón escrito, con
      // las columnas de PAYMENT_SELECT) y el estado que dejó la factura: el
      // llamador no necesita otra lectura y no hay ventana entre la escritura y
      // el resultado.
      const result = written as {
        payment?: CashPaymentRow | null;
        invoice?: { status?: string | null } | null;
      } | null;
      if (!result?.payment) {
        // La transacción no confirmó su escritura. No es un desenlace del SQL
        // —la función devuelve su jsonb o revienta, y si revienta el error llega
        // arriba—, así que es una invariante rota en la frontera y se grita. Como
        // la escritura es INDIVISIBLE, lo único honesto que se puede afirmar es
        // que NO hay un cobro confirmado: no quedó una mitad escrita que
        // compensar. Es el desenlace que este camino ya nombraba
        // (`MIRROR_UNCONFIRMED`), ahora sin compensación de por medio.
        console.error(
          "RPC cash_invoice_payment_atomic sin confirmación:",
          JSON.stringify({
            invoice_id: input.invoice_id,
            shift_id: shift.id,
            method_code: method.code,
            amount: gross,
            fee_percent: feePercent,
            fee_amount: cardFee.fee,
          }),
        );
        throw new CashError(
          "MIRROR_UNCONFIRMED",
          "No se pudo confirmar el registro del cobro en la factura; no quedó nada escrito. Reintente.",
          500,
        );
      }
      writtenPayment = result.payment;
      // El estado de la factura es el que la transacción DEJÓ ESCRITO (o el que
      // dejó intacto): se devuelve eso, no una suposición del llamador.
      if (result.invoice?.status) invoiceStatus = result.invoice.status;
    } else {
      // CL-4: el pago SIN factura. Su ÚNICA escritura es esta fila del libro de
      // cajón (`payments`), sin espejo: UNA sentencia ya es una transacción y no
      // tiene nada que compartir con la transacción de la 053 (no hay espejo ni
      // estado de factura que escribir). La marca del intento la lleva ESTA fila
      // (columna e índice de 043): es la identidad de la operación, porque no hay
      // un espejo que la identifique.
      const { data: payment, error: paymentError } = await db
        .from("payments")
        .insert({
          sede_id: actor.sedeId,
          cash_shift_id: shift.id,
          invoice_id: null,
          method_id: method.id,
          method_code: method.code,
          amount: gross,
          user_id: actor.userId,
          // La marca del intento, en la fila del libro de cajón (043).
          idempotency_key: mark,
        })
        .select(PAYMENT_SELECT)
        .single();
      if (paymentError || !payment) {
        // CL-4: barrera FINAL de la carrera del pago SIN factura. El lookup de
        // arriba y este INSERT no son atómicos: si otro envío con la MISMA marca
        // en el MISMO turno confirmó en esa ventana, este INSERT choca con el
        // índice único parcial de 043 (23505). Acá NO hay espejo que revertir (el
        // camino sin factura escribe UNA sola fila), así que la repetición se
        // relee y se devuelve; sin ganadora, el 23505 no es una repetición y se
        // reporta como fallo real en vez de disfrazarlo.
        //
        // COSTO DECLARADO: acá no se quema ningún número (`payments.id` es un
        // uuid, la tabla no tiene serie); lo que se pierde es la sentencia
        // ABORTADA de la perdedora, que ya había resuelto turno y método. Se
        // prefiere eso —raro, y exige dos envíos con la misma marca solapados—
        // antes que contar el efectivo del turno dos veces.
        if ((paymentError as { code?: string } | null)?.code === "23505") {
          const winner = await findDrawerPaymentByIdempotencyKey(db, shift.id, mark);
          if (winner) return repeatedDrawerPaymentResult(winner, shift);
        }
        throw new CashError("INTERNAL", "Error interno.", 500);
      }
      writtenPayment = payment as CashPaymentRow;
    }

    if (!writtenPayment) {
      // Inalcanzable por construcción (cada rama de arriba asigna una fila o
      // lanza), pero el tipo y la garantía de la respuesta lo exigen: ninguna
      // respuesta puede salir sin el cobro que se registró.
      throw new CashError("INTERNAL", "Error interno.", 500);
    }

    return {
      payment: writtenPayment,
      shift,
      invoice_id: input.invoice_id ?? null,
      invoice_status: invoiceStatus,
    };
  } catch (error) {
    throw toCashError(error);
  }
}

// ------------------------------------------------------------------- cierre ---

/**
 * CAJ-03/CAJ-04: cierra con arqueo. Solo se pide el conteo; la base del
 * próximo turno es automática (min(contado, configurada)) y jamás se pide
 * justificación (arqueo escondido). expected_cash = efectivo cobrado en el
 * turno; calcula recogido (= contado − base) y diferencia
 * (= base − base configurada).
 *
 * Los vales APROBADOS del turno (por su method_code) son salidas de caja y
 * descuentan del esperado por método, igual que los pagos inmediatos de
 * comisión; un vale pendiente o rechazado no toca caja.
 *
 * LIMITACIÓN CONOCIDA: si la caja ya le entregó el efectivo al empleado y el
 * administrador rechaza el vale después, ese dinero salió del cajón pero el
 * sistema no lo registra (rechazar no toca caja): el cierre puede mostrar un
 * faltante no explicado por el sistema. Trade-off aceptado.
 */
export interface CloseShiftResult {
  shift: CashShiftRow;
  methodDifferences: MethodDifference[];
  /** Total de vales aprobados del turno (salida de caja, valor absoluto). */
  vales: number;
}

export async function closeShift(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: CashActor,
): Promise<CloseShiftResult> {
  const parsed = closeShiftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: CloseShiftInput = parsed.data;
  const db = await cashDb();
  try {
    const shift = await getShiftOrThrow(db, sedeId, id);
    if (shift.status !== "abierto") {
      throw new CashError("SHIFT_ALREADY_CLOSED", "El turno ya está cerrado.", 409);
    }
    let isOverride = false;
    try {
      isOverride = assertShiftCloser({
        openedBy: shift.opened_by,
        actorUserId: actor.userId,
        isAdmin: (actor.roles ?? []).includes("admin"),
      }).isOverride;
    } catch (error) {
      throw toCashError(error);
    }
    const register = await resolveRegister(db, sedeId, shift.cash_register_id);
    try {
      assertCloseInput({ countedCash: input.counted_cash });
    } catch (error) {
      throw toCashError(error);
    }
    // Automatic next base (hidden count): never asked, never justified.
    const baseLeft = resolveClosingBase(input.counted_cash, Number(register.base_configurada));

    // T0-a (C1): el arqueo suma los DOS ledgers del turno SIN solapar:
    // movimientos de cajón SIN factura (`invoice_id IS NULL`) más los cobros
    // de factura del turno. Un pago con factura ya vive en `invoice_payments`
    // (ledger del cobro de factura): sumarlo también desde `payments`
    // duplicaba el efectivo del turno.
    const { data: shiftPayments, error: paymentsError } = await db
      .from("payments")
      .select("amount, method_code")
      .eq("cash_shift_id", shift.id)
      .is("invoice_id", null);
    if (paymentsError) throw new CashError("INTERNAL", "Error interno.", 500);
    const invoicePayMaps = await fetchInvoicePaymentsByShift(db, [shift.id]);
    const invoicePays = invoicePayMaps.get(shift.id) ?? [];
    const paidByMethod = sumShiftMoneyByMethod(mergeShiftMoney(shiftPayments, invoicePays));
    // Pagos inmediatos de comisión del turno (descuentan del esperado
    // por método: lo cobrado menos lo pagado).
    const { data: payoutRows, error: payoutError } = await db
      .from("commission_payouts")
      .select("method_code, amount")
      .eq("cash_shift_id", shift.id);
    if (payoutError) throw new CashError("INTERNAL", "Error interno.", 500);
    const paidOutByMethod = new Map<string, number>();
    for (const row of ((payoutRows ?? []) as Array<{ method_code: string; amount: number | string }>)) {
      paidOutByMethod.set(row.method_code, roundMoney((paidOutByMethod.get(row.method_code) ?? 0) + Number(row.amount)));
    }
    const payoutsOut = roundMoney([...paidOutByMethod.values()].reduce((acc, value) => acc + value, 0));
    // Vales aprobados del turno: salida de dinero por su método (RESTAN del
    // esperado, igual que los pagos inmediatos de comisión). Un vale pendiente
    // o rechazado no toca caja (regla "no toca caja hasta aprobar").
    const voucherOutMaps = await fetchVoucherOutTotals(db, [shift.id]);
    const voucherOut = voucherOutMaps.get(shift.id) ?? new Map<string, number>();
    for (const [code, amount] of voucherOut) {
      paidOutByMethod.set(code, roundMoney((paidOutByMethod.get(code) ?? 0) + amount));
    }
    const vouchersOut = sumMethodTotal(voucherOut);
    // Facturas cobradas en este turno (emitidas aquí o en turnos anteriores):
    // ya suman al esperado y al arqueo por método en `paidByMethod`.
    const { total: invoicesTotal, count: invoicesCount } = invoiceCollectionsSummary(invoicePays);

    const expectedCash = roundMoney(
      (paidByMethod.get("efectivo") ?? 0) - (paidOutByMethod.get("efectivo") ?? 0),
    );

    // El conteo de efectivo sale del detalle por denominación (el sistema
    // calcula; el total declarado debe cuadrar con el detalle).
    const declared = await checkCounts(sedeId, input.counts);
    const countedFromDetail = declared.get("efectivo") ?? 0;
    if (!moneyEquals(countedFromDetail, input.counted_cash)) {
      throw new CashError("COUNT_MISMATCH", "El conteo no cuadra con el detalle por denominación.", 422);
    }
    // Digitales: lo declarado contra el saldo de apertura del turno más
    // lo cobrado en el turno menos lo pagado inmediato (el "total en la
    // aplicación").
    const countMaps = await fetchCountTotals(db, [shift.id]);
    const openByMethod = countMaps.get(shift.id)?.open ?? new Map<string, number>();
    const methodDifferences: MethodDifference[] = [];
    for (const [code, total] of declared) {
      if (code === "efectivo") continue;
      const expected = expectedDigitalTotal(
        openByMethod.get(code) ?? 0,
        paidByMethod.get(code) ?? 0,
        paidOutByMethod.get(code) ?? 0,
      );
      if (!moneyEquals(total, expected)) {
        methodDifferences.push({ method_code: code, expected, declared: total, difference: roundMoney(total - expected) });
      }
    }

    const close = computeCashClose({
      countedCash: input.counted_cash,
      baseLeft,
      baseConfigurada: Number(register.base_configurada),
    });
    const observation = input.observation?.trim() ? input.observation.trim() : null;

    // CL-10: el cierre del turno y su arqueo son UNA sola escritura. Una
    // función SQL es UNA sentencia, y una sentencia corre ENTERA dentro de una
    // sola transacción del servidor (PostgREST no ofrece multi-statement por
    // request). Antes esto eran DOS requests —el UPDATE que pisaba el turno a
    // `cerrado` y después el INSERT de sus líneas de conteo— y un fallo entre
    // los dos dejaba el cierre FIRMADO sin su evidencia: el turno con su total,
    // su base dejada, su recogido y su sobre, y ninguna línea que dijera cuántos
    // billetes de cada valor había. Peor: era un CALLEJÓN SIN SALIDA, porque el
    // compare-and-swap de abajo sólo pisa un turno `abierto`, así que el
    // reintento respondía SHIFT_ALREADY_CLOSED y el conteo por denominación
    // —que es lo que hace real a un arqueo— no se podía volver a escribir.
    //
    // La ARITMÉTICA no se mueve: el esperado sale del arqueo del turno, la base
    // dejada de `resolveClosingBase`, el recogido y el sobre de
    // `computeCashClose`, y cada línea del conteo de `checkCounts`; el RPC sólo
    // ESCRIBE lo que recibe y devuelve el turno escrito.
    const { data: updated, error: updateError } = await db.rpc("cash_close_shift_atomic", {
      p_sede_id: sedeId,
      p_shift_id: shift.id,
      p_closed_by: actor.userId,
      p_closed_at: new Date().toISOString(),
      p_close: {
        expected_cash: expectedCash,
        counted_cash: roundMoney(input.counted_cash),
        base_left: roundMoney(baseLeft),
        cash_withdrawn: close.cashWithdrawn,
        base_difference: close.baseDifference,
        observation,
      },
      p_counts: countLines(input.counts),
    });
    if (updateError || !updated) {
      // CHECK expected_cash >= 0 (006_cash.sql): el turno tiene más salidas
      // en efectivo (vales/comisiones) que efectivo cobrado. Es una regla de
      // negocio, no un fallo interno: se reporta con su código y ayuda. El CHECK
      // no se replicó en la función a propósito (ver la migración 049): la
      // transacción la deja hablar y acá se traduce igual que antes.
      const errorCode = (updateError as { code?: string } | null)?.code;
      const errorMessage = (updateError as { message?: string } | null)?.message ?? "";
      if (errorCode === "23514" && /expected_cash/i.test(errorMessage)) {
        throw new CashError(
          "CASH_OUT_EXCEEDS_COLLECTED",
          "Las salidas en efectivo del turno superan el efectivo cobrado. Revise los vales y comisiones pagados en efectivo antes de cerrar.",
          422,
        );
      }
      // Carrera perdida contra el guard de estado: otro cierre ganó el
      // compare-and-swap primero. Antes la detectaba el `.single()` sin filas
      // del UPDATE suelto (PGRST116); ahora la detecta la red de conteo de la
      // transacción —el UPDATE afecta 0 filas— con el MISMO error de negocio y
      // el MISMO estado, y sin dejar los conteos de este intento escritos.
      if (errorMessage.includes("SHIFT_ALREADY_CLOSED")) {
        throw new CashError("SHIFT_ALREADY_CLOSED", "El turno ya está cerrado.", 409);
      }
      throw new CashError("INTERNAL", "Error interno.", 500);
    }
    const closed = updated as CashShiftRow;
    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.SHIFT_CLOSED,
      entity: "cash_shifts",
      entity_id: shift.id,
      metadata: {
        expected_cash: expectedCash,
        counted_cash: roundMoney(input.counted_cash),
        base_left: roundMoney(baseLeft),
        base_configurada: Number(register.base_configurada),
        base_difference: close.baseDifference,
        base_incompleta: close.baseDifference < 0,
        admin_override: isOverride,
        payouts_out: payoutsOut,
        vouchers_out: vouchersOut,
        method_differences: methodDifferences,
        observation: observation ?? null,
        invoices_total: invoicesTotal,
        invoices_count: invoicesCount,
      },
    });
    if (methodDifferences.length > 0) {
      await writeAudit({
        sede_id: sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.SHIFT_CLOSE_MISMATCH,
        entity: "cash_shifts",
        entity_id: shift.id,
        metadata: { method_differences: methodDifferences },
      });
    }
    return { shift: closed, methodDifferences, vales: vouchersOut };
  } catch (error) {
    throw toCashError(error);
  }
}

/**
 * CASH: actualiza la base configurada de una caja (solo admin; el gate vive
 * en actions). Queda rastro de auditoría con el valor anterior y el nuevo.
 */
export async function updateRegisterBase(
  sedeId: string,
  registerId: string,
  base: number,
  actor: CashActor,
): Promise<CashRegisterRow> {
  if (!Number.isFinite(base) || base < 0) {
    throw new CashError("VALIDATION", "Base inválida.", 400);
  }
  const db = await cashDb();
  const register = await resolveRegister(db, sedeId, registerId);
  const previous = Number(register.base_configurada);
  const { data: updated, error } = await db
    .from("cash_registers")
    .update({ base_configurada: roundMoney(base) })
    .eq("id", register.id)
    .select(REGISTER_SELECT)
    .single();
  if (error || !updated) throw new CashError("INTERNAL", "Error interno.", 500);
  await writeAudit({
    sede_id: sedeId,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.REGISTER_BASE_UPDATED,
    entity: "cash_registers",
    entity_id: register.id,
    metadata: { previous_base: previous, new_base: roundMoney(base) },
  });
  return updated as CashRegisterRow;
}

/**
 * U3: recontar un cierre (solo admin; el gate vive en actions). Un cierre
 * firmado es INMUTABLE: `cash_shifts` nunca se pisa. La corrección exige un
 * conteo COMPLETO nuevo (mismo detalle por denominación y totales digitales
 * que el cierre) más un motivo; se reutiliza la maquinaria del cierre
 * (`checkCounts`, `countLines`, `resolveClosingBase`, `computeCashClose`)
 * para que no exista una aritmética paralela. El reconteo se guarda en
 * `cash_shift_recounts` con la versión anterior congelada y la nueva, más
 * quién y cuándo, y deja sus líneas en `cash_shift_counts` (fase `reconteo`).
 *
 * Un cierre se recontá UNA vez: el reconteo también queda firmado y un
 * segundo intento se rechaza (ALREADY_RECOUNTED), no se encadena otro
 * reconteo encima. Antes esto era `updateClosedShift`, que escribía
 * `counted_cash`/`base_left` tecleados sin tocar los conteos por denominación
 * y dejaba el cierre contradiciendo su propia evidencia.
 */
export interface RecountShiftResult {
  /** El turno: su cierre firmado original sigue intacto. */
  shift: CashShiftRow;
  /** El reconteo con las dos versiones y quién/cuándo/por qué. */
  recount: ShiftRecountRow;
}

export async function recountClosedShift(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: CashActor,
): Promise<RecountShiftResult> {
  const parsed = recountShiftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await cashDb();
  const shift = await getShiftOrThrow(db, sedeId, id);
  if (shift.status !== "cerrado") {
    throw new CashError("VALIDATION", "Solo se recontán turnos cerrados.", 400);
  }
  const { data: existing, error: existingError } = await db
    .from("cash_shift_recounts")
    .select("id")
    .eq("shift_id", shift.id)
    .maybeSingle();
  if (existingError) throw new CashError("INTERNAL", "Error interno.", 500);
  if (existing) {
    throw new CashError(
      "ALREADY_RECOUNTED",
      "Este cierre ya fue recontado. El reconteo también quedó firmado y no se modifica.",
      409,
    );
  }
  const register = await resolveRegister(db, sedeId, shift.cash_register_id);
  // El reconteo es un conteo COMPLETO: mismas reglas que el cierre (métodos
  // arqueables completos, efectivo por denominación). `checkCounts` devuelve el
  // total por método; el efectivo declarado debe cuadrar con su detalle.
  const declared = await checkCounts(sedeId, parsed.data.counts);
  const countedFromDetail = declared.get("efectivo") ?? 0;
  if (!moneyEquals(countedFromDetail, parsed.data.counted_cash)) {
    throw new CashError("COUNT_MISMATCH", "El reconteo no cuadra con el detalle por denominación.", 422);
  }
  const record = buildRecountRecord({
    previous: signedAmounts(shift),
    countedCash: parsed.data.counted_cash,
    baseConfigurada: Number(register.base_configurada),
    reason: parsed.data.reason,
  });
  // CL-10: el reconteo y su detalle por denominación son UNA sola escritura.
  // Una función SQL es UNA sentencia, y una sentencia corre ENTERA dentro de
  // una sola transacción del servidor (PostgREST no ofrece multi-statement por
  // request). Antes esto eran DOS requests —la fila del reconteo con las dos
  // versiones y después sus líneas de conteo— y un fallo entre los dos dejaba
  // el reconteo FIRMADO sin su detalle; y también era un callejón sin salida,
  // porque el índice único por turno de 033 hace que el reintento responda
  // ALREADY_RECOUNTED. Rompía justo la promesa que el reconteo existe para
  // cumplir: las DOS versiones, cada una con su evidencia por denominación.
  //
  // La ARITMÉTICA no se mueve: las dos versiones salen de `buildRecountRecord`
  // (la anterior congelada de `signedAmounts`, la corregida de
  // `resolveClosingBase` + `computeCashClose`) y cada línea del conteo nuevo de
  // `checkCounts`; el RPC sólo ESCRIBE lo que recibe y devuelve el reconteo
  // escrito, con las mismas columnas que el servicio leía con RECOUNT_SELECT.
  const { data: inserted, error } = await db.rpc("cash_recount_shift_atomic", {
    p_sede_id: sedeId,
    p_shift_id: shift.id,
    p_recounted_by: actor.userId,
    p_recount: {
      previous_counted_cash: record.previous.counted_cash,
      previous_base_left: record.previous.base_left,
      previous_cash_withdrawn: record.previous.cash_withdrawn,
      previous_base_difference: record.previous.base_difference,
      counted_cash: record.next.counted_cash,
      base_left: record.next.base_left,
      cash_withdrawn: record.next.cash_withdrawn,
      base_difference: record.next.base_difference,
      reason: record.reason,
    },
    // Las líneas por denominación del reconteo las escribe la transacción en la
    // MISMA tabla del arqueo, en la fase `reconteo` (033 extiende el CHECK de
    // `phase`). Así la evidencia por denominación del reconteo es tan real como
    // la del cierre, y viaja ENTERA con la fila del reconteo: no hay mitad del
    // camino donde quedar firmada sin ella.
    p_counts: countLines(parsed.data.counts),
  });
  if (error || !inserted) {
    const errorCode = (error as { code?: string } | null)?.code;
    const errorMessage = String((error as { message?: string } | null)?.message ?? "");
    // Carrera perdida contra el índice único por turno (23505) o contra el
    // reconteo "uno por turno" re-evaluado dentro de la transacción: otro
    // reconteo ganó.
    if (errorCode === "23505" || errorMessage.includes("ALREADY_RECOUNTED")) {
      throw new CashError(
        "ALREADY_RECOUNTED",
        "Este cierre ya fue recontado. El reconteo también quedó firmado y no se modifica.",
        409,
      );
    }
    // El turno dejó de estar cerrado entre la lectura y la transacción: el
    // MISMO rechazo que el servicio da antes de llamar.
    if (errorMessage.includes("SHIFT_NOT_CLOSED")) {
      throw new CashError("VALIDATION", "Solo se recontán turnos cerrados.", 400);
    }
    throw new CashError("INTERNAL", "Error interno.", 500);
  }
  const recount = inserted as ShiftRecountRow;
  await writeAudit({
    sede_id: sedeId,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.SHIFT_RECOUNTED,
    entity: "cash_shifts",
    entity_id: shift.id,
    metadata: {
      reason: record.reason,
      previous: record.previous,
      corrected: record.next,
      recount_id: recount.id,
    },
  });
  return { shift, recount };
}

// -------------------------------------------------------- día e historial ---

export interface DayShiftView {
  shift: CashShiftRow;
  ventas: number;
  efectivo: number;
  /**
   * Total de vales aprobados del turno, en valor absoluto (es una SALIDA de
   * caja: el dinero ya salió del cajón, por eso resta del esperado). Suma
   * todos los métodos; 0 si no hay vales o si la migración de vales no está
   * aplicada.
   */
  vales: number;
  /** Cobrado por método en el turno (todos los métodos con movimiento). */
  metodos: Array<{ method_code: string; amount: number }>;
  /** Declarado por método (cierre si está cerrado, apertura si no). */
  declarados: Array<{ method_code: string; amount: number }>;
  /** Diferencias digitales del cierre (vacío en turnos abiertos). */
  diferencias: MethodDifference[];
  /** Revisión de los desajustes del turno (null si no hay). */
  revision: ShiftRevision | null;
  /**
   * U3: el reconteo del cierre, con las DOS versiones y quién/cuándo/por qué.
   * null cuando el cierre firmado nunca se recontó.
   */
  recount: ShiftRecountView | null;
  /**
   * U3: los cuatro montos que GOVIERNA el turno. Con reconteo, los corregidos;
   * sin reconteo, los del cierre firmado (`shift.*`). Las tablas y los
   * acumulados leen de acá: `shift.counted_cash` es la versión ORIGINAL firmada,
   * no la que rige, cuando hay reconteo.
   */
  vigente: {
    counted_cash: number | null;
    base_left: number | null;
    cash_withdrawn: number | null;
    base_difference: number | null;
  };
  /** Quién abrió / cerró (null al cerrar si sigue abierto). */
  abierto_por: string | null;
  cerrado_por: string | null;
}

/** Nombres de usuarios para las vistas (quién abrió/cerró). */
async function userNames(
  db: DbClient,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("users").select("id, full_name").in("id", ids);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  const names = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; full_name: string }>) {
    names.set(row.id, row.full_name);
  }
  return names;
}

export interface DayView {
  fecha: string;
  register: CashRegisterRow | null;
  shifts: DayShiftView[];
  totals: DayTotals;
}

/**
 * CAJ-05: turnos del día + acumulado (ventas, esperado, contado, base
 * dejada, recogido, diferencias). El acumulado cuadra con la suma de
 * turnos (accumulateDayTotals); el contado suma solo turnos cerrados.
 */
export async function getDayView(sedeId: string, raw: unknown): Promise<DayView> {
  const parsed = dayViewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { fecha } = parsed.data;
  const db = await cashDb();
  const { from, to } = dayBounds(fecha);
  const { data: shifts, error } = await db
    .from("cash_shifts")
    .select(SHIFT_SELECT)
    .eq("sede_id", sedeId)
    .gte("opened_at", from)
    .lte("opened_at", to)
    .order("opened_at")
    .limit(50);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  const rows = (shifts ?? []) as CashShiftRow[];

  let paymentsByShift = new Map<string, Array<{ amount: number; method_code: string }>>();
  if (rows.length > 0) {
    const { data: payments, error: paymentsError } = await db
      .from("payments")
      .select("cash_shift_id, amount, method_code")
      .in(
        "cash_shift_id",
        rows.map((row) => row.id),
      )
      .is("invoice_id", null);
    if (paymentsError) throw new CashError("INTERNAL", "Error interno.", 500);
    paymentsByShift = new Map();
    for (const row of (payments ?? []) as Array<{
      cash_shift_id: string;
      amount: number | string;
      method_code: string;
    }>) {
      const list = paymentsByShift.get(row.cash_shift_id) ?? [];
      list.push({ amount: Number(row.amount), method_code: row.method_code });
      paymentsByShift.set(row.cash_shift_id, list);
    }
  }

  const countMaps = await fetchCountTotals(
    db,
    rows.map((row) => row.id),
  );
  const closedIds = rows.filter((row) => row.status === "cerrado").map((row) => row.id);
  const reviews = await getShiftReviews(sedeId, closedIds);
  const payoutMaps = await fetchPayoutTotals(
    db,
    rows.map((row) => row.id),
  );
  const voucherOutMaps = await fetchVoucherOutTotals(
    db,
    rows.map((row) => row.id),
  );
  const invoicePayMaps = await fetchInvoicePaymentsByShift(
    db,
    rows.map((row) => row.id),
  );
  // U3: los reconteos de los turnos leídos, para preferir la versión corregida
  // y poder marcar en la vista que el cierre fue recontado.
  const recountMaps = await fetchRecounts(
    db,
    rows.map((row) => row.id),
  );
  const names = await userNames(db, [
    ...rows.flatMap((row) => [row.opened_by, row.closed_by]),
    ...[...recountMaps.values()].map((row) => row.recounted_by),
  ]);

  const views: DayShiftView[] = rows.map((shift) => {
    // T0-a (C1): `payments` sin factura + `invoice_payments` del turno.
    const list = mergeShiftMoney(paymentsByShift.get(shift.id), invoicePayMaps.get(shift.id));
    const paidByMethod = sumShiftMoneyByMethod(list);
    const counts = countMaps.get(shift.id) ?? {
      open: new Map<string, number>(),
      closed: new Map<string, number>(),
      recount: new Map<string, number>(),
    };
    const recountRow = recountMaps.get(shift.id) ?? null;
    // U3: el arqueo lee el conteo del reconteo cuando existe; si no, el del
    // cierre firmado. `counts.recount` vive aparte justamente para no sumarse
    // al cierre.
    const { metodos, declarados, diferencias } = buildMethodViews({
      paid: paidByMethod,
      open: counts.open,
      paidOut: sumMethodMaps(payoutMaps.get(shift.id), voucherOutMaps.get(shift.id)),
      closed:
        shift.status === "cerrado" ? (recountRow ? counts.recount : counts.closed) : null,
    });
    const revision = assembleShiftRevision(
      reviews.get(shift.id) ?? [],
      diferencias.length > 0,
    );
    return {
      shift,
      ventas: roundMoney(list.reduce((acc, row) => acc + row.amount, 0)),
      efectivo: roundMoney(
        list.filter((row) => row.method_code === "efectivo").reduce((acc, row) => acc + row.amount, 0),
      ),
      vales: sumMethodTotal(voucherOutMaps.get(shift.id)),
      metodos,
      declarados,
      diferencias,
      revision,
      recount: recountRow
        ? recountView(recountRow, names.get(recountRow.recounted_by) ?? null)
        : null,
      vigente: governingClose(shift, recountRow ? recountAmounts(recountRow) : null),
      abierto_por: names.get(shift.opened_by) ?? null,
      cerrado_por: shift.closed_by ? (names.get(shift.closed_by) ?? null) : null,
    };
  });

  const registers = await listRegisters(sedeId);
  return {
    fecha,
    register: registers[0] ?? null,
    shifts: views,
    totals: accumulateDayTotals(
      views.map((view) => ({
        expectedCash: view.efectivo,
        countedCash: view.vigente.counted_cash,
        baseLeft: view.vigente.base_left,
        cashWithdrawn: view.vigente.cash_withdrawn,
        baseDifference: view.vigente.base_difference,
        ventas: view.ventas,
      })),
    ),
  };
}

export interface HistoryResult {
  desde: string;
  hasta: string;
  shifts: DayShiftView[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * CAJ-06: historial de aperturas, movimientos, bases y cierres filtrable
 * por fecha (rango inclusive sobre opened_at, más recientes primero,
 * paginado en servidor de a HISTORY_PAGE_SIZE para que ningún rango
 * esconda turnos). La página /cash lo pide bajo demanda con el filtro.
 */
export async function getHistory(sedeId: string, raw: unknown): Promise<HistoryResult> {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { desde, hasta, page } = parsed.data;
  const db = await cashDb();
  const { from, to } = rangeBounds(desde, hasta);
  const { count, error: countError } = await db
    .from("cash_shifts")
    .select("id", { count: "exact", head: true })
    .eq("sede_id", sedeId)
    .gte("opened_at", from)
    .lte("opened_at", to);
  if (countError) throw new CashError("INTERNAL", "Error interno.", 500);
  const total = count ?? 0;
  const offset = (page - 1) * HISTORY_PAGE_SIZE;
  const { data: shifts, error } = await db
    .from("cash_shifts")
    .select(SHIFT_SELECT)
    .eq("sede_id", sedeId)
    .gte("opened_at", from)
    .lte("opened_at", to)
    .order("opened_at", { ascending: false })
    .range(offset, offset + HISTORY_PAGE_SIZE - 1);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  const rows = (shifts ?? []) as CashShiftRow[];

  let paymentsByShift = new Map<string, Array<{ amount: number; method_code: string }>>();
  if (rows.length > 0) {
    const { data: payments, error: paymentsError } = await db
      .from("payments")
      .select("cash_shift_id, amount, method_code")
      .in(
        "cash_shift_id",
        rows.map((row) => row.id),
      )
      .is("invoice_id", null);
    if (paymentsError) throw new CashError("INTERNAL", "Error interno.", 500);
    paymentsByShift = new Map();
    for (const row of (payments ?? []) as Array<{
      cash_shift_id: string;
      amount: number | string;
      method_code: string;
    }>) {
      const list = paymentsByShift.get(row.cash_shift_id) ?? [];
      list.push({ amount: Number(row.amount), method_code: row.method_code });
      paymentsByShift.set(row.cash_shift_id, list);
    }
  }

  const historyCountMaps = await fetchCountTotals(
    db,
    rows.map((row) => row.id),
  );
  const historyClosedIds = rows.filter((row) => row.status === "cerrado").map((row) => row.id);
  const historyReviews = await getShiftReviews(sedeId, historyClosedIds);
  const historyPayoutMaps = await fetchPayoutTotals(
    db,
    rows.map((row) => row.id),
  );
  const historyVoucherOutMaps = await fetchVoucherOutTotals(
    db,
    rows.map((row) => row.id),
  );
  const historyInvoicePayMaps = await fetchInvoicePaymentsByShift(
    db,
    rows.map((row) => row.id),
  );
  const historyRecountMaps = await fetchRecounts(
    db,
    rows.map((row) => row.id),
  );
  const historyNames = await userNames(db, [
    ...rows.flatMap((row) => [row.opened_by, row.closed_by]),
    ...[...historyRecountMaps.values()].map((row) => row.recounted_by),
  ]);

  return {
    desde,
    hasta,
    page,
    pageSize: HISTORY_PAGE_SIZE,
    total,
    shifts: rows.map((shift) => {
      // T0-a (C1): `payments` sin factura + `invoice_payments` del turno.
      const list = mergeShiftMoney(paymentsByShift.get(shift.id), historyInvoicePayMaps.get(shift.id));
      const paidByMethod = sumShiftMoneyByMethod(list);
      const counts = historyCountMaps.get(shift.id) ?? {
        open: new Map<string, number>(),
        closed: new Map<string, number>(),
        recount: new Map<string, number>(),
      };
      const recountRow = historyRecountMaps.get(shift.id) ?? null;
      const { metodos, declarados, diferencias } = buildMethodViews({
        paid: paidByMethod,
        open: counts.open,
        paidOut: sumMethodMaps(historyPayoutMaps.get(shift.id), historyVoucherOutMaps.get(shift.id)),
        closed:
          shift.status === "cerrado" ? (recountRow ? counts.recount : counts.closed) : null,
      });
      const revision = assembleShiftRevision(
        historyReviews.get(shift.id) ?? [],
        diferencias.length > 0,
      );
      return {
        shift,
        ventas: roundMoney(list.reduce((acc, row) => acc + row.amount, 0)),
        efectivo: roundMoney(
          list.filter((row) => row.method_code === "efectivo").reduce((acc, row) => acc + row.amount, 0),
        ),
        vales: sumMethodTotal(historyVoucherOutMaps.get(shift.id)),
        metodos,
        declarados,
        diferencias,
        revision,
        recount: recountRow
          ? recountView(recountRow, historyNames.get(recountRow.recounted_by) ?? null)
          : null,
        vigente: governingClose(shift, recountRow ? recountAmounts(recountRow) : null),
        abierto_por: historyNames.get(shift.opened_by) ?? null,
        cerrado_por: shift.closed_by ? (historyNames.get(shift.closed_by) ?? null) : null,
      };
    }),
  };
}
