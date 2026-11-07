import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, zeroAddress } from "viem";
import type { TradingAccount } from "@orcus/core";
import { OSTIUM_TESTNET, ostiumTradingAbi, type OstiumAllowancePlan, type OstiumDelegationPlan } from "./ostium";

const mocks = vi.hoisted(() => ({ read: vi.fn(), estimate: vi.fn(), send: vi.fn(), wait: vi.fn(), deployment: vi.fn(), fetch: vi.fn() }));
vi.mock("viem", async original => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.read, estimateGas: mocks.estimate, waitForTransactionReceipt: mocks.wait }),
  createWalletClient: ({ account }: { account: string }) => ({ account: { address: account }, getChainId: async () => 421614, sendTransaction: mocks.send }),
}));
vi.mock("./ostium-owner", async original => ({ ...await original<typeof import("./ostium-owner")>(), assertOstiumOwnerDeployment: mocks.deployment }));
import { approveOstiumAllowance, grantOstiumPermission, revokeOstiumPermission } from "./client";

const owner = `0x${"1".repeat(40)}` as const, agent = `0x${"2".repeat(40)}` as const, hash = `0x${"a".repeat(64)}` as const;
const account: TradingAccount = { id: "ostium", userId: "user", venue: "ostium", address: owner, ownerAddress: owner, agentAddress: agent, chainId: 421614, status: "connected", controlRevision: 1 };
const acknowledgement = { version: "ostium-native-delegation-v1", chainId: 421614, trader: owner, agentAddress: agent, nativeNoExpiry: true, applicationLimitsOnly: true, delegateCanRemoveCollateral: true, delegateCanChargeBuilderFees: true, ownerOnlyPermissionChanges: true, payoutsToOwner: true };
const grant = (): OstiumDelegationPlan => ({ trader: owner, delegate: agent, currentDelegate: zeroAddress, chainId: 421614, contractAddress: OSTIUM_TESTNET.trading, expiresAt: Date.now() + 60_000, alreadyActive: false, transactions: [{ to: OSTIUM_TESTNET.trading, data: encodeFunctionData({ abi: ostiumTradingAbi, functionName: "setDelegate", args: [agent] }), value: "0", chainId: 421614 }] });
const allowance = (): OstiumAllowancePlan => ({ id: "allowance", accountId: account.id, trader: owner, chainId: 421614, token: OSTIUM_TESTNET.usdc, spender: OSTIUM_TESTNET.storage, amountUsd: "100", amountRaw: "100000000", status: "prepared", expiresAt: Date.now() + 60_000, transaction: { to: OSTIUM_TESTNET.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, 100_000_000n] }), value: "0", chainId: 421614 } });
const grantCall = () => grantOstiumPermission({ account, plan: grant(), acknowledgement });
const approvalCall = () => approveOstiumAllowance({ account, intent: allowance() });
const requests = () => mocks.fetch.mock.calls.filter(([url]) => url.startsWith("/api/ostium/allowances/")).map(([url, options]) => ({ url, body: JSON.parse(options.body) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deployment.mockResolvedValue(undefined);
  mocks.read.mockResolvedValueOnce(zeroAddress).mockResolvedValue(agent);
  mocks.estimate.mockResolvedValue(21_001n);
  mocks.send.mockResolvedValue(hash);
  mocks.wait.mockResolvedValue({ status: "success" });
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => ({ data: url === "/api/session" ? { user: { address: owner }, accounts: [account] } : {} }) }));
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { ethereum: { request: async ({ method }: { method: string }) => method === "eth_accounts" ? [owner] : "0x66eee" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Ostium wallet submission boundaries", () => {
  it("estimates the exact owner grant and pads gas without overriding wallet fees", async () => {
    await grantCall();
    const call = { account: owner, to: OSTIUM_TESTNET.trading, data: grant().transactions[0].data, value: 0n };
    expect(mocks.estimate).toHaveBeenCalledExactlyOnceWith(call);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ to: call.to, data: call.data, value: 0n, gas: 25_202n });
  });
  it("estimates owner revocation before sending", async () => {
    mocks.read.mockReset().mockResolvedValueOnce(agent).mockResolvedValue(zeroAddress);
    const data = encodeFunctionData({ abi: ostiumTradingAbi, functionName: "removeDelegate" });
    const plan = { ...grant(), delegate: zeroAddress, currentDelegate: agent, transactions: [{ ...grant().transactions[0], data }] };
    await revokeOstiumPermission({ account, plan });
    expect(mocks.estimate).toHaveBeenCalledExactlyOnceWith({ account: owner, to: OSTIUM_TESTNET.trading, data, value: 0n });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ to: OSTIUM_TESTNET.trading, data, value: 0n, gas: 25_202n });
  });
  it("skips estimation and signing when the reviewed delegate is already active", async () => {
    mocks.read.mockReset().mockResolvedValue(agent);
    await expect(grantOstiumPermission({ account, acknowledgement, plan: { ...grant(), currentDelegate: agent, alreadyActive: true, transactions: [] } })).resolves.toEqual({ alreadyActive: true });
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([grantCall, approvalCall])("keeps gas estimation failures safely retryable before any send or claim", async call => {
    mocks.estimate.mockRejectedValueOnce(new Error("gas required exceeds allowance"));
    await expect(call()).rejects.toMatchObject({ code: "GAS_ESTIMATION_FAILED", phase: "not-submitted" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(requests()).toEqual([]);
  });
  it.each([0n, -1n])("rejects invalid gas estimates %s before submission", async estimate => {
    mocks.estimate.mockResolvedValueOnce(estimate);
    await expect(grantCall()).rejects.toMatchObject({ code: "GAS_ESTIMATION_FAILED", phase: "not-submitted" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rechecks deployment after estimation and before the wallet send", async () => {
    mocks.estimate.mockImplementationOnce(async () => {
      mocks.deployment.mockRejectedValueOnce(new Error("deployment changed"));
      return 21_001n;
    });
    await expect(grantCall()).rejects.toMatchObject({ phase: "not-submitted" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("estimates the exact allowance before claiming it and submits once", async () => {
    await approvalCall();
    const data = allowance().transaction.data;
    expect(mocks.estimate).toHaveBeenCalledExactlyOnceWith({ account: owner, to: OSTIUM_TESTNET.usdc, data, value: 0n });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ to: OSTIUM_TESTNET.usdc, data, value: 0n, gas: 25_202n });
    expect(requests().filter(call => call.url.endsWith("/submit") && call.body.submissionToken)).toHaveLength(1);
    expect(mocks.estimate.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[mocks.fetch.mock.calls.findIndex(([url]) => url.endsWith("/submit"))]);
  });
  it("classifies raw deployment and delegate read errors before sending as not submitted", async () => {
    mocks.deployment.mockRejectedValueOnce(new Error("RPC offline"));
    await expect(grantCall()).rejects.toMatchObject({ code: "PREFLIGHT_FAILED", phase: "not-submitted" });
    mocks.read.mockReset().mockRejectedValueOnce(new Error("RPC offline"));
    await expect(grantCall()).rejects.toMatchObject({ code: "PREFLIGHT_FAILED", phase: "not-submitted" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("keeps ambiguous permission sends unresolved", async () => {
    mocks.send.mockRejectedValueOnce(new Error("Wallet timeout"));
    await expect(grantCall()).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN", phase: "submitted-unknown" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("preserves the hash if native permission verification fails after confirmation", async () => {
    mocks.read.mockReset().mockResolvedValueOnce(zeroAddress).mockRejectedValueOnce(new Error("RPC offline"));
    await expect(grantCall()).rejects.toMatchObject({ code: "PERMISSION_NOT_PROVEN", phase: "submitted-unknown", evidence: { transactionHash: hash } });
  });
  it("does not claim an allowance when initial checks fail", async () => {
    mocks.deployment.mockRejectedValueOnce(new Error("RPC offline"));
    await expect(approvalCall()).rejects.toMatchObject({ phase: "not-submitted" });
    expect(requests()).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("releases only its claimed allowance after a final pre-send check fails", async () => {
    mocks.deployment.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("RPC offline"));
    await expect(approvalCall()).rejects.toMatchObject({ code: "PREFLIGHT_FAILED", phase: "not-submitted" });
    const calls = requests();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("/api/ostium/allowances/submit");
    expect(calls[0].body.submissionToken).toMatch(/^[\da-f-]{36}$/);
    expect(calls[1]).toEqual({ url: "/api/ostium/allowances/cancel", body: { intentId: "allowance", preflightFailed: true, submissionToken: calls[0].body.submissionToken } });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not cancel another tab's pending claim when claiming fails", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, options: unknown) => url.endsWith("/submit") ? { ok: false } : original(url, options));
    await expect(approvalCall()).rejects.toMatchObject({ phase: "not-submitted" });
    expect(requests().map(call => call.url)).toEqual(["/api/ostium/allowances/submit"]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("never releases an allowance after the send was invoked with an uncertain outcome", async () => {
    mocks.send.mockRejectedValueOnce(new Error("Wallet timeout"));
    await expect(approvalCall()).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN", phase: "submitted-unknown" });
    expect(requests().map(call => call.url)).toEqual(["/api/ostium/allowances/submit"]);
  });
  it("keeps explicit wallet rejection separate from preflight failures", async () => {
    mocks.send.mockRejectedValueOnce({ code: 4001, message: "User rejected" });
    await expect(approvalCall()).rejects.toMatchObject({ code: "OWNER_REJECTED", phase: "not-submitted" });
    expect(requests()[1]).toEqual({ url: "/api/ostium/allowances/cancel", body: { intentId: "allowance", ownerRejected: true, submissionToken: requests()[0].body.submissionToken } });
  });
});
