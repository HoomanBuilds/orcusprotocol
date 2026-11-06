import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setupDemo } from "./lib/demo-setup";

try {
  const { values } = parseArgs({ options: { "env-file": { type: "string" }, "app-url": { type: "string" }, "data-dir": { type: "string" }, "internal-app-url": { type: "string" }, check: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: npm run demo:setup -- --app-url https://HOST --data-dir /absolute/private/runtime [--env-file PATH] [--internal-app-url http://127.0.0.1:3000] [--check]");
    console.log("Existing credentials are preserved. --check validates existing runtime configuration without writes or network requests.");
  } else {
    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const result = setupDemo({ envFile: resolve(projectRoot, values["env-file"] ?? ".env"), projectRoot, appUrl: values["app-url"], dataDir: values["data-dir"], internalAppUrl: values["internal-app-url"], check: values.check });
    console.log(result.checked ? "Runtime configuration checks passed. No files changed; provider funding and service readiness are not verified." : `Runtime setup complete. Updated settings: ${result.changed.join(", ") || "none"}. Secret values are never printed.`);
    if (!result.checked) console.log("Keep the environment file and runtime directory private and persistent on the same host. Run npm run doctor to check integration configuration and public connectivity.");
  }
} catch (error) {
  console.error(`Demo setup failed: ${error instanceof Error ? error.message : "Check configuration and file permissions."}`);
  process.exitCode = 1;
}
