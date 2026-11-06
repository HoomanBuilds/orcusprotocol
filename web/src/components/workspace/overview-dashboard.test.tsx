import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../lib/use-workspace";
import { OverviewDashboard } from "./overview-dashboard";

const state = vi.hoisted(() => ({ workspace: {} as Workspace }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => state.workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const account = { id: "account-a", userId: "user-a", venue: "hyperliquid" as const, address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "connected" as const, controlRevision: 0 };
const render = () => renderToStaticMarkup(<OverviewDashboard/>);

beforeEach(() => {
  state.workspace = {
    session: { user: { id: "user-a" }, agent: { mode: "approval", paused: false }, accounts: [account] },
    portfolio: { accounts: [account], balances: [], positions: [], orders: [], observedAt: 1, totalEquityUsd: "0" },
    resourceErrors: {}, actions: [], requests: [], budget: null, payments: null, funding: null, tradingDeposits: [], ostiumAllowances: [],
    agentData: null, automations: [], markets: [{ symbol: "ETH", midPrice: "2200", change24h: 2 }], venue: "hyperliquid", loading: false,
  } as unknown as Workspace;
});

describe("account overview", () => {
  it("keeps market cards and removes promotional account tiles", () => {
    const html = render();
    expect(html).toContain("overview-market-cards");
    expect(html).toContain("$2,200.00");
    expect(html).toContain("Trading accounts");
    expect(html).not.toContain("Plan it.");
    expect(html).not.toContain("overview-paper-card");
    expect(html).not.toContain("/workspace/orcus.svg");
  });
  it("does not turn unavailable snapshots, budgets or schedules into healthy zeroes", () => {
    state.workspace.resourceErrors = { portfolio: "offline", automations: "offline", budget: "offline" };
    state.workspace.budget = { availableUsd: "42", spentUsd: "0", reservedUsd: "0" } as Workspace["budget"];
    const html = render();
    expect(html).toContain("Snapshot unavailable");
    expect(html).toContain("Schedules could not be loaded");
    expect(html).not.toContain("0 active");
    expect(html).not.toContain("$42.00");
    expect(html).not.toContain("No open positions or orders.");
    expect(html).not.toContain("$0.00");
  });
  it("separates actual trading collateral from the operating cap", () => {
    state.workspace.portfolio.balances = [{ accountId: account.id, symbol: "USDC", amount: "125", usdValue: "125" }];
    state.workspace.budget = { availableUsd: "7", spentUsd: "2", reservedUsd: "1" } as Workspace["budget"];
    const html = render();
    expect(html).toContain("125 USDC");
    expect(html).toContain("Trading collateral");
    expect(html).toContain("Agent expense cap, separate from trading capital.");
    expect(html).toContain("$7.00");
    expect(html).toContain("Reserved");
    expect(html).toContain('href="/settings?section=budget"');
    expect(html).not.toContain('href="/settings?section=agent"');
  });
  it("does not infer an empty balance for an account missing from the snapshot", () => {
    state.workspace.portfolio.accounts = [];
    expect(render()).toContain("Balances unavailable. Refresh to check again.");
  });
  it("shows pending work and typed collateral order units", () => {
    state.workspace.requests = [{ id: "request-a", message: "Review ETH", status: "running", createdAt: 2 }] as Workspace["requests"];
    state.workspace.portfolio.orders = [{ id: "order-a", accountId: "account-a", venue: "ostium", symbol: "ETH/USD", side: "buy", type: "limit", size: "100", collateralUsd: "100", amountUnit: "collateral-usdc", reduceOnly: false, createdAt: 1 }];
    const html = render();
    expect(html).toContain("Review ETH");
    expect(html).toContain("100 USDC collateral");
    expect(html).not.toContain("100 ETH/USD");
  });
  it("never leaks prior owner data after disconnect", () => {
    state.workspace.session.user = null;
    state.workspace.portfolio.positions = [{ id: "old", symbol: "PRIVATE", unrealizedPnl: "99" }] as Workspace["portfolio"]["positions"];
    state.workspace.automations = [{ id: "old", name: "Old owner strategy", status: "active" }] as Workspace["automations"];
    const html = render();
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain("PRIVATE");
    expect(html).not.toContain("Old owner strategy");
    expect(html).toContain("Trading account totals");
    expect(html).toContain("All your accounts.");
    expect(html).toContain("<strong>--</strong>");
    expect(html).not.toContain("Connect to view saved activity");
    expect(html).not.toContain("Operating allowance");
    expect(html).not.toContain("$0.00");
  });
});
