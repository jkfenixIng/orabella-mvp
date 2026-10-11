import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSedeUsers, setUserRoles, upsertEmployee } from "@/src/features/admin/service";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const calls = vi.hoisted(() => [] as Array<{ table?: string; fn?: string; chain: Array<[string, unknown[]]> }>);
const answers = vi.hoisted(() => [] as Array<{ data: unknown; error: unknown }>);
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> }; calls.push(call);
      const response = () => answers.shift() ?? { data: null, error: null };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "or", "order", "in", "eq", "neq", "limit", "upsert"]) query[method] = (...args: unknown[]) => { call.chain.push([method, args]); return query; };
      query.maybeSingle = () => Promise.resolve(response());
      query.single = () => Promise.resolve(response());
      query.then = (ok?: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise.resolve(response()).then(ok, ko);
      return query;
    },
    rpc(fn: string, args: Record<string, unknown>) { calls.push({ fn, chain: [["rpc", [args]]] }); return Promise.resolve(answers.shift() ?? { data: null, error: null }); },
  }),
}));

beforeEach(() => { calls.length = 0; answers.length = 0; });

describe("admin user management supabase characterization", () => {
  it("lists users with a quoted sede logic-tree literal, roles embed and total order", async () => {
    answers.push({ data: [{ id: USER_ID, sede_id: null, full_name: "Ana", id_number: "1" }], error: null }, { data: [{ user_id: USER_ID, roles: { code: "admin" } }], error: null });
    await expect(listSedeUsers('s",sede_id.is.null)')).resolves.toEqual([{ id: USER_ID, sede_id: null, full_name: "Ana", id_number: "1", roles: ["admin"] }]);
    expect(calls).toEqual([
      { table: "users", chain: [["select", ["id, sede_id, full_name, id_number"]], ["or", ['sede_id.eq."s\\",sede_id.is.null)",sede_id.is.null']], ["order", ["full_name"]], ["order", ["id"]]] },
      { table: "user_roles", chain: [["select", ["user_id, roles(code)"]], ["in", ["user_id", [USER_ID]]]] },
    ]);
  });

  it("uses the atomic RPC for creation and exact employee pre-reads", async () => {
    answers.push({ data: { id: USER_ID }, error: null }, { data: [], error: null }, { data: [], error: null }, { data: { id: "e1", full_name: "Ana", salary_fixed: 1000 }, error: null });
    await upsertEmployee({ full_name: "Ana", document: "100", employee_code: "EMP", pay_type: "fijo", salary_fixed: 1000 }, "s1");
    expect(calls.map(({ table, fn, chain }) => ({ table, fn, chain }))).toEqual([
      { table: "users", fn: undefined, chain: [["select", ["id"]], ["eq", ["id_number", "100"]]] },
      { table: "employees", fn: undefined, chain: [["select", ["id"]], ["eq", ["user_id", USER_ID]], ["limit", [1]]] },
      { table: "employees", fn: undefined, chain: [["select", ["id"]], ["eq", ["employee_code", "EMP"]], ["limit", [1]]] },
      { table: undefined, fn: "upsert_employee_atomic", chain: [["rpc", [expect.objectContaining({ p_user_id: USER_ID, p_role_code: "empleado" })]]] },
    ]);
  });

  it("reads the roles embed before atomically replacing the role", async () => {
    answers.push({ data: [{ roles: { code: "empleado" } }], error: null }, { data: ["admin"], error: null });
    await expect(setUserRoles({ user_id: USER_ID, roles: ["admin"] })).resolves.toEqual({ user_id: USER_ID, roles: ["admin"] });
    expect(calls).toEqual([
      { table: "user_roles", chain: [["select", ["roles(code)"]], ["eq", ["user_id", USER_ID]]] },
      { fn: "replace_user_roles", chain: [["rpc", [{ p_user_id: USER_ID, p_role_codes: ["admin"] }]]] },
    ]);
  });
});
