import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OstiumClient } from "@ostium/builder-sdk";
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Hex } from "viem";
import type { TradeRequest, TradingAccount } from "@orcus/core";
import { OSTIUM_TESTNET, ostiumTradingAbi } from "@orcus/wallets/ostium";
import { prepareOstiumAction } from "./execution";
import { reconcileOstiumAction } from "./reconciliation";
import { getOstiumApprovalTransaction, reconcileOstiumApproval } from "./authorization";
import { getOstiumPortfolio } from "./data";

const state = vi.hoisted(() => ({ client: null as any, delegateClient: null as any, delegate: "0x2222222222222222222222222222222222222222", maxLeverage: 100, open: true, rpc: { readContract: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getBlock: vi.fn() } }));
vi.mock("./client", async importOriginal => ({
  ...await importOriginal<typeof import("./client")>(),
  ostiumSdk: vi.fn(async (_trader?: string, delegate?: string) => delegate ? state.delegateClient : state.client),
  verifiedOstiumRpc: vi.fn(async () => state.rpc),
  boundedOstiumRead: <T>(work: () => Promise<T>) => work(),
  getOstiumAuthorization: vi.fn(async () => ({ delegate: state.delegate, chainId: 421614, contractAddress: OSTIUM_TESTNET.trading })),
  getOstiumPrices: vi.fn(async () => [{ symbol: "XAU/USD", rawSymbol: "XAU/USD", mid: "2000", bid: "1999", ask: "2001", observedAt: Date.now(), isMarketOpen: state.open, isDayTradingClosed: false }]),
}));
const owner = "0x1111111111111111111111111111111111111111", hash = `0x${"a".repeat(64)}` as Hex, executionHash = `0x${"b".repeat(64)}` as Hex;
const account: TradingAccount = { id: "ostium", userId: "owner", venue: "ostium", address: owner, ownerAddress: owner, chainId: 421614, agentAddress: "0x2222222222222222222222222222222222222222", status: "authorized", controlRevision: 0 };
const request = (patch: Partial<TradeRequest> = {}): TradeRequest => ({ accountId: account.id, venue: "ostium", type: "market", symbol: "XAU/USD", side: "buy", amount: "10", amountUnit: "collateral-usdc", leverage: 2, slippageBps: 50, reduceOnly: false, mode: "manual", ...patch });
const position = { trader: owner, pairId: "7", pairFrom: "XAU", pairTo: "USD", pid: "42", idx: 3, szi: "1", side: "B", collateralUsed: "100", ntl: "2000", leverage: "20", maxWithdrawable: "5.000000000000000001" };

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in native adapter unit test."); }));
  state.maxLeverage = 100; state.open = true; state.delegate = account.agentAddress!;
  state.rpc.readContract.mockReset().mockResolvedValue(false);
  state.rpc.getBlockNumber.mockReset().mockResolvedValue(100n);
  state.rpc.getBlock.mockReset().mockResolvedValue({ timestamp: 1_800_000_001n });
  state.rpc.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", blockNumber: 101n, logs: [] });
  state.rpc.getTransaction.mockReset();
  const sdk = await OstiumClient.createSelfAndSelf({ testnet: true, traderAddress: owner, rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc" });
  const reads = {
    getPairs: vi.fn(async () => ({ pairs: [{ pairId: "7", pairFrom: "XAU", pairTo: "USD", minLeverage: 1, maxLeverage: state.maxLeverage, overnightMaxLeverage: 100, oracleFee: "0.01" }] })),
    getBalances: vi.fn(async () => ({ usdc: "1000", eth: "0.01", allowance: "1000" })),
    getOpenPositions: vi.fn(async () => ({ pairPositions: [{ position }], time: Date.now() })),
    getOpenOrders: vi.fn(async () => [{ trader: owner, pairId: "7", pairFrom: "XAU", pairTo: "USD", idx: 4, collateralUsed: "10", ntl: "20", leverage: "2", limitPx: "2000", orderType: "Limit", side: "B", szi: "0.01", timestamp: Date.now() }]),
    previewOpenTrade: vi.fn(async () => ({ isValid: true, withinExposureLimit: true, entryPx: "2001", fees: { oracleFee: "0.01", total: "0.02" } })),
    previewCloseTrade: vi.fn(async () => ({ exitPx: "1999", sizeClosing: "0.25" })),
    getOrders: vi.fn(async () => []), getLimitOrderHistory: vi.fn(async () => []),
  };
  state.client = Object.assign(sdk, reads);
  state.delegateClient = Object.assign(await OstiumClient.createDelegatedAndSelf({ testnet: true, traderAddress: owner, delegateAddress: account.agentAddress as Hex, rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc" }), reads);
});
afterEach(() => vi.unstubAllGlobals());

describe("Ostium official SDK build-only preparation", () => {
  it("uses actual SDK calldata and separates USDC collateral, exposure and native gas", async () => {
    const prepared = await prepareOstiumAction(request(), account);
    const decoded = decodeFunctionData({ abi: ostiumTradingAbi, data: prepared.transactions!.at(-1)!.data as Hex });
    expect(decoded.functionName).toBe("openTrade");
    expect(prepared.ostium).toMatchObject({ collateralUsd: "10", notionalUsd: "20", leverage: 2, builderFeeBps: 0, minimumBlock: "100" });
    expect(prepared.request.price).toBe("2001");
    expect(prepared.warnings?.join(" ")).toContain("owner EOA pays Arbitrum Sepolia gas");
  });
  it.each(["limit", "stop"] as const)("builds a real %s entry instead of a fake market order", async type => {
    const prepared = await prepareOstiumAction(request({ type, price: "1900" }), account);
    const decoded = decodeFunctionData({ abi: ostiumTradingAbi, data: prepared.ostium.expectedData });
    expect(decoded.functionName).toBe("openTrade");
    expect((decoded.args as readonly unknown[])[2]).toBe(type === "limit" ? 1 : 2);
  });
  it("uses an actual SDK delegated wrapper bound to the owner's account", async () => {
    const prepared = await prepareOstiumAction(request({ mode: "agent" }), account);
    const decoded = decodeFunctionData({ abi: ostiumTradingAbi, data: prepared.transactions![0]!.data as Hex });
    expect(decoded.functionName).toBe("delegatedAction");
    expect(decoded.args?.[0]).toBe(owner);
    expect(prepared.transactions).toHaveLength(1);
    expect(prepared.warnings?.join(" ")).toContain("Fund your agent wallet with Arbitrum Sepolia ETH");
    expect(prepared.warnings?.join(" ")).toContain("Orcus does not top it up");
  });
  it("refuses disabled markets, stale/native authority and unsupported asset units", async () => {
    state.maxLeverage = 0;
    await expect(prepareOstiumAction(request(), account)).rejects.toMatchObject({ code: "OSTIUM_MARKET_DISABLED" });
    state.maxLeverage = 100; state.delegate = zeroAddress;
    await expect(prepareOstiumAction(request({ mode: "agent" }), account)).rejects.toMatchObject({ code: "AGENT_NOT_AUTHORIZED" });
    await expect(prepareOstiumAction(request(), { ...account, chainId: 1 })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it("prepares exact approval resets only for insufficient owner allowance", async () => {
    state.client.getBalances.mockResolvedValue({ usdc: "1000", allowance: "1", eth: "0.01" });
    const prepared = await prepareOstiumAction(request(), account);
    expect(prepared.transactions).toHaveLength(3);
    expect(decodeFunctionData({ abi: erc20Abi, data: prepared.transactions![0]!.data as Hex }).args?.[1]).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: prepared.transactions![1]!.data as Hex }).args?.[1]).toBe(10_000_000n);
    await expect(prepareOstiumAction(request({ mode: "agent" }), account)).rejects.toMatchObject({ code: "OSTIUM_ALLOWANCE_REQUIRED" });
  });
  it("floors a reduction to native basis points, never closing more than requested", async () => {
    const prepared = await prepareOstiumAction(request({ type: "reduce", positionId: "ostium-position:7:42", amountUnit: "base", amount: "0.25009" }), account);
    expect(prepared.request.amount).toBe("0.25"); expect(prepared.ostium.closePercentBps).toBe(2500);
    expect(prepared.ostium.requiredAllowanceUsd).toBe("0.01");
    await expect(prepareOstiumAction(request({ type: "reduce", positionId: "ostium-position:7:42", amountUnit: "base", amount: "0.009" }), account)).rejects.toMatchObject({ code: "OSTIUM_REDUCTION_TOO_SMALL" });
  });
  it("targets a limit slot explicitly when repricing and preserving both protective levels", async () => {
    const prepared = await prepareOstiumAction(request({ type: "edit-order", orderId: "ostium-order:7:4", price: "1900", takeProfit: "2200", stopLoss: "0" }), account);
    expect(prepared.ostium.functionName).toBe("updateOpenLimitOrder");
    expect(prepared.ostium.orderIndex).toBe(4);
  });
  it("keeps collateral removal owner-only and never bypasses native top-up allowance checks", async () => {
    await expect(prepareOstiumAction(request({ type: "remove-collateral", positionId: "ostium-position:7:42", amount: "1", mode: "agent" }), account)).rejects.toMatchObject({ code: "OWNER_ONLY" });
    state.client.getBalances.mockResolvedValue({ usdc: "1000", allowance: "0", eth: "0.01" });
    await expect(prepareOstiumAction(request({ type: "add-collateral", positionId: "ostium-position:7:42", amount: "1" }), account)).rejects.toMatchObject({ code: "OSTIUM_ALLOWANCE_REQUIRED" });
  });
  it("does not persist raw RPC diagnostics in owner activity", async () => {
    state.rpc.readContract.mockRejectedValue(new Error("private-rpc-token and request body must not escape"));
    await expect(prepareOstiumAction(request(), account)).rejects.toMatchObject({ code: "OSTIUM_PREPARATION_FAILED", message: "The native action could not be prepared safely. No signature or transaction was submitted." });
  });
  it("returns actual pending oracle orders with separate cancelable native identities", async () => {
    state.client.getOrders.mockResolvedValue([{ trader: owner, pairId: "7", pairFrom: "XAU", pairTo: "USD", oid: "88", action: "Open", isPending: true, isCancelled: false, side: "B", szi: "0.1", px: "2000", initiatedTime: Date.now(), collateralUsed: "10", ntl: "200" }]);
    const portfolio = await getOstiumPortfolio(account);
    expect(portfolio.orders).toEqual(expect.arrayContaining([expect.objectContaining({ id: "pending-open:88", type: "pending-open" })]));
  });
});

describe("Ostium evidence reconciliation", () => {
  it("does not fail an action from an unrelated reverted transaction or a pre-review receipt", async () => {
    const prepared = await prepareOstiumAction(request(), account);
    const transaction = { from: owner, to: OSTIUM_TESTNET.trading, value: 0n, input: prepared.transactions!.at(-1)!.data };
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 101n, logs: [] });
    for (const change of [{ from: account.agentAddress }, { to: OSTIUM_TESTNET.usdc }, { input: "0x12345678" }, { value: 1n }]) {
      state.rpc.getTransaction.mockResolvedValue({ ...transaction, ...change });
      await expect(reconcileOstiumAction({ transactionHash: hash, prepared }, account)).rejects.toMatchObject({ code: "TRANSACTION_ACCOUNT_MISMATCH" });
    }
    state.rpc.getTransaction.mockResolvedValue(transaction);
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 100n, logs: [] });
    await expect(reconcileOstiumAction({ transactionHash: hash, prepared }, account)).rejects.toMatchObject({ code: "TRANSACTION_PREDATES_REVIEW" });
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 101n, logs: [] });
    expect(await reconcileOstiumAction({ transactionHash: hash, prepared }, account)).toMatchObject({ status: "rejected", txHash: hash });
    expect(state.client.getOrders).not.toHaveBeenCalled();
  });
  it("does not reject an owner allowance from an unrelated reverted hash", async () => {
    const plan = await getOstiumApprovalTransaction(account, "1.000001");
    const transaction = { from: owner, to: OSTIUM_TESTNET.usdc, value: 0n, input: plan.transaction.data };
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 101n, logs: [] });
    for (const change of [{ from: account.agentAddress }, { to: OSTIUM_TESTNET.trading }, { input: "0x12345678" }, { value: 1n }]) {
      state.rpc.getTransaction.mockResolvedValue({ ...transaction, ...change });
      await expect(reconcileOstiumApproval({ account, amountUsd: plan.amountUsd, transactionHash: hash, minimumBlock: plan.minimumBlock })).rejects.toMatchObject({ code: "APPROVAL_NOT_VERIFIED" });
    }
    state.rpc.getTransaction.mockResolvedValue(transaction);
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 100n, logs: [] });
    await expect(reconcileOstiumApproval({ account, amountUsd: plan.amountUsd, transactionHash: hash, minimumBlock: plan.minimumBlock })).rejects.toMatchObject({ code: "APPROVAL_NOT_VERIFIED" });
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 101n, logs: [] });
    expect(await reconcileOstiumApproval({ account, amountUsd: plan.amountUsd, transactionHash: hash, minimumBlock: plan.minimumBlock })).toMatchObject({ status: "rejected", transactionHash: hash });
  });
  it("does not call native acceptance a fill and binds later execution to the initial hash", async () => {
    const prepared = await prepareOstiumAction(request(), account);
    state.rpc.getTransaction.mockResolvedValue({ from: owner, to: OSTIUM_TESTNET.trading, value: 0n, input: prepared.transactions!.at(-1)!.data });
    expect(await reconcileOstiumAction({ transactionHash: hash, prepared }, account)).toMatchObject({ status: "pending" });
    state.client.getOrders.mockResolvedValue([{ trader: owner, initiatedTx: hash, pairId: "7", action: "Open", pid: "42", oid: "20", isPending: false, isCancelled: false, hash: executionHash }]);
    expect(await reconcileOstiumAction({ transactionHash: hash, prepared }, account)).toMatchObject({ status: "confirmed", evidence: { executionHash } });
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 100n, logs: [] });
    await expect(reconcileOstiumAction({ transactionHash: hash, prepared }, account)).rejects.toMatchObject({ code: "TRANSACTION_PREDATES_REVIEW" });
  });
  it("does not use a reused limit slot's later terminal event as the original order fill", async () => {
    const prepared = await prepareOstiumAction(request({ type: "limit", price: "1900" }), account);
    state.rpc.getTransaction.mockResolvedValue({ from: owner, to: OSTIUM_TESTNET.trading, value: 0n, input: prepared.transactions!.at(-1)!.data });
    const base = { trader: owner, pairId: "7", limitId: `${owner}_7_4`, idx: 4 };
    state.client.getLimitOrderHistory.mockResolvedValue([{ ...base, event: "Placed", hash, block: "101" }, { ...base, event: "Placed", hash: executionHash, block: "104" }, { ...base, event: "Executed", hash: executionHash, block: "105", oid: "99" }]);
    expect(await reconcileOstiumAction({ transactionHash: hash, prepared }, account)).toMatchObject({ status: "submitted-unknown", evidence: { effect: "limit-slot-reused", tradeFillClaimed: false } });
  });
  it("builds exact owner allowance intent with a pre-intent block and rejects old receipt reuse", async () => {
    const plan = await getOstiumApprovalTransaction(account, "1.000001");
    expect(plan).toMatchObject({ minimumBlock: "100", amountRaw: "1000001", spender: OSTIUM_TESTNET.storage });
    state.rpc.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 100n, logs: [] });
    await expect(reconcileOstiumApproval({ account, amountUsd: "1.000001", transactionHash: hash, minimumBlock: plan.minimumBlock })).rejects.toMatchObject({ code: "APPROVAL_NOT_VERIFIED" });
    expect(plan.transaction.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, 1_000_001n] }));
  });
});
