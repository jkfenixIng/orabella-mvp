import {
  approveVoucherSchema,
  assertDraftPeriod,
  assertDeletablePeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeCommissionDetail,
  buildEmployeeDetail,
  calculatePayrollSchema,
  canDiscountVoucher,
  capPayrollDiscounts,
  canReviewVoucher,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeNetPay,
  normalizeAllowedDays,
  normalizePerDayLimits,
  openPeriodSchema,
  overlapBlocksDeletion,
  payPayrollItemSchema,
  requestVoucherSchema,
  rejectVoucherSchema,
  requiresVoucherApproval,
  resolveVoucherDayCap,
  resolveVoucherInitialStatus,
  restoreVoucherStatus,
  roundMoney,
  voucherApprovalCashOutViolation,
  voucherLimitsSchema,
  weekStartOf,
  type CalculatePayrollInput,
  type DetailLine,
  type OpenPeriodInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { commissionRuleKey, type RuleRate } from "@/src/features/commissions/schemas";
import { cashOutUsedInShift, getOpenShiftWithOpener } from "@/src/features/cash/service";
import { cashOutLimitViolation } from "@/src/features/cash/schemas";
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
      case "PERIOD_NOT_DRAFT":
        return new PayrollError(
          "PERIOD_NOT_DRAFT",
          "Solo se pueden borrar períodos en borrador; este ya está cerrado.",
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
  /** V2: null o 0 = sin tope diario general. */
  max_per_day: number | null;
  /** V2: null o 0 = sin tope semanal. */
  max_per_week: number | null;
  /** Días ISO permitidos (1=lunes…7=domingo); null = todos (sin restricción). */
  allowed_days: number[] | null;
  /** V2: tope propio por día ISO {"3": 50000}; reemplaza al general ese día. */
  per_day_limits: Record<string, number> | null;
}

export interface VoucherRequestRow {
  id: string;
  sede_id: string;
  employee_id: string;
  amount: number;
  request_date: string;
  status: string;
  approved_by: string | null;
  /** Usuario de caja que abrió el vale; null = vale histórico. */
  created_by: string | null;
  /** Método arqueable por el que sale el dinero; null = vale histórico. */
  method_code: string | null;
  /** Turno de caja que abrió el vale; null = vale histórico. */
  cash_shift_id: string | null;
  /** PAY-06: código histórico. Ya no se genera; se conserva la columna. */
  approval_code: string | null;
  observation: string | null;
  /** Nombre de quien abrió el vale (resuelto desde users); null si no disponible. */
  created_by_name: string | null;
  /** Nombre de quien aprobó el vale; null si no hay aprobación o no disponible. */
  approved_by_name: string | null;
}

const PERIOD_SELECT =
  "id, sede_id, start_date, end_date, status, created_by, closed_at, created_at";
const ITEM_SELECT =
  "id, period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json, created_at";
const PAYMENT_SELECT =
  "id, payroll_item_id, method_id, method_code, amount, paid_at, paid_by, reference";
/** Columnas base (migración 007), siempre presentes. */
const VOUCHER_SELECT_BASE =
  "id, sede_id, employee_id, amount, request_date, status, approved_by, approval_code, observation";
/** Columnas de la migración 028 (método y turno), opcionales. */
const VOUCHER_SELECT_METHOD = "method_code, cash_shift_id";
/** Columna de la migración 029 (usuario de caja que abrió el vale), opcional. */
const VOUCHER_SELECT_CREATED_BY = "created_by";

// 028 (method_code/cash_shift_id) y 029 (created_by) pueden no estar aplicadas
// en esta base: cada migración se prueba por separado y se cachea de forma
// independiente, para que la ausencia de una no degrade a la otra. Un error
// distinto de "columna ausente" (red/permisos) NO se cachea, así la consulta
// real lo reporta en vez de degradar en silencio.
let voucherMethodColumns: boolean | null = null;
let voucherCreatedByColumn: boolean | null = null;

async function resolveVoucherSelect(db: DbClient): Promise<string> {
  if (voucherMethodColumns === null) {
    const probe = await db.from("voucher_requests").select("method_code, cash_shift_id").limit(1);
    if (!probe.error) {
      voucherMethodColumns = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/method_code|cash_shift_id/i.test(message)) voucherMethodColumns = false;
    }
  }
  if (voucherCreatedByColumn === null) {
    const probe = await db.from("voucher_requests").select("created_by").limit(1);
    if (!probe.error) {
      voucherCreatedByColumn = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/created_by/i.test(message)) voucherCreatedByColumn = false;
    }
  }
  const columns = [VOUCHER_SELECT_BASE];
  if (voucherMethodColumns !== false) columns.push(VOUCHER_SELECT_METHOD);
  if (voucherCreatedByColumn !== false) columns.push(VOUCHER_SELECT_CREATED_BY);
  return columns.join(", ");
}

/** Rellena columnas opcionales cuando su migración (028/029) no está aplicada. */
function normalizeVoucher(row: Record<string, unknown>): VoucherRequestRow {
  return {
    ...(row as unknown as VoucherRequestRow),
    created_by: (row.created_by as string | null) ?? null,
    method_code: (row.method_code as string | null) ?? null,
    cash_shift_id: (row.cash_shift_id as string | null) ?? null,
    // Los nombres se resuelven aparte (attachVoucherUserNames) solo cuando la
    // fila va al cliente; aquí quedan en null.
    created_by_name: null,
    approved_by_name: null,
  };
}

/**
 * Resuelve los nombres de created_by/approved_by con una segunda query a
 * `users` (sin join embebido: voucher_requests tiene DOS FK a users y PostgREST
 * no las desambigua). Una sola consulta por lote para no caer en N+1.
 */
async function attachVoucherUserNames(
  db: DbClient,
  rows: VoucherRequestRow[],
): Promise<VoucherRequestRow[]> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.created_by) ids.add(row.created_by);
    if (row.approved_by) ids.add(row.approved_by);
  }
  if (ids.size === 0) return rows;
  const { data, error } = await db.from("users").select("id, full_name").in("id", [...ids]);
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  const names = new Map<string, string | null>();
  for (const user of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
    names.set(user.id, user.full_name ?? null);
  }
  return rows.map((row) => ({
    ...row,
    created_by_name: row.created_by ? names.get(row.created_by) ?? null : null,
    approved_by_name: row.approved_by ? names.get(row.approved_by) ?? null : null,
  }));
}

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
  product_id: string | null;
  service_id: string | null;
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
    if (invoicesError) {
      console.error(
        "[payroll] calculatePayroll: fallo al listar facturas:",
        JSON.stringify({
          periodId,
          code: invoicesError.code,
          message: invoicesError.message,
          details: invoicesError.details,
          hint: invoicesError.hint,
        }),
      );
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    const invoiceRows = (invoices ?? []) as Array<{ id: string; consecutive_number: number }>;
    const consecutiveByInvoice = new Map(invoiceRows.map((row) => [row.id, row.consecutive_number]));

    let lines: BillingLine[] = [];
    if (invoiceRows.length > 0) {
      const { data: items, error: itemsError } = await db
        .from("invoice_items")
        .select(
          "id, invoice_id, item_type, employee_id, qty, unit_price, subtotal, no_commission, commission_value, product_id, service_id",
        )
        .in(
          "invoice_id",
          invoiceRows.map((row) => row.id),
        )
        .limit(5000);
      if (itemsError) {
        console.error(
          "[payroll] calculatePayroll: fallo al listar ítems de factura:",
          JSON.stringify({
            periodId,
            invoices: invoiceRows.length,
            code: itemsError.code,
            message: itemsError.message,
            details: itemsError.details,
            hint: itemsError.hint,
          }),
        );
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
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
        product_id: string | null;
        service_id: string | null;
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
          product_id: string | null;
          service_id: string | null;
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
        product_id: row.product_id,
        service_id: row.service_id,
      }));
    }
    const linesByEmployee = new Map<string, BillingLine[]>();
    for (const line of lines) {
      const list = linesByEmployee.get(line.employee_id) ?? [];
      list.push(line);
      linesByEmployee.set(line.employee_id, list);
    }

    // Reglas ítem×empleado activas de la sede (mismos filtros que usa el pago
    // inmediato: sede + empleado + activa). Una sola consulta y se agrupan en
    // memoria para no caer en N+1 sobre la planta activa.
    const rulesByEmployee = new Map<string, Map<string, RuleRate>>();
    if (actives.length > 0) {
      const { data: rules, error: rulesError } = await db
        .from("commission_rules")
        .select("employee_id, item_type, item_id, percent, amount")
        .eq("sede_id", sedeId)
        .eq("is_active", true)
        .in(
          "employee_id",
          actives.map((employee) => employee.id),
        )
        .limit(5000);
      if (rulesError) {
        console.error(
          "[payroll] calculatePayroll: fallo al listar reglas de comisión:",
          JSON.stringify({
            periodId,
            employees: actives.length,
            code: rulesError.code,
            message: rulesError.message,
            details: rulesError.details,
            hint: rulesError.hint,
          }),
        );
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
      for (const rule of (rules ?? []) as Array<{
        employee_id: string;
        item_type: string;
        item_id: string;
        percent: number | string | null;
        amount: number | string | null;
      }>) {
        const byItem = rulesByEmployee.get(rule.employee_id) ?? new Map<string, RuleRate>();
        byItem.set(commissionRuleKey(rule.item_type, rule.item_id), {
          percent: rule.percent != null ? Number(rule.percent) : null,
          amount: rule.amount != null ? Number(rule.amount) : null,
        });
        rulesByEmployee.set(rule.employee_id, byItem);
      }
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
    if (vouchersError) {
      console.error(
        "[payroll] calculatePayroll: fallo al listar vales del periodo:",
        JSON.stringify({
          periodId,
          code: vouchersError.code,
          message: vouchersError.message,
          details: vouchersError.details,
          hint: vouchersError.hint,
        }),
      );
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
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
      const baseFixed =
        employee.pay_type === "fijo" || employee.pay_type === "mixto"
          ? roundMoney(Number(employee.salary_fixed ?? 0))
          : 0;
      // Misma resolución por línea que el pago inmediato: la regla ítem×empleado
      // gana sobre el porcentaje plano. Un `fijo` con regla sí comisiona; un
      // `fijo` sin reglas sigue sin detalle (comisión 0). `no_aplica` no entra.
      const detailInput: DetailLine[] = buildEmployeeCommissionDetail({
        employeeId: employee.id,
        payoutMode: employee.payout_mode,
        payType: employee.pay_type,
        commissionPercent: employee.commission_percent,
        lines: (linesByEmployee.get(employee.id) ?? []).map((line) => ({
          invoice_id: line.invoice_id,
          consecutive_number: line.consecutive_number,
          item_id: line.item_id,
          item_type: line.item_type,
          qty: line.qty,
          unit_price: line.unit_price,
          line_subtotal: line.line_subtotal,
          commission_value: line.commission_value,
          item_ref_id:
            line.item_type === "producto"
              ? line.product_id
              : line.item_type === "servicio"
                ? line.service_id
                : null,
        })),
        rules: rulesByEmployee.get(employee.id) ?? new Map<string, RuleRate>(),
      });
      const { detail, commissions: earnedCommissions } = buildEmployeeDetail(detailInput);
      const paidImmediate = paidImmediateByEmployee.get(employee.id) ?? 0;
      const commissions = roundMoney(Math.max(0, earnedCommissions - paidImmediate));
      const adjustment = adjustments.get(employee.id);
      const bonuses = roundMoney(adjustment?.bonuses ?? 0);
      const otherDiscounts = roundMoney(adjustment?.other_discounts ?? 0);
      const vales = valesByEmployee.get(employee.id)?.total ?? 0;
      // El neto nunca queda negativo: si vales + otros supera el bruto, el
      // descuento efectivo se topa al bruto para que el neto persistido (0)
      // sea consistente con el CHECK de payroll_items
      // (neto = bruto − vales − otros). El exceso se absorbe, no se arrastra
      // como deuda; el recorte va primero a other_discounts y luego a vales.
      const applied = capPayrollDiscounts({
        gross: roundMoney(baseFixed + commissions + bonuses),
        vales,
        otherDiscounts,
      });
      const net = computeNetPay({
        baseFixed,
        commissions,
        bonuses,
        vales: applied.vales,
        otherDiscounts: applied.otherDiscounts,
      });
      return {
        period_id: period.id,
        employee_id: employee.id,
        base_fixed: baseFixed,
        commissions,
        bonuses,
        deductions_vales: applied.vales,
        other_discounts: applied.otherDiscounts,
        net_pay: net,
        detail_json: detail,
      };
    });

    if (payload.length > 0) {
      const { error: upsertError } = await db
        .from("payroll_items")
        .upsert(payload, { onConflict: "period_id,employee_id" });
      if (upsertError) {
        console.error(
          "[payroll] calculatePayroll: fallo al guardar ítems de nómina:",
          JSON.stringify({
            periodId,
            items: payload.length,
            code: upsertError.code,
            message: upsertError.message,
            details: upsertError.details,
            hint: upsertError.hint,
          }),
        );
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
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

/**
 * PAY-01: borra un período en BORRADOR (es provisional, no historia). Solo
 * admin (lo aplican ruta/action).
 *
 * - Solo borrador: un período cerrado tiene nómina pagada y es inmutable.
 * - Hijos: `payroll_items` referencia al período y `payroll_payments` al ítem,
 *   ambas con ON DELETE CASCADE (migración 007): un solo delete del período
 *   arrastra ítems y pagos, sin borrado manual ni huérfanos.
 * - Vales: al liquidar, `calculatePayroll` marca como `descontada` los vales
 *   del rango (estado terminal, sin FK al período). Si se borra el borrador
 *   hay que devolverlos a su estado previo o quedarían descontados sin nómina
 *   que los respalde. La atribución es por rango de fechas; el único
 *   solapamiento que bloquea es con un período CERRADO (nómina ya pagada):
 *   revertir esos vales destruiría historia. Solapar con otros borradores no
 *   bloquea, pues nada está pagado y el borrador restante puede recalcularse.
 *   El estado previo se infiere de `approved_by` (ver restoreVoucherStatus).
 */
export async function deletePayrollPeriod(
  sedeId: string,
  periodId: string,
  actor: PayrollActor,
): Promise<{ id: string }> {
  const db = await payrollDb();
  try {
    const period = await getPeriodOrThrow(db, sedeId, periodId);
    try {
      assertDeletablePeriod(period.status);
    } catch (error) {
      throw toPayrollError(error);
    }

    // Sin FK vale↔período, la atribución es por rango. Un período CERRADO
    // (nómina ya pagada) que solape este rango hace ambiguo qué vales
    // pertenecen a este borrador: se rechaza antes que revertir vales de una
    // nómina ya pagada. Los borradores solapados NO bloquean: no hay plata
    // pagada y el borrador restante puede recalcularse.
    const { data: overlapping, error: overlapError } = await db
      .from("payroll_periods")
      .select("id, status")
      .eq("sede_id", sedeId)
      .neq("id", periodId)
      .lte("start_date", period.end_date)
      .gte("end_date", period.start_date);
    if (overlapError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const overlappingStatuses = ((overlapping ?? []) as Array<{ status: string }>).map(
      (row) => row.status,
    );
    if (overlapBlocksDeletion(overlappingStatuses)) {
      throw new PayrollError(
        "PERIOD_OVERLAP_AMBIGUOUS",
        "No se puede borrar: otro período CERRADO de la sede solapa este rango y no se puede determinar qué vales pertenecen a este borrador sin revertir una nómina ya pagada.",
        409,
      );
    }

    // Devuelve a su estado previo los vales que este borrador descontó.
    const { data: discounted, error: discountedError } = await db
      .from("voucher_requests")
      .select("id, approved_by")
      .eq("sede_id", sedeId)
      .eq("status", "descontada")
      .gte("request_date", period.start_date)
      .lte("request_date", period.end_date);
    if (discountedError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const voucherRows = (discounted ?? []) as Array<{ id: string; approved_by: string | null }>;
    const backToApproved = voucherRows
      .filter((row) => restoreVoucherStatus(row.approved_by) === "aprobada")
      .map((row) => row.id);
    const backToPending = voucherRows
      .filter((row) => restoreVoucherStatus(row.approved_by) === "pendiente")
      .map((row) => row.id);
    if (backToApproved.length > 0) {
      const { error } = await db
        .from("voucher_requests")
        .update({ status: "aprobada" })
        .in("id", backToApproved)
        .eq("status", "descontada");
      if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    if (backToPending.length > 0) {
      const { error } = await db
        .from("voucher_requests")
        .update({ status: "pendiente" })
        .in("id", backToPending)
        .eq("status", "descontada");
      if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
    }

    // Los ítems (y por cascada sus pagos) caen con el período.
    const { error: deleteError } = await db.from("payroll_periods").delete().eq("id", periodId);
    if (deleteError) throw new PayrollError("INTERNAL", "Error interno.", 500);

    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.PAYROLL_DELETED,
      entity: "payroll_periods",
      entity_id: periodId,
      metadata: {
        start_date: period.start_date,
        end_date: period.end_date,
        vales_revertidos: backToApproved.length + backToPending.length,
      },
    });
    return { id: periodId };
  } catch (error) {
    throw toPayrollError(error);
  }
}

// -------------------------------------------------------------------- vales ---

/** PAY-05/V2: topes vigentes de la sede (null cuando aún no se configuran). */
export async function getVoucherSettings(sedeId: string): Promise<VoucherSettingsRow | null> {
  const db = await payrollDb();
  // Degradación por migraciones pendientes: 026 (per_day_limits) y 024 (allowed_days).
  const attempts: Array<{ select: string; missing: string }> = [
    { select: "sede_id, max_per_day, max_per_week, allowed_days, per_day_limits", missing: "per_day_limits" },
    { select: "sede_id, max_per_day, max_per_week, allowed_days", missing: "allowed_days" },
  ];
  for (const attempt of attempts) {
    const result = await db.from("voucher_settings").select(attempt.select).eq("sede_id", sedeId).maybeSingle();
    if (!result.error) {
      const row = result.data as unknown as Record<string, unknown> | null;
      if (!row) return null;
      return {
        ...(row as unknown as VoucherSettingsRow),
        allowed_days: (row.allowed_days as number[] | null) ?? null,
        per_day_limits: readPerDayLimits(row.per_day_limits),
      };
    }
    const message = String((result.error as { message?: string }).message ?? "");
    if (!new RegExp(attempt.missing, "i").test(message)) {
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
  }
  const { data, error } = await db
    .from("voucher_settings")
    .select("sede_id, max_per_day, max_per_week")
    .eq("sede_id", sedeId)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) return null;
  return {
    ...(data as unknown as VoucherSettingsRow),
    allowed_days: null,
    per_day_limits: null,
  };
}

/** V2: lee per_day_limits de la BD (jsonb) a un mapa numérico saneado. */
function readPerDayLimits(value: unknown): Record<string, number> | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).map(([day, amount]) => ({
    day,
    amount: amount as number,
  }));
  return normalizePerDayLimits(entries);
}

/** PAY-05/V2: configura topes día/semana (opcionales) + días permitidos + topes por día. Solo admin. */
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
  const perDay = parsed.data.per_day_limits !== undefined
    ? normalizePerDayLimits(parsed.data.per_day_limits)
    : (current?.per_day_limits ?? null);
  // V2: "sin topes" se guarda como NULL; 0 también se normaliza a NULL.
  const maxDay = parsed.data.max_per_day == null || Number(parsed.data.max_per_day) === 0
    ? null
    : roundMoney(Number(parsed.data.max_per_day));
  const maxWeek = parsed.data.max_per_week == null || Number(parsed.data.max_per_week) === 0
    ? null
    : roundMoney(Number(parsed.data.max_per_week));
  const base = { sede_id: actor.sedeId, max_per_day: maxDay, max_per_week: maxWeek };
  const variants = [
    { ...base, allowed_days: allowed ?? [1, 2, 3, 4, 5, 6, 7], per_day_limits: perDay ?? {} },
    { ...base, allowed_days: allowed ?? [1, 2, 3, 4, 5, 6, 7] },
    base,
  ];
  const selects = [
    "sede_id, max_per_day, max_per_week, allowed_days, per_day_limits",
    "sede_id, max_per_day, max_per_week, allowed_days",
    "sede_id, max_per_day, max_per_week",
  ];
  for (const [index, payload] of variants.entries()) {
    const result = await db
      .from("voucher_settings")
      .upsert(payload, { onConflict: "sede_id" })
      .select(selects[index])
      .single();
    if (!result.error && result.data) {
      const row = result.data as unknown as Record<string, unknown>;
      return {
        ...(row as unknown as VoucherSettingsRow),
        allowed_days: (row.allowed_days as number[] | null) ?? current?.allowed_days ?? null,
        per_day_limits: readPerDayLimits(row.per_day_limits) ?? (index === 0 ? perDay : current?.per_day_limits ?? null),
      };
    }
    const message = String((result.error as { message?: string } | null)?.message ?? "");
    const expected = index === 0 ? "per_day_limits" : "allowed_days";
    if (!new RegExp(expected, "i").test(message)) {
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
  }
  throw new PayrollError("INTERNAL", "Error interno.", 500);
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
  /** Dentro de rango: se generó directo (aprobada, utilizable de una). */
  auto_approved: boolean;
}

/**
 * PAY-05/PAY-06 + item 5 (nuevo flujo): la CAJA (turno abierto) abre el vale
 * del empleado que se acerca al mostrador. Exige turno abierto y ser su dueño
 * (o admin); el método arqueable se elige aquí. Valida topes día/semana
 * acumulando los vigentes + días permitidos: dentro de rango se genera DIRECTO
 * (aprobada, utilizable de una); fuera de rango o en día no permitido queda
 * PENDIENTE para que el admin lo autorice o rechace (alerta voucher.requested).
 * Sin código de aprobación: la autorización queda en approved_by + observation.
 *
 * LIMITACIÓN CONOCIDA: un vale aprobado descuenta del arqueo por su método en
 * el turno que lo abrió. Si la caja ya entregó el efectivo y el administrador
 * rechaza después, ese dinero salió del cajón pero el sistema no lo registra
 * (rechazar no toca caja): el cierre puede mostrar un faltante no explicado
 * por el sistema. Trade-off aceptado.
 */
export async function requestVoucher(raw: unknown, actor: PayrollActor): Promise<VoucherRequestResult> {
  const parsed = requestVoucherSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    // La caja abierta es quien abre el vale: sin turno abierto no hay vale.
    const openShift = await getOpenShiftWithOpener(actor.sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    if (!openShift) {
      throw new PayrollError(
        "NO_OPEN_SHIFT",
        "No hay caja abierta: abre tu turno para abrir un vale.",
        409,
      );
    }
    const isAdmin = (actor.roles ?? []).includes("admin");
    if (openShift.opened_by !== actor.userId && !isAdmin) {
      const owner = openShift.opener_name?.trim() || null;
      throw new PayrollError(
        "SHIFT_NOT_OWNER",
        owner
          ? `La caja abierta es del turno de ${owner}: solo ${owner} o un administrador puede abrir vales.`
          : "La caja abierta es de otro turno: solo quien abrió el turno o un administrador puede abrir vales.",
        403,
      );
    }
    // Método de pago arqueable: del catálogo real de la sede, no hardcodeado.
    const methods = await listPaymentMethods(actor.sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    const method = methods.find(
      (row) => row.is_active && row.arqueable && row.code === parsed.data.method_code,
    );
    if (!method) {
      throw new PayrollError(
        "METHOD_NOT_ARCHIVABLE",
        `El método de pago ${parsed.data.method_code} no está activo o no es arqueable en esta sede.`,
        422,
      );
    }
    const employee = await getEmployee(parsed.data.employee_id).catch((error) => {
      throw toPayrollError(error);
    });
    try {
      resolveSede(actor.sedeId, employee.sede_id);
    } catch (error) {
      throw toPayrollError(error);
    }
    const requestDate = parsed.data.request_date ?? new Date().toISOString().slice(0, 10);
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
      maxPerDay: settings?.max_per_day == null ? null : Number(settings.max_per_day),
      maxPerWeek: settings?.max_per_week == null ? null : Number(settings.max_per_week),
      requestDate,
      allowedDays: settings?.allowed_days ?? null,
      perDayLimits: settings?.per_day_limits ?? null,
    });
    // Dentro de rango → directo; fuera de rango (topes/día) → pendiente.
    const status = resolveVoucherInitialStatus(eligibility);
    const autoApproved = status === "aprobada";
    const observation = parsed.data.observation?.trim()
      ? parsed.data.observation.trim()
      : autoApproved
        ? "Generado directo en caja (dentro de rango)."
        : null;
    const voucherSelect = await resolveVoucherSelect(db);
    const hasMethodColumns = voucherMethodColumns !== false;
    const hasCreatedByColumn = voucherCreatedByColumn !== false;
    // Tope de salidas en efectivo del turno (50% de la base de apertura): el
    // vale no puede dejar el acumulado del turno por encima del tope. Solo
    // aplica al efectivo y solo cuando el vale queda ligado a un turno
    // (migración 028); los digitales no tienen tope.
    if (hasMethodColumns && method.code === "efectivo") {
      const usedCashOut = await cashOutUsedInShift(openShift.id).catch((error) => {
        throw toPayrollError(error);
      });
      const violation = cashOutLimitViolation({
        methodCode: method.code,
        openingBase: Number(openShift.opening_base),
        cashOutUsed: usedCashOut,
        amount: parsed.data.amount,
      });
      if (violation) throw new PayrollError(violation.code, violation.message, 422);
    }
    const { data, error } = await db
      .from("voucher_requests")
      .insert({
        sede_id: actor.sedeId,
        employee_id: employee.id,
        amount: roundMoney(parsed.data.amount),
        request_date: requestDate,
        status,
        approved_by: autoApproved ? actor.userId : null,
        observation,
        ...(hasMethodColumns ? { method_code: method.code, cash_shift_id: openShift.id } : {}),
        ...(hasCreatedByColumn ? { created_by: actor.userId } : {}),
      })
      .select(voucherSelect)
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const [created] = await attachVoucherUserNames(db, [
      normalizeVoucher(data as unknown as Record<string, unknown>),
    ]);
    if (autoApproved) {
      // Dentro de rango: sale de caja de una; auditado sin código.
      await writeAudit({
        sede_id: actor.sedeId,
        user_id: actor.userId,
        action: AUDIT_ACTIONS.VOUCHER_APPROVED,
        entity: "voucher_requests",
        entity_id: created.id,
        metadata: {
          employee_id: employee.id,
          amount: Number(created.amount),
          method_code: method.code,
          cash_shift_id: openShift.id,
          auto: true,
          within_range: true,
        },
      });
    } else {
      // Fuera de rango: alerta al admin para autorizar o rechazar.
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
          method_code: method.code,
          over_day: eligibility.overDay,
          over_week: eligibility.overWeek,
          day_not_allowed: eligibility.dayNotAllowed,
        },
      });
    }
    return {
      voucher: created,
      requires_approval: !autoApproved,
      over_day: eligibility.overDay,
      over_week: eligibility.overWeek,
      day_not_allowed: eligibility.dayNotAllowed,
      auto_approved: autoApproved,
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
    .select(await resolveVoucherSelect(db))
    .eq("sede_id", sedeId)
    .order("request_date", { ascending: false })
    .limit(limit);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
  if (filters.request_date) query = query.eq("request_date", filters.request_date);
  const { data, error } = await query;
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeVoucher);
  return attachVoucherUserNames(db, rows);
}

async function getVoucherOrThrow(db: DbClient, sedeId: string, id: string): Promise<VoucherRequestRow> {
  const { data, error } = await db
    .from("voucher_requests")
    .select(await resolveVoucherSelect(db))
    .eq("id", id)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  if (!data) throw new PayrollError("NOT_FOUND", "Vale no encontrado.", 404);
  const row = normalizeVoucher(data as unknown as Record<string, unknown>);
  try {
    resolveSede(sedeId, row.sede_id);
  } catch (error) {
    throw toPayrollError(error);
  }
  return row;
}

/**
 * PAY-06 (nuevo flujo): el admin autoriza un vale pendiente (fuera de rango)
 * con observación opcional. Sin código de aprobación: la autorización queda en
 * `approved_by` + observation. Al aprobarse, el vale entra al arqueo por su
 * método en el turno que lo abrió. Solo admin.
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
    // Tope del 50% de salidas en efectivo del turno: un vale puede nacer
    // pendiente por debajo del límite y superarlo al aprobarse (el acumulado
    // del turno creció). Se repite la validación de la solicitud con lo YA
    // salido del turno (otros vales aprobados + pagos inmediatos) más este
    // vale. Solo aplica al efectivo ligado a un turno (028); los digitales y
    // los vales históricos sin turno no tienen tope.
    if (voucher.method_code === "efectivo" && voucher.cash_shift_id) {
      const { data: shift, error: shiftError } = await db
        .from("cash_shifts")
        .select("id, opening_base")
        .eq("id", voucher.cash_shift_id)
        .maybeSingle();
      if (shiftError) throw new PayrollError("INTERNAL", "Error interno.", 500);
      if (shift) {
        const cashOutUsed = await cashOutUsedInShift(voucher.cash_shift_id).catch((error) => {
          throw toPayrollError(error);
        });
        const violation = voucherApprovalCashOutViolation({
          methodCode: voucher.method_code,
          cashShiftId: voucher.cash_shift_id,
          openingBase: Number((shift as { opening_base: number | string }).opening_base),
          cashOutUsed,
          amount: Number(voucher.amount),
        });
        if (violation) throw new PayrollError(violation.code, violation.message, 422);
      }
    }
    const observation = parsed.data.observation?.trim()
      ? parsed.data.observation.trim()
      : voucher.observation;
    const { data, error } = await db
      .from("voucher_requests")
      .update({
        status: "aprobada",
        approved_by: actor.userId,
        observation,
      })
      .eq("id", id)
      .select(await resolveVoucherSelect(db))
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const [approved] = await attachVoucherUserNames(db, [
      normalizeVoucher(data as unknown as Record<string, unknown>),
    ]);
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
        maxPerDay: resolveVoucherDayCap(
          settings?.max_per_day == null ? null : Number(settings.max_per_day),
          settings?.per_day_limits ?? null,
          voucher.request_date,
        ),
        maxPerWeek: settings?.max_per_week == null ? null : Number(settings.max_per_week),
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
        method_code: approved.method_code,
        over_tope: overTope,
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
      .select(await resolveVoucherSelect(db))
      .single();
    if (error || !data) throw new PayrollError("INTERNAL", "Error interno.", 500);
    const [rejected] = await attachVoucherUserNames(db, [
      normalizeVoucher(data as unknown as Record<string, unknown>),
    ]);
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
    return rejected;
  } catch (error) {
    throw toPayrollError(error);
  }
}

// Re-export puro usado por rutas/UI para el mensaje de suma exacta.
export { assertPortionsMatchNet };
