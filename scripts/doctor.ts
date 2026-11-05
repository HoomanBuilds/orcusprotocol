import { spawnSync } from "node:child_process";
import { getHealth, getMarkets, engineConfig } from "@orcus/engine";
import type { Venue } from "@orcus/core";

const health = getHealth();
console.log("Orcus configuration and read-only connectivity check");
console.log("No transactions, storage uploads or billable inference are submitted.");
for (const [name, capability] of Object.entries(health)) {
  if (typeof capability !== "object" || !capability) continue;
  console.log(`${name}: ${capability.configured ? "configured" : "not configured"}. ${capability.message}`);
}
console.log(`Worker token: ${process.env.ORCUS_INTERNAL_TOKEN ? "configured" : "missing"}`);
console.log(`Production keystore: ${process.env.ORCUS_MASTER_KEY ? "configured" : "not configured; development-only local key available"}`);
console.log(`Smart-account bundler: ${process.env.ZERODEV_RPC_URL ? "configured" : "missing"}`);

await Promise.all((["hyperliquid", "uniswap"] as Venue[]).map(async venue => {
  try {
    const markets = await getMarkets(venue);
    console.log(`${venue} reads: ${markets.length} market(s), real observation received.`);
  } catch {
    console.log(`${venue} reads: unavailable. Check network access, testnet RPC and pool liquidity.`);
    process.exitCode = 1;
  }
}));

const config = engineConfig();
if (config.cre.enabled) {
  const result = spawnSync(config.cre.cliPath, ["version"], { timeout: 10_000, encoding: "utf8" });
  console.log(`CRE binary: ${result.status === 0 ? "available" : "unavailable"}. Login and workflow execution require a separate check.`);
}
