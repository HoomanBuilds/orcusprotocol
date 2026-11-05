import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(resolve(".env"));
const [command, ...flags] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Use dev, build or start.");
if (command === "dev" && !process.env.ORCUS_APP_URL) {
  const portFlag = flags.findIndex(flag => flag === "--port" || flag === "-p");
  const port = portFlag >= 0 ? flags[portFlag + 1] : process.env.PORT ?? "3000";
  process.env.ORCUS_APP_URL = `http://localhost:${port}`;
}
process.argv = [process.execPath, resolve("node_modules/next/dist/bin/next"), command, resolve("web"), ...(command === "build" ? [] : ["--hostname", "0.0.0.0"]), ...flags];
await import("next/dist/bin/next");
