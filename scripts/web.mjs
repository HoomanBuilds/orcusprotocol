import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(resolve(".env"));
const [command, ...flags] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Use dev, build or start.");
process.argv = [process.execPath, resolve("node_modules/next/dist/bin/next"), command, resolve("web"), ...(command === "build" ? [] : ["--hostname", "0.0.0.0"]), ...flags];
await import("next/dist/bin/next");
