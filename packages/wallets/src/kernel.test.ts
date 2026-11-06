import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, slice, type Hex } from "viem";
import { buildKernelPolicies, kernelGrantPolicySchema, type KernelGrantPolicy } from "./kernel";

const policy: KernelGrantPolicy = {
  accountAddress: "0x1111111111111111111111111111111111111111",
  agentAddress: "0x2222222222222222222222222222222222222222",
  router: "0x3333333333333333333333333333333333333333",
  swaps: [{ tokenIn: "0x4444444444444444444444444444444444444444", tokenOut: "0x5555555555555555555555555555555555555555", feeTier: 3000, maxAmountIn: "1000", minAmountOut: "900" }],
  issuedAt: 1_800_000_000_000, expiresAt: 1_800_003_600_000, maxGasWei: "3000000000000000",
};
const abi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns (uint256)", "function multicall(uint256 deadline,bytes[] data) returns (bytes[])"]);

describe("bounded Kernel swap policy", () => {
  it("matches exact ABI fields inside a single-call deadline multicall", () => {
    const swap = policy.swaps[0];
    const inner = encodeFunctionData({ abi, functionName: "exactInputSingle", args: [{ tokenIn: swap.tokenIn as Hex, tokenOut: swap.tokenOut as Hex, fee: swap.feeTier, recipient: policy.accountAddress as Hex, amountIn: 1000n, amountOutMinimum: 900n, sqrtPriceLimitX96: 0n }] });
    const data = encodeFunctionData({ abi, functionName: "multicall", args: [BigInt(policy.expiresAt / 1000), [inner]] });
    const callPolicy = buildKernelPolicies(policy)[0].policyParams;
    if (callPolicy.type !== "call") throw new Error("Missing call policy");
    const permission = callPolicy.permissions?.[1];
    if (!permission?.rules) throw new Error("Missing swap constraints");
    for (const rule of permission.rules) {
      const actual = BigInt(slice(data, rule.offset + 4, rule.offset + 36));
      const expected = BigInt(Array.isArray(rule.params) ? rule.params[0] : rule.params);
      if (rule.condition === 0) expect(actual).toBe(expected);
      else if (rule.condition === 1) expect(actual > expected).toBe(true);
      else if (rule.condition === 3) expect(actual >= expected).toBe(true);
      else if (rule.condition === 4) expect(actual <= expected).toBe(true);
      else throw new Error("Unexpected rule condition");
    }
    expect(permission.rules.some(rule => rule.offset === 64 && (Array.isArray(rule.params) ? rule.params[0] : rule.params).endsWith("01"))).toBe(true);
  });
  it("rejects non-expiring grants and unlimited session durations", () => {
    expect(kernelGrantPolicySchema.safeParse({ ...policy, expiresAt: policy.issuedAt }).success).toBe(false);
    expect(kernelGrantPolicySchema.safeParse({ ...policy, expiresAt: policy.issuedAt + 86_400_001 }).success).toBe(false);
  });
  it("allows only an explicitly opted-in, bounded WETH deposit without expanding router value",()=>{
    const existing=buildKernelPolicies(policy)[0].policyParams;
    if(existing.type!=="call")throw new Error("Missing call policy");
    expect(existing.permissions?.every(permission=>permission.valueLimit===0n)).toBe(true);
    const opted=buildKernelPolicies({...policy,nativeWrap:{weth:policy.swaps[0].tokenIn,maxAmountWei:"1000"}})[0].policyParams;
    if(opted.type!=="call")throw new Error("Missing call policy");
    expect(opted.permissions?.at(-1)).toMatchObject({target:policy.swaps[0].tokenIn,selector:"0xd0e30db0",valueLimit:1000n,rules:[]});
    expect(opted.permissions?.slice(0,-1).every(permission=>permission.valueLimit===0n)).toBe(true);
    expect(()=>buildKernelPolicies({...policy,nativeWrap:{weth:policy.swaps[0].tokenIn,maxAmountWei:"1001"}})).toThrow("approved WETH input band");
    expect(()=>buildKernelPolicies({...policy,nativeWrap:{weth:policy.swaps[0].tokenOut,maxAmountWei:"1000"}})).toThrow("approved WETH input band");
  });
});
