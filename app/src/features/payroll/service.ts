import {
  approveVoucherSchema,
  assertDraftPeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeDetail,
  calculatePayrollSchema,
  canDiscountVoucher,
  canReviewVoucher,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeLineCommission,
  computeNetPay,
  generateApprovalCode,
  normalizeAllowedDays,
  openPeriodSchema,
  payPayrollItemSchema,
  requestVoucherSchema,
  rejectVoucherSchema,
  requiresVoucherApproval,
  voucherRequiresReview,
  roundMoney,
  voucherLimitsSchema,
  weekStartOf,
  type CalculatePayrollInput,
  type DetailLine,
  type OpenPeriodInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import {
  AdminError,
  getEmployee,
  listEmployees,
  listPaymentMethods,
} from "@/src/features/admin/service";

export class PayrollError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PayrollError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function payrollDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

type DbClient = Awaited<ReturnType<typeof payrollDb>>;

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Escritura contable: solo admin (periodos, cálculo, cierre, vales, topes). */
const ADMIN_ROLES: RoleCode[] = ["admin"];
/** Pagos de nómina: admin y caja (igual que los cobros de caja en T6). */
const PAYER_ROLES: RoleCode[] = ["admin", "caja"];

export interface PayrollActor {
  userId: string;
  sedeId: string;
  roles?: RoleCode[];
}

/**
 * §10 Nómina/vales: escritura solo admin de su sede (las rutas y actions
 * aplican este gate; el pago de ítems admite también caja vía
 * requirePayrollPayer).
 */
export async function requirePayrollAdmin(
  token: string | null | undefined,
): Promise<PayrollActor> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new PayrollError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  try {
    requireSedeRole(session.roles, ADMIN_ROLES);
  } catch (error) {
    if (error instanceof AdminError) {
      throw new PayrollError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!session.user.sede_id) {
    throw new PayrollError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

/** PAY-04: pagar un ítem admite admin y caja (el turno/caja lo respalda). */
export async function requirePayrollPayer(
  token: string | null | undefined,
): Promise<PayrollActor> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new PayrollError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  try {
    requireSedeRole(session.roles, PAYER_ROLES);
  } catch (error) {
    if (error instanceof AdminError) {
      throw new PayrollError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!session.user.sede_id) {
    throw new PayrollError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

function toPayrollError(error: unknown): PayrollError {
  if (error instanceof PayrollError) return error;
  if (error instanceof AdminError) {
    return new PayrollError(error.code, error.message, error.status);
  }
  if (error instanceof Error) {
    switch (error.message) {
      case "PERIOD_CLOSED":
        return new PayrollError(
          "PERIOD_CLOSED",
          "El periodo está cerrado y es inmutable. No admite cambios.",
          409,
        );
      case "OVERPAID":
        return new PayrollError(
          "OVERPAID",
          "Las porciones superan el neto del ítem.",
          422,
        );
      case "SUM_MISMATCH":
        return new PayrollError(
          "SUM_MISMATCH",
          "Las porciones de pago deben sumar exactamente el neto del ítem.",
          422,
        );
    }
  }
  return new PayrollError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------- filas ---

export interface PayrollPeriodRow {
  id: string;
  sede_id: string;
  start_date: string;
  end_date: string;
  status: string;
  created_by: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface PayrollItemRow {
  id: string;
  period_id: string;
  employee_id: string;
  base_fixed: number;
  commissions: number;
  bonuses: number;
  deductions_vales: number;
  other_discounts: number;
  net_pay: number;
  detail_json: DetailLine[];
  created_at: string;
}

export interface PayrollPaymentRow {
  id: string;
  payroll_item_id: string;
  method_id: string | null;
  method_code: string;
  amount: number;
  paid_at: string;
  paid_by: string | null;
  reference: string | null;
}

export interface VoucherSettingsRow {
  sede_id: string;
  max_per_day: number;
  max_per_week: number;
  /** Días ISO permitidos (1=lunes…7=domingo); null = todos (sin restricción). */
  allowed_days: number[] | null;
}

export interface VoucherRequestRow {
  id: string;
  sede_id: string;
  employee_id: string;
  amount: number;
  request_date: string;
  status: string;
  approved_by: string | null;
  approval_code: string | null;
  observation: string | null;
}

const PERIOD_SELECT =
  "id, sede_id, start_date, end_date, status, created_by, closed_at, created_at";
const ITEM_SELECT =
  "id, period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json, created_at";
const PAYMENT_SELECT =
  "id, payroll_item_id, method_id, method_code, amount, paid_at, paid_by, reference";
const VOUCHER_SELECT =
  "id, sede_id, employee_id, amount, request_date, status, approved_by, approval_code, observation";

// ----------------------------------------------------------------- periodos ---

/**
 * PAY-01: abre un periodo borrador por sede y rango. El índice parcial
 * uq_payroll_draft_per_range es la barrera final ante carreras (23505 →
 * mismo error de negocio).
 */
export async function openPayrollPeriod(raw: unknown, actor: PayrollActor): Promise<PayrollPeriodRow> {
  const parsed = openPeriodSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: OpenPeriodInput = parsed.data;
  const db = await payrollDb();
  try {
    const { data, error } = await db
      .from("payroll_periods")
      .insert({
        sede_id: actor.sedeId,
        start_date: input.start_date,
        end_date: input.end_date,
        status: "borrador",
        created_by: actor.userId,
      })
      .select(PERIOD_SELECT)
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new PayrollError(
          "PERIOD_DRAFT_EXISTS",
          "Ya existe un borrador para esta sede y rango de fechas.",
          409,
        );
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    if (!data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    return data as PayrollPeriodRow;
  } catch (error) {
    throw toPayrollError(error);
  }
}

/** Lista los periodos de la sede (más recientes primero, máx. 20). */
export async function listPeriods(sedeId: string): Promise<PayrollPeriodRow[]> {
  const db = await payrollDb();
  const { data, error } = await db
    .from("payroll_periods")
    .select(PERIOD_SELECT)
    .eq("sede_id", sedeId)
    .order("start_date", { ascending: false })
    .limit(20);
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as PayrollPeriodRow[];
}

async function getPeriodOrThrow(db: DbClient, sedeId: string, id: string): Promise<PayrollPeriodRow> {
  const { data, error } = await db
    .from("payroll_periods")
    .select(PERIOD_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) throw new PayrollError("NOT_FOUND", "Periodo no encontrado.", 404);
  const row = data as PayrollPeriodRow;
  try {
    resolveSede(sedeId, row.sede_id);
  } catch (error) {
    throw toPayrollError(error);
  }
  return row;
}

export interface PeriodDetail {
  period: PayrollPeriodRow;
  items: Array<PayrollItemRow & { paid: number; remaining: number }>;
}

/**
 * PAY-02/PAY-04: periodo con sus ítems y el saldo de cada uno
 * (pagado = suma de porciones, restante = neto − pagado).
 */
export async function getPeriodDetail(sedeId: string, id: string): Promise<PeriodDetail> {
  const db = await payrollDb();
  const period = await getPeriodOrThrow(db, sedeId, id);
  const { data: items, error: itemsError } = await db
    .from("payroll_items")
    .select(ITEM_SELECT)
    .eq("period_id", id)
    .order("created_at");
  if (itemsError) throw new PayrollError("INTERNAL", "Error interno.", 500);
  const rows = (items ?? []) as PayrollItemRow[];
  let paidByItem = new Map<string, number>();
  if (rows.length > 0) {
    const { data: payments, error: paymentsError } = await db
      .from("payroll_payments")
      .select("payroll_item_id, amount")
      .in(
        "payroll_item_id",
        rows.map((row) => row.id),
      );
    if (paymentsError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    paidByItem = new Map();
    for (const row of (payments ?? []) as Array<{ payroll_item_id: string; amount: number | string }>) {
      paidByItem.set(
        row.payroll_item_id,
        roundMoney((paidByItem.get(row.payroll_item_id) ?? 0) + Number(row.amount)),
      );
    }
  }
  return {
    period,
    items: rows.map((item) => {
      const paid = paidByItem.get(item.id) ?? 0;
      return { ...item, paid, remaining: roundMoney(Math.max(0, Number(item.net_pay) - paid)) };
    }),
  };
}

// ------------------------------------------------------------------ cálculo ---

interface BillingLine {
  invoice_id: string;
  consecutive_number: number | null;
  item_id: string;
  item_type: string;
  employee_id: string;
  qty: number;
  unit_price: number;
  line_subtotal: number;
  commission_value: number | null;
}

/**
 * PAY-02/PAY-03/PAY-07: calcula (o recalcula) el borrador.
 *
 * Por empleado activo de la sede: fijo según pay_type (fijo/mixto cobran
 * salary_fixed) + comisiones desde invoice_items del rango por employee_id
 * (solo facturas no anuladas de la sede, con detail_json por factura/ítem)
 * + bonos − vales pendientes/aprobados del rango (que pasan a descontada)
 * − otros = neto. Recalcular reproduce el mismo neto con los mismos
 * insumos. Periodo cerrado → PERIOD_CLOSED.
 */
export async function calculatePayroll(
  sedeId: string,
  periodId: string,
  raw: unknown,
  actor: PayrollActor,
): Promise<PeriodDetail> {
  const parsed = calculatePayrollSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: CalculatePayrollInput = parsed.data;
  const db = await payrollDb();
  try {
    const period = await getPeriodOrThrow(db, sedeId, periodId);
    try {
      assertDraftPeriod(period.status);
    } catch (error) {
      throw toPayrollError(error);
    }

    // El cálculo cubre toda la planta activa: límite explícito amplio
    // (la UI lista con el límite por defecto de 50).
    const employees = await listEmployees(sedeId, 500).catch((error) => {
      throw toPayrollError(error);
    });
    const actives = employees.filter((row) => row.is_active);

    // Facturas vigentes de la sede en el rango (Anulada excluida).
    const { data: invoices, error: invoicesError } = await db
      .from("invoices")
      .select("id, consecutive_number")
      .eq("sede_id", sedeId)
      .neq("status", "Anulada")
      .gte("created_at", `${period.start_date}T00:00:00`)
      .lte("created_at", `${period.end_date}T23:59:59.999`)
      .limit(2000);
    if (invoicesError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const invoiceRows = (invoices ?? []) as Array<{ id: string; consecutive_number: number }>;
    const consecutiveByInvoice = new Map(invoiceRows.map((row) => [row.id, row.consecutive_number]));

    let lines: BillingLine[] = [];
    if (invoiceRows.length > 0) {
      const { data: items, error: itemsError } = await db
        .from("invoice_items")
        .select("id, invoice_id, item_type, employee_id, qty, unit_price, subtotal, no_commission, commission_value")
        .in(
          "invoice_id",
          invoiceRows.map((row) => row.id),
        )
        .limit(5000);
      if (itemsError) throw new PayrollError("INTERNAL", "Error interno.", 500);
      lines = (((items ?? []) as Array<{
        id: string;
        invoice_id: string;
        item_type: string;
        employee_id: string | null;
        qty: number | string;
        unit_price: number | string;
        subtotal: number | string;
        no_commission?: boolean | null;
        commission_value?: number | null;
      }>).filter(
        (
          row,
        ): row is {
          id: string;
          invoice_id: string;
          item_type: string;
          employee_id: string;
          qty: number | string;
          unit_price: number | string;
          subtotal: number | string;
          no_commission?: boolean | null;
          commission_value?: number | null;
        } => Boolean(row.employee_id) && !row.no_commission,
      )).map((row) => ({
        invoice_id: row.invoice_id,
        consecutive_number: consecutiveByInvoice.get(row.invoice_id) ?? null,
        item_id: row.id,
        item_type: row.item_type,
        employee_id: row.employee_id,
        qty: Number(row.qty),
        unit_price: Number(row.unit_price),
        line_subtotal: Number(row.subtotal),
        commission_value: row.commission_value ? Number(row.commission_value) : null,
      }));
    }
    const linesByEmployee = new Map<string, BillingLine[]>();
    for (const line of lines) {
      const list = linesByEmployee.get(line.employee_id) ?? [];
      list.push(line);
      linesByEmployee.set(line.employee_id, list);
    }

    // Vales pendientes/aprobados del rango (se descuentan y marcan).
    const { data: vouchers, error: vouchersError } = await db
      .from("voucher_requests")
      .select("id, employee_id, amount, status")
      .eq("sede_id", sedeId)
      .in("status", ["pendiente", "aprobada"])
      .gte("request_date", period.start_date)
      .lte("request_date", period.end_date)
      .limit(2000);
    if (vouchersError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const voucherRows = (vouchers ?? []) as Array<{
      id: string;
      employee_id: string;
      amount: number | string;
      status: string;
    }>;
    const valesByEmployee = new Map<string, { total: number; ids: string[] }>();
    for (const row of voucherRows) {
      if (!canDiscountVoucher(row.status)) continue;
      const entry = valesByEmployee.get(row.employee_id) ?? { total: 0, ids: [] };
      entry.total = roundMoney(entry.total + Number(row.amount));
      entry.ids.push(row.id);
      valesByEmployee.set(row.employee_id, entry);
    }

    const adjustments = new Map(
      input.adjustments.map((row) => [row.employee_id, row]),
    );

    // Inmediato ya pagado por (factura×empleado) en este rango: se resta
    // para no pagar doble. Tope acumulado (ganado − pagado, nunca negativo).
    const paidImmediateByEmployee = new Map<string, number>();
    if (invoiceRows.length > 0) {
      const { data: payouts } = await db
        .from("commission_payouts")
        .select("employee_id, amount")
        .eq("sede_id", sedeId)
        .in(
          "invoice_id",
          invoiceRows.map((row) => row.id),
        )
        .limit(5000);
      for (const row of ((payouts ?? []) as Array<{ employee_id: string; amount: number | string }>)) {
        paidImmediateByEmployee.set(
          row.employee_id,
          roundMoney((paidImmediateByEmployee.get(row.employee_id) ?? 0) + Number(row.amount)),
        );
      }
    }

    const payload = actives.map((employee) => {
      const isNoAplica = (employee as { payout_mode?: string }).payout_mode === "no_aplica";
      const employeeLines = isNoAplica ? [] : (linesByEmployee.get(employee.id) ?? []);
      const percent =
        isNoAplica || (employee.pay_type !== "porcentaje" && employee.pay_type !== "mixto")
          ? null
          : Number(employee.commission_percent ?? 0);
      const baseFixed =
        employee.pay_type === "fijo" || employee.pay_type === "mixto"
          ? roundMoney(Number(employee.salary_fixed ?? 0))
          : 0;
      // Fijo: sin reporte de comisiones (alterno F3).
      const detailInput: DetailLine[] =
        percent === null
          ? []
          : employeeLines.map((line) => ({
              employee_id: employee.id,
              invoice_id: line.invoice_id,
              consecutive_number: line.consecutive_number,
              item_id: line.item_id,
              item_type: line.item_type,
              qty: line.qty,
              unit_price: line.unit_price,
              line_subtotal: roundMoney(line.line_subtotal),
              // Para items custom, la comisión es un VALOR fijo del ítem;
              // para productos/servicios, porcentaje del empleado.
              commission: line.item_type === "custom" && line.commission_value !== null
                ? roundMoney(line.commission_value)
                : computeLineCommission(line.line_subtotal, percent),
              commission_value: line.commission_value,
            }));
      const { detail, commissions: earnedCommissions } = buildEmployeeDetail(detailInput);
      const paidImmediate = paidImmediateByEmployee.get(employee.id) ?? 0;
      const commissions = roundMoney(Math.max(0, earnedCommissions - paidImmediate));
      const adjustment = adjustments.get(employee.id);
      const bonuses = roundMoney(adjustment?.bonuses ?? 0);
      const otherDiscounts = roundMoney(adjustment?.other_discounts ?? 0);
      const vales = valesByEmployee.get(employee.id)?.total ?? 0;
      const net = computeNetPay({
        baseFixed,
        commissions,
        bonuses,
        vales,
        otherDiscounts,
      });
      return {
        period_id: period.id,
        employee_id: employee.id,
        base_fixed: baseFixed,
        commissions,
        bonuses,
        deductions_vales: roundMoney(vales),
        other_discounts: otherDiscounts,
        net_pay: net,
        detail_json: detail,
      };
    });

    if (payload.length > 0) {
      const { error: upsertError } = await db
        .from("payroll_items")
        .upsert(payload, { onConflict: "period_id,employee_id" });
      if (upsertError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    }

    // PAY-07: los vales descontados pasan a descontada (transición única;
    // descontada es terminal, doble descuento imposible).
    const discountedIds = [...valesByEmployee.values()].flatMap((entry) => entry.ids);
    if (discountedIds.length > 0) {
      const { error: discountError } = await db
        .from("voucher_requests")
        .update({ status: "descontada" })
        .in("id", discountedIds)
        .in("status", ["pendiente", "aprobada"]);
      if (discountError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    }

    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.PAYROLL_CALCULATED,
      entity: "payroll_periods",
      entity_id: periodId,
      metadata: {
        employees: payload.length,
        vales_descontados: discountedIds.length,
      },
    });
    return getPeriodDetail(sedeId, periodId);
  } catch (error) {
    throw toPayrollError(error);
  }
}

// -------------------------------------------------------------------- pagos ---

async function getItemOrThrow(db: DbClient, sedeId: string, id: string): Promise<PayrollItemRow> {
  const { data, error } = await db
    .from("payroll_items")
    .select(ITEM_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) throw new PayrollError("NOT_FOUND", "Ítem de nómina no encontrado.", 404);
  const item = data as PayrollItemRow;
  // La sede se verifica vía el periodo (el ítem hereda su sede).
  await getPeriodOrThrow(db, sedeId, item.period_id);
  return item;
}

/**
 * PAY-04: paga un ítem en porciones por método (métodos activos de la
 * sede, montos > 0). Acepta abonos parciales (40% + 40% + 20% en una o
 * varias llamadas); el acumulado nunca excede el neto (además del trigger
 * trg_payroll_payments_cap). Periodo cerrado → PERIOD_CLOSED.
 * Solo admin/caja (vía requirePayrollPayer en rutas/actions).
 */
export async function payPayrollItem(
  sedeId: string,
  itemId: string,
  raw: unknown,
  actor: PayrollActor,
): Promise<{ item: PayrollItemRow; paid: number; remaining: number; payments: PayrollPaymentRow[] }> {
  const parsed = payPayrollItemSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    const item = await getItemOrThrow(db, sedeId, itemId);
    const period = await getPeriodOrThrow(db, sedeId, item.period_id);
    try {
      assertDraftPeriod(period.status);
    } catch (error) {
      throw toPayrollError(error);
    }

    const methods = await listPaymentMethods(sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    const activeByCode = new Map(methods.filter((row) => row.is_active).map((row) => [row.code, row]));
    for (const portion of parsed.data.portions) {
      if (!activeByCode.has(portion.method_code)) {
        throw new PayrollError(
          "METHOD_INACTIVE",
          `El método de pago ${portion.method_code} no está activo en esta sede.`,
          422,
        );
      }
    }

    const { data: existing, error: existingError } = await db
      .from("payroll_payments")
      .select("amount")
      .eq("payroll_item_id", itemId);
    if (existingError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const alreadyPaid = roundMoney(
      ((existing ?? []) as Array<{ amount: number | string }>).reduce(
        (acc, row) => acc + Number(row.amount),
        0,
      ),
    );
    const net = roundMoney(Number(item.net_pay));
    const incoming = roundMoney(parsed.data.portions.reduce((acc, row) => acc + Number(row.amount), 0));
    try {
      assertNoOverpay({ alreadyPaid, newAmount: incoming, netPay: net });
    } catch (error) {
      throw toPayrollError(error);
    }

    const { data: inserted, error: insertError } = await db
      .from("payroll_payments")
      .insert(
        parsed.data.portions.map((portion) => ({
          payroll_item_id: itemId,
          method_id: activeByCode.get(portion.method_code)?.id ?? null,
          method_code: portion.method_code,
          amount: roundMoney(Number(portion.amount)),
          paid_by: actor.userId,
          reference: portion.reference?.trim() || null,
        })),
      )
      .select(PAYMENT_SELECT);
    if (insertError) {
      // Carrera perdida contra trg_payroll_payments_cap.
      if ((insertError as { code?: string }).code === "P0001") {
        throw new PayrollError("OVERPAID", "Las porciones superan el neto del ítem.", 422);
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    const paid = roundMoney(alreadyPaid + incoming);
    return {
      item,
      paid,
      remaining: roundMoney(Math.max(0, net - paid)),
      payments: (inserted ?? []) as PayrollPaymentRow[],
    };
  } catch (error) {
    throw toPayrollError(error);
  }
}

// ------------------------------------------------------------------- cierre ---

/**
 * PAY-01: cierra el periodo (inmutable: bloquea cálculo, pagos y vales
 * posteriores vía assertDraftPeriod; los vales ya quedaron en descontada
 * al calcular). Solo admin.
 */
export async function closePayrollPeriod(
  sedeId: string,
  periodId: string,
  actor?: { userId: string },
): Promise<PayrollPeriodRow> {
  const db = await payrollDb();
  try {
    const period = await getPeriodOrThrow(db, sedeId, periodId);
    try {
      assertDraftPeriod(period.status);
    } catch (error) {
      throw toPayrollError(error);
    }
    const { data, error } = await db
      .from("payroll_periods")
      .update({ status: "cerrado", closed_at: new Date().toISOString() })
      .eq("id", periodId)
      .select(PERIOD_SELECT)
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    await writeAudit({
      sede_id: sedeId,
      user_id: actor?.userId ?? null,
      action: AUDIT_ACTIONS.PAYROLL_CLOSED,
      entity: "payroll_periods",
      entity_id: periodId,
      metadata: { start_date: period.start_date, end_date: period.end_date },
    });
    return data as PayrollPeriodRow;
  } catch (error) {
    throw toPayrollError(error);
  }
}

// -------------------------------------------------------------------- vales ---

/** PAY-05: topes vigentes de la sede (null cuando aún no se configuran). */
export async function getVoucherSettings(sedeId: string): Promise<VoucherSettingsRow | null> {
  const db = await payrollDb();
  const withDays = await db
    .from("voucher_settings")
    .select("sede_id, max_per_day, max_per_week, allowed_days")
    .eq("sede_id", sedeId)
    .maybeSingle();
  if (!withDays.error) return (withDays.data as VoucherSettingsRow | null) ?? null;
  // La migración 024 aún sin aplicar en esta base: degradar sin días.
  const message = String((withDays.error as { message?: string }).message ?? "");
  if (!/allowed_days/i.test(message)) throw new PayrollError("INTERNAL", "Error interno.", 500);
  const { data, error } = await db
    .from("voucher_settings")
    .select("sede_id, max_per_day, max_per_week")
    .eq("sede_id", sedeId)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) return null;
  return { ...(data as Omit<VoucherSettingsRow, "allowed_days">), allowed_days: null };
}

/** PAY-05: configura topes día/semana + días permitidos de la sede (upsert). Solo admin. */
export async function setVoucherLimits(raw: unknown, actor: PayrollActor): Promise<VoucherSettingsRow> {
  const parsed = voucherLimitsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  // Sin días en el payload se conserva la config vigente (upsert pisa la fila).
  const current = await getVoucherSettings(actor.sedeId).catch(() => null);
  const allowed = parsed.data.allowed_days !== undefined
    ? normalizeAllowedDays(parsed.data.allowed_days)
    : (current?.allowed_days ?? null);
  const first = await db
    .from("voucher_settings")
    .upsert(
      {
        sede_id: actor.sedeId,
        max_per_day: roundMoney(parsed.data.max_per_day),
        max_per_week: roundMoney(parsed.data.max_per_week),
        allowed_days: allowed ?? [1, 2, 3, 4, 5, 6, 7],
      },
      { onConflict: "sede_id" },
    )
    .select("sede_id, max_per_day, max_per_week, allowed_days")
    .single();
  if (!first.error && first.data) return first.data as VoucherSettingsRow;
  // La migración 024 aún sin aplicar en esta base: guardar sin días.
  const firstMessage = String((first.error as { message?: string } | null)?.message ?? "");
  if (!/allowed_days/i.test(firstMessage)) throw new PayrollError("INTERNAL", "Error interno.", 500);
  const { data, error } = await db
    .from("voucher_settings")
    .upsert(
      {
        sede_id: actor.sedeId,
        max_per_day: roundMoney(parsed.data.max_per_day),
        max_per_week: roundMoney(parsed.data.max_per_week),
      },
      { onConflict: "sede_id" },
    )
    .select("sede_id, max_per_day, max_per_week")
    .single();
  if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return { ...(data as Omit<VoucherSettingsRow, "allowed_days">), allowed_days: current?.allowed_days ?? null };
}

/** Vales vigentes (pendiente/aprobada) de un empleado en una fecha. */
async function vigenteTotals(
  db: DbClient,
  sedeId: string,
  employeeId: string,
  requestDate: string,
  settings: VoucherSettingsRow | null,
): Promise<{ dayTotal: number; weekTotal: number }> {
  if (!settings) return { dayTotal: 0, weekTotal: 0 };
  const weekStart = weekStartOf(requestDate);
  const weekEndDate = new Date(`${weekStart}T00:00:00Z`);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);
  const { data, error } = await db
    .from("voucher_requests")
    .select("amount, request_date")
    .eq("sede_id", sedeId)
    .eq("employee_id", employeeId)
    .in("status", ["pendiente", "aprobada"])
    .gte("request_date", weekStart)
    .lte("request_date", weekEnd)
    .limit(1000);
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  let dayTotal = 0;
  let weekTotal = 0;
  for (const row of (data ?? []) as Array<{ amount: number | string; request_date: string }>) {
    weekTotal = roundMoney(weekTotal + Number(row.amount));
    if (row.request_date === requestDate) {
      dayTotal = roundMoney(dayTotal + Number(row.amount));
    }
  }
  return { dayTotal, weekTotal };
}

export interface VoucherRequestResult {
  voucher: VoucherRequestRow;
  requires_approval: boolean;
  over_day: boolean;
  over_week: boolean;
  /** Item 5: la fecha cae fuera de los días permitidos (también exige revisión). */
  day_not_allowed: boolean;
  /** Item 5: el admin quedó auto-aprobado al solicitar (con código y detalle). */
  auto_approved: boolean;
}

/**
 * PAY-05/PAY-06 + item 5: solicita un vale. Valida topes día/semana
 * acumulando los vales vigentes + días permitidos; si excede topes o cae
 * en día no permitido queda pendiente exigiendo revisión del admin
 * (requires_approval + alerta voucher.requested). El admin que solicita
 * queda auto-aprobado con código y detalle auditado. Lo puede pedir
 * cualquier rol autenticado de la sede.
 */
export async function requestVoucher(raw: unknown, actor: PayrollActor): Promise<VoucherRequestResult> {
  const parsed = requestVoucherSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    const employee = await getEmployee(parsed.data.employee_id).catch((error) => {
      throw toPayrollError(error);
    });
    try {
      resolveSede(actor.sedeId, employee.sede_id);
    } catch (error) {
      throw toPayrollError(error);
    }
    const requestDate =
      parsed.data.request_date ?? new Date().toISOString().slice(0, 10);
    const settings = await getVoucherSettings(actor.sedeId);
    const { dayTotal, weekTotal } = await vigenteTotals(
      db,
      actor.sedeId,
      employee.id,
      requestDate,
      settings,
    );
    const eligibility = checkVoucherEligibility({
      dayTotal,
      weekTotal,
      requested: parsed.data.amount,
      maxPerDay: settings ? Number(settings.max_per_day) : null,
      maxPerWeek: settings ? Number(settings.max_per_week) : null,
      requestDate,
      allowedDays: settings?.allowed_days ?? null,
    });
    const needsReview = voucherRequiresReview(eligibility);
    // Item 5: auto-aprobación del admin con código y detalle auditado.
    if ((actor.roles ?? []).includes("admin")) {
      const observation = parsed.data.observation?.trim()
        ? parsed.data.observation.trim()
        : `Auto-aprobado por admin (solicitud propia${eligibility.dayNotAllowed ? ", día no permitido" : ""}${eligibility.overDay || eligibility.overWeek ? ", sobre tope" : ""}).`;
      const { data, error } = await db
        .from("voucher_requests")
        .insert({
          sede_id: actor.sedeId,
          employee_id: employee.id,
          amount: roundMoney(parsed.data.amount),
          request_date: requestDate,
          status: "aprobada",
          approved_by: actor.userId,
          approval_code: generateApprovalCode(),
          observation,
        })
        .select(VOUCHER_SELECT)
        .single();
      if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
      const approved = data as VoucherRequestRow;
      await writeAudit({
        sede_id: actor.sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.VOUCHER_APPROVED,
        entity: "voucher_requests",
        entity_id: approved.id,
        metadata: {
          employee_id: employee.id,
          amount: Number(approved.amount),
          auto: true,
          over_tope: eligibility.overDay || eligibility.overWeek,
          day_not_allowed: eligibility.dayNotAllowed,
          approval_code: approved.approval_code,
        },
      });
      return {
        voucher: approved,
        requires_approval: false,
        over_day: eligibility.overDay,
        over_week: eligibility.overWeek,
        day_not_allowed: eligibility.dayNotAllowed,
        auto_approved: true,
      };
    }
    const { data, error } = await db
      .from("voucher_requests")
      .insert({
        sede_id: actor.sedeId,
        employee_id: employee.id,
        amount: roundMoney(parsed.data.amount),
        request_date: requestDate,
        status: "pendiente",
        observation: parsed.data.observation?.trim() || null,
      })
      .select(VOUCHER_SELECT)
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const created = data as VoucherRequestRow;
    // Item 5: alerta al admin para aceptar/rechazar con motivo.
    if (needsReview) {
      await writeAudit({
        sede_id: actor.sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.VOUCHER_REQUESTED,
        entity: "voucher_requests",
        entity_id: created.id,
        metadata: {
          employee_id: employee.id,
          amount: Number(created.amount),
          request_date: requestDate,
          over_day: eligibility.overDay,
          over_week: eligibility.overWeek,
          day_not_allowed: eligibility.dayNotAllowed,
        },
      });
    }
    return {
      voucher: created,
      requires_approval: needsReview,
      over_day: eligibility.overDay,
      over_week: eligibility.overWeek,
      day_not_allowed: eligibility.dayNotAllowed,
      auto_approved: false,
    };
  } catch (error) {
    throw toPayrollError(error);
  }
}

/** Lista los vales de la sede (filtro opcional por estado/empleado/fecha, máx. 50 recientes). */
export async function listVouchers(
  sedeId: string,
  filters: { status?: string; employee_id?: string; request_date?: string; limit?: number } = {},
): Promise<VoucherRequestRow[]> {
  if (filters.status !== undefined && !["pendiente", "aprobada", "rechazada", "descontada"].includes(filters.status)) {
    throw new PayrollError("VALIDATION", "Estado de filtro inválido.", 400);
  }
  if (filters.request_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(filters.request_date)) {
    throw new PayrollError("VALIDATION", "Fecha inválida (use yyyy-mm-dd).", 400);
  }
  const limit = filters.limit === undefined ? 50 : Math.min(200, Math.max(1, Math.floor(filters.limit)));
  const db = await payrollDb();
  let query = db
    .from("voucher_requests")
    .select(VOUCHER_SELECT)
    .eq("sede_id", sedeId)
    .order("request_date", { ascending: false })
    .limit(limit);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
  if (filters.request_date) query = query.eq("request_date", filters.request_date);
  const { data, error } = await query;
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as VoucherRequestRow[];
}

async function getVoucherOrThrow(db: DbClient, sedeId: string, id: string): Promise<VoucherRequestRow> {
  const { data, error } = await db
    .from("voucher_requests")
    .select(VOUCHER_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) throw new PayrollError("NOT_FOUND", "Vale no encontrado.", 404);
  const row = data as VoucherRequestRow;
  try {
    resolveSede(sedeId, row.sede_id);
  } catch (error) {
    throw toPayrollError(error);
  }
  return row;
}

/**
 * PAY-06: aprueba un vale pendiente con código dinámico básico de 6
 * dígitos (generado por el servidor) + observación opcional. El código es
 * obligatorio cuando el vale supera los topes (se genera siempre al
 * aprobar). Solo admin.
 */
export async function approveVoucher(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: PayrollActor,
): Promise<VoucherRequestRow> {
  const parsed = approveVoucherSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    const voucher = await getVoucherOrThrow(db, sedeId, id);
    // Item 5: edición bloqueada si el vale ya entró en nómina pagada
    // (descontada al liquidar: terminal, con mensaje propio).
    if (voucher.status === "descontada") {
      throw new PayrollError(
        "VOUCHER_IN_PAYROLL",
        "El vale ya entró en nómina (descontada) y no admite cambios.",
        409,
      );
    }
    if (!canReviewVoucher(voucher.status)) {
      throw new PayrollError(
        "VOUCHER_IMMUTABLE",
        "Solo un vale pendiente puede aprobarse.",
        409,
      );
    }
    const observation = parsed.data.observation?.trim()
      ? parsed.data.observation.trim()
      : voucher.observation;
    const { data, error } = await db
      .from("voucher_requests")
      .update({
        status: "aprobada",
        approved_by: actor.userId,
        approval_code: generateApprovalCode(),
        observation,
      })
      .eq("id", id)
      .select(VOUCHER_SELECT)
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const approved = data as VoucherRequestRow;
    // T8: marca si el vale superó topes (reproduce el chequeo de solicitud
    // descontando el propio vale del acumulado vigente que lo incluye).
    let overTope = false;
    try {
      const settings = await getVoucherSettings(sedeId);
      const totals = await vigenteTotals(db, sedeId, voucher.employee_id, voucher.request_date, settings);
      const amount = Number(voucher.amount);
      const caps = checkVoucherCaps({
        dayTotal: totals.dayTotal - amount,
        weekTotal: totals.weekTotal - amount,
        requested: amount,
        maxPerDay: settings ? Number(settings.max_per_day) : null,
        maxPerWeek: settings ? Number(settings.max_per_week) : null,
      });
      overTope = requiresVoucherApproval(caps);
    } catch {
      overTope = false;
    }
    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.VOUCHER_APPROVED,
      entity: "voucher_requests",
      entity_id: id,
      metadata: {
        employee_id: voucher.employee_id,
        amount: Number(voucher.amount),
        over_tope: overTope,
        approval_code: approved.approval_code,
      },
    });
    return approved;
  } catch (error) {
    throw toPayrollError(error);
  }
}

/**
 * PAY-06 + item 5: rechaza un vale pendiente con motivo obligatorio (queda
 * en observation + auditoría voucher.rejected). Rechazada es terminal y
 * descontada (en nómina) no admite cambios. Solo admin.
 */
export async function rejectVoucher(
  sedeId: string,
  id: string,
  raw: unknown,
  actor?: { userId: string },
): Promise<VoucherRequestRow> {
  const parsed = rejectVoucherSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    const voucher = await getVoucherOrThrow(db, sedeId, id);
    // Item 5: edición bloqueada si el vale ya entró en nómina pagada.
    if (voucher.status === "descontada") {
      throw new PayrollError(
        "VOUCHER_IN_PAYROLL",
        "El vale ya entró en nómina (descontada) y no admite cambios.",
        409,
      );
    }
    if (!canReviewVoucher(voucher.status)) {
      throw new PayrollError(
        "VOUCHER_IMMUTABLE",
        "Solo un vale pendiente puede rechazarse.",
        409,
      );
    }
    const { data, error } = await db
      .from("voucher_requests")
      .update({ status: "rechazada", observation: parsed.data.motivo.trim() })
      .eq("id", id)
      .select(VOUCHER_SELECT)
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    await writeAudit({
      sede_id: sedeId,
      user_id: actor?.userId ?? null,
      action: AUDIT_ACTIONS.VOUCHER_REJECTED,
      entity: "voucher_requests",
      entity_id: id,
      metadata: {
        employee_id: voucher.employee_id,
        amount: Number(voucher.amount),
        motivo: parsed.data.motivo.trim(),
      },
    });
    return data as VoucherRequestRow;
  } catch (error) {
    throw toPayrollError(error);
  }
}

// Re-export puro usado por rutas/UI para el mensaje de suma exacta.
export { assertPortionsMatchNet };
