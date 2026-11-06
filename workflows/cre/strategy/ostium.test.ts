import { describe, expect, it, vi } from "vitest";
import { type HTTPSendRequester } from "@chainlink/cre-sdk";

vi.mock("@chainlink/cre-sdk", () => ({
  bytesToBase64: (value: Uint8Array) => Buffer.from(value).toString("base64"),
  ok: (response: { statusCode: number }) => response.statusCode >= 200 && response.statusCode < 300,
  text: (response: { body: Uint8Array }) => new TextDecoder().decode(response.body),
}));

import { readOstiumMarket } from "./ostium";
import { numericPrice } from "./values";

const now = 1_800_000_000_000;
function fixture(changes: { pair?: Record<string, unknown>; tick?: Record<string, unknown>; data?: Record<string, unknown>; duplicate?: boolean } = {}) {
  const pair = { id: "12", from: "NDX", to: "USD", maxLeverage: "10000", overnightMaxLeverage: "2000", fee: { oracleFee: "500000" }, group: { minLeverage: "100", maxLeverage: "10000" }, ...changes.pair };
  const tick = { from: "NDX", to: "USD", pair: "NDX-USD", feed_id: `0x${"a".repeat(64)}`, bid: 22000.1, mid: 22000.2, ask: 22000.3, timestampSeconds: now / 1000, isMarketOpen: true, isDayTradingClosed: false, ...changes.tick };
  const source = { stale: false, prices: changes.duplicate ? [tick, tick] : [tick], ...changes.data };
  return { sendRequest: (request: { method: string }) => ({ result: () => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify(request.method === "POST" ? { data: { pairs: [pair] } } : source)), headers: {}, multiHeaders: {} }) }) } as unknown as HTTPSendRequester;
}

describe("Ostium CRE capability source fixtures", () => {
  it("binds a live pair ID to its canonical SDK name and rejects stale, duplicate or mismatched ticks", () => {
    expect(readOstiumMarket(fixture(), 12, "US100/USD", now, 60)).toMatchObject({ pairId: "12", symbol: "US100/USD", price: 22000200000000000000000n, oracleFee: 500000n });
    for (const changes of [{ pair: { id: "13" } }, { pair: { from: "XAU" } }, { tick: { timestampSeconds: now / 1000 - 21 } }, { tick: { timestampSeconds: now / 1000 + 6 } }, { tick: { pair: "SPX-USD" } }, { tick: { bid: 23000 } }, { data: { stale: true } }, { duplicate: true }]) expect(() => readOstiumMarket(fixture(changes), 12, "US100/USD", now, 60)).toThrow();
    expect(() => readOstiumMarket(fixture(), 65536, "US100/USD", now, 60)).toThrow();
  });
  it("expands numeric feed notation without floating-point threshold arithmetic", () => {
    expect(numericPrice(0.0000001)).toBe(100000000000n);
    expect(numericPrice(1.234567890123e-6)).toBe(1234567890123n);
    for (const value of [NaN, Infinity, 0, -1, "1", 1e-19]) expect(() => numericPrice(value)).toThrow();
  });
});
