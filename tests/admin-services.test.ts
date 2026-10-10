/**
 * Characterization of the service catalog (ADM-05) on the supabase-js path.
 *
 * Written BEFORE the repository extraction and kept unchanged after it: it pins
 * the request the service sends to PostgREST and how it maps every outcome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminError, listServices, upsertService } from "@/src/features/admin/service";

const SERVICE_ID = "8b0f5e2a-1c3d-4e5f-8a7b-9c0d1e2f3a4b";
const SERVICE_SELECT = "id, name, description, price, duracion_min, duracion_max, is_active";

/** Minimal PostgREST double: records the call chain and returns a canned answer. */
const postgrest = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>,
  response: { data: null as unknown, error: null as unknown },
}));

function createStubClient() {
  return {
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> };
      postgrest.calls.push(call);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "upsert"]) {
        query[method] = (...args: unknown[]) => {
          call.chain.push([method, args]);
          return query;
        };
      }
      query.single = () => {
        call.chain.push(["single", []]);
        const data = postgrest.response.data;
        return Promise.resolve({
          data: Array.isArray(data) ? (data[0] ?? null) : data,
          error: postgrest.response.error,
        });
      };
      query.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ ...postgrest.response }).then(onFulfilled, onRejected);
      return query;
    },
  };
}

vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
}));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createStubClient(),
}));

const ROW = {
  id: SERVICE_ID,
  name: "Corte",
  description: null,
  price: 25000.5,
  duracion_min: 30,
  duracion_max: 45,
  is_active: true,
};

async function rejection(promise: Promise<unknown>): Promise<AdminError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminError);
    return error as AdminError;
  }
  throw new Error("expected an AdminError");
}

beforeEach(() => {
  postgrest.calls = [];
  postgrest.response = { data: null, error: null };
});

describe("listServices (supabase-js)", () => {
  it("reads services ordered by name with the default limit of 50", async () => {
    postgrest.response = { data: [ROW], error: null };
    const rows = await listServices();
    expect(rows).toEqual([ROW]);
    expect(postgrest.calls).toEqual([
      {
        table: "services",
        chain: [
          ["select", [SERVICE_SELECT]],
          ["order", ["name"]],
          ["limit", [50]],
        ],
      },
    ]);
  });

  it.each([
    [10, 10],
    [0, 1],
    [10_000, 500],
    [7.9, 7],
    [Number.NaN, 50],
  ])("clamps the limit %s to %s", async (requested, applied) => {
    postgrest.response = { data: [], error: null };
    await listServices(requested);
    expect(postgrest.calls[0].chain.at(-1)).toEqual(["limit", [applied]]);
  });

  it("keeps the price as a number", async () => {
    postgrest.response = { data: [ROW], error: null };
    const [row] = await listServices();
    expect(typeof row.price).toBe("number");
    expect(row.price).toBe(25000.5);
  });

  it("returns an empty list when PostgREST returns no data", async () => {
    postgrest.response = { data: null, error: null };
    expect(await listServices()).toEqual([]);
  });

  it("maps a read error to AdminError INTERNAL 500", async () => {
    postgrest.response = { data: null, error: { code: "42501", message: "permission denied" } };
    const error = await rejection(listServices());
    expect([error.code, error.message, error.status]).toEqual(["INTERNAL", "Error interno.", 500]);
  });
});

describe("upsertService (supabase-js)", () => {
  it("creates: sends the payload without id or is_active, upserts on id and selects the row", async () => {
    postgrest.response = { data: [ROW], error: null };
    const row = await upsertService({ name: "  Corte ", price: "25000.5", duracion_min: "30", duracion_max: 45 });
    expect(row).toEqual(ROW);
    expect(postgrest.calls).toEqual([
      {
        table: "services",
        chain: [
          [
            "upsert",
            [
              { name: "Corte", description: null, price: 25000.5, duracion_min: 30, duracion_max: 45 },
              { onConflict: "id" },
            ],
          ],
          ["select", [SERVICE_SELECT]],
          ["single", []],
        ],
      },
    ]);
  });

  it("updates: sends id and is_active when given", async () => {
    postgrest.response = { data: [{ ...ROW, is_active: false }], error: null };
    await upsertService({
      id: SERVICE_ID,
      name: "Corte",
      description: "Clásico",
      price: 100,
      duracion_min: 0,
      duracion_max: 0,
      is_active: false,
    });
    const [, [payload]] = postgrest.calls[0].chain[0] as [string, [Record<string, unknown>]];
    expect(payload).toEqual({
      id: SERVICE_ID,
      name: "Corte",
      description: "Clásico",
      price: 100,
      duracion_min: 0,
      duracion_max: 0,
      is_active: false,
    });
    expect(typeof payload.price).toBe("number");
  });

  it("rejects invalid input with VALIDATION 400 before touching the database", async () => {
    const error = await rejection(upsertService({ name: "Corte", price: 10, duracion_min: 50, duracion_max: 10 }));
    expect([error.code, error.message, error.status]).toEqual([
      "VALIDATION",
      "La duración mínima no puede superar a la máxima.",
      400,
    ]);
    expect(postgrest.calls).toEqual([]);
  });

  it.each([
    ["a write error", { data: null, error: { code: "23514", message: "check violation" } }],
    ["no row back", { data: null, error: null }],
  ])("maps %s to AdminError INTERNAL 500", async (_label, response) => {
    postgrest.response = response;
    const error = await rejection(upsertService({ name: "Corte", price: 1, duracion_min: 1, duracion_max: 1 }));
    expect([error.code, error.message, error.status]).toEqual(["INTERNAL", "Error interno.", 500]);
  });
});
