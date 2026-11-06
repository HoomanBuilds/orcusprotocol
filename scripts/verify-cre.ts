import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { tradeRequestSchema, type TradingAccount } from "@orcus/core";
import { evaluateStrategy } from "../agent/src/automation/cre";
import { Platform } from "../packages/server/src/platform";
import { Store } from "../packages/server/src/store";

const args = process.argv.slice(2), ownerFlag = args.find(argument => argument.startsWith("--account-address=")), workerOnly = args.includes("--worker-only");
if (args.length !== (workerOnly ? 2 : 1) || !ownerFlag) throw new Error("Use --account-address=0x... and optional --worker-only. This verifier never signs or trades.");
const owner = getAddress(ownerFlag.slice("--account-address=".length));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.env.CRE_ENABLED = "true";
process.env.CRE_WORKFLOW_DIR = join(root, "workflows", "cre");
process.env.CRE_TARGET = "staging-settings";
const directory = await mkdtemp(join(tmpdir(), "orcus-cre-verification-"));
process.env.ORCUS_DATA_DIR = directory;
const account: TradingAccount = { id: "read-only-sepolia-observation", userId: "local-verification", address: owner, ownerAddress: owner, venue: "uniswap", chainId: 11155111, status: "connected", controlRevision: 0 };
const request = tradeRequestSchema.parse({ accountId: account.id, venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.000001", nativeInput: true, mode: "agent" });
const cases: Array<{ label: string; expected: "allow" | "reject" | "no-action"; patch?: Record<string, unknown> }> = [
  { label: "native-eth-allow", expected: "allow" },
  { label: "token-balance-reject", expected: "reject", patch: { request: { ...request, nativeInput: false }, proposal: { ...request, nativeInput: false } } },
  { label: "condition-no-action", expected: "no-action", patch: { condition: { operator: "above", price: "999999999", maxAgeSeconds: 120 } } },
  { label: "altered-proposal-reject", expected: "reject", patch: { proposal: { ...request, slippageBps: 500 } } },
];
let store: Store | undefined;
try {
  for (const entry of workerOnly ? [] : cases) {
    const evaluationId = `read-only:${entry.label}:${Date.now()}`;
    const result = await evaluateStrategy({ evaluationId, automationId: entry.label, account, request, proposal: request, controlRevision: 0, policyVersion: 1, expiresAt: Date.now() + 120_000, condition: { operator: "always", maxAgeSeconds: 120 }, ...entry.patch });
    assert.equal(result.decision, entry.expected, entry.label);
    if (entry.label === "native-eth-allow") {
      assert.equal(result.observations?.inputToken, "ETH");
      assert.ok(result.observations?.blockNumber);
      assert.ok(result.observations?.marketSource);
    }
    if (entry.label === "token-balance-reject") assert.equal(result.observations?.inputToken, "0xfff9976782d46cc05630d1f6ebab18b2324d6b14");
    console.log(`Captured CRE result ${entry.label}: ORCUS_CRE_RESULT=${JSON.stringify(result)}`);
  }
  store = new Store(join(directory, "worker.sqlite"));
  const user = store.ensureUser(owner), platform = new Platform(store), observedAccount = platform.createAccount(user, { venue: "hyperliquid" });
  const job = platform.createAutomation(user, { kind: "alert", accountId: observedAccount.id, name: "Read-only ETH alert verification", condition: { symbol: "ETH", operator: "above", price: "1" } });
  const tick = await platform.tick();
  const evaluation = store.list<{ id: string; decision: string; observations?: unknown }>(user.id, "evaluation")[0];
  assert.equal(evaluation?.decision, "allow", JSON.stringify(tick));
  assert.equal(platform.notifications(user).notifications.length, 1);
  assert.equal(store.list(user.id, "action").length, 0);
  const repeated = await platform.tick();
  assert.equal(platform.notifications(user).notifications.length, 1);
  assert.equal(repeated.processed, 0);
  store.db.close();
  store = new Store(join(directory, "worker.sqlite"));
  assert.equal(new Platform(store).notifications(user).notifications.length, 1);
  console.log(JSON.stringify({ scope: "authenticated-cli-read-only", publicNetworkWrites: 0, billableInferenceCalls: 0, simulations: (workerOnly ? 0 : cases.length) + 1, workerConsumption: { automationId: job.id, evaluationId: evaluation.id, notificationCount: 1, actionCount: 0, restartPersisted: true, repeatedTickDuplicated: false }, notProven: ["hosted DON execution", "permissioned venue execution from a CRE result", "private-registry deployment"] }, null, 2));
} finally {
  store?.db.close();
  await rm(directory, { recursive: true, force: true });
}
