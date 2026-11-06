import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { reconcileHyperliquidAction } from "./index";

afterEach(() => vi.unstubAllGlobals());

const account: TradingAccount = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "authorized", controlRevision: 1 };
const prepared: PreparedAction = { id: "a".repeat(64), account, request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "agent" }, kind: "hyperliquid", expiresAt: Date.now() + 60_000, controlRevision: 1 };

function venue(status: string, order: Record<string, unknown> = {}, fills: unknown = []) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body.type === "userFillsByTime" ? fills : { status: "order", order: { status, order: { oid: 42, sz: "0.01", origSz: "0.01", coin: "ETH", ...order } } }), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Hyperliquid durable reconciliation", () => {
  it("looks up the submitted payload cloid rather than a replaced application action ID", async () => {
    const fetch = venue("open"), cloid = "0x0123456789abcdef0123456789abcdef";
    const action = { prepared: { ...prepared, hyperliquid: { method: "order" as const, params: { orders: [{ c: cloid }] } } } };
    expect((await reconcileHyperliquidAction(action, account)).status).toBe("pending");
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toMatchObject({ type: "orderStatus", user: account.address, oid: cloid });
  });
  it("uses the original cancellation order ID when the SDK response carries no ID", async () => {
    const fetch = venue("canceled");
    const action = { prepared: { ...prepared, hyperliquid: { method: "cancel" as const, params: { cancels: [{ a: 4, o: 42 }] } } } };
    expect((await reconcileHyperliquidAction(action, account)).status).toBe("cancelled");
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body)).oid).toBe(42);
  });
  it("binds reported order evidence to the actual submitted client order ID", async () => {
    const fetch = venue("filled"), cloid = "0x0123456789abcdef0123456789abcdef";
    const action = { orderId: "43", prepared: { ...prepared, hyperliquid: { method: "order" as const, params: { orders: [{ c: cloid }] } } } };
    expect((await reconcileHyperliquidAction(action, account)).status).toBe("submitted-unknown");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).oid).toBe(cloid);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not report a successful cancellation when a fill won the race", async () => {
    venue("filled");
    const action = { prepared: { ...prepared, hyperliquid: { method: "cancel" as const, params: { cancels: [{ a: 4, o: 42 }] } } } };
    expect((await reconcileHyperliquidAction(action, account)).status).toBe("rejected");
  });
  it("does not classify numerically equal remaining amounts as partial", async () => {
    venue("open", { sz: "0.0100" });
    expect((await reconcileHyperliquidAction({ orderId: "42", prepared }, account)).status).toBe("pending");
  });
  it("keeps a cancelled IOC terminal while preserving actual partial fills and fees", async () => {
    const timestamp = Date.now() - 10_000;
    const fetch = venue("canceled", { sz: "0", timestamp }, [{ oid: 42, coin: "ETH", tid: 5, sz: "0.004", px: "2000", fee: "0.001", feeToken: "USDC", time: timestamp + 100 }]);
    const result = await reconcileHyperliquidAction({ orderId: "42", prepared }, account);
    expect(result.status).toBe("cancelled");
    expect(result.evidence).toMatchObject({ observedExecutedSize: "0.004", observedExecutedQuote: "8", observedFeesByToken: { USDC: "0.001" }, executionOutcome: "partially-filled-cancelled", fillsComplete: false });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ type: "userFillsByTime", user: account.address, startTime: timestamp, aggregateByTime: false });
  });
  it("keeps unavailable fill history explicit without inventing zero fills", async () => {
    venue("filled", {}, { error: "unavailable" });
    const result = await reconcileHyperliquidAction({ orderId: "42", prepared }, account);
    expect(result.status).toBe("confirmed");
    expect(result.evidence).toMatchObject({ fillEvidenceStatus: "unavailable", fillsComplete: false });
    expect(result.evidence).not.toHaveProperty("observedExecutedSize");
  });
  it("fails closed for unknown lifecycle states and inconsistent numeric identities", async () => {
    let fetch = venue("newCanceledState");
    expect((await reconcileHyperliquidAction({ orderId: "42", prepared }, account)).status).toBe("submitted-unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = venue("filled", { oid: 43 });
    expect((await reconcileHyperliquidAction({ orderId: "42", prepared }, account)).status).toBe("submitted-unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
