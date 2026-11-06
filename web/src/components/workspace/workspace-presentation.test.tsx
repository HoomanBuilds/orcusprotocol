import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetIcon, hasAssetIcon } from "./asset-icon";
import { Empty } from "../trading/primitives";

describe("honest asset presentation", () => {
  it.each(["BTC", "ETH", "WETH/USDC", "USDC", "SOL", "HYPE", "btc"])("uses an existing real mark for %s", symbol => {
    expect(hasAssetIcon(symbol)).toBe(true);
    expect(renderToStaticMarkup(<AssetIcon symbol={symbol}/>)).toContain("/landing/");
  });
  it.each(["APT", "ATOM", "", "NOT-A-TOKEN"])("does not classify a generic fallback as a real %s logo", symbol => {
    expect(hasAssetIcon(symbol)).toBe(false);
    const output = renderToStaticMarkup(<AssetIcon symbol={symbol}/>);
    expect(output).not.toContain("<img");
    expect(output).toContain("logo unavailable");
  });
});

describe("concise empty states", () => {
  it("renders the real message and action without a decorative zero or coin", () => {
    const output = renderToStaticMarkup(<Empty title="Sign in to see your activity" action={<button type="button">Connect wallet</button>}>Your saved instructions and trades appear here.</Empty>);
    expect(output).toContain("Sign in to see your activity");
    expect(output).toContain("Connect wallet");
    expect(output).not.toContain("empty-orbit");
    expect(output).not.toContain("owner-scoped");
  });
});
