import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "@orcus/core";
import { planWith0G, getComputeBalance } from "./index";
import type { AgentCheckpoint, AgentContext, AgentMemoryNote } from "./types";

const url = "https://inference.unit.test/v1/chat/completions";
const account: TradingAccount = { id: "owned-account", userId: "user-a", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "authorized", controlRevision: 1 };
const proposal = { accountId: account.id, venue: "hyperliquid", type: "reduce", symbol: "ETH", side: "sell", amount: "0.01", slippageBps: 50, mode: "agent", reduceOnly: true };
const final = { type: "final", message: "I checked the available data. No trade has been executed.", requiresClarification: false };

beforeEach(() => {
  vi.stubEnv("ZEROG_COMPUTE_CHAT_URL", url);
  vi.stubEnv("ZEROG_COMPUTE_API_KEY", "unit-test-inference-key");
  vi.stubEnv("ZEROG_COMPUTE_MODEL", "unit-test-model");
  vi.stubEnv("LANGSMITH_TRACING", "false");
  vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function fakeProvider(decisions: unknown[]) {
  let calls = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === url) {
      const decision = decisions[calls] ?? final;
      calls++;
      return Response.json({ id: `unit-provider-response-${calls}`, choices: [{ message: { content: JSON.stringify(decision) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    }
    if (String(input) === "https://api.hyperliquid-testnet.xyz/info") {
      const body = JSON.parse(String(init?.body));
      if (body.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "ETH", szDecimals: 3, maxLeverage: 20 }] }, [{ markPx: "2000", midPx: "2000", prevDayPx: "1900", dayNtlVlm: "10000" }]]);
      if (body.type === "clearinghouseState") return Response.json({ marginSummary: { accountValue: "100", totalMarginUsed: "10", totalNtlPos: "100" }, withdrawable: "90", assetPositions: [{ position: { coin: "ETH", szi: "0.05", entryPx: "1900", unrealizedPnl: "5", liquidationPx: "1000", marginUsed: "10", leverage: { value: 10 } } }] });
      if (body.type === "frontendOpenOrders") return Response.json([]);
      if (body.type === "candleSnapshot") return Response.json(Array.from({ length: 20 }, (_, i) => ({ t: Date.now() - (20 - i) * 3_600_000, o: String(1900 + i), h: String(1901 + i), l: String(1899 + i), c: String(1900 + i), v: "100" })));
    }
    throw new Error(`Unexpected outbound request in unit test: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, modelCalls: () => calls };
}

function personalMemory(threadId: string, content: string) {
  let checkpoint: unknown = null;
  const note: AgentMemoryNote = { id: `note:${threadId}`, kind: "preference", content, importance: 0.5, source: "user", createdAt: 1, updatedAt: 1 };
  return {
    threadId,
    checkpoints: { load: vi.fn(async () => checkpoint), save: vi.fn(async (_thread: string, state: unknown) => { checkpoint = structuredClone(state); }) },
    memoryStore: { search: vi.fn(async () => [note]), remember: vi.fn(async () => note), forget: vi.fn(async () => true) },
    lastCheckpoint: () => checkpoint as AgentCheckpoint,
  };
}

describe("personal LangGraph agent", () => {
  it("performs a bounded multi-tool reasoning loop with real adapter reads and typed proposal evidence", async () => {
    const provider = fakeProvider([{ type: "tool", name: "read_portfolio", arguments: { accountId: account.id } }, { type: "tool", name: "analyze_market", arguments: { venue: "hyperliquid", symbol: "ETH", interval: "1h", limit: 20 } }, { type: "tool", name: "propose_action", arguments: { request: proposal } }, final]);
    const memory = personalMemory("agent:user-a", "Prefers conservative position reductions.");
    const beforeCall = vi.fn(async (_input: { callId: string; maxTokens: number }) => {}), afterCall = vi.fn(async () => {}), onProgress = vi.fn(async (_event: Parameters<NonNullable<AgentContext["onProgress"]>>[0]) => {});
    const reply = await planWith0G("Reduce my ETH position by 0.01 ETH after checking it.", { accounts: [account], account, evaluationId: "run-a", ...memory, modelBudget: { beforeCall, afterCall }, onProgress });
    expect(reply.framework).toBe("langgraph");
    expect(reply.proposal).toMatchObject(proposal);
    expect(reply.modelCalls).toBe(4);
    expect(reply.toolTrace.map(trace => trace.name)).toEqual(["read_portfolio", "analyze_market", "propose_action"]);
    expect(reply.requestId).toBe("unit-provider-response-3");
    expect(reply.requestIds).toHaveLength(4);
    expect(reply.usage?.total_tokens).toBe(480);
    expect(beforeCall.mock.calls.map(([input]) => input.callId)).toEqual(["run-a:model:0", "run-a:model:1", "run-a:model:2", "run-a:model:3"]);
    expect(memory.lastCheckpoint()).toMatchObject({ status: "completed", inferencePending: false, threadId: "agent:user-a" });
    expect(provider.fetch.mock.calls.filter(([input]) => String(input) !== url).every(([input]) => String(input).endsWith("/info"))).toBe(true);
    expect(onProgress.mock.calls.some(([event]) => event.stage === "tool")).toBe(true);
  });
  it("stops an endlessly requested tool loop at the model budget without a proposal", async () => {
    const provider = fakeProvider([{ type: "tool", name: "search_memory", arguments: { query: "preferences" } }]);
    const reply = await planWith0G("Research my preferences.", { maxModelCalls: 1, ...personalMemory("agent:user-a", "Prefers spot.") });
    expect(provider.modelCalls()).toBe(1);
    expect(reply.message).toContain("budget");
    expect(reply.proposal).toBeUndefined();
  });
  it("isolates recalled memory across personal threads and rejects a foreign checkpoint", async () => {
    const provider = fakeProvider([final, final]);
    const a = personalMemory("agent:user-a", "UniqueA conservative preference.");
    const b = personalMemory("agent:user-b", "UniqueB spot preference.");
    await planWith0G("What do I prefer?", { ...a, evaluationId: "run-a" });
    await planWith0G("What do I prefer?", { ...b, evaluationId: "run-b" });
    const requests = provider.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(JSON.stringify(requests[0])).toContain("UniqueA");
    expect(JSON.stringify(requests[1])).not.toContain("UniqueA");
    await expect(planWith0G("What do I prefer?", { ...b, checkpoints: { load: async () => a.lastCheckpoint(), save: async () => {} } })).rejects.toMatchObject({ code: "MEMORY_SCOPE_MISMATCH" });
  });
  it("reuses a completed run checkpoint without repeating provider charges", async () => {
    const provider = fakeProvider([final]);
    const context: AgentContext = { ...personalMemory("agent:user-a", "Prefers clarity."), evaluationId: "run-a" };
    const first = await planWith0G("Explain spot trading.", context);
    const second = await planWith0G("Explain spot trading.", context);
    expect(second).toEqual(first);
    expect(provider.modelCalls()).toBe(1);
  });
  it("does not replay a model step with unknown billable outcome", async () => {
    const provider = fakeProvider([final]);
    const message = "Explain spot trading.", memory = personalMemory("agent:user-a", "Prefers clarity.");
    await planWith0G(message, { ...memory, evaluationId: "run-a" });
    const checkpoint = { ...memory.lastCheckpoint(), status: "running", inferencePending: true, messageDigest: createHash("sha256").update(message).digest("hex") };
    await expect(planWith0G(message, { ...memory, evaluationId: "run-a", checkpoints: { load: async () => checkpoint, save: async () => {} } })).rejects.toMatchObject({ code: "INFERENCE_OUTCOME_UNKNOWN" });
    expect(provider.modelCalls()).toBe(1);
  });
  it("keeps private-only requests closed before memory or inference access", async () => {
    const provider = fakeProvider([final]), memory = personalMemory("agent:user-a", "Private preference.");
    await expect(planWith0G("Analyze ETH.", { ...memory, requirePrivate: true })).rejects.toMatchObject({ code: "PRIVATE_INFERENCE_UNVERIFIED" });
    expect(provider.modelCalls()).toBe(0);
    expect(memory.checkpoints.load).not.toHaveBeenCalled();
  });
  it("requires an explicit user request before writing long-term preferences", async () => {
    fakeProvider([{ type: "tool", name: "remember_preference", arguments: { content: "Prefers high leverage.", sourceQuote: "Analyze ETH.", kind: "preference", importance: 0.5 } }, final]);
    const memory = personalMemory("agent:user-a", "Prefers clarity.");
    const reply = await planWith0G("Analyze ETH.", memory);
    expect(memory.memoryStore.remember).not.toHaveBeenCalled();
    expect(reply.toolTrace[0].ok).toBe(false);
  });
});

describe("0G Router management balance", () => {
  it("uses the management key and reports exact neuron and 0G units", async () => {
    vi.stubEnv("ZEROG_COMPUTE_MANAGEMENT_KEY", "unit-test-management-key");
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ address: account.address, deposit_balance: "1000000000000000000", total_balance: "2500000000000000000" }));
    vi.stubGlobal("fetch", fetch);
    expect(await getComputeBalance()).toMatchObject({ status: "verified", balance: "2.5", balanceNeurons: "2500000000000000000", unit: "0G", source: "0g-router", accountAddress: account.address });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://router-api.0g.ai/v1/account/balance");
  });
});
