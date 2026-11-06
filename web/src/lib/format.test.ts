import { describe, expect, it } from "vitest";
import { tokenUnits, usd } from "./format";

describe("native expense formatting", () => {
  it("uses explicit token decimals, units and readable precision", () => {
    expect(tokenUnits("1000000", 6, "USDC")).toBe("1 USDC");
    expect(tokenUnits("0", 18, "0G")).toBe("0 0G");
    expect(tokenUnits("1", 18, "0G")).toBe("<0.0001 0G");
    expect(tokenUnits("1234567890000000000000", 18, "0G")).toBe("1,234.57 0G");
    expect(usd("0.000205")).toBe("<$0.01");
  });
  it.each([undefined, "", "NaN", "1e18", "-1"])("does not fabricate unknown costs", value => {
    expect(tokenUnits(value, 18, "0G")).toBe("Unavailable");
  });
});
