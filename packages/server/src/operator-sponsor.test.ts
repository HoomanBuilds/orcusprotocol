import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseEther, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi } from "viem/account-abstraction";
import { decodeOperatorPaymasterData, operatorPaymasterAbi, operatorSponsorshipTypedData, type OperatorUserOperation } from "@orcus/wallets/operator-paymaster";
import { entryPoint } from "@orcus/wallets/kernel";
import { sponsorWithOperator } from "./operator-sponsor";
import { gasSponsorConfig } from "./sponsorship-config";

const privateKey = `0x${"11".repeat(32)}` as Hex, signer = privateKeyToAccount(privateKey);
const paymaster = `0x${"6".repeat(40)}` as Hex;
const operation = { sender: `0x${"1".repeat(40)}`, nonce: toHex(2n ** 248n), callData: "0x1234", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0x1234" };
const estimates = { callGasLimit: "0x186a0", verificationGasLimit: "0x30d40", preVerificationGas: "0xc350", paymasterVerificationGasLimit: "0x186a0", paymasterPostOpGasLimit: "0x0" };
let readChain: string, bundlerChain: string, deposit: bigint, contractCap: bigint, code: string, configuredSigner: Hex, configuredEntryPoint: Hex;
let staked: boolean, stake: bigint, unstakeDelaySec: number, withdrawTime: number, actualDeposit: bigint | undefined;

beforeEach(() => {
  vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "operator");
  vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", privateKey);
  vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", paymaster);
  vi.stubEnv("BUNDLER_RPC_URL", "https://bundler.example/rpc-secret");
  vi.stubEnv("SEPOLIA_RPC_URL", "https://sepolia.example/rpc-secret");
  vi.stubEnv("ZERODEV_RPC_URL", "https://rpc.zerodev.app/secondary-secret");
  vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", "https://rpc.zerodev.app/paymaster-secondary-secret");
  readChain = "0xaa36a7"; bundlerChain = "0xaa36a7"; deposit = parseEther("1"); contractCap = parseEther("0.003"); code = "0x60006000"; configuredSigner = signer.address; configuredEntryPoint = entryPoint.address;
  staked = true; stake = parseEther("0.2"); unstakeDelaySec = 86400; withdrawTime = 0; actualDeposit = undefined;
  vi.stubEnv("ORCUS_GAS_SPONSOR_REQUIRE_STAKE", "true"); vi.stubEnv("ORCUS_GAS_SPONSOR_MIN_STAKE_WEI", undefined); vi.stubEnv("ORCUS_GAS_SPONSOR_MIN_UNSTAKE_DELAY_SECONDS", "86400");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "eth_chainId") result = url.startsWith("https://bundler.") ? bundlerChain : readChain;
    else if (body.method === "eth_supportedEntryPoints") result = [entryPoint.address];
    else if (body.method === "eth_getCode") result = code;
    else if (body.method === "eth_estimateUserOperationGas") result = estimates;
    else if (body.method === "eth_call") {
      if ((body.params[0] as { to: string }).to.toLowerCase() === entryPoint.address.toLowerCase()) {
        result = encodeFunctionResult({ abi: entryPoint07Abi, functionName: "getDepositInfo", result: { deposit: actualDeposit ?? deposit, staked, stake, unstakeDelaySec, withdrawTime } });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }
      const { functionName } = decodeFunctionData({ abi: operatorPaymasterAbi, data: (body.params[0] as { data: Hex }).data });
      if (functionName === "entryPoint") result = encodeFunctionResult({ abi: operatorPaymasterAbi, functionName, result: configuredEntryPoint });
      else if (functionName === "verifyingSigner") result = encodeFunctionResult({ abi: operatorPaymasterAbi, functionName, result: configuredSigner });
      else if (functionName === "maxOperationCostWei") result = encodeFunctionResult({ abi: operatorPaymasterAbi, functionName, result: contractCap });
      else if (functionName === "getDeposit") result = encodeFunctionResult({ abi: operatorPaymasterAbi, functionName, result: deposit });
    }
    if (result === undefined) throw new Error("Unexpected mock RPC method.");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("operator-wallet gas sponsorship", () => {
  it("defaults to operator and never selects configured ZeroDev as an implicit fallback", () => {
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", undefined);
    vi.stubEnv("BUNDLER_RPC_URL", "");
    expect(gasSponsorConfig()).toMatchObject({ provider: "operator", configured: false });
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "zerodev");
    expect(gasSponsorConfig()).toMatchObject({ provider: "zerodev", configured: true, bundlerUrl: "https://rpc.zerodev.app/secondary-secret" });
  });
  it("uses an invalid length-matched stub for generic gas estimation without issuing a usable approval", async () => {
    const approval = await sponsorWithOperator(operation, contractCap.toString(), false);
    const decoded = decodeOperatorPaymasterData(approval.result.paymasterData);
    expect(decoded.signature).toBe(`0x${"ff".repeat(65)}`);
    expect(decoded.validUntil - decoded.validAfter).toBeLessThanOrEqual(300);
    const estimate = vi.mocked(fetch).mock.calls.find(([, init]) => JSON.parse(init!.body as string).method === "eth_estimateUserOperationGas");
    expect(estimate?.[0]).toBe("https://bundler.example/rpc-secret");
    expect(JSON.parse(estimate![1]!.body as string).params).toEqual([expect.objectContaining({ sender: operation.sender, nonce: operation.nonce, paymaster }), entryPoint.address]);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("zerodev"))).toBe(true);
  });
  it("signs exact final gas, fees, calls, high nonce and finite cost using the configured operator", async () => {
    const approval = await sponsorWithOperator(operation, contractCap.toString(), true), decoded = decodeOperatorPaymasterData(approval.result.paymasterData);
    const result = approval.result, typedOperation = { ...operation, ...result } as OperatorUserOperation;
    const authorization = { paymaster, entryPoint: entryPoint.address, chainId: 11155111, validAfter: decoded.validAfter, validUntil: decoded.validUntil, maxCostWei: decoded.maxCostWei, paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit), paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit) };
    const recovered = await recoverTypedDataAddress({ ...operatorSponsorshipTypedData(typedOperation, authorization), signature: decoded.signature });
    expect(recovered).toBe(signer.address);
    const gas = [result.callGasLimit, result.verificationGasLimit, result.preVerificationGas, result.paymasterVerificationGasLimit, result.paymasterPostOpGasLimit].reduce((sum, field) => sum + BigInt(field), 0n);
    expect(decoded.maxCostWei).toBe(gas * BigInt(result.maxFeePerGas));
    expect(decoded.signature).not.toBe(`0x${"ff".repeat(65)}`);
    expect(JSON.stringify(approval, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(privateKey.slice(2));
  });
  it.each(["rpc", "bundler"])("rejects the wrong %s chain rather than switching providers", async target => {
    if (target === "rpc") readChain = "0x1"; else bundlerChain = "0x1";
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_WRONG_NETWORK" });
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("zerodev"))).toBe(true);
  });
  it("requires deployed contracts, matching EntryPoint and the actual authorized signer", async () => {
    code = "0x";
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_PAYMASTER_UNDEPLOYED" });
    code = "0x6000"; configuredSigner = paymaster;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_PAYMASTER_MISMATCH" });
    configuredSigner = signer.address; configuredEntryPoint = paymaster;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_PAYMASTER_MISMATCH" });
  });
  it("rejects insufficient EntryPoint deposit, contract caps and excessive fee quotes", async () => {
    deposit = 0n;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_UNFUNDED" });
    deposit = 1n;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_UNFUNDED" });
    deposit = parseEther("1"); contractCap = 1n;
    await expect(sponsorWithOperator(operation, parseEther("0.003").toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_UNFUNDED" });
    contractCap = parseEther("0.003");
    await expect(sponsorWithOperator({ ...operation, maxFeePerGas: "0xffffffffffffffffffffffffffffffff" }, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_REJECTED" });
  });
  it("sanitizes infrastructure errors and never sends transactions or sponsor secrets to RPCs", async () => {
    await sponsorWithOperator(operation, contractCap.toString(), true);
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => init!.body as string);
    expect(bodies.every(body => !body.includes(privateKey.slice(2)) && !body.includes("eth_send"))).toBe(true);
    vi.mocked(fetch).mockRejectedValue(new Error("rpc-secret private-key"));
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toThrow(/No alternate provider was used/);
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.not.toThrow(/rpc-secret/);
  });
  it("rejects invalid private keys, zero paymaster addresses and unsafe provider URLs", () => {
    vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", `0x${"00".repeat(32)}`);
    expect(() => gasSponsorConfig()).toThrow(/signing key is invalid/);
    vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", privateKey); vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", `0x${"0".repeat(40)}`);
    expect(() => gasSponsorConfig()).toThrow(/paymaster address/);
    vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", paymaster); vi.stubEnv("BUNDLER_RPC_URL", "http://remote.example/rpc");
    expect(() => gasSponsorConfig()).toThrow(/HTTPS bundler/);
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "unknown");
    expect(() => gasSponsorConfig()).toThrow(/Select operator or zerodev/);
  });
  it("requires actual locked stake separately from the funded gas deposit", async () => {
    staked = false;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_STAKE_REQUIRED" });
    staked = true; withdrawTime = 100;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_STAKE_REQUIRED" });
    withdrawTime = 0; unstakeDelaySec = 86399;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_STAKE_REQUIRED" });
    unstakeDelaySec = 86400; stake = 0n;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_STAKE_REQUIRED" });
  });
  it("checks configured provider-specific stake amounts without inventing a universal minimum", async () => {
    vi.stubEnv("ORCUS_GAS_SPONSOR_MIN_STAKE_WEI", (stake + 1n).toString());
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_STAKE_REQUIRED" });
    vi.stubEnv("ORCUS_GAS_SPONSOR_MIN_STAKE_WEI", stake.toString());
    expect((await sponsorWithOperator(operation, contractCap.toString(), true)).staking).toMatchObject({ staked: true, stakeWei: stake.toString(), configuredMinimumStakeWei: stake.toString(), admissionVerified: false });
    vi.stubEnv("ORCUS_GAS_SPONSOR_REQUIRE_STAKE", "false"); staked = false;
    expect((await sponsorWithOperator(operation, contractCap.toString(), false)).staking.required).toBe(false);
  });
  it("verifies the EntryPoint deposit rather than trusting a paymaster getter", async () => {
    actualDeposit = 0n;
    await expect(sponsorWithOperator(operation, contractCap.toString(), true)).rejects.toMatchObject({ code: "SPONSORSHIP_UNFUNDED" });
  });
});
