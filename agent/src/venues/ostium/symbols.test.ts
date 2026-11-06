import { describe, expect, it } from "vitest";
import { ostiumSymbol } from "./symbols";

describe("Ostium SDK canonical pair names", () => {
  it("matches raw price-feed names with normalized SDK pairs without substring replacement", () => {
    const aliases = { CL: "WTI", HG: "XCU", SPX: "US500", NDX: "US100", DJI: "US30", DAX: "GER40", FTSE: "UK100", HSI: "HK50", NIK: "JP225" };
    for (const [raw, canonical] of Object.entries(aliases)) {
      expect(ostiumSymbol(raw, "USD")).toBe(ostiumSymbol(canonical, "USD"));
      expect(ostiumSymbol("USD", raw)).toBe(ostiumSymbol("USD", canonical));
    }
    expect(ostiumSymbol("USD", "JPY")).toBe("USD/JPY");
    expect(ostiumSymbol("CLX", "USD")).toBe("CLX/USD");
    expect(ostiumSymbol("US100", "USD")).toBe("US100/USD");
  });
});
