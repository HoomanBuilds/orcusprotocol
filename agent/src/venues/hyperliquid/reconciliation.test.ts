import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { reconcileHyperliquidAction } from "./index";

afterEach(() => vi.unstubAllGlobals());

const account: TradingAccount = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "authorized", controlRevision: 1 };
const prepared: PreparedAction = { id: "a".repeat(64), account, request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "agent" }, kind: "hyperliquid", expiresAt: Date.now() + 60_000, controlRevision: 1 };

function venue(status: string) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ status: "order", order: { status, order: { oid: 42, sz: "0.01", origSz: "0.01" } } }), { headers: { "Content-Type": "application/json" } }));
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
  it("does not report a successful cancellation when a fill won the race", async () => {
    venue("filled");
    const action = { prepared: { ...prepared, hyperliquid: { method: "cancel" as const, params: { cancels: [{ a: 4, o: 42 }] } } } };
    expect((await reconcileHyperliquidAction(action, account)).status).toBe("rejected");
  });
});
