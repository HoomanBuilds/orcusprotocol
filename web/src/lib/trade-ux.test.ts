import { describe, expect, it } from "vitest";
import type { PreparedAction } from "@orcus/core";
import { actionRecovery, fundingRecovery, hasAtomicNativeInput, tradingGasStatus, type WalletExecutionConfig } from "./trade-ux";

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
});

describe("funding transfer recovery", () => {
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
