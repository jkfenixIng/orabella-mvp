import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { CashError, registerPayment, requireCashWriter } from "@/src/features/cash/service";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/cash/payments — registra un pago contra el turno abierto
 * (solo admin/caja). Método activo, monto > 0; con invoice_id valida la
 * factura, la vincula al turno y refleja la porción en invoice_payments
 * (dual-write T5); al completar el total la factura pasa a Pagada.
 *
 * CL-3 (idempotencia): cuando el pago trae `invoice_id` —el cobro de una
 * factura desde la caja— el cuerpo exige `idempotency_key` (uuid del intento de
 * cobro). Es una superficie pública y los reintentos sobre una red cortada son
 * exactamente su caso de uso, así que la marca NO es opcional AHÍ: este camino
 * acepta montos PARCIALES y el tope de 031 usa la misma aritmética, así que un
 * reintento con 2 × entrante ≤ saldo entraba dos veces. Sin marca responde
 * VALIDATION (400) en vez de cobrar sin protección; reenviar la MISMA marca
 * devuelve el cobro ya registrado —un no-op exitoso para el llamador, con el
 * mismo 201— en lugar de cobrarlo dos veces.
 *
 * Un pago SIN factura no lleva marca: su fila vive sólo en `payments`, que no
 * tiene columna de marca (deuda declarada en la migración 042).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireCashWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await registerPayment(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
