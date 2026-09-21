import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  closeShiftSchema,
  computeCashClose,
  dayViewSchema,
  historySchema,
  openShiftSchema,
  registerPaymentSchema,
  resolveOpeningBase,
  roundMoney,
  moneyEquals,
  type CloseShiftInput,
  type DayTotals,
  type OpenShiftInput,
  type RegisterPaymentInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import {
  requireSedeRole,
  resolveSede,
  listPaymentMethods,
  AdminError,
} from "@/src/features/admin/service";
import { BillingError, getInvoiceDetail } from "@/src/features/billing/service";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";

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
 * cierre o base_configurada si es el primero). Rechaza si hay un turno
 * abierto en la caja (además del índice parcial, barrera ante carreras:
 * 23505 → mismo error de negocio).
 */
export async function openShift(raw: unknown, actor: CashActor): Promise<CashShiftRow> {
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
    return created as CashShiftRow;
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
 * CAJ-03/CAJ-04: cierra con arqueo. Conteo (counted_cash) y base dejada
 * obligatorios; expected_cash = efectivo cobrado en el turno; calcula
 * recogido (= contado − base) y diferencia (= base − base configurada).
 * Base incompleta (base_left < base_configurada) exige observación.
 */
export async function closeShift(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: CashActor,
): Promise<CashShiftRow> {
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
    const register = await resolveRegister(db, sedeId, shift.cash_register_id);
    try {
      assertCloseInput({
        countedCash: input.counted_cash,
        baseLeft: input.base_left,
        baseConfigurada: Number(register.base_configurada),
        observation: input.observation,
      });
    } catch (error) {
      throw toCashError(error);
    }

    const { data: shiftPayments, error: paymentsError } = await db
      .from("payments")
      .select("amount, method_code")
      .eq("cash_shift_id", shift.id);
    if (paymentsError) throw new CashError("INTERNAL", "Error interno.", 500);
    const expectedCash = roundMoney(
      ((shiftPayments ?? []) as Array<{ amount: number | string; method_code: string }>)
        .filter((row) => row.method_code === "efectivo")
        .reduce((acc, row) => acc + Number(row.amount), 0),
    );

    const close = computeCashClose({
      countedCash: input.counted_cash,
      baseLeft: input.base_left,
      baseConfigurada: Number(register.base_configurada),
    });
    const observation = input.observation?.trim() ? input.observation.trim() : null;

    const { data: updated, error: updateError } = await db
      .from("cash_shifts")
      .update({
        expected_cash: expectedCash,
        counted_cash: roundMoney(input.counted_cash),
        base_left: roundMoney(input.base_left),
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
    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.SHIFT_CLOSED,
      entity: "cash_shifts",
      entity_id: shift.id,
      metadata: {
        expected_cash: expectedCash,
        counted_cash: roundMoney(input.counted_cash),
        base_left: roundMoney(input.base_left),
        base_configurada: Number(register.base_configurada),
        base_difference: close.baseDifference,
        base_incompleta: close.baseDifference < 0,
        observation: observation ?? null,
      },
    });
    return closed;
  } catch (error) {
    throw toCashError(error);
  }
}

// -------------------------------------------------------- día e historial ---

export interface DayShiftView {
  shift: CashShiftRow;
  ventas: number;
  efectivo: number;
}

export interface DayView {
  fecha: string;
  register: CashRegisterRow | null;
  shifts: DayShiftView[];
  totals: DayTotals;
}

function dayBounds(fecha: string): { from: string; to: string } {
  return { from: `${fecha}T00:00:00`, to: `${fecha}T23:59:59.999` };
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
    .order("opened_at");
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

  const views: DayShiftView[] = rows.map((shift) => {
    const list = paymentsByShift.get(shift.id) ?? [];
    return {
      shift,
      ventas: roundMoney(list.reduce((acc, row) => acc + row.amount, 0)),
      efectivo: roundMoney(
        list.filter((row) => row.method_code === "efectivo").reduce((acc, row) => acc + row.amount, 0),
      ),
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
}

/**
 * CAJ-06: historial de aperturas, movimientos, bases y cierres filtrable
 * por fecha (rango inclusive sobre opened_at, más recientes primero,
 * máx. 50 turnos). La página /cash NO lo trae de entrada: se carga bajo
 * demanda con el filtro (navegación instantánea).
 */
export async function getHistory(sedeId: string, raw: unknown): Promise<HistoryResult> {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) {
    throw new CashError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { desde, hasta } = parsed.data;
  const db = await cashDb();
  const { data: shifts, error } = await db
    .from("cash_shifts")
    .select(SHIFT_SELECT)
    .eq("sede_id", sedeId)
    .gte("opened_at", `${desde}T00:00:00`)
    .lte("opened_at", `${hasta}T23:59:59.999`)
    .order("opened_at", { ascending: false })
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

  return {
    desde,
    hasta,
    shifts: rows.map((shift) => {
      const list = paymentsByShift.get(shift.id) ?? [];
      return {
        shift,
        ventas: roundMoney(list.reduce((acc, row) => acc + row.amount, 0)),
        efectivo: roundMoney(
          list.filter((row) => row.method_code === "efectivo").reduce((acc, row) => acc + row.amount, 0),
        ),
      };
    }),
  };
}
