import {
  commissionPayoutSchema,
  commissionRuleSchema,
  pendingCommission,
  resolveLineCommission,
  roundMoney,
  type CommissionPayoutRow,
  type CommissionRuleRow,
  type RuleRate,
} from "./schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import { cashOutUsedInShift, getOpenShift } from "@/src/features/cash/service";
import { cashOutLimitViolation } from "@/src/features/cash/schemas";
import { listPaymentMethods } from "@/src/features/admin/service";

export class CommissionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CommissionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function commissionsDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

export interface CommissionActor {
  userId: string;
  sedeId: string;
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

// ------------------------------------------------------------------ reglas ---

const RULE_SELECT =
  "id, sede_id, item_type, item_id, employee_id, percent, amount, is_active";

/** Reglas de la sede (filtro opcional por ítem o empleado). */
export async function listCommissionRules(
  sedeId: string,
  filters: { item_type?: string; item_id?: string; employee_id?: string } = {},
): Promise<CommissionRuleRow[]> {
  const db = await commissionsDb();
  let query = db.from("commission_rules").select(RULE_SELECT).eq("sede_id", sedeId);
  if (filters.item_type) query = query.eq("item_type", filters.item_type);
  if (filters.item_id) query = query.eq("item_id", filters.item_id);
  if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
  const { data, error } = await query.order("created_at");
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as CommissionRuleRow[];
}

/**
 * Crea o ajusta la regla de un (ítem × empleado). Solo admin (el gate
 * vive en actions). Valida que ítem y empleado existan en la sede.
 */
export async function upsertCommissionRule(
  raw: unknown,
  actor: CommissionActor,
): Promise<CommissionRuleRow> {
  const parsed = commissionRuleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommissionError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input = parsed.data;
  const db = await commissionsDb();

  const itemTable = input.item_type === "producto" ? "products" : "services";
  const { data: item, error: itemError } = await db
    .from(itemTable)
    .select("id")
    .eq("id", input.item_id)
    .eq("sede_id", actor.sedeId)
    .maybeSingle();
  if (itemError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!item) throw new CommissionError("NOT_FOUND", "Ítem no encontrado en esta sede.", 404);

  const { data: employee, error: employeeError } = await db
    .from("employees")
    .select("id")
    .eq("id", input.employee_id)
    .eq("sede_id", actor.sedeId)
    .maybeSingle();
  if (employeeError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!employee) throw new CommissionError("NOT_FOUND", "Empleado no encontrado en esta sede.", 404);

  const { data, error } = await db
    .from("commission_rules")
    .upsert(
      {
        ...(input.id ? { id: input.id } : {}),
        sede_id: actor.sedeId,
        item_type: input.item_type,
        item_id: input.item_id,
        employee_id: input.employee_id,
        percent: input.percent ?? null,
        amount: input.amount ?? null,
        ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
      },
      { onConflict: "sede_id,item_type,item_id,employee_id" },
    )
    .select(RULE_SELECT)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new CommissionError("RULE_CONFLICT", "Ya existe una regla para ese ítem y empleado.", 409);
    }
    throw new CommissionError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return data as CommissionRuleRow;
}

/** Elimina una regla (solo admin, acotado a la sede). */
export async function deleteCommissionRule(
  sedeId: string,
  id: string,
): Promise<{ id: string }> {
  const db = await commissionsDb();
  const { data, error } = await db
    .from("commission_rules")
    .delete()
    .eq("id", id)
    .eq("sede_id", sedeId)
    .select("id")
    .maybeSingle();
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!data) throw new CommissionError("NOT_FOUND", "Regla no encontrada.", 404);
  return { id: (data as { id: string }).id };
}

// ------------------------------------------------------------------- ganado ---

export interface EarnedCommission {
  baseSubtotal: number;
  percentApplied: number | null;
  fixedApplied: number | null;
  earned: number;
  lines: number;
}

/**
 * Comisión ganada por (factura, empleado): líneas sin flag × (regla o
 * tasa plana del empleado). Las líneas marcadas sin comisión no suman.
 */
export async function earnedCommissionFor(
  sedeId: string,
  invoiceId: string,
  employeeId: string,
): Promise<EarnedCommission> {
  const db = await commissionsDb();
  const { data: invoice, error: invoiceError } = await db
    .from("invoices")
    .select("id, status")
    .eq("id", invoiceId)
    .eq("sede_id", sedeId)
    .maybeSingle();
  if (invoiceError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!invoice) throw new CommissionError("NOT_FOUND", "Factura no encontrada.", 404);
  if ((invoice as { status: string }).status === "Anulada") {
    throw new CommissionError("INVOICE_ANNULLED", "La factura está anulada.", 422);
  }

  const { data: lines, error: linesError } = await db
    .from("invoice_items")
    .select("item_type, product_id, service_id, qty, unit_price, subtotal, no_commission")
    .eq("invoice_id", invoiceId)
    .eq("employee_id", employeeId);
  if (linesError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  const earning = ((lines ?? []) as Array<{
    item_type: string;
    product_id: string | null;
    service_id: string | null;
    qty: number | string;
    unit_price: number | string;
    subtotal: number | string;
    no_commission: boolean | null;
  }>).filter((line) => !line.no_commission);

  const { data: rules, error: rulesError } = await db
    .from("commission_rules")
    .select("item_type, item_id, percent, amount")
    .eq("sede_id", sedeId)
    .eq("employee_id", employeeId)
    .eq("is_active", true);
  if (rulesError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  const ruleByItem = new Map(
    ((rules ?? []) as Array<{ item_type: string; item_id: string; percent: number | null; amount: number | null }>).map(
      (rule) => [`${rule.item_type}:${rule.item_id}`, rule],
    ),
  );

  const { data: employee, error: employeeError } = await db
    .from("employees")
    .select("pay_type, commission_percent")
    .eq("id", employeeId)
    .eq("sede_id", sedeId)
    .maybeSingle();
  if (employeeError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  const emp = (employee ?? null) as { pay_type: string; commission_percent: number | string | null } | null;
  const flatPercent =
    emp && (emp.pay_type === "porcentaje" || emp.pay_type === "mixto")
      ? Number(emp.commission_percent ?? 0)
      : null;

  let baseSubtotal = 0;
  let earned = 0;
  const usedRules = new Map<string, RuleRate>();
  for (const line of earning) {
    const refId = line.item_type === "producto" ? line.product_id : line.service_id;
    const rule = refId ? ruleByItem.get(`${line.item_type}:${refId}`) : undefined;
    const subtotal = roundMoney(Number(line.subtotal));
    baseSubtotal = roundMoney(baseSubtotal + subtotal);
    earned = roundMoney(
      earned +
        resolveLineCommission({
          subtotal,
          qty: Math.floor(Number(line.qty)),
          rule: rule
            ? { percent: rule.percent != null ? Number(rule.percent) : null, amount: rule.amount != null ? Number(rule.amount) : null }
            : null,
          flatPercent: rule ? null : flatPercent,
        }),
    );
    if (rule) {
      usedRules.set(`${line.item_type}:${refId}`, {
        percent: rule.percent != null ? Number(rule.percent) : null,
        amount: rule.amount != null ? Number(rule.amount) : null,
      });
    }
  }
  const uniform = usedRules.size === 1 ? [...usedRules.values()][0] : null;
  return {
    baseSubtotal,
    percentApplied: uniform?.percent ?? null,
    fixedApplied: uniform?.amount ?? null,
    earned,
    lines: earning.length,
  };
}

/** Total ya pagado de inmediato por (factura, empleado). */
export async function immediatePaidTotal(
  sedeId: string,
  invoiceId: string,
  employeeId: string,
): Promise<number> {
  const db = await commissionsDb();
  const { data, error } = await db
    .from("commission_payouts")
    .select("amount")
    .eq("sede_id", sedeId)
    .eq("invoice_id", invoiceId)
    .eq("employee_id", employeeId);
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return roundMoney(
    ((data ?? []) as Array<{ amount: number | string }>).reduce((acc, row) => acc + Number(row.amount), 0),
  );
}

// -------------------------------------------------------------------- pagos ---

const PAYOUT_SELECT =
  "id, sede_id, employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, percent_applied, fixed_applied, amount, paid_by, paid_at";

/**
 * Paga de inmediato una comisión desde la caja del turno abierto, por
 * cualquier método activo. Valida contra el pendiente (ganado − pagado)
 * para que la misma comisión nunca se pague dos veces. Queda auditado
 * (cuánto, quién pagó, cuándo, método, factura y turno).
 */
export async function payCommissionNow(
  raw: unknown,
  actor: CommissionActor,
): Promise<CommissionPayoutRow> {
  const parsed = commissionPayoutSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommissionError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input = parsed.data;
  const db = await commissionsDb();

  const { data: payoutEmployee } = await db
    .from("employees")
    .select("payout_mode")
    .eq("id", input.employee_id)
    .eq("sede_id", actor.sedeId)
    .maybeSingle();
  if ((payoutEmployee as { payout_mode?: string } | null)?.payout_mode === "no_aplica") {
    throw new CommissionError(
      "COMMISSION_NOT_APPLICABLE",
      "Ese empleado no aplica para comisiones.",
      422,
    );
  }

  const methods = await listPaymentMethods(actor.sedeId).catch(() => {
    throw new CommissionError("INTERNAL", "Error interno.", 500);
  });
  const method = methods.find((row) => row.is_active && row.code === input.method_code);
  if (!method) {
    throw new CommissionError(
      "METHOD_INACTIVE",
      `El método de pago ${input.method_code} no está activo en esta sede.`,
      422,
    );
  }

  const shift = await getOpenShift(actor.sedeId).catch(() => {
    throw new CommissionError("INTERNAL", "Error interno.", 500);
  });
  if (!shift) {
    throw new CommissionError(
      "NO_OPEN_SHIFT",
      "No hay un turno abierto. Abra un turno antes de pagar comisiones.",
      409,
    );
  }

  const earned = await earnedCommissionFor(actor.sedeId, input.invoice_id, input.employee_id).catch(
    (error) => {
      if (error instanceof CommissionError) throw error;
      throw new CommissionError("INTERNAL", "Error interno.", 500);
    },
  );
  if (earned.lines === 0) {
    throw new CommissionError("NOTHING_EARNED", "Esa factura y empleado no tienen comisión.", 422);
  }
  const paid = await immediatePaidTotal(actor.sedeId, input.invoice_id, input.employee_id);
  const pending = pendingCommission(earned.earned, paid);
  if (pending <= 0) {
    throw new CommissionError("NOTHING_PENDING", "Esa comisión ya fue pagada.", 422);
  }
  if (input.amount - pending > 0.009) {
    throw new CommissionError(
      "COMMISSION_OVERPAID",
      `El monto supera la comisión pendiente (${pending}).`,
      422,
    );
  }

  // Tope de salidas en efectivo del turno (50% de la base de apertura): la
  // comisión pagada en efectivo no puede dejar el acumulado del turno por
  // encima del tope. Solo aplica al efectivo; los digitales no tienen tope.
  if (method.code === "efectivo") {
    const usedCashOut = await cashOutUsedInShift(shift.id).catch(() => {
      throw new CommissionError("INTERNAL", "Error interno.", 500);
    });
    const violation = cashOutLimitViolation({
      methodCode: method.code,
      openingBase: Number(shift.opening_base),
      cashOutUsed: usedCashOut,
      amount: input.amount,
    });
    if (violation) throw new CommissionError(violation.code, violation.message, 422);
  }

  const { data, error } = await db
    .from("commission_payouts")
    .insert({
      sede_id: actor.sedeId,
      employee_id: input.employee_id,
      invoice_id: input.invoice_id,
      cash_shift_id: shift.id,
      method_code: method.code,
      base_subtotal: earned.baseSubtotal,
      percent_applied: earned.percentApplied,
      fixed_applied: earned.fixedApplied,
      amount: roundMoney(input.amount),
      paid_by: actor.userId,
    })
    .select(PAYOUT_SELECT)
    .single();
  if (error || !data) throw new CommissionError("INTERNAL", "Error interno.", 500);

  await writeAudit({
    sede_id: actor.sedeId,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.COMMISSION_PAID,
    entity: "commission_payouts",
    entity_id: (data as CommissionPayoutRow).id,
    metadata: {
      employee_id: input.employee_id,
      invoice_id: input.invoice_id,
      cash_shift_id: shift.id,
      method_code: method.code,
      amount: roundMoney(input.amount),
      base_subtotal: earned.baseSubtotal,
      percent_applied: earned.percentApplied,
      fixed_applied: earned.fixedApplied,
    },
  });
  return data as CommissionPayoutRow;
}

/** Pagos inmediatos de la sede (filtros opcionales, recientes primero). */
export async function listCommissionPayouts(
  sedeId: string,
  filters: { employee_id?: string; invoice_id?: string; shift_id?: string } = {},
): Promise<CommissionPayoutRow[]> {
  const db = await commissionsDb();
  let query = db.from("commission_payouts").select(PAYOUT_SELECT).eq("sede_id", sedeId);
  if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
  if (filters.invoice_id) query = query.eq("invoice_id", filters.invoice_id);
  if (filters.shift_id) query = query.eq("cash_shift_id", filters.shift_id);
  const { data, error } = await query.order("paid_at", { ascending: false }).limit(200);
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as CommissionPayoutRow[];
}
