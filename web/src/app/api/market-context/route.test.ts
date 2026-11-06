import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/server/market-context", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/server/market-context")>();
  return { ...actual, createMarketContextReader: () => read };
});
import { GET } from "./route";
import { MarketContextError } from "../../../lib/server/market-context";

beforeEach(() => read.mockReset());

describe("public market-context route", () => {
  it.each(["", "?venue=uniswap&symbol=WETH", "?venue=hyperliquid&symbol=BTC&url=https://example.com", "?venue=hyperliquid&symbol=BTC&symbol=ETH"])("rejects unsupported or ambiguous query %s without network access", async query => {
    expect((await GET(new Request(`http://localhost/api/market-context${query}`))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns bounded public data without storing or authorizing an action", async () => {
    read.mockResolvedValue({ symbol: "BTC", network: "testnet" });
    const response = await GET(new Request("http://localhost/api/market-context?venue=hyperliquid&symbol=BTC"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { symbol: "BTC", network: "testnet" } });
    expect(read).toHaveBeenCalledWith("BTC");
  });

  it("returns bounded throttling and sanitized unknown errors", async () => {
    read.mockRejectedValueOnce(new MarketContextError("MARKET_DATA_BUSY", "Wait a moment.", 429)).mockRejectedValueOnce(new Error("secret provider details"));
    const request = () => new Request("http://localhost/api/market-context?venue=hyperliquid&symbol=BTC");
    expect((await GET(request())).status).toBe(429);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
