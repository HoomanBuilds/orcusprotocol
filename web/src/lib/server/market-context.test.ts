import { describe, expect, it, vi } from "vitest";
import { createMarketContextReader, parseHyperliquidBook } from "./market-context";

const now = 1_000_000;
const metadata = [{ universe: [{ name: "BTC" }, { name: "ETH" }, { name: "OLD", isDelisted: true }] }, [
  { markPx: "65000", oraclePx: "64990", funding: "0.0000125", openInterest: "125.5" },
  { markPx: "3000", funding: "-0.00002", openInterest: "0" },
  {},
]];
const book = (coin = "BTC") => ({ coin, time: now, levels: [[{ px: "64999", sz: "0.125", n: 2 }, { px: "64998", sz: "0.5", n: 1 }], [{ px: "65001", sz: "1", n: 3 }]] });

function source(meta: unknown = metadata, depth: unknown = book()) {
  return vi.fn<typeof fetch>(async (_url, init) => Response.json(JSON.parse(String(init?.body)).type === "metaAndAssetCtxs" ? meta : depth));
}

describe("bounded read-only market context", () => {
  it("reads real shapes from a fixed testnet host and coalesces simultaneous/cache requests", async () => {
    const fetcher = source(), read = createMarketContextReader({ fetcher, now: () => now });
    const [first, duplicate] = await Promise.all([read("BTC"), read("BTC")]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ venue: "hyperliquid", network: "testnet", symbol: "BTC", asset: { fundingRateHourly: "0.0000125", openInterestBase: "125.5" }, book: { observedAt: now, bids: [{ price: "64999", size: "0.125", orders: 2 }, { price: "64998", size: "0.5", orders: 1 }] } });
    expect(await read("BTC")).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://api.hyperliquid-testnet.xyz/info");
      expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    }
  });

  it("retains the actual book time instead of replacing stale evidence with fetch time", async () => {
    const read = createMarketContextReader({ fetcher: source(metadata, { ...book(), time: now - 60_000 }), now: () => now });
    expect((await read("BTC")).book?.observedAt).toBe(now - 60_000);
  });

  it("refreshes the book without falsely refreshing cached context observations", async () => {
    let clock = now;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => Response.json(JSON.parse(String(init?.body)).type === "metaAndAssetCtxs" ? metadata : { ...book(), time: clock }));
    const read = createMarketContextReader({ fetcher, now: () => clock });
    await read("BTC");
    clock += 4_000;
    const second = await read("BTC");
    expect(second.asset?.observedAt).toBe(now);
    expect(second.book?.observedAt).toBe(clock);
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock += 7_000;
    expect((await read("BTC")).asset?.observedAt).toBe(clock);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each(["", "BTC/USDC", "https://example.com", "x".repeat(31), " BTC"])("rejects malformed symbol %s before network access", async symbol => {
    const fetcher = source(), read = createMarketContextReader({ fetcher });
    await expect(read(symbol)).rejects.toMatchObject({ code: "INVALID_MARKET", status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["NEW", "OLD"])("rejects unknown or delisted market %s without requesting a book", async symbol => {
    const fetcher = source(), read = createMarketContextReader({ fetcher });
    await expect(read(symbol)).rejects.toMatchObject({ code: "UNSUPPORTED_MARKET", status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps zero open interest and negative funding as observed values", async () => {
    const read = createMarketContextReader({ fetcher: source(metadata, book("ETH")), now: () => now });
    expect((await read("ETH")).asset).toMatchObject({ fundingRateHourly: "-0.00002", openInterestBase: "0" });
  });

  it("returns unavailable fields rather than manufacturing missing funding", async () => {
    const read = createMarketContextReader({ fetcher: source([{ universe: [{ name: "BTC" }] }, [{}]]), now: () => now });
    const result = await read("BTC");
    expect(result.asset).toBeUndefined();
    expect(result.warnings).toContain("Funding and open interest are unavailable.");
    expect(result.book).toBeDefined();
  });

  it("rejects malformed listing flags and excludes impossible prices or funding", async () => {
    const badListing = createMarketContextReader({ fetcher: source([{ universe: [{ name: "BTC", isDelisted: "false" }] }, [{}]]), now: () => now });
    await expect(badListing("BTC")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    const read = createMarketContextReader({ fetcher: source([{ universe: [{ name: "BTC" }] }, [{ markPx: "0", oraclePx: "-1", funding: "0.5", openInterest: "0" }]]), now: () => now });
    expect((await read("BTC")).asset).toMatchObject({ markPrice: undefined, oraclePrice: undefined, fundingRateHourly: undefined, openInterestBase: "0" });
  });

  it("preserves available funding when the book fails and does not expose upstream errors", async () => {
    const fetcher = source();
    fetcher.mockImplementation(async (_url, init) => {
      if (JSON.parse(String(init?.body)).type === "l2Book") throw new Error("provider secret detail");
      return Response.json(metadata);
    });
    const value = await createMarketContextReader({ fetcher, now: () => now })("BTC");
    expect(value.asset?.markPrice).toBe("65000");
    expect(value.book).toBeUndefined();
    expect(value.warnings).toEqual(["Order book unavailable. Refresh in a moment."]);
    expect(JSON.stringify(value)).not.toContain("secret");
  });

  it("fails closed on oversized or malformed metadata", async () => {
    for (const body of ["{", " ".repeat(1_048_577), "[]"]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
      await expect(createMarketContextReader({ fetcher })("BTC")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    }
  });

  it("limits concurrent distinct requests while sharing one metadata fetch", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => gate);
    const read = createMarketContextReader({ fetcher, now: () => now });
    const requests = Array.from({ length: 8 }, (_, index) => read(`COIN${index}`).catch(error => error));
    await expect(read("COIN8")).rejects.toMatchObject({ code: "MARKET_DATA_BUSY", status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(Response.json(metadata));
    await Promise.all(requests);
  });

  it("rate limits repeated distinct misses without growing the cache", async () => {
    const read = createMarketContextReader({ fetcher: source(), now: () => now });
    for (let index = 0; index < 24; index++) await expect(read(`MISS${index}`)).rejects.toMatchObject({ status: 404 });
    await expect(read("MISS24")).rejects.toMatchObject({ status: 429 });
  });
});

describe("order book input validation", () => {
  it("permits genuine empty and one-sided snapshots", () => {
    expect(parseHyperliquidBook({ ...book(), levels: [[], []] }, "BTC", now)).toMatchObject({ bids: [], asks: [] });
    expect(parseHyperliquidBook({ ...book(), levels: [book().levels[0], []] }, "BTC", now).bids).toHaveLength(2);
  });

  it.each([
    { ...book(), coin: "ETH" },
    { ...book(), time: now + 6_000 },
    { ...book(), levels: [[{ px: "NaN", sz: "1", n: 1 }], []] },
    { ...book(), levels: [[{ px: "1", sz: "-1", n: 1 }], []] },
    { ...book(), levels: [[{ px: "1", sz: "1", n: 0 }], []] },
    { ...book(), levels: [[{ px: "2", sz: "1", n: 1 }], [{ px: "1", sz: "1", n: 1 }]] },
    { ...book(), levels: [[{ px: "1", sz: "1", n: 1 }, { px: "2", sz: "1", n: 1 }], []] },
    { ...book(), levels: [Array.from({ length: 21 }, () => ({ px: "1", sz: "1", n: 1 })), []] },
  ])("rejects mismatched, crossed, malformed or oversized snapshots", value => {
    expect(() => parseHyperliquidBook(value, "BTC", now)).toThrow();
  });
});
