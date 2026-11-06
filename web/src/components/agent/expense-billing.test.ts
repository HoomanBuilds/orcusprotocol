import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { ExpenseBillingRequest, requestExpenseBilling } from "./expense-billing";

afterEach(() => vi.unstubAllGlobals());

function pendingResponse() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

function activeRequest() { const request = new ExpenseBillingRequest("OWNER-A"); request.activate(); return request; }

describe("read-only provider billing recovery", () => {
  it("posts only the existing expense identity and never retries inference or pays", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { expenseId: "expense-1", status: "unknown", message: "provider-secret" } })); vi.stubGlobal("fetch", fetcher);
    const state = vi.fn(), refresh = vi.fn(async () => undefined);
    await activeRequest().run("expense-1", () => requestExpenseBilling("expense-1"), state, refresh);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/budget/reconcile", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ expenseId: "expense-1" }) }));
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: expect.stringMatching(/reservation remains held/), error: null });
    expect(JSON.stringify(state.mock.calls)).not.toContain("provider-secret");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "reserved"])("keeps %s and missing or native-unit billing reserved without inventing USD", async status => {
    const state = vi.fn();
    await activeRequest().run("expense-1", async () => ({ expenseId: "expense-1", status, message: "Management credential unavailable; native 0G has no verified USD equivalent." }), state, vi.fn(async () => undefined));
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: expect.stringMatching(/still unverified.*reservation remains held/), error: null });
    expect(state.mock.lastCall?.[0].notice).not.toMatch(/released|0\.00|converted|settled/);
  });

  it.each([
    { status: "settled", expected: /billing verified.*reconciled/ },
    { status: "released", expected: /reservation is released.*not a token refund/ },
  ])("shows verified $status results and refreshes recorded balances", async ({ status, expected }) => {
    const state = vi.fn(), refresh = vi.fn(async () => undefined);
    await activeRequest().run("expense-1", async () => ({ expenseId: "expense-1", status, message: "unused provider diagnostics" }), state, refresh);
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: expect.stringMatching(expected), error: null });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate clicks through the request and balance-refresh phases", async () => {
    const response = pendingResponse(), reload = pendingResponse(), request = activeRequest();
    const send = vi.fn(() => response.promise), refresh = vi.fn(() => reload.promise), state = vi.fn();
    const first = request.run("expense-1", send, state, refresh);
    await request.run("expense-1", send, state, refresh); expect(send).toHaveBeenCalledTimes(1);
    response.resolve({ expenseId: "expense-1", status: "unknown" }); await Promise.resolve(); await Promise.resolve();
    await request.run("expense-1", send, state, refresh); expect(send).toHaveBeenCalledTimes(1);
    expect(state.mock.lastCall?.[0].pending).toBe(true);
    reload.resolve(undefined); await first;
    expect(state.mock.lastCall?.[0].pending).toBe(false);
  });

  it.each([
    ["COMPUTE_EXPENSE_NOT_FOUND", /signed-in owner/],
    ["COMPUTE_RECONCILIATION_BUSY", /another billing check/i],
    ["COMPUTE_BILLING_UNAVAILABLE", /billing is unavailable/],
    ["COMPUTE_BILLING_CONFLICT", /operator review/],
    ["AUTH_REQUIRED", /session expired/],
    ["UNKNOWN_UPSTREAM", /reservation remains held/],
  ])("sanitizes %s and releases the local click lock without releasing expenses", async (code, message) => {
    const request = activeRequest(), state = vi.fn(), refresh = vi.fn(async () => undefined);
    const send = vi.fn(async () => { throw new ApiError(code as string, "private credential 0xdeadbeef", 503); });
    await request.run("expense-1", send, state, refresh);
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: null, error: expect.stringMatching(message as RegExp) });
    expect(JSON.stringify(state.mock.calls)).not.toMatch(/credential|0xdeadbeef/);
    expect(refresh).not.toHaveBeenCalled();
    await request.run("expense-1", send, state, refresh); expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([null, { expenseId: "other", status: "settled" }, { expenseId: "expense-1", status: "invented" }])("refuses mismatched or malformed provider results", async result => {
    const state = vi.fn(), refresh = vi.fn(async () => undefined);
    await activeRequest().run("expense-1", async () => result, state, refresh);
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: null, error: expect.stringMatching(/reservation remains held/) });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps a verified result but explains a failed workspace refresh safely", async () => {
    const state = vi.fn();
    await activeRequest().run("expense-1", async () => ({ expenseId: "expense-1", status: "settled" }), state, async () => { throw new Error("private RPC details"); });
    expect(state.mock.lastCall?.[0]).toEqual({ pending: false, notice: expect.stringMatching(/billing verified/), error: expect.stringMatching(/Balances could not refresh/) });
    expect(JSON.stringify(state.mock.calls)).not.toContain("private RPC");
  });

  it("ignores late owner-A callbacks after switching away and back", async () => {
    const request = activeRequest(), response = pendingResponse(), state = vi.fn(), refresh = vi.fn(async () => undefined);
    const first = request.run("expense-1", () => response.promise, state, refresh); expect(state).toHaveBeenCalledTimes(1);
    request.changeOwner("owner-b"); request.activate(); request.changeOwner("owner-a"); request.activate();
    response.resolve({ expenseId: "expense-1", status: "settled" }); await first;
    expect(state).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
  });

  it("does not let an old owner finish unlock the new owner's in-flight request", async () => {
    const request = activeRequest(), old = pendingResponse(), current = pendingResponse(), oldState = vi.fn(), newState = vi.fn();
    const first = request.run("expense-1", () => old.promise, oldState, vi.fn(async () => undefined));
    request.changeOwner("owner-b"); request.activate();
    const send = vi.fn(() => current.promise), refresh = vi.fn(async () => undefined), second = request.run("expense-2", send, newState, refresh);
    old.resolve({ expenseId: "expense-1", status: "settled" }); await first;
    await request.run("expense-2", send, newState, refresh); expect(send).toHaveBeenCalledTimes(1);
    current.resolve({ expenseId: "expense-2", status: "unknown" }); await second;
    expect(oldState).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
    expect(newState.mock.lastCall?.[0].pending).toBe(false);
  });

  it("ignores completion after unmount and a Strict Mode remount", async () => {
    const request = activeRequest(), response = pendingResponse(), state = vi.fn(), refresh = vi.fn(async () => undefined);
    const first = request.run("expense-1", () => response.promise, state, refresh);
    request.stop(); request.activate(); response.resolve({ expenseId: "expense-1", status: "settled" }); await first;
    expect(state).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
    request.stop(); const send = vi.fn(async () => undefined); await request.run("expense-1", send, state, refresh); expect(send).not.toHaveBeenCalled();
  });

  it("suppresses completion after the owner changes during workspace refresh", async () => {
    const request = activeRequest(), reload = pendingResponse(), state = vi.fn(), refresh = vi.fn(() => reload.promise);
    const first = request.run("expense-1", async () => ({ expenseId: "expense-1", status: "settled" }), state, refresh);
    await Promise.resolve(); expect(refresh).toHaveBeenCalledTimes(1); expect(state).toHaveBeenCalledTimes(2);
    request.changeOwner("owner-b"); request.activate(); reload.resolve(undefined); await first;
    expect(state).toHaveBeenCalledTimes(2);
  });

  it("keeps unchanged checksum casing in the same owner generation", async () => {
    const request = activeRequest(), response = pendingResponse(), state = vi.fn(), refresh = vi.fn(async () => undefined);
    const first = request.run("expense-1", () => response.promise, state, refresh);
    request.changeOwner("owner-a"); response.resolve({ expenseId: "expense-1", status: "unknown" }); await first;
    expect(refresh).toHaveBeenCalledTimes(1); expect(state.mock.lastCall?.[0].pending).toBe(false);
  });
});
