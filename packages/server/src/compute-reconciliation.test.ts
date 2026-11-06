import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBudget, reconcileComputeExpense, reserveBudget, setBudget, settleComputeReservation } from "./budget";
import { handleRequest } from "./http";
import { Store } from "./store";

const origin = "https://router-api.0g.ai", model = "0gm-1.0-35b-a3b", publicKeyId = "fixture-api-key-id";
let store: Store;
beforeEach(() => { store = new Store(":memory:"); vi.stubEnv("ZEROG_COMPUTE_MANAGEMENT_KEY", "mk-read-only-fixture"); vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", "disabled"); vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "1"); vi.stubEnv("ORCUS_COMPUTE_PROJECT_DAILY_USD", "10"); });
afterEach(() => { if (store.db.open) store.db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function pending(digit = "1", reference = "pending", context: Record<string, unknown> = {}) {
  const user = store.ensureUser(`0x${digit.repeat(40)}`);
  setBudget(store, user.id, "10", "0", false);
  reserveBudget(store, user.id, reference, "0.01");
  settleComputeReservation(store, user.id, reference, { outcome: "unknown", requestId: "router-request", billingOrigin: origin, billingApiKeyId: publicKeyId, model, ...context });
  const expense = getBudget(store, user.id).expenses.find(item => item.reference === reference)!;
  return { user, expense };
}
function record(overrides: Record<string, unknown> = {}) {
  return { request_id: "router-request", api_key_id: publicKeyId, model_id: model, cost: "7", created_at: new Date().toISOString(), ...overrides };
}
function page(data: unknown[] = [record()], overrides: Record<string, unknown> = {}) {
  return { object: "list", currency: "usd", data, total: data.length, limit: 100, offset: 0, ...overrides };
}
function provider(data: unknown = page()) {
  const fetch = vi.fn(async (_url: URL, _options: RequestInit) => Response.json(data));
  vi.stubGlobal("fetch", fetch); return fetch;
}

describe("trusted read-only compute billing recovery", () => {
  it("reconciles the exact account request once without exposing shared history or retrying inference", async () => {
    const { user, expense } = pending(), fetch = provider(page([record({ provider_address: "unnecessary-account-data", input_tokens: 5000 })]));
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "settled" });
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000007", reservedUsd: "0.000000", availableUsd: "9.999993" });
    const url = fetch.mock.calls[0][0], options = fetch.mock.calls[0][1];
    expect(url.origin).toBe(origin); expect(url.pathname).toBe("/v1/account/usage/history"); expect(url.searchParams.get("api_key_id")).toBe(publicKeyId);
    expect(options).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer mk-read-only-fixture" } });
    expect(options.method).toBeUndefined(); expect(options.signal).toBeInstanceOf(AbortSignal);
    const evidence = getBudget(store, user.id).expenses[0].evidence;
    expect(evidence).toMatchObject({ billingStatus: "management-history-verified", requestId: "router-request", billing: { costUsd: "0.000007", currency: "usd" } });
    expect(JSON.stringify(evidence)).not.toMatch(/mk-read-only|unnecessary-account-data|input_tokens/);
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "settled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains native 0G bills without guessing a USD exchange rate, even if an undocumented field claims one", async () => {
    const { user, expense } = pending(); provider(page([record({ cost: "400000000000", cost_usd_micro: "1" })], { currency: "0g" }));
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("native 0G") });
    expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.010000" });
  });
  it("does not infer a zero bill from absent history", async () => {
    const { user, expense } = pending(); provider(page([]));
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("Absence is not proof") });
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it.each([{ billingApiKeyId: undefined }, { billingOrigin: undefined }, { billingOrigin: "https://untrusted.unit.test" }, { requestId: undefined }])("does not query history when the original identity is incomplete: %j", async context => {
    const { user, expense } = pending("1", "legacy", context), fetch = provider();
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("Operator-assisted") });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps reservations when the read-only management integration is not configured", async () => {
    const { user, expense } = pending(), fetch = provider(); vi.stubEnv("ZEROG_COMPUTE_MANAGEMENT_KEY", "");
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("management credential") });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ api_key_id: "another-key" }, { model_id: "other-model" }, { created_at: "2020-01-01T00:00:00Z" }, { created_at: "invalid" }])("rejects mismatched account or call identity: %j", async override => {
    const { user, expense } = pending(); provider(page([record(override)]));
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_CONFLICT" });
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it.each(["7", "8"])("rejects duplicate request rows even when their costs are %s", async secondCost => {
    const { user, expense } = pending(); provider(page([record(), record({ cost: secondCost })]));
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_CONFLICT" });
  });
  it.each(["-1", "1.2", "1e3", 7, "9".repeat(81)])("does not accept non-integer, unsafe, or ambiguous provider cost %s", async cost => {
    const { user, expense } = pending(); provider(page([record({ cost })]));
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_UNAVAILABLE" });
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it("does not silently charge above the reservation", async () => {
    const { user, expense } = pending(); provider(page([record({ cost: "10001" })]));
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("exceeds") });
    expect(getBudget(store, user.id).spentUsd).toBe("0.000000");
  });
  it("prevents a provider proof from paying multiple expenses or users", async () => {
    const first = pending("1"), second = pending("2"); provider();
    await reconcileComputeExpense(store, first.user.id, first.expense.id);
    await expect(reconcileComputeExpense(store, second.user.id, second.expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_CONFLICT" });
    expect(getBudget(store, second.user.id).reservedUsd).toBe("0.010000");
    await expect(reconcileComputeExpense(store, second.user.id, first.expense.id)).rejects.toMatchObject({ code: "COMPUTE_EXPENSE_NOT_FOUND" });
  });
  it("holds state safely while offline and across a reopened database and UTC day", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-compute-recovery-"));
    store.db.close(); store = new Store(join(directory, "recovery.sqlite"));
    try {
      vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T23:59:59Z"));
      const { user, expense } = pending();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret provider error"); }));
      await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_UNAVAILABLE", message: expect.not.stringContaining("secret") });
      store.db.close(); store = new Store(join(directory, "recovery.sqlite"));
      vi.setSystemTime(new Date("2026-11-07T00:00:01Z"));
      vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "0.01");
      expect(() => reserveBudget(store, user.id, "cannot-reset", "0.000001")).toThrow(/operator-paid/);
      provider(); await reconcileComputeExpense(store, user.id, expense.id);
      store.db.close(); store = new Store(join(directory, "recovery.sqlite"));
      const fetch = provider(); await reconcileComputeExpense(store, user.id, expense.id);
      expect(fetch).not.toHaveBeenCalled(); expect(getBudget(store, user.id).spentUsd).toBe("0.000007");
    } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires complete bounded pagination rather than settling the first matching row", async () => {
    const { user, expense } = pending();
    const other = Array.from({ length: 99 }, (_, index) => record({ request_id: `other-${index}` }));
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(page([record(), ...other], { total: 101 }))).mockResolvedValueOnce(Response.json(page([record()], { total: 101, offset: 100 })));
    vi.stubGlobal("fetch", fetch);
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_CONFLICT" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it("stops excessive history windows before following unbounded pagination", async () => {
    const { user, expense } = pending(), fetch = provider(page([record()], { total: 501 }));
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "unknown", message: expect.stringContaining("bounded") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts a provider's smaller page size only after the complete window is checked", async () => {
    const { user, expense } = pending();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(page([record()], { limit: 1, total: 2 }))).mockResolvedValueOnce(Response.json(page([record({ request_id: "unrelated" })], { limit: 1, offset: 1, total: 2 })));
    vi.stubGlobal("fetch", fetch);
    expect(await reconcileComputeExpense(store, user.id, expense.id)).toMatchObject({ status: "settled" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("serializes overlapping checks and fails closed if the expense changes during the read", async () => {
    const { user, expense } = pending();
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
    const first = reconcileComputeExpense(store, user.id, expense.id);
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_RECONCILIATION_BUSY" });
    store.db.prepare("UPDATE expenses SET evidence=? WHERE id=?").run(JSON.stringify({ changed: true }), expense.id);
    finish(Response.json(page()));
    await expect(first).rejects.toMatchObject({ code: "COMPUTE_BILLING_CONFLICT" });
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it.each([{ currency: "unknown" }, { total: undefined }, { offset: 1 }, { next_cursor: "more-records" }])("retains the reservation when history is ambiguous: %j", async override => {
    const { user, expense } = pending(); provider(page([record()], override));
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: expect.stringMatching(/^COMPUTE_BILLING_/) });
    expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
  });
  it("bounds history response bytes without persisting provider payloads", async () => {
    const { user, expense } = pending();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-provider-body".repeat(60_000))));
    await expect(reconcileComputeExpense(store, user.id, expense.id)).rejects.toMatchObject({ code: "COMPUTE_BILLING_UNAVAILABLE" });
    expect(JSON.stringify(getBudget(store, user.id).expenses)).not.toContain("private-provider-body");
  });
  it("keeps old unresolved reservations visible ahead of newer finalized expenses", () => {
    const { user, expense } = pending();
    for (let index = 0; index < 55; index++) { reserveBudget(store, user.id, `new-${index}`, "0.01"); settleComputeReservation(store, user.id, `new-${index}`, { outcome: "rejected" }); }
    expect(getBudget(store, user.id).expenses[0].id).toBe(expense.id);
  });
  it("accepts only an authenticated owner's expense ID, never caller billing amounts or provider IDs", async () => {
    const { user, expense } = pending(), fetch = provider();
    const appOrigin = "http://localhost:3000";
    vi.stubEnv("ORCUS_APP_URL", appOrigin);
    const challenge = store.createChallenge(user.address, appOrigin), token = store.createSession(challenge.id, user.address).token;
    const post = (body: unknown, cookie = `orcus_session=${token}`, suppliedOrigin = appOrigin) => handleRequest(new Request(`${appOrigin}/api/budget/reconcile`, { method: "POST", headers: { Origin: suppliedOrigin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }), store);
    expect((await post({ expenseId: expense.id }, "")).status).toBe(401);
    expect((await post({ expenseId: expense.id }, undefined, "https://other.test")).status).toBe(403);
    expect((await post({ expenseId: expense.id, costUsd: "0", requestId: "claimed" })).status).toBe(400);
    const other = pending("2");
    expect((await post({ expenseId: other.expense.id })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect((await post({ expenseId: expense.id })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
