import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Market, OpenOrder, PreparedAction, TradingAccount } from "@orcus/core";
import type { Workspace } from "../../lib/use-workspace";
import { OstiumReviewDetails } from "./ostium-review-details";
import { OstiumMarketContext } from "./ostium-market-context";
import { OstiumOrderRow } from "./ostium-account-rows";
import { OstiumOrderTicket } from "./ostium-order-ticket";

const account: TradingAccount = { id: "native", userId: "user", venue: "ostium", address: `0x${"1".repeat(40)}`, ownerAddress: `0x${"1".repeat(40)}`, chainId: 421614, status: "connected", controlRevision: 0 };
const market: Market = { venue: "ostium", symbol: "USD/JPY", baseAsset: "USD", quoteAsset: "JPY", midPrice: "152.3125", observedAt: 1000, tradable: true, minLeverage: 1, maxLeverage: 50, overnightMaxLeverage: 0, rolloverRate: { long: "-0.0125", short: "0.01" }, oracleFeeUsdc: "0.01", openFeeBps: 5 };
const request = { accountId: account.id, venue: "ostium" as const, symbol: market.symbol, side: "buy" as const, type: "market" as const, amount: "25", amountUnit: "collateral-usdc" as const, leverage: 5, slippageBps: 50, reduceOnly: false, mode: "manual" as const };
const prepared: PreparedAction = { id: "review", account, request, kind: "evm", expiresAt: 2000, controlRevision: 0, transactions: [{ to: account.address, data: "0x12345678", value: "0", chainId: 421614 }, { to: account.address, data: "0x12345678", value: "0", chainId: 421614 }], ostium: { pairId: 4, symbol: market.symbol, trader: account.address, recipient: account.address, chainId: 421614, amountUnit: "collateral-usdc", collateralUsd: "25", notionalUsd: "125", requiredAllowanceUsd: "25", leverage: 5, builderFeeBps: 0, functionName: "openTrade", expectedData: "0x12345678", marketObservedAt: 1000, minimumBlock: "100", preview: { collateralAtOpen: "24.98", exposure: "124.9", positionSize: "0.82", entryPx: "152.4", fees: { openFee: "0.01", oracleFee: "0.01", builderFee: "0", total: "0.02" } } } };
afterEach(() => vi.unstubAllGlobals());

describe("native review and quote currencies", () => {
  it("shows exact collateral, actual SDK fees, quote units and separate wallet steps", () => {
    const output = renderToStaticMarkup(<OstiumReviewDetails prepared={prepared}/>);
    for (const text of ["25 USDC", "124.90", "24.98 USDC", "152.40 JPY", "0.82 USD", "Opening fee", "Oracle fee", "Builder fee", "1 exact approval transaction", "non-atomic", "oracle callback"]) expect(output).toContain(text);
    expect(output).not.toContain("$152.40");
  });
  it("does not invent fees from malformed preview values or describe cancellation as a position", () => {
    const invalid = { ...prepared, ostium: { ...prepared.ostium!, preview: { fees: { openFee: "invalid" } } } };
    expect(renderToStaticMarkup(<OstiumReviewDetails prepared={invalid}/>)).not.toContain("Total opening fees");
    const output = renderToStaticMarkup(<OstiumReviewDetails prepared={{ ...prepared, request: { ...request, type: "cancel", amount: "0", amountUnit: "base", orderId: "pending-open:2" }, ostium: { ...prepared.ostium!, preview: undefined } }}/>);
    expect(output).not.toContain("Position notional");
    expect(output).not.toContain("Exact requested amount");
  });
  it("shows actual venue metadata without a simulated order book or fabricated schedule", () => {
    const output = renderToStaticMarkup(<OstiumMarketContext market={market} symbol={market.symbol}/>);
    for (const text of ["152.3125 JPY", "No overnight restriction", "-0.0125%", "+0.01%", "signed eight-hour", "No schedule was supplied", "no resting order book"]) expect(output).toContain(text);
    expect(output).not.toContain("$152.3125");
    expect(output).toContain("/workspace/ostium.png");
  });
});

describe("native entry and pending-order controls", () => {
  const workspace = { session: { user: { id: "user", address: account.address } }, account, symbol: market.symbol, activeMarket: market, portfolio: { balances: [] }, actions: [], markets: [market], preparing: false, executing: false } as unknown as Workspace;
  it("keeps the collateral ticket and gas payer explicit without requesting data or signing on render", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const output = renderToStaticMarkup(<OstiumOrderTicket workspace={workspace} onSetup={() => undefined}/>);
    for (const text of ["Collateral (USDC)", "Estimated notional", "Stop entry", "Take-profit (JPY per USD)", "Owner-paid Arbitrum Sepolia ETH", "Leveraged price exposure"]) expect(output).toContain(text);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps disabled native markets discoverable and unable to review an entry", () => {
    const output = renderToStaticMarkup(<OstiumOrderTicket workspace={{ ...workspace, activeMarket: { ...market, tradable: false, unavailableReason: "Testnet leverage is disabled" } }} onSetup={() => undefined}/>);
    expect(output).toContain("Testnet leverage is disabled");
    expect(output).toMatch(/disabled=""[^>]*>Review order/);
  });
  it("never offers resting-limit edit controls for a native oracle-pending order", () => {
    const order: OpenOrder = { id: "pending-open:2", accountId: account.id, venue: "ostium", symbol: market.symbol, side: "buy", type: "pending-market", size: "0", reduceOnly: false, createdAt: 1000 };
    const output = renderToStaticMarkup(<table><tbody><OstiumOrderRow order={order} workspace={workspace}/></tbody></table>);
    expect(output).toContain("Oracle action pending");
    expect(output).toContain("Review timeout cancel");
    expect(output).not.toContain(">Edit<");
  });
});
