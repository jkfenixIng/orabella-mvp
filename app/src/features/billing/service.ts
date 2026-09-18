import {
  annulInvoiceSchema,
  applyPaymentSplit,
  buildInvoiceOutReason,
  buildReversalReasons,
  canAnnulStatus,
  computeInvoiceTotals,
  createInvoiceSchema,
  annulBlockedMessage,
  portionsMatchBalance,
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
} from "@/src/features/admin/service";
import { getEmployee, listPaymentMethods, listServices, listTaxes } from "@/src/features/admin/service";
import {
  getProduct,
  registerMovement,
  InventoryError,
} from "@/src/features/inventory/service";
import { applyMovementStock } from "@/src/features/inventory/schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";

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
  client_name: string;
  client_document: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  status: string;
  user_id: string | null;
  cash_shift_id: string | null;
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
  qty: number;
  unit_price: number;
  discount: number;
  subtotal: number;
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
  created_at: string;
}

export interface InvoiceDetail {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  taxes: InvoiceTaxRow[];
  payments: InvoicePaymentRow[];
  paid: number;
  remaining: number;
}

const INVOICE_SELECT =
  "id, sede_id, consecutive_number, client_name, client_document, subtotal, discount, tax, total, status, user_id, cash_shift_id, cancel_reason, created_at";
const ITEM_SELECT =
  "id, invoice_id, item_type, product_id, service_id, custom_name, employee_id, qty, unit_price, discount, subtotal";
const TAX_SELECT = "id, invoice_id, tax_code, tax_name, percent, amount";
const PAYMENT_SELECT = "id, invoice_id, method_id, method_code, amount, created_at";

// ----------------------------------------------------------------- lectura ---

export interface InvoiceFilters {
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function dateBound(value: string, end: boolean): string {
  const trimmed = value.trim();
  // Fecha sola (yyyy-mm-dd) → rango del día en hora local del servidor.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return end ? `${trimmed}T23:59:59.999` : `${trimmed}T00:00:00`;
  }
  return trimmed;
}

/** Lista facturas de la sede con filtros de estado/fecha (más recientes primero). */
export async function listInvoices(sedeId: string, filters: InvoiceFilters = {}): Promise<InvoiceRow[]> {
  if (filters.status !== undefined && !["Emitida", "Pagada", "Anulada"].includes(filters.status)) {
    throw new BillingError("VALIDATION", "Estado de filtro inválido.", 400);
  }
  const limit = filters.limit === undefined ? 50 : Math.min(100, Math.max(1, Math.floor(filters.limit)));
  const db = await billingDb();
  let query = db
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("sede_id", sedeId)
    .order("consecutive_number", { ascending: false })
    .limit(limit);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from?.trim()) query = query.gte("created_at", dateBound(filters.from, false));
  if (filters.to?.trim()) query = query.lte("created_at", dateBound(filters.to, true));
  const { data, error } = await query;
  if (error) throw new BillingError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as InvoiceRow[];
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
    throw new BillingError("INTERNAL", "Error interno.", 500);
  }
  const payments = (paymentsRes.data ?? []) as InvoicePaymentRow[];
  const paid = round2(payments.reduce((acc, row) => acc + Number(row.amount), 0));
  return {
    invoice,
    items: (itemsRes.data ?? []) as InvoiceItemRow[],
    taxes: (taxesRes.data ?? []) as InvoiceTaxRow[],
    payments,
    paid,
    remaining: round2(Math.max(0, Number(invoice.total) - paid)),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------ ayudas ---

interface ValidatedRefs {
  activeTaxes: Array<{ code: string; name: string; percent: number }>;
  methodByCode: Map<string, { id: string; code: string }>;
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
      methods.filter((method) => method.is_active).map((method) => [method.code, { id: method.id, code: method.code }]),
    ),
  };
}

/**
 * Verifica existencia y sede de cada referencia de los ítems (productos,
 * servicios, empleados). Además pre-verifica stock de productos para
 * fallar ANTES de reservar el consecutivo (FAC-05 sin huecos).
 */
async function validateItemRefs(sedeId: string, items: InvoiceItemInput[]): Promise<void> {
  const serviceRows = await listServices(sedeId);
  const serviceSedeById = new Map(serviceRows.map((row) => [row.id, row.sede_id]));
  for (const item of items) {
    if (item.item_type === "producto" && item.product_id) {
      const product = await getProduct(item.product_id);
      if (product.sede_id !== sedeId) {
        throw new BillingError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
      }
      try {
        applyMovementStock(product.stock_qty, "OUT", item.qty);
      } catch {
        throw new BillingError(
          "INSUFFICIENT_STOCK",
          `Stock insuficiente para ${product.name}: hay ${product.stock_qty}, se piden ${item.qty}.`,
          409,
        );
      }
    }
    if (item.item_type === "servicio" && item.service_id) {
      if (serviceSedeById.get(item.service_id) !== sedeId) {
        throw new BillingError("NOT_FOUND", "Servicio no encontrado en esta sede.", 404);
      }
    }
    const employee = await getEmployee(item.employee_id);
    if (employee.sede_id !== sedeId) {
      throw new BillingError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
    }
  }
}

function toBillingError(error: unknown): BillingError {
  if (error instanceof BillingError) return error;
  if (error instanceof InventoryError) {
    return new BillingError(error.code, error.message, error.status);
  }
  if (error instanceof Error && error.message === "DESCUENTO_EXCEDE") {
    return new BillingError("VALIDATION", "El descuento no puede superar el subtotal.", 400);
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
 * impuestos activos, OUT de stock por producto, porciones que cuadran).
 * Estado inicial Emitida; si las porciones suman el total → Pagada.
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
  try {
    refs = await loadRefs(actor.sedeId);
    await validateItemRefs(actor.sedeId, input.items);
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
      "Las porciones de pago deben sumar exactamente el total de la factura.",
      422,
    );
  }
  const status = portions.length > 0 ? "Pagada" : "Emitida";

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
      for (const out of outMovements.reverse()) {
        await db.from("inventory_movements").insert({
          sede_id: actor.sedeId,
          product_id: out.product_id,
          type: "IN",
          qty: out.qty,
          reason: `Compensación fallo emisión factura #${consecutive}`,
          user_id: actor.userId,
        });
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
        client_name: input.client_name.trim(),
        client_document: input.client_document?.trim() || null,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        total: totals.total,
        status,
        user_id: actor.userId,
        cash_shift_id: null,
      })
      .select(INVOICE_SELECT)
      .single();
    if (invoiceError || !invoice) {
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
        subtotal:
          Math.round(item.qty * Number(item.unit_price) * 100) / 100 -
          Math.min(item.discount, Math.round(item.qty * Number(item.unit_price) * 100) / 100),
      })),
    );
    if (itemsError) throw new BillingError("INTERNAL", "Error interno.", 500);

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

    if (portions.length > 0) {
      const { error: paymentsError } = await db.from("invoice_payments").insert(
        portions.map((portion) => ({
          invoice_id: invoiceId,
          method_id: methodByCode.get(portion.method_code)?.id ?? null,
          method_code: portion.method_code,
          amount: portion.amount,
        })),
      );
      if (paymentsError) throw new BillingError("INTERNAL", "Error interno.", 500);
    }

    // FAC-06: OUT de stock por cada ítem producto (reutiliza registerMovement).
    const outReason = buildInvoiceOutReason(consecutive, input.client_name);
    for (const item of input.items) {
      if (item.item_type !== "producto" || !item.product_id) continue;
      try {
        await registerMovement(
          { product_id: item.product_id, type: "OUT", qty: item.qty, reason: outReason },
          actor,
        );
        outMovements.push({ product_id: item.product_id, qty: item.qty });
      } catch (error) {
        throw toBillingError(error);
      }
    }

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

  const { data: updated, error: updateError } = await db
    .from("invoices")
    .update({ status: "Anulada", cancel_reason: motivo })
    .eq("id", id)
    .select(INVOICE_SELECT)
    .single();
  if (updateError || !updated) throw new BillingError("INTERNAL", "Error interno.", 500);

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

// ------------------------------------------------------------------ cobrar ---

/**
 * FAC-07: registra porciones de pago (métodos activos) contra el saldo.
 * Rechaza sobrepago; si las porciones completan el total → Pagada.
 * Solo admin/caja (vía requireBillingWriter en rutas/actions).
 */
export async function splitPayment(
  sedeId: string,
  id: string,
  raw: unknown,
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

  let check: ReturnType<typeof applyPaymentSplit>;
  try {
    check = applyPaymentSplit({
      paidSoFar: detail.paid,
      portions: parsed.data.portions,
      total: Number(detail.invoice.total),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "SOBREPAGO") {
      throw new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);
    }
    throw new BillingError("VALIDATION", "Porciones de pago inválidas.", 400);
  }

  const { error: insertError } = await db.from("invoice_payments").insert(
    parsed.data.portions.map((portion) => ({
      invoice_id: id,
      method_id: refs.methodByCode.get(portion.method_code)?.id ?? null,
      method_code: portion.method_code,
      amount: portion.amount,
    })),
  );
  if (insertError) throw new BillingError("INTERNAL", "Error interno.", 500);

  if (check.fullyPaid && detail.invoice.status === "Emitida") {
    const { data: updated, error: updateError } = await db
      .from("invoices")
      .update({ status: "Pagada" })
      .eq("id", id)
      .select(INVOICE_SELECT)
      .single();
    if (updateError || !updated) throw new BillingError("INTERNAL", "Error interno.", 500);
    return loadDetail(db, updated as InvoiceRow);
  }
  return getInvoiceDetail(sedeId, id);
}
