import {
  annulInvoiceSchema,
  assertEditReconciles,
  buildInvoiceOutReason,
  buildReversalReasons,
  canAnnulStatus,
  computeCardFees,
  computeInvoiceTotals,
  computeLineSubtotal,
  createInvoiceSchema,
  annulBlockedMessage,
  diffInvoiceItems,
  editEmittedInvoiceSchema,
  editInvoiceSchema,
  editItemsSubtotal,
  moneyEquals,
  MONEY_EPSILON,
  normalizeCommissionFields,
  overCollectedEdit,
  overCollectedEditMessage,
  portionsMatchBalance,
  roundMoney,
  splitPaymentSchema,
  type CreateInvoiceInput,
  type InvoiceItemInput,
  type PaymentPortionInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import {
  requireSedeRole,
  resolveSede,
} from "@/src/shared/lib/sede";
import { dayBounds } from "@/src/shared/lib/dates";
import { listPaymentMethods, listServices, listTaxes } from "@/src/features/admin/service";
import {
  deductStock,
  getProductsStock,
  registerMovement,
  InventoryError,
  type StockEntry,
} from "@/src/features/inventory/service";
import { planStockDeduction } from "@/src/features/inventory/schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import {
  chunkIds,
  IN_FILTER_CHUNK_SIZE,
  PagedReadError,
  readAllPaged,
  readPagedBatches,
} from "@/src/shared/lib/paged";
import { getOpenShiftWithOpener } from "@/src/features/cash/service";
import { commissionRuleKey, type RuleRate } from "@/src/features/commissions/schemas";
import { computeInvoiceItemCommission } from "./commission";

export class BillingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function billingDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

type DbClient = Awaited<ReturnType<typeof billingDb>>;

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Roles que pueden emitir/cobrar/anular (lectura: cualquier rol de la sede). */
const WRITER_ROLES: RoleCode[] = ["admin", "caja"];

/**
 * §10 Factura: escritura solo admin/caja de su sede; lectura cualquier
 * rol autenticado de su sede (las rutas y actions aplican este gate).
 * La anulación la restringe además el servicio (solo admin, FAC-04).
 */
export async function requireBillingWriter(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new BillingError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  requireSedeRole(session.roles, WRITER_ROLES);
  if (!session.user.sede_id) {
    throw new BillingError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

// ------------------------------------------------------------------- filas ---

export interface InvoiceRow {
  id: string;
  sede_id: string;
  consecutive_number: number;
  client_name: string | null;
  client_document: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  surcharge: number;
  total: number;
  status: string;
  user_id: string | null;
  cash_shift_id: string | null;
  closed_by: string | null;
  closed_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  item_type: string;
  product_id: string | null;
  service_id: string | null;
  custom_name: string | null;
  employee_id: string;
  employee_full_name: string | null;
  employee_code: string | null;
  qty: number;
  unit_price: number;
  discount: number;
  subtotal: number;
  no_commission: boolean;
  commission_value: number | null;
  /** Modo de comisión explícito (030): comision | porcentaje | ninguna | null. */
  commission_mode: string | null;
  /** Porcentaje explícito de la línea (personalizado por porcentaje, pago fijo). */
  commission_percent_override: number | null;
  /**
   * Comisión calculada de la línea (solo lectura, no se persiste). null = no
   * calculable (sin empleado); número = monto en moneda. Misma regla que
   * nómina: ver `computeInvoiceItemCommission` en ./commission.
   */
  commission_amount: number | null;
}

export interface InvoiceTaxRow {
  id: string;
  invoice_id: string;
  tax_code: string;
  tax_name: string;
  percent: number;
  amount: number;
}

export interface InvoicePaymentRow {
  id: string;
  invoice_id: string;
  method_id: string | null;
  method_code: string;
  amount: number;
  fee_percent: number;
  fee_amount: number;
  cash_shift_id: string | null;
  created_at: string;
}

export interface InvoiceDetail {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  taxes: InvoiceTaxRow[];
  payments: InvoicePaymentRow[];
  /** BRUTO cobrado = Σ invoice_payments.amount (019: la porción guarda bruto). */
  paid: number;
  /** Saldo cobrable NETO = (total − surcharge) − Σ(amount − fee_amount). */
  remaining: number;
}

const INVOICE_SELECT =
  "id, sede_id, consecutive_number, client_name, client_document, subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id, closed_by, closed_at, cancel_reason, created_at";
const ITEM_SELECT =
  "id, invoice_id, item_type, product_id, service_id, custom_name, employee_id, qty, unit_price, discount, subtotal, no_commission, commission_value, commission_mode, commission_percent_override, employees!inner(full_name, employee_code, commission_percent, pay_type, payout_mode)";
const TAX_SELECT = "id, invoice_id, tax_code, tax_name, percent, amount";
const PAYMENT_SELECT = "id, invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id, created_at";

// ----------------------------------------------------------------- lectura ---

export interface InvoiceFilters {
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  user_id?: string;
  consecutive_number?: number;
  closed_by?: string;
  employee_id?: string;
  page?: number;
  pageSize?: number;
}

/** Fila de lista: factura + quién abrió/cerró + empleados participantes. */
export interface InvoiceListItem extends InvoiceRow {
  user_name: string | null;
  closed_by_name: string | null;
  employee_names: string[];
}

/** Tamaño de página del listado de facturas. */
export const INVOICE_PAGE_SIZE = 10;

function dateBound(value: string, end: boolean): string {
  const trimmed = value.trim();
  // Fecha sola (yyyy-mm-dd) → rango del día en hora de Bogotá (UTC-5 fijo,
  // Colombia no tiene DST). El offset explícito es obligatorio: sin él,
  // Postgres interpreta el literal en la TZ de la sesión (UTC en Supabase)
  // y la ventana queda corrida 5h — se cuelan facturas de la noche anterior
  // (19:00–23:59) y faltan las de la noche del propio día. El cálculo vive en
  // el helper compartido para que caja, facturación y nómina no diverjan.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const bounds = dayBounds(trimmed);
    return end ? bounds.to : bounds.from;
  }
  return trimmed;
}

/**
 * U8: los ids de factura en los que participa un empleado, leídos de forma
 * EXHAUSTIVA. Antes cada llamador usaba un `.limit(N)` (`2000` en el listado,
 * `5000` en el conteo) que el `max-rows` del Data API bajaba a 1000: listado y
 * conteo trabajaban con un conjunto RECORTADO —facturas del empleado que no
 * aparecían, páginas inalcanzables— sin un solo error. `order("id")` fija un
 * orden determinista para que dos corridas paginen exactamente lo mismo. El
 * fallo de la lectura se convierte en un error de negocio a la vista
 * (`READ_INCOMPLETE`): nunca en “no hay facturas”.
 */
async function invoiceIdsOfEmployee(db: DbClient, employeeId: string): Promise<string[]> {
  try {
    const rows = await readAllPaged<{ invoice_id: string }>({
      table: "invoice_items",
      fetchPage: (from, to) =>
        db
          .from("invoice_items")
          .select("invoice_id")
          .eq("employee_id", employeeId)
          .order("id")
          .range(from, to),
    });
    return [...new Set(rows.map((row) => row.invoice_id))];
  } catch (error) {
    throw new BillingError(
      "READ_INCOMPLETE",
      `${error instanceof Error ? error.message : "La lectura de invoice_items quedó incompleta."} No se puede listar ni contar sin las facturas del empleado: con el conjunto recortado faltarían facturas y el paginador mostraría páginas vacías. Reintente y, si persiste, revise el volumen de datos de la sede.`,
      500,
    );
  }
}

/** Lista facturas de la sede con filtros + paginación (más recientes primero). */
export async function listInvoices(sedeId: string, filters: InvoiceFilters = {}): Promise<InvoiceListItem[]> {
  if (filters.status !== undefined && !["Emitida", "Pagada", "Anulada"].includes(filters.status)) {
    throw new BillingError("VALIDATION", "Estado de filtro inválido.", 400);
  }
  const pageSize =
    filters.pageSize === undefined ? INVOICE_PAGE_SIZE : Math.min(100, Math.max(1, Math.floor(filters.pageSize)));
  const page = filters.page === undefined ? 1 : Math.max(1, Math.floor(filters.page));
  const db = await billingDb();

  // Filtro por empleado participante: primero los invoice_id con ese empleado
  // (U8: lectura exhaustiva, ver `invoiceIdsOfEmployee`).
  let employeeInvoiceIds: string[] | null = null;
  if (filters.employee_id) {
    employeeInvoiceIds = await invoiceIdsOfEmployee(db, filters.employee_id);
    if (employeeInvoiceIds.length === 0) return [];
  }

  // Ventana pedida. `limit` (si viene) manda sobre `page`: reproduce el
  // comportamiento del header `Range` de PostgREST, donde el último valor pedido
  // gana.
  const limit = filters.limit === undefined ? null : Math.min(100, Math.max(1, Math.floor(filters.limit)));
  const offset = limit === null ? (page - 1) * pageSize : 0;
  const size = limit ?? pageSize;

  // Constructor de la consulta con TODOS los filtros, nuevo en cada llamada:
  // los constructores encadenables de Supabase son inmutables y el doble de
  // pruebas muta, así que reutilizar uno acumularía filtros entre lotes.
  const buildInvoiceQuery = () => {
    let query = db
      .from("invoices")
      .select(`${INVOICE_SELECT}, users!invoices_user_id_fkey(full_name)`)
      .eq("sede_id", sedeId)
      .order("consecutive_number", { ascending: false });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.from?.trim()) query = query.gte("created_at", dateBound(filters.from, false));
    if (filters.to?.trim()) query = query.lte("created_at", dateBound(filters.to, true));
    if (filters.user_id) query = query.eq("user_id", filters.user_id);
    if (filters.closed_by) query = query.eq("closed_by", filters.closed_by);
    if (filters.consecutive_number !== undefined) query = query.eq("consecutive_number", filters.consecutive_number);
    return query;
  };

  interface JoinedUser {
    users?: { full_name?: string | null } | null;
  }
  let pageRows: InvoiceRow[];
  if (employeeInvoiceIds) {
    // U8: el `in("id", ...)` viaja en la URL; con 1000+ ids son ~44 KB y el Data
    // API responde 414 —la lectura no ocurre—. Se lee por lotes y por páginas y
    // recién ahí se recorta la página en memoria: el orden global
    // (`consecutive_number` desc) no se puede reconstruir leyendo ventanas por
    // lote, así que se trae el conjunto completo del empleado y se ordena igual
    // que el servidor.
    const all: InvoiceRow[] = [];
    try {
      for (const chunk of chunkIds(employeeInvoiceIds)) {
        all.push(
          ...(await readAllPaged<InvoiceRow>({
            table: "invoices",
            fetchPage: (from, to) =>
              buildInvoiceQuery()
                .in("id", chunk)
                .order("id", { ascending: false })
                .range(from, to),
          })),
        );
      }
    } catch (error) {
      throw new BillingError(
        "READ_INCOMPLETE",
        `${error instanceof Error ? error.message : "La lectura de invoices quedó incompleta."} No se muestra el listado: con las facturas recortadas faltarían facturas del empleado. Reintente y, si persiste, revise el volumen de datos de la sede.`,
        500,
      );
    }
    all.sort(
      (left, right) =>
        right.consecutive_number - left.consecutive_number ||
        (right.id === left.id ? 0 : right.id < left.id ? -1 : 1),
    );
    pageRows = all.slice(offset, offset + size);
  } else {
    const { data, error } = await buildInvoiceQuery().range(offset, offset + size - 1);
    if (error) {
      // Diagnóstico servidor (no se expone al cliente): código/mensaje de PostgREST.
      console.error("PG listInvoices:", JSON.stringify({ code: error.code, message: error.message, details: error.details, hint: error.hint }));
      throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    pageRows = (data ?? []) as unknown as InvoiceRow[];
  }
  const rows = pageRows.map((row) => ({
    ...row,
    user_name: (row as unknown as JoinedUser).users?.full_name ?? null,
  }));
  if (rows.length === 0) return [];

  // Enriquecimiento: quién cerró + empleados participantes (sin N+1: 3 queries).
  const ids = rows.map((row) => row.id);
  // U8: lectura exhaustiva, por lotes de ids. Antes `.limit(2000)` (que el
  // `max-rows` bajaba a 1000) truncaba los ítems de la página: con muchas líneas
  // por factura, los empleados participantes de las últimas facturas
  // desaparecían del listado.
  const itemRows: Array<{ invoice_id: string; employee_id: string }> = [];
  try {
    for (const chunk of chunkIds(ids)) {
      itemRows.push(
        ...(await readAllPaged<{ invoice_id: string; employee_id: string }>({
          table: "invoice_items",
          fetchPage: (from, to) =>
            db
              .from("invoice_items")
              .select("invoice_id, employee_id")
              .in("invoice_id", chunk)
              .order("created_at")
              .order("id")
              .range(from, to),
        })),
      );
    }
  } catch (error) {
    throw new BillingError(
      "READ_INCOMPLETE",
      `${error instanceof Error ? error.message : "La lectura de los ítems de factura quedó incompleta."} No se muestra el listado: sin los ítems no se sabe qué empleados participaron. Reintente y, si persiste, revise el volumen de datos de la sede.`,
      500,
    );
  }
  const empIds = [...new Set(itemRows.map((row) => row.employee_id))];
  const closerIds = [...new Set(rows.map((row) => row.closed_by).filter((id): id is string => id !== null))];
  const userIds = [...new Set([...empIds, ...closerIds])];
  const nameByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const [{ data: empRows }, { data: userRows }] = await Promise.all([
      empIds.length > 0
        ? db.from("employees").select("id, user_id, full_name").in("id", empIds)
        : Promise.resolve({ data: [] }),
      closerIds.length > 0
        ? db.from("users").select("id, full_name").in("id", closerIds)
        : Promise.resolve({ data: [] }),
    ]);
    for (const row of ((empRows ?? []) as Array<{ id: string; user_id: string | null; full_name: string }>)) {
      nameByUser.set(row.id, row.full_name);
      if (row.user_id) nameByUser.set(row.user_id, row.full_name);
    }
    for (const row of ((userRows ?? []) as Array<{ id: string; full_name: string }>)) {
      if (!nameByUser.has(row.id)) nameByUser.set(row.id, row.full_name);
    }
  }
  const namesByInvoice = new Map<string, string[]>();
  for (const row of itemRows) {
    const name = nameByUser.get(row.employee_id);
    if (!name) continue;
    const list = namesByInvoice.get(row.invoice_id) ?? [];
    if (!list.includes(name)) list.push(name);
    namesByInvoice.set(row.invoice_id, list);
  }
  return rows.map((row) => ({
    ...row,
    closed_by_name: row.closed_by ? (nameByUser.get(row.closed_by) ?? null) : null,
    employee_names: namesByInvoice.get(row.id) ?? [],
  }));
}

/** Total de facturas con los mismos filtros (para paginar). */
export async function countInvoices(sedeId: string, filters: InvoiceFilters = {}): Promise<number> {
  const db = await billingDb();
  let employeeInvoiceIds: string[] | null = null;
  if (filters.employee_id) {
    employeeInvoiceIds = await invoiceIdsOfEmployee(db, filters.employee_id);
    if (employeeInvoiceIds.length === 0) return 0;
  }
  // Constructor nuevo por lote (los encadenables de Supabase son inmutables y el
  // doble de pruebas muta): el `in("id", ...)` con todos los ids de una vez
  // viaja en la URL y con 1000+ ids son ~44 KB → 414, la lectura no ocurre.
  const buildCountQuery = () => {
    let query = db.from("invoices").select("id", { count: "exact", head: true }).eq("sede_id", sedeId);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.from?.trim()) query = query.gte("created_at", dateBound(filters.from, false));
    if (filters.to?.trim()) query = query.lte("created_at", dateBound(filters.to, true));
    if (filters.user_id) query = query.eq("user_id", filters.user_id);
    if (filters.closed_by) query = query.eq("closed_by", filters.closed_by);
    if (filters.consecutive_number !== undefined) query = query.eq("consecutive_number", filters.consecutive_number);
    return query;
  };
  if (employeeInvoiceIds) {
    // U8: el conteo se hace por lotes DISJUNTOS de ids y se suma: la suma es el
    // total exacto y cada URL queda dentro del tamaño que aguanta.
    let total = 0;
    for (const chunk of chunkIds(employeeInvoiceIds)) {
      const { count, error } = await buildCountQuery().in("id", chunk);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
      total += count ?? 0;
    }
    return total;
  }
  const { count, error } = await buildCountQuery();
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  return count ?? 0;
}

/** Detalle con ítems, snapshot de impuestos y porciones (solo su sede). */
export async function getInvoiceDetail(sedeId: string, id: string): Promise<InvoiceDetail> {
  const db = await billingDb();
  const { data: invoice, error } = await db
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  if (!invoice) throw new BillingError("NOT_FOUND", "Factura no encontrada.", 404);
  const row = invoice as InvoiceRow;
  try {
    resolveSede(sedeId, row.sede_id);
  } catch {
    throw new BillingError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
  }
  return loadDetail(db, row);
}

async function loadDetail(db: DbClient, invoice: InvoiceRow): Promise<InvoiceDetail> {
  const [itemsRes, taxesRes, paymentsRes] = await Promise.all([
    db.from("invoice_items").select(ITEM_SELECT).eq("invoice_id", invoice.id).order("created_at"),
    db.from("invoice_taxes").select(TAX_SELECT).eq("invoice_id", invoice.id).order("tax_code"),
    db.from("invoice_payments").select(PAYMENT_SELECT).eq("invoice_id", invoice.id).order("created_at"),
  ]);
  if (itemsRes.error || taxesRes.error || paymentsRes.error) {
    console.error(
      "PG loadDetail:",
      JSON.stringify({
        items: itemsRes.error ?? null,
        taxes: taxesRes.error ?? null,
        payments: paymentsRes.error ?? null,
      }),
    );
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }
  const payments = (paymentsRes.data ?? []) as InvoicePaymentRow[];
  const paid = round2(payments.reduce((acc, row) => acc + Number(row.amount), 0));
  interface JoinedEmployee {
    employees?:
      | {
          full_name?: string | null;
          employee_code?: string | null;
          commission_percent?: number | null;
          pay_type?: string | null;
          payout_mode?: string | null;
        }
      | Array<{
          full_name?: string | null;
          employee_code?: string | null;
          commission_percent?: number | null;
          pay_type?: string | null;
          payout_mode?: string | null;
        }>
      | null;
  }
  const itemRows = (itemsRes.data ?? []) as Array<InvoiceItemRow & JoinedEmployee>;
  // Reglas ítem×empleado de TODOS los empleados de la factura en una sola
  // consulta: el detalle puede mezclar empleados y no se cae en N+1.
  const rulesByEmployee = await loadCommissionRulesByEmployee(
    db,
    invoice.sede_id,
    [...new Set(itemRows.map((item) => item.employee_id))],
  );
  const items = itemRows.map((item) => {
    const joined = Array.isArray(item.employees) ? item.employees[0] : item.employees;
    return {
      ...item,
      employee_full_name: joined?.full_name ?? null,
      employee_code: joined?.employee_code ?? null,
      commission_value: item.commission_value ?? null,
      // Campo derivado de lectura (no se persiste): misma regla que nómina y
      // el pago inmediato (resolución compartida).
      commission_amount: computeInvoiceItemCommission({
        itemType: item.item_type,
        itemRefId:
          item.item_type === "producto"
            ? item.product_id
            : item.item_type === "servicio"
              ? item.service_id
              : null,
        subtotal: Number(item.subtotal),
        qty: Number(item.qty),
        commissionValue: item.commission_value ?? null,
        commissionPercentOverride: item.commission_percent_override ?? null,
        noCommission: Boolean(item.no_commission),
        rules: rulesByEmployee.get(item.employee_id) ?? new Map<string, RuleRate>(),
        employee: joined
          ? {
              payoutMode: joined.payout_mode ?? null,
              payType: joined.pay_type ?? null,
              commissionPercent: joined.commission_percent ?? null,
            }
          : null,
      }),
    };
  }) as InvoiceItemRow[];
  // El saldo cobrable es NETO: `total` incluye el recargo EMITIDO
  // (invoices.surcharge), que no es saldo, y cada porción ya trae su recargo
  // en el bruto. `paid` sigue siendo el BRUTO cobrado (lo que entregó el
  // cliente, y lo que lista el detalle de cobro); el saldo se calcula sobre
  // el neto facturado, que es lo que exigen el cobro
  // (billing.splitPayment / cash.registerPayment) y el tope de 031. Así lo
  // que se muestra como Saldo es exactamente lo que el cobro va a aceptar.
  const balance = invoiceNetBalance({
    total: invoice.total,
    surcharge: invoice.surcharge,
    payments,
  });
  return {
    invoice,
    items,
    taxes: (taxesRes.data ?? []) as InvoiceTaxRow[],
    payments: (paymentsRes.data ?? []) as InvoicePaymentRow[],
    paid,
    remaining: round2(Math.max(0, balance.netRemaining)),
  };
}

/**
 * Reglas ítem×empleado activas de todos los empleados de una factura, en una
 * sola consulta (sin N+1). Se agrupan por empleado y por la clave
 * `${item_type}:${item_id}` que consume la resolución compartida.
 *
 * `commission_rules` es una tabla estable (migración 016): el pago inmediato
 * (`earnedCommissionFor`, commissions/service.ts) y la nómina
 * (`calculatePayroll`, payroll/service.ts) la consultan sin degradación. Acá
 * se sigue el mismo criterio: un error real se propaga en vez de degradar a
 * "sin reglas", que reintroduciría justamente la divergencia que este cálculo
 * elimina (mostrar solo el porcentaje plano cuando el pago usa la regla).
 *
 * U7: lectura exhaustiva. El `.limit(5000)` de antes no era un tope de negocio
 * y, peor, el `max-rows` del Data API lo bajaba a 1000: una regla que no se leía
 * hacía que la pantalla mostrara el porcentaje plano mientras la nómina —que SÍ
 * lee todas las reglas— pagaba la regla. Dos cifras de la misma plata que no
 * cuadran. Se pagina hasta agotar, con `order("id")`, y los ids van en lotes del
 * tamaño que aguanta la URL (una lista sin tope termina en 414 y la lectura no
 * ocurre).
 */
async function loadCommissionRulesByEmployee(
  db: DbClient,
  sedeId: string,
  employeeIds: string[],
): Promise<Map<string, Map<string, RuleRate>>> {
  const byEmployee = new Map<string, Map<string, RuleRate>>();
  if (employeeIds.length === 0) return byEmployee;
  try {
    for (const chunk of chunkIds(employeeIds)) {
      const rules = await readAllPaged<{
        employee_id: string;
        item_type: string;
        item_id: string;
        percent: number | string | null;
        amount: number | string | null;
      }>({
        table: "commission_rules",
        fetchPage: (from, to) =>
          db
            .from("commission_rules")
            .select("employee_id, item_type, item_id, percent, amount")
            .eq("sede_id", sedeId)
            .eq("is_active", true)
            .in("employee_id", chunk)
            .order("id")
            .range(from, to),
      });
      for (const rule of rules) {
        const byItem = byEmployee.get(rule.employee_id) ?? new Map<string, RuleRate>();
        byItem.set(commissionRuleKey(rule.item_type, rule.item_id), {
          percent: rule.percent != null ? Number(rule.percent) : null,
          amount: rule.amount != null ? Number(rule.amount) : null,
        });
        byEmployee.set(rule.employee_id, byItem);
      }
    }
  } catch (error) {
    // "No se pudo leer" llega como error de negocio con el código accionable:
    // el mensaje genérico de `toBillingError` habla del candado de nómina, que
    // no es este camino.
    throw new BillingError(
      "READ_INCOMPLETE",
      `${error instanceof Error ? error.message : "La lectura de commission_rules quedó incompleta."} No se muestra la comisión: con las reglas incompletas la cifra no coincidiría con lo que paga la nómina. Reintente y, si persiste, revise el volumen de datos de la sede.`,
      500,
    );
  }
  return byEmployee;
}

/**
 * Redondeo de RECONCILIACIÓN (centavos): es para leer/ajustar dinero YA
 * GUARDADO en columnas `numeric(12,2)` — no para calcular dinero nuevo.
 *
 * El dinero que la app CALCULA es peso entero (`roundMoney`, billing/schemas);
 * esta función es la otra mitad de la historia: las filas históricas todavía
 * pueden traer centavos y los cuadres que comparan SUMA contra TOTAL guardado
 * (el CHECK de `invoices` al recalcular una emitida) tienen que coincidir al
 * centavo con lo que hay guardado. La migración 032 (a) reporta si quedan
 * centavos; hasta que esa decisión se tome, esos cuadres siguen al centavo.
 * El SALDO COBRABLE es la excepción: se redondea a peso entero en
 * `invoiceNetBalance` (ver ahí), porque el datafono no cobra centavos.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------- dinero de factura (019/031) ---

/**
 * Saldo NETO de una factura: la única comparación de dinero correcta para
 * cobrar y para decidir si la factura queda Pagada.
 *
 * `invoice_payments.amount` guarda el BRUTO (neto + recargo del método,
 * 019_card_fee.sql) y `invoices.total = neto facturado + invoices.surcharge`
 * — recargo EMITIDO, que no es saldo cobrable (031). Por eso:
 *
 *     netBilled    = roundMoney(total − surcharge)
 *     netCollected = Σ(amount − fee_amount)
 *     netRemaining = max(0, netBilled − netCollected)
 *
 * REGLA DEL PESO ENTERO APLICADA AL COBRO: el datafono no acepta centavos, así
 * que el monto que el cliente ENTREGA es un peso entero y el saldo cobrable
 * también lo es. Por eso `netBilled` se redondea a peso entero: para una
 * factura cuyo `total − surcharge` ya es entero es un NO-OP exacto (la
 * identidad guardada se conserva), y para una factura legacy cuyo neto quedó
 * con centavos el cobrable es el peso redondeado. En esas filas históricas el
 * neto cobrado es entonces el redondeado, no el guardado: la diferencia es de
 * a lo sumo un peso y la corrección de datos de centavos históricos (032) la
 * elimina. Sin este redondeo el cobro de una factura legacy es
 * INSATISFACIBLE — 9999 deja 0.99 y 10000 deja 0.01, los dos fuera de
 * `MONEY_EPSILON` — y la factura queda Emitida e impagable.
 *
 * Comparar bruto contra `total` (saldo = `total − Σamount`) deja un saldo
 * MENOR que el neto pendiente en cuanto hay un cobro con recargo posterior a
 * la emisión: la porción final se cobra corta y la factura queda Pagada con
 * neto sin cobrar. Es la misma cuenta que aplica
 * `trg_invoice_payments_cap` (031) en la base. Puro: se prueba sin base de
 * datos.
 */
export interface InvoiceNetBalance {
  /** Neto facturado cobrable = roundMoney(total − surcharge), en pesos enteros. */
  netBilled: number;
  /** Neto cobrado = Σ(amount − fee_amount) de invoice_payments. */
  netCollected: number;
  /** Saldo neto pendiente, en peso entero y nunca negativo. */
  netRemaining: number;
}

export function invoiceNetBalance(args: {
  total: number | string;
  surcharge?: number | string | null;
  payments: Array<{ amount: number | string; fee_amount?: number | string | null }>;
}): InvoiceNetBalance {
  // El neto cobrable es el neto facturado en la unidad del cobro (peso
  // entero): es el monto que el datafono puede cobrar. `netCollected` ya es
  // entero (todo monto cobrable lo es desde la regla del peso entero), así que
  // no se redondea: redondearlo al centavo era justo lo que dejaba el saldo
  // con centavos y volvía impagable la factura legacy.
  const netBilled = roundMoney(Number(args.total) - Number(args.surcharge ?? 0));
  const netCollected = args.payments.reduce(
    (acc, row) => acc + (Number(row.amount) - Number(row.fee_amount ?? 0)),
    0,
  );
  return {
    netBilled,
    netCollected,
    netRemaining: Math.max(0, netBilled - netCollected),
  };
}

/**
 * Recargo de una porción cuyo monto es el BRUTO que entregó el cliente (el
 * caso de la caja: el operador cobra lo que el cliente paga). Inversa exacta
 * de `computeCardFees` (billing/schemas.ts), que trabaja con el NETO:
 *
 *     neto = bruto / (1 + fee_percent/100)      fee = bruto − neto
 *
 * Se redondea primero el NETO y el recargo sale por diferencia, así
 * `neto + fee == bruto` al centavo y `amount − fee_amount` es exactamente el
 * neto cobrado que suman `invoiceNetBalance` y el tope de 031. Puro.
 */
export function splitGrossCardFee(
  gross: number,
  feePercent: number,
): { net: number; fee: number } {
  const percent = Math.max(0, Number(feePercent) || 0);
  // El bruto es lo que el cliente entregó en el datafono, y el datafono no
  // acepta centavos: se normaliza a peso entero. Es lo que va a las dos filas
  // (`invoice_payments.amount` y `payments.amount`) y a la caja.
  const whole = roundMoney(Number(gross));
  // Se redondea el NETO (a peso entero) y el recargo sale por DIFERENCIA:
  // así `neto + fee == bruto` EXACTO (los dos son enteros) y
  // `amount − fee_amount` es exactamente el neto cobrado que suman
  // `invoiceNetBalance` y el tope de 031. Con `fee = round(neto × pct / 100)`,
  // `round(bruto / (1 + pct/100))` devuelve ese mismo neto: la desviación de
  // la división es menor a 0,5 y no cruza el medio. Puro.
  const net = roundMoney(whole / (1 + percent / 100));
  return { net, fee: whole - net };
}

// ------------------------------------------------------------------ ayudas ---

interface ValidatedRefs {
  activeTaxes: Array<{ code: string; name: string; percent: number }>;
  methodByCode: Map<string, { id: string; code: string; feePercent: number }>;
}

/** Valida catálogos: impuestos activos (snapshot) y métodos activos por código. */
async function loadRefs(sedeId: string): Promise<ValidatedRefs> {
  const [taxes, methods] = await Promise.all([
    listTaxes(sedeId),
    listPaymentMethods(sedeId),
  ]);
  return {
    activeTaxes: taxes
      .filter((tax) => tax.is_active)
      .map((tax) => ({ code: tax.code, name: tax.name, percent: Number(tax.percent) })),
    methodByCode: new Map(
      methods
        .filter((method) => method.is_active)
        .map((method) => [method.code, { id: method.id, code: method.code, feePercent: Number(method.fee_percent ?? 0) }]),
    ),
  };
}

/**
 * Verifica existencia y sede de cada referencia de los ítems (productos,
 * servicios, empleados). B1: los productos se validan vía la frontera de
 * inventario (getProductsStock) — billing NUNCA toca las tablas de
 * inventory directo. Devuelve el mapa de stock para que el llamador
 * pre-verifique disponibilidad ANTES de reservar el consecutivo
 * (FAC-05 sin huecos) o de mutar. Sin N+1: una sola query con IN por
 * tabla (productos vía servicio + empleados) más el catálogo de
 * servicios; el bucle posterior es en memoria.
 */
async function validateItemRefs(
  sedeId: string,
  items: InvoiceItemInput[],
): Promise<Map<string, StockEntry>> {
  const db = await billingDb();
  const serviceRows = await listServices(sedeId, 500);
  const serviceSedeById = new Map(serviceRows.map((row) => [row.id, row.sede_id]));

  const productIds = [...new Set(
    items
      .filter((item) => item.item_type === "producto" && item.product_id)
      .map((item) => item.product_id as string),
  )];
  const employeeIds = [...new Set(items.map((item) => item.employee_id))];

  const [stockMap, employeeRes] = await Promise.all([
    productIds.length > 0
      ? getProductsStock(sedeId, productIds)
      : Promise.resolve(new Map<string, StockEntry>()),
    employeeIds.length > 0
      ? db.from("employees").select("id, sede_id").in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (employeeRes.error) {
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }
  const employeeSedeById = new Map(
    ((employeeRes.data ?? []) as Array<{ id: string; sede_id: string }>).map((row) => [row.id, row.sede_id]),
  );

  for (const item of items) {
    if (item.item_type === "producto" && item.product_id) {
      // getProductsStock solo devuelve productos de esta sede: ausente =
      // inexistente o de otra sede (sin filtrar datos ajenos).
      if (!stockMap.has(item.product_id)) {
        throw new BillingError("NOT_FOUND", "Producto no encontrado.", 404);
      }
    }
    if (item.item_type === "servicio" && item.service_id) {
      if (serviceSedeById.get(item.service_id) !== sedeId) {
        throw new BillingError("NOT_FOUND", "Servicio no encontrado en esta sede.", 404);
      }
    }
    const employeeSedeId = employeeSedeById.get(item.employee_id);
    if (!employeeSedeId) {
      throw new BillingError("NOT_FOUND", "Empleado no encontrado.", 404);
    }
    if (employeeSedeId !== sedeId) {
      throw new BillingError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
    }
  }
  return stockMap;
}

/**
 * Traduce el error puro de planStockDeduction a BillingError con mensaje
 * de negocio por producto (409, nunca INTERNAL por falta de stock).
 */
function insufficientStockError(error: unknown): BillingError {
  if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
    const details = (error as { details?: { name: string; stock: number; requested: number } })
      .details;
    if (details) {
      return new BillingError(
        "INSUFFICIENT_STOCK",
        `Stock insuficiente para ${details.name}: hay ${details.stock}, se piden ${details.requested}.`,
        409,
      );
    }
  }
  return toBillingError(error);
}

function toBillingError(error: unknown): BillingError {
  if (error instanceof BillingError) return error;
  if (error instanceof PagedReadError) {
    return new BillingError(
      error.code,
      `${error.message} La operación se rechaza: sin el historial de nómina completo no se puede saber si la comisión de esta factura ya estaba pagada.`,
      500,
    );
  }
  if (error instanceof InventoryError) {
    return new BillingError(error.code, error.message, error.status);
  }
  if (error instanceof Error && error.message === "DESCUENTO_EXCEDE") {
    return new BillingError("VALIDATION", "El descuento no puede superar el subtotal.", 400);
  }
  if (error instanceof Error && error.message.startsWith("TOTAL_MISMATCH")) {
    return new BillingError("TOTAL_MISMATCH", error.message.replace(/^TOTAL_MISMATCH:\s*/, ""), 422);
  }
  return new BillingError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------ crear ---

export interface BillingActor {
  userId: string;
  sedeId: string;
  roles?: RoleCode[];
}

/**
 * FAC-01…07: crea la factura (consecutivo con lock, snapshot de
 * impuestos activos, OUT de stock por producto vía deductStock,
 * porciones que cuadran). Estado inicial Emitida; si las porciones
 * suman el total → Pagada. B1: este es el MOMENTO ÚNICO del descuento;
 * pagar después no descuenta de nuevo.
 *
 * Orden anti-huecos (FAC-05): valida todo y pre-verifica stock ANTES de
 * reservar el número vía rpc next_invoice_number(); el UNIQUE
 * (sede_id, consecutive_number) es la barrera final contra duplicados.
 * PostgREST no ofrece multi-statement en una transacción, así que ante
 * fallo posterior a la reserva se intenta limpieza best-effort (ver
 * cleanupFailedInvoice) y se documenta en la migración 005.
 */
export async function createInvoice(raw: unknown, actor: BillingActor): Promise<InvoiceDetail> {
  const parsed = createInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: CreateInvoiceInput = parsed.data;
  const db = await billingDb();

  let refs: ValidatedRefs;
  let stockMap: Map<string, StockEntry>;
  try {
    refs = await loadRefs(actor.sedeId);
    stockMap = await validateItemRefs(actor.sedeId, input.items);
    // B1/FAC-05: pre-verifica stock ANTES de reservar el consecutivo (sin
    // huecos). El descuento real ocurre tras insertar ítems vía deductStock.
    try {
      planStockDeduction(
        input.items.map((item) => ({ product_id: item.product_id, qty: item.qty })),
        new Map(
          [...stockMap].map(([id, entry]) => [id, { name: entry.name, stock_qty: entry.stock_qty }]),
        ),
      );
    } catch (error) {
      throw insufficientStockError(error);
    }
  } catch (error) {
    throw toBillingError(error);
  }

  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals({
      items: input.items,
      discount: input.discount,
      activeTaxes: refs.activeTaxes,
    });
  } catch (error) {
    throw toBillingError(error);
  }

  const portions: PaymentPortionInput[] = input.payments ?? [];
  const methodByCode = refs.methodByCode;
  for (const portion of portions) {
    if (!methodByCode.has(portion.method_code)) {
      throw new BillingError(
        "METHOD_INACTIVE",
        `El método de pago ${portion.method_code} no está activo en esta sede.`,
        422,
      );
    }
  }
  if (portions.length > 0 && !portionsMatchBalance(portions, totals.total)) {
    throw new BillingError(
      "SPLIT_MISMATCH",
      "Las porciones de pago deben sumar exactamente el neto de la factura (sin recargo; el recargo se suma solo).",
      422,
    );
  }
  // Recargo por método (p. ej. tarjeta 5%) sobre el neto de cada porción.
  // El cliente paga el bruto; pagado/saldo/cierre cuadran sin lógica especial.
  const feeOf = (methodCode: string): number => methodByCode.get(methodCode)?.feePercent ?? 0;
  const fees = computeCardFees(portions, feeOf);
  // Recargo y total son dinero CALCULADO: peso entero (los fee ya lo son).
  const surcharge = roundMoney(fees.reduce((acc, fee) => acc + fee.fee, 0));
  const grandTotal = roundMoney(totals.total + surcharge);
  const status = portions.length > 0 ? "Pagada" : "Emitida";

  // Validar turno de caja abierto (CAJ-01 / FAC-01): solo se emite con turno abierto.
  // Solo quien abrió el turno puede emitir; admin puede con justificación (override).
  let cashShiftId: string | null = null;
  let adminOverrideJustification: string | null = null;
  {
    const openShift = await getOpenShiftWithOpener(actor.sedeId);
    if (!openShift) {
      throw new BillingError(
        "NO_OPEN_SHIFT",
        "No hay caja abierta: abre tu turno para emitir.",
        409,
      );
    }
    const isAdmin = (actor.roles ?? []).includes("admin");
    const isOpener = openShift.opened_by === actor.userId;
    if (!isOpener && !isAdmin) {
      const owner = openShift.opener_name?.trim() || null;
      throw new BillingError(
        "SHIFT_NOT_OWNER",
        owner
          ? `La caja abierta es del turno de ${owner}: solo ${owner} o un administrador puede emitir.`
          : "La caja abierta es de otro turno: solo quien abrió el turno o un administrador puede emitir.",
        403,
      );
    }
    if (!isOpener && isAdmin) {
      // Admin override: requerir justificación en metadata (se audita abajo).
      adminOverrideJustification = `Admin override: emitida por admin (${actor.userId}) en turno abierto por ${openShift.opener_name ?? openShift.opened_by}.`;
    }
    cashShiftId = openShift.id;
  }

  const { data: seq, error: seqError } = await db.rpc("next_invoice_number", {
    p_sede_id: actor.sedeId,
  });
  if (seqError || typeof seq !== "number") {
    throw new BillingError("INTERNAL", "No se pudo reservar el consecutivo.", 500);
  }
  const consecutive = seq as number;

  // Limpieza best-effort si algo falla después de reservar el número.
  let invoiceId: string | null = null;
  const outMovements: Array<{ product_id: string; qty: number }> = [];
  const cleanupFailedInvoice = async () => {
    try {
      // B1: la compensación también cruza por la frontera de inventario
      // (registerMovement), nunca con insert directo a inventory_movements.
      for (const out of outMovements.reverse()) {
        await registerMovement(
          {
            product_id: out.product_id,
            type: "IN",
            qty: out.qty,
            reason: `Compensación fallo emisión factura #${consecutive}`,
          },
          actor,
        );
      }
      if (invoiceId) {
        await db.from("invoice_payments").delete().eq("invoice_id", invoiceId);
        await db.from("invoice_taxes").delete().eq("invoice_id", invoiceId);
        await db.from("invoice_items").delete().eq("invoice_id", invoiceId);
        await db.from("invoices").delete().eq("id", invoiceId);
      }
    } catch {
      // Best-effort: el error original manda (queda auditado en la respuesta).
    }
  };

  try {
    const { data: invoice, error: invoiceError } = await db
      .from("invoices")
      .insert({
        sede_id: actor.sedeId,
        consecutive_number: consecutive,
        client_name: input.client_name?.trim() || null,
        client_document: input.client_document?.trim() || null,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        surcharge,
        total: grandTotal,
        status,
        user_id: actor.userId,
        cash_shift_id: cashShiftId,
        closed_by: status === "Pagada" ? actor.userId : null,
        closed_at: status === "Pagada" ? new Date().toISOString() : null,
      })
      .select(INVOICE_SELECT)
      .single();
    if (invoiceError || !invoice) {
      console.error("PG invoice insert:", JSON.stringify(invoiceError));
      if ((invoiceError as { code?: string } | null)?.code === "23505") {
        throw new BillingError("DUPLICATE_NUMBER", "Consecutivo duplicado, reintente la emisión.", 409);
      }
      throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    invoiceId = (invoice as InvoiceRow).id;

    const { error: itemsError } = await db.from("invoice_items").insert(
      input.items.map((item) => ({
        invoice_id: invoiceId,
        item_type: item.item_type,
        product_id: item.product_id ?? null,
        service_id: item.service_id ?? null,
        custom_name: item.custom_name?.trim() || null,
        employee_id: item.employee_id,
        qty: item.qty,
        unit_price: item.unit_price,
        discount: item.discount,
        ...normalizeCommissionFields(item),
        // Mismo cálculo que el subtotal de la factura: una sola fórmula
        // (`computeLineSubtotal`) para que la línea y el total no puedan
        // discrepar, en pesos enteros.
        subtotal: computeLineSubtotal(item).subtotal,
      })),
    );
    if (itemsError) {
      console.error("PG invoice_items insert:", JSON.stringify(itemsError));
      throw new BillingError("INTERNAL", "Error interno.", 500);
    }

    if (totals.taxes.length > 0) {
      const { error: taxesError } = await db.from("invoice_taxes").insert(
        totals.taxes.map((tax) => ({
          invoice_id: invoiceId,
          tax_code: tax.tax_code,
          tax_name: tax.tax_name,
          percent: tax.percent,
          amount: tax.amount,
        })),
      );
      if (taxesError) {
        console.error("PG invoice_taxes insert:", JSON.stringify(taxesError));
        throw new BillingError("INTERNAL", "Error interno.", 500);
      }
    }

    if (portions.length > 0) {
      const { error: paymentsError } = await db.from("invoice_payments").insert(
        fees.map((fee) => ({
          invoice_id: invoiceId,
          method_id: methodByCode.get(fee.method_code)?.id ?? null,
          method_code: fee.method_code,
          amount: fee.gross,
          fee_percent: fee.feePercent,
          fee_amount: fee.fee,
          cash_shift_id: cashShiftId,
        })),
      );
      if (paymentsError) {
        console.error("PG invoice_payments insert:", JSON.stringify(paymentsError));
        // Carrera perdida contra trg_invoice_payments_cap (031): mismo P0001
        // que nómina traduce en payroll/service.ts.
        if ((paymentsError as { code?: string }).code === "P0001") {
          throw new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);
        }
        throw new BillingError("INTERNAL", "Error interno.", 500);
      }
    }

    // B1/FAC-06, momento único: AL EMITIR se descuenta el stock de cada
    // ítem producto vía la frontera de inventario (deductStock valida y
    // registra los OUT). Pagar después (splitPayment) NO descuenta de
    // nuevo; anular revierte con IN; editar ajusta por deltas.
    const outReason = buildInvoiceOutReason(consecutive, input.client_name);
    try {
      const planned = await deductStock(
        actor,
        input.items.map((item) => ({ product_id: item.product_id, qty: item.qty })),
        outReason,
      );
      for (const item of planned) {
        outMovements.push({ product_id: item.product_id, qty: item.qty });
      }
    } catch (error) {
      throw toBillingError(error);
    }

    // Audit log para creación de factura (con info de admin override si aplica)
    await writeAudit({
      sede_id: actor.sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.INVOICE_CREATED,
      entity: "invoices",
      entity_id: invoiceId,
      metadata: {
        consecutive_number: consecutive,
        client_name: input.client_name,
        total: grandTotal,
        surcharge,
        card_fees: fees.filter((fee) => fee.fee > 0),
        status,
        cash_shift_id: cashShiftId,
        admin_override: adminOverrideJustification,
        portions_count: portions.length,
        items_count: input.items.length,
      },
    });

    return loadDetail(db, invoice as InvoiceRow);
  } catch (error) {
    await cleanupFailedInvoice();
    throw toBillingError(error);
  }
}

// ------------------------------------------------------------------ anular ---

/**
 * FAC-04/FAC-06: anula (solo Emitida/Pagada, motivo obligatorio). Revierte
 * stock con IN por cada producto y deja el motivo en cancel_reason.
 * Queda en audit_logs (TRA-01, T8). Solo admin.
 *
 * U6: dos candados que faltaban, sin cambiar la política.
 *
 * (a) La anulación TAMBIÉN respeta el candado de nómina cerrada que las dos
 *     ediciones ya aplican (`editInvoiceItems` / `editEmittedInvoiceItems`,
 *     `PAYROLL_LOCKED`). No es una exención deliberada: anular es la otra forma
 *     de reescribir la plata de la factura, y con el período cerrado no hay
 *     reverso posible de la comisión ya pagada (el período está congelado,
 *     `commissions` solo bloquea pagos inmediatos NUEVOS sobre una anulada y
 *     la nómina solo excluye anuladas de los cálculos FUTUROS). Faltaba acá,
 *     punto.
 *
 * (b) El UPDATE es compare-and-swap: lleva el estado leído como precondición.
 *     Dos anulaciones simultáneas leían el mismo estado anulable e insertaban
 *     las DOS el IN de reversión (stock devuelto dos veces). Ahora la que
 *     aplica segunda afecta 0 filas y se rechaza.
 */
export async function annulInvoice(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: BillingActor,
): Promise<InvoiceDetail> {
  if (!actor.roles?.includes("admin")) {
    throw new BillingError("FORBIDDEN", "Solo el admin puede anular facturas.", 403);
  }
  const parsed = annulInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const motivo = parsed.data.motivo.trim();
  const db = await billingDb();

  const detail = await getInvoiceDetail(sedeId, id);
  if (!canAnnulStatus(detail.invoice.status)) {
    throw new BillingError("ANNUL_INVALID", annulBlockedMessage(detail.invoice.status), 409);
  }

  // U6-a: mismo candado que las dos ediciones. Si la lectura del historial no
  // se puede completar, `invoiceInClosedPayroll` LANZA (READ_INCOMPLETE) y la
  // anulación se rechaza: nunca un `false` por no haber podido mirar.
  if (await invoiceInClosedPayroll(db, sedeId, id)) {
    throw new BillingError(
      "PAYROLL_LOCKED",
      "La factura ya entró en una nómina cerrada: al empleado pagado no se le toca, y anularla dejaría esa comisión pagada sin reverso.",
      409,
    );
  }

  // U6-b: el estado leído es la precondición del UPDATE. Si otra anulación (o
  // un cobro) movió la fila entre la lectura y esta escritura, se afectan 0
  // filas y la reversión de stock NO se ejecuta. Sin esta guarda, dos
  // anulaciones simultáneas devolvían el stock dos veces.
  const { data: updated, error: updateError } = await db
    .from("invoices")
    .update({ status: "Anulada", cancel_reason: motivo, closed_by: actor.userId, closed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", detail.invoice.status)
    .select(INVOICE_SELECT)
    .single();
  if (updateError || !updated) {
    // Carrera perdida contra la guarda de estado (PGRST116 = `.single()` sin
    // filas, el patrón del cliente Supabase y el mismo que usa el cierre de
    // caja para SHIFT_ALREADY_CLOSED).
    const errorCode = (updateError as { code?: string } | null)?.code;
    if (errorCode === "PGRST116") {
      throw new BillingError(
        "ANNUL_CONFLICT",
        "La factura ya no está en el estado con el que se leyó (posible anulación simultánea): no se anuló nada, vuelva a intentarlo.",
        409,
      );
    }
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  const productItems = detail.items
    .filter((item) => item.item_type === "producto" && item.product_id)
    .map((item) => ({ product_id: item.product_id as string, qty: item.qty }));
  const reversals = buildReversalReasons({
    consecutiveNumber: detail.invoice.consecutive_number,
    motivo,
    productItems,
  });
  try {
    for (const reversal of reversals) {
      await registerMovement(
        { product_id: reversal.product_id, type: "IN", qty: reversal.qty, reason: reversal.reason },
        actor,
      );
    }
  } catch (error) {
    throw toBillingError(error);
  }

  await writeAudit({
    sede_id: sedeId,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.INVOICE_ANNULLED,
    entity: "invoices",
    entity_id: id,
    metadata: {
      consecutive_number: detail.invoice.consecutive_number,
      motivo,
      previous_status: detail.invoice.status,
    },
  });

  return loadDetail(db, updated as InvoiceRow);
}

// ------------------------------------------------------------------ editar ---

/**
 * Edición admin de factura (total INMUTABLE): corrige ítems y métodos de
 * pago con motivo obligatorio. Reglas:
 * - Empleado/comisión/cant./precio bloqueados si la factura ya entró en
 *   una nómina cerrada (al que se le pagó no se le toca).
 * - Nuevo subtotal y recargo deben igualar a los emitidos (si no, se rechaza).
 * - Cambios de método solo entre iguales recargos.
 * - ANULADA es terminal: no se edita. Inventario se reajusta por deltas.
 * - Todo queda en audit_logs con motivo + antes/después.
 */
export async function editInvoiceItems(
  sedeId: string,
  invoiceId: string,
  raw: unknown,
  actor: BillingActor,
): Promise<InvoiceDetail> {
  if (!actor.roles?.includes("admin")) {
    throw new BillingError("FORBIDDEN", "Solo el admin puede editar facturas.", 403);
  }
  const parsed = editInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input = parsed.data;
  const motivo = input.motivo.trim();
  const db = await billingDb();

  const detail = await getInvoiceDetail(sedeId, invoiceId);
  if (detail.invoice.status === "Anulada") {
    throw new BillingError("ANNUL_INVALID", "Anulada es terminal: no se edita (emita una nueva).", 409);
  }

  let refs: ValidatedRefs;
  let stockMap: Map<string, StockEntry>;
  try {
    refs = await loadRefs(actor.sedeId);
    stockMap = await validateItemRefs(
      actor.sedeId,
      input.items.map((item) => ({
        item_type: item.item_type,
        product_id: item.product_id,
        service_id: item.service_id,
        custom_name: item.custom_name,
        employee_id: item.employee_id,
        qty: item.qty,
        unit_price: item.unit_price,
        discount: item.discount,
        no_commission: item.no_commission,
        commission_value: item.commission_value,
      })),
    );
  } catch (error) {
    throw toBillingError(error);
  }

  // Cobros: mismos ids, solo puede cambiar el método (montos intactos).
  const oldPayIds = [...detail.payments.map((row) => row.id)].sort();
  const newPayIds = [...input.payments.map((row) => row.id)].sort();
  if (JSON.stringify(oldPayIds) !== JSON.stringify(newPayIds)) {
    throw new BillingError(
      "VALIDATION",
      "Los cobros no se agregan ni quitan al editar (solo cambia el método).",
      400,
    );
  }
  const oldPayById = new Map(detail.payments.map((row) => [row.id, row]));
  for (const payment of input.payments) {
    const method = refs.methodByCode.get(payment.method_code);
    if (!method) {
      throw new BillingError(
        "METHOD_INACTIVE",
        `El método de pago ${payment.method_code} no está activo en esta sede.`,
        422,
      );
    }
    const old = oldPayById.get(payment.id);
    if (old && Number(method.feePercent) !== Number(old.fee_percent ?? 0)) {
      throw new BillingError(
        "METHOD_FEE_CHANGED",
        "El nuevo método cambia el recargo y movería el total (inmutable). Use uno con igual recargo.",
        422,
      );
    }
  }

  const diff = diffInvoiceItems(
    detail.items.map((row) => ({
      id: row.id,
      item_type: row.item_type,
      product_id: row.product_id,
      service_id: row.service_id,
      custom_name: row.custom_name,
      employee_id: row.employee_id,
      qty: Number(row.qty),
      unit_price: Number(row.unit_price),
      discount: Number(row.discount),
      no_commission: row.no_commission,
      commission_value: row.commission_value ?? null,
    })),
    input.items,
  );

  if (diff.payTouched && (await invoiceInClosedPayroll(db, sedeId, invoiceId))) {
    throw new BillingError(
      "PAYROLL_LOCKED",
      "La factura ya entró en una nómina cerrada: al empleado pagado no se le toca (empleado, comisión, cant., precio).",
      409,
    );
  }

  const newSubtotal = editItemsSubtotal(input.items);
  try {
    assertEditReconciles({
      oldSubtotal: Number(detail.invoice.subtotal),
      newSubtotal,
      oldSurcharge: Number(detail.invoice.surcharge ?? 0),
      newSurcharge: Number(detail.invoice.surcharge ?? 0),
      oldTotal: Number(detail.invoice.total),
    });
  } catch (error) {
    throw toBillingError(error);
  }

  // Inventario por deltas netos por producto (pre-valida stock vía la
  // frontera antes de mutar; solo los incrementos requieren stock).
  const oldQtyByProduct = new Map<string, number>();
  for (const row of detail.items) {
    if (row.item_type === "producto" && row.product_id) {
      oldQtyByProduct.set(row.product_id, (oldQtyByProduct.get(row.product_id) ?? 0) + Number(row.qty));
    }
  }
  const newQtyByProduct = new Map<string, number>();
  for (const item of input.items) {
    if (item.item_type === "producto" && item.product_id) {
      newQtyByProduct.set(item.product_id, (newQtyByProduct.get(item.product_id) ?? 0) + Number(item.qty));
    }
  }
  const productIds = [...new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()])];
  const increments = productIds
    .map((productId) => ({
      product_id: productId,
      qty: (newQtyByProduct.get(productId) ?? 0) - (oldQtyByProduct.get(productId) ?? 0),
    }))
    .filter((line) => line.qty > 0);
  if (increments.length > 0) {
    try {
      planStockDeduction(
        increments,
        new Map(
          [...stockMap].map(([id, entry]) => [id, { name: entry.name, stock_qty: entry.stock_qty }]),
        ),
      );
    } catch {
      throw new BillingError("INSUFFICIENT_STOCK", "Stock insuficiente para el ajuste.", 409);
    }
  }

  // Aplica: borra, actualiza, inserta, métodos, inventario, auditoría.
  const editReason = `Ajuste edición factura #${detail.invoice.consecutive_number} — ${motivo.slice(0, 200)}`;
  try {
    for (const row of diff.removed) {
      const { error } = await db.from("invoice_items").delete().eq("id", row.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const { old, next } of diff.changed) {
      const line = computeLineSubtotal({ qty: next.qty, unit_price: next.unit_price, discount: next.discount });
      const { error } = await db
        .from("invoice_items")
        .update({
          item_type: next.item_type,
          product_id: next.product_id ?? null,
          service_id: next.service_id ?? null,
          custom_name: next.custom_name?.trim() || null,
          employee_id: next.employee_id,
          qty: next.qty,
          unit_price: next.unit_price,
          discount: next.discount,
          ...normalizeCommissionFields(next),
          subtotal: line.subtotal,
        })
        .eq("id", old.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const item of diff.added) {
      const line = computeLineSubtotal({ qty: item.qty, unit_price: item.unit_price, discount: item.discount });
      const { error } = await db.from("invoice_items").insert({
        invoice_id: invoiceId,
        item_type: item.item_type,
        product_id: item.product_id ?? null,
        service_id: item.service_id ?? null,
        custom_name: item.custom_name?.trim() || null,
        employee_id: item.employee_id,
        qty: item.qty,
        unit_price: item.unit_price,
        discount: item.discount,
        ...normalizeCommissionFields(item),
        subtotal: line.subtotal,
      });
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const payment of input.payments) {
      const method = refs.methodByCode.get(payment.method_code);
      const { error } = await db
        .from("invoice_payments")
        .update({ method_code: payment.method_code, method_id: method?.id ?? null })
        .eq("id", payment.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    const inventoryMoves: Array<{ product_id: string; qty: number; type: "IN" | "OUT" }> = [];
    for (const productId of productIds) {
      const delta = (newQtyByProduct.get(productId) ?? 0) - (oldQtyByProduct.get(productId) ?? 0);
      if (delta === 0) continue;
      const type = delta > 0 ? "OUT" : "IN";
      await registerMovement({ product_id: productId, type, qty: Math.abs(delta), reason: editReason }, actor);
      inventoryMoves.push({ product_id: productId, qty: Math.abs(delta), type });
    }
    await writeAudit({
      sede_id: actor.sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.INVOICE_EDITED,
      entity: "invoices",
      entity_id: invoiceId,
      metadata: {
        consecutive_number: detail.invoice.consecutive_number,
        motivo,
        total: Number(detail.invoice.total),
        items_before: diff.removed.length + diff.changed.length,
        items_added: diff.added.length,
        inventory_moves: inventoryMoves,
      },
    });
  } catch (error) {
    throw toBillingError(error);
  }
  return loadDetail(db, { ...detail.invoice } as InvoiceRow);
}

/**
 * Edición LIBRE de factura EMITIDA (el total se recalcula): la cajera del
 * turno (quien abrió la factura y tiene turno abierto) edita sin motivo:
 * agrega/quita/cambia ítems, cantidades y precios. Admin puede editar
 * emitidas de otros como override ligero (sin motivo, queda auditado con el
 * mecanismo existente INVOICE_EDITED).
 *
 * Separa el camino de la edición admin estricta (editInvoiceItems): Pagada
 * sigue con motivo obligatorio + total inmutable; Anulada es terminal.
 */
export async function editEmittedInvoiceItems(
  sedeId: string,
  invoiceId: string,
  raw: unknown,
  actor: BillingActor,
): Promise<InvoiceDetail> {
  const isAdmin = actor.roles?.includes("admin") ?? false;
  const isCashier = actor.roles?.includes("caja") ?? false;
  if (!isAdmin && !isCashier) {
    throw new BillingError("FORBIDDEN", "Solo caja o admin pueden editar facturas emitidas.", 403);
  }
  const parsed = editEmittedInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input = parsed.data;
  const motivo = input.motivo?.trim() || null;
  const db = await billingDb();

  const detail = await getInvoiceDetail(sedeId, invoiceId);
  if (detail.invoice.status === "Anulada") {
    throw new BillingError("ANNUL_INVALID", "Anulada es terminal: no se edita (emita una nueva).", 409);
  }
  if (detail.invoice.status === "Pagada") {
    throw new BillingError(
      "STATUS_INVALID",
      "Factura pagada: use la edición admin con motivo (total inmutable).",
      409,
    );
  }

  if (!isAdmin) {
    const openShift = await getOpenShiftWithOpener(sedeId).catch(() => null);
    if (!openShift) {
      throw new BillingError(
        "NO_OPEN_SHIFT",
        "No hay caja abierta: abre tu turno para editar.",
        409,
      );
    }
    if (openShift.opened_by !== actor.userId) {
      const owner = openShift.opener_name?.trim() || null;
      throw new BillingError(
        "SHIFT_NOT_OWNER",
        owner
          ? `El turno abierto es de ${owner}: solo ${owner} o un administrador puede editar.`
          : "El turno abierto es de otro cajero: solo quien abrió el turno o un administrador puede editar.",
        403,
      );
    }
    if (detail.invoice.user_id !== actor.userId) {
      throw new BillingError("FORBIDDEN", "Solo quien abrió la factura puede editarla.", 403);
    }
  }

  let refs: ValidatedRefs;
  let emittedStockMap: Map<string, StockEntry>;
  try {
    refs = await loadRefs(actor.sedeId);
    emittedStockMap = await validateItemRefs(
      actor.sedeId,
      input.items.map((item) => ({
        item_type: item.item_type,
        product_id: item.product_id,
        service_id: item.service_id,
        custom_name: item.custom_name,
        employee_id: item.employee_id,
        qty: item.qty,
        unit_price: item.unit_price,
        discount: item.discount,
        no_commission: item.no_commission,
        commission_value: item.commission_value,
      })),
    );
  } catch (error) {
    throw toBillingError(error);
  }

  // Cobros parciales ya registrados: mismos ids, solo puede cambiar el
  // método entre iguales recargos (el recargo emitido se conserva).
  const oldPayIds = [...detail.payments.map((row) => row.id)].sort();
  const newPayIds = [...input.payments.map((row) => row.id)].sort();
  if (JSON.stringify(oldPayIds) !== JSON.stringify(newPayIds)) {
    throw new BillingError(
      "VALIDATION",
      "Los cobros no se agregan ni quitan al editar (solo cambia el método).",
      400,
    );
  }
  const oldPayById = new Map(detail.payments.map((row) => [row.id, row]));
  for (const payment of input.payments) {
    const method = refs.methodByCode.get(payment.method_code);
    if (!method) {
      throw new BillingError(
        "METHOD_INACTIVE",
        `El método de pago ${payment.method_code} no está activo en esta sede.`,
        422,
      );
    }
    const old = oldPayById.get(payment.id);
    if (old && Number(method.feePercent) !== Number(old.fee_percent ?? 0)) {
      throw new BillingError(
        "METHOD_FEE_CHANGED",
        "El nuevo método cambia el recargo emitido. Use uno con igual recargo.",
        422,
      );
    }
  }

  const diff = diffInvoiceItems(
    detail.items.map((row) => ({
      id: row.id,
      item_type: row.item_type,
      product_id: row.product_id,
      service_id: row.service_id,
      custom_name: row.custom_name,
      employee_id: row.employee_id,
      qty: Number(row.qty),
      unit_price: Number(row.unit_price),
      discount: Number(row.discount),
      no_commission: row.no_commission,
      commission_value: row.commission_value ?? null,
    })),
    input.items,
  );

  if (diff.payTouched && (await invoiceInClosedPayroll(db, sedeId, invoiceId))) {
    throw new BillingError(
      "PAYROLL_LOCKED",
      "La factura ya entró en una nómina cerrada: al empleado pagado no se le toca (empleado, comisión, cant., precio).",
      409,
    );
  }

  // El total SE recalcula: subtotal + impuestos snapshot vigentes; el
  // descuento de factura y el recargo emitido se conservan.
  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals({
      items: input.items,
      discount: Number(detail.invoice.discount),
      activeTaxes: refs.activeTaxes,
    });
  } catch (error) {
    throw toBillingError(error);
  }
  const surcharge = round2(Number(detail.invoice.surcharge ?? 0));
  // El recargo guardado se conserva tal cual (es el recargo EMITIDO, un dato
  // histórico que puede traer centavos hasta que 032 decida): por eso el total
  // se reconcilia con `round2` y no con la regla del peso entero. El descuento
  // SÍ se normaliza y se vuelve a escribir más abajo: `totals` lo calculó ya
  // en pesos enteros, y si la fila guardaba un descuento con centavos la
  // identidad `total = subtotal − discount + tax + surcharge` del CHECK de
  // `invoices` no cerraría y el UPDATE fallaría.
  const newTotal = round2(totals.total + surcharge);

  // GATE (WU2, decisión del dueño): bajar el total de una factura YA COBRADA
  // por debajo de lo cobrado se permite, pero nunca en silencio. El saldo sale
  // de `invoiceNetBalance` —la casa única de qué se factura, qué se cobra y qué
  // falta—: el neto facturado del total NUEVO (`roundMoney(newTotal −
  // surcharge)`, y por eso el recargo emitido entra por `surcharge`) contra el
  // neto cobrado (`Σ(amount − fee_amount)`, NO el bruto de `amount`, que lleva
  // el recargo del método). Sin la confirmación explícita del operador el ajuste
  // se rechaza ANTES de tocar nada —ni una fila, ni el stock, ni la auditoría—;
  // con ella sigue el camino de siempre.
  const newBalance = invoiceNetBalance({
    total: newTotal,
    surcharge,
    payments: detail.payments,
  });
  const sobreCobro = overCollectedEdit(newBalance);
  if (sobreCobro && !input.confirmar_bajo_cobrado) {
    throw new BillingError(
      "OVERCOLLECTED",
      overCollectedEditMessage({
        ...sobreCobro,
        consecutive_number: detail.invoice.consecutive_number,
      }),
      422,
    );
  }

  // Inventario por deltas netos por producto vía la frontera (pre-valida
  // stock antes de mutar; solo los incrementos requieren stock).
  const oldQtyByProduct = new Map<string, number>();
  for (const row of detail.items) {
    if (row.item_type === "producto" && row.product_id) {
      oldQtyByProduct.set(row.product_id, (oldQtyByProduct.get(row.product_id) ?? 0) + Number(row.qty));
    }
  }
  const newQtyByProduct = new Map<string, number>();
  for (const item of input.items) {
    if (item.item_type === "producto" && item.product_id) {
      newQtyByProduct.set(item.product_id, (newQtyByProduct.get(item.product_id) ?? 0) + Number(item.qty));
    }
  }
  const productIds = [...new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()])];
  const emittedIncrements = productIds
    .map((productId) => ({
      product_id: productId,
      qty: (newQtyByProduct.get(productId) ?? 0) - (oldQtyByProduct.get(productId) ?? 0),
    }))
    .filter((line) => line.qty > 0);
  if (emittedIncrements.length > 0) {
    try {
      planStockDeduction(
        emittedIncrements,
        new Map(
          [...emittedStockMap].map(([id, entry]) => [
            id,
            { name: entry.name, stock_qty: entry.stock_qty },
          ]),
        ),
      );
    } catch {
      throw new BillingError("INSUFFICIENT_STOCK", "Stock insuficiente para el ajuste.", 409);
    }
  }

  // Aplica: ítems, métodos, snapshot de impuestos, totales, inventario, auditoría.
  const editReason = `Edición libre emitida factura #${detail.invoice.consecutive_number}${motivo ? ` — ${motivo.slice(0, 200)}` : ""}`;
  try {
    for (const row of diff.removed) {
      const { error } = await db.from("invoice_items").delete().eq("id", row.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const { old, next } of diff.changed) {
      const line = computeLineSubtotal({ qty: next.qty, unit_price: next.unit_price, discount: next.discount });
      const { error } = await db
        .from("invoice_items")
        .update({
          item_type: next.item_type,
          product_id: next.product_id ?? null,
          service_id: next.service_id ?? null,
          custom_name: next.custom_name?.trim() || null,
          employee_id: next.employee_id,
          qty: next.qty,
          unit_price: next.unit_price,
          discount: next.discount,
          ...normalizeCommissionFields(next),
          subtotal: line.subtotal,
        })
        .eq("id", old.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const item of diff.added) {
      const line = computeLineSubtotal({ qty: item.qty, unit_price: item.unit_price, discount: item.discount });
      const { error } = await db.from("invoice_items").insert({
        invoice_id: invoiceId,
        item_type: item.item_type,
        product_id: item.product_id ?? null,
        service_id: item.service_id ?? null,
        custom_name: item.custom_name?.trim() || null,
        employee_id: item.employee_id,
        qty: item.qty,
        unit_price: item.unit_price,
        discount: item.discount,
        ...normalizeCommissionFields(item),
        subtotal: line.subtotal,
      });
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    for (const payment of input.payments) {
      const method = refs.methodByCode.get(payment.method_code);
      const { error } = await db
        .from("invoice_payments")
        .update({ method_code: payment.method_code, method_id: method?.id ?? null })
        .eq("id", payment.id);
      if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    const { error: taxesDeleteError } = await db.from("invoice_taxes").delete().eq("invoice_id", invoiceId);
    if (taxesDeleteError) throw new BillingError("INTERNAL", "Error interno.", 500);
    if (totals.taxes.length > 0) {
      const { error: taxesError } = await db.from("invoice_taxes").insert(
        totals.taxes.map((tax) => ({
          invoice_id: invoiceId,
          tax_code: tax.tax_code,
          tax_name: tax.tax_name,
          percent: tax.percent,
          amount: tax.amount,
        })),
      );
      if (taxesError) throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    const { data: updated, error: updateError } = await db
      .from("invoices")
      .update({
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        surcharge,
        total: newTotal,
      })
      .eq("id", invoiceId)
      .select(INVOICE_SELECT)
      .single();
    if (updateError || !updated) throw new BillingError("INTERNAL", "Error interno.", 500);
    const inventoryMoves: Array<{ product_id: string; qty: number; type: "IN" | "OUT" }> = [];
    for (const productId of productIds) {
      const delta = (newQtyByProduct.get(productId) ?? 0) - (oldQtyByProduct.get(productId) ?? 0);
      if (delta === 0) continue;
      const type = delta > 0 ? "OUT" : "IN";
      await registerMovement({ product_id: productId, type, qty: Math.abs(delta), reason: editReason }, actor);
      inventoryMoves.push({ product_id: productId, qty: Math.abs(delta), type });
    }
    await writeAudit({
      sede_id: actor.sedeId,
      user_id: actor.userId,
      action: AUDIT_ACTIONS.INVOICE_EDITED,
      entity: "invoices",
      entity_id: invoiceId,
      metadata: {
        consecutive_number: detail.invoice.consecutive_number,
        modo: "libre_emitida",
        motivo,
        admin_override: isAdmin && detail.invoice.user_id !== actor.userId,
        total_antes: Number(detail.invoice.total),
        total_nuevo: newTotal,
        // La confirmación convierte el sobre-cobro en un acto DELIBERADO y
        // explicable después: la MISMA acción INVOICE_EDITED (la que ya cubre
        // esta edición) deja el rastro de que hubo confirmación y las cifras del
        // aviso. No se inventa una acción nueva: `AUDIT_ACTIONS` es el
        // vocabulario cerrado del sistema (src/shared/lib/audit.ts) y este
        // ajuste ya se audita como INVOICE_EDITED.
        ...(sobreCobro
          ? {
              bajo_cobrado_confirmado: true,
              cobrado_neto: sobreCobro.cobrado,
              bajo_cobrado_diferencia: sobreCobro.diferencia,
            }
          : {}),
        items_before: diff.removed.length + diff.changed.length,
        items_added: diff.added.length,
        inventory_moves: inventoryMoves,
      },
    });
    return loadDetail(db, updated as InvoiceRow);
  } catch (error) {
    throw toBillingError(error);
  }
}

/** ¿Alguna línea de `detail_json` menciona esta factura? */
function detailHasInvoice(detail: unknown, invoiceId: string): boolean {
  return (
    Array.isArray(detail) &&
    detail.some(
      (line) => typeof line === "object" && line !== null && (line as { invoice_id?: string }).invoice_id === invoiceId,
    )
  );
}

/**
 * ¿La factura ya entró en una nómina cerrada? (bloquea tocar al pagado).
 *
 * U5: antes leía `.limit(200)` períodos y `.limit(2000)` ítems, SIN orden y sin
 * aviso. Pasado cualquiera de los dos topes la respuesta era `false`, o sea que
 * el candado PAYROLL_LOCKED FALLABA ABIERTO: una factura cuya comisión ya se
 * había pagado en un período cerrado se podía repreciar o reasignar. El tope era
 * de TRANSPORTE (lo que aguanta un request), no de negocio. Ahora se pagina
 * hasta agotar, en orden determinista (`id`), y si la lectura no se puede
 * completar se LANZA: el llamador rechaza la edición. Nunca `false` por no haber
 * podido mirar, porque un `false` acá autoriza a tocar plata ya pagada.
 *
 * Los ids de período van en lotes (`in(...)` viaja en la URL: una lista sin
 * tope termina en 414 y la lectura no ocurre) y los ítems se leen por páginas,
 * cortando en la primera línea que menciona la factura para no traer todo el
 * historial a memoria.
 *
 * LÍMITE CONOCIDO, SIN CAMBIO DE ALCANCE: el candado reconoce la factura por una
 * línea de `detail_json`, y ese detalle lo escribe `buildEmployeeCommissionDetail`
 * (payroll/schemas.ts) SOLO con las líneas que tienen base de comisión. Una
 * factura cuyas líneas no comisionan a nadie no aparece en ninguna nómina; en ese
 * caso tampoco había comisión pagada que proteger, pero el candado no la ve. No
 * se ensancha acá: no existe otra fuente que ligue factura e ítem de nómina, así
 * que cambiar el alcance exige decidir antes qué se considera "pagado".
 */
async function invoiceInClosedPayroll(db: DbClient, sedeId: string, invoiceId: string): Promise<boolean> {
  try {
    const closedPeriods = await readAllClosedPeriods(db, sedeId);
    if (closedPeriods.length === 0) return false;
    for (let start = 0; start < closedPeriods.length; start += IN_FILTER_CHUNK_SIZE) {
      const chunk = closedPeriods.slice(start, start + IN_FILTER_CHUNK_SIZE);
      for await (const batch of readPagedBatches<{ detail_json: unknown }>({
        table: "payroll_items",
        fetchPage: (from, to) =>
          db
            .from("payroll_items")
            .select("detail_json")
            .in("period_id", chunk)
            .order("id")
            .range(from, to),
      })) {
        if (batch.some((row) => detailHasInvoice(row.detail_json, invoiceId))) return true;
      }
    }
    return false;
  } catch (error) {
    // "No se pudo evaluar" se traduce a un error de negocio: el llamador rechaza
    // la edición. Si esto devolviera `false`, el candado fallaría ABIERTO.
    throw toBillingError(error);
  }
}

/**
 * Períodos CERRADOS de la sede, todos y en orden (U5: sin `.limit(200)`). Se
 * leen en lotes del tamaño que después aguanta el `in(...)` de los ítems.
 */
async function readAllClosedPeriods(db: DbClient, sedeId: string): Promise<string[]> {
  const periods = await readAllPaged<{ id: string }>({
    table: "payroll_periods",
    pageSize: IN_FILTER_CHUNK_SIZE,
    fetchPage: (from, to) =>
      db
        .from("payroll_periods")
        .select("id")
        .eq("sede_id", sedeId)
        .eq("status", "cerrado")
        .order("id")
        .range(from, to),
  });
  return periods.map((row) => row.id);
}

// ------------------------------------------------------------------ cobrar ---

/**
 * FAC-07: registra porciones de pago (métodos activos) contra el saldo.
 * Rechaza sobrepago; si las porciones completan el total → Pagada.
 * Solo admin/caja (vía requireBillingWriter en rutas/actions).
 *
 * B1: pagar NO mueve stock — el descuento ocurrió al emitir (momento
 * único FAC-06). Descontar aquí duplicaría la salida.
 */
export async function splitPayment(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: BillingActor,
): Promise<InvoiceDetail> {
  const parsed = splitPaymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await billingDb();
  const detail = await getInvoiceDetail(sedeId, id);
  if (detail.invoice.status === "Anulada") {
    throw new BillingError("ANNUL_INVALID", annulBlockedMessage("Anulada"), 409);
  }

  // F2: el cobro exige caja abierta (CAJ-02). Solo la caja dueña del
  // turno o un administrador puede pagar o anular.
  const openShift = await getOpenShiftWithOpener(sedeId).catch(() => null);
  if (!openShift) {
    throw new BillingError(
      "NO_OPEN_SHIFT",
      "No hay caja abierta: abre tu turno para pagar.",
      409,
    );
  }
  const isAdmin = (actor.roles ?? []).includes("admin");
  if (openShift.opened_by !== actor.userId && !isAdmin) {
    const owner = openShift.opener_name?.trim() || null;
    throw new BillingError(
      "SHIFT_NOT_OWNER",
      owner
        ? `Esta factura es del turno de ${owner}: solo ${owner} o un administrador puede pagarla o anularla.`
        : "El turno abierto es de otro cajero: solo quien abrió el turno o un administrador puede pagar o anular.",
      403,
    );
  }

  const refs = await loadRefs(sedeId);
  for (const portion of parsed.data.portions) {
    if (!refs.methodByCode.has(portion.method_code)) {
      throw new BillingError(
        "METHOD_INACTIVE",
        `El método de pago ${portion.method_code} no está activo en esta sede.`,
        422,
      );
    }
  }

  // Recargo por método también al pagar después: los inputs son NETOS
  // (igual que al crear); el bruto cubre el saldo y el fee queda auditado.
  const fees = computeCardFees(
    parsed.data.portions,
    (code) => refs.methodByCode.get(code)?.feePercent ?? 0,
  );
  const netSum = roundMoney(fees.reduce((acc, fee) => acc + fee.net, 0));
  // El saldo cobrable es NETO. `detail.paid` es el BRUTO cobrado, así que
  // `total − detail.paid` quedaba corto en el recargo de los cobros
  // posteriores a la emisión (o cuando un cobro con tarjeta de caja dejó su
  // fila en `invoice_payments`): la porción final se cobraba incompleta y la
  // factura quedaba Pagada con neto sin cobrar.
  const balance = invoiceNetBalance({
    total: detail.invoice.total,
    surcharge: detail.invoice.surcharge,
    payments: detail.payments,
  });
  if (!moneyEquals(netSum, balance.netRemaining)) {
    throw new BillingError(
      netSum - balance.netRemaining > 0 ? "OVERPAID" : "SUM_MISMATCH",
      netSum - balance.netRemaining > 0
        ? "Las porciones superan el saldo pendiente."
        : "Las porciones no cubren el saldo pendiente.",
      422,
    );
  }
  // Cierra la factura el NETO cobrado, no el bruto: con el recargo de un
  // cobro posterior a la emisión el bruto supera `total` y comparar bruto
  // contra total era lo que marcaba Pagada sin neto completo.
  const fullyPaid =
    balance.netCollected + netSum - balance.netBilled > -MONEY_EPSILON;

  // El cobro pertenece al turno abierto AHORA (dueño del dinero en caja),
  // que puede ser otro turno/cajera que el de emisión.
  const payShift = openShift;

  const { error: insertError } = await db.from("invoice_payments").insert(
    fees.map((fee) => ({
      invoice_id: id,
      method_id: refs.methodByCode.get(fee.method_code)?.id ?? null,
      method_code: fee.method_code,
      amount: fee.gross,
      fee_percent: fee.feePercent,
      fee_amount: fee.fee,
      cash_shift_id: payShift.id,
    })),
  );
  if (insertError) {
    // Carrera perdida contra trg_invoice_payments_cap (031): mismo P0001 que
    // nómina traduce en payroll/service.ts.
    if ((insertError as { code?: string }).code === "P0001") {
      throw new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);
    }
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  if (fullyPaid && detail.invoice.status === "Emitida") {
    const { data: updated, error: updateError } = await db
      .from("invoices")
      .update({ status: "Pagada", closed_by: actor.userId, closed_at: new Date().toISOString() })
      .eq("id", id)
      .select(INVOICE_SELECT)
      .single();
    if (updateError || !updated) throw new BillingError("INTERNAL", "Error interno.", 500);
    return loadDetail(db, updated as InvoiceRow);
  }
  return getInvoiceDetail(sedeId, id);
}
