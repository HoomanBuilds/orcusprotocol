import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationInputSchema, tradeRequestSchema, type PreparedAction } from "@orcus/core";
import { Platform } from "./platform";
import { Store } from "./store";
import * as boundary from "./engine";
import type { StoredAccount, StoredAction, StoredAutomation, StoredPermission } from "./types";

let directory: string;
const stores: Store[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orcus-policy-"));
  vi.stubEnv("ORCUS_DATA_DIR", directory);
  vi.stubEnv("ORCUS_MASTER_KEY", randomBytes(32).toString("hex"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No public network calls in policy fixtures"); }));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.db.close();
  rmSync(directory, { recursive: true, force: true });
});

function harness(persistent = false) {
  const store = new Store(persistent ? join(directory, "policy.sqlite") : ":memory:"); stores.push(store);
  const user = store.ensureUser("0x1111111111111111111111111111111111111111"), platform = new Platform(store);
  const created = platform.createAccount(user, { venue: "hyperliquid" });
  const account = store.update<StoredAccount>(user.id, "account", created.id, { status: "authorized" });
  const now = Date.now();
  const permission = store.put("permission", { id: "grant", userId: user.id, accountId: account.id, agentAddress: account.agentAddress!, allowedSymbols: ["ETH"], allowedActions: ["market"], maxTradeUsd: "100", expiresAt: now + 86_400_000, status: "active", enforcement: "application", controlRevision: account.controlRevision, createdAt: now, updatedAt: now } satisfies StoredPermission);
  vi.spyOn(platform, "verifyHyperliquidApproval").mockResolvedValue();
  const request = tradeRequestSchema.parse({ accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", mode: "agent" });
  const submit = vi.fn(async (_prepared: unknown, _account: unknown, _key: unknown, options: { assertAuthority: () => void }) => { options.assertAuthority(); return { status: "pending", orderId: "fixture-order" }; });
  let decision = "allow";
  const engine = vi.spyOn(boundary, "callEngine").mockImplementation(async (name, ...args) => {
    if (name === "evaluateStrategy") {
      const input = args[0] as { evaluationId: string; automationId: string; account: StoredAccount; expiresAt: number; controlRevision: number; policyVersion: number };
      return { id: input.evaluationId, automationId: input.automationId, accountId: input.account.id, chainId: input.account.chainId, expiresAt: input.expiresAt, controlRevision: input.controlRevision, policyVersion: input.policyVersion, source: "local-simulation", observedAt: Date.now(), decision, reason: "Fixture threshold result" };
    }
    if (name === "getMarkets") return [{ venue: "hyperliquid", symbol: "ETH", baseAsset: "ETH", quoteAsset: "USDC", midPrice: "2000", observedAt: Date.now() }];
    if (name === "prepareAction") return { id: "fixture-prepared", request: args[0], account: args[1], kind: "hyperliquid", expiresAt: Date.now() + 60_000, controlRevision: 0 } as PreparedAction;
    if (name === "submitAgentAction") return submit(...args as Parameters<typeof submit>);
    if (name === "reconcileAction") return { status: "confirmed", orderId: "fixture-order" };
    throw new Error(`Unexpected fixture boundary ${name}`);
  });
  const create = (extra: Record<string, unknown> = {}) => platform.createAutomation(user, { kind: "trade", accountId: account.id, name: "Reviewed ETH trade", request, intervalSeconds: 60, ...extra });
  let step = 0;
  const tick = async (job: StoredAutomation, next: "allow" | "no-action" | "reject" = "allow") => {
    decision = next;
    store.update<StoredAutomation>(user.id, "automation", job.id, { nextRunAt: Date.now() - ++step * 1000 });
    return platform.tick();
  };
  return { store, platform, account, user, permission, request, engine, submit, create, tick };
}

describe("reviewed bounded automation policy", () => {
  it("rejects free text, implicit schedules, unsupported conditions and mismatched markets", () => {
    const h = harness();
    expect(() => h.platform.createAutomation(h.user, { accountId: h.account.id, name: "Unsafe", instruction: "Buy if RSI is below 30" })).toThrow("typed trade");
    expect(() => automationInputSchema.parse({ accountId: h.account.id, name: "No schedule", request: h.request })).toThrow("explicit interval");
    expect(() => h.create({ executionMode: "recurring" })).toThrow("maximum execution count");
    expect(() => h.create({ executionMode: "once", maxExecutions: 2 })).toThrow("exactly one");
    expect(() => h.create({ executionMode: "on-crossing", maxExecutions: 3 })).toThrow("requires a price condition");
    expect(() => h.create({ condition: { symbol: "BTC", operator: "above", price: "1000" } })).toThrow("same market");
    expect(() => h.create({ condition: { symbol: "ETH", operator: "rsi-below", price: "30" } })).toThrow();
    for (const maxExecutions of [0, -1, 1.5, 1001, Infinity]) expect(() => h.create({ executionMode: "recurring", maxExecutions })).toThrow();
    expect(h.engine).not.toHaveBeenCalled();
  });

  it("defaults to one attempt and cannot resume or raise the cap after completion", async () => {
    const h = harness(), job = h.create();
    expect(job).toMatchObject({ executionMode: "once", maxExecutions: 1, executionCount: 0, policySchemaVersion: 1 });
    await h.tick(job);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "completed", executionCount: 1 });
    await h.tick(job);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(() => h.platform.updateAutomation(h.user, job.id, { status: "active" })).toThrow("execution limit");
    expect(() => h.platform.updateAutomation(h.user, job.id, { executionMode: "recurring", maxExecutions: 10, status: "active" })).toThrow("execution limit");
  });

  it("repeats only up to the explicitly reviewed finite count", async () => {
    const h = harness(), job = h.create({ executionMode: "recurring", maxExecutions: 2 });
    await h.tick(job); await h.tick(job); await h.tick(job);
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "completed", executionCount: 2 });
    expect(h.engine.mock.calls.some(([name]) => name === "planWith0G")).toBe(false);
  });

  it("observes before crossing, rearms on false and does not fire repeatedly while true", async () => {
    const h = harness(), job = h.create({ executionMode: "on-crossing", maxExecutions: 2, condition: { symbol: "ETH", operator: "below", price: "2100" } });
    await h.tick(job, "allow");
    expect(h.store.get(h.user.id,"automation",job.id)).toMatchObject({executionCount:0,lastOutcome:{status:"armed"}});
    await h.tick(job, "allow");
    expect(h.submit).not.toHaveBeenCalled();
    await h.tick(job, "no-action"); await h.tick(job, "allow"); await h.tick(job, "allow");
    expect(h.submit).toHaveBeenCalledOnce();
    await h.tick(job, "no-action"); await h.tick(job, "allow");
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "completed", executionCount: 2, conditionActive: true });
  });

  it("does not rearm on rejected observations", async () => {
    const h = harness(), job = h.create({ executionMode: "on-crossing", maxExecutions: 2, condition: { symbol: "ETH", operator: "above", price: "1900" } });
    await h.tick(job, "allow"); await h.tick(job, "reject"); await h.tick(job, "allow");
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("consumes an unknown submission attempt and never retries it", async () => {
    const h = harness(), job = h.create();
    h.submit.mockRejectedValue(new Error("Fixture transport disconnected after submission"));
    await h.tick(job);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.store.list<StoredAction>(h.user.id, "action")[0]).toMatchObject({ status: "submitted-unknown", automationExecutionOrdinal: 1 });
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "failed", executionCount: 1 });
    expect(() => h.platform.updateAutomation(h.user, job.id, { status: "active" })).toThrow("execution limit");
    await h.tick(job);
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("rejects instruction-only edits and preserves consumed counts on structured review", async () => {
    const h = harness(), job = h.create({ executionMode: "recurring", maxExecutions: 3 });
    expect(() => h.platform.updateAutomation(h.user, job.id, { instruction: "Actually only buy below 1000" })).toThrow("Instructions are descriptive");
    await h.tick(job);
    const updated = h.platform.updateAutomation(h.user, job.id, { condition: { symbol: "ETH", operator: "below", price: "1000" }, executionMode: "on-crossing" });
    expect(updated).toMatchObject({ policyVersion: 2, executionCount: 1, executionMode: "on-crossing" });
    expect(updated.conditionActive).toBeUndefined();
    await h.tick(job, "allow");
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("requires fresh authorization when a paused strategy is resumed", () => {
    const h = harness(), job = h.create();
    h.platform.updateAutomation(h.user, job.id, { status: "paused" });
    h.store.update<StoredPermission>(h.user.id, "permission", h.permission.id, { status: "revoked" });
    expect(() => h.platform.updateAutomation(h.user, job.id, { status: "active" })).toThrow("Authorize agent access");
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "paused" });
  });

  it("pauses legacy policies before evaluation and requires a structured review", async () => {
    const h = harness(), job = h.create();
    h.store.update<StoredAutomation>(h.user.id, "automation", job.id, { policySchemaVersion: undefined, executionMode: undefined, maxExecutions: undefined });
    await h.tick(job);
    expect(h.engine).not.toHaveBeenCalled();
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "paused", error: expect.stringContaining("older automation") });
    expect(() => h.platform.updateAutomation(h.user, job.id, { status: "active" })).toThrow("explicit execution mode");
    expect(h.platform.updateAutomation(h.user, job.id, { status: "active", executionMode: "once", maxExecutions: 1 })).toMatchObject({ status: "active", policySchemaVersion: 1 });
  });

  it("persists counts and crossing state across SQLite reopen", async () => {
    const h = harness(true), job = h.create({ executionMode: "on-crossing", maxExecutions: 2, condition: { symbol: "ETH", operator: "below", price: "2100" } });
    await h.tick(job, "no-action"); await h.tick(job, "allow");
    h.store.db.close(); stores.splice(stores.indexOf(h.store), 1);
    const reopened = new Store(join(directory, "policy.sqlite")); stores.push(reopened);
    const platform = new Platform(reopened);
    vi.spyOn(platform, "verifyHyperliquidApproval").mockResolvedValue();
    reopened.update<StoredAutomation>(h.user.id, "automation", job.id, { nextRunAt: Date.now() - 30_000 });
    await platform.tick();
    expect(h.submit).toHaveBeenCalledOnce();
    expect(reopened.get(h.user.id, "automation", job.id)).toMatchObject({ executionCount: 1, conditionActive: true });
  });

  it("bounds alert notifications and waits for an observed crossing", async () => {
    const h = harness(), job = h.platform.createAutomation(h.user, { kind: "alert", accountId: h.account.id, name: "ETH crossing", condition: { symbol: "ETH", operator: "above", price: "1900" }, executionMode: "on-crossing", maxExecutions: 1 });
    await h.tick(job, "allow");
    expect(h.platform.notifications(h.user).notifications).toHaveLength(0);
    await h.tick(job, "no-action"); await h.tick(job, "allow"); await h.tick(job, "allow");
    expect(h.platform.notifications(h.user).notifications).toHaveLength(1);
    expect(h.store.get(h.user.id, "automation", job.id)).toMatchObject({ status: "completed", executionCount: 1 });
    expect(h.submit).not.toHaveBeenCalled();
  });
});
