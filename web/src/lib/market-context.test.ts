import { describe, expect, it } from "vitest";
import { cumulativeLevels, hourlyFundingLabel, marketContextIsStale, marketQuantity } from "./market-context";

describe("market-context display boundaries", () => {
  it("formats funding as hourly percent without annualizing or hiding direction", () => {
    expect(hourlyFundingLabel("0.0000125")).toBe("+0.00125%");
    expect(hourlyFundingLabel("-0.0000125")).toBe("-0.00125%");
    expect(hourlyFundingLabel("0")).toBe("0.0000%");
    expect(hourlyFundingLabel(undefined)).toBe("Unavailable");
    expect(hourlyFundingLabel("1e-99")).toBe("<0.000001%");
    expect(hourlyFundingLabel("NaN")).toBe("Unavailable");
  });

  it("does not present tiny quantities as zero or absent balances as zero", () => {
    expect(marketQuantity("0.000000001")).toBe("<0.000001");
    expect(marketQuantity("0")).toBe("0");
    expect(marketQuantity(undefined)).toBe("Unavailable");
    expect(marketQuantity("65000.125")).toBe("65,000.125");
  });

  it("marks missing, future and aged observations stale at an explicit boundary", () => {
    const now = 1_000_000;
    expect(marketContextIsStale(now - 20_000, now)).toBe(false);
    expect(marketContextIsStale(now - 20_001, now)).toBe(true);
    expect(marketContextIsStale(now + 5_001, now)).toBe(true);
    expect(marketContextIsStale(undefined, now)).toBe(true);
  });

  it("keeps cumulative displayed size separate from each actual level", () => {
    expect(cumulativeLevels([{ price: "100", size: "0.25", orders: 1 }, { price: "99", size: "0.5", orders: 2 }])).toEqual([
      { price: "100", size: "0.25", orders: 1, cumulative: 0.25 },
      { price: "99", size: "0.5", orders: 2, cumulative: 0.75 },
    ]);
  });
});
