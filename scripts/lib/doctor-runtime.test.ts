import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctorRuntimeConfiguration } from "./doctor-runtime";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("doctor runtime configuration", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "orcus-doctor-runtime-")); directories.push(root);
    const checkout = join(root, "checkout"), workflow = join(checkout, "workflow"); mkdirSync(workflow, { recursive: true });
    return { checkout, environment: { ORCUS_APP_URL: "https://demo.example", ORCUS_INTERNAL_APP_URL: "http://127.0.0.1:3000", ORCUS_DATA_DIR: join(root, "runtime"), ORCUS_MASTER_KEY: "ab".repeat(32), ORCUS_INTERNAL_TOKEN: "unit-test-token-".repeat(3), CRE_ENABLED: "true", CRE_WORKFLOW_DIR: workflow } as NodeJS.ProcessEnv };
  }
  it("accepts essential configuration without requiring optional paid features or exposing secrets", () => {
    const { checkout, environment } = fixture(), checks = doctorRuntimeConfiguration(environment, checkout);
    expect(checks.every(check => check.configured)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(environment.ORCUS_MASTER_KEY);
    expect(JSON.stringify(checks)).not.toContain(environment.ORCUS_INTERNAL_TOKEN);
    expect(checks.every(check => check.message.includes("not a live service readiness check"))).toBe(true);
  });
  it.each(["ORCUS_APP_URL", "ORCUS_DATA_DIR", "ORCUS_MASTER_KEY", "ORCUS_INTERNAL_TOKEN", "CRE_ENABLED", "CRE_WORKFLOW_DIR"])("reports missing required configuration: %s", name => {
    const { checkout, environment } = fixture(); delete environment[name];
    expect(doctorRuntimeConfiguration(environment, checkout).some(check => !check.configured)).toBe(true);
  });
  it("rejects short tokens, relative paths, invalid keys and absent CRE workflows", () => {
    const { checkout, environment } = fixture();
    Object.assign(environment, { ORCUS_DATA_DIR: "relative", ORCUS_MASTER_KEY: "bad", ORCUS_INTERNAL_TOKEN: "short", CRE_WORKFLOW_DIR: "/nonexistent/orcus-workflow" });
    expect(doctorRuntimeConfiguration(environment, checkout).filter(check => !check.configured)).toHaveLength(4);
  });
  it("requires an enabled operator storage payer but never assumes its wallet is funded", () => {
    const { checkout, environment } = fixture();
    Object.assign(environment, { ZEROG_STORAGE_ENABLED: "true", ZEROG_STORAGE_PAYER: "operator" });
    expect(doctorRuntimeConfiguration(environment, checkout).find(check => check.name === "Enabled storage payer")?.configured).toBe(false);
    environment.ZEROG_STORAGE_SPONSOR_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    expect(doctorRuntimeConfiguration(environment, checkout).every(check => check.configured)).toBe(true);
    environment.ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G = "0";
    expect(doctorRuntimeConfiguration(environment, checkout).find(check => check.name === "Enabled storage payer")?.configured).toBe(false);
    environment.ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G = "100000000";
    expect(doctorRuntimeConfiguration(environment, checkout).find(check => check.name === "Enabled storage payer")?.configured).toBe(false);
  });
  it("leaves per-owner agent storage payer authorization to runtime", () => {
    const { checkout, environment } = fixture();
    Object.assign(environment, { ZEROG_STORAGE_ENABLED: "true", ZEROG_STORAGE_PAYER: "agent" });
    expect(doctorRuntimeConfiguration(environment, checkout).every(check => check.configured)).toBe(true);
  });
  it("runs doctor config-only with synthetic credentials, no network and a failing verdict for missing prerequisites", () => {
    const { environment } = fixture();
    const env = { ...environment, ZEROG_COMPUTE_API_KEY: "unit-test-inference-key", ORCUS_GAS_SPONSOR_PROVIDER: "zerodev", ZERODEV_RPC_URL: "https://rpc.zerodev.app/unit-test-bundler", ZERODEV_PAYMASTER_RPC_URL: "https://rpc.zerodev.app/unit-test-paymaster" };
    const source = `process.argv = ["node", "doctor.ts", "--check-config"]; let reads = 0; globalThis.fetch = async () => { reads++; throw new Error("Network forbidden"); }; await import(${JSON.stringify(new URL("../doctor.ts", import.meta.url).href)}); if (reads) process.exitCode = 99; console.log("Synthetic network attempts: " + reads);`;
    const run = (configuration: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: new URL("../../", import.meta.url), env: configuration, encoding: "utf8", timeout: 15_000 });
    const passing = run(env);
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain("Synthetic network attempts: 0");
    expect(passing.stdout).toContain("operation acceptance was verified");
    expect(passing.stdout).not.toContain(environment.ORCUS_MASTER_KEY);
    expect(passing.stdout).not.toContain(env.ZEROG_COMPUTE_API_KEY);
    const failing = run({ ...env, ORCUS_MASTER_KEY: "", ORCUS_INTERNAL_TOKEN: "", ZEROG_COMPUTE_API_KEY: "" });
    expect(failing.status, failing.stderr).toBe(1);
    expect(failing.stdout).toContain("Synthetic network attempts: 0");
    expect(failing.stdout).toContain("missing or invalid");
  }, 15_000);
});
