import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, parseUnits, zeroAddress, type Hex } from "viem";
import { inspectOstiumOwnerPlan, inspectPreparedOstiumAction, OSTIUM_TESTNET, ostiumTradingAbi, type OstiumPreparedAction } from "./ostium";
import { executeOstiumOwnerAction } from "./ostium-owner";

const owner = "0x1111111111111111111111111111111111111111", agent = "0x2222222222222222222222222222222222222222", other = "0x3333333333333333333333333333333333333333";
const hash = `0x${"a".repeat(64)}` as Hex;
function opening(delegated = false): OstiumPreparedAction {
  const inner = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "openTrade", args: [{ collateral: 10_000_000n, openPrice: parseUnits("2000", 18), tp: 0n, sl: 0n, trader: owner, leverage: 200, pairIndex: 7, index: 0, buy: true, isDayTrade: false }, { builder: zeroAddress, builderFee: 0 }, 0, 50n] });
  return {
    id: "trade", request: { accountId: "ostium", venue: "ostium", type: "market", symbol: "XAU/USD", side: "buy", amount: "10", amountUnit: "collateral-usdc", price: "2000", leverage: 2, slippageBps: 50, reduceOnly: false, mode: delegated ? "agent" : "manual" },
    account: { id: "ostium", userId: "owner", venue: "ostium", address: owner, ownerAddress: owner, chainId: 421614, status: "authorized", agentAddress: agent, controlRevision: 0 },
    kind: "evm", controlRevision: 0, expiresAt: Date.now() + 60_000, warnings: [],
    ostium: { pairId: 7, symbol: "XAU/USD", trader: owner, recipient: owner, chainId: 421614, amountUnit: "collateral-usdc", collateralUsd: "10", leverage: 2, builderFeeBps: 0, functionName: "openTrade", expectedData: inner, requiredAllowanceUsd: "10", notionalUsd: "20", marketObservedAt: Date.now(), minimumBlock: "100", ...(delegated ? { delegate: agent } : {}) },
    transactions: [{ chainId: 421614, value: "0", to: OSTIUM_TESTNET.trading, data: delegated ? encodeFunctionData({ abi: ostiumTradingAbi, functionName: "delegatedAction", args: [owner, inner] }) : inner }],
  };
}
function approval(amount = 10_000_000n) { return { chainId: 421614, value: "0", to: OSTIUM_TESTNET.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, amount] }) }; }
function exit(bps = 2500): OstiumPreparedAction {
  const prepared = opening();
  prepared.request = { ...prepared.request, type: "reduce", amount: "0.25", amountUnit: "base", positionId: "ostium-position:7:42", side: "sell", reduceOnly: true };
  const data = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "closeTradeMarket", args: [7, 2, bps, parseUnits("2000", 18), 50] });
  prepared.ostium = { ...prepared.ostium, functionName: "closeTradeMarket", expectedData: data, positionId: prepared.request.positionId, positionIndex: 2, positionSize: "1", closePercentBps: bps, requiredAllowanceUsd: "0.01" };
  prepared.transactions![0]!.data = data;
  return prepared;
}

describe("Ostium native wallet boundary", () => {
  it("accepts exact owner calls and explicitly wrapped agent calls", () => {
    expect(inspectPreparedOstiumAction(opening()).ostium.functionName).toBe("openTrade");
    expect(inspectPreparedOstiumAction(opening(true), "agent").ostium.delegate).toBe(agent);
    expect(() => inspectPreparedOstiumAction(opening(true))).toThrow();
  });
  it.each(["chain", "recipient", "trader", "target", "builder", "expiry", "symbol", "amount"])("rejects changed %s", mutation => {
    const prepared = opening();
    if (mutation === "chain") prepared.account.chainId = 1;
    if (mutation === "recipient") prepared.ostium.recipient = other;
    if (mutation === "trader") prepared.ostium.trader = other;
    if (mutation === "target") prepared.transactions![0]!.to = other;
    if (mutation === "builder") (prepared.ostium as { builderFeeBps: number }).builderFeeBps = 1;
    if (mutation === "expiry") prepared.expiresAt = 0;
    if (mutation === "symbol") prepared.request.symbol = "EUR/USD";
    if (mutation === "amount") prepared.request.amount = "20";
    expect(() => inspectPreparedOstiumAction(prepared)).toThrow();
  });
  it("does not let matching metadata hide a nonzero native builder fee", () => {
    const prepared = opening();
    const data = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "openTrade", args: [{ collateral: 10_000_000n, openPrice: parseUnits("2000", 18), tp: 0n, sl: 0n, trader: owner, leverage: 200, pairIndex: 7, index: 0, buy: true, isDayTrade: false }, { builder: other, builderFee: 100 }, 0, 50n] });
    prepared.transactions![0]!.data = data; prepared.ostium.expectedData = data;
    expect(() => inspectPreparedOstiumAction(prepared)).toThrow();
  });
  it("allows only optional reset followed by one exact positive approval", () => {
    for (const amounts of [[10_000_000n], [0n, 10_000_000n]]) {
      const prepared = opening(); prepared.transactions!.unshift(...amounts.map(approval));
      expect(inspectPreparedOstiumAction(prepared)).toBe(prepared);
    }
    for (const amounts of [[0n], [10_000_000n, 10_000_000n], [10_000_001n], [10_000_000n, 0n]]) {
      const prepared = opening(); prepared.transactions!.unshift(...amounts.map(approval));
      expect(() => inspectPreparedOstiumAction(prepared)).toThrow();
    }
  });
  it("allows exact native oracle fee approval on an exit, but never agent approvals", () => {
    const prepared = exit(); prepared.transactions!.unshift(approval(10_000n));
    expect(inspectPreparedOstiumAction(prepared)).toBe(prepared);
    const delegated = opening(true); delegated.transactions!.unshift(approval());
    expect(() => inspectPreparedOstiumAction(delegated, "agent")).toThrow();
    prepared.ostium.requiredAllowanceUsd = "0";
    expect(() => inspectPreparedOstiumAction(prepared)).toThrow();
  });
  it("binds close percentage to actual reviewed base quantity and exact position", () => {
    expect(inspectPreparedOstiumAction(exit())).toBeTruthy();
    const incorrect = exit(5000);
    expect(() => inspectPreparedOstiumAction(incorrect)).toThrow();
    const minimum = exit(99); minimum.request.amount = "0.0099";
    expect(() => inspectPreparedOstiumAction(minimum)).toThrow();
    const changed = exit(); changed.request.positionId = "ostium-position:7:99";
    expect(() => inspectPreparedOstiumAction(changed)).toThrow();
  });
  it("rejects permission selectors disguised as trading actions", () => {
    const prepared = opening(true), data = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "setDelegate", args: [other] });
    prepared.ostium.expectedData = data; prepared.ostium.functionName = "setDelegate";
    prepared.transactions![0]!.data = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "delegatedAction", args: [owner, data] });
    expect(() => inspectPreparedOstiumAction(prepared, "agent")).toThrow();
  });
  it("requires direct owner-only delegation and cannot silently replace another delegate", () => {
    const account = opening().account;
    const plan = { trader: owner, delegate: agent, currentDelegate: zeroAddress, chainId: 421614 as const, contractAddress: OSTIUM_TESTNET.trading, expiresAt: Date.now() + 60_000, alreadyActive: false, transactions: [{ chainId: 421614, value: "0", to: OSTIUM_TESTNET.trading, data: encodeFunctionData({ abi: ostiumTradingAbi, functionName: "setDelegate", args: [agent] }) }] };
    expect(() => inspectOstiumOwnerPlan(account, plan, "grant")).not.toThrow();
    expect(() => inspectOstiumOwnerPlan(account, { ...plan, currentDelegate: other }, "grant")).toThrow();
    expect(() => inspectOstiumOwnerPlan(account, { ...plan, transactions: [{ ...plan.transactions[0]!, data: encodeFunctionData({ abi: ostiumTradingAbi, functionName: "delegatedAction", args: [owner, plan.transactions[0]!.data] }) }] }, "grant")).toThrow();
  });
});

describe("Ostium browser owner transaction sequence", () => {
  it("journals before opening wallet, confirms approvals, and does not call an accepted trade a fill", async () => {
    const prepared = opening(); prepared.transactions!.unshift(approval());
    const events: string[] = [];
    const result = await executeOstiumOwnerAction(prepared, { assertReady: async () => { events.push("ready"); }, send: async () => { events.push("send"); return hash; }, wait: async () => { events.push("receipt"); return { status: "success" }; }, record: async evidence => { events.push(evidence.result ? "claim" : evidence.approvalIndex !== undefined ? "approval-hash" : "trade-hash"); } });
    expect(events).toEqual(["ready", "claim", "send", "approval-hash", "receipt", "approval-hash", "ready", "claim", "send", "trade-hash"]);
    expect(result.response.settlement).toBe("native-confirmation-pending");
  });
  it("never sends the trade when an approval reverts", async () => {
    const prepared = opening(); prepared.transactions!.unshift(approval());
    const send = vi.fn(async () => hash);
    await expect(executeOstiumOwnerAction(prepared, { assertReady: async () => {}, send, wait: async () => ({ status: "reverted" }), record: async () => {} })).rejects.toMatchObject({ code: "APPROVAL_REVERTED" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown sends blocked and saves the phase needing recovery", async () => {
    const record = vi.fn(async () => {}), send = vi.fn(async (): Promise<Hex> => { throw new Error("response lost"); });
    await expect(executeOstiumOwnerAction(opening(), { assertReady: async () => {}, send, wait: async () => ({ status: "success" }), record })).rejects.toMatchObject({ phase: "submitted-unknown" });
    expect(record).toHaveBeenLastCalledWith({ result: { venue: "ostium", submissionUnknown: true, phase: "trade", approvalIndex: undefined } });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
