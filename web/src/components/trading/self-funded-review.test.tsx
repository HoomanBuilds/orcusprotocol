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
    for (const text of ["Trading account pays Sepolia ETH", "Gas funding address on Ethereum Sepolia", trading, owner, "0.003 ETH", "not a fee estimate", "not the session signer", "no automatic top-ups", "Sign and execute"]) expect(markup).toContain(text);
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
