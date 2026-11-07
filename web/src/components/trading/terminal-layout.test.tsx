import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "./terminal";

const state = vi.hoisted(() => ({ venue: "hyperliquid", symbol: "ETH", activeMarket: undefined as undefined | { venue: string; symbol: string; observedAt: number; midPrice: string; quoteAsset: string } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => ({
  ...state,
  markets: [],
  session: {},
  portfolio: { positions: [], observedAt: 0 },
  resourceErrors: {},
}) }));
vi.mock("./market-chart", () => ({ MarketChart: () => <section data-testid="chart"/> }));
vi.mock("./market-context-panel", () => ({ MarketContextPanel: () => <section data-testid="market-context"/> }));
vi.mock("./ostium-market-context", () => ({ OstiumMarketContext: () => <section data-testid="native-context"/> }));
vi.mock("./account-tables", () => ({ AccountTables: () => <section data-testid="accounts"/> }));
vi.mock("./order-ticket", () => ({ OrderTicket: () => <section data-testid="ticket"/> }));
vi.mock("./ostium-order-ticket", () => ({ OstiumOrderTicket: () => <section data-testid="native-ticket"/> }));
vi.mock("./wallet-roles", () => ({ WalletRoles: () => null }));
vi.mock("./spot-swap", () => ({ SpotSwap: () => <section data-testid="spot-swap"/> }));

beforeEach(() => { state.venue = "hyperliquid"; state.symbol = "ETH"; state.activeMarket = undefined; });

describe("continuous trading terminal", () => {
  it("does not label the next venue with the previous venue's asset", () => {
    state.venue = "uniswap"; state.symbol = "BTC";
    state.activeMarket = { venue: "hyperliquid", symbol: "BTC", midPrice: "90000", quoteAsset: "USDC", observedAt: Date.now() };
    const markup = renderToStaticMarkup(<Terminal/>);
    expect(markup).toContain('data-testid="spot-swap"');
    expect(markup).not.toContain('<strong>BTC</strong>');
    expect(markup).not.toContain("90,000");
  });

  it("shows the selected asset once a matching venue snapshot arrives", () => {
    state.activeMarket = { venue: "hyperliquid", symbol: "ETH", midPrice: "3000", quoteAsset: "USDC", observedAt: Date.now() };
    expect(renderToStaticMarkup(<Terminal/>)).toContain('aria-label="Select market, ETH"');
  });

  it("keeps the market and account stack independent of ticket height", () => {
    const markup = renderToStaticMarkup(<Terminal/>);
    expect(markup).toContain('class="trade-market-stack"><div class="trade-market-grid">');
    expect(markup).toContain('<div class="trade-tables-row"><section data-testid="accounts"></section></div></div><div class="trade-ticket-column">');
    expect(markup).toContain('data-testid="chart"');
    expect(markup).toContain('data-testid="market-context"');
  });

  it("shows a dedicated swap immediately without the perpetual terminal shell", () => {
    state.venue = "uniswap"; state.symbol = "WETH/USDC";
    const markup = renderToStaticMarkup(<Terminal/>);
    expect(markup).not.toContain('data-testid="chart"');
    expect(markup).toContain('data-testid="spot-swap"');
    for (const text of ["market-context", "accounts", "trade-mobile-tabs", "24h", "Unrealized", "Take over"]) expect(markup).not.toContain(text);
  });

  it("preserves native venue chart, context, ticket and account controls", () => {
    state.venue = "ostium"; state.symbol = "XAU/USD";
    const markup = renderToStaticMarkup(<Terminal/>);
    for (const name of ["chart", "native-context", "native-ticket", "accounts"]) expect(markup).toContain(`data-testid="${name}"`);
  });

  it("declares borderless panes, a flexible chart and dark native options", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain('.trade-route .chart-canvas { flex: 1 1 auto; min-height: 0; height: auto; }');
    expect(css).toContain('.trade-route .account-tables { border: 0; border-radius: 0; }');
    expect(css).toContain('.trade-route select { color-scheme: dark; color: var(--fg); }');
    expect(css).toContain('.trade-route select option { background: var(--surface-2); color: var(--fg); }');
    expect(css).toContain('[data-mobile-view="market"] [data-venue="uniswap"] .trade-depth-column');
  });

  it("uses the landing-style wordmark without a fabricated sidebar emblem", () => {
    const source = readFileSync(new URL("../workspace/workspace-shell.tsx", import.meta.url), "utf8");
    const brand = source.match(/<Link className="workspace-brand".*?<\/Link>/)?.[0];
    expect(brand).toContain('<span>orcus<span>.</span></span>');
    expect(brand).not.toContain("<img");
  });
});
