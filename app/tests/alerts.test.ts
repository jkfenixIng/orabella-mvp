import { describe, expect, it } from "vitest";
import {
  ALERT_ACTIONS,
  ALERT_MODULES,
  ALERTS_PAGE_SIZE,
  alertsQuerySchema,
  assembleShiftRevision,
  reviewNoteSchema,
} from "@/src/features/alerts/schemas";

describe("alerts: conjunto de alerta y paginado", () => {
  it("cubre desajustes de caja y bloqueos, página fija de 10", () => {
    expect([...ALERT_ACTIONS]).toEqual([
      "cash.shift_open_mismatch",
      "cash.shift_close_mismatch",
      "auth.login_locked",
    ]);
    expect(ALERTS_PAGE_SIZE).toBe(10);
  });

  it("página 1 y todas por defecto; rechaza página inválida", () => {
    const parsed = alertsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ unreadOnly: false, page: 1 });
    }
    expect(alertsQuerySchema.safeParse({ page: 2 }).success).toBe(true);
    expect(alertsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(alertsQuerySchema.safeParse({ unreadOnly: true }).success).toBe(true);
  });

  it("revisar exige justificación no vacía de hasta 500", () => {    expect(reviewNoteSchema.safeParse({ note: "Hablé con caja, faltante justificado." }).success).toBe(true);
    expect(reviewNoteSchema.safeParse({ note: "   " }).success).toBe(false);
    expect(reviewNoteSchema.safeParse({}).success).toBe(false);
    expect(reviewNoteSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
  });

  it("cada alerta pertenece a exactamente un módulo (sin mezclas)", () => {
    const flat = [...ALERT_MODULES.caja.actions, ...ALERT_MODULES.acceso.actions];
    expect([...flat].sort()).toEqual([...ALERT_ACTIONS].sort());
    expect(new Set(flat).size).toBe(flat.length);
    expect(alertsQuerySchema.safeParse({ module: "caja" }).success).toBe(true);
    expect(alertsQuerySchema.safeParse({ module: "otro" }).success).toBe(false);
  });

  it("revisión del turno: null sin desajustes, Sí solo con todas leídas", () => {
    expect(assembleShiftRevision([], false)).toBeNull();
    expect(
      assembleShiftRevision([], true),
    ).toEqual({ revisada: false, notas: [] });
    expect(
      assembleShiftRevision(
        [{ action: "cash.shift_close_mismatch", fecha: "2026-09-22T01:00:00Z", revisada: true, justificacion: "Hablado.", revisor: "Ana" }],
        false,
      ),
    ).toEqual({
      revisada: true,
      notas: [{ accion: "Cierre", fecha: "2026-09-22T01:00:00Z", nota: "Hablado.", revisor: "Ana" }],
    });
    expect(
      assembleShiftRevision(
        [
          { action: "cash.shift_open_mismatch", fecha: "2026-09-22T01:00:00Z", revisada: true, justificacion: "Apertura ok.", revisor: "Ana" },
          { action: "cash.shift_close_mismatch", fecha: "2026-09-22T02:00:00Z", revisada: false, justificacion: null, revisor: null },
        ],
        true,
      )?.revisada,
    ).toBe(false);
  });
});
