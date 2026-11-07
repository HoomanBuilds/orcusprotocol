import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/use-workspace";
import { OrderTicket } from "./order-ticket";

const state = vi.hoisted(() => ({ amount: "0.0001", index: 0 }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => [initial === "" && state.index++ === 0 ? state.amount : initial, vi.fn()] };
});
vi.mock("../workspace/asset-icon", () => ({ AssetIcon: () => null }));

const workspace = {
  venue: "hyperliquid", symbol: "ETH", actions: [], session: { user: { address: "0x1111111111111111111111111111111111111111" } },
  account: { id: "account", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111" },
  portfolio: { balances: [], positions: [] },
  activeMarket: { venue: "hyperliquid", symbol: "ETH", baseAsset: "ETH", quoteAsset: "USDC", midPrice: "2269.1", sizeDecimals: 4, observedAt: Date.now() },
} as unknown as Workspace;

beforeEach(() => { state.index = 0; state.amount = "0.0001"; });

describe("Hyperliquid order minimum presentation", () => {
  it("labels base units and blocks review below the venue minimum", () => {
    const html = renderToStaticMarkup(<OrderTicket workspace={workspace} onSetup={() => undefined} />);
    expect(html).toContain("Amount (ETH)");
    expect(html).toContain("Minimum 10 USDC (0.0045 ETH at this price).");
    expect(html).toMatch(/disabled=""[^>]*>Review order/);
  });
  it("enables review once the size meets the current minimum", () => {
    state.amount = "0.0045";
    const html = renderToStaticMarkup(<OrderTicket workspace={workspace} onSetup={() => undefined} />);
    expect(html).not.toMatch(/disabled=""[^>]*>Review order/);
    expect(html).not.toContain("Minimum 10 USDC");
  });
  it("does not present a calculated minimum from stale market data", () => {
    const html = renderToStaticMarkup(<OrderTicket workspace={{ ...workspace, activeMarket: { ...workspace.activeMarket!, observedAt: Date.now() - 31_000 } }} onSetup={() => undefined} />);
    expect(html).toContain("Waiting for a fresh price");
    expect(html).not.toContain("Minimum 10 USDC");
    expect(html).toMatch(/disabled=""[^>]*>Review order/);
  });
});
