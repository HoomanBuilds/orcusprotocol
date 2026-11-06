import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TradeRequest } from "@orcus/core";
import { AgentRun, agentRunRecordId, readAgentRunStatus } from "./agent-runtime";
import { getBudget, setBudget } from "./budget";
import * as boundary from "./engine";
import { handleRequest } from "./http";
import { Platform } from "./platform";
import { Store } from "./store";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("durable proposal and progress namespaces", () => {
  it("persists typed results separately from progress and reuses them after HTTP retry and database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-proposal-persistence-")), path = join(directory, "platform.sqlite");
    const origin = "http://localhost:3125", owner = privateKeyToAccount(generatePrivateKey());
    vi.stubEnv("ORCUS_DATA_DIR", directory); vi.stubEnv("ORCUS_APP_URL", origin);
    let store = new Store(path), cookie = "";
    const request = async (route: string, body?: unknown) => {
      const response = await handleRequest(new Request(`${origin}/api/${route}`, { method: body ? "POST" : "GET", headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), store);
      return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
    };
    try {
      const challenge = await request("auth/challenge", { address: owner.address });
      const login = await request("auth/verify", { challengeId: challenge.data.data.id, signature: await owner.signMessage({ message: challenge.data.data.message }) });
      cookie = login.cookie!.split(";")[0];
      const user = store.getUser(owner.address)!;
      const account = (await request("accounts", { venue: "hyperliquid" })).data.data;
      setBudget(store, user.id, "1", "0.1", false);
      const proposal: TradeRequest = { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "agent" };
      const compute = vi.spyOn(boundary, "callEngine").mockImplementation(async (name) => {
        if (name === "getPortfolio") return { balances: [], positions: [], orders: [], observedAt: Date.now() };
        if (name === "planWith0G") return { message: "Explicit compute fixture, no paid inference", proposal, requestId: "fixture-provider-request", costUsd: "0.000001" };
        throw new Error(`Unexpected engine call ${name}`);
      });
      const input = { message: "Plan an ETH trade", accountId: account.id, requestId: "durable-request" };
      const first = await request("agent/chat", input);
      expect(first.status).toBe(200);
      const reference = first.data.data.runId as string;
      const progress = store.get(user.id, "agent-run", agentRunRecordId(user.id, reference));
      const cached = store.get(user.id, "proposal", `proposal:${user.id}:${reference}`);
      expect(progress).toMatchObject({ runId: reference, status: "completed" });
      expect(cached).toMatchObject({ reference, result: { proposal, requestId: "fixture-provider-request" } });
      expect(new Platform(store).runStatus(user, input.requestId)).toMatchObject({ id: reference, status: "completed" });
      expect((await request("agent/chat", input)).data.data.proposal).toEqual(proposal);
      store.db.close(); store = new Store(path);
      expect((await request("agent/chat", input)).data.data.proposal).toEqual(proposal);
      expect(compute.mock.calls.filter(([name]) => name === "planWith0G")).toHaveLength(1);
      expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000001", reservedUsd: "0.000000" });
      expect(getBudget(store, user.id).expenses).toHaveLength(1);
    } finally { if (store.db.open) store.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps a strategy's logical evaluation distinct from its planner run, cache and final result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-strategy-proposal-"));
    vi.stubEnv("ORCUS_DATA_DIR", directory);
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"1".repeat(40)}`), reference = "strategy-evaluation", now = Date.now();
      setBudget(store, user.id, "1", "0.1", false);
      const record = { userId: user.id, createdAt: now, updatedAt: now };
      store.put("evaluation-run", { ...record, id: `evaluation-run:${reference}`, evaluationId: reference, status: "running" });
      vi.spyOn(boundary, "callEngine").mockImplementation(async name => {
        if (name === "planWith0G") return { message: "Fixture no-action candidate", costUsd: "0" };
        throw new Error(`Unexpected engine call ${name}`);
      });
      await new Platform(store).proposal(user, "Wait for an explicit ETH condition", undefined, reference, "strategy");
      store.put("evaluation", { ...record, id: reference, decision: "no-action" });
      expect(store.get(user.id, "evaluation", reference)).toMatchObject({ decision: "no-action" });
      expect(store.get(user.id, "evaluation-run", `evaluation-run:${reference}`)).toMatchObject({ status: "running" });
      expect(readAgentRunStatus(store, user.id, reference)).toMatchObject({ status: "completed", runId: reference });
      expect(store.get(user.id, "proposal", `proposal:${user.id}:${reference}`)).toMatchObject({ toolProfile: "strategy" });
    } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reads legacy caches and run status without rebilling or changing the logical run ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-legacy-cache-")); vi.stubEnv("ORCUS_DATA_DIR", directory);
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"2".repeat(40)}`), requestId = "legacy-request", now = Date.now();
      const reference = createHash("sha256").update(`${user.id}|chat|${requestId}`).digest("hex");
      store.put("proposal", { id: "legacy-cache", userId: user.id, result: { message: "Saved legacy result" }, createdAt: now, updatedAt: now });
      store.put("agent-run", { id: reference, userId: user.id, threadId: `agent:${user.id}`, status: "completed", stage: "completed", modelCalls: 1, toolCalls: 0, startedAt: now, createdAt: now, updatedAt: now });
      const compute = vi.spyOn(boundary, "callEngine");
      expect(await new Platform(store).proposal(user, "Read saved result", undefined, "legacy-cache")).toEqual({ message: "Saved legacy result" });
      expect(new Platform(store).runStatus(user, requestId)).toMatchObject({ id: reference, status: "completed", modelCalls: 1 });
      expect(compute).not.toHaveBeenCalled();
    } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("continues legacy progress under its namespaced key and records failure without destroying prior records", () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-legacy-progress-")); vi.stubEnv("ORCUS_DATA_DIR", directory);
    const store = new Store(":memory:"); let run: AgentRun | undefined;
    try {
      const user = store.ensureUser(`0x${"3".repeat(40)}`), now = Date.now(); setBudget(store, user.id, "1", "0.1", false);
      store.put("agent-run", { id: "legacy-run", userId: user.id, threadId: `agent:${user.id}`, status: "running", stage: "tool", modelCalls: 1, toolCalls: 2, startedAt: now - 1000, createdAt: now - 1000, updatedAt: now });
      run = new AgentRun(store, user.id, "legacy-run", "Read-only progress test"); run.start(); run.fail(new Error("fixture"));
      expect(readAgentRunStatus(store, user.id, "legacy-run")).toMatchObject({ id: agentRunRecordId(user.id, "legacy-run"), runId: "legacy-run", status: "failed", modelCalls: 1, toolCalls: 2, startedAt: now - 1000 });
      expect(store.get(user.id, "agent-run", "legacy-run")).toMatchObject({ status: "running" });
    } finally { run?.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
