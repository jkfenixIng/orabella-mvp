/**
 * Restores a production backup folder into PGlite and verifies it, offline.
 *
 *   npm run verify:backup -- <backup-dir>
 *
 * Reads (never modifies) from <backup-dir>:
 *   SHA256SUMS.txt, prod-public-data.sql, prod-conteos.txt, prod-catalogo.txt
 * Writes exactly one file: <backup-dir>/verificacion-restauracion-pglite.txt
 *
 * Steps: checksums -> schema (bootstrap/platform-roles.sql + 001 + 002 verbatim,
 * NO catalog seed, the dump brings its own rows) -> data load -> every later
 * migration (003, 004...) -> FK check -> exact row count per table vs
 * prod-conteos.txt -> catalog inventory vs prod-catalogo.txt.
 *
 * Expected differences are declared by exact object name below: 002 redefines
 * current_sede_id() and 003/004 add repo-only objects until production applies
 * them. The inventory compares signatures, so it does not confuse that with a
 * data/schema drift.
 * No network and no remote database: PGlite runs in-process.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Runs on Node's native TypeScript stripping, which needs the `.ts` extension in
// the specifier; tsconfig (moduleResolution bundler) rejects it in a static
// import, so the harness is loaded by URL and typed through `typeof import`.
type Harness = typeof import("../tests/db/harness");
const harnessUrl = new URL("../tests/db/harness.ts", import.meta.url).href;
const { buildSchemaDb, MIGRATION_PATHS, PORTABLE_PATH, SCHEMA_PATH, applyFile } = (await import(harnessUrl)) as Harness;
type Db = Awaited<ReturnType<Harness["buildSchemaDb"]>>;

const dir = resolve(process.argv[2] ?? "");
const REQUIRED = ["SHA256SUMS.txt", "prod-public-data.sql", "prod-conteos.txt", "prod-catalogo.txt"];
if (!process.argv[2] || REQUIRED.some((file) => !existsSync(join(dir, file)))) {
  console.error(`usage: npm run verify:backup -- <backup-dir>  (needs ${REQUIRED.join(", ")})`);
  process.exit(2);
}

const read = (file: string): string => readFileSync(join(dir, file), "utf8");

/**
 * Catalog objects that exist in the repo because of 003/004 and not yet in the
 * production backup. They are EXPECTED differences, listed one by one: anything
 * outside this list (or missing from production) is still a failure. The
 * dropped `payment_methods_code_check` is the one object production has and
 * the repo intentionally no longer has.
 */
const EXPECTED_LATER = {
  tables: new Set(["cash_shift_method_balances", "installation_owner"]),
  onlyInRepo: new Set([
    "function|cash_open_shift_atomic_legacy(p_register_id uuid, p_opened_by uuid, p_opening_base numeric, p_counts jsonb)",
    "function|cash_recount_shift_atomic_legacy(p_shift_id uuid, p_recounted_by uuid, p_recount jsonb, p_counts jsonb)",
    "function|cash_shift_method_expected_balance(p_shift_id uuid, p_method_code text)",
    "function|voucher_is_cash_out(p_status text, p_approved_by uuid, p_method_code text, p_cash_shift_id uuid)",
    "function|enforce_voucher_cash_out_state()",
    "function|enforce_collection_move_minimum()",
    "function|lock_invoice_edit_payment_balances(p_invoice_id uuid, p_edit jsonb)",
    "function|invoice_edit_items_atomic_legacy(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb)",
    "function|invoice_edit_emitted_atomic_legacy(p_invoice_id uuid, p_user_id uuid, p_expected_version integer, p_expected_status text, p_edit jsonb)",
    "trigger|voucher_requests.trg_voucher_requests_cash_out_state",
    "trigger|invoice_payments.trg_invoice_payments_balance_guard",
    "trigger|payments.trg_payments_balance_guard",
    "function|enforce_cash_method_minimum(p_shift_id uuid, p_method_code text, p_amount numeric, p_old_amount numeric)",
    "function|enforce_commission_cash_method_minimum()",
    "function|enforce_voucher_cash_method_minimum()",
    "function|payment_method_code_immutable()",
    "trigger|payment_methods.trg_payment_methods_code_immutable",
    "trigger|commission_payouts.trg_commission_payouts_balance_guard",
    "trigger|voucher_requests.trg_voucher_requests_balance_guard",
    "constraint|payment_methods.payment_methods_code_format_check|c",
    "constraint|payment_methods.payment_methods_arqueo_mode_check|c",
    "constraint|payment_methods.payment_methods_arqueo_coherent_check|c",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_pkey|p",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_opening_base_check|c",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_shift_method_key|u",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_shift_code_key|u",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_cash_shift_id_fkey|f",
    "constraint|cash_shift_method_balances.cash_shift_method_balances_payment_method_id_fkey|f",
    "index|cash_shift_method_balances.cash_shift_method_balances_pkey",
    "index|cash_shift_method_balances.cash_shift_method_balances_shift_method_key",
    "index|cash_shift_method_balances.cash_shift_method_balances_shift_code_key",
    "index|payment_methods.uq_payment_methods_single_denominations",
    // 004: literal inventory search, used by both database engines.
    "function|search_products_literal(p_query text, p_limit integer, p_offset integer)",
    // 005: whole-peso COP guards (additive; legacy numeric rows stay intact).
    "function|assert_cop_whole_peso()",
    "function|assert_cop_whole_peso_settings()",
    "trigger|cash_denominations.trg_cop_whole_peso",
    "trigger|cash_registers.trg_cop_whole_peso",
    "trigger|cash_shift_counts.trg_cop_whole_peso",
    "trigger|cash_shift_recounts.trg_cop_whole_peso",
    "trigger|cash_shifts.trg_cop_whole_peso",
    "trigger|commission_payouts.trg_cop_whole_peso",
    "trigger|commission_rules.trg_cop_whole_peso",
    "trigger|employees.trg_cop_whole_peso",
    "trigger|invoice_items.trg_cop_whole_peso",
    "trigger|invoice_payments.trg_cop_whole_peso",
    "trigger|invoices.trg_cop_whole_peso",
    "trigger|payments.trg_cop_whole_peso",
    "trigger|payroll_discount_carries.trg_cop_whole_peso",
    "trigger|payroll_extras.trg_cop_whole_peso",
    "trigger|payroll_items.trg_cop_whole_peso",
    "trigger|payroll_payments.trg_cop_whole_peso",
    "trigger|payroll_period_correction_items.trg_cop_whole_peso",
    "trigger|products.trg_cop_whole_peso",
    "trigger|services.trg_cop_whole_peso",
    "trigger|system_settings.trg_cop_whole_peso_settings",
    "trigger|voucher_requests.trg_cop_whole_peso",
    "trigger|voucher_settings.trg_cop_whole_peso",
    // 006: immutable singleton owner and superadmin guard.
    "function|assert_installation_owner_operator()",
    "function|assert_installation_owner_immutable()",
    "function|assert_superadmin_owner()",
    "function|provision_installation_owner(p_owner_user_id uuid)",
    "function|break_glass_transfer_installation_owner(p_new_owner_user_id uuid, p_reason text)",
    "trigger|installation_owner.trg_installation_owner_immutable",
    "trigger|user_roles.trg_superadmin_owner",
    "constraint|installation_owner.installation_owner_pkey|p",
    "constraint|installation_owner.installation_owner_singleton_check|c",
    "constraint|installation_owner.installation_owner_owner_user_id_key|u",
    "constraint|installation_owner.installation_owner_owner_user_id_fkey|f",
    "index|installation_owner.installation_owner_pkey",
    "index|installation_owner.installation_owner_owner_user_id_key",
  ]),
  onlyInProduction: new Set(["constraint|payment_methods.payment_methods_code_check|c"]),
};
const report: string[] = [];
const log = (line = ""): void => {
  report.push(line);
  console.log(line);
};
let failures = 0;
const fail = (line: string): void => {
  failures += 1;
  log(`  FALLO ${line}`);
};

log("VERIFICACION DE RESTAURACION EN PGLITE");
log(`carpeta: ${dir}`);
log(`fecha: ${new Date().toISOString()}`);

// 1. Checksums of every file listed in SHA256SUMS.txt (read-only).
log("");
log("== 1. Integridad (SHA256SUMS.txt) ==");
for (const line of read("SHA256SUMS.txt").split("\n").filter(Boolean)) {
  const [expected, file] = line.trim().split(/\s+\*?/);
  if (!file || !existsSync(join(dir, file))) {
    fail(`${file ?? line}: listado en SHA256SUMS.txt pero no existe en la carpeta`);
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
  if (actual === expected) log(`  OK    ${file}`);
  else fail(`${file}: esperado ${expected}, calculado ${actual}`);
}

// 2. The backup predates 003: build its compatible 001+002 shape first, load
// its rows, then apply 003 as the migration backfill. That is the production
// order; applying 003 before COPY would make the new NOT NULL column reject the
// old dump. No backup input is modified.
const started = Date.now();
const legacyMigrationPaths = [SCHEMA_PATH, PORTABLE_PATH];
const laterMigrationPaths = MIGRATION_PATHS.filter((path) => !legacyMigrationPaths.includes(path));
const db: Db = await buildSchemaDb({ catalog: false, migrations: legacyMigrationPaths });
const version = (await db.query<{ v: string }>("SELECT version() AS v")).rows[0].v;
log("");
log("== 2. Esquema ==");
log(`  motor: ${version}`);
// Optional: only informative, the comparison does not depend on it.
log(
  `  produccion: ${
    existsSync(join(dir, "prod-version.txt"))
      ? read("prod-version.txt").split("\n")[0] || "(prod-version.txt vacio)"
      : "(sin prod-version.txt: version de produccion no registrada)"
  }`,
);
log(
  `  supabase/bootstrap/platform-roles.sql + ${MIGRATION_PATHS.map((path) => path.split(/[\\/]/).pop()).join(" + ")} aplicados literales (tests/db/harness.ts), sin esquema auth`,
);
const sedeFnDef = (
  await db.query<{ d: string }>(`SELECT pg_get_functiondef('public.current_sede_id()'::regprocedure) AS d`)
).rows[0].d;
log(
  `  diferencia ESPERADA con produccion: current_sede_id() del repo lee request.jwt.claims directo (002); ` +
    `produccion la tiene con auth.jwt() (001) hasta que se aplique 002. Mismo resultado, distinto cuerpo. ` +
    `El inventario del paso 6 compara firmas y no la ve.`,
);
if (/\bauth\./.test(sedeFnDef)) fail("current_sede_id() del repo todavia referencia auth.* despues de 002");

// 3. Data load. psql meta-commands `\restrict`/`\unrestrict` are not SQL and are
// skipped; COPY ... FROM stdin blocks are fed through PGlite's /dev/blob.
// session_replication_role = replica is what `pg_restore --disable-triggers`
// does: the dump already holds the RESULT of every trigger (e.g. products.stock_qty),
// so re-firing them would double-apply. FKs are checked explicitly in step 4.
async function loadData(sql: string): Promise<number> {
  let buffer: string[] = [];
  let copies = 0;
  const flush = async (): Promise<void> => {
    if (buffer.join("").trim()) await db.exec(buffer.join("\n"));
    buffer = [];
  };
  const lines = sql.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\\(un)?restrict /.test(line)) continue;
    if (line.startsWith("\\")) throw new Error(`unexpected psql meta-command at line ${index + 1}: ${line}`);
    const copy = /^(COPY .+) FROM stdin;$/.exec(line);
    if (!copy) {
      buffer.push(line);
      continue;
    }
    await flush();
    const rows: string[] = [];
    for (index += 1; lines[index] !== "\\."; index += 1) {
      if (index >= lines.length) throw new Error(`unterminated COPY: ${copy[1]}`);
      rows.push(lines[index]);
    }
    if (rows.length > 0) {
      await db.query(`${copy[1]} FROM '/dev/blob'`, [], { blob: new Blob([rows.join("\n") + "\n"]) });
    }
    copies += 1;
  }
  await flush();
  return copies;
}

await db.exec("BEGIN; SET session_replication_role = replica;");
const copies = await loadData(read("prod-public-data.sql"));
await db.exec("SET session_replication_role = origin; COMMIT;");
await db.exec("SELECT pg_catalog.set_config('search_path', 'public', false);");
log("");
log("== 3. Carga de datos ==");
log(`  ${copies} bloques COPY cargados en una transaccion (triggers y FK diferidos como --disable-triggers)`);

// 3b. Later migrations over the restored data, the way production applies them.
for (const path of laterMigrationPaths) await applyFile(db, path);
const methodModes = (
  await db.query<{ code: string; arqueable: boolean; arqueo_mode: string }>(
    `SELECT code, arqueable, arqueo_mode FROM public.payment_methods ORDER BY code`,
  )
).rows;
log("");
log("== 3b. Migraciones posteriores sobre los datos restaurados ==");
log(`  aplicadas: ${laterMigrationPaths.map((path) => path.split(/[\\/]/).pop()).join(", ") || "(ninguna)"}`);
for (const row of methodModes) log(`  backfill 003: ${row.code.padEnd(22)} arqueable=${row.arqueable} arqueo_mode=${row.arqueo_mode}`);
const incoherent = methodModes.filter((row) => row.arqueable !== (row.arqueo_mode !== "none"));
if (incoherent.length > 0) fail(`backfill 003 incoherente: ${incoherent.map((row) => row.code).join(", ")}`);
const openShifts = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.cash_shifts WHERE status = 'abierto'`)).rows[0].n;
log(
  `  turnos abiertos sin base por metodo: ${openShifts}. Regla segura de 003: sus comisiones y vales por metodos ` +
    `arqueables se rechazan (CASH_METHOD_BALANCE_REQUIRED) hasta cerrarlos y abrir uno nuevo; no se reconstruyen.`,
);

// 4. Every foreign key holds on the restored data.
log("");
log("== 4. Integridad referencial ==");
const fks = await db.query<{ name: string; child: string; parent: string; ccols: string[]; pcols: string[] }>(`
  SELECT c.conname AS name, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
         array(SELECT quote_ident(a.attname) FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS ccols,
         array(SELECT quote_ident(a.attname) FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS pcols
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE c.contype = 'f' AND n.nspname = 'public' ORDER BY 1`);
let fkViolations = 0;
for (const fk of fks.rows) {
  const notNull = fk.ccols.map((col) => `c.${col} IS NOT NULL`).join(" AND ");
  const match = fk.ccols.map((col, i) => `p.${fk.pcols[i]} = c.${col}`).join(" AND ");
  const bad = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${fk.child} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${match})`,
    )
  ).rows[0].n;
  if (bad > 0) {
    fkViolations += bad;
    fail(`${fk.child}.${fk.name}: ${bad} filas huerfanas`);
  }
}
if (fkViolations === 0) log(`  OK    ${fks.rows.length} llaves foraneas, 0 filas huerfanas`);

// 5. Exact row count per table.
log("");
log("== 5. Conteo de filas por tabla (prod-conteos.txt vs restaurado) ==");
const expectedCounts = new Map(
  read("prod-conteos.txt")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [table, n] = line.split("|");
      return [table, Number(n)] as const;
    }),
);
const tables = (
  await db.query<{ t: string }>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  )
).rows.map((row) => row.t);
for (const table of [...new Set([...expectedCounts.keys(), ...tables])].sort()) {
  const expected = expectedCounts.get(table);
  const actual = tables.includes(table)
    ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n
    : undefined;
  const label = `${table.padEnd(34)} prod=${String(expected ?? "-").padStart(4)} restaurado=${String(actual ?? "-").padStart(4)}`;
  if (expected !== undefined && expected === actual) log(`  OK    ${label}`);
  // A table that only 003 creates: empty after the migration (no shift is
  // reconstructed). Any row would be a failure.
  else if (expected === undefined && EXPECTED_LATER.tables.has(table) && actual === 0) log(`  ESPERADA (migracion posterior, aun no en produccion) ${label}`);
  else fail(label);
}

// 6. Catalog inventory, same line format as prod-catalogo.txt.
const INVENTORY_SQL = `
  SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS line,
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS ext
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'trigger|' || c.relname || '.' || t.tgname, false
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'constraint|' || c.relname || '.' || k.conname || '|' || k.contype::text, false
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND k.contype <> 'n'
  UNION ALL
  SELECT 'index|' || tablename || '.' || indexname, false FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy|' || tablename || '.' || policyname, false FROM pg_policies WHERE schemaname = 'public'`;
const inventory = (await db.query<{ line: string; ext: boolean }>(INVENTORY_SQL)).rows;
const localAll = new Set(inventory.map((row) => row.line));
const localExtension = new Set(inventory.filter((row) => row.ext).map((row) => row.line));
const prodLines = read("prod-catalogo.txt").split("\n").filter((line) => line && !line.startsWith("summary|"));
const prodSummary = new Map(
  read("prod-catalogo.txt")
    .split("\n")
    .filter((line) => line.startsWith("summary|"))
    .map((line) => {
      const [, kind, n] = line.split("|");
      return [kind, Number(n)] as const;
    }),
);
const extVersion = (await db.query<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'btree_gist'`)).rows[0].v;

log("");
log("== 6. Inventario del catalogo (prod-catalogo.txt vs 001 + 002 aplicados) ==");
const notNullRows = (
  await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace s ON s.oid = k.connamespace WHERE s.nspname = 'public' AND k.contype = 'n'`,
  )
).rows[0].n;
log(`  btree_gist local ${extVersion}; produccion 1.7 (prod-plataforma.txt). Funciones de extension excluidas por pg_depend deptype='e' del lado local; del lado de produccion se excluyen las mismas firmas.`);
const extLocations = (
  await db.query<{ e: string }>(
    `SELECT string_agg(e.extname || '@' || n.nspname, ', ' ORDER BY e.extname) AS e FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql'`,
  )
).rows[0].e;
log(`  extensiones locales: ${extLocations}. En produccion pgcrypto vive en extensions (prod-plataforma.txt); en PostgreSQL limpio 001 la crea en public. El esquema no la usa: solo cambia el total de funciones de extension.`);
log(`  PostgreSQL 18 registra los NOT NULL de columna en pg_constraint (contype 'n'); PostgreSQL 17 no. Se excluyen de la comparacion: ${notNullRows} filas 'n' locales, artefacto de version y no de esquema.`);
for (const kind of ["function", "trigger", "constraint", "index", "policy"]) {
  const isKind = (line: string): boolean => line.startsWith(`${kind}|`);
  const prodOwn = new Set(prodLines.filter(isKind).filter((line) => !localExtension.has(line)));
  const localOwn = new Set([...localAll].filter(isKind).filter((line) => !localExtension.has(line)));
  const missingAll = [...prodOwn].filter((line) => !localOwn.has(line)).sort();
  const extraAll = [...localOwn].filter((line) => !prodOwn.has(line)).sort();
  const expectedMissing = missingAll.filter((line) => EXPECTED_LATER.onlyInProduction.has(line));
  const expectedExtra = extraAll.filter((line) => EXPECTED_LATER.onlyInRepo.has(line));
  const missing = missingAll.filter((line) => !EXPECTED_LATER.onlyInProduction.has(line));
  const extra = extraAll.filter((line) => !EXPECTED_LATER.onlyInRepo.has(line));
  for (const line of expectedMissing) log(`        ESPERADA (003 la borra, produccion la conserva hasta aplicar 003): ${line}`);
  for (const line of expectedExtra) log(`        ESPERADA (migracion posterior, aun no en produccion): ${line}`);
  const prodTotal = prodLines.filter(isKind).length;
  const localTotal = [...localAll].filter(isKind).length;
  const summaryKey = kind === "index" ? "indexes" : kind === "policy" ? "policies" : `${kind}s`;
  const label = `${kind.padEnd(10)} propios prod=${prodOwn.size} repo=${localOwn.size} | totales prod=${prodTotal} (summary ${prodSummary.get(summaryKey) ?? "-"}) repo=${localTotal}`;
  if (missing.length === 0 && extra.length === 0) log(`  OK    ${label}`);
  else fail(label);
  for (const line of missing) log(`        solo en produccion: ${line}`);
  for (const line of extra) log(`        solo en el repo:    ${line}`);
  // Only when the own objects match exactly is the remaining gap made of
  // extension functions (the lines excluded on both sides): say so then, never otherwise.
  if (kind === "function" && prodTotal !== localTotal && missing.length === 0 && extra.length === 0 && expectedExtra.length === 0) {
    log(
      `        nota: la diferencia de totales (${prodTotal} vs ${localTotal}) es solo de funciones de extension ` +
        `(prod ${prodTotal - prodOwn.size}, repo ${localTotal - localOwn.size}); las propias coinciden`,
    );
  }
}

await db.close();
log("");
log(`duracion: ${((Date.now() - started) / 1000).toFixed(1)} s`);
log(failures === 0 ? "RESULTADO: OK" : `RESULTADO: ${failures} DIFERENCIA(S)`);

writeFileSync(join(dir, "verificacion-restauracion-pglite.txt"), report.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
