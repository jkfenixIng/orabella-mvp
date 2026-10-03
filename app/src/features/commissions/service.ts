import {
  commissionPayoutSchema,
  commissionRuleKey,
  commissionRuleSchema,
  employeeLineCommissionOrigin,
  pendingCommission,
  resolveEmployeeLineCommission,
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

type DbClient = Awaited<ReturnType<typeof commissionsDb>>;

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

/** Reglas (filtro opcional por ítem o empleado). */
export async function listCommissionRules(
  filters: { item_type?: string; item_id?: string; employee_id?: string } = {},
): Promise<CommissionRuleRow[]> {
  const db = await commissionsDb();
  let query = db.from("commission_rules").select(RULE_SELECT);
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
    .maybeSingle();
  if (itemError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!item) throw new CommissionError("NOT_FOUND", "Ítem no encontrado en esta sede.", 404);

  const { data: employee, error: employeeError } = await db
    .from("employees")
    .select("id")
    .eq("id", input.employee_id)
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
  /** Total ganado por el empleado: comisión por ítem + porcentaje del empleado. */
  earned: number;
  /**
   * Ganado que se puede pagar de IMMEDIATO: solo el origen "commission"
   * (valor fijo del ítem o regla ítem×empleado). El porcentaje del empleado
   * queda fuera: se acumula y se paga en nómina.
   */
  immediateEarned: number;
  lines: number;
}

/**
 * Decisión del dueño (2026-10-01): la comisión de una factura existe cuando la
 * factura está Pagada. Con la factura pagada el destino de la comisión ya quedó
 * definido —se pagó de inmediato, o se dejó para la nómina—; con una factura
 * Emitida todavía no hay comisión en juego. La nómina ya filtra por el mismo
 * estado; esta es la guarda del pago inmediato.
 */
export function canPayCommissionImmediately(status: string): boolean {
  return status === "Pagada";
}

/**
 * Rechaza la factura que no habilita el pago inmediato. Anulada conserva su
 * código propio; cualquier otro estado no pagado es `INVOICE_NOT_PAID`.
 */
function assertInvoicePaid(status: string): void {
  if (status === "Anulada") {
    throw new CommissionError("INVOICE_ANNULLED", "La factura está anulada.", 422);
  }
  if (!canPayCommissionImmediately(status)) {
    throw new CommissionError(
      "INVOICE_NOT_PAID",
      "La factura debe estar Pagada para pagar la comisión.",
      422,
    );
  }
}

/**
 * Comisión ganada por (factura, empleado): líneas sin flag × (regla o
 * tasa plana del empleado). Las líneas marcadas sin comisión no suman.
 * Devuelve el total (`earned`) y, separado, lo pagable de inmediato
 * (`immediateEarned`, solo origen comisión por ítem).
 */
export async function earnedCommissionFor(
  invoiceId: string,
  employeeId: string,
): Promise<EarnedCommission> {
  const db = await commissionsDb();
  const { data: invoice, error: invoiceError } = await db
    .from("invoices")
    .select("id, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invoiceError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!invoice) throw new CommissionError("NOT_FOUND", "Factura no encontrada.", 404);
  assertInvoicePaid((invoice as { status: string }).status);

  const { data: lines, error: linesError } = await db
    .from("invoice_items")
    .select(
      "item_type, product_id, service_id, qty, unit_price, subtotal, no_commission, commission_value, commission_percent_override",
    )
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
    commission_value: number | string | null;
    commission_percent_override: number | string | null;
  }>).filter((line) => !line.no_commission);

  const { data: rules, error: rulesError } = await db
    .from("commission_rules")
    .select("item_type, item_id, percent, amount")
    .eq("employee_id", employeeId)
    .eq("is_active", true);
  if (rulesError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  const ruleByItem = new Map<string, RuleRate>(
    ((rules ?? []) as Array<{ item_type: string; item_id: string; percent: number | null; amount: number | null }>).map(
      (rule) => [
        commissionRuleKey(rule.item_type, rule.item_id),
        {
          percent: rule.percent != null ? Number(rule.percent) : null,
          amount: rule.amount != null ? Number(rule.amount) : null,
        },
      ],
    ),
  );

  const { data: employee, error: employeeError } = await db
    .from("employees")
    .select("pay_type, commission_percent")
    .eq("id", employeeId)
    .maybeSingle();
  if (employeeError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  const emp = (employee ?? null) as { pay_type: string; commission_percent: number | string | null } | null;
  const flatPercent =
    emp && (emp.pay_type === "porcentaje" || emp.pay_type === "mixto")
      ? Number(emp.commission_percent ?? 0)
      : null;

  let baseSubtotal = 0;
  let earned = 0;
  let immediateEarned = 0;
  const usedRules = new Map<string, RuleRate>();
  for (const line of earning) {
    const refId = line.item_type === "producto" ? line.product_id : line.service_id;
    const rule = refId ? ruleByItem.get(commissionRuleKey(line.item_type, refId)) : undefined;
    const subtotal = roundMoney(Number(line.subtotal));
    baseSubtotal = roundMoney(baseSubtotal + subtotal);
    // El valor fijo del ítem (producto o `custom`) es la comisión: mismo
    // insumo que nómina y detalle. Un 0 no es valor fijo (se normaliza a
    // null, igual que en payroll/billing).
    const commissionValue = line.commission_value ? Number(line.commission_value) : null;
    const commissionPercentOverride =
      line.commission_percent_override != null ? Number(line.commission_percent_override) : null;
    const lineCommission = resolveEmployeeLineCommission({
      itemType: line.item_type,
      itemRefId: refId ?? null,
      subtotal,
      qty: Number(line.qty),
      commissionValue,
      commissionPercentOverride,
      rules: ruleByItem,
      flatPercent,
    });
    earned = roundMoney(earned + lineCommission);
    // Solo la comisión por ítem (origen "commission") es pagable de inmediato;
    // el porcentaje (del empleado o el explícito de la línea) se acumula para la
    // nómina.
    if (
      employeeLineCommissionOrigin({
        itemType: line.item_type,
        itemRefId: refId ?? null,
        commissionValue,
        commissionPercentOverride,
        rules: ruleByItem,
        flatPercent,
      }) === "commission"
    ) {
      immediateEarned = roundMoney(immediateEarned + lineCommission);
    }
    if (rule && refId) {
      usedRules.set(commissionRuleKey(line.item_type, refId), rule);
    }
  }
  const uniform = usedRules.size === 1 ? [...usedRules.values()][0] : null;
  return {
    baseSubtotal,
    percentApplied: uniform?.percent ?? null,
    fixedApplied: uniform?.amount ?? null,
    earned,
    immediateEarned,
    lines: earning.length,
  };
}

/** Total ya pagado de inmediato por (factura, empleado). */
export async function immediatePaidTotal(
  invoiceId: string,
  employeeId: string,
): Promise<number> {
  const db = await commissionsDb();
  const { data, error } = await db
    .from("commission_payouts")
    .select("amount")
    .eq("invoice_id", invoiceId)
    .eq("employee_id", employeeId);
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return roundMoney(
    ((data ?? []) as Array<{ amount: number | string }>).reduce((acc, row) => acc + Number(row.amount), 0),
  );
}

// -------------------------------------------------------------------- pagos ---

const PAYOUT_SELECT =
  "id, sede_id, employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, percent_applied, fixed_applied, earned_immediate, amount, paid_by, paid_at";

/**
 * CL-5: la fila de `commission_payouts` que YA se registró con esa marca, DENTRO
 * DE ESE PAR (factura, empleado).
 *
 * La marca es un uuid que acuña la pantalla al empezar el intento de pago y que
 * reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `commissionPayoutSchema` (schemas.ts). El filtro es por
 * el PAR: la marca se resuelve dentro del registro que la usó —el par
 * (factura, empleado) es lo que el modal identifica, lo que suma el tope de 034
 * `trg_commission_payouts_cap` y lo que lee `immediatePaidTotal`—, así que el
 * lookup nunca puede devolver el pago de otra factura ni de otro empleado, y la
 * misma marca en dos pares distintos son DOS operaciones. La clave del índice de
 * la 044 es la MISMA (`invoice_id, employee_id, idempotency_key`): el `eq` de
 * este lookup y la clave del índice son el mismo conjunto, así que este lookup
 * no puede devolver una fila que el índice no habría bloqueado.
 *
 * La sede NO entra en la clave porque no agrega identidad: la factura pertenece
 * a una sola sede y el servicio la resuelve dentro de la del actor (una factura
 * ajena es NOT_FOUND en `earnedCommissionFor`), así que este lookup corre
 * DESPUÉS de esa validación y no puede devolver el pago de otra sede.
 */
async function findCommissionPayoutByIdempotencyKey(
  db: DbClient,
  invoiceId: string,
  employeeId: string,
  idempotencyKey: string,
): Promise<CommissionPayoutRow | null> {
  const { data, error } = await db
    .from("commission_payouts")
    .select(PAYOUT_SELECT)
    .eq("invoice_id", invoiceId)
    .eq("employee_id", employeeId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return (data as CommissionPayoutRow | null) ?? null;
}

/**
 * Paga de inmediato una comisión desde la caja del turno abierto, por
 * cualquier método activo. Valida contra el pendiente (ganado − pagado)
 * para que la misma comisión nunca se pague dos veces. Queda auditado
 * (cuánto, quién pagó, cuándo, método, factura y turno).
 *
 * Doble barrera: esta validación (que da el mensaje exacto del pendiente) y el
 * tope de la base (`trg_commission_payouts_cap`, 034). La validación de código
 * es un leer-y-escribir y pierde contra una carrera; por eso la fila lleva
 * `earned_immediate` — el ganado que la base compara contra la suma de lo
 * pagado, sin recalcular la regla—.
 *
 * CL-5 (idempotencia): el orden empieza por la MARCA del intento
 * (`idempotency_key`, columna e índice único parcial de la 044), DESPUÉS de
 * `earnedCommissionFor` —que es lo que valida el par dentro de la sede del
 * actor, así el lookup no puede devolver el pago de otra sede— y ANTES de leer
 * lo ya pagado y de decidir el pendiente. Un reintento del MISMO envío (doble
 * clic, o el navegador reenviando tras cortarse la red) se reconoce y devuelve
 * el pago ya registrado como un no-op EXITOSO: no paga de nuevo.
 *
 * POR QUÉ ANTES DE LA ARITMÉTICA DEL PENDIENTE y no después: el tope de 034 usa
 * la MISMA aritmética que la validación de acá (`Σ + nuevo − ganado > 0,009`),
 * así que un reintento que agotó el pendiente moría con NOTHING_PENDING (o
 * COMMISSION_OVERPAID con la carrera perdida) —un error por una operación que SÍ
 * se registró—. Es el mismo razonamiento de CL-3 para el cobro de factura.
 *
 * POR QUÉ ACÁ Y NO AL PRINCIPIO DE TODO (limitación declarada): el par tiene que
 * estar validado dentro de la sede del actor antes de que la marca se resuelva,
 * y esa validación vive en `earnedCommissionFor` (la anulación incluida). La
 * contrapartida, declarada: un reintento que llegue con la factura ANULADA, sin
 * turno abierto (NO_OPEN_SHIFT), con el método ya inactivo (METHOD_INACTIVE) o
 * con el empleado marcado `no_aplica` se rechaza en vez de reconocerse —el caso
 * real del reintento, doble clic o corte de red, ocurre segundos después, con
 * la factura vigente, el mismo turno abierto y el mismo método activo, y ahí la
 * marca SÍ reconoce—. No se pierde plata: el rechazo es ruidoso y la misma marca
 * sigue reconociendo cuando la guarda se levanta.
 *
 * COSTO DECLARADO: acá NO se quema ningún número (`commission_payouts.id` es un
 * uuid: la tabla no tiene serie ni consecutivo). Lo que cuesta la carrera es una
 * sentencia ABORTADA: la perdedora ya había leído el pendiente cuando chocó con
 * el índice, y esa sentencia no deja filas. Es el mismo canje de 042/043
 * —perder trabajo invisible antes que pagar dos veces—.
 *
 * LA ARRUGA DE 042 NO APLICA ACÁ: este camino inserta UNA sola fila (una
 * sentencia de un objeto, no un `insert([...])` de N porciones), así que la
 * marca vive en esa única fila, no hay porciones hermanas que enumerar y el
 * índice único parcial nunca puede rechazar una operación legítima.
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
  // Dinero que se persiste: peso entero. Se normaliza UNA vez y es el mismo
  // valor para la validación del pendiente, el tope de caja y la fila
  // guardada (lo que se valida es lo que se guarda).
  const amount = roundMoney(input.amount);
  const db = await commissionsDb();

  const { data: payoutEmployee } = await db
    .from("employees")
    .select("payout_mode")
    .eq("id", input.employee_id)
    .maybeSingle();
  if ((payoutEmployee as { payout_mode?: string } | null)?.payout_mode === "no_aplica") {
    throw new CommissionError(
      "COMMISSION_NOT_APPLICABLE",
      "Ese empleado no aplica para comisiones.",
      422,
    );
  }

  const methods = await listPaymentMethods().catch(() => {
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

  const earned = await earnedCommissionFor(input.invoice_id, input.employee_id).catch(
    (error) => {
      if (error instanceof CommissionError) throw error;
      throw new CommissionError("INTERNAL", "Error interno.", 500);
    },
  );
  if (earned.lines === 0) {
    throw new CommissionError("NOTHING_EARNED", "Esa factura y empleado no tienen comisión.", 422);
  }
  // CL-5: la MARCA del intento, ANTES de leer el pendiente y antes de cualquier
  // escritura. Un reintento del MISMO envío trae la misma marca: se devuelve el
  // pago ya registrado, sin escribir nada y sin que el tope acumulado de 034 (que
  // usa la MISMA aritmética que la validación de abajo) lo confunda con un pago
  // nuevo. Va después de `earnedCommissionFor` porque ahí es donde el par queda
  // validado dentro de la sede del actor (ver el encabezado).
  const repeated = await findCommissionPayoutByIdempotencyKey(
    db,
    input.invoice_id,
    input.employee_id,
    input.idempotency_key,
  );
  if (repeated) return repeated;
  const paid = await immediatePaidTotal(input.invoice_id, input.employee_id);
  // El pendiente inmediato es SOLO comisión por ítem: el porcentaje del empleado
  // se acumula y se paga en nómina, nunca de inmediato.
  const pending = pendingCommission(earned.immediateEarned, paid);
  if (pending <= 0) {
    throw new CommissionError(
      "NOTHING_PENDING",
      earned.immediateEarned <= 0
        ? "Esa factura solo tiene porcentaje del empleado: se paga en nómina, no de inmediato."
        : "Esa comisión ya fue pagada.",
      422,
    );
  }
  if (amount - pending > 0.009) {
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
      amount,
    });
    if (violation) throw new CommissionError(violation.code, violation.message, 422);
  }

  // Defensa en profundidad: `earnedCommissionFor` ya exigió `Pagada`, pero el
  // estado pudo cambiar entre esa lectura y este INSERT (anulación o cobro en
  // vuelo). Este camino escribe plata, así que la guarda no vive solo en la
  // lectura previa: se relee la factura justo antes de escribir y se vuelve a
  // exigir el mismo estado. Corre DESPUÉS del reconocimiento de la marca CL-5,
  // así que un reintento ya registrado sigue siendo un no-op exitoso.
  const { data: payoutInvoice, error: payoutInvoiceError } = await db
    .from("invoices")
    .select("id, status")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (payoutInvoiceError) throw new CommissionError("INTERNAL", "Error interno.", 500);
  if (!payoutInvoice) throw new CommissionError("NOT_FOUND", "Factura no encontrada.", 404);
  assertInvoicePaid((payoutInvoice as { status: string }).status);

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
      // El tope de la base (034) compara contra ESTE número: es el ganado
      // inmediato que ya se validó arriba, no una segunda versión de la regla.
      earned_immediate: earned.immediateEarned,
      amount,
      paid_by: actor.userId,
      // CL-5: la marca del intento. Es la identidad de ESTA operación dentro del
      // par (factura, empleado): el índice único parcial de la 044 y el lookup de
      // arriba usan la misma clave. Sin ella no habría forma de distinguir "el
      // mismo envío" de "un segundo pago parcial legítimo".
      idempotency_key: input.idempotency_key,
    })
    .select(PAYOUT_SELECT)
    .single();
  if (error) {
    // CL-5: carrera perdida contra el índice único parcial de la 044 (23505). El
    // lookup de arriba y este INSERT no son atómicos: si otro envío con la MISMA
    // marca en el MISMO par se confirmó en esa ventana, la repetición se relee y
    // se devuelve. Sin ganadora, el 23505 no es una repetición y se reporta como
    // fallo real en vez de disfrazarlo.
    //
    // El 23505 va ANTES del P0001 a propósito: son dos barreras distintas y el
    // código de la base las distingue. Si la fila que chocó es de la MISMA marca,
    // la respuesta correcta es la operación ya registrada; el tope, en cambio,
    // sólo habla de dinero que se pasa del ganado.
    if ((error as { code?: string }).code === "23505") {
      const winner = await findCommissionPayoutByIdempotencyKey(
        db,
        input.invoice_id,
        input.employee_id,
        input.idempotency_key,
      );
      if (winner) return winner;
      throw new CommissionError("INTERNAL", "Error interno.", 500);
    }
    // Carrera perdida contra trg_commission_payouts_cap (034): P0001 = el tope
    // acumulado de la base rechazó el pago (la suma del par ya estaba completa
    // cuando entró esta fila). Mismo código que traducen payroll, cash y
    // billing; la condición de negocio es la misma que valida el pendiente.
    if ((error as { code?: string }).code === "P0001") {
      throw new CommissionError(
        "COMMISSION_OVERPAID",
        "El monto supera la comisión pendiente.",
        422,
      );
    }
    throw new CommissionError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new CommissionError("INTERNAL", "Error interno.", 500);

  await writeAudit({
    user_id: actor.userId,
    action: AUDIT_ACTIONS.COMMISSION_PAID,
    entity: "commission_payouts",
    entity_id: (data as CommissionPayoutRow).id,
    metadata: {
      employee_id: input.employee_id,
      invoice_id: input.invoice_id,
      cash_shift_id: shift.id,
      method_code: method.code,
      amount,
      base_subtotal: earned.baseSubtotal,
      percent_applied: earned.percentApplied,
      fixed_applied: earned.fixedApplied,
      // El tope con el que la base aceptó esta fila (034): queda en la
      // auditoría el número contra el que se comparó, no solo el pago.
      earned_immediate: earned.immediateEarned,
    },
  });
  return data as CommissionPayoutRow;
}

/** Pagos inmediatos (filtros opcionales, recientes primero). */
export async function listCommissionPayouts(
  filters: { employee_id?: string; invoice_id?: string; shift_id?: string } = {},
): Promise<CommissionPayoutRow[]> {
  const db = await commissionsDb();
  let query = db.from("commission_payouts").select(PAYOUT_SELECT);
  if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
  if (filters.invoice_id) query = query.eq("invoice_id", filters.invoice_id);
  if (filters.shift_id) query = query.eq("cash_shift_id", filters.shift_id);
  const { data, error } = await query.order("paid_at", { ascending: false }).limit(200);
  if (error) throw new CommissionError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as CommissionPayoutRow[];
}
