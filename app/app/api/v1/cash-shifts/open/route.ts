import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { CashError, openShift, requireCashWriter } from "@/src/features/cash/service";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/cash-shifts/open — abre un turno (solo admin/caja).
 * Equivale al `cash-shifts:open` del PRD §10 (en Next la carpeta no
 * admite `:` en Windows, se usa `open`). Hereda opening_base del último
 * cierre (o base_configurada si es el primero); rechaza doble apertura.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireCashWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await openShift(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
