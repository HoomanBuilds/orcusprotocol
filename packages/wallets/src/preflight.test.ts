import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { PreparedAction } from "@orcus/core";
import type { KernelGrantPolicy } from "./kernel";
import { assertKernelPolicyCompatible, exactTokenAmount, inspectPreparedSwap, isOwnerRejection, swapCallAbi } from "./preflight";
import { broadcastPreparedOperation } from "./execution";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const now = 1_800_000_000_000;
const policy: KernelGrantPolicy = { accountAddress: address("1"), agentAddress: address("2"), router: address("3"), swaps: [{ tokenIn: address("4"), tokenOut: address("5"), feeTier: 500, maxAmountIn: "1000", minAmountOut: "900" }], issuedAt: now, expiresAt: now + 60_000, maxGasWei: "1000" };

function prepared(amountIn = 1000n, amountOutMinimum = 900n): PreparedAction {
  const data = encodeFunctionData({ abi: swapCallAbi, functionName: "exactInputSingle", args: [{ tokenIn: address("4"), tokenOut: address("5"), fee: 500, recipient: address("1"), amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }] });
  return {
    id: "action", account: { id: "account", userId: "user", venue: "uniswap", address: address("1"), ownerAddress: address("6"), agentAddress: address("2"), chainId: 11155111, status: "authorized", controlRevision: 1 },
    request: { accountId: "account", venue: "uniswap", type: "swap", symbol: "IN/OUT", side: "sell", amount: amountIn.toString(), tokenIn: address("4"), tokenOut: address("5"), tokenInDecimals: 0, tokenOutDecimals: 0, feeTier: 500, slippageBps: 50, reduceOnly: false, mode: "agent" },
    quote: { amountIn: amountIn.toString(), amountOut: "1000", minimumOut: amountOutMinimum.toString(), observedAt: now }, kind: "user-operation", controlRevision: 1, expiresAt: now + 60_000,
    transactions: [{ to: address("3"), value: "0", chainId: 11155111, data: encodeFunctionData({ abi: swapCallAbi, functionName: "multicall", args: [BigInt((now + 60_000) / 1000), [data]] }) }],
  };
}
function nativePrepared(){
  const action=prepared();action.account.smartAccountAddress=action.account.address;
  action.request={...action.request,symbol:"WETH/USDC",nativeInput:true,tokenInDecimals:18,amount:"0.000000000000001"};action.quote!.amountIn=action.request.amount;
  action.transactions!.unshift({to:address("4"),value:"1000",chainId:11155111,data:encodeFunctionData({abi:swapCallAbi,functionName:"deposit"})});
  return action;
}

describe("swap preflight", () => {
  it("accepts a quote inside its exact owner-approved size/output band", () => {
    expect(assertKernelPolicyCompatible(prepared(), policy, now).amountIn).toBe(1000n);
  });
  it("requires regrant for a smaller swap whose output floor is below the grant", () => {
    expect(() => assertKernelPolicyCompatible(prepared(100n, 90n), policy, now)).toThrow("owner-approved input/output size band");
  });
  it("accepts an explicitly owner-approved smaller band without weakening the larger one", () => {
    expect(assertKernelPolicyCompatible(prepared(100n, 90n), { ...policy, swaps: [...policy.swaps, { ...policy.swaps[0], maxAmountIn: "100", minAmountOut: "90" }] }, now).amountIn).toBe(100n);
  });
  it("rejects stale revision, expired quote, mismatched recipient and extra router bytes", () => {
    const action = prepared();
    expect(() => inspectPreparedSwap({ ...action, controlRevision: 2 }, now)).toThrow("revision");
    expect(() => inspectPreparedSwap(action, action.expiresAt)).toThrow("expired");
    expect(() => inspectPreparedSwap({ ...action, account: { ...action.account, address: address("7") } }, now)).toThrow("recipient");
    expect(() => inspectPreparedSwap({ ...action, transactions: [{ ...action.transactions![0], data: `${action.transactions![0].data}00` }] }, now)).toThrow("Noncanonical");
  });
  it("rejects excessive approvals before a wallet signature", () => {
    const action = prepared();
    action.transactions!.unshift({ to: address("4"), value: "0", chainId: 11155111, data: encodeFunctionData({ abi: swapCallAbi, functionName: "approve", args: [address("3"), 1001n] }) });
    expect(() => inspectPreparedSwap(action, now)).toThrow("exactly the input amount");
  });
  it("never rounds excess precision or permits zero amounts", () => {
    expect(exactTokenAmount("0.000001", 6)).toBe(1n);
    for (const amount of ["0", "-1", "1e5", "0.0000001", "1.0000001", ""]) expect(() => exactTokenAmount(amount, 6)).toThrow();
  });
  it("recognizes nested wallet rejection without treating RPC timeouts as rejection", () => {
    expect(isOwnerRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isOwnerRejection(new Error("RPC timeout"))).toBe(false);
  });
  it("accepts atomic native input only under a separate explicit wrapping grant",()=>{
    const action=nativePrepared();
    expect(inspectPreparedSwap(action,now).amountIn).toBe(1000n);
    expect(()=>assertKernelPolicyCompatible(action,policy,now)).toThrow("does not explicitly approve");
    expect(assertKernelPolicyCompatible(action,{...policy,nativeWrap:{weth:address("4"),maxAmountWei:"1000"}},now).amountIn).toBe(1000n);
    expect(()=>assertKernelPolicyCompatible(action,{...policy,nativeWrap:{weth:address("4"),maxAmountWei:"999"}},now)).toThrow("does not explicitly approve");
  });
  it("rejects native overspend, duplicate wraps, arbitrary destinations and value on router calls",()=>{
    for(const mutate of [
      (action:PreparedAction)=>{action.transactions![0].value="1001";},
      (action:PreparedAction)=>{action.transactions![0].to=address("7");},
      (action:PreparedAction)=>{action.transactions![0].data=`${action.transactions![0].data}00`;},
      (action:PreparedAction)=>{action.transactions!.at(-1)!.value="1";},
      (action:PreparedAction)=>{action.transactions!.unshift({...action.transactions![0]});},
      (action:PreparedAction)=>{delete action.account.smartAccountAddress;},
      (action:PreparedAction)=>{action.request.nativeInput=false;},
    ]){const action=nativePrepared();mutate(action);expect(()=>inspectPreparedSwap(action,now)).toThrow();}
  });
});

describe("durable user operation evidence", () => {
  const hash = `0x${"a".repeat(64)}` as Hex;
  const tx = `0x${"b".repeat(64)}` as Hex;
  it("persists the hash before waiting for a receipt", async () => {
    const steps: string[] = [];
    const result = await broadcastPreparedOperation({ candidateHash: hash, send: async () => hash, onSubmitted: () => { steps.push("record"); }, wait: async () => { steps.push("wait"); return { success: true, receipt: { transactionHash: tx } }; } });
    expect(steps).toEqual(["record", "wait"]);
    expect(result.status).toBe("confirmed");
  });
  it("preserves the candidate hash when the send result is unknown", async () => {
    const onSubmitted = vi.fn();
    await expect(broadcastPreparedOperation({ candidateHash: hash, send: async () => { throw new Error("timeout"); }, onSubmitted, wait: vi.fn() })).rejects.toMatchObject({ phase: "submitted-unknown", evidence: { userOperationHash: hash } });
    expect(onSubmitted).toHaveBeenCalledWith({ userOperationHash: hash });
  });
  it("stops a revoked or paused session at the final broadcast boundary", async () => {
    const send = vi.fn();
    const onSubmitted = vi.fn();
    await expect(broadcastPreparedOperation({ candidateHash: hash, assertBeforeSend: () => { throw new Error("Permission revoked"); }, send, onSubmitted, wait: vi.fn() })).rejects.toThrow("Permission revoked");
    expect(send).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
  it("does not trust a bundler hash that differs from the exact signed payload", async () => {
    await expect(broadcastPreparedOperation({ candidateHash: hash, send: async () => tx, wait: vi.fn() })).rejects.toMatchObject({ phase: "submitted-unknown", evidence: { userOperationHash: hash } });
  });
  it("does not call a recorded but timed-out operation rejected or filled", async () => {
    await expect(broadcastPreparedOperation({ candidateHash: hash, send: async () => hash, wait: async () => { throw new Error("timeout"); } })).rejects.toMatchObject({ code: "RECEIPT_UNKNOWN", phase: "submitted-unknown", evidence: { userOperationHash: hash } });
  });
  it("keeps a proven reverted receipt distinct from an unknown submission", async () => {
    const result = await broadcastPreparedOperation({ candidateHash: hash, send: async () => hash, wait: async () => ({ success: false, receipt: { transactionHash: tx } }) });
    expect(result).toMatchObject({ status: "rejected", transactionHash: tx });
  });
});
