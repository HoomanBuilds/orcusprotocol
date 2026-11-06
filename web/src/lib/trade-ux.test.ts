import { describe, expect, it, vi } from "vitest";
import type { PreparedAction } from "@orcus/core";
import { actionRecovery, fundingRecovery, hasAtomicNativeInput, tradingGasStatus, withFundingRecoveryIntent, type WalletExecutionConfig } from "./trade-ux";

const configured: WalletExecutionConfig = { chainId: 11155111, smartAccountsConfigured: true, gasSponsorship: { required: true, configured: true, status: "configured" } };

describe("honest trading gas readiness", () => {
  it("requires Sepolia, bundler, and sponsor metadata, not just readable RPC or an account", () => {
    expect(tradingGasStatus(configured, "uniswap").ready).toBe(true);
    for (const value of [null, { ...configured, chainId: 1 }, { ...configured, smartAccountsConfigured: false }, { ...configured, gasSponsorship: undefined }, { ...configured, gasSponsorship: { required: true, configured: false, status: "unconfigured" as const } }]) expect(tradingGasStatus(value, "uniswap").ready).toBe(false);
  });
  it("never silently offers owner-paid gas when sponsorship is unavailable", () => {
    expect(tradingGasStatus(null, "uniswap").label).toBe("Gas sponsorship unavailable");
    expect(tradingGasStatus(configured, "uniswap").detail).toMatch(/no owner-paid gas fallback/);
    expect(tradingGasStatus(null, "hyperliquid")).toMatchObject({ ready: true, label: "Venue trading fees apply" });
  });
  it("identifies the selected sponsor without claiming configuration proves a paid operation", () => {
    expect(tradingGasStatus({ ...configured, gasSponsorship: { ...configured.gasSponsorship!, provider: "operator" } }, "uniswap").detail).toMatch(/platform-funded sponsor/);
    const secondary = tradingGasStatus({ ...configured, gasSponsorship: { ...configured.gasSponsorship!, provider: "zerodev" } }, "uniswap");
    expect(secondary.detail).toMatch(/explicitly selected hosted sponsor/);
    expect(secondary.label).toMatch(/after sponsor approval/);
    expect(secondary.detail).toMatch(/do not need a gas-provider account/);
  });
});

describe("funding transfer recovery", () => {
  it("persists an unknown intent with no invented hash before a wallet request can start", async () => {
    const records = new Map<string, string>();
    const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.fn(() => {
      expect(fundingRecovery(JSON.parse(records.get("account-one")!))).toEqual({ status: "unknown" });
      expect(records.has("account-two")).toBe(false);
      return pending;
    });
    const result = withFundingRecoveryIntent(storage, "account-one", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fundingRecovery(JSON.parse(records.get("account-one")!))).toEqual({ status: "unknown" });
    finish(); await result;
  });
  it("never calls a wallet if the recovery record cannot be written and read back", () => {
    const send = vi.fn(async () => undefined);
    expect(() => withFundingRecoveryIntent({ getItem: () => null, setItem: () => { throw new Error("storage blocked"); } }, "account", send)).toThrow(expect.objectContaining({ code: "FUNDING_RECOVERY_UNAVAILABLE", phase: "not-submitted" }));
    expect(() => withFundingRecoveryIntent({ getItem: () => null, setItem: () => undefined }, "account", send)).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps only bounded public transaction recovery metadata", () => {
    const transactionHash = `0x${"1".repeat(64)}`;
    expect(fundingRecovery({ status: "unknown", transactionHash, privateKey: "do-not-copy", rawProviderMessage: "not public" })).toEqual({ status: "unknown", transactionHash });
    expect(fundingRecovery({ status: "unknown" })).toEqual({ status: "unknown" });
    expect(fundingRecovery({ status: "confirmed", transactionHash })).toEqual({ status: "confirmed", transactionHash });
  });
  it.each([null, {}, { status: "confirmed" }, { status: "confirmed", transactionHash: "invalid" }, { status: "anything", transactionHash: `0x${"2".repeat(64)}` }])("does not invent a confirmed recovery record", input => expect(fundingRecovery(input)).toBeNull());
});

describe("pending trade recovery", () => {
  it.each(["submitting", "submitted-unknown"] as const)("does not invite another submission for %s", status => expect(actionRecovery(status)).toMatch(/do not send a replacement/));
  it("distinguishes accepted, partially filled, and cancelled orders", () => {
    expect(actionRecovery("pending")).toMatch(/not confirmed/);
    expect(actionRecovery("partially-filled")).toMatch(/part of this order/);
    expect(actionRecovery("cancelled")).toMatch(/fills/);
    expect(actionRecovery("confirmed")).toBeUndefined();
  });
});

describe("atomic ETH input presentation", () => {
  const account = `0x${"1".repeat(40)}`, weth = `0x${"2".repeat(40)}`;
  const prepared: PreparedAction = {
    id: "action", kind: "user-operation", expiresAt: Date.now() + 60_000, controlRevision: 0,
    account: { id: "account", userId: "user", address: account, smartAccountAddress: account, ownerAddress: `0x${"3".repeat(40)}`, venue: "uniswap", chainId: 11155111, status: "connected", controlRevision: 0 },
    request: { accountId: "account", venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.001", nativeInput: true, tokenIn: weth, mode: "manual", reduceOnly: false, slippageBps: 50 },
    transactions: [{ to: weth, data: "0xd0e30db0", value: "1000000000000000", chainId: 11155111 }, { to: `0x${"4".repeat(40)}`, data: "0x1234", value: "0", chainId: 11155111 }],
  };
  it("advertises wrapping only for the exact native amount in a single smart-account batch", () => {
    expect(hasAtomicNativeInput(prepared)).toBe(true);
    expect(hasAtomicNativeInput({ ...prepared, transactions: [{ ...prepared.transactions![0]!, value: "999" }, prepared.transactions![1]!] })).toBe(false);
    expect(hasAtomicNativeInput({ ...prepared, account: { ...prepared.account, smartAccountAddress: undefined } })).toBe(false);
    expect(hasAtomicNativeInput({ ...prepared, request: { ...prepared.request, nativeInput: false } })).toBe(false);
    expect(hasAtomicNativeInput({ ...prepared, request: { ...prepared.request, side: "buy" } })).toBe(false);
    expect(hasAtomicNativeInput({ ...prepared, kind: "evm" })).toBe(false);
  });
});
