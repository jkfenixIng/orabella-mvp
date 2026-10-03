import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PayrollError,
  payPayrollItem,
  requirePayrollAdmin,
} from "@/src/features/payroll/service";

function payrollErrorResponse(error: unknown) {
  if (error instanceof PayrollError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/payroll-items/:id/payments — paga un ítem en porciones por
 * método (PAY-04, solo admin). Métodos activos, montos > 0; el acumulado
 * nunca excede el neto. Periodo cerrado → PERIOD_CLOSED.
 *
 * CL-2 (idempotencia): el cuerpo exige `idempotency_key` (uuid del intento de
 * pago). Es una superficie pública y los reintentos sobre una red cortada son
 * exactamente su caso de uso, así que la marca NO es opcional: sin ella
 * responde VALIDATION (400) en vez de pagar sin protección. Reenviar la misma
 * marca devuelve el pago ya registrado —un no-op exitoso para el llamador, con
 * el mismo estado del ítem— en lugar de pagarlo dos veces (con 2 × entrante ≤
 * saldo el tope de 007 tampoco lo frenaba).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await payPayrollItem(id, body, { userId: session.userId });
    return ok(data, 201);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
