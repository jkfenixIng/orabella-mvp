import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/src/shared/db/client";
import { callRpc } from "@/src/shared/db/rpc";

function capturedRpc(args: Parameters<typeof callRpc>[2]) {
  let query: unknown;
  const db = {
    execute: async (statement: unknown) => {
      query = statement;
      return [{ result: null }];
    },
  } as unknown as Database;

  return callRpc(db, "money_apply", args).then(() => new PgDialect().sqlToQuery(query as never));
}

describe("callRpc", () => {
  it("binds UUID arrays with an explicit uuid[] cast", async () => {
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    await expect(capturedRpc([{ value: ids, cast: "uuid[]" }])).resolves.toMatchObject({
      sql: "SELECT public.money_apply($1::uuid[]) AS result",
      params: ['{"11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222"}'],
    });
  });

  it("binds false and signed decimals without interpolating them", async () => {
    const args = [
      { value: false, cast: "boolean" },
      { value: -12.34, cast: "numeric" },
      { value: "1000000.10", cast: "numeric" },
    ] as const;
    await expect(capturedRpc([...args])).resolves.toMatchObject({
      sql: "SELECT public.money_apply($1::boolean, $2::numeric, $3::numeric) AS result",
      params: [false, -12.34, "1000000.10"],
    });
  });

  it("serializes nested jsonb exactly once", async () => {
    await expect(capturedRpc([{ value: { allocation: [{ amount: 12.5 }] }, cast: "jsonb" }])).resolves.toMatchObject({
      sql: "SELECT public.money_apply($1::jsonb) AS result",
      params: ['{"allocation":[{"amount":12.5}]}'],
    });
  });

  it("rejects an unsafe function name before executing", async () => {
    const execute = vi.fn(() => Promise.resolve([{ result: null }]));
    const db = { execute } as unknown as Database;
    for (const name of ["money_apply; DROP TABLE invoices", "public.money_apply", "Money_apply", "a".repeat(64)]) {
      await expect(callRpc(db, name, [])).rejects.toThrow("Invalid RPC name.");
    }
    const cast = "numeric); DROP TABLE invoices; --" as "numeric";
    await expect(callRpc(db, "money_apply", [{ value: 1, cast }])).rejects.toThrow("Invalid RPC cast.");
    expect(execute).not.toHaveBeenCalled();
  });
});
