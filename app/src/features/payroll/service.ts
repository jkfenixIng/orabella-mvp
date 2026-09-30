import {
  approveVoucherSchema,
  assertCorrectablePeriod,
  assertDraftPeriod,
  assertDeletablePeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeCommissionDetail,
  buildEmployeeDetail,
  buildPayrollCorrectionView,
  buildPayrollMonthToDate,
  calculatePayrollSchema,
  canDiscountVoucher,
  capPayrollDiscounts,
  canReviewVoucher,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeNetPay,
  correctPayrollPeriodSchema,
  normalizeAllowedDays,
  normalizePerDayLimits,
  openPeriodSchema,
  overlapBlocksDeletion,
  payPayrollItemSchema,
  payrollExtraSchema,
  prorateFixedSalary,
  rangesOverlap,
  requestVoucherSchema,
  rejectVoucherSchema,
  requiresVoucherApproval,
  resolveVoucherDayCap,
  resolveVoucherInitialStatus,
  restoreVoucherStatus,
  roundMoney,
  summarizePayrollItems,
  voucherApprovalCashOutViolation,
  voucherLimitsSchema,
  weekStartOf,
  type CalculatePayrollInput,
  type DetailLine,
  type OpenPeriodInput,
  type PayrollCorrectionView,
  type PayrollExtraKind,
  type PayrollMonthEmployeeRow,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { commissionRuleKey, type RuleRate } from "@/src/features/commissions/schemas";
import { cashOutUsedInShift, getOpenShiftWithOpener } from "@/src/features/cash/service";
import { cashOutLimitViolation } from "@/src/features/cash/schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import { bogotaDay, rangeBounds } from "@/src/shared/lib/dates";
import {
  chunkIds,
  PagedReadError,
  readAllPaged,
  type PagedResponse,
} from "@/src/shared/lib/paged";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import {
  AdminError,
  getEmployee,
  listAllEmployees,
  listPaymentMethods,
  requireSession,
  type EmployeeRow,
} from "@/src/features/admin/service";
import { resolveVoucherAlert } from "@/src/features/alerts/service";
import {
  voucherAlertRequired,
  voucherAlertResolutionNote,
} from "@/src/features/alerts/schemas";

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

/** Campos de diagnóstico que devuelve PostgREST en un error de lectura. */
interface PostgrestFailure {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Los campos de error de PostgREST (o el mensaje suelto si no vino de la base). */
function readFailureFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof PagedReadError)) {
    return { message: error instanceof Error ? error.message : "error desconocido" };
  }
  const cause = (error.cause ?? null) as PostgrestFailure | null;
  if (!cause) return { message: error.message };
  return {
    code: cause.code ?? null,
    message: cause.message ?? error.message,
    details: cause.details ?? null,
    hint: cause.hint ?? null,
  };
}

/**
 * U5: lectura exhaustiva de nómina. El tope de transporte del Data API NO es un
 * tope de negocio: leer un conjunto recortado liquida comisiones y vales con
 * datos incompletos —al empleado le falta plata y los topes de vales se evalúan
 * contra un acumulado que no es el real— y eso no se ve en ningún lado. Acá se
 * pagina hasta agotar el conjunto y cualquier fallo se registra y se LANZA
 * (`READ_INCOMPLETE` en `toPayrollError`): nunca se sigue con lo que se alcanzó
 * a leer.
 */
async function readAllPayroll<TRow>(args: {
  log: string;
  what: string;
  meta: Record<string, unknown>;
  table: string;
  fetchPage: (from: number, to: number) => PromiseLike<PagedResponse<TRow>>;
}): Promise<TRow[]> {
  try {
    return await readAllPaged<TRow>({ table: args.table, fetchPage: args.fetchPage });
  } catch (error) {
    console.error(
      `[payroll] ${args.log}: fallo al listar ${args.what}:`,
      JSON.stringify({ ...args.meta, ...readFailureFields(error) }),
    );
    throw error;
  }
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/**
 * Administración de la nómina: solo admin. Quien genera (periodo, cálculo) y
 * quien revisa (cierre, borrado, pago de ítems) la nómina es el administrador;
 * la caja no tiene acceso al módulo.
 */
const ADMIN_ROLES: RoleCode[] = ["admin"];
/**
 * Lectura de nómina: admin y empleado. El empleado ve SU recibo —el alcance por
 * fila lo aplica el llamador—; la caja NO entra, ni siquiera para leer.
 */
const VIEWER_ROLES: RoleCode[] = ["admin", "empleado"];
/**
 * Vales: admin y caja (la caja abre el vale al empleado con su turno abierto).
 * Es la ÚNICA superficie que admite caja: NO usar esta guarda en nómina —por
 * acá entraba la caja a leer y a pagar nómina.
 */
const PAYER_ROLES: RoleCode[] = ["admin", "caja"];

export interface PayrollActor {
  userId: string;
  sedeId: string;
  roles?: RoleCode[];
}

/** Sesión de nómina: autenticada, con sede, y sus roles. */
interface PayrollSession {
  userId: string;
  sedeId: string;
  roles: RoleCode[];
}

/**
 * Resuelve la sesión con el guard compartido (`requireSession`: autenticada y
 * con sede) y la reescribe a los tipos de nómina. Los errores de sesión cambian
 * de clase, no de forma: mismo código, mismo mensaje, mismo status.
 */
async function payrollSession(token: string | null | undefined): Promise<PayrollSession> {
  try {
    const session = await requireSession(token);
    return { userId: session.userId, sedeId: session.sedeId, roles: session.roles };
  } catch (error) {
    if (error instanceof AdminError) {
      throw new PayrollError(error.code, error.message, error.status);
    }
    throw error;
  }
}

/** Gate de rol de una superficie: FORBIDDEN como error de nómina. */
function requirePayrollRoles(roles: RoleCode[], allowed: RoleCode[]): void {
  try {
    requireSedeRole(roles, allowed);
  } catch (error) {
    if (error instanceof AdminError) {
      throw new PayrollError(error.code, error.message, error.status);
    }
    throw error;
  }
}

/**
 * §10 Nómina/vales: administrar la nómina es solo admin de su sede (las rutas y
 * las actions aplican este gate; incluye pagar un ítem).
 *
 * Los vales NO usan esta guarda: el vale lo abre la caja (requirePayrollPayer).
 */
export async function requirePayrollAdmin(
  token: string | null | undefined,
): Promise<PayrollActor> {
  const session = await payrollSession(token);
  requirePayrollRoles(session.roles, ADMIN_ROLES);
  return session;
}

/**
 * Lectura de nómina: admin de la sede y el empleado que mira SU recibo.
 *
 * El empleado pasa el gate y el llamador recorta por fila (`getPeriodDetail` +
 * el filtro por legajo); la caja queda fuera: el módulo de nómina no es de caja,
 * ni para leer (para el vale tiene /vales y requirePayrollPayer).
 */
export async function requirePayrollViewer(
  token: string | null | undefined,
): Promise<PayrollActor> {
  const session = await payrollSession(token);
  requirePayrollRoles(session.roles, VIEWER_ROLES);
  return session;
}

/**
 * Vales (PAY-04/V2): abrir un vale admite admin y caja —la caja abierta es quien
 * lo abre con turno abierto (el servicio lo vuelve a validar)—.
 *
 * Solo para el flujo de vales. La nómina NO pasa por acá: usar esta guarda en
 * una superficie de nómina vuelve a abrirle el módulo a la caja.
 */
export async function requirePayrollPayer(
  token: string | null | undefined,
): Promise<PayrollActor> {
  const session = await payrollSession(token);
  requirePayrollRoles(session.roles, PAYER_ROLES);
  return session;
}

function toPayrollError(error: unknown): PayrollError {
  if (error instanceof PayrollError) return error;
  if (error instanceof PagedReadError) {
    return new PayrollError(
      error.code,
      `${error.message} La operación se detuvo: con una lectura incompleta las cifras de nómina (comisiones, vales y pagado) saldrían mal. Reintente y, si persiste, revise el volumen de datos de la sede.`,
      500,
    );
  }
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
      case "PERIOD_NOT_CLOSED":
        // PA-2b: un borrador no se corrige, se recalcula. Corregir es para una
        // liquidación ya firmada, que no tiene otra salida.
        return new PayrollError(
          "PERIOD_NOT_CLOSED",
          "Solo se corrigen períodos cerrados; este está en borrador y se recalcula.",
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
      case "INVALID_PERIOD_RANGE":
        // PR1: la prorata del fijo no puede calcularse sobre un rango
        // imposible. El CHECK de 007 ya lo impide en la base; si igual llega
        // acá, el cálculo se detiene en vez de pagar 0 en silencio.
        return new PayrollError(
          "INVALID_PERIOD_RANGE",
          "El rango del período es inválido (la fecha final no puede ser anterior a la inicial).",
          409,
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

/**
 * PA-2a: un pago de nómina individual por caso extraordinario. NO es un
 * período: no tiene `period_id`, no se calcula desde facturas y no cierra
 * nada. Es plata que sale de la sede con su motivo y su tipo, para los días
 * que un período (incluso uno CERRADO) ya cubrió.
 */
export interface PayrollExtraRow {
  id: string;
  sede_id: string;
  employee_id: string;
  amount: number;
  method_id: string | null;
  method_code: string;
  reference: string | null;
  reason: string;
  kind: PayrollExtraKind;
  /** Días que el pago liquida (referencia); null = pago sin días asociados. */
  days_from: string | null;
  days_to: string | null;
  paid_by: string | null;
  paid_at: string;
  created_at: string;
}

/**
 * PA-2b: una corrección de un período CERRADO. Guarda las DOS versiones —los
 * totales de la versión anterior congelados y los de la corregida—, más el
 * motivo, quién corrigió y cuándo. El período y sus ítems NO se tocan: esta
 * fila es la versión corregida, autocontenida y legible por sí sola.
 */
export interface PayrollPeriodCorrectionRow {
  id: string;
  period_id: string;
  /** Total neto que el período decía antes de corregir (versión anterior). */
  previous_net_total: number;
  /** Total pagado del período al momento de corregir (no cambia). */
  previous_paid_total: number;
  /** Total neto que dicen las reglas vigentes (versión corregida). */
  corrected_net_total: number;
  previous_item_count: number;
  corrected_item_count: number;
  /** Motivo obligatorio de la corrección. */
  reason: string;
  corrected_by: string;
  corrected_at: string;
}

/**
 * PA-2b: los montos por empleado de una corrección, con las dos versiones
 * (anterior congelada y corregida) y lo pagado. Las filas se guardan para que
 * la corrección sea autocontenida: leerla no depende de que nadie haya
 * respetado la inmutabilidad del período.
 */
export interface PayrollPeriodCorrectionItemRow {
  id: string;
  correction_id: string;
  employee_id: string;
  previous_base_fixed: number;
  previous_commissions: number;
  previous_bonuses: number;
  previous_deductions_vales: number;
  previous_other_discounts: number;
  previous_net_pay: number;
  previous_paid: number;
  corrected_base_fixed: number;
  corrected_commissions: number;
  corrected_bonuses: number;
  corrected_deductions_vales: number;
  corrected_other_discounts: number;
  corrected_net_pay: number;
}

/**
 * PA-2b: el resultado de corregir (o de leer la corrección de) un período. La
 * vista trae la comparación ya armada: por empleado y para el período, lo que
 * decía la versión anterior, lo que dice la corregida, lo pagado y la
 * diferencia.
 */
export interface PayrollPeriodCorrectionResult {
  period: PayrollPeriodRow;
  correction: PayrollPeriodCorrectionRow;
  view: PayrollCorrectionView;
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
const EXTRA_SELECT =
  "id, sede_id, employee_id, amount, method_id, method_code, reference, reason, kind, days_from, days_to, paid_by, paid_at, created_at";

/**
 * CL-5: el pago extraordinario que YA se registró con esa marca, PARA ESE
 * EMPLEADO.
 *
 * La marca es un uuid que acuña la pantalla al empezar el intento y que
 * reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `payrollExtraSchema` (schemas.ts). El filtro es por
 * EMPLEADO: el pago extraordinario no tiene período ni ítem —esa es su razón de
 * ser (036): existe para pagar días que un período CERRADO ya cubrió—, así que
 * su único registro es el empleado, que es a quien el pago significa y la
 * dimensión del historial del módulo (`idx_payroll_extras_employee_paid_at`).
 * Con la clave por empleado el lookup nunca puede devolver el pago de otra
 * persona, y la misma marca para dos empleados son DOS operaciones. La clave
 * del índice de la 044 es la MISMA (`employee_id, idempotency_key`), así que el
 * `eq` de este lookup y la clave del índice son el mismo conjunto: el lookup no
 * puede devolver una fila que el índice no habría bloqueado.
 *
 * La sede NO entra en la clave porque no agrega identidad: el servicio resuelve
 * al empleado y exige que sea de la sede del actor (uno ajeno es NOT_FOUND)
 * antes de llegar acá, así que este lookup corre después de esa validación y no
 * puede devolver el pago de otra sede.
 */
async function findPayrollExtraByIdempotencyKey(
  db: DbClient,
  employeeId: string,
  idempotencyKey: string,
): Promise<PayrollExtraRow | null> {
  const { data, error } = await db
    .from("payroll_extras")
    .select(EXTRA_SELECT)
    .eq("employee_id", employeeId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return (data as PayrollExtraRow | null) ?? null;
}
/** PA-2b: la corrección de un período cerrado (037). */
const PERIOD_CORRECTION_SELECT =
  "id, period_id, previous_net_total, previous_paid_total, corrected_net_total, previous_item_count, corrected_item_count, reason, corrected_by, corrected_at";
const PERIOD_CORRECTION_ITEM_SELECT =
  "id, correction_id, employee_id, previous_base_fixed, previous_commissions, previous_bonuses, previous_deductions_vales, previous_other_discounts, previous_net_pay, previous_paid, corrected_base_fixed, corrected_commissions, corrected_bonuses, corrected_deductions_vales, corrected_other_discounts, corrected_net_pay";
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
 * PAY-01: abre un periodo borrador por sede y rango.
 *
 * PR1: un DÍA se nomina una sola vez. La prorata del fijo hace que la suma de
 * los períodos de un mes sea el sueldo SOLO si no comparten días, así que
 * abrir un rango que solape otro (en cualquier estado: un período cerrado ya
 * pagó esos días) se rechaza acá con el rango en conflicto a la vista. El
 * índice único parcial de 007 sólo miraba la tupla EXACTA de los borradores:
 * dos rangos adyacentes o cruzados pasaban sin ruido.
 *
 * Barreras ante carreras: la lectura y el INSERT no son atómicos, así que la
 * restricción de exclusión de la base (migración 035) es la barrera final
 * (23P01 → mismo error de negocio, igual que 23505 para el borrador repetido).
 */
export async function openPayrollPeriod(raw: unknown, actor: PayrollActor): Promise<PayrollPeriodRow> {
  const parsed = openPeriodSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: OpenPeriodInput = parsed.data;
  const db = await payrollDb();
  try {
    // Candidatos: los períodos de la sede que tocan el rango pedido. La
    // decisión la toma el predicado puro `rangesOverlap` (el mismo contrato que
    // el `daterange(..., '[]') &&` de la base), pero la LECTURA es exhaustiva y
    // falla a la vista (READ_INCOMPLETE): con una lectura recortada por el tope
    // del Data API la guarda podría no ver el período que estorba y abrir un
    // rango que comparte días. Acá no se decide con lo que se alcanzó a leer.
    const candidates = await readAllPayroll<{
      start_date: string;
      end_date: string;
      status: string;
    }>({
      log: "openPayrollPeriod",
      what: "períodos de la sede en el rango",
      meta: { sedeId: actor.sedeId, start: input.start_date, end: input.end_date },
      table: "payroll_periods",
      fetchPage: (from, to) =>
        db
          .from("payroll_periods")
          .select("id, start_date, end_date, status")
          .eq("sede_id", actor.sedeId)
          .lte("start_date", input.end_date)
          .gte("end_date", input.start_date)
          .order("id")
          .range(from, to),
    });
    const requested = { start_date: input.start_date, end_date: input.end_date };
    const clash = candidates.find((row) => rangesOverlap(row, requested));
    if (clash) {
      throw new PayrollError(
        "PERIOD_OVERLAP",
        `El rango ${requested.start_date} a ${requested.end_date} comparte días con el período ${clash.start_date} a ${clash.end_date} (${clash.status}) de esta sede. Un día se nomina una sola vez: ajuste las fechas para que no se crucen con un período existente.`,
        409,
      );
    }

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
      // Carrera perdida contra `ex_payroll_periods_no_overlap` (035): otro
      // proceso abrió un período con días en común entre la lectura y el
      // INSERT. Es el mismo error de negocio, no un fallo interno.
      if ((error as { code?: string }).code === "23P01") {
        throw new PayrollError(
          "PERIOD_OVERLAP",
          "Otro período de esta sede quedó con días en común mientras se abría este. Un día se nomina una sola vez: revise los períodos existentes y ajuste las fechas.",
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

/**
 * Lista TODOS los períodos de la sede (más recientes primero).
 *
 * PA3: antes tenía `.limit(20)` y eso no era un tope de presentación, era un
 * tope de HISTORIA: la pantalla se quedaba con los 20 últimos sin total, sin
 * conteo y sin aviso, así que la sede con más de 20 períodos perdía los viejos
 * de la vista y nada lo decía. El conjunto está acotado por la sede (un día se
 * nomina una sola vez), así que lo correcto es leerlo entero por páginas y con
 * `order()` determinista: sin el desempate por `id`, dos períodos con la misma
 * fecha de inicio pueden caer en páginas distintas y repetirse o perderse.
 */
export async function listPeriods(sedeId: string): Promise<PayrollPeriodRow[]> {
  try {
    const db = await payrollDb();
    return await readAllPayroll<PayrollPeriodRow>({
      log: "listPeriods",
      what: "períodos de la sede",
      meta: { sede: sedeId },
      table: "payroll_periods",
      fetchPage: (from, to) =>
        db
          .from("payroll_periods")
          .select(PERIOD_SELECT)
          .eq("sede_id", sedeId)
          .order("start_date", { ascending: false })
          .order("id")
          .range(from, to),
    });
  } catch (error) {
    throw toPayrollError(error);
  }
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
 *
 * U7: las dos lecturas son exhaustivas. Antes los ítems se leían con
 * `.order("created_at")` y sin tope explícito —el `max-rows` del Data API los
 * recortaba a 1000— y los pagos con un `in(...)` de todos los ids de una sola
 * vez. El `paid`/`remaining` que se muestra es plata: una lectura recortada
 * mostraba menos líneas de las que tiene el período y menos pagado del real
 * (plata ya entregada que parece debida). El fallo de cualquiera de las dos
 * lecturas se convierte en un error de negocio a la vista, nunca en una cifra
 * calculada con lo que se alcanzó a leer.
 */
export async function getPeriodDetail(sedeId: string, id: string): Promise<PeriodDetail> {
  try {
    const db = await payrollDb();
    const period = await getPeriodOrThrow(db, sedeId, id);
    // `created_at` es el orden de presentación; `id` lo desempata para que dos
    // ítems con el mismo timestamp no caigan en páginas distintas.
    const rows = await readAllPayroll<PayrollItemRow>({
      log: "getPeriodDetail",
      what: "ítems del período",
      meta: { periodId: id },
      table: "payroll_items",
      fetchPage: (from, to) =>
        db
          .from("payroll_items")
          .select(ITEM_SELECT)
          .eq("period_id", id)
          .order("created_at")
          .order("id")
          .range(from, to),
    });
    let paidByItem = new Map<string, number>();
    if (rows.length > 0) {
      // U7: los ids van en lotes del tamaño que aguanta la URL (una lista sin
      // tope termina en 414 y la lectura no ocurre) y cada lote se pagina hasta
      // agotar, con `order("id")` para que dos corridas lean lo mismo.
      paidByItem = new Map();
      for (const chunk of chunkIds(rows.map((row) => row.id))) {
        const payments = await readAllPayroll<{ payroll_item_id: string; amount: number | string }>({
          log: "getPeriodDetail",
          what: "pagos del período",
          meta: { periodId: id, items: rows.length, ids: chunk.length },
          table: "payroll_payments",
          fetchPage: (from, to) =>
            db
              .from("payroll_payments")
              .select("payroll_item_id, amount")
              .in("payroll_item_id", chunk)
              .order("id")
              .range(from, to),
        });
        for (const row of payments) {
          paidByItem.set(
            row.payroll_item_id,
            roundMoney((paidByItem.get(row.payroll_item_id) ?? 0) + Number(row.amount)),
          );
        }
      }
    }
    return {
      period,
      items: rows.map((item) => {
        const paid = paidByItem.get(item.id) ?? 0;
        return { ...item, paid, remaining: roundMoney(Math.max(0, Number(item.net_pay) - paid)) };
      }),
    };
  } catch (error) {
    // "No se pudo leer" no puede llegar como INTERNAL genérico: el código
    // READ_INCOMPLETE y la tabla/fila donde se cortó son lo accionable.
    throw toPayrollError(error);
  }
}

/** Ítem de nómina con lo pagado ya resuelto (lo que la vista muestra). */
type PaidPayrollItem = PayrollItemRow & { paid: number };

/**
 * PA3: el resumen de un período —se lee sin abrirlo— y el mes a la fecha por
 * empleado. Los períodos y el resumen salen de UNA lectura, así que la lista
 * sabe cuántos hay sin depender de cuántos alcanzó a leer.
 */
export interface PayrollPeriodSummary {
  period: PayrollPeriodRow;
  employeeCount: number;
  netTotal: number;
  paidTotal: number;
  remainingTotal: number;
}

export interface PayrollOverview {
  summaries: PayrollPeriodSummary[];
  months: PayrollMonthEmployeeRow[];
}

/**
 * Los ítems de VARIOS períodos con lo pagado de cada uno resuelto.
 *
 * Mismas dos reglas que `getPeriodDetail`, que es plata: los ids van en lotes
 * del tamaño que aguanta la URL (una lista sin tope termina en 414 y la
 * lectura no ocurre) y cada lote se pagina hasta agotar, con `order("id")` para
 * que dos corridas lean lo mismo. El fallo de cualquiera de las dos lecturas se
 * PROPAGA (`PagedReadError`): la vista no se arma con un total calculado sobre
 * un conjunto recortado.
 */
async function readPaidItemsOfPeriods(args: {
  db: DbClient;
  periodIds: readonly string[];
  log: string;
  meta: Record<string, unknown>;
}): Promise<PaidPayrollItem[]> {
  const items: PayrollItemRow[] = [];
  for (const chunk of chunkIds(args.periodIds)) {
    const rows = await readAllPayroll<PayrollItemRow>({
      log: args.log,
      what: "ítems de los períodos",
      meta: { ...args.meta, periods: args.periodIds.length, ids: chunk.length },
      table: "payroll_items",
      fetchPage: (from, to) =>
        args.db
          .from("payroll_items")
          .select(ITEM_SELECT)
          .in("period_id", chunk)
          .order("id")
          .range(from, to),
    });
    items.push(...rows);
  }

  const paidByItem = new Map<string, number>();
  for (const chunk of chunkIds(items.map((row) => row.id))) {
    const payments = await readAllPayroll<{ payroll_item_id: string; amount: number | string }>({
      log: args.log,
      what: "pagos de los períodos",
      meta: { ...args.meta, items: items.length, ids: chunk.length },
      table: "payroll_payments",
      fetchPage: (from, to) =>
        args.db
          .from("payroll_payments")
          .select("payroll_item_id, amount")
          .in("payroll_item_id", chunk)
          .order("id")
          .range(from, to),
    });
    for (const row of payments) {
      paidByItem.set(
        row.payroll_item_id,
        roundMoney((paidByItem.get(row.payroll_item_id) ?? 0) + Number(row.amount)),
      );
    }
  }

  return items.map((item) => ({ ...item, paid: paidByItem.get(item.id) ?? 0 }));
}

/**
 * PA3: la vista COMPLETA de la nómina de una sede, en una lectura y con dos
 * proyecciones de los mismos datos: los totales por período y el mes a la fecha
 * por empleado. Nada de esto mueve plata: es lectura y presentación, y las
 * sumas quedan en peso entero (dentro de los derivadores puros de `schemas`).
 *
 * OJO — AUTORIZACIÓN: el resumen agrega plata de TODA la planta. Es la misma
 * superficie que el detalle SIN alcance por fila
 * (`GET /api/v1/payroll-periods/[id]`), así que quien llama decide: la página
 * sólo la usa para el admin y al empleado le manda nada más que su propia fila.
 */
export async function listPayrollOverview(sedeId: string): Promise<PayrollOverview> {
  try {
    // `listPeriods` ya es exhaustiva: si se recorta, esto se cae a la vista.
    const periods = await listPeriods(sedeId);
    if (periods.length === 0) return { summaries: [], months: [] };

    const db = await payrollDb();
    const items = await readPaidItemsOfPeriods({
      db,
      periodIds: periods.map((period) => period.id),
      log: "listPayrollOverview",
      meta: { sede: sedeId },
    });

    const byPeriod = new Map<string, PaidPayrollItem[]>();
    for (const item of items) {
      const bucket = byPeriod.get(item.period_id);
      if (bucket) bucket.push(item);
      else byPeriod.set(item.period_id, [item]);
    }

    return {
      summaries: periods.map((period) => ({
        period,
        ...summarizePayrollItems(byPeriod.get(period.id) ?? []),
      })),
      months: buildPayrollMonthToDate({ periods, items }),
    };
  } catch (error) {
    throw toPayrollError(error);
  }
}

// ------------------------------------------------------------------ cálculo ---

/** Fila cruda de `invoice_items` que alimenta el cálculo de comisiones. */
interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  item_type: string;
  employee_id: string | null;
  qty: number | string;
  unit_price: number | string;
  subtotal: number | string;
  no_commission?: boolean | null;
  commission_value?: number | null;
  commission_percent_override?: number | null;
  product_id: string | null;
  service_id: string | null;
}

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
  /** Porcentaje explícito de la línea (personalizado por porcentaje, pago fijo). */
  commission_percent_override: number | null;
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
 *
 * La ARITMÉTICA no vive acá: `computePayrollLines` la calcula (una sola
 * fórmula) y esta función sólo la PERSISTE —upsert de ítems, vales a
 * `descontada` y auditoría—. La corrección de un período cerrado (PA-2b,
 * `correctPayrollPeriod`) reutiliza la MISMA aritmética sin persistir nada de
 * esto.
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

    // La alineación cubre TODA la planta activa de la sede, no el listado de
    // navegación: U7: antes esto era `listEmployees(sedeId, 500)` y el techo de
    // `clampLimit` (500) mandaba. El empleado 501 no se liquidaba —ausente, sin
    // error— y la nómina quedaba firmada como completa. La planta está acotada
    // por la sede, así que se lee entera por páginas.
    const employees = await listAllEmployees(sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    const actives = employees.filter((row) => row.is_active);

    const { payload, vouchersToDiscount } = await computePayrollLines({
      db,
      sedeId,
      period,
      // El borrador liquida la planta ACTIVA de la sede.
      roster: actives,
      input,
      voucherScope: "vigentes",
      log: "calculatePayroll",
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
    if (vouchersToDiscount.length > 0) {
      const { error: discountError } = await db
        .from("voucher_requests")
        .update({ status: "descontada" })
        .in("id", vouchersToDiscount)
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
        vales_descontados: vouchersToDiscount.length,
      },
    });
    return getPeriodDetail(sedeId, periodId);
  } catch (error) {
    throw toPayrollError(error);
  }
}

/**
 * Qué estados de vale descuentan el neto de un cálculo.
 *
 * `vigentes`: el borrador descuenta los vales pendientes/aprobados del rango y
 * los marca `descontada` (PAY-07).
 * `vigentes_y_descontados`: la corrección de un período cerrado vuelve a
 * descontar ADEMÁS los vales que ESTE período ya descontó. Sin eso el neto
 * corregido perdería el descuento del vale (ya no está pendiente) y subiría por
 * una razón ajena a la corrección: un número que cambia de significado en
 * silencio. El rango no es ambiguo: la restricción de exclusión de 035 impide
 * que dos períodos de la sede compartan un solo día, así que un vale
 * `descontada` dentro del rango pertenece a este período.
 */
type VoucherDiscountScope = "vigentes" | "vigentes_y_descontados";

/** ¿Este vale descuenta el neto del cálculo, dado su alcance? */
function discountsVoucher(status: string, scope: VoucherDiscountScope): boolean {
  if (canDiscountVoucher(status)) return true;
  return scope === "vigentes_y_descontados" && status === "descontada";
}

/** Estados de vale que se leen, según el alcance del descuento. */
function voucherStatusesForScope(scope: VoucherDiscountScope): string[] {
  return scope === "vigentes_y_descontados"
    ? ["pendiente", "aprobada", "descontada"]
    : ["pendiente", "aprobada"];
}

/** Un ítem de nómina calculado, todavía sin persistir. */
interface PayrollItemPayload {
  period_id: string;
  employee_id: string;
  base_fixed: number;
  commissions: number;
  bonuses: number;
  deductions_vales: number;
  other_discounts: number;
  net_pay: number;
  detail_json: DetailLine[];
}

interface PayrollLinesResult {
  payload: PayrollItemPayload[];
  /**
   * Vales que ESTE cálculo descuenta por primera vez (pendiente/aprobada). Son
   * los únicos que el borrador pasa a `descontada`; la corrección los ignora:
   * no reescribe vales.
   */
  vouchersToDiscount: string[];
}

/**
 * La aritmética de la nómina de un período (PAY-02/PAY-03), COMPARTIDA por el
 * cálculo del borrador (`calculatePayroll`) y por la corrección de un período
 * cerrado (PA-2b, `correctPayrollPeriod`): una sola fórmula, sin una aritmética
 * paralela que pueda desviarse.
 *
 * Lee facturas vigentes del rango, sus ítems comisionables, las reglas
 * ítem×empleado activas, los vales del rango y los pagos inmediatos ya hechos,
 * y arma un ítem por empleado del `roster`. NO escribe nada: devuelve el
 * payload y qué vales correspondería descontar. Quien llama decide qué hacer
 * con eso (el borrador lo persiste y marca vales; la corrección lo guarda como
 * la versión corregida del período cerrado).
 *
 * `roster` lo decide el llamador a propósito: el borrador pasa la planta ACTIVA
 * de la sede y la corrección pasa los empleados que el período YA liquidó (un
 * empleado dado de baja después del cierre tiene que seguir en la corrección;
 * un alta posterior no puede aparecer en un período cerrado).
 */
async function computePayrollLines(args: {
  db: DbClient;
  sedeId: string;
  period: PayrollPeriodRow;
  roster: EmployeeRow[];
  input: CalculatePayrollInput;
  voucherScope: VoucherDiscountScope;
  /** Nombre de la operación para el log de una lectura incompleta. */
  log: string;
}): Promise<PayrollLinesResult> {
  const { db, sedeId, period, roster, input, voucherScope, log } = args;
  const periodId = period.id;

    // Facturas vigentes de la sede en el rango (Anulada excluida). El rango
    // lleva offset de Bogotá: sin él la ventana corre 5 h y se pierden las
    // facturas de la noche del último día (comisión no liquidada).
    const invoiceRange = rangeBounds(period.start_date, period.end_date);
    // U5: lectura exhaustiva. El `.limit(2000)` de antes era un tope de
    // TRANSPORTE tomado por tope de negocio: una sede con más facturas en el
    // rango liquidaba comisiones con un conjunto recortado (al empleado le
    // faltaba plata) sin un solo error. Se pagina hasta agotar, con
    // `order("id")` para que dos corridas lean exactamente lo mismo.
    const invoiceRows = await readAllPayroll<{ id: string; consecutive_number: number }>({
      log,
      what: "facturas",
      meta: { periodId },
      table: "invoices",
      fetchPage: (from, to) =>
        db
          .from("invoices")
          .select("id, consecutive_number")
          .eq("sede_id", sedeId)
          .neq("status", "Anulada")
          .gte("created_at", invoiceRange.from)
          .lte("created_at", invoiceRange.to)
          .order("id")
          .range(from, to),
    });
    const consecutiveByInvoice = new Map(invoiceRows.map((row) => [row.id, row.consecutive_number]));

    let lines: BillingLine[] = [];
    if (invoiceRows.length > 0) {
      // U5: mismos dos topes de transporte acá (`.limit(5000)` y la lista de ids
      // en la URL del `in(...)`). Los ids se mandan en lotes para que la URL no
      // reviente en 414, y cada lote se pagina hasta agotar.
      const items: Array<InvoiceItemRow> = [];
      for (const chunk of chunkIds(invoiceRows.map((row) => row.id))) {
        items.push(
          ...(await readAllPayroll<InvoiceItemRow>({
            log,
            what: "ítems de factura",
            meta: { periodId, invoices: invoiceRows.length, ids: chunk.length },
            table: "invoice_items",
            fetchPage: (from, to) =>
              db
                .from("invoice_items")
                .select(
                  "id, invoice_id, item_type, employee_id, qty, unit_price, subtotal, no_commission, commission_value, commission_percent_override, product_id, service_id",
                )
                .in("invoice_id", chunk)
                .order("id")
                .range(from, to),
          })),
        );
      }
      lines = items
        // Solo las líneas con empleado y comisionables: el resto no entra al
        // detalle (es la misma semántica de siempre, ahora sobre el conjunto
        // COMPLETO de ítems).
        .filter(
          (row): row is InvoiceItemRow & { employee_id: string } =>
            Boolean(row.employee_id) && !row.no_commission,
        )
        .map((row) => ({
          invoice_id: row.invoice_id,
          consecutive_number: consecutiveByInvoice.get(row.invoice_id) ?? null,
          item_id: row.id,
          item_type: row.item_type,
          employee_id: row.employee_id,
          qty: Number(row.qty),
          unit_price: Number(row.unit_price),
          line_subtotal: Number(row.subtotal),
          commission_value: row.commission_value ? Number(row.commission_value) : null,
          commission_percent_override:
            row.commission_percent_override != null ? Number(row.commission_percent_override) : null,
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
    // inmediato: sede + empleado + activa). Una sola lectura exhaustiva y se
    // agrupan en memoria para no caer en N+1 sobre la planta del cálculo.
    const rulesByEmployee = new Map<string, Map<string, RuleRate>>();
    if (roster.length > 0) {
      // U5: sin `.limit(5000)`. Una regla que no se lee es una comisión que se
      // liquida de menos (el `porcentaje plano` del empleado o cero, según el
      // ítem): la diferencia sale del bolsillo del empleado y no aparece en
      // ningún error.
      const rules = await readAllPayroll<{
        employee_id: string;
        item_type: string;
        item_id: string;
        percent: number | string | null;
        amount: number | string | null;
      }>({
        log,
        what: "reglas de comisión",
        meta: { periodId, employees: roster.length },
        table: "commission_rules",
        fetchPage: (from, to) =>
          db
            .from("commission_rules")
            .select("employee_id, item_type, item_id, percent, amount")
            .eq("sede_id", sedeId)
            .eq("is_active", true)
            .in(
              "employee_id",
              roster.map((employee) => employee.id),
            )
            .order("id")
            .range(from, to),
      });
      for (const rule of rules) {
        const byItem = rulesByEmployee.get(rule.employee_id) ?? new Map<string, RuleRate>();
        byItem.set(commissionRuleKey(rule.item_type, rule.item_id), {
          percent: rule.percent != null ? Number(rule.percent) : null,
          amount: rule.amount != null ? Number(rule.amount) : null,
        });
        rulesByEmployee.set(rule.employee_id, byItem);
      }
    }

    // Vales del rango que descuentan el neto. El borrador descuenta los
    // pendientes/aprobados (y los marca `descontada`); la corrección además
    // vuelve a descontar los que ESTE período ya descontó (ver
    // `VoucherDiscountScope`).
    // U5: sin `.limit(2000)`. Un vale que no se lee NO se descuenta del neto y
    // queda sin marcar: el descuento se pierde y el vale sigue vigente.
    const voucherRows = await readAllPayroll<{
      id: string;
      employee_id: string;
      amount: number | string;
      status: string;
    }>({
      log,
      what: "vales del periodo",
      meta: { periodId },
      table: "voucher_requests",
      fetchPage: (from, to) =>
        db
          .from("voucher_requests")
          .select("id, employee_id, amount, status")
          .eq("sede_id", sedeId)
          .in("status", voucherStatusesForScope(voucherScope))
          .gte("request_date", period.start_date)
          .lte("request_date", period.end_date)
          .order("id")
          .range(from, to),
    });
    const valesByEmployee = new Map<string, { total: number; ids: string[] }>();
    // Vales que ESTE cálculo descuenta por primera vez (pendiente/aprobada).
    // Los `descontada` que la corrección vuelve a restar NO entran acá: nadie
    // reescribe un vale ya descontado.
    const vouchersToDiscount: string[] = [];
    for (const row of voucherRows) {
      if (!discountsVoucher(row.status, voucherScope)) continue;
      if (canDiscountVoucher(row.status)) vouchersToDiscount.push(row.id);
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
      // U5: sin `.limit(5000)`, con los ids en lotes y por páginas. Un pago
      // inmediato que no se lee no se resta: la comisión se pagaría DOS VECES.
      // Y el error deja de ignorarse en silencio (antes no se miraba `error`).
      for (const chunk of chunkIds(invoiceRows.map((row) => row.id))) {
        const payouts = await readAllPayroll<{ employee_id: string; amount: number | string }>({
          log,
          what: "pagos inmediatos",
          meta: { periodId, invoices: invoiceRows.length, ids: chunk.length },
          table: "commission_payouts",
          fetchPage: (from, to) =>
            db
              .from("commission_payouts")
              .select("employee_id, amount")
              .eq("sede_id", sedeId)
              .in("invoice_id", chunk)
              .order("id")
              .range(from, to),
        });
        for (const row of payouts) {
          paidImmediateByEmployee.set(
            row.employee_id,
            roundMoney((paidImmediateByEmployee.get(row.employee_id) ?? 0) + Number(row.amount)),
          );
        }
      }
    }

    const payload = roster.map((employee) => {
      // PR1: el fijo de un período son SOLO sus días. `salary_fixed` es mensual
      // (003_admin.sql): antes se pagaba completo en cada período y cuatro
      // cierres semanales de un mes pagaban 4 × el sueldo, sin error ni aviso.
      // La porción se calcula por los días del rango (mes por mes, redondeando
      // una sola vez) y la suma de los períodos del mes da el sueldo siempre
      // que no compartan días (de eso se ocupa la guarda de solape).
      const baseFixed =
        employee.pay_type === "fijo" || employee.pay_type === "mixto"
          ? prorateFixedSalary({
              salaryFixed: employee.salary_fixed,
              startDate: period.start_date,
              endDate: period.end_date,
            })
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
          commission_percent_override: line.commission_percent_override,
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

    // Vales que ESTE cálculo descuenta por primera vez (pendiente/aprobada).
    // Los `descontada` que la corrección volvió a restar NO entran acá: nadie
    // reescribe un vale ya descontado.
    return { payload, vouchersToDiscount };
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
 * CL-2: las porciones que YA se registraron con esa marca, si las hay.
 *
 * La marca es un uuid que genera la PANTALLA al empezar el intento de pago y
 * que viaja en el cuerpo; se reutiliza en los reintentos del MISMO intento. El
 * filtro es por ÍTEM: la marca se resuelve dentro del ítem que la usó (el que
 * identifica la URL), así que el lookup nunca puede devolver el pago de otro
 * ítem. Devuelve las filas MARCADAS: para una operación de varias porciones es
 * la fila de IDENTIDAD de la operación, no sus hermanas (no llevan marca: ver
 * 042). El monto real no queda a medias igual —el acumulado se relee aparte—,
 * y es el costo declarado de la opción elegida (la marca en la primera
 * porción, sin columna de ordinal).
 */
async function findPayrollPaymentsByIdempotencyKey(
  db: DbClient,
  itemId: string,
  idempotencyKey: string,
): Promise<PayrollPaymentRow[]> {
  const { data, error } = await db
    .from("payroll_payments")
    .select(`${PAYMENT_SELECT}, idempotency_key`)
    .eq("payroll_item_id", itemId)
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as PayrollPaymentRow[];
}

/**
 * CL-2: total YA pagado del ítem, en peso entero. Es la lectura del acumulado
 * que decide el tope, y la que devuelve el estado real en los caminos donde el
 * servicio NO escribe (repetición reconocida y carrera perdida).
 */
async function readPaidTotal(db: DbClient, itemId: string): Promise<number> {
  const { data, error } = await db
    .from("payroll_payments")
    .select("amount")
    .eq("payroll_item_id", itemId);
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return roundMoney(
    ((data ?? []) as Array<{ amount: number | string }>).reduce(
      (acc, row) => acc + Number(row.amount),
      0,
    ),
  );
}

/**
 * PAY-04: paga un ítem en porciones por método (métodos activos de la
 * sede, montos > 0). Acepta abonos parciales (40% + 40% + 20% en una o
 * varias llamadas); el acumulado nunca excede el neto (además del trigger
 * trg_payroll_payments_cap). Periodo cerrado → PERIOD_CLOSED.
 * Solo admin (vía requirePayrollAdmin en rutas/actions): pagar un ítem es parte
 * de liquidar la nómina, y el módulo de nómina no es de caja.
 *
 * CL-2 (idempotencia): el orden empieza por la MARCA
 * (`idempotency_key`, migración 042), DESPUÉS de las guardas de estado —el
 * período cerrado es un candado de dinero (PAY-01) y va primero— y ANTES de
 * leer el acumulado y de insertar. Un reintento del MISMO envío (doble clic, o
 * el navegador reenviando tras cortarse la red) se reconoce y devuelve el
 * resultado ya registrado como un no-op EXITOSO: no vuelve a pagar. Antes de
 * esto, con 2 × entrante ≤ saldo el reintento pagaba DOS veces, y el tope de
 * 007 no lo veía porque no salta: un tope no es una identidad.
 *
 * Las porciones entran en UNA sola sentencia multi-fila y la marca vive SÓLO en
 * la primera (el resto NULL): por eso el índice único parcial `(payroll_item_id,
 * idempotency_key)` no rechaza a una operación de varias porciones, y el 23505
 * de una repetición aborta la sentencia entera —ninguna porción sobrevive
 * (ver 042, "una operación no es una fila")—.
 *
 * COSTO DECLARADO: acá NO se quema ningún número, porque `payroll_payments` no
 * tiene consecutivo (`id` es uuid). Lo que cuesta la carrera es una sentencia
 * ABORTADA: la perdedora ya había leído el acumulado cuando chocó con el
 * índice, y esa sentencia no deja filas.
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

    // CL-2: la MARCA primero, ANTES de leer el acumulado y antes de cualquier
    // escritura —y antes de revalidar catálogos: una repetición ya registrada no
    // necesita volver a validar el método con el que se pagó entonces—.
    // El candado del período cerrado va antes que esto a propósito: es una
    // guarda de estado sobre el dinero (PAY-01) y no cambia entre el intento y
    // su reintento (pagar no cierra el período).
    const repeated = await findPayrollPaymentsByIdempotencyKey(
      db,
      itemId,
      parsed.data.idempotency_key,
    );
    if (repeated.length > 0) {
      // El intento ya está registrado: no-op EXITOSO para el llamador, con el
      // mismo estado que devolvió la primera vez y CERO escrituras. El total se
      // relee en vez de suponerlo: es el acumulado real del ítem, y por eso el
      // `paid`/`remaining` de la repetición son exactos aunque la operación
      // tuviera varias porciones. `payments` trae las filas MARCADAS (la
      // identidad de la operación): las hermanas no llevan marca y no se
      // pueden atribuir a esta operación sin adivinar (costo declarado de la
      // forma elegida, ver 042).
      const paid = await readPaidTotal(db, itemId);
      const net = roundMoney(Number(item.net_pay));
      return { item, paid, remaining: roundMoney(Math.max(0, net - paid)), payments: repeated };
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

    const alreadyPaid = await readPaidTotal(db, itemId);
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
        // CL-2: UNA sola sentencia multi-fila y la MARCA SÓLO en la primera
        // porción (las demás NULL). Es lo que hace sonora la forma: el índice
        // único parcial (042) no rechaza a una operación legítima de varias
        // porciones, y el 23505 de una repetición aborta la sentencia ENTERA,
        // así que ninguna porción duplicada puede sobrevivir.
        parsed.data.portions.map((portion, index) => ({
          payroll_item_id: itemId,
          method_id: activeByCode.get(portion.method_code)?.id ?? null,
          method_code: portion.method_code,
          amount: roundMoney(Number(portion.amount)),
          paid_by: actor.userId,
          reference: portion.reference?.trim() || null,
          idempotency_key: index === 0 ? parsed.data.idempotency_key : null,
        })),
      )
      .select(PAYMENT_SELECT);
    if (insertError) {
      // Dos barreras pueden rechazar este INSERT, y el código lo dice: el tope
      // de 007 (trigger BEFORE INSERT → P0001) y el índice único parcial de
      // identidad de la 042 (23505).
      if ((insertError as { code?: string }).code === "23505") {
        // Carrera contra el índice: otra operación con la MISMA marca se
        // confirmó entre el lookup de arriba y este INSERT. Su operación es la
        // respuesta y esta no escribe nada —el 23505 aborta la sentencia
        // entera, así que no quedó ninguna porción a medias—.
        //
        // COSTO DECLARADO: acá no se quema ningún número (`payroll_payments` no
        // tiene consecutivo); lo que se pierde es la sentencia abortada. Se
        // prefiere eso —raro, y exige dos envíos con la misma marca solapados—
        // antes que pagar dos veces.
        const winner = await findPayrollPaymentsByIdempotencyKey(
          db,
          itemId,
          parsed.data.idempotency_key,
        );
        if (winner.length > 0) {
          const paid = await readPaidTotal(db, itemId);
          return {
            item,
            paid,
            remaining: roundMoney(Math.max(0, net - paid)),
            payments: winner,
          };
        }
        // Sin operación con esa marca, el choque no es de identidad: es un
        // fallo real y se reporta como tal (no hay "ganadora" que devolver).
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
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

// ------------------------------------------------ nómina extraordinaria (PA-2a) ---

/**
 * PA-2a: registra un pago de nómina INDIVIDUAL por caso extraordinario
 * (despido, renuncia, emergencia del empleado) y lo audita.
 *
 * NO es un período y no toca `payroll_periods`. Existe justamente porque
 * `payPayrollItem` exige un período en BORRADOR (`assertDraftPeriod`): una
 * renuncia un miércoles, por días que ya están dentro de un período CERRADO,
 * no tiene otro camino. Acá no hay período que mirar: el pago se registra por
 * sí mismo, con su MOTIVO (obligatorio) y su TIPO.
 *
 * El monto lo escribe el admin y NO se topa: el sueldo mensual es la base
 * GUÍA (ver `payrollExtraGuide` en schemas.ts), no un límite. Un despido
 * liquida prestaciones y no es la porción del sueldo; una emergencia puede
 * costar más que los días trabajados. La base sólo exige `amount > 0` y un
 * motivo no vacío.
 *
 * Sólo admin (vía requirePayrollAdmin en la action): es nómina, y el módulo de
 * nómina no es de caja.
 *
 * CL-5 (idempotencia): el orden empieza por la MARCA del intento
 * (`idempotency_key`, columna e índice único parcial de la 044) apenas el
 * REGISTRO —el empleado— queda validado dentro de la sede del actor, y ANTES de
 * resolver el método y de insertar. Un reintento del MISMO envío (doble clic, o
 * el navegador reenviando tras cortarse la red) se reconoce y devuelve el pago
 * ya registrado como un no-op EXITOSO: no escribe un segundo pago. Antes de
 * esto no había NADA que lo frenara, porque el monto es a propósito SIN TOPE:
 * no hay obligación contra la cual comparar, así que un reintento era siempre
 * un segundo pago extraordinario.
 *
 * POR QUÉ ACÁ Y NO DESPUÉS DEL MÉTODO: la operación no se identifica por el
 * método —`method_code` es el medio por el que salió el dinero, no lo que el
 * pago ES—, así que no hay razón para hacer esperar a la repetición por una
 * guarda que sólo llena una columna de una escritura que la repetición no hace.
 * La contrapartida es una propiedad, no una limitación: un reintento que llega
 * con el método ya inactivo se reconoce igual (no se duplica ni se pierde
 * plata); lo que sigue rechazándose es un pago NUEVO con el método inactivo
 * (METHOD_INACTIVE).
 *
 * LA ARRUGA DE 042 NO APLICA ACÁ: este camino inserta UNA sola fila (una
 * sentencia de un objeto, no un `insert([...])` de N porciones), así que la
 * marca vive en esa única fila, no hay porciones hermanas que enumerar y el
 * índice único parcial nunca puede rechazar una operación legítima.
 *
 * COSTO DECLARADO: acá NO se quema ningún número (`payroll_extras.id` es un
 * uuid: la tabla no tiene serie ni consecutivo). Lo que cuesta la carrera es una
 * sentencia ABORTADA: la perdedora ya había resuelto el empleado y el método
 * cuando chocó con el índice, y esa sentencia no deja filas. Mismo canje que
 * 041/042/043 —perder trabajo invisible antes que pagar dos veces—.
 */
export async function payPayrollExtra(raw: unknown, actor: PayrollActor): Promise<PayrollExtraRow> {
  const parsed = payrollExtraSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    // El empleado tiene que ser de la sede del actor. `getEmployee` busca por
    // id sin filtrar sede (admin/service), así que la sede se comprueba ACÁ:
    // sin esto un admin podría pagarle a la planta de otra sede. El código de
    // error es el mismo NOT_FOUND de un empleado inexistente, para no revelar
    // la planta de otras sedes.
    const employee = await getEmployee(parsed.data.employee_id).catch((error) => {
      throw toPayrollError(error);
    });
    if (employee.sede_id !== actor.sedeId) {
      throw new PayrollError("NOT_FOUND", "Empleado no encontrado.", 404);
    }

    // CL-5: la MARCA del intento, apenas el empleado queda validado dentro de la
    // sede del actor y ANTES de cualquier escritura. Un reintento del MISMO envío
    // trae la misma marca: se devuelve el pago ya registrado, sin escribir un
    // segundo pago extraordinario. Acá no hay pendiente ni tope contra el cual
    // comparar (el monto lo escribe el admin y no se topa), así que la IDENTIDAD
    // del envío es la única barrera posible: no hay nada más que mirar.
    const repeated = await findPayrollExtraByIdempotencyKey(
      db,
      parsed.data.employee_id,
      parsed.data.idempotency_key,
    );
    if (repeated) return repeated;

    const methods = await listPaymentMethods(actor.sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    const method = methods.find((row) => row.is_active && row.code === parsed.data.method_code);
    if (!method) {
      throw new PayrollError(
        "METHOD_INACTIVE",
        `El método de pago ${parsed.data.method_code} no está activo en esta sede.`,
        422,
      );
    }

    const amount = roundMoney(Number(parsed.data.amount));
    const reference = parsed.data.reference?.trim() || null;
    const daysFrom = parsed.data.days_from ?? null;
    const daysTo = parsed.data.days_to ?? null;

    const { data, error } = await db
      .from("payroll_extras")
      .insert({
        sede_id: actor.sedeId,
        employee_id: parsed.data.employee_id,
        amount,
        method_id: method.id,
        method_code: parsed.data.method_code,
        reference,
        reason: parsed.data.reason,
        kind: parsed.data.kind,
        days_from: daysFrom,
        days_to: daysTo,
        paid_by: actor.userId,
        // CL-5: la marca del intento. Es la identidad de ESTA operación dentro
        // del empleado: el índice único parcial de la 044 y el lookup de arriba
        // usan la misma clave. Sin ella no habría forma de distinguir "el mismo
        // envío" de "dos pagos extraordinarios legítimos al mismo empleado".
        idempotency_key: parsed.data.idempotency_key,
      })
      .select(EXTRA_SELECT)
      .single();
    if (error || !data) {
      // CL-5: carrera perdida contra el índice único parcial de la 044 (23505).
      // El lookup de arriba y este INSERT no son atómicos: si otro envío con la
      // MISMA marca para el MISMO empleado se confirmó en esa ventana, la
      // repetición se relee y se devuelve. Sin ganadora, el 23505 no es una
      // repetición y se reporta como fallo real en vez de disfrazarlo.
      if ((error as { code?: string } | null)?.code === "23505") {
        const winner = await findPayrollExtraByIdempotencyKey(
          db,
          parsed.data.employee_id,
          parsed.data.idempotency_key,
        );
        if (winner) return winner;
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    const row = data as PayrollExtraRow;

    // PA-2a: la plata que sale sin un período detrás tiene que poder
    // explicarse. Se audita el empleado, el monto, el TIPO, el MOTIVO y el
    // medio de pago (más los días liquidados, si se indicaron).
    await writeAudit({
      sede_id: actor.sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.PAYROLL_EXTRA_PAID,
      entity: "payroll_extras",
      entity_id: row.id,
      metadata: {
        employee_id: parsed.data.employee_id,
        amount,
        kind: parsed.data.kind,
        reason: parsed.data.reason,
        method_code: parsed.data.method_code,
        reference,
        days_from: daysFrom,
        days_to: daysTo,
      },
    });

    return row;
  } catch (error) {
    throw toPayrollError(error);
  }
}

/**
 * PA-2a: pagos extraordinarios de la sede, del más reciente al más viejo. Es
 * la cara VISIBLE del registro (el módulo de nómina), no sólo la auditoría.
 * Lectura exhaustiva (U5): son pocos y un listado recortado en silencio
 * mostraría menos plata pagada de la que salió.
 */
export async function listPayrollExtras(sedeId: string): Promise<PayrollExtraRow[]> {
  try {
    const db = await payrollDb();
    return await readAllPayroll<PayrollExtraRow>({
      log: "listPayrollExtras",
      what: "pagos extraordinarios",
      meta: { sedeId },
      table: "payroll_extras",
      fetchPage: (from, to) =>
        db
          .from("payroll_extras")
          .select(EXTRA_SELECT)
          .eq("sede_id", sedeId)
          .order("paid_at", { ascending: false })
          // `id` desempata: dos pagos con el mismo timestamp no pueden caer en
          // páginas distintas (ni repetirse ni faltar).
          .order("id")
          .range(from, to),
    });
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

// ------------------------------------------- corrección de un período cerrado ---

/**
 * PA-2b: CORRIGE un período CERRADO sin reabrirlo, sin pisarlo y sin borrar
 * nada. Es el mismo problema que el reconteo de turno (033) resuelto para la
 * nómina: el original queda firmado y la corrección es un registro propio.
 *
 * EL HUECO QUE CIERRA. Un período cerrado no tiene salida cuando su liquidación
 * quedó mal:
 *   * no se puede borrar —`assertDeletablePeriod` exige `borrador`—;
 *   * no se puede recalcular —`assertDraftPeriod` exige `borrador`—;
 *   * no se pueden volver a nominar sus días —la restricción de exclusión de
 *     035 cubre TODOS los estados—.
 * Antes de 035 el camino era abrir un segundo período sobre los mismos días, y
 * ESE camino era el defecto: pagaba dos veces los mismos días. Hoy no hay
 * camino, y este es el que corresponde.
 *
 * QUÉ HACE. Recalcula la liquidación del período con las REGLAS VIGENTES
 * (`computePayrollLines`, la misma aritmética de `calculatePayroll`: incluye la
 * prorata del fijo por los días del rango) sobre los empleados que el período
 * YA liquidó, y guarda las DOS versiones:
 *   * la ANTERIOR congelada (los montos firmados de cada ítem, más lo pagado);
 *   * la CORREGIDA (lo que dicen las reglas hoy).
 * El motivo es obligatorio, queda el actor y el momento, y hay UNA corrección
 * por período (índice único): la corrección también queda firmada.
 *
 * QUÉ NO HACE (la decisión del dueño, no un olvido). NO mueve plata: no paga,
 * no descuenta, no genera un ajuste, no arrastra el saldo al período siguiente
 * y no toca `payroll_payments` ni `payroll_extras`. Muestra la diferencia
 * (`pagado − neto corregido`); saldarla es un acto HUMANO, con el pago
 * extraordinario que ya existe (`payPayrollExtra`, migración 036) y un motivo
 * que diga que es el ajuste por la corrección del período. Un claw-back
 * automático sería un movimiento de dinero que nadie pidió.
 *
 * POR QUÉ LA CORRECCIÓN NO PUEDE MOVER PLATA AUNQUE QUIERA: un período cerrado
 * no se puede pagar desde el sistema. `payPayrollItem` exige un borrador
 * (`assertDraftPeriod`, PERIOD_CLOSED) y el único camino que escribe
 * `payroll_payments` es ése. Aplicar los montos corregidos al registro cambia lo
 * que el registro dice que se DEBÍA, no lo que se pagó ni lo que se puede pagar.
 *
 * NO ESCRIBE EN LOS VALES. El recálculo vuelve a descontar del neto los vales
 * que ESTE período ya descontó (si no, el neto corregido perdería ese descuento
 * y subiría por una razón ajena a la corrección), pero no marca ni revierte
 * ninguno: los vales ya quedaron en `descontada` al liquidar y ahí siguen.
 *
 * Solo admin (vía `requirePayrollAdmin` en la action): es nómina.
 */
export async function correctPayrollPeriod(
  sedeId: string,
  periodId: string,
  raw: unknown,
  actor: PayrollActor,
): Promise<PayrollPeriodCorrectionResult> {
  const parsed = correctPayrollPeriodSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayrollError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await payrollDb();
  try {
    const period = await getPeriodOrThrow(db, sedeId, periodId);
    try {
      assertCorrectablePeriod(period.status);
    } catch (error) {
      throw toPayrollError(error);
    }

    // Una corrección por período: la corrección también queda firmada y no se
    // apila una segunda encima (eso volvería a dejar la última versión editable
    // en el lugar, el mismo defecto un nivel más abajo).
    const { data: existing, error: existingError } = await db
      .from("payroll_period_corrections")
      .select("id")
      .eq("period_id", periodId)
      .maybeSingle();
    if (existingError) throw new PayrollError("INTERNAL", "Error interno.", 500);
    if (existing) {
      throw new PayrollError(
        "ALREADY_CORRECTED",
        "Este período ya fue corregido. La corrección también quedó firmada y no se modifica.",
        409,
      );
    }

    // Versión ANTERIOR: los ítems firmados del período, con lo pagado de cada
    // uno resuelto por la MISMA lectura del detalle (una sola forma de calcular
    // "pagado" en el módulo).
    const detail = await getPeriodDetail(sedeId, periodId);
    const previousItems = detail.items;
    if (previousItems.length === 0) {
      throw new PayrollError(
        "NOTHING_TO_CORRECT",
        "El período no tiene ítems liquidados: no hay liquidación que corregir.",
        409,
      );
    }

    // El cálculo corre sobre los empleados que el período YA liquidó, no sobre
    // la planta activa de hoy: un empleado dado de baja después del cierre
    // tiene que seguir en la corrección, y un alta posterior no puede aparecer
    // en un período que ya se cerró.
    const roster = await listAllEmployees(sedeId).catch((error) => {
      throw toPayrollError(error);
    });
    const employeeById = new Map(roster.map((row) => [row.id, row]));
    const correctionRoster: EmployeeRow[] = [];
    for (const item of previousItems) {
      const employee = employeeById.get(item.employee_id);
      if (!employee) {
        throw new PayrollError(
          "INTERNAL",
          "No se pudo corregir: un empleado de la liquidación no está en la planta de la sede.",
          500,
        );
      }
      correctionRoster.push(employee);
    }

    // Los ajustes MANUALES (bonos y otros descuentos) no se recalculan: son una
    // decisión que quedó escrita en la liquidación firmada, no el resultado de
    // una regla. Se vuelven a aplicar tal como estaban para que la corrección
    // cambie lo que cambian las reglas y no borre un bono por el camino.
    const input: CalculatePayrollInput = {
      adjustments: previousItems.map((item) => ({
        employee_id: item.employee_id,
        bonuses: roundMoney(Number(item.bonuses)),
        other_discounts: roundMoney(Number(item.other_discounts)),
      })),
    };

    const { payload } = await computePayrollLines({
      db,
      sedeId,
      period,
      roster: correctionRoster,
      input,
      // Vuelve a descontar los vales que este período ya descontó, y NO marca
      // ninguno (ver `correctPayrollPeriod` arriba).
      voucherScope: "vigentes_y_descontados",
      log: "correctPayrollPeriod",
    });

    const view = buildPayrollCorrectionView({
      previous: previousItems,
      corrected: payload,
      paidByEmployee: new Map(
        previousItems.map((item) => [item.employee_id, Number(item.paid ?? 0)]),
      ),
    });

    const { data: inserted, error } = await db
      .from("payroll_period_corrections")
      .insert({
        period_id: periodId,
        previous_net_total: view.previousNetTotal,
        previous_paid_total: view.paidTotal,
        corrected_net_total: view.correctedNetTotal,
        previous_item_count: previousItems.length,
        corrected_item_count: payload.length,
        reason: parsed.data.reason,
        corrected_by: actor.userId,
      })
      .select(PERIOD_CORRECTION_SELECT)
      .single();
    if (error || !inserted) {
      // Carrera perdida contra el índice único por período: otra corrección ganó.
      if ((error as { code?: string } | null)?.code === "23505") {
        throw new PayrollError(
          "ALREADY_CORRECTED",
          "Este período ya fue corregido. La corrección también quedó firmada y no se modifica.",
          409,
        );
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    const correction = inserted as PayrollPeriodCorrectionRow;

    // Las dos versiones por empleado, en la misma tabla de la corrección: la
    // fila es autocontenida y no depende de `payroll_items` (que sigue siendo
    // el original firmado).
    const { error: itemsError } = await db.from("payroll_period_correction_items").insert(
      view.rows.map((row) => ({
        correction_id: correction.id,
        employee_id: row.employee_id,
        previous_base_fixed: roundMoney(Number(row.previous.base_fixed)),
        previous_commissions: roundMoney(Number(row.previous.commissions)),
        previous_bonuses: roundMoney(Number(row.previous.bonuses)),
        previous_deductions_vales: roundMoney(Number(row.previous.deductions_vales)),
        previous_other_discounts: roundMoney(Number(row.previous.other_discounts)),
        previous_net_pay: roundMoney(Number(row.previous.net_pay)),
        previous_paid: roundMoney(Number(row.paid)),
        corrected_base_fixed: roundMoney(Number(row.corrected.base_fixed)),
        corrected_commissions: roundMoney(Number(row.corrected.commissions)),
        corrected_bonuses: roundMoney(Number(row.corrected.bonuses)),
        corrected_deductions_vales: roundMoney(Number(row.corrected.deductions_vales)),
        corrected_other_discounts: roundMoney(Number(row.corrected.other_discounts)),
        corrected_net_pay: roundMoney(Number(row.corrected.net_pay)),
      })),
    );
    if (itemsError) throw new PayrollError("INTERNAL", "Error interno.", 500);

    // La auditoría lleva el motivo y los totales de las DOS versiones: un
    // auditor tiene que poder leer qué cambió sin abrir la pantalla.
    await writeAudit({
      sede_id: sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.PAYROLL_PERIOD_CORRECTED,
      entity: "payroll_periods",
      entity_id: periodId,
      metadata: {
        correction_id: correction.id,
        reason: parsed.data.reason,
        start_date: period.start_date,
        end_date: period.end_date,
        previous_net_total: view.previousNetTotal,
        corrected_net_total: view.correctedNetTotal,
        previous_paid_total: view.paidTotal,
        difference_total: view.differenceTotal,
      },
    });

    return { period, correction, view };
  } catch (error) {
    throw toPayrollError(error);
  }
}

/**
 * PA-2b: la corrección de un período (si existe), con las dos versiones ya
 * comparadas. `null` = el período no fue corregido. Solo admin (la action).
 */
export async function getPayrollPeriodCorrection(
  sedeId: string,
  periodId: string,
): Promise<PayrollPeriodCorrectionResult | null> {
  const db = await payrollDb();
  try {
    const period = await getPeriodOrThrow(db, sedeId, periodId);
    const { data, error } = await db
      .from("payroll_period_corrections")
      .select(PERIOD_CORRECTION_SELECT)
      .eq("period_id", periodId)
      .maybeSingle();
    if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
    if (!data) return null;
    const correction = data as PayrollPeriodCorrectionRow;

    // Lectura exhaustiva: la corrección es el registro de una diferencia de
    // plata y una lectura recortada mostraría menos de lo que se corrigió.
    const items = await readAllPayroll<PayrollPeriodCorrectionItemRow>({
      log: "getPayrollPeriodCorrection",
      what: "ítems de la corrección",
      meta: { periodId, correctionId: correction.id },
      table: "payroll_period_correction_items",
      fetchPage: (from, to) =>
        db
          .from("payroll_period_correction_items")
          .select(PERIOD_CORRECTION_ITEM_SELECT)
          .eq("correction_id", correction.id)
          .order("employee_id")
          .order("id")
          .range(from, to),
    });

    const view = buildPayrollCorrectionView({
      previous: items.map((row) => ({
        employee_id: row.employee_id,
        base_fixed: row.previous_base_fixed,
        commissions: row.previous_commissions,
        bonuses: row.previous_bonuses,
        deductions_vales: row.previous_deductions_vales,
        other_discounts: row.previous_other_discounts,
        net_pay: row.previous_net_pay,
      })),
      corrected: items.map((row) => ({
        employee_id: row.employee_id,
        base_fixed: row.corrected_base_fixed,
        commissions: row.corrected_commissions,
        bonuses: row.corrected_bonuses,
        deductions_vales: row.corrected_deductions_vales,
        other_discounts: row.corrected_other_discounts,
        net_pay: row.corrected_net_pay,
      })),
      paidByEmployee: new Map(items.map((row) => [row.employee_id, Number(row.previous_paid)])),
    });

    return { period, correction, view };
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
  // U5: sin `.limit(1000)`. El acumulado que decide el tope día/semana tiene
  // que ser el REAL: con un acumulado recortado el tope se evade (se aprueba un
  // vale por encima del límite de la sede).
  const data = await readAllPayroll<{ amount: number | string; request_date: string }>({
    log: "vigenteTotals",
    what: "vales vigentes",
    meta: { sedeId, employeeId, weekStart, weekEnd },
    table: "voucher_requests",
    fetchPage: (from, to) =>
      db
        .from("voucher_requests")
        .select("amount, request_date")
        .eq("sede_id", sedeId)
        .eq("employee_id", employeeId)
        .in("status", ["pendiente", "aprobada"])
        .gte("request_date", weekStart)
        .lte("request_date", weekEnd)
        .order("id")
        .range(from, to),
  });
  let dayTotal = 0;
  let weekTotal = 0;
  for (const row of data) {
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
 * CL-5: el vale que YA se registró con esa marca, PARA ESE EMPLEADO.
 *
 * La marca es un uuid que acuña la pantalla de vales al empezar el intento y
 * que reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `requestVoucherSchema` (schemas.ts). El filtro es por
 * EMPLEADO: el vale es una OBLIGACIÓN del empleado —es lo que la nómina
 * descuenta y es la dimensión de los topes acumulados de 026
 * (`idx_voucher_requests_employee_date`)—, así que el registro de la operación
 * es el empleado y el lookup nunca puede devolver el vale de otra persona. La
 * clave del índice de la 044 es la MISMA (`employee_id, idempotency_key`): el
 * `eq` de este lookup y la clave del índice son el mismo conjunto, así que este
 * lookup no puede devolver una fila que el índice no habría bloqueado.
 *
 * EL TURNO NO ENTRA EN LA CLAVE, a propósito: el turno es el dueño del EFECTIVO
 * que sale (y es lo que suma el arqueo), pero no es lo que el vale ES, y
 * meterlo costaría el defecto mismo: un reintento que llegue después de que el
 * turno original se cerró y se abrió OTRO resolvería contra el turno nuevo, no
 * encontraría su marca ahí y abriría el SEGUNDO vale que esta puerta existe
 * para evitar. Sin el turno en la clave, ese reintento se reconoce. La
 * seguridad de sede no se pierde por eso: el servicio valida que el empleado
 * sea de la sede del actor (uno ajeno es NOT_FOUND) ANTES de llegar acá, así
 * que este lookup no puede cruzar de sede. La misma marca para dos empleados
 * son DOS operaciones.
 */
async function findVoucherRequestByIdempotencyKey(
  db: DbClient,
  employeeId: string,
  idempotencyKey: string,
): Promise<VoucherRequestRow | null> {
  const { data, error } = await db
    .from("voucher_requests")
    .select(await resolveVoucherSelect(db))
    .eq("employee_id", employeeId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new PayrollError("INTERNAL", "Error interno.", 500);
  return data ? normalizeVoucher(data as unknown as Record<string, unknown>) : null;
}

/**
 * CL-5: el resultado de una repetición reconocida: el VALE que ya existe y su
 * ESTADO, sin escribir nada.
 *
 * La repetición NO vuelve a evaluar la elegibilidad, y es deliberado: los topes
 * de 026 son ACUMULADOS y reevaluarlos con los totales de AHORA respondería
 * otra pregunta —podría decir "hoy el tope ya está lleno" sobre un vale que se
 * abrió cuando no lo estaba—. Lo que sí es exacto es la fila y su estado:
 * `requires_approval` es "el vale sigue esperando al admin" y `auto_approved`
 * es "el vale entró aprobado y es utilizable de una", que es lo que la pantalla
 * necesita para decir la verdad. Los tres flags de RANGO son los INSUMOS de la
 * decisión original —el admin los ve en la auditoría de la alerta, escrita al
 * solicitar—, no estado guardado en la fila: se devuelven en falso y el estado
 * del vale es el que manda. Queda declarado, no escondido.
 */
function repeatedVoucherResult(repeated: VoucherRequestRow): VoucherRequestResult {
  const approved = repeated.status === "aprobada";
  return {
    voucher: repeated,
    requires_approval: repeated.status === "pendiente",
    over_day: false,
    over_week: false,
    day_not_allowed: false,
    auto_approved: approved,
  };
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
 *
 * CL-5 (idempotencia): el orden resuelve primero al DUEÑO del registro (el
 * empleado, que tiene que ser de la sede del actor) y las guardas de la caja
 * (turno abierto y ser su dueño o admin), DESPUÉS mira la MARCA del intento
 * (`idempotency_key`, columna e índice único parcial de la 044) y recién
 * entonces resuelve el método y evalúa los topes. Un reintento del MISMO envío
 * (doble clic, o el navegador reenviando tras cortarse la red) se reconoce y
 * devuelve el vale ya registrado como un no-op EXITOSO: no abre un segundo vale
 * —ni una segunda salida de caja en el arqueo ni un segundo descuento en la
 * nómina—. Antes de esto no había nada que lo frenara: los topes de 026 son
 * ACUMULADOS, así que mientras `2 × monto` cupiera el reintento entraba.
 *
 * POR QUÉ ACÁ Y NO MÁS ARRIBA: la marca se resuelve dentro del EMPLEADO, que es
 * el registro de la operación (la obligación que descuenta la nómina y la
 * dimensión de los topes de 026), así que el empleado tiene que estar validado
 * dentro de la sede del actor antes del lookup —si no, el lookup podría devolver
 * el vale de otra sede—. Las guardas de la CAJA van primero porque son las que
 * deciden si esta caja puede entregar dinero; la contrapartida, declarada como
 * en CL-3/CL-4: un reintento que llegue con el turno ya CERRADO, o con la caja
 * abierta a nombre de otro, recibe el rechazo de estado
 * (NO_OPEN_SHIFT/SHIFT_NOT_OWNER) en vez del reconocimiento. El caso real del
 * reintento —doble clic, o el navegador tras cortarse la red— ocurre segundos
 * después, con la misma caja abierta, y ahí la marca SÍ reconoce. No se pierde
 * plata: el rechazo es ruidoso y, con la caja abierta de nuevo, la misma marca
 * sigue reconociendo (la clave no lleva el turno, así que un reintento con OTRO
 * turno abierto también se reconoce).
 *
 * POR QUÉ ANTES DE LOS TOPES: se evita la familia de error que CL-3 documentó
 * —un reintento rechazado "por pasarse del tope" cuando en realidad la
 * operación ya está registrada— y, sobre todo, se evita que el propio tope
 * ACUMULADO del reintento sea el que decide: el acumulado ya incluye el vale del
 * primer intento, así que el reintento es precisamente el caso en que la
 * aritmética engañaría. Ver `repeatedVoucherResult` para qué se devuelve.
 *
 * LA ARRUGA DE 042 NO APLICA ACÁ: este camino inserta UNA sola fila (una
 * sentencia de un objeto), así que la marca vive en esa única fila, no hay
 * porciones hermanas que enumerar y el índice único parcial nunca puede
 * rechazar una operación legítima.
 *
 * COSTO DECLARADO: acá NO se quema ningún número (`voucher_requests.id` es un
 * uuid: la tabla no tiene serie ni consecutivo). Lo que cuesta la carrera es una
 * sentencia ABORTADA: la perdedora ya había resuelto el empleado, la caja y su
 * método cuando chocó con el índice, y esa sentencia no deja filas.
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
    // CL-5: el EMPLEADO es el registro de la operación, así que se resuelve (y
    // se valida contra la sede del actor) ANTES de mirar la marca: es lo que
    // impide que el lookup devuelva el vale de otra sede. El orden de las dos
    // guardas —turno y empleado— sólo cambia CUÁL de los dos errores ve una
    // petición que incumple los dos; el empleado va primero porque es el registro
    // que la marca necesita.
    const employee = await getEmployee(parsed.data.employee_id).catch((error) => {
      throw toPayrollError(error);
    });
    try {
      resolveSede(actor.sedeId, employee.sede_id);
    } catch (error) {
      throw toPayrollError(error);
    }
    // CL-5: la MARCA del intento, antes de resolver el método, antes de evaluar
    // los topes acumulados y antes de cualquier escritura. Un reintento del
    // MISMO envío trae la misma marca: se devuelve el vale ya registrado, sin
    // abrir un segundo vale (segunda salida de caja y segundo descuento).
    const repeated = await findVoucherRequestByIdempotencyKey(
      db,
      employee.id,
      parsed.data.idempotency_key,
    );
    if (repeated) return repeatedVoucherResult(repeated);
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
    // Día del vale en hora de Bogotá: el default de la BD (CURRENT_DATE) usa
    // el día UTC y a partir de las 19:00 COT adelanta la fecha un día.
    const requestDate = parsed.data.request_date ?? bogotaDay();
    const settings = await getVoucherSettings(actor.sedeId);
    const { dayTotal, weekTotal } = await vigenteTotals(
      db,
      actor.sedeId,
      employee.id,
      requestDate,
      settings,
    );
    // Dinero que se persiste: peso entero. Se normaliza UNA vez y es el mismo
    // valor para la elegibilidad, el tope de caja y la fila guardada (lo que
    // se valida es lo que se guarda).
    const voucherAmount = roundMoney(parsed.data.amount);
    const eligibility = checkVoucherEligibility({
      dayTotal,
      weekTotal,
      requested: voucherAmount,
      maxPerDay: settings?.max_per_day == null ? null : Number(settings.max_per_day),
      maxPerWeek: settings?.max_per_week == null ? null : Number(settings.max_per_week),
      requestDate,
      allowedDays: settings?.allowed_days ?? null,
      perDayLimits: settings?.per_day_limits ?? null,
    });
    // Dentro de rango → directo; fuera de rango (topes/día) → pendiente.
    const status = resolveVoucherInitialStatus(eligibility);
    // Fuera de rango (topes/día) queda pendiente y abre la alerta del admin;
    // dentro de rango sale directo. Mismo criterio que usa el cierre de la alerta.
    const autoApproved = !voucherAlertRequired(status);
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
        amount: voucherAmount,
      });
      if (violation) throw new PayrollError(violation.code, violation.message, 422);
    }
    const { data, error } = await db
      .from("voucher_requests")
      .insert({
        sede_id: actor.sedeId,
        employee_id: employee.id,
        amount: voucherAmount,
        request_date: requestDate,
        status,
        approved_by: autoApproved ? actor.userId : null,
        observation,
        ...(hasMethodColumns ? { method_code: method.code, cash_shift_id: openShift.id } : {}),
        ...(hasCreatedByColumn ? { created_by: actor.userId } : {}),
        // CL-5: la marca del intento. Es la identidad de ESTA operación dentro
        // del empleado: el índice único parcial de la 044 y el lookup de arriba
        // usan la misma clave. Sin ella, un reintento era siempre un segundo
        // vale —segunda salida de caja y segundo descuento de nómina— porque
        // los topes de 026 son acumulados, no identidad.
        idempotency_key: parsed.data.idempotency_key,
      })
      .select(voucherSelect)
      .single();
    if (error || !data) {
      // CL-5: carrera perdida contra el índice único parcial de la 044 (23505).
      // El lookup de arriba y este INSERT no son atómicos: si otro envío con la
      // MISMA marca para el MISMO empleado se confirmó en esa ventana, la
      // repetición se relee y se devuelve. Sin ganadora, el 23505 no es una
      // repetición y se reporta como fallo real en vez de disfrazarlo.
      if ((error as { code?: string } | null)?.code === "23505") {
        const winner = await findVoucherRequestByIdempotencyKey(
          db,
          employee.id,
          parsed.data.idempotency_key,
        );
        if (winner) return repeatedVoucherResult(winner);
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
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
    // T8: marca si el vale superó topes (reproduce el chequeo de solicitud
    // descontando el propio vale del acumulado vigente que lo incluye).
    //
    // U7: esto se evalúa ANTES de aprobar y su fallo es FATAL. Antes iba después
    // del UPDATE y dentro de un `catch {}` que dejaba `over_tope: false`: el
    // registro de auditoría afirmaba "no superó topes" cuando el chequeo NO SE
    // PUDO EVALUAR —una marca que miente justo en el control de topes—.
    //
    // Se eligió el fallo fatal (y no una marca del tipo "no evaluado") porque el
    // acumulado que decide el tope sale de la MISMA tabla `voucher_requests` que
    // la aprobación escribe: si esa lectura no se completa, la escritura tampoco
    // es confiable. Así el vale queda pendiente, el admin reintenta, y la
    // auditoría solo conoce `true` o `false` verificados. De paso, evaluarlo
    // antes del UPDATE es lo que hace que rechazar no deje un vale aprobado sin
    // auditoría ni alerta resuelta.
    const settings = await getVoucherSettings(sedeId);
    const totals = await vigenteTotals(
      db,
      sedeId,
      voucher.employee_id,
      voucher.request_date,
      settings,
    ).catch((error) => {
      throw toPayrollError(error);
    });
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
    const overTope = requiresVoucherApproval(caps);
    const { data, error } = await db
      .from("voucher_requests")
      .update({
        status: "aprobada",
        approved_by: actor.userId,
        observation,
      })
      .eq("id", id)
      // U8: el estado LEÍDO es la precondición del UPDATE (compare-and-swap,
      // igual que el cierre de caja y la anulación de factura). Sin esta guarda,
      // una nómina que marca el vale `descontada` entre la lectura y esta
      // escritura —el descuento SÍ guarda con `.in("status", ["pendiente",
      // "aprobada"])`— quedaba pisada por `aprobada`: el vale se volvía a
      // descontar en un período posterior y, a la vez, quedaba contado como
      // salida de caja. El empleado cobraba de menos dos veces o la caja
      // mostraba una salida fantasma.
      .eq("status", voucher.status)
      .select(await resolveVoucherSelect(db))
      .single();
    if (error || !data) {
      // Carrera perdida contra la guarda de estado (PGRST116 = `.single()` sin
      // filas, el patrón del cliente Supabase: el mismo que usan el cierre de
      // caja —SHIFT_ALREADY_CLOSED— y la anulación de factura —ANNUL_CONFLICT—).
      const errorCode = (error as { code?: string } | null)?.code;
      if (errorCode === "PGRST116") {
        throw new PayrollError(
          "VOUCHER_CONFLICT",
          "El vale cambió de estado mientras se revisaba (posible descuento en nómina simultáneo). No se aprobó nada: vuelva a cargar el vale y revíselo de nuevo.",
          409,
        );
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
    const [approved] = await attachVoucherUserNames(db, [
      normalizeVoucher(data as unknown as Record<string, unknown>),
    ]);
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
    // La alerta abierta por la solicitud fuera de rango queda resuelta:
    // aprobado el vale, ya no hay nada pendiente de revisar.
    await resolveVoucherAlert(
      sedeId,
      id,
      actor.userId,
      voucherAlertResolutionNote("aprobada"),
    );
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
      // U8: misma guarda que la aprobación y por la misma razón. Acá el daño es
      // el espejo: pisar `descontada` con `rechazada` deja un vale que YA se le
      // descontó al empleado (y que quizá ya salió de caja) marcado como si
      // nunca hubiera entrado en nómina, sin camino de reversión.
      .eq("status", voucher.status)
      .select(await resolveVoucherSelect(db))
      .single();
    if (error || !data) {
      // Carrera perdida contra la guarda de estado (PGRST116 = `.single()` sin
      // filas, el patrón del cliente Supabase).
      const errorCode = (error as { code?: string } | null)?.code;
      if (errorCode === "PGRST116") {
        throw new PayrollError(
          "VOUCHER_CONFLICT",
          "El vale cambió de estado mientras se revisaba (posible descuento en nómina simultáneo). No se rechazó nada: vuelva a cargar el vale y revíselo de nuevo.",
          409,
        );
      }
      throw new PayrollError("INTERNAL", "Error interno.", 500);
    }
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
    // Rechazado el vale, su alerta pendiente deja de aplicar.
    await resolveVoucherAlert(
      sedeId,
      id,
      actor?.userId ?? null,
      voucherAlertResolutionNote("rechazada", parsed.data.motivo),
    );
    return rejected;
  } catch (error) {
    throw toPayrollError(error);
  }
}

// Re-export puro usado por rutas/UI para el mensaje de suma exacta.
export { assertPortionsMatchNet };
