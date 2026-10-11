// Node 20 runnable: node tests/portable-migration-runner.test.mjs
// Safety rules run against an in-memory adapter; no database is contacted.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { buildMigrationPlan } from "../scripts/portable-migrations.mjs";
import { applyPlan, reconcilePlan, verifyPlan } from "../scripts/portable-migration-runner.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const contracts = Object.freeze({
  "002_a.sql": { sql: "SELECT true AS present" },
  "003_b.sql": { sql: "SELECT true AS present" },
  "004_c.sql": { sql: "SELECT true AS present" },
});
const sources = { "002_a.sql": "SELECT 2;", "003_b.sql": "SELECT 3;", "004_c.sql": "SELECT 4;" };
const discovered = Object.keys(sources).map((filename) => ({ filename, sha256: sha(sources[filename]) }));
const operator = {
  current_user: "deploy_login",
  session_user: "deploy_login",
  current_roles: ["migration_operator"],
  session_roles: ["migration_operator"],
  session_is_superuser: false,
  current_in_app_role: false,
  session_in_app_role: false,
  is_migration_operator: true,
  operator_role: {
    rolcanlogin: false,
    rolinherit: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    app_members: [],
  },
};
const plan = (applied = []) => buildMigrationPlan(discovered, applied, [], contracts);

function fakeDb({ identity = operator, applied = [], markers = {} } = {}) {
  const state = { ledger: [...applied], markers: { ...markers }, executed: [], reconciled: [] };
  return {
    state,
    identity: async () => identity,
    ledger: async () => ({ applied: [...state.ledger] }),
    markers: async (filenames) => Object.fromEntries(filenames.map((filename) => [filename, state.markers[filename] === true])),
    applyMigration: async (migration) => {
      state.executed.push(migration.filename);
      state.markers[migration.filename] = true;
      state.ledger.push({ filename: migration.filename, sha256: migration.sha256 });
    },
    recordReconciled: async (migration, reason) => {
      state.reconciled.push({ filename: migration.filename, reason });
      state.ledger.push({ filename: migration.filename, sha256: migration.sha256 });
    },
  };
}

const context = (db, currentPlan = plan()) => ({
  plan: currentPlan,
  discovered,
  db,
  markers: contracts,
  readSource: (filename) => Buffer.from(sources[filename]),
});

async function rejects(promise, pattern) {
  await assert.rejects(promise, pattern);
}

// Identity refusal: app login, app session identity, app membership, missing operator membership.
for (const identity of [
  { ...operator, current_user: "orabella_app", session_user: "orabella_app" },
  { ...operator, session_user: "service_role" },
  { ...operator, current_roles: ["migration_operator", "service_role"], current_in_app_role: true },
  { ...operator, current_roles: [], session_roles: [], is_migration_operator: false },
  // Superuser remains refused when it has an explicit app-role grant.
  { ...operator, session_is_superuser: true, current_roles: ["migration_operator", "service_role"] },
]) {
  const db = fakeDb({ identity });
  await rejects(applyPlan(context(db)), /application|superuser nor a migration_operator/);
  assert.deepEqual(db.state.executed, []);
}

// A preexisting or tampered operator role is refused in both modes before any migration.
for (const attribute of ["rolcanlogin", "rolinherit", "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"]) {
  for (const session_is_superuser of [false, true]) {
    const db = fakeDb({ identity: { ...operator, session_is_superuser, operator_role: { ...operator.operator_role, [attribute]: true } } });
    await rejects(applyPlan(context(db)), new RegExp(`forbidden attributes \\(${attribute}\\)`));
    assert.deepEqual(db.state.executed, []);
  }
}
await rejects(
  applyPlan(context(fakeDb({ identity: { ...operator, operator_role: { ...operator.operator_role, app_members: ["orabella_app"] } } }))),
  /application roles are migration_operator members/,
);
await rejects(applyPlan(context(fakeDb({ identity: { ...operator, operator_role: null } }))), /does not exist/);

// An audited DB owner/superuser without explicit app-role grants is an allowed mode.
{
  const db = fakeDb({ identity: { ...operator, session_is_superuser: true, current_in_app_role: true, session_in_app_role: true } });
  assert.deepEqual(await applyPlan(context(db)), ["002_a.sql", "003_b.sql", "004_c.sql"]);
}

// Live ledger differs from the plan state: apply aborts before migration work.
{
  const db = fakeDb({ applied: [{ filename: "002_a.sql", sha256: sha(sources["002_a.sql"]) }] });
  await rejects(applyPlan(context(db)), /stale plan/);
  assert.deepEqual(db.state.executed, []);
}

// A marker already true means a migration might have committed before a crash: never rerun it.
{
  const db = fakeDb({ markers: { "002_a.sql": true } });
  await rejects(applyPlan(context(db)), /run reconcile/);
  assert.deepEqual(db.state.executed, []);
}

// Reconcile records only the first marker-true pending migration, with a reason.
{
  const db = fakeDb({ markers: { "002_a.sql": true } });
  assert.equal(await reconcilePlan({ ...context(db), reason: "INC-42" }), "002_a.sql");
  assert.deepEqual(db.state.reconciled, [{ filename: "002_a.sql", reason: "INC-42" }]);
}

// A false first marker and an unexpected later marker both refuse reconciliation.
await rejects(reconcilePlan({ ...context(fakeDb()), reason: "INC-42" }), /marker is false/);
await rejects(reconcilePlan({ ...context(fakeDb({ markers: { "002_a.sql": true, "003_b.sql": true } })), reason: "INC-42" }), /later pending/);

// Happy apply then live verification.
{
  const db = fakeDb();
  assert.deepEqual(await applyPlan(context(db)), ["002_a.sql", "003_b.sql", "004_c.sql"]);
  assert.match(await verifyPlan(context(db, plan())), /^[a-f0-9]{64}$/);
}

console.log("portable migration runner tests passed");
