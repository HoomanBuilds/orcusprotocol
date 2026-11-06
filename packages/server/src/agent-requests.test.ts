import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@orcus/engine/compute";
import { agentRequestLease, storedAgentRequest } from "./agent-requests";
import { getBudget, setBudget } from "./budget";
import { ApiError } from "./errors";
import * as boundary from "./engine";
import { handleRequest } from "./http";
import { Platform } from "./platform";
import { Store } from "./store";
import type { StoredAccount, StoredAgentRequest, StoredMessage, StoredPermission } from "./types";

let directory: string, store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orcus-durable-requests-"));
  vi.stubEnv("ORCUS_DATA_DIR", directory); vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", "disabled");
  vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "1"); vi.stubEnv("ORCUS_COMPUTE_PROJECT_DAILY_USD", "10");
  store = new Store(join(directory, "requests.sqlite"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); if (store.db.open) store.db.close(); rmSync(directory, { recursive: true, force: true }); });
function setup(digit = "1") {
  const user = store.ensureUser(`0x${digit.repeat(40)}`), platform = new Platform(store), account = platform.createAccount(user, { venue: "hyperliquid" });
  setBudget(store, user.id, "1", "0", false);
  return { user, platform, account, input: { message: "Analyze ETH without placing an order", accountId: account.id, requestId: "saved-request", autonomous: false } };
}
function computeFixture(onPlan?: (context: AgentContext) => Promise<void> | void, result: Record<string, unknown> = {}) {
  return vi.spyOn(boundary, "callEngine").mockImplementation(async (name, ...args) => {
    if (name === "getPortfolio") return { balances: [], positions: [], orders: [], observedAt: Date.now() };
    if (name !== "planWith0G") throw new Error(`Unexpected fixture engine call ${name}`);
    const context = args[1] as AgentContext, callId = `${context.evaluationId}:model:0`;
    await context.modelBudget!.beforeCall({ callId, maxTokens: 100 });
    await context.modelBudget!.afterCall({ callId, outcome: "completed", requestId: `fixture-${context.evaluationId}`, billing: { currency: "usd", input_cost: "1", output_cost: "1", total_cost: "2", total_cost_usd_micro: "2" } });
    await onPlan?.(context);
    return { message: "Saved fixture answer, no paid inference or trade", requestId: `fixture-${context.evaluationId}`, ...result };
  });
}

describe("durable owner-scoped agent requests", () => {
  it("persists intake and conversation before acceptance, with no model call or budget charge", () => {
    const { user, platform, input } = setup(), engine = vi.spyOn(boundary, "callEngine");
    const result = platform.enqueueChat(user, input).request;
    expect(result).toMatchObject({ id: input.requestId, requestId: input.requestId, status: "queued", stage: "waiting-for-worker", modelCalls: 0, toolCalls: 0 });
    expect(store.get(user.id, "message", result.userMessageId)).toMatchObject({ role: "user", content: input.message });
    expect(result.expiresAt - result.createdAt).toBe(15 * 60_000);
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.000000" });
    expect(engine).not.toHaveBeenCalled();
  });
  it("restores queued work after database reopen, completes once and discovers the saved answer", async () => {
    const { user, platform, input } = setup(), queued = platform.enqueueChat(user, input).request, engine = computeFixture();
    store.db.close(); store = new Store(join(directory, "requests.sqlite"));
    const restarted = new Platform(store);
    expect(restarted.agentRequests(user).requests[0].status).toBe("queued");
    await restarted.tick();
    const completed = restarted.agentRequest(user, queued.id).request;
    expect(completed).toMatchObject({ status: "completed", modelCalls: 1, response: { content: "Saved fixture answer, no paid inference or trade" } });
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000002", reservedUsd: "0.000000" });
    expect(restarted.enqueueChat(user, input).request.id).toBe(input.requestId);
    store.db.close(); store = new Store(join(directory, "requests.sqlite"));
    await new Platform(store).tick();
    expect(new Platform(store).agentRequest(user, queued.id).request.response?.id).toBe(completed.response?.id);
    expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM expenses").get()).toEqual({ count: 1 });
  });
  it("binds the entire input and isolates identical request IDs across wallets", () => {
    const first = setup("1"), second = setup("2");
    const accepted = first.platform.enqueueChat(first.user, first.input).request;
    expect(first.platform.enqueueChat(first.user, first.input).request.runId).toBe(accepted.runId);
    for (const change of [{ message: "Different instruction" }, { accountId: second.account.id }, { autonomous: true }]) expect(() => first.platform.enqueueChat(first.user, { ...first.input, ...change })).toThrow(/already used/);
    expect(() => second.platform.agentRequest(second.user, accepted.id)).toThrow(/not available/);
    expect(second.platform.agentRequests(second.user).requests).toEqual([]);
    const other = second.platform.enqueueChat(second.user, second.input).request;
    expect(other.runId).not.toBe(accepted.runId);
  });
  it("refuses credentials and foreign accounts before storing work", () => {
    const first = setup("1"), second = setup("2");
    expect(() => first.platform.enqueueChat(first.user, { ...first.input, message: `Use sk-${"fixture".repeat(6)}` })).toThrow(/credentials/);
    expect(() => first.platform.enqueueChat(first.user, { ...first.input, accountId: second.account.id })).toThrow(/Connect this trading account/);
    expect(first.platform.agentRequests(first.user).requests).toEqual([]);
    expect(store.list(first.user.id, "message")).toEqual([]);
  });
  it("bounds pending jobs per owner and across the shared worker", () => {
    const first = setup("1");
    for (let index = 0; index < 5; index++) first.platform.enqueueChat(first.user, { ...first.input, requestId: `request-${index}` });
    expect(() => first.platform.enqueueChat(first.user, { ...first.input, requestId: "sixth" })).toThrow(/queue is full/);
    const template = store.list<StoredAgentRequest>(first.user.id, "agent-request")[0];
    for (let index = 0; index < 95; index++) store.put("agent-request", { ...template, id: `fixture-queued-${index}`, requestId: `fixture-queued-${index}` });
    const second = setup("2");
    expect(() => second.platform.enqueueChat(second.user, second.input)).toThrow(/queue is full/);
  });
  it("does not hide a new completed answer behind fifty older interrupted requests", () => {
    const { user, platform, input } = setup(), accepted = platform.enqueueChat(user, input).request;
    const current = storedAgentRequest(store, user.id, input.requestId)!;
    for (let index = 0; index < 50; index++) store.put("agent-request", { ...current, id: `fixture-old-${index}`, requestId: `old-${index}`, runId: `old-run-${index}`, status: "interrupted", createdAt: current.createdAt - index - 1000 });
    store.update<StoredAgentRequest>(user.id, "agent-request", current.id, { status: "completed" });
    store.put("message", { id: `${accepted.runId}:assistant`, userId: user.id, role: "assistant", content: "Newest completed answer", createdAt: Date.now(), updatedAt: Date.now() } satisfies StoredMessage);
    const listed = platform.agentRequests(user).requests;
    expect(listed).toHaveLength(50);
    expect(listed[0]).toMatchObject({ id: input.requestId, status: "completed", response: { content: "Newest completed answer" } });
  });
  it.each(["mode", "privacy", "account", "permission"])("interrupts changed %s binding before any inference", async change => {
    const { user, platform, account, input } = setup(), engine = computeFixture(); platform.enqueueChat(user, input);
    if (change === "mode") platform.control(user, { command: "update", mode: "autonomous" });
    if (change === "privacy") platform.control(user, { command: "update", privateInferenceRequired: true });
    if (change === "account") store.update<StoredAccount>(user.id, "account", account.id, { controlRevision: 1 });
    if (change === "permission") { const now = Date.now(); store.put("permission", { id: "new-permission", userId: user.id, accountId: account.id, agentAddress: account.agentAddress!, allowedActions: ["market"], allowedSymbols: ["ETH"], maxTradeUsd: "10", status: "active", enforcement: "application", controlRevision: 0, expiresAt: now + 60_000, createdAt: now, updatedAt: now } satisfies StoredPermission); }
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "AGENT_REQUEST_CHANGED" });
    expect(engine).not.toHaveBeenCalled();
    expect(getBudget(store, user.id).reservedUsd).toBe("0.000000");
  });
  it("expires old queued instructions without executing them", async () => {
    const { user, platform, input } = setup(), engine = computeFixture(); platform.enqueueChat(user, input);
    const request = storedAgentRequest(store, user.id, input.requestId)!;
    store.update<StoredAgentRequest>(user.id, "agent-request", request.id, { expiresAt: Date.now() - 1 });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "failed", errorCode: "AGENT_REQUEST_EXPIRED" });
    expect(engine).not.toHaveBeenCalled();
  });
  it("claims at most one request per tick and excludes future queued prompts from reasoning context", async () => {
    const { user, platform, input } = setup();
    platform.enqueueChat(user, input); platform.enqueueChat(user, { ...input, requestId: "future", message: "Future instruction must not enter this request" });
    const engine = computeFixture(context => { expect(JSON.stringify(context.history)).not.toContain("Future instruction"); });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequests(user).requests.filter(request => request.status === "completed")).toHaveLength(1);
    expect(platform.agentRequests(user).requests.filter(request => request.status === "queued")).toHaveLength(1);
    expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
  });
  it("does not reclaim a live lease and marks abandoned work interrupted without replaying it", async () => {
    const { user, platform, input } = setup(), engine = computeFixture(); platform.enqueueChat(user, input);
    const request = storedAgentRequest(store, user.id, input.requestId)!;
    store.update<StoredAgentRequest>(user.id, "agent-request", request.id, { status: "running", claimedBy: "old-worker", startedAt: Date.now() });
    store.takeLease(agentRequestLease(request.id), "old-worker", 180_000);
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request.status).toBe("running");
    store.db.prepare("UPDATE leases SET expires_at=0 WHERE scope=?").run(agentRequestLease(request.id));
    store.db.close(); store = new Store(join(directory, "requests.sqlite"));
    const restarted = new Platform(store); await restarted.tickAgentRequests(() => {});
    expect(restarted.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "AGENT_REQUEST_INTERRUPTED" });
    expect(engine).not.toHaveBeenCalled();
  });
  it("retains unknown billable outcomes across worker and database restart without a duplicate model call", async () => {
    const { user, platform, input } = setup(); platform.enqueueChat(user, input);
    const engine = vi.spyOn(boundary, "callEngine").mockImplementation(async (name, ...args) => {
      if (name === "getPortfolio") return { balances: [], positions: [], orders: [] };
      if (name !== "planWith0G") throw new Error("Unexpected fixture call");
      const context = args[1] as AgentContext, callId = `${context.evaluationId}:model:0`;
      await context.modelBudget!.beforeCall({ callId, maxTokens: 100 });
      await context.modelBudget!.afterCall({ callId, outcome: "unknown", requestId: "fixture-unknown-request" });
      throw new ApiError("INFERENCE_OUTCOME_UNKNOWN", "fixture private provider diagnostics", 504);
    });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "INFERENCE_OUTCOME_UNKNOWN" });
    expect(JSON.stringify(platform.agentRequests(user))).not.toContain("private provider diagnostics");
    store.db.close(); store = new Store(join(directory, "requests.sqlite"));
    const restarted = new Platform(store); restarted.enqueueChat(user, input); await restarted.tickAgentRequests(() => {});
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.010000" });
    expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
    await expect(restarted.chat(user, input)).rejects.toMatchObject({ code: "AGENT_REQUEST_EXISTS" });
  });
  it("keeps a saved answer and linked action discoverable after interruption instead of submitting again", async () => {
    const { user, platform, input } = setup(), engine = computeFixture(); const queued = platform.enqueueChat(user, input).request;
    const request = storedAgentRequest(store, user.id, input.requestId)!, now = Date.now();
    store.put("message", { id: `${queued.runId}:assistant`, userId: user.id, role: "assistant", content: "Saved answer before process exit", actionId: "pending-action", createdAt: now, updatedAt: now } satisfies StoredMessage);
    store.update<StoredAgentRequest>(user.id, "agent-request", request.id, { status: "running", claimedBy: "gone", startedAt: now });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", actionId: "pending-action", response: { content: "Saved answer before process exit" } });
    expect(engine).not.toHaveBeenCalled();
  });
  it("serializes worker ticks while one queued request is in flight", async () => {
    const { user, platform, input } = setup(); platform.enqueueChat(user, input);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const engine = computeFixture(async () => { await gate; });
    const first = platform.tick();
    try {
      await vi.waitFor(() => expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1));
      expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "running", modelCalls: 1 });
      expect(await platform.tick()).toMatchObject({ busy: true, processed: 0 });
      expect(platform.enqueueChat(user, input).request.status).toBe("running");
    } finally { release(); await first; }
    expect(platform.agentRequest(user, input.requestId).request.status).toBe("completed");
    expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
  });
  it("marks a later unknown model-step bill interrupted even after the first call settled", async () => {
    const { user, platform, input } = setup(); platform.enqueueChat(user, input);
    const engine = computeFixture(async context => {
      const callId = `${context.evaluationId}:model:1`;
      await context.modelBudget!.beforeCall({ callId, maxTokens: 100 });
      await context.modelBudget!.afterCall({ callId, outcome: "unknown", requestId: "fixture-later-unknown" });
      throw new ApiError("INFERENCE_REJECTED", "private provider error", 502);
    });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "INFERENCE_REJECTED", modelCalls: 2 });
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000002", reservedUsd: "0.010000" });
    await platform.tickAgentRequests(() => {});
    expect(engine.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
  });
  it("preserves the answer but refuses broader execution when controls change while inference runs", async () => {
    const { user, platform, account, input } = setup(); platform.control(user, { command: "update", mode: "autonomous" }); platform.enqueueChat(user, { ...input, autonomous: true });
    computeFixture(() => { platform.control(user, { command: "take-over" }); }, { proposal: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", mode: "agent" } });
    const submit = vi.spyOn(platform, "submit"), prepare = vi.spyOn(platform, "prepare");
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "AGENT_REQUEST_CHANGED", response: { role: "assistant" } });
    expect(submit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("recovers an answer cached just before conversation persistence without re-running planning", async () => {
    const { user, platform, account, input } = setup(), engine = computeFixture(), now = Date.now();
    const accepted = platform.enqueueChat(user, input).request, request = storedAgentRequest(store, user.id, input.requestId)!;
    store.put("proposal", { id: `proposal:${user.id}:${accepted.runId}`, userId: user.id, result: { message: "Already paid and cached answer", requestId: "fixture-cached-provider-id", proposal: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", mode: "agent" } }, createdAt: now, updatedAt: now });
    store.update<StoredAgentRequest>(user.id, "agent-request", request.id, { status: "running", claimedBy: "gone" });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", response: { content: "Already paid and cached answer", requestId: "fixture-cached-provider-id" } });
    expect(store.get(user.id, "message", `${accepted.runId}:assistant`)).toMatchObject({ role: "assistant", proposedAction: { accountId: account.id, mode: "agent" } });
    expect(engine).not.toHaveBeenCalled();
  });
  it("rechecks privacy and authority before every additional model reservation", async () => {
    const { user, platform, input } = setup(); platform.enqueueChat(user, input);
    computeFixture(async context => {
      platform.control(user, { command: "update", privateInferenceRequired: true });
      await context.modelBudget!.beforeCall({ callId: `${context.evaluationId}:model:1`, maxTokens: 100 });
    });
    await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "interrupted", errorCode: "AGENT_REQUEST_CHANGED", modelCalls: 1 });
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000002", reservedUsd: "0.000000" });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM expenses").get()).toEqual({ count: 1 });
  });
  it("reports low budget without calling a provider and does not retry a failed request", async () => {
    const { user, platform, input } = setup(), engine = computeFixture(); setBudget(store, user.id, "0", "0", false); platform.enqueueChat(user, input);
    await platform.tickAgentRequests(() => {}); await platform.tickAgentRequests(() => {});
    expect(platform.agentRequest(user, input.requestId).request).toMatchObject({ status: "failed", errorCode: "INSUFFICIENT_BUDGET" });
    expect(engine).not.toHaveBeenCalled(); expect(getBudget(store, user.id).reservedUsd).toBe("0.000000");
  });
  it("uses authenticated HTTP intake/list/detail with strict owner and field guards", async () => {
    const first = setup("1"), other = setup("2"), origin = "http://localhost:3125";
    vi.stubEnv("ORCUS_APP_URL", origin);
    const challenge = store.createChallenge(first.user.address, origin), token = store.createSession(challenge.id, first.user.address).token;
    const request = (path: string, body?: unknown, cookie = token) => handleRequest(new Request(`${origin}/api/${path}`, { method: body ? "POST" : "GET", headers: { Origin: origin, Cookie: `orcus_session=${cookie}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), store);
    expect((await request("agent/requests", first.input, "")).status).toBe(401);
    expect((await request("agent/requests", { ...first.input, controlRevision: 123 })).status).toBe(400);
    const accepted = await request("agent/requests", first.input); expect(accepted.status).toBe(202);
    expect((await accepted.json()).data.request.status).toBe("queued");
    const listed = await request("agent/requests"); expect((await listed.json()).data.requests).toHaveLength(1);
    expect((await request(`agent/requests/${first.input.requestId}`)).status).toBe(200);
    const otherChallenge = store.createChallenge(other.user.address, origin), otherToken = store.createSession(otherChallenge.id, other.user.address).token;
    expect((await request(`agent/requests/${first.input.requestId}`, undefined, otherToken)).status).toBe(404);
  });
});
