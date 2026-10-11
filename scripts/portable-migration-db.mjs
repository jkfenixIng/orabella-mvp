// psql-backed database adapter for the portable migration runner.
// Every call uses a validated executable plus an argument array: no shell and no
// interpolated connection URL. The runner login must explicitly SET ROLE to the
// NOLOGIN migration_operator role.
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { MIGRATION_MARKERS } from "./portable-migration-markers.mjs";
import { fail } from "./portable-migrations.mjs";

const unsafePathCharacters = /[\0\r\n"'`$&|;<>*?%!^(){}[\]]/;

export function migrationUrl(environment = process.env) {
  const url = environment.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is required");
  if (environment.DATABASE_URL && url === environment.DATABASE_URL) fail("MIGRATION_DATABASE_URL must not equal the application DATABASE_URL");
  return url;
}

function executableNames(platform) {
  return platform === "win32" ? ["psql.exe"] : ["psql"];
}

/** Resolves psql to an existing absolute file; .cmd/.bat wrappers are refused because they need a shell. */
export function resolvePsql(candidate, { environment = process.env, platform = process.platform } = {}) {
  const resolved = candidate ?? findOnPath(environment.PATH ?? environment.Path ?? "", platform);
  if (!resolved) fail("psql executable not found on PATH; pass --psql <absolute path>");
  if (!isAbsolute(resolved)) fail("--psql must be an absolute path");
  if (unsafePathCharacters.test(resolved)) fail("--psql path contains shell metacharacters");
  if (platform === "win32" && !resolved.toLowerCase().endsWith(".exe")) fail("--psql must be a .exe on Windows");
  if (!existsSync(resolved) || !statSync(resolved).isFile()) fail("--psql must be an existing file");
  return resolved;
}

function findOnPath(pathValue, platform) {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(platform)) {
      const candidate = join(directory, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const roleClosure = (who) => `(
  WITH RECURSIVE closure(roleid) AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${who}
    UNION
    SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN closure c ON m.member = c.roleid
  )
  SELECT coalesce(jsonb_agg(r.rolname), '[]'::jsonb) FROM closure c JOIN pg_catalog.pg_roles r ON r.oid = c.roleid
)`;

// to_regrole() keeps the probe valid before app-role.sql creates orabella_app
// (pg_has_role on a NULL oid yields NULL, coalesced to false).
const appMembership = (who) =>
  `coalesce(pg_has_role(${who}, pg_catalog.to_regrole('orabella_app'), 'MEMBER'), false)` +
  ` OR coalesce(pg_has_role(${who}, pg_catalog.to_regrole('service_role'), 'MEMBER'), false)`;

export const IDENTITY_SQL = `SELECT jsonb_build_object(
  'current_user', current_user::text,
  'session_user', session_user::text,
  'current_roles', ${roleClosure("current_user")},
  'session_roles', ${roleClosure("session_user")},
  'session_is_superuser', (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user),
  'current_in_app_role', ${appMembership("current_user")},
  'session_in_app_role', ${appMembership("session_user")},
  'is_migration_operator', coalesce(pg_has_role(current_user, pg_catalog.to_regrole('migration_operator'), 'MEMBER'), false),
  'operator_role', (
    SELECT jsonb_build_object(
      'rolcanlogin', r.rolcanlogin, 'rolinherit', r.rolinherit, 'rolsuper', r.rolsuper,
      'rolcreatedb', r.rolcreatedb, 'rolcreaterole', r.rolcreaterole,
      'rolreplication', r.rolreplication, 'rolbypassrls', r.rolbypassrls,
      'app_members', (
        SELECT coalesce(jsonb_agg(member.rolname), '[]'::jsonb)
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
         WHERE m.roleid = r.oid
           AND member.rolname IN ('orabella_app', 'service_role', 'anon', 'authenticated')
      )
    )
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'migration_operator'
  )
)::text`;

export const LEDGER_SQL = `SELECT jsonb_build_object('applied', coalesce(jsonb_agg(jsonb_build_object('filename', filename, 'sha256', sha256) ORDER BY filename), '[]'::jsonb))::text
  FROM public.portable_migration_audit`;

export function markersSql(filenames) {
  if (filenames.length === 0) return "SELECT '{}'::text";
  const pairs = filenames.map((filename) => {
    const contract = MIGRATION_MARKERS[filename];
    if (!contract) fail(`missing marker contract for ${filename}`);
    return `${sqlLiteral(filename)}, (SELECT present FROM (${contract.sql}) AS marker)`;
  });
  return `SELECT jsonb_build_object(${pairs.join(", ")})::text`;
}

export function ledgerInsertSql(migration, reconciliation) {
  const reconciled = reconciliation ? "true" : "false";
  const reason = reconciliation ? sqlLiteral(reconciliation.reason) : "NULL";
  return `SET ROLE migration_operator;
INSERT INTO public.portable_migration_audit (filename, sha256, reconciled, reason)
VALUES (${sqlLiteral(migration.filename)}, ${sqlLiteral(migration.sha256)}, ${reconciled}, ${reason});
RESET ROLE;
`;
}

export function createPsqlDatabase({ psql, url }) {
  const run = (args) => {
    const result = spawnSync(psql, [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`portable migrations: psql failed\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const jsonQuery = (sql) => {
    const lines = run(["-c", sql]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return JSON.parse(lines.at(-1) ?? "null");
  };
  const runScript = (contents) => {
    const directory = mkdtempSync(join(tmpdir(), "orabella-portable-"));
    try {
      const path = join(directory, "script.sql");
      writeFileSync(path, contents);
      run(["-f", path]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return {
    identity: () => {
      // The actual SET ROLE/RESET ROLE dry run is deliberately separate from the
      // identity query so psql stops before any migration if switching is denied.
      run(["-c", "SET ROLE migration_operator", "-c", "RESET ROLE"]);
      return jsonQuery(IDENTITY_SQL);
    },
    ledger: () => jsonQuery(LEDGER_SQL),
    markers: (filenames) => jsonQuery(`BEGIN READ ONLY; ${markersSql(filenames)}; ROLLBACK;`),
    applyMigration: (migration, source) => runScript(`${source}\n${ledgerInsertSql(migration)}`),
    recordReconciled: (migration, reason) => runScript(ledgerInsertSql(migration, { reason })),
  };
}
