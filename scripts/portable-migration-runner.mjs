// Portable migration operations. Pure orchestration over an injected database
// adapter (see portable-migration-db.mjs), so every safety rule is testable
// without a server. The adapter contract:
//   identity()            -> { current_user, session_user, current_roles[], session_roles[],
//                              session_is_superuser, is_migration_operator, operator_role{...} }
//   ledger()              -> { applied: [{ filename, sha256 }] }   (live, ordered)
//   markers(filenames[])  -> { [filename]: boolean }                (read-only)
//   applyMigration(m, sql)   runs the file, then the ledger INSERT as migration_operator
//   recordReconciled(m, reason)  ledger INSERT with reconciled = true
import { MIGRATION_MARKERS } from "./portable-migration-markers.mjs";
import { buildMigrationPlan, fail, hash, same } from "./portable-migrations.mjs";

const applicationRoles = new Set(["orabella_app", "service_role", "anon", "authenticated"]);
const forbiddenOperatorAttributes = ["rolcanlogin", "rolinherit", "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"];

/** The live migration_operator role must be exactly what the bootstrap creates. */
export function assertOperatorRole(role) {
  if (!role) fail("migration_operator role does not exist; apply portable-migration-audit.sql");
  const enabled = forbiddenOperatorAttributes.filter((attribute) => role[attribute] !== false);
  if (enabled.length > 0) fail(`migration_operator has forbidden attributes (${enabled.join(", ")}); re-run portable-migration-audit.sql`);
  if ((role.app_members ?? []).length > 0) fail(`application roles are migration_operator members (${role.app_members.join(", ")})`);
}

/**
 * Two operator modes are accepted; application identities never are.
 *   - "superuser": the audited DB owner/superuser (SQL editor or psql). pg_has_role
 *     is true for a superuser on EVERY role, so for this mode only the explicit
 *     grants (pg_auth_members closure) are checked against application roles.
 *   - "migration_operator": a non-superuser login explicitly granted
 *     migration_operator, with no application-role membership at all.
 * The adapter's dry SET ROLE migration_operator / RESET ROLE runs before this.
 */
export function assertRunnerIdentity(identity) {
  const explicitRoles = [...(identity.current_roles ?? []), ...(identity.session_roles ?? [])];
  if (applicationRoles.has(identity.current_user) || applicationRoles.has(identity.session_user)) {
    fail("migration runner is an application identity");
  }
  if (explicitRoles.some((role) => applicationRoles.has(role))) fail("migration runner has an application-role membership");
  // Both modes switch to migration_operator for the ledger INSERT, so the live
  // role attributes are checked before either is accepted.
  assertOperatorRole(identity.operator_role);
  if (identity.session_is_superuser === true) return "superuser";
  if (identity.current_in_app_role || identity.session_in_app_role) fail("migration runner has an application-role membership");
  if (!identity.is_migration_operator || !(identity.current_roles ?? []).includes("migration_operator")) {
    fail("migration runner is neither a superuser nor a migration_operator member");
  }
  return "migration_operator";
}

/** The plan must still be the deterministic plan for the repo. */
export function assertCurrentPlan(plan, discovered, markers = MIGRATION_MARKERS) {
  if (!Array.isArray(plan?.applied) || !Array.isArray(plan?.deferred)) fail("invalid plan JSON");
  const expected = buildMigrationPlan(discovered, plan.applied, plan.deferred.map((migration) => migration.filename), markers);
  if (!same(plan, expected)) fail("plan does not match current migration hashes, marker contracts, or deferred scope");
}

/** The live ledger, not the manifest the plan was built from, is the source of truth. */
export function assertLivePrefix(plan, liveLedger) {
  if (!same(liveLedger.applied, plan.applied)) fail("stale plan: live ledger differs from the plan's applied prefix; regenerate the plan");
}

async function preflight({ plan, discovered, db, markers }) {
  assertCurrentPlan(plan, discovered, markers);
  assertRunnerIdentity(await db.identity());
  assertLivePrefix(plan, await db.ledger());
}

export async function applyPlan({ plan, discovered, db, readSource, markers }) {
  await preflight({ plan, discovered, db, markers });
  const pending = plan.apply.map((migration) => migration.filename);
  const live = await db.markers(pending);
  for (const filename of pending) {
    if (live[filename] === true) fail(`marker already true for pending ${filename}; run reconcile, never rerun it`);
  }
  const applied = [];
  for (const migration of plan.apply) {
    const source = readSource(migration.filename);
    if (hash(source) !== migration.sha256) fail(`file changed before apply: ${migration.filename}`);
    await db.applyMigration(migration, source.toString());
    applied.push(migration.filename);
  }
  return applied;
}

/** Records ONLY the first pending migration, and only when its marker proves it already committed. */
export async function reconcilePlan({ plan, discovered, db, readSource, reason, markers }) {
  if (!reason || !reason.trim()) fail("reconcile requires --reason");
  await preflight({ plan, discovered, db, markers });
  const [first, ...later] = plan.apply;
  if (!first) fail("no pending migration to reconcile");
  if (hash(readSource(first.filename)) !== first.sha256) fail(`repo hash differs from plan for ${first.filename}`);
  const live = await db.markers(plan.apply.map((migration) => migration.filename));
  if (live[first.filename] !== true) fail(`marker is false for ${first.filename}; reconciliation refused`);
  const unexpected = later.filter((migration) => live[migration.filename] === true).map((migration) => migration.filename);
  if (unexpected.length > 0) fail(`later pending markers unexpectedly true (${unexpected.join(", ")}); reconciliation refused`);
  await db.recordReconciled(first, reason.trim());
  return first.filename;
}

/** Live ledger must equal the plan's expected ledger and every expected marker must be true. */
export async function verifyPlan({ plan, discovered, db, markers }) {
  assertCurrentPlan(plan, discovered, markers);
  assertRunnerIdentity(await db.identity());
  const ledger = await db.ledger();
  if (!same(ledger.applied, plan.expectedApplied)) fail("live ledger does not equal the plan's expected applied migrations");
  const expected = plan.expectedApplied.map((migration) => migration.filename);
  const live = await db.markers(expected);
  const missing = expected.filter((filename) => live[filename] !== true);
  if (missing.length > 0) fail(`schema markers false for ${missing.join(", ")}`);
  return plan.manifestSha256;
}
