import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getHealth, getMarkets, engineConfig } from "@orcus/engine";
import type { Venue } from "@orcus/core";
import { entryPoint } from "@orcus/wallets/kernel";
import { sponsorshipSummary } from "../packages/server/src/sponsorship";
import { doctorBundlerConfiguration, doctorOperatorStakeConfiguration } from "./lib/doctor-bundler";
import { doctorRuntimeConfiguration } from "./lib/doctor-runtime";

const checkConfigOnly = process.argv.includes("--check-config");
if (process.argv.slice(2).some(argument => argument !== "--check-config")) throw new Error("Usage: npm run doctor -- [--check-config]");
const health = getHealth();
console.log("Orcus configuration and read-only connectivity check");
console.log("No transactions, storage uploads or billable inference are submitted.");
console.log("Required hackathon configuration:");
for (const check of doctorRuntimeConfiguration(process.env, fileURLToPath(new URL("../", import.meta.url)))) {
  console.log(`${check.name}: ${check.configured ? "configured" : "missing or invalid"}. ${check.message}`);
  if (!check.configured) process.exitCode = 1;
}
for (const [name, capability] of Object.entries(health)) {
  if (typeof capability !== "object" || !capability) continue;
  console.log(`${name} configuration${name === "storage" ? " (optional)" : ""}: ${capability.configured ? "configured" : "not configured"}. ${capability.message}`);
}
if (!health.compute.configured) process.exitCode = 1;
const bundler = doctorBundlerConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: process.env.ORCUS_GAS_SPONSOR_PROVIDER, BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL, ZERODEV_RPC_URL: process.env.ZERODEV_RPC_URL });
const bundlerUrl = bundler.url;
console.log(`Smart-account bundler: ${bundler.status}${bundler.provider ? ` (${bundler.provider})` : ""}`);
if (bundler.status !== "configured") process.exitCode = 1;
const operatorStake = doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: process.env.ORCUS_GAS_SPONSOR_PROVIDER, ORCUS_GAS_SPONSOR_REQUIRE_STAKE: process.env.ORCUS_GAS_SPONSOR_REQUIRE_STAKE, ORCUS_GAS_SPONSOR_MIN_STAKE_WEI: process.env.ORCUS_GAS_SPONSOR_MIN_STAKE_WEI });
console.log(`Operator bundler stake minimum: ${operatorStake}. Configuration only; locked stake and bundler admission are not verified.`);
if (operatorStake === "missing" || operatorStake === "invalid") process.exitCode = 1;
const sponsorship = sponsorshipSummary();
console.log(`Sponsored Uniswap configuration: ${sponsorship.status}. ${sponsorship.message}`);
if (!sponsorship.configured) process.exitCode = 1;
console.log("Optional capabilities: strict TEE verification, 0G Storage, automatic compute top-up and testnet service payments are not launch prerequisites. Real-money payments and mainnet trading remain disabled.");
console.log("Trading scope: Ethereum Sepolia spot and Hyperliquid testnet. No mainnet trading or automatic bridges.");
console.log("Customer funding: trading capital stays separate from agent service costs; backend 0G credits do not pay Ethereum gas.");
console.log("External-wallet deposits: the owner approves the transfer and pays its network fee; smart-account sponsorship does not cover this transfer.");

if (!checkConfigOnly && bundlerUrl) {
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

if (!checkConfigOnly) await Promise.all((["hyperliquid", "uniswap"] as Venue[]).map(async venue => {
  try {
    const markets = await getMarkets(venue);
    console.log(`${venue} reads: ${markets.length} market(s), real observation received.`);
  } catch {
    console.log(`${venue} reads: unavailable. Check network access, testnet RPC and pool liquidity.`);
    process.exitCode = 1;
  }
}));

const config = engineConfig();
if (!checkConfigOnly && config.cre.enabled) {
  const result = spawnSync(config.cre.cliPath, ["version"], { timeout: 10_000, encoding: "utf8" });
  console.log(`CRE binary: ${result.status === 0 ? "available" : "unavailable"}. Login and workflow execution require a separate check.`);
  if (result.status !== 0) process.exitCode = 1;
}
console.log(checkConfigOnly ? "Configuration check only: no connectivity, provider credit, paid inference, funding or operation acceptance was verified." : "Readiness scope: public market and configured bundler reads only. Provider credits, paid inference, storage payer funding and sponsored operation acceptance remain unverified.");
