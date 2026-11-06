import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "./terminal";

const state = vi.hoisted(() => ({ venue: "hyperliquid", symbol: "ETH" }));
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

beforeEach(() => { state.venue = "hyperliquid"; state.symbol = "ETH"; });

describe("continuous trading terminal", () => {
  it("keeps the market and account stack independent of ticket height", () => {
    const markup = renderToStaticMarkup(<Terminal/>);
    expect(markup).toContain('class="trade-market-stack"><div class="trade-market-grid">');
    expect(markup).toContain('<div class="trade-tables-row"><section data-testid="accounts"></section></div></div><div class="trade-ticket-column">');
    expect(markup).toContain('data-testid="chart"');
    expect(markup).toContain('data-testid="market-context"');
  });

  it("uses real spot execution details instead of mounting an unsupported candle chart", () => {
    state.venue = "uniswap"; state.symbol = "WETH/USDC";
    const markup = renderToStaticMarkup(<Terminal/>);
    expect(markup).not.toContain('data-testid="chart"');
    expect(markup).toContain('data-testid="market-context"');
    expect(markup).toContain('data-venue="uniswap"');
    expect(markup).toContain('class="selected">Swap</button>');
    expect(markup).not.toContain('>Depth</button>');
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
