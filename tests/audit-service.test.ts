/**
 * writeAudit on the default supabase engine: the same single request, payload
 * and result as before the dual repository; failures never throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const postgrest = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: unknown }>,
  error: null as null | { message: string },
}));
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: (payload: unknown) => {
        postgrest.calls.push({ table, payload });
        return Promise.resolve({ error: postgrest.error });
      },
    }),
  }),
}));

import { writeAudit } from "@/src/shared/lib/audit";

beforeEach(() => {
  vi.unstubAllEnvs();
  postgrest.calls = [];
  postgrest.error = null;
});

describe("writeAudit (supabase-js)", () => {
  it("inserts the normalized payload once into audit_logs", async () => {
    expect(await writeAudit({ action: "auth.login_failed", entity: "users", entity_id: "9" })).toEqual({ written: true });
    expect(postgrest.calls).toEqual([
      { table: "audit_logs", payload: { user_id: null, action: "auth.login_failed", entity: "users", entity_id: "9", metadata: {} } },
    ]);
  });

  it("a PostgREST error is logged with its message and returns written:false", async () => {
    postgrest.error = { message: "permission denied for table audit_logs" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await writeAudit({ user_id: "u1", action: "a", entity: "e", entity_id: "1", metadata: { k: 1 } })).toEqual({ written: false });
    expect(log).toHaveBeenCalledWith("[audit] no se pudo escribir audit_logs:", "permission denied for table audit_logs");
    log.mockRestore();
  });

  it("never throws when the engine configuration is invalid", async () => {
    vi.stubEnv("DB_ENGINE", "mysql");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await writeAudit({ action: "a", entity: "e", entity_id: "1" })).toEqual({ written: false });
    expect(postgrest.calls).toEqual([]);
    log.mockRestore();
  });
});
