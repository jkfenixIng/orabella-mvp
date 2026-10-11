/**
 * DB_ENGINE / DATABASE_URL (src/shared/config/env.ts) and the repository
 * selector. Default is supabase: production runs without either variable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDbConfig } from "@/src/shared/config/env";

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({ from: () => ({}) }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getDbConfig", () => {
  it.each([
    ["no variables (Vercel today)", {}],
    ["an empty DB_ENGINE", { DB_ENGINE: "" }],
    ["a blank DB_ENGINE", { DB_ENGINE: "   " }],
    ["an explicit supabase", { DB_ENGINE: "supabase" }],
    ["supabase surrounded by whitespace", { DB_ENGINE: " supabase\n" }],
    ["supabase with an unrelated DATABASE_URL", { DB_ENGINE: "supabase", DATABASE_URL: "not a url" }],
  ])("defaults to supabase with %s", (_label, env) => {
    expect(getDbConfig(env)).toEqual({ engine: "supabase" });
  });

  it("selects postgres with its connection string", () => {
    const url = "postgresql://orabella_app@localhost:6543/postgres";
    expect(getDbConfig({ DB_ENGINE: "postgres", DATABASE_URL: url })).toEqual({ engine: "postgres", databaseUrl: url });
  });

  it("trims DB_ENGINE and DATABASE_URL before validating", () => {
    const url = "postgres://orabella_app@localhost:5432/orabella";
    expect(getDbConfig({ DB_ENGINE: "  postgres\t", DATABASE_URL: ` ${url} \n` })).toEqual({
      engine: "postgres",
      databaseUrl: url,
    });
  });

  it.each([{}, { DATABASE_URL: "" }, { DATABASE_URL: "  " }])(
    "postgres without DATABASE_URL fails with a clear message (%o)",
    (extra) => {
      expect(() => getDbConfig({ DB_ENGINE: "postgres", ...extra })).toThrow(
        "Invalid database configuration: DATABASE_URL is required when DB_ENGINE=postgres.",
      );
    },
  );

  it("postgres with a non-postgres URL fails", () => {
    expect(() => getDbConfig({ DB_ENGINE: "postgres", DATABASE_URL: "mysql://x" })).toThrow(
      "DATABASE_URL must be a postgres:// or postgresql:// connection string.",
    );
  });

  it.each(["mysql", "Postgres", "SUPABASE", "pg", "post gres"])("rejects the invalid engine %s", (engine) => {
    expect(() => getDbConfig({ DB_ENGINE: engine })).toThrow('DB_ENGINE must be "supabase" or "postgres".');
  });
});

describe("servicesRepo selector", () => {
  it("uses supabase-js by default and never opens the postgres client", async () => {
    vi.stubEnv("DB_ENGINE", "");
    const { servicesRepo } = await import("@/src/features/admin/repos/services");
    const repo = await servicesRepo();
    expect(Object.keys(repo).sort()).toEqual(["list", "upsert"]);
    expect(Object.keys(globalThis)).not.toContain("__orabellaDb");
  });

  it("fails loudly when DB_ENGINE=postgres has no DATABASE_URL", async () => {
    vi.stubEnv("DB_ENGINE", "postgres");
    vi.stubEnv("DATABASE_URL", "");
    const { servicesRepo } = await import("@/src/features/admin/repos/services");
    await expect(servicesRepo()).rejects.toThrow("DATABASE_URL is required when DB_ENGINE=postgres.");
  });
});

describe("commissionsRepo selector", () => {
  it("uses supabase-js by default and leaves the postgres driver unloaded", async () => {
    vi.stubEnv("DB_ENGINE", "");
    const { commissionsRepo } = await import("@/src/features/commissions/repos/commissions");
    const repo = await commissionsRepo();
    expect(typeof repo.listRules).toBe("function");
    expect(Object.keys(globalThis)).not.toContain("__orabellaDb");
  });

  it("validates postgres configuration before loading the direct adapter", async () => {
    vi.stubEnv("DB_ENGINE", "postgres");
    vi.stubEnv("DATABASE_URL", "");
    const { commissionsRepo } = await import("@/src/features/commissions/repos/commissions");
    await expect(commissionsRepo()).rejects.toThrow("DATABASE_URL is required when DB_ENGINE=postgres.");
  });
});
