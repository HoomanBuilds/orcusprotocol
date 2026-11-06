import { spawnSync } from "node:child_process";
import { getHealth, getMarkets, engineConfig } from "@orcus/engine";
import type { Venue } from "@orcus/core";
import { entryPoint } from "@orcus/wallets/kernel";

const health = getHealth();
console.log("Orcus configuration and read-only connectivity check");
console.log("No transactions, storage uploads or billable inference are submitted.");
for (const [name, capability] of Object.entries(health)) {
  if (typeof capability !== "object" || !capability) continue;
  console.log(`${name}: ${capability.configured ? "configured" : "not configured"}. ${capability.message}`);
}
console.log(`Worker token: ${process.env.ORCUS_INTERNAL_TOKEN ? "configured" : "missing"}`);
console.log(`Production keystore: ${process.env.ORCUS_MASTER_KEY ? "configured" : "not configured; development-only local key available"}`);
const bundlerUrl = process.env.ZERODEV_RPC_URL?.trim();
console.log(`Smart-account bundler: ${bundlerUrl ? "configured" : "missing"}`);
console.log("Trading scope: Ethereum Sepolia spot and Hyperliquid testnet. No mainnet trading or automatic bridges.");
console.log("Customer funding: trading capital stays separate from agent service costs; backend 0G credits do not pay Ethereum gas.");
console.log("External-wallet deposits: the owner approves the transfer and pays its network fee; smart-account sponsorship does not cover this transfer.");

if (bundlerUrl) {
  try {
    const read = async (method: string) => {
      const response = await fetch(bundlerUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (!response.ok || body.error || !Object.hasOwn(body, "result")) throw new Error("Bundler read failed.");
      return body.result;
    };
    const [chainId, supported] = await Promise.all([read("eth_chainId"), read("eth_supportedEntryPoints")]);
    if (chainId !== "0xaa36a7" || !Array.isArray(supported) || !supported.some(address => typeof address === "string" && address.toLowerCase() === entryPoint.address.toLowerCase())) throw new Error("Bundler network or EntryPoint mismatch.");
    console.log("Bundler reads: Ethereum Sepolia and EntryPoint 0.7 verified. This does not prove funded gas sponsorship or operation acceptance.");
  } catch {
    console.log("Bundler reads: unavailable or incompatible. Check Sepolia and EntryPoint 0.7 in the provider project.");
    process.exitCode = 1;
  }
}

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
