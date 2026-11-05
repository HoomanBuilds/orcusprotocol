import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import type { KernelGrantPolicy } from "./kernel";
import { zeroAddress } from "viem";

const mocks = vi.hoisted(() => ({
  ownerAddress: `0x${"6".repeat(40)}`,
  accountAddress: `0x${"1".repeat(40)}`,
  currentAddress: `0x${"6".repeat(40)}`,
  chainId: 11155111,
  switchAccount: false,
  ownerCode: "0x",
  sign: vi.fn(),
  send: vi.fn(),
  wait: vi.fn(),
  prepare: vi.fn(),
  read: vi.fn(),
  getCode: vi.fn(),
  estimateGas: vi.fn(),
  estimateFees: vi.fn(),
  getBalance: vi.fn(),
  sendTransaction: vi.fn(),
  waitTransaction: vi.fn(),
}));

vi.mock("viem", async importOriginal => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => ({ account: { address: mocks.currentAddress }, getChainId: async () => mocks.chainId, switchChain: async ({ id }: { id: number }) => { mocks.chainId = id; if (mocks.switchAccount) mocks.currentAddress = mocks.accountAddress; }, sendTransaction: mocks.sendTransaction }),
}));

vi.mock("./kernel", async importOriginal => ({
  ...await importOriginal<typeof import("./kernel")>(),
  kernelPublicClient: () => ({ getCode: async () => mocks.ownerCode }),
  createOwnerKernel: async () => ({
    account: { address: mocks.accountAddress, encodeCalls: async () => "0x1234", signUserOperation: mocks.sign },
    client: { prepareUserOperation: mocks.prepare, sendUserOperation: mocks.send, waitForUserOperationReceipt: mocks.wait },
    publicClient: { getCode: mocks.getCode, readContract: mocks.read, estimateGas: mocks.estimateGas, estimateFeesPerGas: mocks.estimateFees, getBalance: mocks.getBalance, waitForTransactionReceipt: mocks.waitTransaction },
  }),
  createPermissionPlugin: async () => ({ getIdentifier: () => "0x12345678", getEnableData: async () => "0x" }),
}));

import { createTradingSmartAccount, executePreparedAction, fundTradingAccount, invalidateKernelPendingApprovals, revokeKernelPermission } from "./client";

const account: TradingAccount = { id: "account", userId: "user", venue: "uniswap", address: mocks.accountAddress, ownerAddress: mocks.ownerAddress, chainId: 11155111, status: "authorized", controlRevision: 1 };
const policy: KernelGrantPolicy = { accountAddress: mocks.accountAddress, agentAddress: `0x${"2".repeat(40)}`, router: `0x${"3".repeat(40)}`, swaps: [{ tokenIn: `0x${"4".repeat(40)}`, tokenOut: `0x${"5".repeat(40)}`, feeTier: 500, maxAmountIn: "1000", minAmountOut: "900" }], issuedAt: Date.now(), expiresAt: Date.now() + 60_000, maxGasWei: "1000" };
const operationHash = `0x${"a".repeat(64)}`;
const txHash = `0x${"b".repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentAddress = mocks.ownerAddress;
  mocks.chainId = 11155111;
  mocks.switchAccount = false;
  mocks.ownerCode = "0x";
  mocks.getCode.mockResolvedValue("0x1234");
  mocks.prepare.mockResolvedValue({ sender: mocks.accountAddress, nonce: 0n, callData: "0x1234", callGasLimit: 10n, verificationGasLimit: 10n, preVerificationGas: 10n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  mocks.sign.mockResolvedValue("0x1234");
  mocks.send.mockResolvedValue(operationHash);
  mocks.wait.mockResolvedValue({ success: true, receipt: { transactionHash: txHash } });
  mocks.estimateGas.mockResolvedValue(21_000n);
  mocks.estimateFees.mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  mocks.getBalance.mockResolvedValue(10n ** 20n);
  mocks.sendTransaction.mockResolvedValue(txHash);
  mocks.waitTransaction.mockResolvedValue({ status: "success", transactionHash: txHash });
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000" }, ethereum: { request: async ({ method }: { method: string }) => method === "eth_accounts" ? [mocks.currentAddress] : `0x${mocks.chainId.toString(16)}` } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => ({ data: url === "/api/session" ? { user: { address: mocks.ownerAddress }, accounts: [account] } : { smartAccountsConfigured: true, rpcUrl: "/api/rpc", bundlerUrl: "/api/bundler", chainId: 11155111 } }) })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("owner account binding", () => {
  it("rechecks the owner when switching networks changes the selected wallet", async () => {
    mocks.chainId = 1;
    mocks.switchAccount = true;
    await expect(createTradingSmartAccount()).rejects.toMatchObject({ code: "OWNER_CHANGED", phase: "not-submitted" });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("does not pretend ECDSA validators support multisig contract owners", async () => {
    mocks.ownerCode = "0x1234";
    await expect(createTradingSmartAccount()).rejects.toMatchObject({ code: "OWNER_TYPE_UNSUPPORTED" });
  });
  it("rejects stale account revisions before signing or gas estimation", async () => {
    const action = { account, controlRevision: 2, expiresAt: Date.now() + 60_000 } as PreparedAction;
    await expect(executePreparedAction(action)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe("native permission revocation", () => {
  it("requires explicit invalidation for a signed but never-installed grant", async () => {
    mocks.read.mockResolvedValue({ signer: zeroAddress });
    await expect(revokeKernelPermission(policy)).rejects.toMatchObject({ code: "PENDING_APPROVAL_INVALIDATION_REQUIRED" });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("does not report RPC errors as proof that a session is disabled", async () => {
    mocks.read.mockResolvedValueOnce({ signer: mocks.ownerAddress }).mockRejectedValueOnce(new Error("RPC down"));
    await expect(revokeKernelPermission(policy)).rejects.toMatchObject({ code: "REVOCATION_PROOF_UNAVAILABLE", evidence: { transactionHash: txHash } });
  });
  it("returns a revocation hash only after checking the signer is cleared", async () => {
    mocks.read.mockResolvedValueOnce({ signer: mocks.ownerAddress }).mockResolvedValueOnce({ signer: zeroAddress });
    await expect(revokeKernelPermission(policy)).resolves.toBe(txHash);
  });
  it("never invalidates all older sessions without explicit confirmation", async () => {
    await expect(invalidateKernelPendingApprovals(policy, { invalidateAllOlderSessions: false } as never)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("checks the resulting nonce floor after explicit invalidation", async () => {
    mocks.read.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(invalidateKernelPendingApprovals(policy, { invalidateAllOlderSessions: true })).resolves.toMatchObject({ nonceFloor: 2, invalidatedAllOlderSessions: true });
  });
});

describe("owner-signed account funding", () => {
  it("refuses mainnet funding", async () => {
    await expect(fundTradingAccount({ account: { ...account, chainId: 1 }, asset: "ETH", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED_NETWORK" });
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });
  it("keeps ETH for gas and requires an explicit owner wallet transaction", async () => {
    mocks.getBalance.mockResolvedValue(10n ** 18n);
    await expect(fundTradingAccount({ account, asset: "ETH", amount: "1" })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });
  it("funds only the derived account with testnet ETH", async () => {
    await expect(fundTradingAccount({ account, asset: "ETH", amount: "0.01" })).resolves.toMatchObject({ recipient: mocks.accountAddress, chainId: 11155111, transactionHash: txHash });
    expect(mocks.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: mocks.accountAddress, value: 10n ** 16n }));
  });
  it("distinguishes an owner rejection from an unknown send result", async () => {
    mocks.sendTransaction.mockRejectedValueOnce({ code: 4001 });
    await expect(fundTradingAccount({ account, asset: "ETH", amount: "0.01" })).rejects.toMatchObject({ code: "OWNER_REJECTED", phase: "not-submitted" });
    mocks.sendTransaction.mockRejectedValueOnce(new Error("transport timeout"));
    await expect(fundTradingAccount({ account, asset: "ETH", amount: "0.01" })).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN", phase: "submitted-unknown" });
  });
});
