import { describe, expect, it } from "vitest";
import { positiveDecimalSchema, tradeRequestSchema } from "./index";

describe("action boundary", () => {
  const action = { accountId: "account", venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01" };
  it("accepts an exact positive decimal and applies bounded defaults", () => {
    expect(tradeRequestSchema.parse(action)).toMatchObject({ amount: "0.01", slippageBps: 50, mode: "manual", reduceOnly: false });
  });
  it.each(["0", "-1", "NaN", "Infinity", "1e20", "", "01.0"])("rejects unsafe amount %s", amount => {
    expect(positiveDecimalSchema.safeParse(amount).success).toBe(false);
  });
  it("rejects unbounded slippage and unexpected execution fields", () => {
    expect(tradeRequestSchema.safeParse({ ...action, slippageBps: 501 }).success).toBe(false);
    expect(tradeRequestSchema.safeParse({ ...action, privateKey: "not-allowed" }).success).toBe(false);
  });
  it("keeps native ETH input explicit and never silently treats WETH output as ETH",()=>{
    const native={...action,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side:"sell",nativeInput:true};
    expect(tradeRequestSchema.parse(native).nativeInput).toBe(true);
    for(const invalid of [{...native,venue:"hyperliquid"},{...native,type:"market"},{...native,side:"buy"},{...native,symbol:"USDC/WETH"}])expect(tradeRequestSchema.safeParse(invalid).success).toBe(false);
    expect(tradeRequestSchema.parse(action).nativeInput).toBeUndefined();
  });
});
