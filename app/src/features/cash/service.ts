import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  assertShiftCloser,
  buildMethodViews,
  closeShiftSchema,
  computeCashClose,
  dayBounds,
  dayViewSchema,
  expectedDigitalTotal,
  HISTORY_PAGE_SIZE,
  historySchema,
  openShiftSchema,
  rangeBounds,
  registerPaymentSchema,
  resolveClosingBase,
  resolveOpeningBase,
  roundMoney,
  moneyEquals,
  type CloseShiftInput,
  type DayTotals,
  type MethodDifference,
  type OpenShiftInput,
  type RegisterPaymentInput,
  type ShiftCountInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import {
  listPaymentMethods,
  AdminError,
} from "@/src/features/admin/service";
import { BillingError, getInvoiceDetail } from "@/src/features/billing/service";
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
  phase: "apertura" | "cierre";
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
 * Totales por método de los conteos de varios turnos, separados por fase.
 * Base del esperado digital acumulativo (apertura + cobrado).
 */
async function fetchCountTotals(
  db: DbClient,
  shiftIds: string[],
): Promise<Map<string, { open: Map<string, number>; closed: Map<string, number> }>> {
  const result = new Map<string, { open: Map<string, number>; closed: Map<string, number> }>();
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
    const entry = result.get(row.shift_id) ?? { open: new Map(), closed: new Map() };
    const target = row.phase === "apertura" ? entry.open : entry.closed;
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

async function insertCounts(
  db: DbClient,
  shiftId: string,
  phase: "apertura" | "cierre",
  counts: ShiftCountInput[],
): Promise<void> {  const rows = counts.map((line) => ({
    shift_id: shiftId,
    phase,
    method_code: line.method_code,
    denomination: line.denomination ?? null,
    quantity: line.quantity,
    amount: roundMoney(line.amount),
  }));
  const { error } = await db.from("cash_shift_counts").insert(rows);
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
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
  const { data: counts, error: countsError } = await db
    .from("cash_shift_counts")
    .select("method_code, amount")
    .eq("shift_id", (last as { id: string }).id)
    .eq("phase", "cierre");
  if (countsError) throw new CashError("INTERNAL", "Error interno.", 500);
  const byMethod = new Map<string, number>();
  for (const row of ((counts ?? []) as Array<{ method_code: string; amount: number | string }>)) {
    byMethod.set(row.method_code, roundMoney((byMethod.get(row.method_code) ?? 0) + Number(row.amount)));
  }
  return { baseLeft: (last as { base_left: number | null }).base_left, byMethod, hasCounts: byMethod.size > 0 };
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
  const db = await cashDb();
  const { data, error } = await db
    .from("cash_shifts")
    .select(`${SHIFT_SELECT}, users!inner(full_name)`)
    .eq("sede_id", sedeId)
    .eq("status", "abierto")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new CashError("INTERNAL", "Error interno.", 500);
  if (!data) return null;
  const user = Array.isArray(data.users) ? data.users[0] : data.users;
  return {
    ...(data as CashShiftRow),
    opener_name: user?.full_name ?? null,
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

    const { data: last, error: lastError } = await db
      .from("cash_shifts")
      .select("base_left")
      .eq("cash_register_id", register.id)
      .eq("status", "cerrado")
      .order("closed_at", { ascending: false })
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw new CashError("INTERNAL", "Error interno.", 500);
    const lastBaseLeft = (last as { base_left: number | null } | null)?.base_left ?? null;
    const openingBase = resolveOpeningBase(lastBaseLeft, Number(register.base_configurada));

    // Pre-open count never blocks the operation: cash must match the base
    // the shift opens with (base_left from the last close, or
    // base_configurada on first open); digitals are checked against last
    // close totals only when they exist. Mismatches are recorded and alert
    // administrators (except on the very first open) while the shift opens
    // anyway so the business never stops.
    const declared = await checkCounts(actor.sedeId, input.counts);
    const prev = await previousCloseTotals(db, register.id);
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

    const { data: created, error: createError } = await db
      .from("cash_shifts")
      .insert({
        cash_register_id: register.id,
        sede_id: actor.sedeId,
        opened_by: actor.userId,
        opening_base: openingBase,
        expected_cash: 0,
        status: "abierto",
      })
      .select(SHIFT_SELECT)
      .single();
    if (createError) {
      // Carrera perdida contra uq_cash_shifts_open_per_register.
      if ((createError as { code?: string }).code === "23505") {
        throw new CashError(
          "SHIFT_ALREADY_OPEN",
          "Ya hay un turno abierto en esta caja. Ciérrelo antes de abrir otro.",
          409,
        );
      }
      throw new CashError("INTERNAL", "Error interno.", 500);
    }
    if (!created) throw new CashError("INTERNAL", "Error interno.", 500);
    await insertCounts(db, (created as CashShiftRow).id, "apertura", input.counts);
    // Filed against the created shift (not the register) so the shift's
    // review state can be joined from the day/history views.
    if (mismatches.length > 0 && !isFirstOpen) {
      await writeAudit({
        sede_id: actor.sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.SHIFT_OPEN_MISMATCH,
        entity: "cash_shifts",
        entity_id: (created as CashShiftRow).id,
        metadata: { opening_base: openingBase, mismatches },
      });
    }
    return { shift: created as CashShiftRow, mismatches, firstOpen: isFirstOpen };
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
 * CAJ-02: registra un pago contra el turno abierto (el indicado o el
 * único abierto de la sede). Método activo, monto > 0; si trae
 * invoice_id, la factura debe existir en la sede y no estar Anulada.
 *
 * Consolidación T5 (dual-write): el pago vive en payments (por turno,
 * PRD §9.1) Y se refleja en invoice_payments, así el saldo de la factura
 * (paid/remaining de T5) sigue cuadrando. Si las porciones completan el
 * total, la factura pasa a Pagada y se vincula al turno (cash_shift_id).
 * Solo admin/caja (vía requireCashWriter en rutas/actions).
 */
export async function registerPayment(raw: unknown, actor: CashActor): Promise<PaymentResult> {
  const parsed = registerPaymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: RegisterPaymentInput = parsed.data;
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
    let invoicePaid = 0;
    let invoiceTotal = 0;
    let invoiceShiftId: string | null = null;
    if (input.invoice_id) {
      const detail = await getInvoiceDetail(actor.sedeId, input.invoice_id).catch((error) => {
        throw toCashError(error);
      });
      if (detail.invoice.status === "Anulada") {
        throw new CashError("ANNUL_INVALID", "No se puede cobrar una factura anulada.", 409);
      }
      invoiceStatus = detail.invoice.status;
      invoicePaid = detail.paid;
      invoiceTotal = Number(detail.invoice.total);
      invoiceShiftId = detail.invoice.cash_shift_id;
      const incoming = roundMoney(invoicePaid + input.amount);
      if (incoming - invoiceTotal > 0.009) {
        throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);
      }
    }

    const { data: payment, error: paymentError } = await db
      .from("payments")
      .insert({
        sede_id: actor.sedeId,
        cash_shift_id: shift.id,
        invoice_id: input.invoice_id ?? null,
        method_id: method.id,
        method_code: method.code,
        amount: input.amount,
        user_id: actor.userId,
      })
      .select(PAYMENT_SELECT)
      .single();
    if (paymentError || !payment) throw new CashError("INTERNAL", "Error interno.", 500);

    // Dual-write T5: refleja la porción en invoice_payments (o limpia el
    // pago por turno si falla, best-effort).
    if (input.invoice_id) {
      const { error: mirrorError } = await db.from("invoice_payments").insert({
        invoice_id: input.invoice_id,
        method_id: method.id,
        method_code: method.code,
        amount: input.amount,
      });
      if (mirrorError) {
        await db.from("payments").delete().eq("id", (payment as CashPaymentRow).id);
        throw new CashError("INTERNAL", "Error interno.", 500);
      }
      const paid = roundMoney(invoicePaid + input.amount);
      const updates: Record<string, unknown> = {};
      if (!invoiceShiftId) updates.cash_shift_id = shift.id;
      if (invoiceStatus === "Emitida" && moneyEquals(paid, invoiceTotal)) {
        updates.status = "Pagada";
        invoiceStatus = "Pagada";
      }
      if (Object.keys(updates).length > 0) {
        const { error: updateError } = await db
          .from("invoices")
          .update(updates)
          .eq("id", input.invoice_id);
        if (updateError) throw new CashError("INTERNAL", "Error interno.", 500);
      }
    }

    return {
      payment: payment as CashPaymentRow,
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
 */
export interface CloseShiftResult {
  shift: CashShiftRow;
  methodDifferences: MethodDifference[];
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

    const { data: shiftPayments, error: paymentsError } = await db
      .from("payments")
      .select("amount, method_code")
      .eq("cash_shift_id", shift.id);
    if (paymentsError) throw new CashError("INTERNAL", "Error interno.", 500);
    const paidByMethod = new Map<string, number>();
    for (const row of ((shiftPayments ?? []) as Array<{ amount: number | string; method_code: string }>)) {
      paidByMethod.set(row.method_code, roundMoney((paidByMethod.get(row.method_code) ?? 0) + Number(row.amount)));
    }
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

    const { data: updated, error: updateError } = await db
      .from("cash_shifts")
      .update({
        expected_cash: expectedCash,
        counted_cash: roundMoney(input.counted_cash),
        base_left: roundMoney(baseLeft),
        cash_withdrawn: close.cashWithdrawn,
        base_difference: close.baseDifference,
        observation,
        status: "cerrado",
        closed_at: new Date().toISOString(),
        closed_by: actor.userId,
      })
      .eq("id", shift.id)
      .select(SHIFT_SELECT)
      .single();
    if (updateError || !updated) throw new CashError("INTERNAL", "Error interno.", 500);
    const closed = updated as CashShiftRow;
    await insertCounts(db, shift.id, "cierre", input.counts);
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
        payouts_out: roundMoney([...paidOutByMethod.values()].reduce((acc, value) => acc + value, 0)),
        method_differences: methodDifferences,
        observation: observation ?? null,
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
    return { shift: closed, methodDifferences };
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
 * CASH: edita un turno cerrado (solo admin; el gate vive en actions).
 * Recalcula el sobre y la diferencia; todo cambio queda auditado con
 * los valores anteriores. Los conteos originales no se tocan.
 */
export async function updateClosedShift(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: CashActor,
): Promise<CashShiftRow> {
  const parsed = z.object({
    counted_cash: z.coerce.number().nonnegative().optional(),
    base_left: z.coerce.number().nonnegative().optional(),
    observation: z.string().trim().max(500).nullish(),
  }).safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await cashDb();
  const shift = await getShiftOrThrow(db, sedeId, id);
  if (shift.status !== "cerrado") {
    throw new CashError("VALIDATION", "Solo se editan turnos cerrados.", 400);
  }
  const register = await resolveRegister(db, sedeId, shift.cash_register_id);
  const counted = parsed.data.counted_cash ?? Number(shift.counted_cash);
  const left = parsed.data.base_left ?? Number(shift.base_left);
  const close = computeCashClose({
    countedCash: counted,
    baseLeft: left,
    baseConfigurada: Number(register.base_configurada),
  });
  const observation = parsed.data.observation !== undefined
    ? (parsed.data.observation?.trim() ? parsed.data.observation.trim() : null)
    : shift.observation;
  const { data: updated, error } = await db
    .from("cash_shifts")
    .update({
      counted_cash: roundMoney(counted),
      base_left: roundMoney(left),
      cash_withdrawn: close.cashWithdrawn,
      base_difference: close.baseDifference,
      observation,
    })
    .eq("id", shift.id)
    .select(SHIFT_SELECT)
    .single();
  if (error || !updated) throw new CashError("INTERNAL", "Error interno.", 500);
  await writeAudit({
    sede_id: sedeId,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.SHIFT_EDITED,
    entity: "cash_shifts",
    entity_id: shift.id,
    metadata: {
      previous: { counted_cash: shift.counted_cash, base_left: shift.base_left, observation: shift.observation },
      updated: { counted_cash: roundMoney(counted), base_left: roundMoney(left), observation },
    },
  });
  return updated as CashShiftRow;
}

// -------------------------------------------------------- día e historial ---

export interface DayShiftView {
  shift: CashShiftRow;
  ventas: number;
  efectivo: number;
  /** Cobrado por método en el turno (todos los métodos con movimiento). */
  metodos: Array<{ method_code: string; amount: number }>;
  /** Declarado por método (cierre si está cerrado, apertura si no). */
  declarados: Array<{ method_code: string; amount: number }>;
  /** Diferencias digitales del cierre (vacío en turnos abiertos). */
  diferencias: MethodDifference[];
  /** Revisión de los desajustes del turno (null si no hay). */
  revision: ShiftRevision | null;
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
      );
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
  const names = await userNames(
    db,
    rows.flatMap((row) => [row.opened_by, row.closed_by]),
  );

  const views: DayShiftView[] = rows.map((shift) => {
    const list = paymentsByShift.get(shift.id) ?? [];
    const paidByMethod = new Map<string, number>();
    for (const item of list) {
      paidByMethod.set(item.method_code, roundMoney((paidByMethod.get(item.method_code) ?? 0) + item.amount));
    }
    const counts = countMaps.get(shift.id) ?? { open: new Map(), closed: new Map() };
    const { metodos, declarados, diferencias } = buildMethodViews({
      paid: paidByMethod,
      open: counts.open,
      paidOut: payoutMaps.get(shift.id) ?? new Map<string, number>(),
      closed: shift.status === "cerrado" ? counts.closed : null,
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
      metodos,
      declarados,
      diferencias,
      revision,
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
        countedCash: view.shift.counted_cash,
        baseLeft: view.shift.base_left,
        cashWithdrawn: view.shift.cash_withdrawn,
        baseDifference: view.shift.base_difference,
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
      );
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
  const historyNames = await userNames(
    db,
    rows.flatMap((row) => [row.opened_by, row.closed_by]),
  );

  return {
    desde,
    hasta,
    page,
    pageSize: HISTORY_PAGE_SIZE,
    total,
    shifts: rows.map((shift) => {
      const list = paymentsByShift.get(shift.id) ?? [];
      const paidByMethod = new Map<string, number>();
      for (const item of list) {
        paidByMethod.set(item.method_code, roundMoney((paidByMethod.get(item.method_code) ?? 0) + item.amount));
      }
      const counts = historyCountMaps.get(shift.id) ?? { open: new Map(), closed: new Map() };
      const { metodos, declarados, diferencias } = buildMethodViews({
        paid: paidByMethod,
        open: counts.open,
        paidOut: historyPayoutMaps.get(shift.id) ?? new Map<string, number>(),
        closed: shift.status === "cerrado" ? counts.closed : null,
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
        metodos,
        declarados,
        diferencias,
        revision,
        abierto_por: historyNames.get(shift.opened_by) ?? null,
        cerrado_por: shift.closed_by ? (historyNames.get(shift.closed_by) ?? null) : null,
      };
    }),
  };
}
