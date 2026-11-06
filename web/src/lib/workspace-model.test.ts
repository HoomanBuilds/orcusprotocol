import { describe, expect, it } from "vitest";
import type { ActionRecord, Portfolio, TradingAccount } from "@orcus/core";
import { actionReviewIssue, activityEntries, activityTime, filterActivity, portfolioSummary, type AgentRequestSummary, type FundingSnapshot } from "./workspace-model";

const account: TradingAccount = { id: "account", userId: "owner", address: `0x${"1".repeat(40)}`, ownerAddress: `0x${"2".repeat(40)}`, venue: "hyperliquid", chainId: 421614, status: "connected", controlRevision: 2 };
const request = { accountId: account.id, venue: "hyperliquid" as const, symbol: "ETH", type: "market" as const, side: "buy" as const, amount: "0.1", slippageBps: 50, reduceOnly: false, mode: "manual" as const };
const action: ActionRecord = { id: "action", userId: "owner", accountId: account.id, request, status: "awaiting-approval", initiator: "manual", createdAt: 10, updatedAt: 10, prepared: { id: "action", request, account, kind: "hyperliquid", expiresAt: 2000, controlRevision: 2 } };
const portfolio: Portfolio = { accounts: [account], balances: [], positions: [], orders: [], observedAt: 1000 };
const agentRequest: AgentRequestSummary = { id: "request", requestId: "request", runId: "run-1", message: "Review ETH exposure", autonomous: false, status: "queued", createdAt: 20 };
const empty = { actions: [], requests: [], budget: null, payments: null, funding: null };

describe("saved owner action review", () => {
  it("reopens only a current owner's unexpired, unchanged prepared action", () => {
    expect(actionReviewIssue(action, "owner", [account], 1000)).toBeNull();
    expect(actionReviewIssue(action, undefined, [account], 1000)).toMatch(/owner/);
    expect(actionReviewIssue(action, "other", [account], 1000)).toMatch(/owner/);
    expect(actionReviewIssue(action, "owner", [account], 2000)).toMatch(/expired/);
    expect(actionReviewIssue({ ...action, prepared: undefined }, "owner", [account], 1000)).toMatch(/expired/);
  });
  it.each(["submitting", "submitted-unknown", "pending", "partially-filled", "confirmed", "rejected", "cancelled"] as const)("does not offer another submission for %s", status => {
    expect(actionReviewIssue({ ...action, status }, "owner", [account], 1000)).toMatch(/already submitted or closed/);
  });
  it("rejects a removed, switched or revised account and mismatched prepared payload", () => {
    expect(actionReviewIssue(action, "owner", [], 1000)).toMatch(/authorization changed/);
    for (const replacement of [{ ...account, userId: "other" }, { ...account, controlRevision: 3 }, { ...account, ownerAddress: `0x${"3".repeat(40)}` }, { ...account, venue: "uniswap" as const }]) expect(actionReviewIssue(action, "owner", [replacement], 1000)).toMatch(/authorization changed/);
    expect(actionReviewIssue({ ...action, prepared: { ...action.prepared!, account: { ...account, id: "other" } } }, "owner", [account], 1000)).toMatch(/authorization changed/);
    expect(actionReviewIssue({ ...action, prepared: { ...action.prepared!, request: { ...request, accountId: "other" } } }, "owner", [account], 1000)).toMatch(/authorization changed/);
  });
});

describe("observed portfolio summary", () => {
  it("never invents a valuation and distinguishes unobserved from observed empty", () => {
    expect(portfolioSummary(portfolio, false)).toMatchObject({ observed: false, equity: undefined, exposure: undefined, pnl: undefined });
    expect(portfolioSummary({ ...portfolio, observedAt: 0 }, true).observed).toBe(false);
    expect(portfolioSummary(portfolio, true)).toMatchObject({ complete: true, equity: undefined, exposure: 0, pnl: 0 });
    expect(portfolioSummary({ ...portfolio, totalEquityUsd: "0" }, true).equity).toBe("0");
  });
  it("keeps partial, missing-mark, malformed and overflow values unavailable", () => {
    const position = { id: "position", accountId: account.id, venue: "hyperliquid" as const, symbol: "ETH", side: "long" as const, size: "2", entryPrice: "100", markPrice: "110", unrealizedPnl: "20", observedAt: 1000 };
    const snapshot = { ...portfolio, positions: [position], totalEquityUsd: "300" };
    expect(portfolioSummary(snapshot, true)).toMatchObject({ pnl: 20, exposure: 220, equity: "300" });
    expect(portfolioSummary(snapshot, true, true).equity).toBeUndefined();
    expect(portfolioSummary({ ...snapshot, errors: [{ accountId: account.id, message: "Feed unavailable" }] }, true).pnl).toBeUndefined();
    for (const value of [undefined, "", "NaN", "1e309", "9".repeat(400)]) expect(portfolioSummary({ ...snapshot, positions: [{ ...position, markPrice: value }] }, true).exposure).toBeUndefined();
    expect(portfolioSummary({ ...snapshot, positions: [{ ...position, unrealizedPnl: "" }] }, true).pnl).toBeUndefined();
    expect(portfolioSummary({ ...snapshot, totalEquityUsd: "" }, true).equity).toBeUndefined();
  });
});

describe("persisted activity presentation", () => {
  it("combines recorded sources without inventing times, fills or provider credits", () => {
    const funding: FundingSnapshot = { status: "configured", intents: [{ id: "native", status: "confirmed", amountWei: "1", createdAt: 30 }] };
    const entries = activityEntries({ ...empty, actions: [action], requests: [agentRequest], funding, deposits: [{ accountId: account.id, status: "unknown" }] });
    expect(entries.map(entry => entry.id)).toEqual(["funding:native", "request:request", "action:action", "deposit:account"]);
    expect(entries[0]).toMatchObject({ status: "awaiting-provider-sync", pending: true });
    expect(entries.at(-1)?.createdAt).toBe(0);
    expect(activityTime(0)).toBe("Time unavailable");
    expect(activityTime(Infinity)).toBe("Time unavailable");
    expect(activityTime(1e30)).toBe("Time unavailable");
  });
  it("filters actual request IDs, statuses, kinds and initiators without changing records", () => {
    const entries = activityEntries({ ...empty, actions: [action, { ...action, id: "done", status: "confirmed", transactionHash: `0x${"a".repeat(64)}` }], requests: [agentRequest, { ...agentRequest, id: "interrupted", status: "interrupted" }] });
    expect(filterActivity(entries, { status: "pending" })).toHaveLength(2);
    expect(filterActivity(entries, { kind: "agent", query: " RUN-1 " })).toHaveLength(2);
    expect(filterActivity(entries, { initiator: "manual", status: "confirmed" }).map(entry => entry.id)).toEqual(["action:done"]);
    expect(filterActivity(entries, { query: "not found" })).toEqual([]);
    expect(entries).toHaveLength(4);
    expect(activityEntries(empty)).toEqual([]);
  });
});
