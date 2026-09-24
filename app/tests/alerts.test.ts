import { describe, expect, it } from "vitest";
import {
  ALERT_ACTIONS,
  ALERT_MODULES,
  ALERTS_PAGE_SIZE,
  VOUCHER_ALERT_ACTION,
  VOUCHER_ALERT_ENTITY,
  alertsQuerySchema,
  assembleShiftRevision,
  buildVoucherAlertResolution,
  reviewNoteSchema,
  voucherAlertFilter,
  voucherAlertRequired,
  voucherAlertResolutionNote,
} from "@/src/features/alerts/schemas";

describe("alerts: conjunto de alerta y paginado", () => {
  it("cubre desajustes de caja, bloqueos y vales por revisar, página fija de 10", () => {
    expect([...ALERT_ACTIONS]).toEqual([
      "cash.shift_open_mismatch",
      "cash.shift_close_mismatch",
      "auth.login_locked",
      "payroll.commission_paid",
      "voucher.requested",
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

describe("alerts: la alerta del vale se resuelve al aprobarlo o rechazarlo", () => {
  it("solo un vale fuera de rango (pendiente) deja alerta; dentro de rango no", () => {
    // requestVoucher nace aprobada (dentro de rango) o pendiente (fuera);
    // solo la pendiente escribe la alerta voucher.requested.
    expect(voucherAlertRequired("pendiente")).toBe(true);
    expect(voucherAlertRequired("aprobada")).toBe(false);
    expect(voucherAlertRequired("rechazada")).toBe(false);
    expect(voucherAlertRequired("descontada")).toBe(false);
  });

  it("la alerta del vale vive en el vocabulario y módulo de la bandeja", () => {
    expect([...ALERT_ACTIONS]).toContain(VOUCHER_ALERT_ACTION);
    expect([...ALERT_MODULES.caja.actions]).toContain(VOUCHER_ALERT_ACTION);
    expect(VOUCHER_ALERT_ENTITY).toBe("voucher_requests");
  });

  it("el cierre reutiliza is_read/read_at/review_note/reviewed_by (sin estados nuevos)", () => {
    const patch = buildVoucherAlertResolution({
      reviewedBy: "admin-1",
      note: "Vale aprobado.",
      now: "2026-01-02T03:04:05.000Z",
    });
    expect(patch).toEqual({
      is_read: true,
      read_at: "2026-01-02T03:04:05.000Z",
      review_note: "Vale aprobado.",
      reviewed_by: "admin-1",
    });
  });

  it("nota de resolución: aprobado y rechazado con su motivo", () => {
    expect(voucherAlertResolutionNote("aprobada")).toBe("Vale aprobado.");
    expect(voucherAlertResolutionNote("rechazada")).toBe("Vale rechazado.");
    expect(voucherAlertResolutionNote("rechazada", "sin soporte")).toBe(
      "Vale rechazado: sin soporte",
    );
    expect(voucherAlertResolutionNote("rechazada", "   ")).toBe("Vale rechazado.");
  });

  it("el cierre toca SOLO la alerta pendiente de ESE vale (idempotente, sin duplicar)", () => {
    expect(voucherAlertFilter("sede-1", "vale-9")).toEqual({
      sede_id: "sede-1",
      action: VOUCHER_ALERT_ACTION,
      entity: VOUCHER_ALERT_ENTITY,
      entity_id: "vale-9",
      is_read: false,
    });
    // Otro vale queda fuera del filtro: aprobar uno no cierra la alerta de otro.
    const other = voucherAlertFilter("sede-1", "vale-10");
    expect(other.entity_id).not.toBe("vale-9");
  });
});
