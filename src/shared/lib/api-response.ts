import { NextResponse } from "next/server";

export interface ApiSuccessEnvelope<TData> {
  success: true;
  data: TData;
}

export interface ApiErrorEnvelope {
  success: false;
  code: string;
  message: string;
}

/**
 * Resultado de una server action visto desde el cliente.
 *
 * Es el espejo local de los dos sobres de arriba: éxito con datos, o error con
 * `code` y `message`. Se exporta desde acá porque es el mismo contrato de
 * respuesta, y lo consumen tanto los clientes con `useTransition` como las
 * acciones que los abastecen. Antes de WU3 estaba declarado ocho veces, byte a
 * byte idéntico, en `admin/admin-shared.ts` y en los siete clientes.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

export function ok<TData>(data: TData, status = 200): NextResponse {
  const body: ApiSuccessEnvelope<TData> = { success: true, data };
  return NextResponse.json(body, { status });
}

export function fail(code: string, message: string, status = 400): NextResponse {
  const body: ApiErrorEnvelope = { success: false, code, message };
  return NextResponse.json(body, { status });
}
