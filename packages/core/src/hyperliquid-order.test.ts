import { describe, expect, it } from "vitest";
import { checkHyperliquidOrderSize } from "./hyperliquid-order";

const input = { amount: "0.005", price: "2000", sizeDecimals: 4 };

describe("Hyperliquid minimum order checks", () => {
  it("accepts exactly 10 USDC and rejects one lot below it", () => {
    expect(checkHyperliquidOrderSize(input)).toMatchObject({ valid: true, minimumSize: "0.005" });
    expect(checkHyperliquidOrderSize({ ...input, amount: "0.0049" })).toMatchObject({ valid: false, code: "MINIMUM_NOTIONAL", minimumSize: "0.005" });
  });
  it("rounds the minimum up to a venue lot and checks the limit price", () => {
    expect(checkHyperliquidOrderSize({ ...input, amount: "0.0001", price: "2269.1" })).toMatchObject({ valid: false, minimumSize: "0.0045" });
    expect(checkHyperliquidOrderSize({ ...input, price: "1000" })).toMatchObject({ valid: false, minimumSize: "0.01" });
  });
  it.each(["", "0", "0.0000", "-1", "1e-3", "Infinity", "NaN", "1".repeat(81)])("rejects invalid amount %s", amount => {
    expect(checkHyperliquidOrderSize({ ...input, amount })).toMatchObject({ valid: false, code: "INVALID_AMOUNT" });
  });
  it("rejects excessive precision instead of silently rounding", () => {
    expect(checkHyperliquidOrderSize({ ...input, amount: "0.00501" })).toMatchObject({ valid: false, code: "INVALID_PRECISION" });
  });
  it.each([undefined, "0", "NaN", "Infinity", "1e3"])("does not infer a minimum from unavailable price %s", price => {
    expect(checkHyperliquidOrderSize({ ...input, price })).toMatchObject({ valid: false, code: "MARKET_DATA_UNAVAILABLE" });
  });
  it("requires a fresh quote and valid venue precision", () => {
    expect(checkHyperliquidOrderSize({ ...input, observedAt: 1, now: 30_002 })).toMatchObject({ valid: false, code: "MARKET_DATA_UNAVAILABLE" });
    expect(checkHyperliquidOrderSize({ ...input, observedAt: 2, now: 1 })).toMatchObject({ valid: false, code: "MARKET_DATA_UNAVAILABLE" });
    expect(checkHyperliquidOrderSize({ ...input, sizeDecimals: undefined })).toMatchObject({ valid: false, code: "MARKET_DATA_UNAVAILABLE" });
  });
  it("does not impose an entry minimum on reduce-only exits", () => {
    expect(checkHyperliquidOrderSize({ ...input, amount: "0.0001", reduceOnly: true })).toEqual({ valid: true });
    expect(checkHyperliquidOrderSize({ ...input, amount: "0", reduceOnly: true }).valid).toBe(false);
    expect(checkHyperliquidOrderSize({ ...input, amount: "0.00001", reduceOnly: true }).valid).toBe(false);
  });
  it("compares decimals exactly without floating-point loss", () => {
    expect(checkHyperliquidOrderSize({ amount: "1", price: "9.999999999999999999999999999999999999", sizeDecimals: 0 })).toMatchObject({ valid: false, minimumSize: "2" });
    expect(checkHyperliquidOrderSize({ amount: "100000000000000000000", price: "0.0000000000000000001", sizeDecimals: 0 }).valid).toBe(true);
  });
});
