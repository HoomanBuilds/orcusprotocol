import { describe, expect, it, vi } from "vitest";
import type { PreparedAction } from "@orcus/core";
import { actionRecovery, actionReviewLabel, fundingRecovery, hasAtomicNativeInput, tradingGasStatus, withFundingRecoveryIntent, type WalletExecutionConfig } from "./trade-ux";

const configured: WalletExecutionConfig = { chainId: 11155111, smartAccountsConfigured: true, gasPayment: { mode: "self-funded", payer: "smart-account", maxOperationGasWei: "3000000000000000", chainId: 11155111 } };

describe("explicit control-operation reviews", () => {
  it.each([["cancel", "Cancel order"], ["edit-order", "Update order"], ["stop-loss", "Update stop-loss"], ["take-profit", "Update take-profit"], ["close", "Close position"], ["reduce", "Reduce position"], ["add-collateral", "Add collateral"], ["remove-collateral", "Remove collateral"]] as const)("labels %s by its actual operation rather than its incidental side", (type, label) => {
    expect(actionReviewLabel({ type, side: "buy" })).toBe(label);
    expect(actionReviewLabel({ type, side: "sell" })).toBe(label);
  });
});

describe("honest trading gas readiness", () => {
  it("requires Sepolia bundler and self-funded mode, not a paymaster", () => {
    expect(tradingGasStatus(configured, "uniswap").ready).toBe(true);
    for (const value of [null, { ...configured, chainId: 1 }, { ...configured, smartAccountsConfigured: false }, { ...configured, gasPayment: undefined }, { ...configured, gasPayment: { ...configured.gasPayment!, chainId: 1 } }]) expect(tradingGasStatus(value, "uniswap").ready).toBe(false);
  });
  it("identifies the shared smart account as the payer without claiming a funded balance", () => {
    expect(tradingGasStatus(null, "uniswap").label).toBe("Smart-account execution unavailable");
    const ready = tradingGasStatus(configured, "uniswap");
    expect(ready.label).toBe("Trading account pays Sepolia ETH");
    expect(ready.detail).toMatch(/same account, not the session signer/);
    expect(ready.detail).toMatch(/Gas is checked before signing/);
    expect(ready.detail).toMatch(/no automatic top-ups/);
  });
  it("keeps each venue's native gas and fee model distinct", () => {
    expect(tradingGasStatus(null, "hyperliquid")).toMatchObject({ ready: true, label: "Venue trading fees apply" });
    expect(tradingGasStatus(null, "hyperliquid").detail).toMatch(/signed API requests/);
    expect(tradingGasStatus(null, "ostium").detail).toMatch(/Owner actions use the owner's Arbitrum Sepolia ETH/);
    expect(tradingGasStatus(null, "ostium").detail).toMatch(/agent signer ETH/);
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
  it("explains expired unobserved requests without claiming a venue rejection", () => {
    expect(actionRecovery("expired")).toContain("No execution was observed");
    expect(actionRecovery("expired")).toContain("will not be retried");
  });
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
