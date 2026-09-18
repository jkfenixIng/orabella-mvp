import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, buildAuditPayload, writeAudit } from "@/src/shared/lib/audit";
import {
  MemoryRateLimiter,
  isExternalRateLimitConfigured,
  isRateLimited,
  recordRateFailure,
  resetRateLimit,
} from "@/src/shared/lib/rate-limit";

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8");
}

describe("audit payload (T8, sin red)", () => {
  it("construye el payload con metadata por defecto {}", () => {
    const payload = buildAuditPayload({
      sede_id: "sede-1",
      user_id: "user-1",
      action: AUDIT_ACTIONS.INVOICE_ANNULLED,
      entity: "invoices",
      entity_id: "inv-1",
    });
    expect(payload).toEqual({
      sede_id: "sede-1",
      user_id: "user-1",
      action: "invoice.annulled",
      entity: "invoices",
      entity_id: "inv-1",
      metadata: {},
    });
  });

  it("normaliza sede/user nulos y conserva metadata", () => {
    const payload = buildAuditPayload({
      sede_id: null,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: "users",
      entity_id: "999",
      metadata: { reason: "unknown_or_inactive" },
    });
    expect(payload.sede_id).toBeNull();
    expect(payload.user_id).toBeNull();
    expect(payload.metadata).toEqual({ reason: "unknown_or_inactive" });
  });

  it("cubre las acciones críticas del vocabulario T8", () => {
    expect(Object.values(AUDIT_ACTIONS)).toEqual(
      expect.arrayContaining([
        "auth.login_failed",
        "auth.login_locked",
        "auth.password_changed",
        "invoice.annulled",
        "cash.shift_closed",
        "payroll.calculated",
        "payroll.closed",
        "voucher.approved",
      ]),
    );
  });

  // Timeout amplio: el primer import dinámico de next/headers + supabase-js
  // es pesado en este entorno; lo que se valida es que nunca lanza.
  it("writeAudit nunca lanza sin backend (devuelve written:false)", async () => {
    const saved = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const result = await writeAudit({
        sede_id: "sede-1",
        user_id: "user-1",
        action: AUDIT_ACTIONS.SHIFT_CLOSED,
        entity: "cash_shifts",
        entity_id: "shift-1",
        metadata: { base_incompleta: true },
      });
      expect(result).toEqual({ written: false });
    } finally {
      if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.anon !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.anon;
      if (saved.service !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.service;
    }
  }, 20000);
});

describe("rate-limit compartido T8 (fallback memoria, sin red)", () => {
  const savedUpstash = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  function withoutUpstash() {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  function restoreUpstash() {
    if (savedUpstash.url !== undefined) process.env.UPSTASH_REDIS_REST_URL = savedUpstash.url;
    if (savedUpstash.token !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = savedUpstash.token;
  }

  it("sin Upstash no hay backend externo", () => {
    withoutUpstash();
    try {
      expect(isExternalRateLimitConfigured()).toBe(false);
    } finally {
      restoreUpstash();
    }
  });

  it("fallback: 5 fallos bloquean y reset libera (async)", async () => {
    withoutUpstash();
    const budget = { maxAttempts: 5, windowMs: 15 * 60 * 1000, namespace: "t8-test-login" };
    try {
      for (let i = 0; i < 4; i += 1) {
        expect(await isRateLimited(`doc-fallback-${i % 2}`, budget)).toBe(false);
        await recordRateFailure("doc-fallback", budget);
      }
      expect(await isRateLimited("doc-fallback", budget)).toBe(false);
      const outcome = await recordRateFailure("doc-fallback", budget);
      expect(outcome.blocked).toBe(true);
      expect(await isRateLimited("doc-fallback", budget)).toBe(true);
      await resetRateLimit("doc-fallback", budget);
      expect(await isRateLimited("doc-fallback", budget)).toBe(false);
    } finally {
      restoreUpstash();
    }
  });

  it("MemoryRateLimiter conserva la interfaz T2 (sync)", () => {
    const limiter = new MemoryRateLimiter();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("abc", now);
    expect(limiter.isBlocked("abc", now)).toBe(true);
    expect(MemoryRateLimiter.normalize("  abc ")).toBe("abc");
  });
});

describe("migración 008_hardening.sql (T8)", () => {
  const sql = readMigration("008_hardening.sql");

  it("define current_sede_id() leyendo app_metadata.sede_id del JWT", () => {
    expect(sql).toContain("current_sede_id");
    expect(sql).toContain("app_metadata");
    expect(sql).toContain("auth.jwt()");
  });

  it("crea audit_logs con las columnas TRA-01", () => {
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("audit_logs");
    expect(sql).toContain("entity_id");
    expect(sql).toContain("metadata jsonb");
  });

  it("revoca las políticas permisivas temporales de T2–T7", () => {
    for (const policy of [
      "pol_sedes_sede_isolation",
      "pol_products_sede_isolation",
      "pol_invoices_sede_isolation",
      "pol_cash_shifts_sede_isolation",
      "pol_payroll_periods_sede_isolation",
      "pol_voucher_requests_sede_isolation",
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${policy}`);
    }
    expect(sql).not.toMatch(/FOR ALL USING \(true\)/);
  });

  it("documenta el Auth Hook custom access token con app_metadata.sede_id", () => {
    expect(sql).toContain("custom_access_token_hook");
    expect(sql).toContain("app_metadata,sede_id");
  });

  it("documenta la excepción funcional de roles (catálogo global)", () => {
    expect(sql).toContain("pol_roles_readonly");
  });
});

describe("seed de aceptación §11 (T8)", () => {
  const seed = readFileSync(join(process.cwd(), "supabase", "seeds", "acceptance.sql"), "utf8");

  it("es idempotente (ON CONFLICT / NOT EXISTS)", () => {
    expect(seed).toContain("ON CONFLICT DO NOTHING");
    expect(seed).toContain("NOT EXISTS");
  });

  it("deja sede, 10 empleados (Sonia '13' mixta), 4 servicios, 3 productos", () => {
    expect(seed).toContain("Sede principal");
    expect(seed).toContain("'13'");
    expect(seed).toContain("mixto");
    expect(seed).toContain("duracion_min");
    expect(seed).toContain("SH-500");
  });

  it("activa IVA 19% de prueba, deja ICA inactivo y 6 métodos de pago", () => {
    expect(seed).toContain("'IVA', 'IVA general', 19, true");
    expect(seed).toContain("'ICA', 'ICA', 0, false");
    expect(seed).toContain("bre-b");
  });

  it("deja base_configurada y register listo sin turnos", () => {
    expect(seed).toContain("base_configurada");
    expect(seed).toContain("Caja única");
    expect(seed).not.toMatch(/INSERT INTO public\.cash_shifts/);
  });
});
