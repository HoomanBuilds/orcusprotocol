import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

if (!process.argv.includes("--allow-paid-inference")) throw new Error("This check spends real compute credits. Run with --allow-paid-inference to consent.");
const origin = process.env.ORCUS_VERIFY_APP_URL ?? "http://localhost:3000";
const target = new URL(origin);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.protocol !== "http:" || target.pathname !== "/" || target.username || target.password || target.search || target.hash) throw new Error("Use a local HTTP application origin for this generated, unfunded test owner.");
const owner = privateKeyToAccount(generatePrivateKey());
let cookie = "";

async function request(path: string, body?: unknown) {
  const response = await fetch(`${origin}/api/${path}`, { method: body ? "POST" : "GET", headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000), redirect: "error" });
  const next = response.headers.get("set-cookie");
  if (next) cookie = next.split(";")[0];
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? "Application check failed"}`);
  return result.data;
}

const challenge = await request("auth/challenge", { address: owner.address });
await request("auth/verify", { challengeId: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
try {
  await request("budget", { limitUsd: "0.05" });
  const privateMode = process.argv.includes("--gateway-reported-private");
  await request("agent/control", { command: "update", privateInferenceRequired: privateMode, ...(privateMode ? { privateVerification: "gateway-reported" } : {}) });
  const reply = await request("agent/chat", { requestId: `compute-check:${randomUUID()}`, message: "Remember: I prefer spot trading without leverage. Save this preference, then explain it briefly. Do not propose or execute a trade." });
  assert.ok(reply.requestId);
  assert.ok(reply.requestIds?.length > 0);
  assert.ok(reply.modelCalls > 0 && reply.modelCalls <= 4);
  assert.equal(reply.message.actionId, undefined);
  assert.equal(reply.message.proposedAction, undefined);
  if (privateMode) assert.equal(reply.message.privacy, "gateway-reported-private");
  const memory = await request("memory?query=leverage");
  assert.ok(memory.notes.length > 0);
  const budget = await request("budget");
  assert.equal(budget.reservedUsd, "0.000000");
  assert.ok(budget.expenses.length > 0 && budget.expenses.every((expense: { status: string }) => expense.status === "settled"));
  console.log(JSON.stringify({ status: "passed", requestIds: reply.requestIds, modelCalls: reply.modelCalls, privacy: reply.message.privacy, recalledPreferences: memory.notes.length, spentUsdEquivalent: budget.spentUsd, publicChainWrites: 0, deployment: false }, null, 2));
} finally {
  await request("auth/logout", {});
}
