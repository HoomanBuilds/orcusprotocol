import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex, type Hex } from "viem";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { entryPoint } from "@orcus/wallets/kernel";
import { verifySwapSettlement } from "./index";

const account: TradingAccount = { id: "account", userId: "user", venue: "uniswap", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x2222222222222222222222222222222222222222", smartAccountAddress: "0x1111111111111111111111111111111111111111", chainId: 11155111, status: "authorized", controlRevision: 1 };
const input = "0x3333333333333333333333333333333333333333", output = "0x4444444444444444444444444444444444444444", pool = "0x5555555555555555555555555555555555555555";
const prepared: PreparedAction = { id: "action", account, request: { accountId: account.id, venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "buy", amount: "10", slippageBps: 50, reduceOnly: false, mode: "agent", tokenIn: input, tokenOut: output, tokenInDecimals: 6, tokenOutDecimals: 18 }, kind: "user-operation", expiresAt: Date.now() + 60_000, controlRevision: 1, quote: { amountIn: "10", amountOut: "0.01", minimumOut: "0.009", observedAt: Date.now() } };
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const depositAbi = parseAbi(["event Deposit(address indexed dst,uint256 wad)"]);
const operationAbi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)"]);
const userOperationHash = keccak256(toHex("unit-test-operation"));
const transaction = { from: pool, to: entryPoint.address, input: "0x" as Hex };
const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) => ({ address: token, topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]) });
const operation = (sender: Hex, success = true) => ({ address: entryPoint.address, topics: encodeEventTopics({ abi: operationAbi, eventName: "UserOperationEvent", args: { userOpHash: userOperationHash, sender, paymaster: pool } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [1n, success, 1n, 1n]) });
const swaps = [transfer(input, account.address as Hex, pool, 10_000_000n), transfer(output, pool, account.address as Hex, 10_000_000_000_000_000n)];

describe("smart-account swap settlement", () => {
  it("requires the correct successful operation and actual protected token movements", () => {
    expect(verifySwapSettlement({ prepared, userOperationHash }, account, transaction, [...swaps, operation(account.address as Hex)])).toBe(true);
    expect(verifySwapSettlement({ prepared, userOperationHash }, account, transaction, [...swaps, operation(account.address as Hex, false)])).toBe(false);
  });
  it("does not accept an arbitrary successful transaction or another account's operation", () => {
    expect(() => verifySwapSettlement({ prepared }, account, transaction, swaps)).toThrow("does not uniquely identify");
    expect(() => verifySwapSettlement({ prepared }, account, transaction, [...swaps, operation(pool)])).toThrow("does not uniquely identify");
  });
  it("does not count transfers from an earlier bundled operation", () => {
    expect(() => verifySwapSettlement({ prepared }, account, transaction, [...swaps, operation(pool), operation(account.address as Hex)])).toThrow("does not prove");
    expect(() => verifySwapSettlement({ prepared }, account, transaction, [operation(account.address as Hex)])).toThrow("does not prove");
  });
  it("proves native ETH deposit and swap transfers in the same successful account operation",()=>{
    const native={...prepared,request:{...prepared.request,side:"sell"as const,nativeInput:true,tokenInDecimals:18,tokenOutDecimals:6,amount:"0.001"},quote:{amountIn:"0.001",amountOut:"2",minimumOut:"1.99",observedAt:Date.now()}};
    const deposit={address:input,topics:encodeEventTopics({abi:depositAbi,eventName:"Deposit",args:{dst:account.address as Hex}})as Hex[],data:encodeAbiParameters([{type:"uint256"}],[1_000_000_000_000_000n])};
    const nativeSwaps=[transfer(input,account.address as Hex,pool,1_000_000_000_000_000n),transfer(output,pool,account.address as Hex,2_000_000n)],end=operation(account.address as Hex);
    expect(verifySwapSettlement({prepared:native},account,transaction,[deposit,...nativeSwaps,end])).toBe(true);
    expect(()=>verifySwapSettlement({prepared:native},account,transaction,[...nativeSwaps,end])).toThrow("exact native ETH deposit");
    expect(()=>verifySwapSettlement({prepared:native},account,transaction,[deposit,deposit,...nativeSwaps,end])).toThrow("exact native ETH deposit");
    expect(()=>verifySwapSettlement({prepared:native},account,transaction,[deposit,operation(pool),...nativeSwaps,end])).toThrow("exact native ETH deposit");
  });
});
