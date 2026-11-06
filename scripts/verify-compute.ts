import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyComputeRestartReplay } from "./lib/compute-restart-proof";

if (!process.argv.includes("--allow-paid-inference")) throw new Error("This check spends real compute credits. Run with --allow-paid-inference to consent.");
const target = new URL(process.env.ORCUS_VERIFY_APP_URL ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.protocol !== "http:" || target.pathname !== "/" || target.username || target.password || target.search || target.hash) throw new Error("Use a local HTTP application origin for this generated, unfunded test owner.");
const origin = target.origin;
const owner = privateKeyToAccount(generatePrivateKey());
let cookie = "";
const restartReplay = process.argv.includes("--restart-replay");
if (restartReplay && !process.argv.includes("--extended")) throw new Error("Restart replay requires the extended proof, which exhausts the authorized cap before restart.");

async function request(path: string, body?: unknown, expectedError?: string) {
  const response = await fetch(`${origin}/api/${path}`, { method: body ? "POST" : "GET", headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000), redirect: "error" });
  const next = response.headers.get("set-cookie");
  if (next) cookie = next.split(";")[0];
  const result = await response.json();
  if (expectedError) { assert.equal(result.error?.code, expectedError); assert.equal(response.ok, false); return result.error; }
  if (!response.ok) throw new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? "Application check failed"}`);
  return result.data;
}

const challenge = await request("auth/challenge", { address: owner.address });
await request("auth/verify", { challengeId: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
try {
  await request("budget", { limitUsd: "0.05" });
  const privateMode = process.argv.includes("--gateway-reported-private");
  await request("agent/control", { command: "update", privateInferenceRequired: privateMode, ...(privateMode ? { privateVerification: "gateway-reported" } : {}) });
  const instruction = { requestId: `compute-check:${randomUUID()}`, message: "Remember: I prefer spot trading without leverage. Save this preference, then explain it briefly. Do not propose or execute a trade." };
  const reply = await request("agent/chat", instruction);
  assert.ok(reply.requestId);
  assert.ok(reply.requestIds?.length > 0);
  assert.ok(reply.modelCalls > 0 && reply.modelCalls <= 4);
  assert.equal(reply.message.actionId, undefined);
  assert.equal(reply.message.proposedAction, undefined);
  if (privateMode) assert.equal(reply.message.privacy, "gateway-reported-private");
  const memory = await request("memory?query=leverage");
  assert.ok(memory.notes.length > 0);
  let budget = await request("budget");
  assert.equal(budget.reservedUsd, "0.000000");
  assert.ok(budget.expenses.length > 0 && budget.expenses.every((expense: { status: string }) => expense.status === "settled"));
  const cases: Array<{ name: string; requestIds?: string[]; modelCalls?: number; tools?: string[] }> = [{ name: "memory-write", requestIds: reply.requestIds, modelCalls: reply.modelCalls }];
  if (process.argv.includes("--extended")) {
    const replay = await request("agent/chat", instruction);
    assert.deepEqual(replay.requestIds, reply.requestIds);
    assert.equal((await request("budget")).spentUsd, budget.spentUsd);
    cases.push({ name: "idempotent-replay-no-extra-charge" });
    await request("agent/chat", { ...instruction, message: "Different instruction" }, "IDEMPOTENCY_CONFLICT");
    const account = await request("accounts", { venue: "hyperliquid" });
    const scenarios = [
      { name: "memory-recall", message: "Use search_memory to retrieve my saved preference about leverage, then explain it. Do not trade.", tool: "search_memory" },
      { name: "live-market-read", message: "Use read_markets for ETH on Hyperliquid testnet and summarize that actual observation only. Do not trade or create a proposal.", tool: "read_markets" },
      { name: "live-candle-analysis", message: "Use analyze_market for Hyperliquid ETH, interval 1h and limit 20, then report its RSI14 and SMA20 observations. Do not trade or make a proposal.", tool: "analyze_market" },
      { name: "draft-limit-order", message: "For a preview only, use propose_action to draft a limit buy of 0.001 ETH at 1000 USDC on the selected Hyperliquid account with slippageBps 50. Do not place, authorize or execute it. This account is unfunded and the draft is not executable.", tool: "propose_action" },
      { name: "draft-price-alert", message: "Use propose_automation to draft a price alert when ETH on this Hyperliquid account is below 1000 USDC, checked every 300 seconds. This is an alert only, not a trade. Do not create or activate the job.", tool: "propose_automation" },
    ];
    for (const scenario of scenarios) {
      const result = await request("agent/chat", { message: scenario.message, accountId: account.id, requestId: `compute-check:${randomUUID()}`, autonomous: false });
      assert.ok(result.requestIds?.length);
      assert.equal(result.action, undefined);
      assert.equal(result.message.actionId, undefined);
      assert.ok(result.message.toolSteps?.some((step: { name: string; ok: boolean }) => step.name === scenario.tool && step.ok), `${scenario.name} did not use its real scoped tool successfully`);
      if (privateMode) assert.equal(result.message.privacy, "gateway-reported-private");
      if (scenario.name === "draft-limit-order") { assert.equal(result.proposal.type, "limit"); assert.equal(result.proposal.accountId, account.id); }
      if (scenario.name === "draft-price-alert") { assert.equal(result.automationProposal.kind, "alert"); assert.equal((await request("automations")).automations.length, 0); }
      cases.push({ name: scenario.name, requestIds: result.requestIds, modelCalls: result.modelCalls, tools: result.message.toolSteps.map((step: { name: string }) => step.name) });
      console.log(JSON.stringify({ case: scenario.name, status: "passed", modelCalls: result.modelCalls }));
    }
    budget = await request("budget");
    assert.equal(budget.reservedUsd, "0.000000");
    assert.ok(budget.expenses.every((expense: { status: string }) => expense.status === "settled"));
    await request("agent/chat", { message: "api_key: sk-unit-test-credential-not-a-real-secret", requestId: `compute-check:${randomUUID()}` }, "CREDENTIAL_INPUT_REJECTED");
    assert.equal((await request("budget")).spentUsd, budget.spentUsd);
    await request("budget", { limitUsd: budget.spentUsd });
    await request("agent/chat", { message: "Explain trading", requestId: `compute-check:${randomUUID()}` }, "INSUFFICIENT_BUDGET");
    const exhausted = await request("budget");
    assert.equal(exhausted.spentUsd, budget.spentUsd);
    assert.equal(exhausted.reservedUsd, "0.000000");
    cases.push({ name: "credential-rejection-no-charge" }, { name: "budget-stop-before-inference" });
  }
  if (restartReplay) {
    console.log(JSON.stringify({ phase: "restart-ready", spentUsdEquivalent: budget.spentUsd, instruction: "Restart this same local app with its existing runtime directory, then send one newline. No new owner or paid request is created." }));
    await new Promise<void>(resolve => { process.stdin.once("data", () => resolve()); });
    cases.push(await verifyComputeRestartReplay(request, { instruction, requestIds: reply.requestIds, spentUsd: budget.spentUsd }));
  }
  console.log(JSON.stringify({ status: "passed", cases, privacy: reply.message.privacy, recalledPreferences: memory.notes.length, spentUsdEquivalent: budget.spentUsd, publicChainWrites: 0, deployment: false }, null, 2));
} finally {
  await request("auth/logout", {});
}
