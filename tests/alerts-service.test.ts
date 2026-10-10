/**
 * Characterization of the alert inbox on the supabase-js path: the exact
 * PostgREST requests and how each outcome is mapped. Written against the
 * service as it was before the repository extraction (b105749) and kept
 * unchanged after it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_ACTIONS, ALERT_MODULES } from "@/src/features/alerts/schemas";
import {
  AlertError,
  countUnreadAlerts,
  getShiftReviews,
  listAlerts,
  markAlertRead,
  resolveVoucherAlert,
} from "@/src/features/alerts/service";

const ALERT_SELECT =
  "id, action, entity, entity_id, metadata, user_id, is_read, read_at, review_note, reviewed_by, created_at";

type Response = { data?: unknown; count?: number | null; error: unknown };

/** PostgREST double: records each request's chain and answers per table in order. */
const postgrest = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>,
  answers: [] as Array<{ data?: unknown; count?: number | null; error: unknown }>,
}));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> };
      postgrest.calls.push(call);
      const answer = () => postgrest.answers.shift() ?? { data: null, error: null };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "in", "eq", "gte", "lte", "order", "range", "update", "match"]) {
        query[method] = (...args: unknown[]) => {
          call.chain.push([method, args]);
          return query;
        };
      }
      query.maybeSingle = () => {
        call.chain.push(["maybeSingle", []]);
        return Promise.resolve(answer());
      };
      query.then = (ok?: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(ok, ko);
      return query;
    },
  }),
}));

const RAW = {
  id: "a1",
  action: "cash.shift_open_mismatch",
  entity: "cash_shifts",
  entity_id: "shift-1",
  metadata: null,
  user_id: "u1",
  is_read: true,
  read_at: "2026-10-09T19:40:00.5+00:00",
  review_note: "ok",
  reviewed_by: "u2",
  created_at: "2026-10-09T19:32:18.123456+00:00",
};

function answer(...responses: Response[]) {
  postgrest.answers = responses;
}

async function rejection(promise: Promise<unknown>): Promise<AlertError> {
  const error = await promise.then(
    () => {
      throw new Error("expected an AlertError");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AlertError);
  return error as AlertError;
}

beforeEach(() => {
  postgrest.calls = [];
  postgrest.answers = [];
});

describe("listAlerts (supabase-js)", () => {
  it("counts exactly, reads one newest-first page and resolves both user names", async () => {
    answer(
      { count: 23, error: null },
      { data: [RAW], error: null },
      { data: [{ id: "u1", full_name: "Ana" }, { id: "u2", full_name: "Beto" }], error: null },
    );
    const result = await listAlerts({ page: 3, unreadOnly: true, module: "caja", from: "2026-10-01", to: "2026-10-09" });
    const actions = [...ALERT_MODULES.caja.actions];
    const filters: Array<[string, unknown[]]> = [
      ["in", ["action", actions]],
      ["eq", ["is_read", false]],
      ["gte", ["created_at", "2026-10-01T00:00:00-05:00"]],
      ["lte", ["created_at", "2026-10-09T23:59:59.999-05:00"]],
    ];
    expect(postgrest.calls).toEqual([
      { table: "audit_logs", chain: [["select", ["id", { count: "exact", head: true }]], ...filters] },
      {
        table: "audit_logs",
        chain: [
          ["select", [ALERT_SELECT]],
          ...filters,
          ["order", ["created_at", { ascending: false }]],
          ["order", ["id", { ascending: false }]],
          ["range", [20, 29]],
        ],
      },
      { table: "users", chain: [["select", ["id, full_name"]], ["in", ["id", ["u1", "u2"]]]] },
    ]);
    expect(result).toEqual({
      page: 3,
      pageSize: 10,
      total: 23,
      alerts: [{ ...RAW, metadata: {}, user_name: "Ana", reviewed_by_name: "Beto" }],
    });
  });

  it("without filters: all alert actions, page 1, no user read when nobody is named", async () => {
    answer({ count: null, error: null }, { data: null, error: null });
    expect(await listAlerts({})).toEqual({ alerts: [], page: 1, pageSize: 10, total: 0 });
    expect(postgrest.calls.map((call) => call.chain.slice(1))).toEqual([
      [["in", ["action", [...ALERT_ACTIONS]]]],
      [
        ["in", ["action", [...ALERT_ACTIONS]]],
        ["order", ["created_at", { ascending: false }]],
        ["order", ["id", { ascending: false }]],
        ["range", [0, 9]],
      ],
    ]);
  });

  it.each([
    ["the count", [{ error: { code: "42703", message: 'column "is_read" does not exist' } }], "SCHEMA_MISMATCH"],
    ["the page", [{ count: 1, error: null }, { error: { code: "42P01", message: "relation x does not exist" } }], "SCHEMA_MISMATCH"],
    ["the page (other error)", [{ count: 1, error: null }, { error: { code: "57014", message: "timeout" } }], "INTERNAL"],
    ["the user names", [{ count: 1, error: null }, { data: [RAW], error: null }, { error: { message: 'column "x" does not exist' } }], "INTERNAL"],
  ])("maps a failure of %s", async (_label, responses, code) => {
    answer(...(responses as Response[]));
    const error = await rejection(listAlerts({}));
    expect([error.code, error.status]).toEqual([code, 500]);
  });

  it("rejects invalid input with VALIDATION 400 before touching the database", async () => {
    const error = await rejection(listAlerts({ page: 0 }));
    expect([error.code, error.status]).toEqual(["VALIDATION", 400]);
    expect(postgrest.calls).toEqual([]);
  });
});

describe("countUnreadAlerts (supabase-js)", () => {
  it("exact head count of unread alerts of a module", async () => {
    answer({ count: 4, error: null });
    expect(await countUnreadAlerts("acceso")).toBe(4);
    expect(postgrest.calls).toEqual([
      {
        table: "audit_logs",
        chain: [
          ["select", ["id", { count: "exact", head: true }]],
          ["in", ["action", [...ALERT_MODULES.acceso.actions]]],
          ["eq", ["is_read", false]],
        ],
      },
    ]);
  });

  it("null count is 0; a failure maps through toAlertError", async () => {
    answer({ count: null, error: null });
    expect(await countUnreadAlerts()).toBe(0);
    answer({ error: { message: "boom" } });
    expect((await rejection(countUnreadAlerts())).code).toBe("INTERNAL");
  });
});

describe("getShiftReviews (supabase-js)", () => {
  it("no shift: no request", async () => {
    expect(await getShiftReviews([])).toEqual(new Map());
    expect(postgrest.calls).toEqual([]);
  });

  it("groups the mismatch audits of each shift with the reviewer name", async () => {
    answer(
      {
        data: [
          { entity_id: "s1", action: "cash.shift_open_mismatch", created_at: RAW.created_at, is_read: true, review_note: "ok", reviewed_by: "u2" },
          { entity_id: "s1", action: "cash.shift_close_mismatch", created_at: RAW.created_at, is_read: false, review_note: null, reviewed_by: null },
        ],
        error: null,
      },
      { data: [{ id: "u2", full_name: "Beto" }], error: null },
    );
    const result = await getShiftReviews(["s1", "s2"]);
    expect(postgrest.calls[0]).toEqual({
      table: "audit_logs",
      chain: [
        ["select", ["entity_id, action, created_at, is_read, review_note, reviewed_by"]],
        ["eq", ["entity", "cash_shifts"]],
        ["in", ["entity_id", ["s1", "s2"]]],
        ["in", ["action", ["cash.shift_open_mismatch", "cash.shift_close_mismatch"]]],
      ],
    });
    expect([...result]).toEqual([
      [
        "s1",
        [
          { action: "cash.shift_open_mismatch", fecha: RAW.created_at, revisada: true, justificacion: "ok", revisor: "Beto" },
          { action: "cash.shift_close_mismatch", fecha: RAW.created_at, revisada: false, justificacion: null, revisor: null },
        ],
      ],
    ]);
  });
});

describe("markAlertRead / resolveVoucherAlert (supabase-js)", () => {
  it("update by id with maybeSingle; no row is NOT_FOUND, an error maps through toAlertError", async () => {
    answer({ data: { id: "a1" }, error: null });
    expect(await markAlertRead("a1", { note: " ok " }, { userId: "u9" })).toEqual({ id: "a1" });
    const [, [patch]] = postgrest.calls[0].chain[0] as [string, [Record<string, unknown>]];
    expect(patch).toMatchObject({ is_read: true, review_note: "ok", reviewed_by: "u9" });
    expect(postgrest.calls[0].chain.slice(1)).toEqual([["eq", ["id", "a1"]], ["select", ["id"]], ["maybeSingle", []]]);

    answer({ data: null, error: null });
    expect((await rejection(markAlertRead("a2", { note: "x" }, { userId: "u9" }))).code).toBe("NOT_FOUND");
    answer({ data: null, error: { message: "relation audit_logs does not exist" } });
    expect((await rejection(markAlertRead("a2", { note: "x" }, { userId: "u9" }))).code).toBe("SCHEMA_MISMATCH");
  });

  it("closes the voucher alert with match(); a database error is logged and reported unresolved", async () => {
    answer({ data: null, error: null });
    expect(await resolveVoucherAlert("v1", "u9", "Vale aprobado.")).toEqual({ resolved: true });
    expect(postgrest.calls[0].chain[1]).toEqual([
      "match",
      [{ action: "voucher.requested", entity: "voucher_requests", entity_id: "v1", is_read: false }],
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    answer({ data: null, error: { message: "down" } });
    expect(await resolveVoucherAlert("v1", null, "x")).toEqual({ resolved: false });
    expect(log).toHaveBeenCalledWith("[alerts] no se pudo cerrar la alerta del vale:", "down");
    log.mockRestore();
  });
});
