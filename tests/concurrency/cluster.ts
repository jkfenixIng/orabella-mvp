/**
 * Ephemeral PostgreSQL cluster for the real-concurrency suite.
 *
 * It only owns a fresh directory under %LOCALAPPDATA%\Temp\opencode and a
 * random loopback port. It never targets the Windows PostgreSQL service or 5432.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_BIN = process.env.ORABELLA_PG_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin";
const exe = (name: string) => join(PG_BIN, process.platform === "win32" ? `${name}.exe` : name);
const INITDB = exe("initdb");
const PG_CTL = exe("pg_ctl");
const PSQL = exe("psql");
const MARKER = "orabella-concurrency-cluster.json";

export interface Cluster {
  url: string;
  dataDir: string;
  port: number;
  runnerPid: number;
}

function run(command: string, args: string[], quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port && port !== 5432 ? resolve(port) : reject(new Error("no free non-5432 port")));
    });
  });
}

const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
export const SCHEMA_FILES = [
  join(REPO_ROOT, "supabase", "bootstrap", "platform-roles.sql"),
  ...["001_orabella_schema.sql", "002_portable_platform.sql", "003_payment_method_arqueo.sql", "004_inventory_literal_search.sql"].map((name) => join(MIGRATIONS_DIR, name)),
  join(REPO_ROOT, "supabase", "seeds", "catalog.sql"),
  join(REPO_ROOT, "supabase", "bootstrap", "app-role.sql"),
];

export async function startCluster(): Promise<Cluster> {
  for (const binary of [INITDB, PG_CTL, PSQL]) {
    if (!existsSync(binary)) throw new Error(`test:concurrency needs local PostgreSQL binaries; missing ${binary}. Set ORABELLA_PG_BIN.`);
  }
  const root = join(tmpdir(), "opencode");
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(join(root, "orabella-pgtmp-"));
  const port = await freePort();
  const cluster = { dataDir, port, runnerPid: process.pid, url: `postgres://postgres@127.0.0.1:${port}/postgres` };
  try {
    await run(INITDB, ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    writeFileSync(join(dataDir, MARKER), JSON.stringify({ ...cluster, createdAt: new Date().toISOString() }, null, 2));
    await run(PG_CTL, ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", join(dataDir, "server.log"), "-w", "-t", "60", "start"], true);
    for (const file of SCHEMA_FILES) await run(PSQL, [cluster.url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
    return cluster;
  } catch (error) {
    await stopCluster(cluster);
    throw new Error(`test:concurrency could not create its ephemeral PostgreSQL cluster: ${(error as Error).message}`);
  }
}

/** Stops only a directory created by this runner, then removes it even after a failed start. */
export async function stopCluster(cluster: Pick<Cluster, "dataDir" | "runnerPid">): Promise<void> {
  const marker = join(cluster.dataDir, MARKER);
  if (existsSync(marker)) {
    const owner = JSON.parse(readFileSync(marker, "utf8")) as { runnerPid?: number };
    if (owner.runnerPid !== cluster.runnerPid) throw new Error(`refusing to stop cluster not owned by this runner: ${cluster.dataDir}`);
  }
  if (existsSync(join(cluster.dataDir, "postmaster.pid"))) {
    await run(PG_CTL, ["-D", cluster.dataDir, "-m", "fast", "-w", "-t", "60", "stop"], true).catch(() => undefined);
  }
  rmSync(cluster.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (existsSync(cluster.dataDir)) throw new Error(`teardown left ${cluster.dataDir} behind`);
}
