import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/use-workspace";
import { ActionPreview } from "./action-preview";

vi.mock("./primitives", () => ({
  Address: ({ value }: { value?: string }) => <span>{value ?? "Unavailable"}</span>,
  InlineError: ({ message }: { message?: string }) => message ?? null,
  Spinner: () => "Loading",
}));

const owner = `0x${"1".repeat(40)}`;
const trading = `0x${"2".repeat(40)}`;
const agent = `0x${"3".repeat(40)}`;
const workspace = {
  walletConfig: { chainId: 11155111, smartAccountsConfigured: true, gasPayment: { mode: "self-funded", payer: "smart-account", chainId: 11155111, maxOperationGasWei: "3000000000000000" } },
  preview: {
    execution: {
      expiresAt: Date.now() + 60_000,
      account: { address: trading, smartAccountAddress: trading, ownerAddress: owner, agentAddress: agent, venue: "uniswap", chainId: 11155111 },
      request: { venue: "uniswap", type: "swap", side: "buy", symbol: "WETH/USDC", amount: "10", mode: "manual", slippageBps: 50 },
    },
  },
  executing: false,
  error: null,
} as unknown as Workspace;

describe("self-funded operation review", () => {
  it("shows the payer, network and cap before owner signing without promising an exact fee", () => {
    const markup = renderToStaticMarkup(<ActionPreview workspace={workspace} />);
    for (const text of ["Trading account pays Sepolia ETH", "Gas paid by", "Recipient", trading, owner, "0.003 ETH", "not a fee estimate", "not the session signer", "no automatic top-ups", "Sign and execute"]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/sponsor|paymaster|gas covered/i);
  });
  it("keeps the action unavailable when the bundler configuration is missing", () => {
    const markup = renderToStaticMarkup(<ActionPreview workspace={{ ...workspace, walletConfig: { ...workspace.walletConfig!, smartAccountsConfigured: false } }} />);
    expect(markup).toMatch(/disabled=""[^>]*>Smart-account execution unavailable/);
    expect(markup).toContain(trading);
  });
  it("uses the same gas account for agent execution", () => {
    const preview = workspace.preview!;
    const markup = renderToStaticMarkup(<ActionPreview workspace={{ ...workspace, preview: { ...preview, execution: { ...preview.execution, request: { ...preview.execution.request, mode: "agent" } } } }} />);
    expect(markup).toContain("Execute with agent");
    expect(markup).toContain("Manual and agent actions spend gas from that same account");
    expect(markup).toContain(trading);
  });
});

describe("focused Uniswap review", () => {
  function render(execution: Partial<NonNullable<Workspace["preview"]>["execution"]> = {}, state: Partial<Workspace> = {}) {
    return renderToStaticMarkup(<ActionPreview workspace={{ ...workspace, ...state, preview: { ...workspace.preview!, execution: { ...workspace.preview!.execution, ...execution } } }} />);
  }

  it("displays precise token units and real icons without inventing fiat values", () => {
    const markup = render({ quote: { amountIn: "10", amountOut: "0.000001234567891234", minimumOut: "0.000001228395051777", observedAt: Date.now() } });
    for (const text of ["You pay", "10 USDC", "You receive, estimated", "0.000001234567891234 WETH", "Minimum received", "0.000001228395051777 WETH", "/landing/tokens/USDC.svg", "/landing/tokens/WETH.png"]) expect(markup).toContain(text);
    expect(markup).not.toContain("$");
    expect(markup).toMatch(/<details[^>]*><summary>Execution details/);
    expect(markup).not.toMatch(/<details[^>]*\bopen/);
  });

  it("does not invent an output when a quote is absent", () => {
    const markup = render({ quote: undefined });
    expect(markup).toMatch(/You receive, estimated<\/span><strong>Unavailable/);
    expect(markup).toMatch(/Minimum received<\/dt><dd>Unavailable/);
  });

  it("keeps errors and execution warnings outside the collapsed details", () => {
    const markup = render({ warnings: ["Pool liquidity is low."] }, { error: "Insufficient gas." });
    expect(markup.indexOf("Pool liquidity is low.")).toBeGreaterThan(markup.indexOf("</details>"));
    expect(markup.indexOf("Insufficient gas.")).toBeGreaterThan(markup.indexOf("</details>"));
  });

  it("blocks expired quotes", () => {
    const markup = render({ expiresAt: Date.now() - 1000 });
    expect(markup).toMatch(/disabled=""[^>]*>Quote expired/);
  });

  it("locks cancel and close while execution is in progress", () => {
    const markup = render({}, { executing: true });
    expect(markup).toMatch(/aria-label="Close confirmation" disabled=""/);
    expect(markup).toMatch(/disabled=""[^>]*>Cancel/);
    expect(markup).toMatch(/disabled=""[^>]*>LoadingConfirming in wallet/);
  });

  it("blocks unverified native input instead of presenting it as a valid wrap", () => {
    const markup = render({ request: { ...workspace.preview!.execution.request, side: "sell", nativeInput: true } });
    expect(markup).toContain("native ETH wrapping plan could not be verified");
    expect(markup).toMatch(/disabled=""[^>]*>Native input plan unavailable/);
    expect(markup).not.toContain("ETH wraps to WETH as part of this swap.");
  });

  it("shows a verified native input as ETH with a short wrap note", () => {
    const markup = render({
      kind: "user-operation",
      request: { ...workspace.preview!.execution.request, side: "sell", nativeInput: true, amount: "0.01", tokenIn: owner },
      transactions: [
        { chainId: 11155111, to: owner, data: "0xd0e30db0", value: "10000000000000000" },
        { chainId: 11155111, to: owner, data: "0x", value: "0" },
      ],
      quote: { amountIn: "0.01", amountOut: "256.817812", minimumOut: "255.533722", observedAt: Date.now() },
    });
    expect(markup).toContain("0.01 ETH");
    expect(markup).toContain("256.817812 USDC");
    expect(markup).toContain("ETH wraps to WETH as part of this swap.");
    expect(markup).not.toContain("Native input plan unavailable");
  });

  it("does not apply the swap layout to Hyperliquid", () => {
    const markup = render({ request: { ...workspace.preview!.execution.request, venue: "hyperliquid", type: "market", symbol: "ETH" } });
    expect(markup).toContain("Confirm your order");
    expect(markup).toContain("REVIEW BEFORE EXECUTION");
    expect(markup).not.toContain("You receive, estimated");
    expect(markup).not.toContain("Execution details");
  });
});
