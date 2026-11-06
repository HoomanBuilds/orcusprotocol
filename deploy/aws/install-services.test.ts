import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("deploy/aws/install-services.sh");
let directory: string;
let appDirectory: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orcus-aws-services-"));
  appDirectory = join(directory, "app");
  const binDirectory = join(directory, "bin");
  mkdirSync(appDirectory);
  mkdirSync(binDirectory);
  writeFileSync(join(appDirectory, "package.json"), "{}");
  writeFileSync(join(binDirectory, "id"), '#!/bin/sh\n[ "$1" = -u ] || exit 2\ncase "$2" in orcus) printf "1001\\n" ;; root-alias) printf "0\\n" ;; *) exit 2 ;; esac\n', { mode: 0o700 });
  writeFileSync(join(binDirectory, "getent"), '#!/bin/sh\n[ "$1" = passwd ] && [ "$2" = orcus ] || exit 2\nprintf "%s\\n" "orcus:x:1001:1001::/var/lib/orcus:/bin/bash"\n', { mode: 0o700 });
  env = { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` };
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
}

describe("AWS systemd installer", () => {
  it("has valid Bash syntax and describes its non-starting behavior", () => {
    execFileSync("bash", ["-n", script]);
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("does not start services");
  });

  it("renders both services without requiring or reading an env file or a build", () => {
    const result = run("--dry-run", appDirectory, "orcus");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`WorkingDirectory=${appDirectory}`);
    expect(result.stdout.match(/User=orcus/g)).toHaveLength(2);
    expect(result.stdout.match(/UMask=0077/g)).toHaveLength(2);
    expect(result.stdout).toContain("PATH=/var/lib/orcus/.bun/bin:/var/lib/orcus/.cre/bin:/usr/local/bin:/usr/bin:/bin");
    expect(result.stdout).toContain("npm start -- --hostname 127.0.0.1 --port 3000");
    expect(result.stdout).toContain("ExecStart=/usr/bin/env npm run worker");
    expect(result.stdout).not.toMatch(/@[A-Z_]+@|EnvironmentFile|ORCUS_MASTER_KEY|ORCUS_INTERNAL_TOKEN/);
  });

  it.each(["relative", "/", "/tmp/app path", "/tmp/app%name", "/tmp/app&name"])("rejects unsupported app path %s", (path) => {
    const result = run("--dry-run", path, "orcus");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("absolute app directory");
  });

  it("bounds the web process, its child workflows and the worker on shared hosts", () => {
    const result = run("--dry-run", appDirectory, "orcus");
    expect(result.status).toBe(0);
    const [web, worker] = result.stdout.split("# orcus-worker.service");
    expect(web).toContain("Environment=NODE_OPTIONS=--max-old-space-size=1536");
    expect(web).toContain("MemoryHigh=2048M\nMemoryMax=2560M\nMemorySwapMax=128M\nCPUQuota=80%\nTasksMax=256");
    expect(worker).toContain("Environment=NODE_OPTIONS=--max-old-space-size=256");
    expect(worker).toContain("MemoryHigh=256M\nMemoryMax=512M\nMemorySwapMax=128M\nCPUQuota=20%\nTasksMax=128");
    expect(result.stdout.match(/Restart=on-failure/g)).toHaveLength(2);
  });

  it("rejects a missing directory and a directory without the app manifest", () => {
    expect(run("--dry-run", join(directory, "missing"), "orcus").status).not.toBe(0);
    const result = run("--dry-run", directory, "orcus");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package.json");
  });

  it.each(["root", "root-alias", "missing", "orcus%user", "orcus&user"])("rejects invalid service user %s", (user) => {
    const result = run("--dry-run", appDirectory, user);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects extra arguments without rendering or installing", () => {
    const result = run("--dry-run", appDirectory, "orcus", "extra");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("does not install without a prepared env file", () => {
    const result = run(appDirectory, "orcus");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Run with sudo|Run demo:setup/);
  });
});
