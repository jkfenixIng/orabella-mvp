import { z } from "zod";

/** FAC-01: un solo origen por línea (producto O servicio O custom). */
export const invoiceItemTypeSchema = z.enum(["producto", "servicio", "custom"]);
export type InvoiceItemType = z.infer<typeof invoiceItemTypeSchema>;

/** FAC-04: estados de la factura interna (sin borrado, solo transiciones). */
export const invoiceStatusSchema = z.enum(["Emitida", "Pagada", "Anulada"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

const uuidSchema = z.uuid("Identificador inválido.");

/** Tolerancia de centavo al comparar sumas de dinero (redondeo a 2 dec). */
export const MONEY_EPSILON = 0.01;

/** Redondea a 2 decimales (numérico de dinero numeric(12,2)). */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** true cuando dos montos cuadran dentro de la tolerancia de centavo. */
export function moneyEquals(a: number, b: number): boolean {
  return Math.abs(a - b) < MONEY_EPSILON;
}

const moneySchema = (label: string) =>
  z.coerce.number().nonnegative(`${label} no puede ser negativo.`);

/**
 * FAC-01/FAC-02: línea de factura. El origen único se valida en
 * superRefine (mismo mensaje claro a nivel app que el CHECK SQL):
 * producto exige product_id, servicio exige service_id, custom exige
 * custom_name con valor. employee_id siempre requerido (base T7).
 */
export const invoiceItemSchema = z
  .object({
    item_type: invoiceItemTypeSchema,
    product_id: uuidSchema.nullish(),
    service_id: uuidSchema.nullish(),
    custom_name: z.string().trim().max(120, "Nombre muy largo.").nullish(),
    employee_id: uuidSchema,
    qty: z.coerce.number().int("Cantidad entera.").positive("La cantidad debe ser mayor a 0."),
    unit_price: moneySchema("El precio"),
    discount: moneySchema("El descuento").default(0),
    no_commission: z.boolean().optional().default(false),
    commission_value: z.coerce.number().min(0, "La comisión no puede ser negativa.").optional().nullable(),
  })
  .superRefine((value, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    switch (value.item_type) {
      case "producto":
        if (!value.product_id) fail("La línea de producto exige un producto.");
        if (value.service_id) fail("La línea de producto no lleva servicio.");
        if (value.custom_name?.trim()) fail("La línea de producto no lleva nombre personalizado.");
        break;
      case "servicio":
        if (!value.service_id) fail("La línea de servicio exige un servicio.");
        if (value.product_id) fail("La línea de servicio no lleva producto.");
        if (value.custom_name?.trim()) fail("La línea de servicio no lleva nombre personalizado.");
        break;
      case "custom":
        if (!value.custom_name?.trim()) fail("La línea personalizada exige un nombre.");
        if (value.product_id) fail("La línea personalizada no lleva producto.");
        if (value.service_id) fail("La línea personalizada no lleva servicio.");
        if (!value.no_commission && (value.commission_value === undefined || value.commission_value === null || value.commission_value < 0)) {
          fail("La línea personalizada con comisión exige el valor de la comisión en pesos.");
        }
        if (value.no_commission && value.commission_value !== undefined && value.commission_value !== null) {
          fail("La línea personalizada sin comisión no debe tener valor de comisión.");
        }
        break;
    }
    const lineGross = value.qty * value.unit_price;
    if (value.discount > lineGross) {
      fail("El descuento de la línea no puede superar su valor bruto.");
    }
  });
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;

/** FAC-07: porción del cobro con su método de pago (monto > 0). */
export const paymentPortionSchema = z.object({
  method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
  amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
});
export type PaymentPortionInput = z.infer<typeof paymentPortionSchema>;

/** FAC-01…07: creación de factura (descuento a nivel factura + porciones). */
export const createInvoiceSchema = z.object({
  client_name: z.string().trim().max(120, "Nombre muy largo.").optional(),
  client_document: z.string().trim().max(20, "Documento inválido.").nullish(),
  items: z.array(invoiceItemSchema).min(1, "La factura exige al menos un ítem."),
  discount: moneySchema("El descuento").default(0),
  payments: z.array(paymentPortionSchema).default([]),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/** FAC-04: anulación con motivo obligatorio (sin borrado). */
export const annulInvoiceSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de anulación es requerido.").max(500, "Motivo muy largo."),
});
export type AnnulInvoiceInput = z.infer<typeof annulInvoiceSchema>;

/**
 * Edición admin de factura (total inmutable): cambia ítems y métodos de
 * pago con motivo obligatorio. Los ítems llevan `id` cuando son filas
 * existentes (sin id = fila nueva; ids viejos ausentes = eliminadas).
 * Los pagos conservan montos: solo puede cambiar el método.
 */
export const editInvoiceItemSchema = invoiceItemSchema.extend({
  id: uuidSchema.optional(),
});
export type EditInvoiceItemInput = z.infer<typeof editInvoiceItemSchema>;

export const editInvoicePaymentSchema = z.object({
  id: uuidSchema,
  method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
});
export type EditInvoicePaymentInput = z.infer<typeof editInvoicePaymentSchema>;

export const editInvoiceSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de edición es requerido.").max(500, "Motivo muy largo."),
  items: z.array(editInvoiceItemSchema).min(1, "La factura exige al menos un ítem."),
  payments: z.array(editInvoicePaymentSchema).default([]),
});
export type EditInvoiceInput = z.infer<typeof editInvoiceSchema>;

export interface OldInvoiceItem {
  id: string;
  item_type: string;
  product_id?: string | null | undefined;
  service_id?: string | null | undefined;
  custom_name?: string | null | undefined;
  employee_id: string;
  qty: number;
  unit_price: number;
  discount: number;
  no_commission: boolean | null | undefined;
  commission_value: number | null | undefined;
}

export interface InvoiceItemsDiff {
  added: EditInvoiceItemInput[];
  removed: OldInvoiceItem[];
  changed: Array<{ old: OldInvoiceItem; next: EditInvoiceItemInput }>;
  /** Toca quién cobra o cuánto (empleado, comisión, cant., precio). */
  payTouched: boolean;
}

/** Diferencia ítems viejos vs nuevos por id (puros, sin BD). */
export function diffInvoiceItems(oldItems: OldInvoiceItem[], nextItems: EditInvoiceItemInput[]): InvoiceItemsDiff {
  const oldById = new Map(oldItems.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const added: EditInvoiceItemInput[] = [];
  const changed: Array<{ old: OldInvoiceItem; next: EditInvoiceItemInput }> = [];
  let payTouched = false;
  const same = (a: number | null | undefined, b: number | null | undefined): boolean => (a ?? 0) === (b ?? 0);
  for (const next of nextItems) {
    if (!next.id || !oldById.has(next.id)) {
      added.push(next);
      payTouched = true;
      continue;
    }
    seen.add(next.id);
    const old = oldById.get(next.id) as OldInvoiceItem;
    const equal =
      old.item_type === next.item_type &&
      (old.product_id ?? null) === (next.product_id ?? null) &&
      (old.service_id ?? null) === (next.service_id ?? null) &&
      (old.custom_name ?? null) === (next.custom_name?.trim() || null) &&
      old.employee_id === next.employee_id &&
      Number(old.qty) === Number(next.qty) &&
      Number(old.unit_price) === Number(next.unit_price) &&
      Number(old.discount) === Number(next.discount) &&
      Boolean(old.no_commission) === Boolean(next.no_commission) &&
      same(old.commission_value, next.commission_value ?? null);
    if (!equal) {
      changed.push({ old, next });
      if (
        old.employee_id !== next.employee_id ||
        Boolean(old.no_commission) !== Boolean(next.no_commission) ||
        !same(old.commission_value, next.commission_value ?? null) ||
        Number(old.qty) !== Number(next.qty) ||
        Number(old.unit_price) !== Number(next.unit_price)
      ) {
        payTouched = true;
      }
    }
  }
  const removed = oldItems.filter((row) => !seen.has(row.id));
  if (removed.length > 0 || added.length > 0) payTouched = true;
  return { added, removed, changed, payTouched };
}

/** Subtotal de un borrador de edición (puros). */
export function editItemsSubtotal(items: Array<{ qty: number; unit_price: number; discount: number }>): number {
  return roundMoney(items.reduce((acc, item) => acc + computeLineSubtotal(item).subtotal, 0));
}

/**
 * Regla de oro de la edición: el total NO se toca. Con descuento fijo e
 * impuestos snapshot intactos, basta exigir mismo subtotal y mismo recargo.
 * Lanza TOTAL_MISMATCH si no cuadra.
 */
export function assertEditReconciles(args: {
  oldSubtotal: number;
  newSubtotal: number;
  oldSurcharge: number;
  newSurcharge: number;
  oldTotal: number;
}): void {
  if (!moneyEquals(args.newSubtotal, args.oldSubtotal)) {
    throw new Error(
      `TOTAL_MISMATCH: el nuevo subtotal (${args.newSubtotal}) debe igualar al emitido (${args.oldSubtotal}). Ajuste cantidades/precios.`,
    );
  }
  if (!moneyEquals(args.newSurcharge, args.oldSurcharge)) {
    throw new Error(
      `TOTAL_MISMATCH: el recargo resultante (${args.newSurcharge}) debe igualar al emitido (${args.oldSurcharge}). Use métodos con igual recargo.`,
    );
  }
}

/** FAC-07: cobro dividido (las porciones deben cuadrar con el saldo). */
export const splitPaymentSchema = z.object({
  portions: z.array(paymentPortionSchema).min(1, "Indique al menos una porción de pago."),
});
export type SplitPaymentInput = z.infer<typeof splitPaymentSchema>;

// ------------------------------------------------------------ cálculos puros ---

export interface ComputedLine {
  gross: number;
  discount: number;
  subtotal: number;
}

/** Subtotal de una línea: qty × precio − descuento de línea. */
export function computeLineSubtotal(item: { qty: number; unit_price: number; discount: number }): ComputedLine {
  const gross = roundMoney(item.qty * item.unit_price);
  const discount = roundMoney(Math.min(item.discount, gross));
  return { gross, discount, subtotal: roundMoney(gross - discount) };
}

export interface ActiveTax {
  code: string;
  name: string;
  percent: number;
}

export interface TaxSnapshot {
  tax_code: string;
  tax_name: string;
  percent: number;
  amount: number;
}

/**
 * FAC-03: snapshot de los impuestos ACTIVOS sobre la base
 * (subtotal − descuento de factura). Los inactivos se excluyen (suman 0).
 * Puro para probarlo sin base de datos.
 */
export function snapshotInvoiceTaxes(activeTaxes: ActiveTax[], base: number): TaxSnapshot[] {
  const taxable = Math.max(0, roundMoney(base));
  return activeTaxes.map((tax) => ({
    tax_code: tax.code,
    tax_name: tax.name,
    percent: tax.percent,
    amount: roundMoney((taxable * tax.percent) / 100),
  }));
}

export interface InvoiceTotals {
  subtotal: number;
  discount: number;
  base: number;
  taxes: TaxSnapshot[];
  tax: number;
  surcharge: number;
  total: number;
}

/**
 * Recargo por método (p. ej. tarjeta 5%): fee = neto × feePercent / 100
 * por porción. El cliente paga el BRUTO (neto + recargo). Puro.
 */
export interface CardFee {
  method_code: string;
  net: number;
  feePercent: number;
  fee: number;
  gross: number;
}

export function computeCardFees(
  portions: Array<{ method_code: string; amount: number }>,
  feeByMethod: (methodCode: string) => number,
): CardFee[] {
  return portions.map((portion) => {
    const net = roundMoney(portion.amount);
    const feePercent = feeByMethod(portion.method_code) ?? 0;
    const fee = roundMoney((net * feePercent) / 100);
    return { method_code: portion.method_code, net, feePercent, fee, gross: roundMoney(net + fee) };
  });
}

/**
 * FAC-01/FAC-03: total = subtotal − descuento + impuestos (snapshot).
 * Lanza DESCUENTO_EXCEDE cuando el descuento supera el subtotal.
 * Puro para probarlo sin base de datos.
 */
export function computeInvoiceTotals(args: {
  items: Array<{ qty: number; unit_price: number; discount: number }>;
  discount: number;
  activeTaxes: ActiveTax[];
  surcharge?: number;
}): InvoiceTotals {
  const subtotal = roundMoney(
    args.items.reduce((acc, item) => acc + computeLineSubtotal(item).subtotal, 0),
  );
  const discount = roundMoney(args.discount);
  if (discount - subtotal > MONEY_EPSILON) {
    throw new Error("DESCUENTO_EXCEDE");
  }
  const base = roundMoney(Math.max(0, subtotal - discount));
  const taxes = snapshotInvoiceTaxes(args.activeTaxes, base);
  const tax = roundMoney(taxes.reduce((acc, row) => acc + row.amount, 0));
  const surcharge = roundMoney(args.surcharge ?? 0);
  return { subtotal, discount, base, taxes, tax, surcharge, total: roundMoney(base + tax + surcharge) };
}

export interface SplitCheck {
  paid: number;
  remaining: number;
  fullyPaid: boolean;
}

/**
 * FAC-07: valida porciones nuevas contra el saldo pendiente. Lanza
 * SOBREPAGO si exceden el saldo. Puro para probarlo sin base de datos.
 */
export function applyPaymentSplit(args: {
  paidSoFar: number;
  portions: Array<{ amount: number }>;
  total: number;
}): SplitCheck {
  const incoming = roundMoney(args.portions.reduce((acc, row) => acc + row.amount, 0));
  if (incoming <= 0) throw new Error("PORCION_INVALIDA");
  const paid = roundMoney(args.paidSoFar + incoming);
  if (paid - args.total > MONEY_EPSILON) throw new Error("SOBREPAGO");
  const remaining = roundMoney(Math.max(0, args.total - paid));
  return { paid, remaining, fullyPaid: moneyEquals(paid, args.total) };
}

/** Las porciones de una llamada deben sumar exactamente el saldo pendiente. */
export function portionsMatchBalance(portions: Array<{ amount: number }>, balance: number): boolean {
  const sum = roundMoney(portions.reduce((acc, row) => acc + row.amount, 0));
  return moneyEquals(sum, balance);
}

// ------------------------------------------------------------------ estados ---

/** FAC-04: solo Emitida/Pagada admiten anulación (Anulada es terminal). */
export function canAnnulStatus(status: string): boolean {
  return status === "Emitida" || status === "Pagada";
}

/** Mensaje de negocio cuando el estado no admite anulación. */
export function annulBlockedMessage(status: string): string {
  if (status === "Anulada") return "La factura ya está anulada.";
  return `No se puede anular una factura en estado ${status}.`;
}

/**
 * FAC-05: reserva N números consecutivos desde el último emitido.
 * Simula la serie que next_invoice_number() produce bajo lock
 * (SELECT … FOR UPDATE): 1..N únicos y continuos. Puro para probar la
 * propiedad sin concurrencia real de BD (ver tests).
 */
export function nextConsecutiveNumbers(lastNumber: number, count: number): number[] {
  if (!Number.isInteger(count) || count <= 0) throw new Error("CONTEO_INVALIDO");
  return Array.from({ length: count }, (_, index) => lastNumber + index + 1);
}

/**
 * FAC-06: movimientos IN de reversión por cada ítem de producto de la
 * factura anulada. El motivo lleva el consecutivo + motivo de anulación
 * (auditoría en el kardex). Puro para probarlo sin base de datos.
 */
export function buildReversalReasons(args: {
  consecutiveNumber: number;
  motivo: string;
  productItems: Array<{ product_id: string; qty: number }>;
}): Array<{ product_id: string; qty: number; reason: string }> {
  const motivo = args.motivo.trim().slice(0, 200);
  return args.productItems.map((item) => ({
    product_id: item.product_id,
    qty: item.qty,
    reason: `Reversión factura #${args.consecutiveNumber} — ${motivo}`,
  }));
}

/** Motivo OUT de stock al facturar (trazable al consecutivo). */
export function buildInvoiceOutReason(consecutiveNumber: number, clientName: string | null | undefined): string {
  const name = clientName?.trim() ?? "Cliente sin nombre";
  return `FACTURA #${consecutiveNumber} — ${name.slice(0, 120)}`;
}
