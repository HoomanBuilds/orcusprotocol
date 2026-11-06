import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "@orcus/core";
import { buildAgentTools } from "./tools";
import * as venue from "../venues/hyperliquid";

const account: TradingAccount = { id: "account", userId: "owner", ownerAddress: `0x${"1".repeat(40)}`, address: `0x${"1".repeat(40)}`, venue: "hyperliquid", chainId: 421614, status: "authorized", controlRevision: 0 };
afterEach(() => vi.restoreAllMocks());

describe("explicit position selection", () => {
  it.each(["whether we should close it", "close something", "close it", "close alice.eth", "close ETH or BTC", "close BTC"])("requires clarification for %s with multiple open positions", async message => {
    vi.spyOn(venue, "getHyperliquidPortfolio").mockResolvedValue({ accountId: account.id, balances: [], orders: [], positions: ["ETH", "BTC"].map(symbol => ({ id: symbol, accountId: account.id, venue: "hyperliquid", symbol, side: "long", size: "1", entryPrice: "2000", unrealizedPnl: "0", observedAt: Date.now() })), observedAt: Date.now() });
    const tool = buildAgentTools({ account, accounts: [account] }, message).get("propose_action")!;
    await expect(tool.run({ request: { accountId: account.id, venue: "hyperliquid", type: "close", symbol: "ETH", side: "sell", amount: "1" } })).rejects.toThrow("Ask which position");
  });
  it.each(["close ETH", "close $ETH", "reduce ETH/USDC", "set a stop for eth-perp"])("permits one explicitly named instrument in %s", async message => {
    vi.spyOn(venue, "getHyperliquidPortfolio").mockResolvedValue({ accountId: account.id, balances: [], orders: [], positions: ["ETH", "BTC"].map(symbol => ({ id: symbol, accountId: account.id, venue: "hyperliquid", symbol, side: "long", size: "1", entryPrice: "2000", unrealizedPnl: "0", observedAt: Date.now() })), observedAt: Date.now() });
    const tool = buildAgentTools({ account, accounts: [account] }, message).get("propose_action")!;
    await expect(tool.run({ request: { accountId: account.id, venue: "hyperliquid", type: "close", symbol: "ETH", side: "sell", amount: "1" } })).resolves.toHaveProperty("proposal");
  });
});
