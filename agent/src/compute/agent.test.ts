import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "@orcus/core";
import { planWith0G, getComputeBalance } from "./index";
import type { AgentCheckpoint, AgentContext, AgentMemoryNote } from "./types";
import { buildAgentTools } from "./tools";

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
  it("converts default memory importance to the backend integer scale", async () => {
    fakeProvider([{ type: "tool", name: "remember_preference", arguments: { content: "Use conservative position sizes.", sourceQuote: "use conservative position sizes" } }, final]);
    const memory = personalMemory("agent:user-a", "Use conservative position sizes.");
    const remember = vi.fn(async (input: { content: string; importance?: number }) => {
      if (!Number.isInteger(input.importance) || input.importance! < 0 || input.importance! > 100) throw new Error("importance must be an integer from 0 to 100");
      return { id: "saved", kind: "preference", content: input.content, importance: input.importance!, source: "user", createdAt: 1, updatedAt: 1 };
    });
    const reply = await planWith0G("Remember: use conservative position sizes.", { ...memory, memoryStore: { ...memory.memoryStore, remember } });
    expect(remember).toHaveBeenCalledWith({ content: "Use conservative position sizes.", kind: "preference", importance: 50 });
    expect(reply.toolTrace[0]?.ok).toBe(true);
  });
  it("proposes a typed scheduled trade without executing or creating a job", async () => {
    const scheduled = { kind: "trade", accountId: account.id, name: "Hourly ETH", intervalSeconds: 3600, request: { ...proposal, type: "market", side: "buy", reduceOnly: false } };
    const provider = fakeProvider([{ type: "tool", name: "propose_automation", arguments: { automation: scheduled } }, final]);
    const memory = personalMemory("agent:user-a", "Use conservative amounts.");
    const reply = await planWith0G("Buy 0.01 ETH every hour until my authorization expires.", { account, accounts: [account], ...memory });
    expect(reply.automationProposal).toMatchObject(scheduled);
    expect(reply.automationProposal?.expiresAt).toBeUndefined();
    expect(reply.proposal).toBeUndefined();
    expect(reply.message).toContain("no schedule is active");
    expect(reply.requestId).toBe("unit-provider-response-1");
    expect(memory.lastCheckpoint().automationProposal).toMatchObject(scheduled);
    expect(provider.fetch.mock.calls.every(([input]) => String(input) === url)).toBe(true);
  });
  it("proposes a finite read-only alert without a trade request or native authorization", async () => {
    const alertAccount = { ...account, status: "connected" as const };
    const alert = { kind: "alert", accountId: account.id, name: "ETH below 1800", intervalSeconds: 300, condition: { symbol: "ETH", operator: "below", price: "1800" } };
    fakeProvider([{ type: "tool", name: "propose_automation", arguments: { automation: alert } }, final]);
    const started = Date.now();
    const reply = await planWith0G("Alert me when ETH drops below 1800.", { account: alertAccount, accounts: [alertAccount] });
    expect(reply.automationProposal).toMatchObject(alert);
    expect(reply.automationProposal?.expiresAt).toBeGreaterThanOrEqual(started + 86_400_000);
    expect(reply.automationProposal).not.toHaveProperty("request");
    expect(reply.proposal).toBeUndefined();
  });
  it.each([
    { kind: "trade", accountId: "other-account", name: "Wrong owner", intervalSeconds: 300, request: proposal },
    { kind: "trade", accountId: account.id, name: "Wrong request owner", intervalSeconds: 300, request: { ...proposal, accountId: "other-account" } },
    { kind: "trade", accountId: account.id, name: "Wrong venue", intervalSeconds: 300, request: { ...proposal, venue: "uniswap" } },
    { kind: "trade", accountId: account.id, name: "No typed action", intervalSeconds: 300 },
    { kind: "alert", accountId: account.id, name: "Too frequent", intervalSeconds: 59, condition: { symbol: "ETH", operator: "below", price: "1800" } },
    { kind: "alert", accountId: account.id, name: "Alert cannot trade", intervalSeconds: 300, request: proposal, condition: { symbol: "ETH", operator: "below", price: "1800" } },
    { kind: "alert", accountId: account.id, name: "Expired", intervalSeconds: 300, expiresAt: 1, condition: { symbol: "ETH", operator: "below", price: "1800" } },
    { kind: "alert", accountId: account.id, name: "Too long", intervalSeconds: 300, expiresAt: Date.now() + 31 * 86_400_000, condition: { symbol: "ETH", operator: "below", price: "1800" } },
  ])("rejects unsafe or unbounded automation proposals: $name", async automation => {
    const tool = buildAgentTools({ account, accounts: [account] }, "Schedule an action.").get("propose_automation")!;
    await expect(tool.run({ automation })).rejects.toThrow();
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
  it("does not expose or invoke memory mutations or nested scheduling during an unattended strategy", async () => {
    const provider = fakeProvider([
      { type: "tool", name: "remember_preference", arguments: { content: "Use large trades.", sourceQuote: "use large trades" } },
      { type: "tool", name: "propose_automation", arguments: { automation: { kind: "alert", accountId: account.id, name: "Nested alert", condition: { symbol: "ETH", operator: "above", price: "2000" } } } },
      final,
    ]);
    const memory = personalMemory("agent:user-a", "Use conservative amounts.");
    const reply = await planWith0G("Remember: use large trades and create another strategy.", { ...memory, account, accounts: [account], toolProfile: "strategy" });
    expect(reply.toolTrace).toMatchObject([{ name: "remember_preference", ok: false }, { name: "propose_automation", ok: false }]);
    expect(memory.memoryStore.remember).not.toHaveBeenCalled();
    expect(memory.memoryStore.forget).not.toHaveBeenCalled();
    expect(reply.automationProposal).toBeUndefined();
    expect(reply.proposal).toBeUndefined();
    const body = JSON.parse(String(provider.fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).not.toContain("remember_preference:");
    expect(body.messages[0].content).not.toContain("forget_memory:");
    expect(body.messages[0].content).not.toContain("propose_automation:");
    expect(memory.lastCheckpoint().toolProfile).toBe("strategy");
  });
  it("still permits a validated trade proposal in strategy mode", async () => {
    fakeProvider([{ type: "tool", name: "propose_action", arguments: { request: proposal } }, final]);
    const reply = await planWith0G("Reduce the ETH position by 0.01 ETH.", { account, accounts: [account], toolProfile: "strategy" });
    expect(reply.proposal).toMatchObject(proposal);
    expect(reply.automationProposal).toBeUndefined();
    expect(reply.toolTrace[0]).toMatchObject({ name: "propose_action", ok: true });
  });
  it("rejects an unknown runtime profile before memory access, billing or inference", async () => {
    const provider = fakeProvider([final]), memory = personalMemory("agent:user-a", "Use conservative amounts.");
    const beforeCall = vi.fn(async () => {});
    await expect(planWith0G("Analyze ETH.", { ...memory, modelBudget: { beforeCall, afterCall: async () => {} }, toolProfile: "unknown" })).rejects.toMatchObject({ code: "INVALID_TOOL_PROFILE" });
    expect(provider.modelCalls()).toBe(0);
    expect(beforeCall).not.toHaveBeenCalled();
    expect(memory.checkpoints.load).not.toHaveBeenCalled();
  });
  it("binds completed checkpoint replay to its original tool profile", async () => {
    const provider = fakeProvider([final]), memory = personalMemory("agent:user-a", "Use conservative amounts.");
    const context = { ...memory, evaluationId: "profile-bound-run" };
    await planWith0G("Analyze ETH.", context);
    await expect(planWith0G("Analyze ETH.", { ...context, toolProfile: "strategy" })).rejects.toMatchObject({ code: "RUN_PROFILE_MISMATCH" });
    expect(provider.modelCalls()).toBe(1);
  });
  it("treats legacy checkpoints as interactive but permits a new strategy run", async () => {
    const provider = fakeProvider([final, final]), memory = personalMemory("agent:user-a", "Use conservative amounts.");
    await planWith0G("Analyze ETH.", { ...memory, evaluationId: "legacy-run" });
    const { toolProfile: _profile, ...legacy } = memory.lastCheckpoint();
    const checkpoints = { load: async () => legacy, save: memory.checkpoints.save };
    await expect(planWith0G("Analyze ETH.", { ...memory, checkpoints, evaluationId: "legacy-run", toolProfile: "strategy" })).rejects.toMatchObject({ code: "RUN_PROFILE_MISMATCH" });
    const reply = await planWith0G("Analyze ETH.", { ...memory, checkpoints, evaluationId: "new-strategy-run", toolProfile: "strategy" });
    expect(reply.framework).toBe("langgraph");
    expect(provider.modelCalls()).toBe(2);
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
