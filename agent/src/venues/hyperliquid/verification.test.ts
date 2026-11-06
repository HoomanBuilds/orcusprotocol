import { describe, expect, it } from "vitest";
import type { PreparedAction } from "@orcus/core";
import { assertBoundedTestAction, assertEmptyTestAccount, cappedEthSize, positiveFees, verificationArgs } from "../../../../scripts/lib/hyperliquid-testnet";

const owner = "0x1111111111111111111111111111111111111111";
const caps = { owner, assetIndex: 4, maxSize: "0.005", maxNotional: "20", opening: true };
const prepared: PreparedAction = { id: "verification", expiresAt: Date.now() + 20_000, controlRevision: 0, kind: "hyperliquid", account: { id: "account", userId: "owner", ownerAddress: owner, venue: "hyperliquid", chainId: 421614, address: owner, status: "connected", controlRevision: 0 }, request: { accountId: "account", venue: "hyperliquid", symbol: "ETH", type: "market", side: "buy", amount: "0.005", slippageBps: 50, mode: "manual", reduceOnly: false }, hyperliquid: { method: "order", params: { grouping: "na", orders: [{ a: 4, b: true, s: "0.005", p: "4000", r: false }] } } };

describe("bounded Hyperliquid verification gates", () => {
  it("defaults to read-only and requires explicit exact write caps", () => {
    expect(verificationArgs([`--expected-owner=${owner}`])).toMatchObject({ allowTrades: false, maxNotional: "20", maxFees: "1" });
    expect(() => verificationArgs([`--expected-owner=${owner}`, "--allow-testnet-trades"])).toThrow("explicit notional and fee caps");
    for (const flag of ["--mainnet", "--max-notional-usdc=21", "--max-fees-usdc=1.000001", "--max-fees-usdc=0"]) expect(() => verificationArgs([`--expected-owner=${owner}`, flag])).toThrow();
    expect(() => verificationArgs([`--expected-owner=${owner}`, `--expected-owner=${owner}`])).toThrow();
  });
  it("refuses pre-existing exposure or replacing a named agent", () => {
    const clean = { positions: [], orders: [], freeCollateralUsd: "185.426761" };
    expect(() => assertEmptyTestAccount(clean, [{ name: "keep-existing" }])).not.toThrow();
    for (const state of [{ ...clean, positions: [{}] }, { ...clean, orders: [{}] }, { ...clean, freeCollateralUsd: "20.999999" }]) expect(() => assertEmptyTestAccount(state, [])).toThrow();
    expect(() => assertEmptyTestAccount(clean, [{ name: "a" }, { name: "b" }, { name: "c" }])).toThrow();
  });
  it("rounds the single ETH position down with a price buffer", () => {
    expect(cappedEthSize("4000", 4, "20")).toBe("0.0049");
    expect(() => cappedEthSize("0", 4, "20")).toThrow();
    expect(() => cappedEthSize("4000", 0, "20")).toThrow();
  });
  it("allows one bounded opening and only reduce-only follow-ups", () => {
    expect(() => assertBoundedTestAction(prepared, caps)).not.toThrow();
    const patch = (order: Record<string, unknown>) => ({ ...prepared, hyperliquid: { ...prepared.hyperliquid!, params: { grouping: "na", orders: [{ ...(prepared.hyperliquid!.params.orders as Record<string, unknown>[])[0], ...order }] } } });
    for (const order of [{ s: "0.0051" }, { p: "4001" }, { a: 5 }, { b: false }, { r: true }]) expect(() => assertBoundedTestAction(patch(order), caps)).toThrow();
    expect(() => assertBoundedTestAction(patch({ b: false, r: true }), { ...caps, opening: false })).not.toThrow();
    expect(() => assertBoundedTestAction(prepared, { ...caps, opening: false })).toThrow();
    expect(() => assertBoundedTestAction({ ...prepared, expiresAt: Date.now() - 1 }, caps)).toThrow("expired");
    expect(() => assertBoundedTestAction({ ...prepared, account: { ...prepared.account, chainId: 42161 } }, caps)).toThrow();
    expect(() => assertBoundedTestAction({ ...prepared, hyperliquid: { ...prepared.hyperliquid!, params: { ...prepared.hyperliquid!.params, builder: { b: owner, f: 1 } } } }, caps)).toThrow();
  });
  it("counts exact positive fees only for recorded ETH order IDs", () => {
    const fill = { oid: 1, tid: 1, coin: "ETH", feeToken: "USDC", fee: "0.0085" };
    expect(positiveFees([fill, { ...fill, oid: 2 }, { ...fill, tid: 2, fee: "-0.0001" }], new Set([1]))).toBe("0.0085");
    expect(() => positiveFees([fill, fill], new Set([1]))).toThrow();
    expect(() => positiveFees([{ ...fill, feeToken: "HYPE" }], new Set([1]))).toThrow();
  });
});
