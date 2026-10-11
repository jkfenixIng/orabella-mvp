import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stopCluster } from "./cluster";

const source = (name: string) => readFileSync(join(__dirname, name), "utf8");

describe("real-concurrency harness contract", () => {
  it("refuses to remove a directory without this runner's ownership marker", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "orabella-unmarked-"));
    try {
      await expect(stopCluster({ dataDir, runnerPid: process.pid })).rejects.toThrow("ownership marker");
      expect(existsSync(dataDir)).toBe(true);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("requires exact losers, observed waits, settled timeouts and fail-closed teardown", () => {
    const run = source("run.ts");
    const cluster = source("cluster.ts");
    expect(run).toMatch(/error\.code === "23505"/);
    expect(run).toMatch(/PAYROLL_VOUCHER_CONFLICT/);
    expect(run).toMatch(/await expectWaiting\(o, await backendPid\(b\)\)/);
    expect(run).toMatch(/await recover\(sessions\); await operation\.catch/);
    expect(run).not.toMatch(/stopCluster\(current\)\.catch/);
    expect(cluster).toMatch(/teardown left postmaster/);
    expect(cluster).toMatch(/teardown left PostgreSQL listening/);
    expect(run).toMatch(/process\.once\("unhandledRejection"/);
    expect(run).toMatch(/process\.once\("uncaughtException"/);
    expect(source("preflight.mjs")).toMatch(/Node 22\.18\+ or 23\.6\+/);
    // 005 is applied to the real cluster and smoke-checked there.
    expect(cluster).toContain('"005_cop_whole_peso.sql"');
    expect(run).toMatch(/l\. 005 COP whole-peso smoke/);
    expect(run).toMatch(/COP_WHOLE_PESO_REQUIRED/);
  });
});
