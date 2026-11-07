import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentPermission, TradingAccount } from "@orcus/core";
import type { Workspace } from "../../lib/use-workspace";
import { AccountCard } from "./settings-view";

vi.mock("../../lib/wallets", () => ({}));
vi.mock("./venue-symbol-picker", () => ({ VenueSymbolPicker: () => <div>Market selector</div> }));
vi.mock("./memory-controls", () => ({ MemoryControls: () => null }));
vi.mock("./compute-funding-panel", () => ({ ComputeFundingPanel: () => null }));
vi.mock("./service-payment-panel", () => ({ ServicePaymentPanel: () => null }));
vi.mock("./expense-billing-check", () => ({ ExpenseBillingCheck: () => null }));
vi.mock("./ostium-account-card", () => ({ OstiumAccountCard: () => null }));

const account: TradingAccount = {
  id: "account", userId: "user", venue: "uniswap", chainId: 11155111,
  address: `0x${"1".repeat(40)}`, ownerAddress: `0x${"2".repeat(40)}`,
  agentAddress: `0x${"3".repeat(40)}`, status: "connected", controlRevision: 0,
};
const permission: AgentPermission = {
  id: "permission", accountId: account.id, agentAddress: account.agentAddress!,
  allowedSymbols: ["WETH/USDC"], allowedActions: ["market"], maxTradeUsd: "100",
  expiresAt: Date.now() + 3_600_000, status: "active", enforcement: "account",
};
function render(permissions: AgentPermission[] = [], paused = false, venue = account.venue) {
  const workspace = {
    agentData: { permissions, agent: { paused } },
    portfolio: { balances: [{ accountId: account.id, symbol: "USDC", amount: "100" }, { accountId: "other", symbol: "USDC", amount: "999" }] },
    walletConfig: { chainId: 11155111, smartAccountsConfigured: true, gasPayment: { mode: "self-funded", payer: "smart-account", chainId: 11155111 } },
  } as unknown as Workspace;
  return renderToStaticMarkup(<AccountCard account={{ ...account, venue }} workspace={workspace}/>);
}

describe("compact trading account settings", () => {
  it("keeps setup optional and does not render permission forms by default", () => {
    const html = render();
    expect(html).toContain("Set up agent");
    expect(html).toContain("Agent not enabled");
    expect(html).not.toContain("Maximum per trade");
    expect(html).not.toContain("Review agent access");
    expect(html).toContain("100 USDC");
    expect(html).not.toContain("999 USDC");
    expect(html).toMatch(/<details[^>]*><summary>Account details/);
    expect(html).toMatch(/<details[^>]*><summary>Add trading funds/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("shows valid active access without opening destructive controls", () => {
    const html = render([permission]);
    expect(html).toContain("Agent enabled");
    expect(html).toContain("Manage agent");
    expect(html).not.toContain("Revoke agent access");
    expect(html).toMatch(/<details[^>]*><summary>Advanced access controls/);
  });

  it("does not claim an expired permission is enabled", () => {
    const html = render([{ ...permission, expiresAt: Date.now() - 1 }]);
    expect(html).toContain("Agent access expired");
    expect(html).not.toContain("Agent enabled");
    expect(html).toContain("Manage agent");
  });

  it("distinguishes globally paused access from enabled access", () => {
    const html = render([permission], true);
    expect(html).toContain("Agent paused");
    expect(html).not.toContain("Agent enabled");
  });

  it("does not inherit another account's permission", () => {
    expect(render([{ ...permission, accountId: "other" }])).toContain("Agent not enabled");
  });

  it("does not present smart account deposits or ETH gas for Hyperliquid", () => {
    const html = render([], false, "hyperliquid");
    expect(html).toContain("Hyperliquid Testnet");
    expect(html).not.toContain("Add trading funds");
    expect(html).not.toContain("Trading account gas");
    expect(html).toContain("Trade yourself or let your agent manage the same positions");
  });
});
