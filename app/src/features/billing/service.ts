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
  type EditInvoiceItemInput,
  type InvoiceItemInput,
  type PaymentPortionInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole } from "@/src/shared/lib/sede";
import { dayBounds } from "@/src/shared/lib/dates";
import { listPaymentMethods, listServices, listTaxes } from "@/src/features/admin/service";
import {
  getProductsStock,
  InventoryError,
  type StockEntry,
} from "@/src/features/inventory/service";
import { planStockDeduction, type PlannedDeduction } from "@/src/features/inventory/schemas";
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

// CO-1 / CL-1 / CL-12: los DOS candados que protegen una edición de factura.
//
// El token es `invoices.edit_version` (migración 038): un contador que cambia en
// CADA edición exitosa, y la precondición es `(versión, estado)` —CL-1: el estado
// es la OTRA mitad de la decisión, porque la edición decide con el estado que
// LEYÓ (`Anulada` es terminal, la libre rechaza `Pagada`) y entre esa lectura y
// la escritura cabe una anulación o un cobro—. El candado es por FILA, no global:
// editar otra factura no se bloquea.
//
// CO-1 lo reclamaba desde el cliente con un compare-and-swap (un `UPDATE` de
// `edit_version` con las dos guardas en el `WHERE`, ANTES de la primera escritura
// de la edición) y declaraba su propio límite: no era una transacción, así que
// una tercera edición podía leer los ítems viejos después de que la ganadora
// reclamara el token. CL-12 cierra ese límite moviendo el candado ADENTRO de la
// transacción: el token se escribe en la MISMA sentencia que la edición, con
// `(versión, estado)` como precondición en su `WHERE` y la fila bloqueada con
// `FOR UPDATE` (migración 051). Una edición concurrente ESPERA el lock de la fila
// y después se RECHAZA con `EDIT_CONFLICT` (409) sin escribir una sola fila. El
// rechazo sigue siendo el MISMO error de negocio accionable de siempre —nunca un
// 500— y su traducción desde el RPC vive en `toRpcEditError`.

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
  /**
   * CO-1: token de serialización de la edición (migración 038). Cambia en cada
   * edición exitosa; es la precondición del compare-and-swap que rechaza la
   * edición simultánea con EDIT_CONFLICT antes de tocar stock.
   */
  edit_version: number;
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
  "id, consecutive_number, client_name, client_document, subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id, closed_by, closed_at, cancel_reason, created_at, edit_version";
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
      `${error instanceof Error ? error.message : "La lectura de invoice_items quedó incompleta."} No se puede listar ni contar sin las facturas del empleado: con el conjunto recortado faltarían facturas y el paginador mostraría páginas vacías. Reintente y, si persiste, revise el volumen de datos de la instalación.`,
      500,
    );
  }
}

/** Lista facturas con filtros + paginación (más recientes primero). */
export async function listInvoices(filters: InvoiceFilters = {}): Promise<InvoiceListItem[]> {
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
        `${error instanceof Error ? error.message : "La lectura de invoices quedó incompleta."} No se muestra el listado: con las facturas recortadas faltarían facturas del empleado. Reintente y, si persiste, revise el volumen de datos de la instalación.`,
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
      `${error instanceof Error ? error.message : "La lectura de los ítems de factura quedó incompleta."} No se muestra el listado: sin los ítems no se sabe qué empleados participaron. Reintente y, si persiste, revise el volumen de datos de la instalación.`,
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
export async function countInvoices(filters: InvoiceFilters = {}): Promise<number> {
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
    let query = db.from("invoices").select("id", { count: "exact", head: true });
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

/**
 * Detalle con ítems, snapshot de impuestos y porciones.
 *
 * No recibe sede: la instalación es de una sola y la fila no trae la columna.
 */
export async function getInvoiceDetail(id: string): Promise<InvoiceDetail> {
  const db = await billingDb();
  const { data: invoice, error } = await db
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  if (!invoice) throw new BillingError("NOT_FOUND", "Factura no encontrada.", 404);
  return loadDetail(db, invoice as InvoiceRow);
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
      `${error instanceof Error ? error.message : "La lectura de commission_rules quedó incompleta."} No se muestra la comisión: con las reglas incompletas la cifra no coincidiría con lo que paga la nómina. Reintente y, si persiste, revise el volumen de datos de la instalación.`,
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
 * centavo con lo que hay guardado. No hay ninguna migración que repare esos
 * centavos —y no hace falta: la app todavía no está en producción, así que esas
 * filas son datos de prueba descartables—. Mientras existan, esos cuadres siguen
 * al centavo, porque el valor guardado ES el hecho.
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
 * a lo sumo un peso, y desaparece sola en cuanto la fila deja de traer centavos
 * (el histórico con centavos es de la era en que la app redondeaba al centavo).
 * Sin este redondeo el cobro de una factura legacy es
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
async function loadRefs(): Promise<ValidatedRefs> {
  const [taxes, methods] = await Promise.all([
    listTaxes(),
    listPaymentMethods(),
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
 * Verifica existencia de cada referencia de los ítems (productos, servicios,
 * empleados). B1: los productos se validan vía la frontera de inventario
 * (getProductsStock) — billing NUNCA toca las tablas de inventory directo.
 * Devuelve el mapa de stock para que el llamador pre-verifique disponibilidad
 * ANTES de reservar el consecutivo (FAC-05 sin huecos) o de mutar. Sin N+1: una
 * sola query con IN por tabla (productos vía servicio + empleados) más el
 * catálogo de servicios; el bucle posterior es en memoria.
 *
 * La SEDE no es un criterio de esta validación: con una sola instalación, una
 * referencia que existe PERTENECE a la instalación, así que la comprobación es
 * de existencia y el error sigue siendo NOT_FOUND.
 */
async function validateItemRefs(
  items: InvoiceItemInput[],
): Promise<Map<string, StockEntry>> {
  const db = await billingDb();
  const serviceRows = await listServices(500);
  const serviceIds = new Set(serviceRows.map((row) => row.id));

  const productIds = [...new Set(
    items
      .filter((item) => item.item_type === "producto" && item.product_id)
      .map((item) => item.product_id as string),
  )];
  const employeeIds = [...new Set(items.map((item) => item.employee_id))];

  const [stockMap, employeeRes] = await Promise.all([
    productIds.length > 0
      ? getProductsStock(productIds)
      : Promise.resolve(new Map<string, StockEntry>()),
    employeeIds.length > 0
      ? db.from("employees").select("id").in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (employeeRes.error) {
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }
  const employeeIdsFound = new Set(
    ((employeeRes.data ?? []) as Array<{ id: string }>).map((row) => row.id),
  );

  for (const item of items) {
    // `getProductsStock` solo devuelve productos existentes: ausente =
    // inexistente.
    if (item.item_type === "producto" && item.product_id) {
      if (!stockMap.has(item.product_id)) {
        throw new BillingError("NOT_FOUND", "Producto no encontrado.", 404);
      }
    }
    if (item.item_type === "servicio" && item.service_id) {
      if (!serviceIds.has(item.service_id)) {
        throw new BillingError("NOT_FOUND", "Servicio no encontrado.", 404);
      }
    }
    if (!employeeIdsFound.has(item.employee_id)) {
      throw new BillingError("NOT_FOUND", "Empleado no encontrado.", 404);
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

/**
 * CL-11: el error del RPC `invoice_annul_atomic` (050) traducido al MISMO
 * contrato de negocio que la anulación devolvía antes.
 *
 * La forma del error es la de PostgREST —un objeto `{code, message, …}`, no un
 * `Error`— y todas sus `RAISE EXCEPTION` salen con el MISMO SQLSTATE (P0001: el
 * de un `RAISE EXCEPTION` plano, que es también el del tope de cobro de 031 y el
 * de los triggers de stock), así que lo único confiable es el MENSAJE, igual que
 * en `deductStock` (046).
 *
 *   * `ANNUL_CONFLICT` — el estado de la fila ya no es el que el servicio leyó
 *     (otra anulación ganó la carrera): la transacción no escribió NADA. Es el
 *     MISMO código y el MISMO mensaje que el servicio devolvía cuando perdía el
 *     compare-and-swap en el cliente (PGRST116). `INVOICE_NOT_FOUND` —la fila
 *     desapareció entre la lectura y la escritura— sale por el mismo código: en
 *     el camino viejo también terminaba en ANNUL_CONFLICT, porque el `.single()`
 *     sin filas era el mismo PGRST116.
 *   * `PRODUCT_NOT_FOUND` — la red de conteo de la transacción: un producto de
 *     la reversión no existe y la anulación NO se aplicó. La SEDE no es un
 *     criterio (igual que en `validateItemRefs`): `products` no trae la columna,
 *     así que lo único que el conteo puede encontrar es que el producto no
 *     exista. Es el MISMO 404 —"Producto no encontrado."— que devolvía
 *     `getProduct` cuando el bucle de reversiones pasaba por
 *     `registerMovement`.
 *   * `ANNUL_INVALID` (entrada mal formada) y `PAYMENT_MISMATCH` no deberían
 *     poder llegar desde acá: la entrada la arma este mismo módulo y el conteo
 *     lo hace la función. Si llegan, es un fallo real y se reporta como
 *     INTERNAL en vez de disfrazarse.
 */
function toRpcAnnulError(error: { code?: unknown; message?: unknown } | null): BillingError {
  const message = String(error?.message ?? "");
  if (message.includes("ANNUL_CONFLICT") || message.includes("INVOICE_NOT_FOUND")) {
    return new BillingError(
      "ANNUL_CONFLICT",
      "La factura ya no está en el estado con el que se leyó (posible anulación simultánea): no se anuló nada, vuelva a intentarlo.",
      409,
    );
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return new BillingError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  return new BillingError("INTERNAL", "Error interno.", 500);
}

/**
 * CL-12: el error del RPC de EDICIÓN (051) traducido al MISMO contrato de negocio
 * que la edición devolvía antes.
 *
 * La forma del error es la de PostgREST —un objeto `{code, message, …}`, no un
 * `Error`— y todas sus `RAISE EXCEPTION` salen con el MISMO SQLSTATE (P0001: el
 * de un `RAISE EXCEPTION` plano, que es también el del trigger de stock de 004),
 * así que lo único confiable es el MENSAJE, igual que en `deductStock` (046) y
 * en `toRpcAnnulError` (050).
 *
 *   * `EDIT_CONFLICT` — la versión o el estado de la fila ya no son los que el
 *     servicio leyó (otra edición, o una anulación, o un cobro, ganaron la
 *     carrera): la transacción no escribió NADA. Es el MISMO código, el MISMO
 *     mensaje y el MISMO 409 que el servicio devolvía cuando perdía el
 *     compare-and-swap en el cliente (PGRST116). `INVOICE_NOT_FOUND` —la fila
 *     desapareció entre la lectura y la escritura— sale por el mismo código: en
 *     el camino viejo también terminaba en EDIT_CONFLICT, porque el `.single()`
 *     sin filas era el mismo PGRST116.
 *   * `PRODUCT_NOT_FOUND` — la red de conteo del ajuste: un producto no existe
 *     (la SEDE no es un criterio, por la misma razón que arriba) y la edición NO
 *     se aplicó. Es el MISMO 404 —"Producto no encontrado."— que devolvía
 *     `getProduct` cuando el bucle de ajustes pasaba por `registerMovement`.
 *   * `INSUFFICIENT_STOCK` — el trigger de stock de 004 rechazó un OUT que
 *     dejaría el stock negativo (la foto que tomó `planStockDeduction` puede
 *     haber quedado vieja: la guarda que manda es la del trigger, y corre
 *     ADENTRO). Es el MISMO 409 y el MISMO mensaje de `registerMovement`.
 *   * `EDIT_INVALID` (entrada mal formada), `ITEM_MISMATCH`, `PAYMENT_MISMATCH` y
 *     `TAX_MISMATCH` no deberían poder llegar desde acá: la entrada la arma este
 *     mismo módulo y los conteos los hace la función. Si llegan, es un fallo real
 *     y se reporta como INTERNAL en vez de disfrazarse.
 */
function toRpcEditError(error: { code?: unknown; message?: unknown } | null): BillingError {
  const message = String(error?.message ?? "");
  if (message.includes("EDIT_CONFLICT") || message.includes("INVOICE_NOT_FOUND")) {
    return new BillingError(
      "EDIT_CONFLICT",
      "El estado de la factura cambió entre la lectura y la escritura, o se aplicó otra edición (posible edición simultánea): no se ajustó nada. Vuelva a abrir la factura y repita la edición.",
      409,
    );
  }
  if (message.includes("INSUFFICIENT_STOCK")) {
    return new BillingError("INSUFFICIENT_STOCK", "Stock insuficiente para el ajuste.", 409);
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return new BillingError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  return new BillingError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------ crear ---

export interface BillingActor {
  userId: string;
  /**
   * Ya no decide nada: la instalación es de una sola sede. El campo sobrevive
   * porque las fixtures de `tests/billing.test.ts` se anotan como `BillingActor`
   * y lo declaran; quitarlo de la interfaz las rompería por exceso de propiedad.
   */
  sedeId: string;
  roles?: RoleCode[];
}

/**
 * MO-1: la factura que ya se emitió con esa marca, si existe.
 *
 * La marca es un uuid que genera la PANTALLA al empezar el intento y que viaja
 * en el cuerpo; se reutiliza en los reintentos del MISMO intento. Deduplicar por
 * CONTENIDO sería otra cosa y estaría mal: dos clientes distintos comprando lo
 * mismo, o el mismo cliente comprando dos veces, son ventas legítimamente
 * repetidas y no deben colapsarse. La marca es lo único que distingue "el mismo
 * envío" de "el mismo contenido".
 *
 * El filtro es por la MARCA, no por la sede: la marca identifica el envío y la
 * fila se resuelve por `idempotency_key` dentro de las facturas de la instalación
 * (una sola sede). El detalle de una factura nunca se devuelve por acá sin el
 * `id` que la pide.
 */
async function findInvoiceByIdempotencyKey(
  db: DbClient,
  idempotencyKey: string,
): Promise<InvoiceRow | null> {
  const { data, error } = await db
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  return (data as InvoiceRow | null) ?? null;
}

/**
 * CL-13: el error del RPC de EMISIÓN (052) traducido al MISMO contrato de
 * negocio que la emisión devolvía antes.
 *
 * La forma del error es la de PostgREST —un objeto `{code, message, …}`, no un
 * `Error`— y todas las `RAISE EXCEPTION` de la función salen con el MISMO
 * SQLSTATE (P0001: el de un `RAISE EXCEPTION` plano, que es también el del
 * trigger de stock de 004 y el del tope de cobro de 031), así que lo único
 * confiable es el MENSAJE, igual que en `deductStock` (046),
 * `toRpcAnnulError` (050) y `toRpcEditError` (051).
 *
 *   * `INSUFFICIENT_STOCK` — el trigger de 004 rechazó un OUT que dejaría el
 *     stock negativo (la foto que tomó `planStockDeduction` puede haber quedado
 *     vieja: la guarda que manda es la del trigger, y corre ADENTRO). Es el
 *     MISMO 409 y el MISMO mensaje que devolvía `deductStock`.
 *   * `PRODUCT_NOT_FOUND` — la red de conteo de la deducción: el producto no
 *     existe (la SEDE no es un criterio, por la misma razón que arriba). Es el
 *     MISMO 404 —"Producto no encontrado."— que devolvía `getProduct`.
 *   * `SHIFT_NOT_OPEN` — la precondición del turno se vuelve a comprobar sobre
 *     la fila bloqueada y en la ventana lectura→escritura el turno se cerró. Es
 *     el MISMO código, el MISMO mensaje y el MISMO 409 que ya devolvía la
 *     comprobación del servicio: el llamador no ve una diferencia.
 *   * el tope de cobro de 031 (su `RAISE EXCEPTION` nombra el neto facturado)
 *     es el MISMO 422 `OVERPAID` que ya traducía el INSERT de las porciones.
 *   * `INVOICE_INVALID`, `ITEM_MISMATCH`, `TAX_MISMATCH`, `PAYMENT_MISMATCH`,
 *     `MOVEMENT_MISMATCH`, `OUT_REASON_INVALID` y `SEDE_NOT_FOUND` no deberían
 *     poder llegar desde acá: la entrada la arma este mismo módulo y los conteos
 *     los hace la función. Si llegan, es un fallo real y se reporta como
 *     INTERNAL en vez de disfrazarse.
 */
function toRpcCreateError(error: { message?: unknown } | null): BillingError {
  const message = String(error?.message ?? "");
  if (message.includes("INSUFFICIENT_STOCK")) {
    return new BillingError(
      "INSUFFICIENT_STOCK",
      "Stock insuficiente: el movimiento dejaría el stock negativo.",
      409,
    );
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return new BillingError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  if (message.includes("SHIFT_NOT_OPEN")) {
    return new BillingError("NO_OPEN_SHIFT", "No hay caja abierta: abre tu turno para emitir.", 409);
  }
  if (message.includes("El cobro supera")) {
    return new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);
  }
  return new BillingError("INTERNAL", "Error interno.", 500);
}

/**
 * CL-13: el token que la transacción de emisión sustituye por el consecutivo, y
 * el motivo del OUT como PLANTILLA.
 *
 * El motivo sale de `buildInvoiceOutReason` —la MISMA función de formato, con un
 * consecutivo SENTINELA imposible (`-1`: el CHECK de 005 exige
 * `consecutive_number > 0`)— y el sentinela se reemplaza por el token. Así el
 * texto (`FACTURA #`, el separador, el recorte y el respaldo de nombre) no se
 * duplica en ningún lado: lo decide TypeScript una sola vez, y la transacción
 * —donde nace el número— sólo sustituye la PRIMERA ocurrencia por el
 * consecutivo que ella reservó. `String.replace` con un patrón de texto
 * reemplaza sólo la primera, así que un nombre de cliente que contuviera el
 * sentinela no puede confundirse con el número.
 */
const OUT_REASON_TOKEN = "{consecutivo}";
const OUT_REASON_SENTINEL = -1;

export function buildInvoiceOutReasonTemplate(clientName: string | null | undefined): string {
  return buildInvoiceOutReason(OUT_REASON_SENTINEL, clientName).replace(
    `#${OUT_REASON_SENTINEL}`,
    `#${OUT_REASON_TOKEN}`,
  );
}

/**
 * FAC-01…07: crea la factura (consecutivo, snapshot de impuestos activos, OUT de
 * stock por producto, porciones que cuadran). Estado inicial Emitida; si las
 * porciones suman el total → Pagada. B1: este es el MOMENTO ÚNICO del descuento;
 * pagar después no descuenta de nuevo.
 *
 * MO-1 (idempotencia): el orden empieza por la MARCA (`idempotency_key`,
 * migración 041). Un reintento del MISMO envío se detecta ANTES de cualquier
 * escritura y devuelve la factura ya emitida —no-op exitoso para el
 * llamador—, así que el camino normal de la repetición no escribe ni reserva
 * nada. La ventana entre ese lookup y la escritura la cubre el índice único
 * parcial (sede_id, idempotency_key), que ahora se evalúa DENTRO de la misma
 * transacción que la emisión.
 *
 * CL-13: LA EMISIÓN ES UNA TRANSACCIÓN (RPC `invoice_create_atomic`, migración
 * 052). Antes era una SECUENCIA de requests sueltos —el consecutivo, la factura,
 * las líneas, los impuestos, las porciones y la deducción— compensada por su
 * rutina de limpieza best-effort: un bucle de reversiones y cuatro `DELETE`
 * dentro de un `catch {}` que se tragaba su propio error: si la compensación
 * fallaba a mitad, quedaba una factura viva con su dinero borrado y su stock ya
 * devuelto (y una anulación posterior devolvía el stock OTRA vez), sin que nadie
 * se enterara más que del error original. Ahora los cinco grupos de escritura
 * —la factura, las líneas, el snapshot de impuestos, las porciones y el OUT de
 * stock— son grupos de la MISMA sentencia del servidor: o se escriben todos, o no
 * se escribe ninguno. **No hay compensación**, así que no hay `catch {}` que
 * tragarse nada y no hay residuo que reparar. La rutina desapareció con este
 * cambio: el registro de qué hacía y de dónde salieron las líneas que se midieron
 * queda en la migración 052.
 *
 * El CONSECUTIVO se reserva ADENTRO (`next_invoice_number`, 005 y re-emitida
 * por 072): el incremento de la fila `invoice_sequence` de `system_settings`
 * pertenece a la misma transacción, así que un fallo lo REVIERTE con ella y la
 * serie queda sin huecos —ni el que dejaba un fallo posterior a la reserva, ni
 * el que dejaba la carrera de la 041—. Esa fila es la que la función bloquea
 * con `FOR UPDATE`, igual que antes bloqueaba la de `invoice_sequences`: el lock
 * es lo que impide que dos emisiones concurrentes se lleven el mismo número. El
 * servicio ya no reserva nada: sólo computa y manda DATOS.
 *
 * QUÉ SIGUE COMPUTANDO EL SERVICIO (y no cruza a SQL): los subtotales por línea
 * (`computeLineSubtotal`), el snapshot de impuestos y los totales
 * (`computeInvoiceTotals`), el recargo por método (`computeCardFees`), el total
 * con recargo, el estado (`Emitida`/`Pagada`), los campos de comisión
 * (`normalizeCommissionFields`), el plan de stock agregado por producto
 * (`planStockDeduction`) y el motivo del OUT. La función sólo escribe lo que
 * recibe.
 *
 * LO QUE SIGUE IGUAL: el pre-chequeo de stock con su mensaje de negocio por
 * producto (que ahora es una red de negocio, no la forma de evitar huecos: el
 * hueco ya no puede existir), el turno abierto con su regla de dueño/admin, el
 * `SPLIT_MISMATCH` de las porciones, la marca OBLIGATORIA y su lookup previo, la
 * auditoría FUERA de la transacción (`writeAudit` no lanza: a lo sumo falta la
 * fila de auditoría, nunca una escritura a medias) y el detalle devuelto.
 */
export async function createInvoice(raw: unknown, actor: BillingActor): Promise<InvoiceDetail> {
  const parsed = createInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: CreateInvoiceInput = parsed.data;
  const db = await billingDb();

  // MO-1: la MARCA primero, ANTES de reservar el consecutivo y antes de validar
  // catálogos. Un reintento (doble clic, o el navegador reenviando tras cortarse
  // la red) trae la MISMA marca: se devuelve la factura que ya existe y no se
  // reserva nada. El reintento es un no-op EXITOSO para el llamador, no un
  // error; y como no hay reserva, tampoco hay hueco en la serie.
  const alreadyEmitted = await findInvoiceByIdempotencyKey(db, input.idempotency_key);
  if (alreadyEmitted) return loadDetail(db, alreadyEmitted);

  let refs: ValidatedRefs;
  let stockMap: Map<string, StockEntry>;
  // CL-13: el plan de stock se computa UNA sola vez —agregado por producto— y
  // viaja como DATO a la transacción, que es quien lo escribe (vía
  // `deduct_stock_atomic`, 046). Antes se computaba dos veces —el pre-chequeo de
  // acá y el de `deductStock`, con otra lectura del stock— y el resultado del
  // primero se descartaba. Ahora la guarda de negocio y el dato son el MISMO
  // cálculo.
  let stockPlan: PlannedDeduction[];
  try {
    refs = await loadRefs();
    stockMap = await validateItemRefs(input.items);
    // B1/FAC-05: pre-verifica stock con mensaje de negocio POR PRODUCTO. Ya no es
    // la forma de evitar un hueco en la serie —el hueco no puede existir: la
    // reserva es de la transacción— sino la guarda que le dice al operador QUÉ
    // producto falta, ANTES de escribir nada. La autoridad final sigue siendo el
    // trigger de 004, que corre adentro.
    try {
      stockPlan = planStockDeduction(
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
        `El método de pago ${portion.method_code} no está activo en la instalación.`,
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
    const openShift = await getOpenShiftWithOpener();
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

  // CL-13: LA EMISIÓN ENTERA, en UNA sentencia del servidor. El consecutivo
  // (005), la factura, sus líneas, su snapshot de impuestos, sus porciones y el
  // OUT de stock (046) son grupos de la MISMA transacción: o se escriben todos,
  // o no se escribe ninguno —y con ellos se revierte la reserva del
  // consecutivo—. La clave está en que acá NO se manda un número: la función lo
  // reserva adentro y lo sustituye en la plantilla del motivo del OUT.
  const { data: written, error: createError } = await db.rpc("invoice_create_atomic", {
    p_user_id: actor.userId,
    p_cash_shift_id: cashShiftId,
    p_idempotency_key: input.idempotency_key,
    p_invoice: {
      client_name: input.client_name?.trim() || null,
      client_document: input.client_document?.trim() || null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      surcharge,
      total: grandTotal,
      status,
      closed_by: status === "Pagada" ? actor.userId : null,
      closed_at: status === "Pagada" ? new Date().toISOString() : null,
    },
    p_items: input.items.map((item) => ({
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
    p_taxes: totals.taxes.map((tax) => ({
      tax_code: tax.tax_code,
      tax_name: tax.tax_name,
      percent: tax.percent,
      amount: tax.amount,
    })),
    // `cash_shift_id` NO viaja por porción: es el mismo en todas (la sede tiene
    // un turno abierto) y la función escribe el escalar en cada fila.
    p_payments: fees.map((fee) => ({
      method_id: methodByCode.get(fee.method_code)?.id ?? null,
      method_code: fee.method_code,
      amount: fee.gross,
      fee_percent: fee.feePercent,
      fee_amount: fee.fee,
    })),
    // El motivo del OUT como PLANTILLA (ver `buildInvoiceOutReasonTemplate`): el
    // consecutivo lo conoce la transacción, que lo reserva, no el servicio.
    p_out_reason: buildInvoiceOutReasonTemplate(input.client_name),
    // El plan de stock: QUÉ se descuenta, agregado por producto, lo computó
    // `planStockDeduction`. La función lo escribe vía `deduct_stock_atomic`
    // (046), con su conteo y el trigger de 004 como autoridad final.
    p_out_items: stockPlan.map((item) => ({ product_id: item.product_id, qty: item.qty })),
  });
  if (createError || !written) {
    console.error("PG invoice_create_atomic:", JSON.stringify(createError));
    if ((createError as { code?: string } | null)?.code === "23505") {
      // Dos índices únicos pueden dar 23505 acá: el consecutivo
      // (sede_id, consecutive_number) y la marca (sede_id, idempotency_key).
      // Manda la MARCA: si otra emisión con la misma marca se confirmó entre el
      // lookup de arriba y esta transacción (la carrera), su factura es la
      // respuesta y este intento no escribe una segunda.
      //
      // CL-13: SIN COSTO DE NUMERACIÓN. La reserva del consecutivo pertenece a
      // esta misma transacción, así que el choque la REVIERTE con ella: la
      // perdedora de la carrera NO quema ningún número. El hueco que la 041
      // documentaba como costo declarado ya no puede existir —y con él se fue la
      // última razón para que el servicio reservara por su cuenta—.
      const winner = await findInvoiceByIdempotencyKey(db, input.idempotency_key);
      if (winner) return loadDetail(db, winner);
      // Sin factura con esa marca, el choque es del CONSECUTIVO: comportamiento
      // de siempre (barrera final de 005).
      throw new BillingError("DUPLICATE_NUMBER", "Consecutivo duplicado, reintente la emisión.", 409);
    }
    // Cualquier otro rechazo de la transacción NO escribió una sola fila: no hay
    // nada que compensar ni residuo que reparar. El código de negocio se traduce
    // como siempre (`toRpcCreateError`).
    throw toRpcCreateError(createError as { message?: unknown } | null);
  }
  const invoice = written as InvoiceRow;
  const consecutive = invoice.consecutive_number;

  // Audit log para creación de factura (con info de admin override si aplica).
  // FUERA de la transacción, como en las anulaciones y las ediciones: no es un
  // punto de fallo de estado (`writeAudit` no lanza), así que a lo sumo falta la
  // fila de auditoría, nunca una escritura a medias.
  await writeAudit({
    user_id: actor.userId,
    action: AUDIT_ACTIONS.INVOICE_CREATED,
    entity: "invoices",
    entity_id: invoice.id,
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

  return loadDetail(db, invoice);
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
 *
 * CL-11: el UPDATE y las N reversiones de stock pasan a ser UNA transacción
 * (RPC `invoice_annul_atomic`, migración 050). Antes eran dos requests —el
 * estado de la factura y DESPUÉS un `registerMovement` por línea de producto—,
 * y un fallo entre los dos dejaba la factura Anulada con el stock devuelto a
 * medias; como el compare-and-swap sólo pisa una factura en el estado leído, el
 * reintento ya no encontraba una factura anulable: el stock que faltaba devolver
 * no se devolvía nunca. Ahora o se escriben las dos cosas, o ninguna.
 *
 * Lo que NO cambia: el estado anulable (`canAnnulStatus`), el candado de nómina
 * cerrada, el compare-and-swap, el motivo obligatorio y qué se revierte —las
 * líneas de producto, sus cantidades y el texto de la reversión
 * (`buildReversalReasons`) siguen computándose acá, en TypeScript, y viajan como
 * DATO—. La precondición de estado se vuelve a comprobar DENTRO de la
 * transacción, sobre la fila bloqueada: una transacción no es un camino para
 * saltear una guarda.
 */
/**
 * No recibe sede: la instalación es de una sola y la fila no trae la columna.
 */
export async function annulInvoice(
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

  const detail = await getInvoiceDetail(id);
  if (!canAnnulStatus(detail.invoice.status)) {
    throw new BillingError("ANNUL_INVALID", annulBlockedMessage(detail.invoice.status), 409);
  }

  // U6-a: mismo candado que las dos ediciones. Si la lectura del historial no
  // se puede completar, `invoiceInClosedPayroll` LANZA (READ_INCOMPLETE) y la
  // anulación se rechaza: nunca un `false` por no haber podido mirar.
  if (await invoiceInClosedPayroll(db, id)) {
    throw new BillingError(
      "PAYROLL_LOCKED",
      "La factura ya entró en una nómina cerrada: al empleado pagado no se le toca, y anularla dejaría esa comisión pagada sin reverso.",
      409,
    );
  }

  // U6-b/CL-11: el estado leído es la precondición de la transacción. Si otra
  // anulación (o un cobro) movió la fila entre la lectura y esta escritura, la
  // transacción entera se rechaza con ANNUL_CONFLICT y NO se ejecuta ni la
  // reversión de stock ni una parte de ella. Sin esta guarda, dos anulaciones
  // simultáneas devolvían el stock dos veces.
  //
  // CL-11: qué se revierte se decide ACÁ —las líneas de producto, sus cantidades
  // y el texto del kardex— y viaja como DATO. La función sólo escribe filas, en
  // la misma transacción que el estado de la factura.
  const productItems = detail.items
    .filter((item) => item.item_type === "producto" && item.product_id)
    .map((item) => ({ product_id: item.product_id as string, qty: item.qty }));
  const reversals = buildReversalReasons({
    consecutiveNumber: detail.invoice.consecutive_number,
    motivo,
    productItems,
  });

  const { data: written, error: annulError } = await db.rpc("invoice_annul_atomic", {
    p_invoice_id: id,
    p_user_id: actor.userId,
    // El instante lo resuelve el servicio, como en el cierre de caja (049): la
    // función escribe lo que recibe.
    p_closed_at: new Date().toISOString(),
    p_motivo: motivo,
    p_expected_status: detail.invoice.status,
    p_items: reversals.map((reversal) => ({
      product_id: reversal.product_id,
      qty: reversal.qty,
      reason: reversal.reason,
    })),
  });
  if (annulError || !written) {
    throw toRpcAnnulError(annulError as { code?: unknown; message?: unknown } | null);
  }

  await writeAudit({
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

  return loadDetail(db, written as InvoiceRow);
}

// ------------------------------------------------------------------ editar ---

/**
 * CL-12: las columnas de UNA línea de ítem, tal como la edición las escribe.
 *
 * Es la MISMA proyección para la actualización y para la inserción (por eso una
 * sola función: dos listas de columnas al lado de la otra es un lugar donde se
 * separan sin que nadie lo note), y es la proyección que antes escribía el
 * cliente en cada `update`/`insert`: el `subtotal` sale de `computeLineSubtotal`
 * y los campos de comisión de `normalizeCommissionFields`, en TypeScript. La
 * función de la 051 la escribe verbatim.
 */
function editItemColumns(item: EditInvoiceItemInput): Record<string, unknown> {
  const line = computeLineSubtotal({ qty: item.qty, unit_price: item.unit_price, discount: item.discount });
  return {
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
  };
}

/**
 * CL-12: el ajuste de stock de una edición, computado acá y enviado como DATO.
 *
 * El delta es NETO por producto (la suma de las cantidades viejas contra la suma
 * de las nuevas), y el tipo sale de su signo: OUT si la factura lleva más
 * unidades que antes, IN si lleva menos. Los deltas que quedan en cero no
 * escriben un movimiento: no movieron stock. El motivo es el mismo para todos
 * los movimientos de una edición (el del kardex, con el consecutivo de la
 * factura) y lo arma el llamador.
 */
function buildEditStockMoves(args: {
  productIds: string[];
  oldQtyByProduct: Map<string, number>;
  newQtyByProduct: Map<string, number>;
  reason: string;
}): Array<{ product_id: string; type: "IN" | "OUT"; qty: number; reason: string }> {
  const moves: Array<{ product_id: string; type: "IN" | "OUT"; qty: number; reason: string }> = [];
  for (const productId of args.productIds) {
    const delta =
      (args.newQtyByProduct.get(productId) ?? 0) - (args.oldQtyByProduct.get(productId) ?? 0);
    if (delta === 0) continue;
    moves.push({
      product_id: productId,
      type: delta > 0 ? "OUT" : "IN",
      qty: Math.abs(delta),
      reason: args.reason,
    });
  }
  return moves;
}

/**
 * Edición admin de factura (total INMUTABLE): corrige ítems y métodos de
 * pago con motivo obligatorio. Reglas:
 * - Empleado/comisión/cant./precio bloqueados si la factura ya entró en
 *   una nómina cerrada (al que se le pagó no se le toca).
 * - Nuevo subtotal y recargo deben igualar a los emitidos (si no, se rechaza).
 * - Cambios de método solo entre iguales recargos.
 * - ANULADA es terminal: no se edita. Inventario se reajusta por deltas.
 * - Todo queda en audit_logs con motivo + antes/después.
 *
 * CL-12: la edición entera —el candado de la 038 incluido— es UNA transacción
 * (RPC `invoice_edit_items_atomic`, migración 051). Antes eran requests sueltos
 * —el token, el borrado, las actualizaciones, las altas, los cobros y un
 * `registerMovement` por producto— y un fallo a mitad dejaba los ítems escritos,
 * el stock a medias y el token avanzado, con el reintento rechazado por el
 * propio candado: un callejón sin salida. Ahora o se escriben todas las filas, o
 * ninguna. Lo que NO cambia: qué se escribe —el diff, los subtotales, el delta
 * de stock y su motivo— se computa acá, en TypeScript, y viaja como DATO; y la
 * inmutabilidad del total es ESTRUCTURAL, porque la función no tiene un grupo
 * capaz de escribir dinero.
 */
/**
 * No recibe sede: la instalación es de una sola y la fila no trae la columna.
 */
export async function editInvoiceItems(
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

  const detail = await getInvoiceDetail(invoiceId);
  if (detail.invoice.status === "Anulada") {
    throw new BillingError("ANNUL_INVALID", "Anulada es terminal: no se edita (emita una nueva).", 409);
  }

  let refs: ValidatedRefs;
  let stockMap: Map<string, StockEntry>;
  try {
    refs = await loadRefs();
    stockMap = await validateItemRefs(
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
        `El método de pago ${payment.method_code} no está activo en la instalación.`,
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

  if (diff.payTouched && (await invoiceInClosedPayroll(db, invoiceId))) {
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

  // CL-12: la edición entera —el candado de la 038 incluido— es UNA transacción
  // (RPC `invoice_edit_items_atomic`, migración 051). El servicio ya computó TODO
  // lo que hay que escribir: el diff de `diffInvoiceItems`, el subtotal de cada
  // línea (`computeLineSubtotal`), el delta NETO por producto con su tipo y el
  // motivo del kardex. La función sólo escribe filas.
  //
  // El candado deja de reclamarse desde el cliente: viaja como la precondición
  // `(versión, estado)` que la función contrasta contra la fila BLOQUEADA, así que
  // una edición concurrente ESPERA y se rechaza con `EDIT_CONFLICT` sin escribir
  // una sola fila. Antes, la perdedora alcanzaba a reclamar su token y el fallo a
  // mitad de la secuencia dejaba la factura con los ítems escritos, el stock a
  // medias y el token avanzado —sin forma de reintentar—.
  const editReason = `Ajuste edición factura #${detail.invoice.consecutive_number} — ${motivo.slice(0, 200)}`;
  const inventoryMoves = buildEditStockMoves({
    productIds,
    oldQtyByProduct,
    newQtyByProduct,
    reason: editReason,
  });
  const { data: written, error: editError } = await db.rpc("invoice_edit_items_atomic", {
    p_invoice_id: invoiceId,
    p_user_id: actor.userId,
    p_expected_version: Number(detail.invoice.edit_version),
    p_expected_status: detail.invoice.status,
    p_edit: {
      items_remove: diff.removed.map((row) => row.id),
      items_update: diff.changed.map(({ old, next }) => ({ id: old.id, ...editItemColumns(next) })),
      items_insert: diff.added.map((item) => editItemColumns(item)),
      // Los cobros: los MISMOS ids y los MISMOS montos (la igualdad de ids ya se
      // validó arriba); lo único que cambia es el método, y su recargo igual.
      payments: input.payments.map((payment) => ({
        id: payment.id,
        method_code: payment.method_code,
        method_id: refs.methodByCode.get(payment.method_code)?.id ?? null,
      })),
      movements: inventoryMoves,
    },
  });
  if (editError || !written) {
    throw toRpcEditError(editError as { code?: unknown; message?: unknown } | null);
  }

  // Segunda barrera en la frontera: la función ya revierte si escribió menos de
  // lo pedido, así que un conteo distinto sólo puede venir de una respuesta
  // incoherente. Se reporta como fallo real en vez de devolver un detalle que la
  // base no escribió.
  const result = written as { invoice: InvoiceRow; items: number; movements: number };
  if (
    result.items !== diff.removed.length + diff.changed.length + diff.added.length ||
    result.movements !== inventoryMoves.length
  ) {
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  // La auditoría queda FUERA de la transacción (el mismo límite que 049 y 050):
  // es un INSERT posterior y `writeAudit` no lanza, así que a lo sumo falta la
  // fila de auditoría, nunca una escritura a medias. Las cifras son las de
  // siempre, con el motivo y los movimientos que el servicio CREYÓ escribir.
  await writeAudit({
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
      inventory_moves: inventoryMoves.map(({ product_id, qty, type }) => ({ product_id, qty, type })),
    },
  });
  // La fila ESCRITA por la transacción (no la leída): sin una segunda lectura y
  // sin su ventana.
  return loadDetail(db, result.invoice);
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
 *
 * CL-12: la edición libre entera —el candado de la 038 incluido— es UNA
 * transacción (RPC `invoice_edit_emitted_atomic`, migración 051), la MISMA forma
 * de la admin MÁS el REEMPLAZO del snapshot de impuestos y los totales
 * recalculados. El reemplazo es lo que la vuelve distinta: entre el `DELETE` del
 * snapshot viejo y el `INSERT` del nuevo había una ventana en la que la factura
 * quedaba SIN impuestos —que no es ni el snapshot anterior ni el nuevo—, y el
 * cierre de turno se firmaba ARRIBA de ese estado. Ahora las dos mitades del
 * reemplazo —y los totales, y el stock— son la misma transacción: o queda la
 * colección ANTERIOR completa, o queda la NUEVA completa.
 */
/**
 * No recibe sede: la instalación es de una sola y la fila no trae la columna.
 */
export async function editEmittedInvoiceItems(
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

  const detail = await getInvoiceDetail(invoiceId);
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
    const openShift = await getOpenShiftWithOpener().catch(() => null);
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
    refs = await loadRefs();
    emittedStockMap = await validateItemRefs(
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
        `El método de pago ${payment.method_code} no está activo en la instalación.`,
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

  if (diff.payTouched && (await invoiceInClosedPayroll(db, invoiceId))) {
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
  // histórico que puede traer centavos): por eso el total
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

  // CL-12: la edición libre entera —el candado de la 038 incluido— es UNA
  // transacción (RPC `invoice_edit_emitted_atomic`, migración 051). Es la MISMA
  // forma que la edición admin MÁS el REEMPLAZO del snapshot de impuestos y los
  // totales recalculados, que es lo que esta edición agrega: los tres siguen
  // computándose acá y viajan como DATO.
  //
  // El candado deja de reclamarse desde el cliente: viaja como la precondición
  // `(versión, estado)` que la función contrasta contra la fila BLOQUEADA. Antes,
  // la perdedora reclamaba el token y el fallo a mitad de la secuencia dejaba los
  // ítems, los impuestos y los totales escritos, el stock a medias y el token
  // avanzado —con el cierre de turno firmándose arriba de ese estado—.
  const editReason = `Edición libre emitida factura #${detail.invoice.consecutive_number}${motivo ? ` — ${motivo.slice(0, 200)}` : ""}`;
  const inventoryMoves = buildEditStockMoves({
    productIds,
    oldQtyByProduct,
    newQtyByProduct,
    reason: editReason,
  });
  const { data: written, error: editError } = await db.rpc("invoice_edit_emitted_atomic", {
    p_invoice_id: invoiceId,
    p_user_id: actor.userId,
    p_expected_version: Number(detail.invoice.edit_version),
    p_expected_status: detail.invoice.status,
    p_edit: {
      items_remove: diff.removed.map((row) => row.id),
      items_update: diff.changed.map(({ old, next }) => ({ id: old.id, ...editItemColumns(next) })),
      items_insert: diff.added.map((item) => editItemColumns(item)),
      payments: input.payments.map((payment) => ({
        id: payment.id,
        method_code: payment.method_code,
        method_id: refs.methodByCode.get(payment.method_code)?.id ?? null,
      })),
      movements: inventoryMoves,
      // El REEMPLAZO del snapshot: los ids del que se LEYÓ y el que se computó,
      // con su monto ya calculado por `snapshotInvoiceTaxes` (FAC-03).
      taxes_remove: detail.taxes.map((tax) => tax.id),
      taxes: totals.taxes.map((tax) => ({
        tax_code: tax.tax_code,
        tax_name: tax.tax_name,
        percent: tax.percent,
        amount: tax.amount,
      })),
      // Y los cinco números de la factura: los que computó `computeInvoiceTotals`
      // (más el recargo EMITIDO que esta edición conserva, ya sumado en
      // `newTotal`).
      totals: {
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        surcharge,
        total: newTotal,
      },
    },
  });
  if (editError || !written) {
    throw toRpcEditError(editError as { code?: unknown; message?: unknown } | null);
  }

  // Segunda barrera en la frontera (la misma de la edición admin).
  const result = written as { invoice: InvoiceRow; items: number; movements: number };
  if (
    result.items !== diff.removed.length + diff.changed.length + diff.added.length ||
    result.movements !== inventoryMoves.length
  ) {
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  await writeAudit({
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
      inventory_moves: inventoryMoves.map(({ product_id, qty, type }) => ({ product_id, qty, type })),
    },
  });
  return loadDetail(db, result.invoice);
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
async function invoiceInClosedPayroll(db: DbClient, invoiceId: string): Promise<boolean> {
  try {
    const closedPeriods = await readAllClosedPeriods(db);
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
 * Períodos CERRADOS, todos y en orden (U5: sin `.limit(200)`). Se leen en
 * lotes del tamaño que después aguanta el `in(...)` de los ítems.
 */
async function readAllClosedPeriods(db: DbClient): Promise<string[]> {
  const periods = await readAllPaged<{ id: string }>({
    table: "payroll_periods",
    pageSize: IN_FILTER_CHUNK_SIZE,
    fetchPage: (from, to) =>
      db
        .from("payroll_periods")
        .select("id")
        .eq("status", "cerrado")
        .order("id")
        .range(from, to),
  });
  return periods.map((row) => row.id);
}

// ------------------------------------------------------------------ cobrar ---

/**
 * CL-2: las porciones de un cobro que YA se registraron con esa marca, si las
 * hay.
 *
 * La marca es un uuid que genera la PANTALLA al empezar el intento de cobro y
 * que viaja en el cuerpo; se reutiliza en los reintentos del MISMO intento. El
 * filtro es por FACTURA: la marca se resuelve dentro de la factura que la usó
 * (la que identifica la URL), así que el lookup nunca puede devolver el cobro
 * de otra factura. Las porciones hermanas de una misma operación no llevan
 * marca (ver 042), así que esto devuelve la operación por su fila de identidad;
 * la respuesta de la repetición no depende de esto (devuelve el detalle
 * completo de la factura).
 */
async function findInvoicePaymentsByIdempotencyKey(
  db: DbClient,
  invoiceId: string,
  idempotencyKey: string,
): Promise<InvoicePaymentRow[]> {
  const { data, error } = await db
    .from("invoice_payments")
    .select(`${PAYMENT_SELECT}, idempotency_key`)
    .eq("invoice_id", invoiceId)
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as InvoicePaymentRow[];
}

/**
 * FAC-07: registra porciones de pago (métodos activos) contra el saldo.
 * Rechaza sobrepago; si las porciones completan el total → Pagada.
 * Solo admin/caja (vía requireBillingWriter en rutas/actions).
 *
 * B1: pagar NO mueve stock — el descuento ocurrió al emitir (momento
 * único FAC-06). Descontar aquí duplicaría la salida.
 *
 * CL-2 (idempotencia): el orden empieza por la MARCA
 * (`idempotency_key`, migración 042), después de saber que la factura existe y
 * no está Anulada, y ANTES de leer el saldo, de las guardas de turno y de
 * cualquier escritura. Un reintento del MISMO envío devuelve el detalle ya
 * cobrado como un no-op EXITOSO.
 *
 * POR QUÉ ANTES DEL SALDO: el cobro exige que las porciones igualen el saldo
 * EXACTO. Después de un cobro bueno el saldo queda en cero, así que el
 * reintento no es que "cobre dos veces": moría con OVERPAID y el usuario veía
 * un error por una operación que sí se registró. La marca se mira antes para
 * que la repetición se reconozca en vez de confundirse con un cobro nuevo.
 *
 * POR QUÉ DESPUÉS DE LA ANULACIÓN Y NO ANTES DE LAS GUARDAS DE TURNO: la
 * anulación es una guarda de estado sobre el dinero de la factura y va primero
 * (una factura anulada no admite cobros, repetidos o no); las guardas de turno
 * son sobre QUIÉN cobra y no sobre la repetición, así que una repetición —que
 * no escribe nada— no depende de que la caja siga abierta ni de que el turno
 * siga siendo del mismo cajero. La autorización del llamador (requireBillingWriter)
 * sigue aplicándose en la action y en la ruta.
 *
 * CL-11: las porciones y el cierre de la factura pasan a ser UNA transacción
 * (RPC `invoice_split_payment_atomic`, migración 050). Antes eran dos requests
 * —el INSERT de las porciones y DESPUÉS el paso a `Pagada`—, y un fallo entre
 * los dos dejaba el dinero cobrado con la factura todavía Emitida: el saldo
 * cobrable quedaba en cero (ningún cobro posterior podía cerrarla) y el
 * reintento del mismo intento era un no-op que la devolvía abierta, así que la
 * factura no se cerraba nunca. Ahora o se escriben las dos cosas, o ninguna.
 *
 * Lo que NO cambia: la marca se busca ANTES de leer el saldo y antes de
 * cualquier escritura (una repetición sigue siendo un no-op exitoso), la
 * igualdad EXACTA entre las porciones y el saldo (`invoiceNetBalance` +
 * `moneyEquals`), el reparto por método (`computeCardFees`), la decisión
 * `Pagada` (`fullyPaid`) y el tope de 031 con el índice único parcial de la
 * 042, que siguen corriendo —ahora dentro de la misma transacción— y siguen
 * traduciéndose a los mismos errores.
 */
/**
 * No recibe sede: la instalación es de una sola y la fila no trae la columna.
 */
export async function splitPayment(
  id: string,
  raw: unknown,
  actor: BillingActor,
): Promise<InvoiceDetail> {
  const parsed = splitPaymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillingError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await billingDb();
  const detail = await getInvoiceDetail(id);
  if (detail.invoice.status === "Anulada") {
    throw new BillingError("ANNUL_INVALID", annulBlockedMessage("Anulada"), 409);
  }

  // CL-2: la MARCA primero, ANTES de leer el saldo y antes de cualquier
  // escritura. Un reintento (doble clic, o el navegador reenviando tras
  // cortarse la red) trae la MISMA marca: se devuelve el detalle que ya quedó
  // cobrado y no se escribe nada. Sin esto, el reintento moría con OVERPAID
  // (el saldo ya está en cero) sin reconocerse como repetición.
  const repeated = await findInvoicePaymentsByIdempotencyKey(
    db,
    id,
    parsed.data.idempotency_key,
  );
  if (repeated.length > 0) return getInvoiceDetail(id);

  // F2: el cobro exige caja abierta (CAJ-02). Solo la caja dueña del
  // turno o un administrador puede pagar o anular.
  const openShift = await getOpenShiftWithOpener().catch(() => null);
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

  const refs = await loadRefs();
  for (const portion of parsed.data.portions) {
    if (!refs.methodByCode.has(portion.method_code)) {
      throw new BillingError(
        "METHOD_INACTIVE",
        `El método de pago ${portion.method_code} no está activo en la instalación.`,
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
  // CL-11: la DECISIÓN de cerrar la factura se toma acá (con `fullyPaid` y el
  // estado leído) y viaja como un booleano: la transacción no compara el cobrado
  // contra el facturado ni una vez.
  const closesInvoice = fullyPaid && detail.invoice.status === "Emitida";

  // El cobro pertenece al turno abierto AHORA (dueño del dinero en caja),
  // que puede ser otro turno/cajera que el de emisión.
  const payShift = openShift;

  // CL-11: las porciones y el cierre de la factura, en UNA transacción. El
  // reparto por método lo computa `computeCardFees` (arriba) y se escribe
  // verbatim; la marca del intento de la 042 vive SÓLO en la primera porción
  // (las demás NULL): es lo que hace sonora la forma —el índice único parcial
  // no rechaza a una operación legítima de varias porciones, y el choque aborta
  // la sentencia ENTERA y con ella la transacción—, y el número de porciones que
  // la función devuelve se contrasta contra las que se pidieron.
  //
  // CL-17: la 056 agregó a esa transacción el lock del TURNO (arriba, como
  // parámetro). Un `closeShift` concurrente ya no puede cerrar el turno a mitad
  // del cobro; la transacción lo revalida y rechaza con `SHIFT_CLOSED`, que
  // abajo se traduce al mismo error de negocio que el servicio ya usa para "no
  // hay caja abierta". El cierre de la factura con sus datos (`closed_by`,
  // `closed_at`) ya viajaba y no cambia.
  const { data: written, error: payError } = await db.rpc("invoice_split_payment_atomic", {
    p_invoice_id: id,
    // CL-17: el TURNO que cobra, como PARÁMETRO de la operación (no sólo dentro
    // de cada porción). La función lo bloquea (`FOR SHARE`) ANTES de bloquear la
    // factura —orden global `cash_shifts > invoices`— y lo revalida: un
    // `closeShift` concurrente ya no puede cerrar el turno a mitad del cobro, así
    // que las porciones no pueden caer en un turno recién cerrado. Además exige
    // que TODAS las porciones pertenezcan a ese turno.
    p_shift_id: payShift.id,
    p_user_id: actor.userId,
    p_closed_at: new Date().toISOString(),
    p_mark_paid: closesInvoice,
    p_portions: fees.map((fee, index) => ({
      method_id: refs.methodByCode.get(fee.method_code)?.id ?? null,
      method_code: fee.method_code,
      amount: fee.gross,
      fee_percent: fee.feePercent,
      fee_amount: fee.fee,
      cash_shift_id: payShift.id,
      idempotency_key: index === 0 ? parsed.data.idempotency_key : null,
    })),
  });
  if (payError) {
    // CL-11: la transacción revalida adentro las precondiciones que el servicio
    // ya revisó (la factura no puede estar Anulada) y sus `RAISE EXCEPTION`
    // salen con el MISMO SQLSTATE que el tope de 031 (P0001), así que el MENSAJE
    // se mira ANTES que el código: si no, un cobro sobre una factura anulada se
    // leería como "se pasó del tope".
    const code = (payError as { code?: string } | null)?.code;
    const message = String((payError as { message?: unknown } | null)?.message ?? "");
    if (message.includes("ANNUL_INVALID")) {
      throw new BillingError("ANNUL_INVALID", annulBlockedMessage("Anulada"), 409);
    }
    // CL-17: el turno se cerró entre la lectura del servicio y el commit. La
    // transacción lo revalida sobre la fila bloqueada y rechaza; acá se traduce
    // al MISMO error de negocio con el que el servicio responde cuando no hay
    // caja abierta, en vez de un OVERPAID que no tiene nada que ver.
    if (message.includes("SHIFT_CLOSED") || message.includes("SHIFT_NOT_FOUND")) {
      throw new BillingError(
        "NO_OPEN_SHIFT",
        "No hay caja abierta: abre tu turno para pagar.",
        409,
      );
    }
    // Dos barreras pueden rechazar este INSERT, dentro de la transacción, y el
    // código lo dice: el tope de 031 (trigger BEFORE INSERT → P0001) y el índice
    // único parcial de identidad de la 042 (23505). El orden depende de cuál
    // llegue primero —el trigger de fila corre ANTES de la comprobación del
    // índice—, así que las dos se atienden igual: si la marca YA está registrada,
    // esto es una repetición y la respuesta es el detalle de la ganadora.
    if (code === "23505" || code === "P0001") {
      // COSTO DECLARADO: acá no se quema ningún número (`invoice_payments` no
      // tiene consecutivo); lo que se pierde es la transacción ABORTADA de la
      // perdedora, que ya había leído el saldo. Se prefiere eso —raro, y exige
      // dos envíos con la misma marca solapados— antes que cobrar dos veces.
      // (La factura tampoco pasa a Pagada dos veces: el cierre va en la MISMA
      // transacción que las porciones y sólo escribe si el servicio lo decidió.)
      const winner = await findInvoicePaymentsByIdempotencyKey(
        db,
        id,
        parsed.data.idempotency_key,
      );
      if (winner.length > 0) return getInvoiceDetail(id);
      // Sin cobro con esa marca, el rechazo es el de siempre: el tope.
      if (code === "P0001") {
        throw new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);
      }
      throw new BillingError("INTERNAL", "Error interno.", 500);
    }
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  const result = written as { invoice: InvoiceRow; portions: number } | null;
  // Segunda barrera en la frontera: la función ya revierte si escribió menos de
  // lo pedido, así que un conteo distinto sólo puede venir de una respuesta
  // incoherente. Se reporta como fallo real en vez de devolver un detalle que la
  // base no escribió.
  if (!result || result.portions !== fees.length) {
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }

  if (closesInvoice) return loadDetail(db, result.invoice);
  return getInvoiceDetail(id);
}
