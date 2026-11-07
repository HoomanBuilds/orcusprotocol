import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { reconcileHyperliquidAction } from "./index";

const now = 1_794_032_000_000;
const account: TradingAccount = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "authorized", controlRevision: 1 };
const prepared: PreparedAction = { id: "prepared", account, kind: "hyperliquid", expiresAt: now - 300_000, request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.0001", slippageBps: 50, reduceOnly: false, mode: "manual" }, hyperliquid: { method: "order", params: { orders: [{ a: 4, b: true, p: "2269.1", s: "0.0001", r: false, t: { limit: { tif: "Ioc" } }, c: "0x0123456789abcdef0123456789abcdef" }], grouping: "na" } } };
function action() { return { id: "saved", status: "submitted-unknown", createdAt: now - 360_000, prepared: structuredClone(prepared) }; }
function responses(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { orderStatus: { status: "unknownOid" }, userFillsByTime: [], openOrders: [], clearinghouseState: { time: now, assetPositions: [], marginSummary: { accountValue: "185.420466", totalMarginUsed: "0", totalNtlPos: "0" }, withdrawable: "185.420466" }, ...overrides };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/info");
    const type = JSON.parse(String(init?.body)).type;
    if (values[type] instanceof Error) throw values[type];
    return new Response(JSON.stringify(values[type]), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("expired Hyperliquid IOC recovery", () => {
  it("retires only the expired request with complete empty venue observations", async () => {
    const fetch = responses();
    const result = await reconcileHyperliquidAction(action(), account);
    expect(result).toMatchObject({ status: "expired", evidence: { recovery: "expired-ioc-no-execution-observed", venueStatus: "unknownOid", signedExpiresAfter: prepared.expiresAt, observedFillCount: 0, observedOpenOrderCount: 0, observedPositionCount: 0, checkedAt: now } });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toContainEqual({ type: "userFillsByTime", user: account.address, startTime: now - 420_000, endTime: now, aggregateByTime: false });
  });
  it.each([
    ["userFillsByTime", [{}]], ["userFillsByTime", { error: "truncated" }], ["userFillsByTime", Array(500).fill({})],
    ["openOrders", [{}]], ["openOrders", null], ["clearinghouseState", null],
    ["clearinghouseState", { time: now, assetPositions: [] }], ["userFillsByTime", new Error("Unavailable")],
  ])("keeps incomplete or nonempty %s unresolved", async (key, value) => {
    responses({ [key as string]: value });
    expect((await reconcileHyperliquidAction(action(), account)).status).toBe("submitted-unknown");
  });
  it.each([now - 30_001, now + 5_001, undefined, NaN])("rejects stale or invalid account timestamps %s", async time => {
    responses({ clearinghouseState: { time, assetPositions: [], marginSummary: { accountValue: "185", totalMarginUsed: "0", totalNtlPos: "0" }, withdrawable: "185" } });
    expect((await reconcileHyperliquidAction(action(), account)).status).toBe("submitted-unknown");
  });
  it("retains unknown status when the account has positions", async () => {
    responses({ clearinghouseState: { time: now, assetPositions: [{}], marginSummary: { accountValue: "185", totalMarginUsed: "0", totalNtlPos: "0" }, withdrawable: "185" } });
    expect((await reconcileHyperliquidAction(action(), account)).status).toBe("submitted-unknown");
  });
  it.each(["recent", "old", "missing-created", "missing-expiry", "limit", "trigger", "batch", "vault", "override", "grouping", "order-id", "account", "not-submitted"]) ("does not recover ineligible %s requests", async kind => {
    const value = action();
    const params = value.prepared.hyperliquid!.params;
    if (kind === "recent") value.prepared.expiresAt = now - 299_999;
    if (kind === "old") value.createdAt = now - 86_400_001;
    if (kind === "missing-created") value.createdAt = undefined as unknown as number;
    if (kind === "missing-expiry") value.prepared.expiresAt = NaN;
    if (kind === "limit") (params.orders as any[])[0].t.limit.tif = "Gtc";
    if (kind === "trigger") (params.orders as any[])[0].t.trigger = {};
    if (kind === "batch") (params.orders as any[]).push((params.orders as any[])[0]);
    if (kind === "vault") params.vaultAddress = account.address;
    if (kind === "override") params.expiresAfter = now + 60_000;
    if (kind === "grouping") params.grouping = "normalTpsl";
    if (kind === "order-id") Object.assign(value, { orderId: "42" });
    if (kind === "account") value.prepared.request.accountId = "different";
    if (kind === "not-submitted") value.status = "awaiting-approval";
    const fetch = responses();
    expect((await reconcileHyperliquidAction(value, account)).status).toBe("submitted-unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires the exact unknownOid venue response", async () => {
    const fetch = responses({ orderStatus: { status: "unavailable" } });
    expect((await reconcileHyperliquidAction(action(), account)).status).toBe("submitted-unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
