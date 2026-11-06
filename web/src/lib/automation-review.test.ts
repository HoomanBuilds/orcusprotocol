import { describe, expect, it } from "vitest";
import type { TradingAccount } from "@orcus/core";
import { executionLabel, reviewAutomation, triggerLabel } from "./automation-review";

const account = { id: "account", venue: "hyperliquid" } as TradingAccount;
const draft = { kind: "trade", name: "ETH once", accountId: account.id, intervalSeconds: 300, executionMode: "once", maxExecutions: 1, request: { accountId: account.id, venue: account.venue, type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, mode: "agent" }, condition: { symbol: "ETH", operator: "below", price: "2000" } };

describe("explicit automation review", () => {
  it("retains the exact action, condition and bounded once-only policy", () => {
    expect(reviewAutomation(draft, [account])).toMatchObject(draft);
    expect(executionLabel("once")).toBe("Run once");
    expect(triggerLabel(reviewAutomation(draft, [account]))).toBe("ETH below 2000 at evaluation");
  });
  it.each([
    { executionMode: undefined }, { executionMode: "always" }, { maxExecutions: 2 }, { maxExecutions: 0 },
    { executionMode: "recurring", maxExecutions: undefined }, { executionMode: "recurring", maxExecutions: 1001 },
    { executionMode: "on-crossing", condition: undefined }, { request: undefined, instruction: "Buy when RSI is low" },
    { condition: { symbol: "BTC", operator: "above", price: "2000" } }, { expiresAt: 100 },
    { condition: { symbol: "ETH", operator: "above", price: "1e3" } },
    { condition: { symbol: "ETH", operator: "above", price: "0" } },
    { condition: { symbol: "ETH", operator: "above", price: "1.000000001" } },
  ])("refuses an incomplete or unsafe policy %j", change => expect(() => reviewAutomation({ ...draft, ...change }, [account], 100)).toThrow());
  it("requires the exact connected owner account and rejects a trade inside a read-only alert", () => {
    expect(() => reviewAutomation(draft, [])).toThrow("connected account");
    expect(() => reviewAutomation({ ...draft, kind: "alert" }, [account])).toThrow("cannot contain a trade");
    expect(() => reviewAutomation({ ...draft, request: { ...draft.request, accountId: "other" } }, [account])).toThrow("different account");
  });
  it("distinguishes a scheduled repeat from a crossing that first arms", () => {
    expect(executionLabel("recurring", "alert")).toBe("Notify on match, then after rearming");
    expect(executionLabel("recurring", "trade")).toBe("Repeat at each interval");
    const repeat = reviewAutomation({ ...draft, condition: undefined, executionMode: "recurring", maxExecutions: 5 }, [account]);
    expect(triggerLabel(repeat)).toBe("Scheduled execution, no price condition");
    expect(triggerLabel({ ...repeat, executionMode: "on-crossing", condition: { symbol: "ETH", operator: "below", price: "2000" } })).toContain("after a new crossing");
  });
});
