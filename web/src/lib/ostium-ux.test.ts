import { describe, expect, it } from "vitest";
import type { Market, OpenOrder, Position, TradingAccount } from "@orcus/core";
import { ostiumAcknowledgement, ostiumEntryRequest, ostiumOrderRequest, ostiumPositionRequest, positionSizeAtPercent, type OstiumEntryDraft } from "./ostium-ux";
import { venueSymbol } from "./workspace-model";

const account: TradingAccount = { id: "native", userId: "owner", address: `0x${"1".repeat(40)}`, ownerAddress: `0x${"1".repeat(40)}`, agentAddress: `0x${"2".repeat(40)}`, venue: "ostium", chainId: 421614, status: "connected", controlRevision: 0 };
const market: Market = { venue: "ostium", symbol: "USD/JPY", baseAsset: "USD", quoteAsset: "JPY", midPrice: "152.3125", observedAt: 1000, tradable: true, minLeverage: 1, maxLeverage: 50, overnightMaxLeverage: 10 };
const draft: OstiumEntryDraft = { type: "market", side: "buy", amount: "25", leverage: "5", price: "", takeProfit: "", stopLoss: "", slippage: "0.5", isDayTrade: false };
const position: Position = { id: "ostium-position:4:10", positionId: "ostium-position:4:10", venue: "ostium", accountId: account.id, symbol: market.symbol, size: "0.12345678", side: "long", entryPrice: "152", unrealizedPnl: "0.001", observedAt: 1000 };

describe("native ticket units and current pair limits", () => {
  it("builds collateral-USDC entries without treating collateral as base size or changing symbols", () => {
    expect(ostiumEntryRequest(account, market, draft)).toMatchObject({ symbol: "USD/JPY", amount: "25", amountUnit: "collateral-usdc", leverage: 5, mode: "manual", type: "market" });
    expect(ostiumEntryRequest(account, market, { ...draft, type: "stop", price: "155", stopLoss: "150", takeProfit: "160" })).toMatchObject({ type: "stop", price: "155", stopLoss: "150", takeProfit: "160" });
  });
  it("blocks disabled, missing and out-of-limit entries instead of substituting a market", () => {
    expect(() => ostiumEntryRequest(account, undefined, draft)).toThrow(/available/);
    expect(() => ostiumEntryRequest(account, { ...market, tradable: false }, draft)).toThrow(/available/);
    expect(() => ostiumEntryRequest(account, market, { ...draft, leverage: "51" })).toThrow(/limits/);
    expect(() => ostiumEntryRequest(account, market, { ...draft, leverage: "20" })).toThrow(/day trade/);
    expect(ostiumEntryRequest(account, market, { ...draft, leverage: "20", isDayTrade: true }).isDayTrade).toBe(true);
  });
});

describe("exact native position and order management", () => {
  it("retains position identity and exact base size for exits", () => {
    expect(positionSizeAtPercent("0.12345678", 50)).toBe("0.06172839");
    expect(ostiumPositionRequest(position, "close")).toMatchObject({ positionId: position.id, amount: position.size, amountUnit: "base", side: "sell", reduceOnly: true });
    expect(ostiumPositionRequest(position, "reduce", "", 25).amount).toBe("0.030864195");
  });
  it("separates collateral units and explicit protection clearing", () => {
    expect(ostiumPositionRequest(position, "remove-collateral", "5")).toMatchObject({ amount: "5", amountUnit: "collateral-usdc", mode: "manual" });
    expect(ostiumPositionRequest(position, "stop-loss", "0")).toMatchObject({ stopLoss: "0", amountUnit: "base", positionId: position.id });
    expect(() => ostiumPositionRequest(position, "take-profit", "")).toThrow();
    expect(() => positionSizeAtPercent("0.000000000000000001", 1)).toThrow(/precision/);
    expect(() => positionSizeAtPercent("1", 0)).toThrow();
  });
  it("requires both protective levels for edits and never edits an oracle-pending order", () => {
    const order: OpenOrder = { id: "ostium-order:4:1", accountId: account.id, venue: "ostium", symbol: market.symbol, side: "buy", type: "limit", size: "0.2", collateralUsd: "25", price: "151", takeProfit: "160", stopLoss: "148", reduceOnly: false, createdAt: 1000 };
    expect(ostiumOrderRequest(order, { price: "150", takeProfit: "160", stopLoss: "0" })).toMatchObject({ type: "edit-order", amountUnit: "collateral-usdc", orderId: order.id, stopLoss: "0" });
    expect(ostiumOrderRequest({ ...order, id: "pending-open:22" }).type).toBe("cancel");
    expect(() => ostiumOrderRequest({ ...order, id: "pending-open:22" }, { price: "150", takeProfit: "160", stopLoss: "0" })).toThrow(/cannot be edited/);
  });
});

describe("native discovery and explicit authority binding", () => {
  it("starts with a fresh tradable pair and preserves explicit disabled or delisted selections", () => {
    const disabled = { ...market, symbol: "BTC/USD", tradable: false };
    expect(venueSymbol("ostium", [disabled, market], "ETH", undefined, 1000)).toBe("USD/JPY");
    expect(venueSymbol("ostium", [disabled, market], "ETH", "BTC/USD", 1000)).toBe("BTC/USD");
    expect(venueSymbol("ostium", [market], "ETH", "REMOVED/USD", 1000)).toBe("REMOVED/USD");
  });
  it("binds the broad-rights acknowledgement to the actual owner and selected agent", () => {
    expect(ostiumAcknowledgement(account, account.agentAddress!)).toMatchObject({ trader: account.ownerAddress, agentAddress: account.agentAddress, nativeNoExpiry: true, applicationLimitsOnly: true, delegateCanRemoveCollateral: true, delegateCanChargeBuilderFees: true, ownerOnlyPermissionChanges: true });
    expect(() => ostiumAcknowledgement(account, "not an address")).toThrow();
  });
});
