import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeRequest, TradingAccount } from "@orcus/core";
import { prepareHyperliquidAction } from "./index";

const account: TradingAccount = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "connected", controlRevision: 0 };
const request: TradeRequest = { accountId: account.id, venue: "hyperliquid", type: "limit", symbol: "ETH", side: "buy", amount: "0.005", price: "2000", slippageBps: 50, reduceOnly: false, mode: "manual" };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
    const { type } = JSON.parse(String(options.body));
    const response = type === "metaAndAssetCtxs" ? [{ universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 20 }] }, [{ midPx: "2000", markPx: "2000", prevDayPx: "2000", dayNtlVlm: "1000000" }]]
      : type === "clearinghouseState" ? { marginSummary: { accountValue: "100", totalMarginUsed: "1", totalNtlPos: "0.2" }, withdrawable: "99", assetPositions: [{ position: { coin: "ETH", szi: "0.0001", entryPx: "2000", unrealizedPnl: "0", liquidationPx: null, marginUsed: "0.1", leverage: { value: 2 } } }] }
      : type === "frontendOpenOrders" ? [] : undefined;
    if (!response) throw new Error("Unexpected venue request");
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["manual", "agent"] as const)("Hyperliquid %s minimum validation", mode => {
  it("accepts a limit order of exactly 10 USDC", async () => {
    await expect(prepareHyperliquidAction({ ...request, mode }, account)).resolves.toMatchObject({ hyperliquid: { method: "order" } });
  });
  it("rejects below minimum before preparing any signed action", async () => {
    await expect(prepareHyperliquidAction({ ...request, mode, amount: "0.0001", type: "market", price: undefined }, account)).rejects.toMatchObject({ code: "MINIMUM_NOTIONAL" });
  });
  it("checks the requested limit price instead of the current mark", async () => {
    await expect(prepareHyperliquidAction({ ...request, mode, price: "1000" }, account)).rejects.toMatchObject({ code: "MINIMUM_NOTIONAL" });
  });
  it("rejects excessive precision rather than rounding up to the minimum", async () => {
    await expect(prepareHyperliquidAction({ ...request, mode, amount: "0.00501" }, account)).rejects.toMatchObject({ code: "INVALID_PRECISION" });
  });
  it("does not block closing a dust position with the entry minimum", async () => {
    const prepared = await prepareHyperliquidAction({ ...request, mode, type: "close", amount: "0.0001", price: undefined }, account);
    expect(prepared.request).toMatchObject({ amount: "0.0001", side: "sell", reduceOnly: true });
  });
});
