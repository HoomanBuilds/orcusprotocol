import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "@orcus/core";
import { WalletRoles } from "./wallet-roles";

vi.mock("./primitives", () => ({ Address: ({ value }: { value?: string }) => value ?? "Not created" }));
const owner = `0x${"1".repeat(40)}`, trading = `0x${"2".repeat(40)}`, operating = `0x${"3".repeat(40)}`;
const account: TradingAccount = { id: "account", userId: "owner", ownerAddress: owner, address: trading, venue: "uniswap", chainId: 11155111, status: "connected", controlRevision: 0 };

describe("distinct wallet roles", () => {
  it("labels owner, trading principal and operating costs separately without inventing shared addresses", () => {
    const markup = renderToStaticMarkup(<WalletRoles owner={owner} account={account} operatingAddress={operating} />);
    for (const text of ["Owner wallet", "Smart trading account", "Agent operating wallet", "Trading principal", "Separate service costs", owner, trading, operating]) expect(markup).toContain(text);
  });
  it("shows the same owner address honestly for a venue account and hides signed-out private roles", () => {
    const markup = renderToStaticMarkup(<WalletRoles owner={owner} account={{ ...account, address: owner, venue: "hyperliquid" }} operatingAddress={operating} />);
    expect(markup).toContain("Hyperliquid trading account");
    expect(renderToStaticMarkup(<WalletRoles />)).toBe("");
  });
});
