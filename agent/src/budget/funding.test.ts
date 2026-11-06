import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildComputeFunding, computePaymentVault, computePaymentVaultAbi, nativeAmount, reconcileComputeFunding, submitComputeFunding, validateComputeFunding } from "./funding";

const rpc = vi.hoisted(() => ({ getCode: vi.fn(), getChainId: vi.fn(), simulateContract: vi.fn(), estimateGas: vi.fn(), estimateFeesPerGas: vi.fn(), getTransactionCount: vi.fn(), getBalance: vi.fn(), sendRawTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: () => rpc }));
const key = `0x${"1".padStart(64, "0")}` as const;
const payerAddress = privateKeyToAccount(key).address;
const ownerAddress = `0x${"2".repeat(40)}`, computeAccountAddress = `0x${"3".repeat(40)}`;
const transactionHash = `0x${"4".repeat(64)}`;
const intent = () => buildComputeFunding({ id: "funding", userId: "user", ownerAddress, payerAddress, computeAccountAddress, topUp0G: "0.1", maxGas0G: "0.000001", expiresAt: Date.now() + 120_000, policyRevision: 1 });

beforeEach(() => {
  vi.resetAllMocks();
  rpc.getCode.mockResolvedValue("0x1234"); rpc.getChainId.mockResolvedValue(16602);
  rpc.simulateContract.mockResolvedValue({}); rpc.estimateGas.mockResolvedValue(21_000n);
  rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  rpc.getTransactionCount.mockResolvedValue(0); rpc.getBalance.mockResolvedValue(parseEther("1"));
});

describe("bounded Router compute funding", () => {
  it("builds an exact deposit to the fixed vault and approved beneficiary", () => {
    const deposit = intent();
    expect(deposit).toMatchObject({ to: computePaymentVault, chainId: 16602, amountWei: parseEther("0.1").toString(), payerAddress });
    expect(decodeFunctionData({ abi: computePaymentVaultAbi, data: deposit.data as `0x${string}` })).toMatchObject({ functionName: "depositFor", args: [computeAccountAddress] });
    expect(() => validateComputeFunding({ ...deposit, computeAccountAddress: ownerAddress })).toThrow(/approved compute account/);
    expect(() => validateComputeFunding({ ...deposit, to: ownerAddress })).toThrow(/fixed Galileo vault/);
    expect(() => validateComputeFunding({ ...deposit, chainId: 16661 })).toThrow();
  });
  it("rejects owner trading funds, invalid amounts, and unbounded prepared expiry", () => {
    expect(() => buildComputeFunding({ ...intent(), topUp0G: "1", maxGas0G: "0.01", payerAddress: ownerAddress })).toThrow(/separate operating wallet/);
    expect(() => buildComputeFunding({ ...intent(), topUp0G: "1", maxGas0G: "0.01", expiresAt: Date.now() + 600_000 })).toThrow(/five minutes/);
    for (const value of ["0", "-1", "1e9", "1.0000000000000000001", "999999999"]) expect(() => nativeAmount(value)).toThrow();
  });
  it("refuses missing vaults and insufficient operating funds without broadcasting", async () => {
    rpc.getCode.mockResolvedValue("0x");
    await expect(submitComputeFunding(intent(), key, { assertAuthority: vi.fn(), onSubmissionIntent: vi.fn() })).rejects.toMatchObject({ code: "FUNDING_NETWORK_MISMATCH", phase: "not-submitted" });
    rpc.getCode.mockResolvedValue("0x1234"); rpc.getBalance.mockResolvedValue(0n);
    await expect(submitComputeFunding(intent(), key, { assertAuthority: vi.fn(), onSubmissionIntent: vi.fn() })).rejects.toMatchObject({ code: "OPERATING_BALANCE_LOW", phase: "not-submitted" });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("enforces the network gas cap before signing or broadcasting", async () => {
    rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: parseEther("1"), maxPriorityFeePerGas: 1n });
    const persist = vi.fn();
    await expect(submitComputeFunding(intent(), key, { assertAuthority: vi.fn(), onSubmissionIntent: persist })).rejects.toMatchObject({ code: "FUNDING_GAS_CAP", phase: "not-submitted" });
    expect(persist).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("persists the signed hash before any uncertain submission and does not retry", async () => {
    const persist = vi.fn();
    rpc.sendRawTransaction.mockImplementation(async () => { expect(persist).toHaveBeenCalledOnce(); throw new Error("RPC timeout"); });
    const result = await submitComputeFunding(intent(), key, { assertAuthority: vi.fn(), onSubmissionIntent: persist });
    expect(result).toMatchObject({ status: "submitted-unknown", creditStatus: "unconfirmed", transactionHash: persist.mock.calls[0][0] });
    expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();
  });
  it("rechecks authority after signing and records a safe preflight phase", async () => {
    const authority = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked")), persist = vi.fn();
    await expect(submitComputeFunding(intent(), key, { assertAuthority: authority, onSubmissionIntent: persist })).rejects.toMatchObject({ phase: "not-submitted", transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(persist).toHaveBeenCalledOnce(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("binds receipt evidence to payer, beneficiary, calldata, amount, and chain", async () => {
    const deposit = intent();
    rpc.getTransaction.mockResolvedValue({ to: deposit.to, from: payerAddress, input: deposit.data, value: BigInt(deposit.amountWei), chainId: 16602 });
    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", gasUsed: 21_000n, effectiveGasPrice: 2n, blockNumber: 123n });
    await expect(reconcileComputeFunding(deposit, transactionHash)).resolves.toMatchObject({ status: "confirmed", amountWei: deposit.amountWei, gasPaidWei: "42000", beneficiary: computeAccountAddress, creditStatus: "awaiting-router-sync" });
    rpc.getTransaction.mockResolvedValue({ to: deposit.to, from: ownerAddress, input: deposit.data, value: BigInt(deposit.amountWei), chainId: 16602 });
    await expect(reconcileComputeFunding(deposit, transactionHash)).rejects.toMatchObject({ code: "FUNDING_EVIDENCE_MISMATCH" });
  });
  it("does not turn an absent receipt into funded compute credits", async () => {
    rpc.getTransaction.mockRejectedValue(new Error("not found"));
    await expect(reconcileComputeFunding(intent(), transactionHash)).resolves.toMatchObject({ status: "submitted-unknown", creditStatus: "unconfirmed" });
  });
});
