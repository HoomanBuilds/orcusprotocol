import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { creChildEnvironment } from "../../agent/src/automation/cre.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const marker = "ORCUS_CRE_LOCAL_RESULT=";

export function localResultLine(stdout) {
  const lines = stdout.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).filter(line => line.includes(marker));
  if (lines.length !== 1) throw new Error("Expected one local simulation result.");
  const line = lines[0].slice(lines[0].indexOf(marker)).trim();
  if (Buffer.byteLength(line) > 1024) throw new Error("Local simulation result is too large.");
  const payload = line.slice(marker.length);
  const result = JSON.parse(payload);
  if (payload !== JSON.stringify(result)) throw new Error("Noncanonical local simulation result.");
  const expectedKeys = ["changed", "currentPrice", "mode", "previousPrice", "wouldWrite"];
  const price = /^(?:0|[1-9]\d{0,59})(?:\.\d{1,8})?$/;
  if (!result || Object.keys(result).sort().join() !== expectedKeys.join() || result.mode !== "local-simulation" || result.wouldWrite !== false || typeof result.changed !== "boolean" || typeof result.currentPrice !== "string" || !price.test(result.currentPrice) || typeof result.previousPrice !== "string" || !price.test(result.previousPrice)) {
    throw new Error("Invalid local simulation result.");
  }
  return line;
}

export function checkCre(root = projectRoot, run = execFileSync) {
  let directory;
  let stage = "configuration";
  try {
    loadEnvFile(join(root, ".env"));
    const cli = process.env.CRE_CLI_PATH || "cre";
    const env = creChildEnvironment();
    directory = mkdtempSync(join(tmpdir(), "orcus-cre-check-"));
    const envPath = join(directory, ".env");
    const publicEnvPath = join(directory, ".env.public");
    writeFileSync(envPath, "", { mode: 0o600, flag: "wx" });
    writeFileSync(publicEnvPath, "", { mode: 0o600, flag: "wx" });
    const flags = ["--env", envPath, "--public-env", publicEnvPath, "--non-interactive"];
    const options = { cwd: join(root, "workflows", "cre"), env, encoding: "utf8", maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] };
    stage = "authentication";
    run(cli, ["whoami", ...flags], { ...options, timeout: 10_000 });
    stage = "local simulation";
    const stdout = run(cli, ["workflow", "simulate", "strategy", "--target", "local-simulation", "--trigger-index", "0", ...flags], { ...options, timeout: 90_000 });
    return localResultLine(stdout);
  } catch {
    throw new Error(`CRE ${stage} check failed. Raw CLI diagnostics were withheld.`);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("Usage: node --import tsx deploy/aws/check-cre.mjs");
    process.exitCode = 1;
  } else {
    try {
      console.log(checkCre());
    } catch {
      console.error("CRE check failed. Check the root .env, CLI authentication, workflow toolchain and network access privately. No raw CLI diagnostics were printed.");
      process.exitCode = 1;
    }
  }
}
