import { afterEach, describe, expect, it } from "vitest";
import { applyFile, buildSchemaDb, closeDb, one, pgError, rpc, type Db } from "./harness";

const before006 = [
  "001_orabella_schema.sql",
  "002_portable_platform.sql",
  "003_payment_method_arqueo.sql",
  "004_inventory_literal_search.sql",
  "005_cop_whole_peso.sql",
].map((name) => `supabase/migrations/${name}`);

let db: Db | undefined;

async function preparedDb(): Promise<Db> {
  db = await buildSchemaDb({ catalog: true, migrations: before006 });
  await applyFile(db, "supabase/migrations/006_installation_owner.sql");
  return db;
}

async function addUser(current: Db, document: string, active = true): Promise<string> {
  return (await one<{ id: string }>(
    current,
    `INSERT INTO public.users (id_type, id_number, password_hash, full_name, is_active)
     VALUES ('CC', $1, 'hash', $1, $2) RETURNING id`,
    [document, active],
  )).id;
}

async function roleCodes(current: Db, userId: string): Promise<string[]> {
  return (await current.query<{ code: string }>(
    `SELECT r.code FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  )).rows.map((row) => row.code);
}

afterEach(async () => closeDb(db));

describe("006 installation owner", () => {
  it("leaves ownership unprovisioned and denies normal superadmin assignment", async () => {
    const current = await preparedDb();
    const user = await addUser(current, "owner-candidate");

    expect(await one<{ n: number }>(current, "SELECT count(*)::int AS n FROM public.installation_owner")).toEqual({ n: 0 });
    expect(await pgError(rpc(current, "replace_user_roles", [user, ["superadmin"]], ["uuid", "text[]"]))).toMatchObject({
      code: "P0001",
      message: "OWNER_NOT_PROVISIONED",
    });
    expect(await pgError(current.query(
      `INSERT INTO public.user_roles (user_id, role_id) SELECT $1, id FROM public.roles WHERE code = 'superadmin'`,
      [user],
    ))).toMatchObject({ code: "P0001", message: "OWNER_NOT_PROVISIONED" });
    expect(await roleCodes(current, user)).toEqual([]);
  });

  it("provisions one active owner once, grants only their superadmin role, and rejects a second provision", async () => {
    const current = await preparedDb();
    const owner = await addUser(current, "owner");
    const other = await addUser(current, "other");

    await rpc(current, "provision_installation_owner", [owner], ["uuid"]);

    expect(await one<{ owner_user_id: string }>(current, "SELECT owner_user_id FROM public.installation_owner")).toEqual({ owner_user_id: owner });
    expect(await roleCodes(current, owner)).toEqual(["superadmin"]);
    expect(await pgError(rpc(current, "provision_installation_owner", [other], ["uuid"]))).toMatchObject({
      code: "P0001",
      message: "INSTALLATION_OWNER_ALREADY_PROVISIONED",
    });
    expect(await pgError(rpc(current, "replace_user_roles", [other, ["superadmin"]], ["uuid", "text[]"]))).toMatchObject({
      code: "P0001",
      message: "SUPERADMIN_OWNER_ONLY",
    });
  });

  it("rejects an inactive candidate and direct or RPC attempts to remove the owner role", async () => {
    const current = await preparedDb();
    const inactive = await addUser(current, "inactive", false);
    const owner = await addUser(current, "owner");

    expect(await pgError(rpc(current, "provision_installation_owner", [inactive], ["uuid"]))).toMatchObject({
      code: "P0001",
      message: "INSTALLATION_OWNER_INACTIVE",
    });
    await rpc(current, "provision_installation_owner", [owner], ["uuid"]);

    expect(await pgError(rpc(current, "replace_user_roles", [owner, ["admin"]], ["uuid", "text[]"]))).toMatchObject({
      code: "P0001",
      message: "INSTALLATION_OWNER_ROLE_IMMUTABLE",
    });
    expect(await pgError(current.query(
      `DELETE FROM public.user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM public.roles WHERE code = 'superadmin')`,
      [owner],
    ))).toMatchObject({ code: "P0001", message: "INSTALLATION_OWNER_ROLE_IMMUTABLE" });
    expect(await roleCodes(current, owner)).toEqual(["superadmin"]);
  });

  it("blocks direct owner changes and records an audited break-glass transfer", async () => {
    const current = await preparedDb();
    const owner = await addUser(current, "owner");
    const replacement = await addUser(current, "replacement");
    await rpc(current, "provision_installation_owner", [owner], ["uuid"]);

    expect(await pgError(current.query("DELETE FROM public.installation_owner"))).toMatchObject({
      code: "P0001",
      message: "INSTALLATION_OWNER_IMMUTABLE",
    });
    expect(await pgError(current.query("UPDATE public.installation_owner SET owner_user_id = $1", [replacement]))).toMatchObject({
      code: "P0001",
      message: "INSTALLATION_OWNER_IMMUTABLE",
    });

    await rpc(current, "break_glass_transfer_installation_owner", [replacement, "Lost access ticket INC-42"], ["uuid", "text"]);

    expect(await one<{ owner_user_id: string }>(current, "SELECT owner_user_id FROM public.installation_owner")).toEqual({ owner_user_id: replacement });
    expect(await roleCodes(current, owner)).toEqual([]);
    expect(await roleCodes(current, replacement)).toEqual(["superadmin"]);
    expect(await one<{ action: string; metadata: { old: string; new: string; reason: string; operator: string } }>(
      current,
      "SELECT action, metadata FROM public.audit_logs WHERE action = 'installation_owner_break_glass_transfer' ORDER BY created_at DESC LIMIT 1",
    )).toEqual({
      action: "installation_owner_break_glass_transfer",
      metadata: expect.objectContaining({ old: owner, new: replacement, reason: "Lost access ticket INC-42", operator: expect.any(String) }),
    });
  });

  it("keeps owner procedures out of app roles and hardens their search path", async () => {
    const current = await preparedDb();
    const acl = await one<{ anon: boolean; authenticated: boolean; service: boolean; public_execute: boolean }>(
      current,
      `SELECT has_function_privilege('anon', 'public.provision_installation_owner(uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.provision_installation_owner(uuid)', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.provision_installation_owner(uuid)', 'EXECUTE') AS service,
              has_function_privilege('public', 'public.provision_installation_owner(uuid)', 'EXECUTE') AS public_execute`,
    );
    expect(acl).toEqual({ anon: false, authenticated: false, service: true, public_execute: false });
    const paths = await current.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig FROM pg_proc WHERE proname IN ('provision_installation_owner', 'break_glass_transfer_installation_owner') ORDER BY proname`,
    );
    expect(paths.rows).toEqual([
      { proname: "break_glass_transfer_installation_owner", proconfig: ["search_path=pg_catalog, public"] },
      { proname: "provision_installation_owner", proconfig: ["search_path=pg_catalog, public"] },
    ]);
  });
});
