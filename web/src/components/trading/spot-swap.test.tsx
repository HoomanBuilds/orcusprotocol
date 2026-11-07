import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/use-workspace";
import { createDemoData } from "@/lib/demo-workspace-data";
import { SpotSwap, swapInputIssue, swapRequest } from "./spot-swap";

const demo = createDemoData();
const workspace = {
  ...demo, account: demo.session.accounts.find(account => account.venue === "uniswap"),
  venue: "uniswap", symbol: "WETH/USDC", resourceErrors: {}, actions: [], preview: null,
  walletConfig: { chainId: 11155111, smartAccountsConfigured: true, gasPayment: { mode: "self-funded", payer: "smart-account", chainId: 11155111, maxOperationGasWei: "3000000000000000" } },
} as unknown as Workspace;

function markup(overrides: Partial<Workspace> = {}) { return renderToStaticMarkup(<SpotSwap workspace={{ ...workspace, ...overrides }} onSetup={vi.fn()}/>); }

describe("focused spot swap", () => {
  it("shows the swap card, real token assets and only this account's holdings", () => {
    const html = markup();
    for (const text of ["You pay", "You receive", "Review swap", "4,500", "1.2", "0.12", "/landing/tokens/USDC.svg", "/landing/tokens/WETH.png", "Pay token"]) expect(html).toContain(text);
    for (const text of ["Unrealized", "Open positions", "Open orders", "24h", "25,754", "10,175", "XAU", "Owner wallet", "Agent operating wallet"]) expect(html).not.toContain(text);
    expect(html).toContain("Quoted when you review");
    expect(html).toContain('<details');
  });

  it("keeps gas execution unavailable instead of pretending swaps can run", () => {
    expect(markup({ walletConfig: null })).toContain("Swap execution is temporarily unavailable");
  });

  it("shows unknown balances on a failed portfolio fetch, not stale values", () => {
    const html = markup({ resourceErrors: { portfolio: "offline" } });
    expect(html).toContain("Balances could not refresh");
    expect(html).not.toContain("4,500");
  });

  it("requires wallet connection or trading account setup", () => {
    expect(markup({ account: undefined, session: { user: null, accounts: [], agent: null } })).toContain("Connect wallet");
    expect(markup({ account: undefined })).toContain("Set up trading account");
  });

  it("shows only this account's activity and pauses duplicate pending swaps", () => {
    const swap = demo.actions.find(action => action.request.venue === "uniswap")!;
    const actions = [
      { ...swap, id: "pending", accountId: workspace.account!.id, status: "submitted-unknown" as const },
      { ...swap, id: "other", accountId: "other-user-account", transactionHash: `0x${"f".repeat(64)}` },
    ];
    const html = markup({ actions });
    expect(html).toContain("Your previous swap needs a status check");
    expect(html).toContain("Check status");
    expect(html).not.toContain(`0x${"f".repeat(64)}`);
    expect(markup({ actions: [actions[1]] })).not.toContain("Check status");
  });
});

describe("spot amount and route handling", () => {
  it("keeps exact input precision and routes native ETH explicitly", () => {
    expect(swapRequest("account", "USDC", "10.123456", "0.5")).toMatchObject({ amount: "10.123456", side: "buy", symbol: "WETH/USDC", slippageBps: 50 });
    expect(swapRequest("account", "WETH", "0.000000000000000001", "0.01")).toMatchObject({ side: "sell", amount: "0.000000000000000001", slippageBps: 1 });
    expect(swapRequest("account", "WETH", "1", "5").nativeInput).toBeUndefined();
    expect(swapRequest("account", "ETH", "0.1", "0.5")).toMatchObject({ side: "sell", nativeInput: true });
    expect(() => swapRequest("account", "USDC", "1", "5.01")).toThrow();
  });

  it("checks amounts without floating-point balance comparisons", () => {
    expect(swapInputIssue("", "USDC")).toBeUndefined();
    expect(swapInputIssue("10.123456", "USDC", "10.123456")).toBeUndefined();
    expect(swapInputIssue("0.100000000000000001", "WETH", "0.1")).toContain("Not enough");
    expect(swapInputIssue("1.0000001", "USDC")).toContain("6 decimal places");
    for (const amount of ["-1", "1e3", "NaN", "Infinity", "01", "0.", "9".repeat(81)]) expect(swapInputIssue(amount, "ETH")).toBe("Enter a valid amount.");
    expect(swapInputIssue("0", "ETH")).toContain("above zero");
    expect(swapInputIssue("0.000000000000000001", "ETH")).toBeUndefined();
  });
});
