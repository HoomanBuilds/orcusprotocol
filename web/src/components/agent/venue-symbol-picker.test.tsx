import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Market } from "@orcus/core";
import { VenueSymbolPicker, filterVenueSymbols, selectedVenueSymbols, toggleVenueSymbol } from "./venue-symbol-picker";

const markets = [
  { venue: "ostium", symbol: "ETH/USD", baseAsset: "ETH", quoteAsset: "USD", tradable: true },
  { venue: "ostium", symbol: "XAU/USD", baseAsset: "XAU", quoteAsset: "USD", marketOpen: false },
  { venue: "uniswap", symbol: "WETH/USDC", baseAsset: "WETH", quoteAsset: "USDC" },
] as Market[];

describe("venue asset selection", () => {
  it("filters the requested venue and searches exact symbols case-insensitively", () => {
    expect(filterVenueSymbols(markets, "ostium", " eth ").map(item => item.symbol)).toEqual(["ETH/USD"]);
    expect(filterVenueSymbols(markets, "uniswap", "eth").map(item => item.symbol)).toEqual(["WETH/USDC"]);
    expect(filterVenueSymbols(markets, "ostium", "missing")).toEqual([]);
  });
  it("keeps closed markets available for permission selection and removes duplicate rows", () => {
    expect(filterVenueSymbols([...markets, markets[1]!], "ostium", "").map(item => item.symbol)).toEqual(["ETH/USD", "XAU/USD"]);
  });
  it("preserves unknown existing selections until explicitly removed", () => {
    expect(selectedVenueSymbols(" LEGACY/USD, ETH/USD, ETH/USD ")).toEqual(["LEGACY/USD", "ETH/USD"]);
    expect(toggleVenueSymbol("LEGACY/USD, ETH/USD", "ETH/USD")).toBe("LEGACY/USD");
    expect(toggleVenueSymbol("LEGACY/USD", "BTC/USD")).toBe("LEGACY/USD, BTC/USD");
    expect(toggleVenueSymbol("LEGACY/USD", "LEGACY/USD")).toBe("");
  });
  it("allows thirty assets, blocks a thirty-first, and still permits removal", () => {
    const full = Array.from({ length: 30 }, (_, i) => `ASSET${i}/USD`).join(", ");
    expect(toggleVenueSymbol(full, "ETH/USD")).toBe(full);
    expect(selectedVenueSymbols(toggleVenueSymbol(full, "ASSET0/USD"))).toHaveLength(29);
    expect(selectedVenueSymbols(toggleVenueSymbol(toggleVenueSymbol(full, "ASSET0/USD"), "ETH/USD"))).toHaveLength(30);
  });
  it("renders a collapsed selector and removable chips rather than raw symbol entry", () => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(<VenueSymbolPicker venue="ostium" value="ETH/USD, LEGACY/USD" onChange={onChange}/>);
    expect(markup).toContain("Allowed assets");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Remove LEGACY/USD");
    expect(markup).not.toContain("<input");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("disables selection and removal while a permission request is pending", () => {
    const markup = renderToStaticMarkup(<VenueSymbolPicker venue="ostium" value="ETH/USD" onChange={vi.fn()} disabled/>);
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
