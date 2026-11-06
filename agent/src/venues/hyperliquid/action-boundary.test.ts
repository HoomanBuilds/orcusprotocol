import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount, TradeRequest } from "@orcus/core";
import { prepareHyperliquidAction } from "./index";

const account: TradingAccount = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", chainId: 421614, status: "connected", controlRevision: 0 };
const request: TradeRequest = { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "manual" };
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetch = vi.fn(() => { throw new Error("Unexpected venue request"); });
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["manual", "agent"] as const)("Hyperliquid %s action boundary", mode => {
  it.each(["swap", "stop", "edit-order", "add-collateral", "remove-collateral"] as const)("rejects unsupported %s before reading or preparing an order", async type => {
    await expect(prepareHyperliquidAction({ ...request, mode, type }, account)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["uniswap", "ostium"] as const)("rejects a %s request before contacting Hyperliquid", async venue => {
    await expect(prepareHyperliquidAction({ ...request, mode, venue, ...(venue === "ostium" ? { amountUnit: "collateral-usdc" as const, leverage: 2 } : {}) }, account)).rejects.toMatchObject({ code: "VENUE_MISMATCH" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
