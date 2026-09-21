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

export function ok<TData>(data: TData, status = 200): NextResponse {
  const body: ApiSuccessEnvelope<TData> = { success: true, data };
  return NextResponse.json(body, { status });
}

export function fail(code: string, message: string, status = 400): NextResponse {
  const body: ApiErrorEnvelope = { success: false, code, message };
  return NextResponse.json(body, { status });
}
