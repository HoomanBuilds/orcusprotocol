import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inferencePreviewEnvironment } from "./lib/inference-preview.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [runtimePath, mode] = process.argv.slice(2);
try {
  if (!runtimePath || mode && mode !== "--check") throw new Error("Usage: node scripts/start-inference-preview.mjs /absolute/runtime.env [--check]");
  if (readdirSync(resolve(root, "web")).some(name => /^\.env(?:\.|$)/.test(name))) throw new Error("Remove web/.env files from the isolated preview checkout before launching.");
  const environment = inferencePreviewEnvironment(parseEnv(readFileSync(resolve(root, ".env"), "utf8")), parseEnv(readFileSync(resolve(runtimePath), "utf8")), process.env);
  if (resolve(environment.ORCUS_DATA_DIR).startsWith(root)) throw new Error("The evaluation data directory must be outside the checkout.");
  if (mode === "--check") console.log(JSON.stringify({ status: "configured", origin: environment.ORCUS_APP_URL, projectDailyCapUsd: "0.05", importedComputeNames: Object.keys(environment).filter(name => name.startsWith("ZEROG_COMPUTE_")), worker: false, storage: false, cre: false }));
  else {
    const child = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "start", resolve(root, "web"), "--hostname", "127.0.0.1", "--port", "3132"], { cwd: root, env: environment, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => { console.error("The isolated inference preview could not start."); process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(error instanceof Error && !error.message.includes("ENOENT") ? error.message : "Cannot read isolated preview configuration. Check paths privately.");
  process.exitCode = 1;
}
