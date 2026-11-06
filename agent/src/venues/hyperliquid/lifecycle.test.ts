import { describe, expect, it } from "vitest";
import { classifyOrderStatus, sizeProgress, summarizeOrderFills } from "./lifecycle";

const fill = (overrides: Record<string, unknown> = {}) => ({ oid: 42, coin: "ETH", tid: 1, sz: "0.001", px: "2345.67", fee: "0.0001", feeToken: "USDC", time: 1_700_000_000_000, ...overrides });

describe("Hyperliquid order lifecycle", () => {
  it.each(["open", "resting", "triggered"])("keeps %s nonterminal", status => {
    expect(classifyOrderStatus(status)).toBe("pending");
  });
  it.each(["canceled", "marginCanceled", "reduceOnlyCanceled", "scheduledCancel", "internalCancel"])("recognizes explicit cancellation %s", status => {
    expect(classifyOrderStatus(status)).toBe("cancelled");
  });
  it.each(["rejected", "iocCancelRejected", "badAloPxRejected", "perpMarginRejected"])("recognizes explicit rejection %s", status => {
    expect(classifyOrderStatus(status)).toBe("rejected");
  });
  it("does not guess new terminal statuses from substrings", () => {
    expect(classifyOrderStatus("filled")).toBe("confirmed");
    expect(classifyOrderStatus("unknownCanceledState")).toBe("submitted-unknown");
    expect(classifyOrderStatus("notRejectedYet")).toBe("submitted-unknown");
  });
  it("compares sizes as exact decimals rather than strings or floats", () => {
    expect(sizeProgress("0.0100", "0.01")).toMatchObject({ partial: false, remainingSize: "0.01" });
    expect(sizeProgress("0.000000000000000001", "0.000000000000000002")).toMatchObject({ partial: true });
    expect(sizeProgress("0", "0.01")).toMatchObject({ partial: false });
    expect(sizeProgress("2", "1")).toBeUndefined();
    expect(sizeProgress("NaN", "1")).toBeUndefined();
    expect(sizeProgress("-1", "1")).toBeUndefined();
  });
});

describe("Hyperliquid order fill evidence", () => {
  it("correlates by order and market and deduplicates trade IDs", () => {
    const first = fill(), second = fill({ tid: 2, sz: "0.002", px: "2000", fee: "-0.00001" });
    const result = summarizeOrderFills([first, first, second, fill({ oid: 43 }), fill({ tid: 3, coin: "BTC" })], 42, "ETH", "0.01");
    expect(result.fills).toHaveLength(2);
    expect(result.observedExecutedSize).toBe("0.003");
    expect(result.observedExecutedQuote).toBe("6.34567");
    expect(result.observedFeesByToken).toEqual({ USDC: "0.00009" });
    expect(result.fillsComplete).toBe(false);
  });
  it("preserves distinct fee currencies and exact quantities beyond float precision", () => {
    const result = summarizeOrderFills([fill({ sz: "0.000000000000000001", px: "9007199254740993", fee: "0.000000000000000001" }), fill({ tid: 2, feeToken: "HYPE", fee: "0.2" })], 42, "ETH");
    expect(result.observedExecutedSize).toBe("0.001000000000000001");
    expect(result.observedExecutedQuote).toBe("2.354677199254740993");
    expect(result.observedFeesByToken).toEqual({ USDC: "0.000000000000000001", HYPE: "0.2" });
  });
  it("does not claim an empty or partial retained history proves full execution", () => {
    expect(summarizeOrderFills([], 42, "ETH", "1")).toMatchObject({ observedExecutedSize: "0", fillEvidenceStatus: "observed", fillsComplete: false });
    expect(summarizeOrderFills([fill()], 42, "ETH", "0.001")).toMatchObject({ fillsComplete: true });
  });
  it("flags malformed and truncated histories without fabricating evidence", () => {
    const invalid = summarizeOrderFills([fill({ sz: "-1" }), fill({ tid: 2, fee: "NaN" }), fill({ tid: 3 })], 42, "ETH", "0.001");
    expect(invalid).toMatchObject({ observedExecutedSize: "0.001", fillEvidenceStatus: "invalid-rows", fillsComplete: false });
    expect(summarizeOrderFills(Array.from({ length: 2000 }, (_, tid) => fill({ tid })), 42, "ETH", "2")).toMatchObject({ fillEvidenceStatus: "truncated", fillsComplete: false });
    expect(() => summarizeOrderFills({}, 42)).toThrow("unsupported fill history");
  });
});
