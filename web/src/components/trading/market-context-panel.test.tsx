import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedAction } from "@orcus/core";
import { MarketContextPanel, MarketDepthView } from "./market-context-panel";
import type { HyperliquidMarketContext } from "../../lib/market-context";

afterEach(() => vi.unstubAllGlobals());
const snapshot: HyperliquidMarketContext = { venue: "hyperliquid", network: "testnet", symbol: "BTC", retrievedAt: 1_000_000, asset: { observedAt: 1_000_000, markPrice: "65000", fundingRateHourly: "0.0000125", openInterestBase: "0" }, book: { observedAt: 1_000_000, bids: [{ price: "64999", size: "1", orders: 1 }], asks: [] }, warnings: [] };
const prepared: PreparedAction = {
  id: "preview", account: { id: "account", userId: "owner", address: `0x${"1".repeat(40)}`, ownerAddress: `0x${"2".repeat(40)}`, venue: "uniswap", chainId: 11155111, status: "connected", controlRevision: 0 }, kind: "user-operation", controlRevision: 0, expiresAt: Date.now() + 60_000,
  request: { accountId: "account", venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "buy", amount: "10", slippageBps: 50, reduceOnly: false, mode: "manual" },
  quote: { amountIn: "10", amountOut: "0.005", minimumOut: "0.004975", fee: "0.05%", observedAt: Date.now() },
};

describe("truthful market-context panels", () => {
  it("shows observed depth, hourly funding, correct payer direction and actual zero OI", () => {
    const markup = renderToStaticMarkup(<MarketDepthView symbol="BTC" snapshot={snapshot} loading={false} error={null} now={1_000_000} onRefresh={() => undefined} />);
    for (const text of ["Funding / hour", "+0.00125%", "longs pay shorts", "Open interest (BTC)", "Observed snapshot", "not a fill guarantee", "/landing/brands/hyperliquid.svg", "64,999"]) expect(markup).toContain(text);
    expect(markup).not.toContain("APR");
    expect(markup).toContain(">0</dd>");
  });

  it("keeps stale snapshots visibly stale when fresh data is unavailable", () => {
    const markup = renderToStaticMarkup(<MarketDepthView symbol="BTC" snapshot={snapshot} loading={false} error="Market data is unavailable." now={1_100_000} onRefresh={() => undefined} />);
    for (const text of ["Stale snapshot", "Context may be stale", "last received snapshot", "64,999"]) expect(markup).toContain(text);
    expect(markup).not.toContain("Observed snapshot");
  });

  it("distinguishes initial loading and unavailable context without invented data", () => {
    const markup = renderToStaticMarkup(<MarketDepthView symbol="BTC" snapshot={null} loading error={null} now={1_000_000} onRefresh={() => undefined} />);
    expect(markup).toContain("Loading testnet order book");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("65,000");
  });

  it("uses actual reviewed swap amounts and never requests data while rendering", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(<MarketContextPanel venue="uniswap" symbol="WETH/USDC" prepared={prepared} />);
    for (const text of ["Swap details", "not a resting order book", "0.004975", "0.05%", "Output is WETH, not native ETH", "not live-market valuations", "/landing/brands/uniswap.svg"]) expect(markup).toContain(text);
    expect(markup).not.toContain("Funding / hour");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not reuse an unrelated network or instrument's quote", () => {
    for (const action of [{ ...prepared, request: { ...prepared.request, symbol: "OTHER/USDC" } }, { ...prepared, account: { ...prepared.account, chainId: 1 } }]) {
      const markup = renderToStaticMarkup(<MarketContextPanel venue="uniswap" symbol="WETH/USDC" prepared={action} />);
      expect(markup).toContain("Review a swap to see");
      expect(markup).not.toContain("0.004975");
    }
  });

  it("marks an expired quote unusable rather than displaying a live validity claim", () => {
    const markup = renderToStaticMarkup(<MarketContextPanel venue="uniswap" symbol="WETH/USDC" prepared={{ ...prepared, expiresAt: 1 }} />);
    expect(markup).toContain("Expired. Review a fresh quote.");
  });
});
