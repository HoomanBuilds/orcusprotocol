import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeCandles, boundedResearchJson, publicSourceUrl, researchSource, searchResearch } from "./research";
import { parseResearchBook, readResearchMarketContext } from "./market-context";
import { compactToolObservation, groundFinalAnswer } from "./grounding";

const now = 1_783_000_800_000;
const candles = () => Array.from({ length: 21 }, (_, i) => ({ time: now / 1000 - (21 - i) * 3600, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("bounded source-grounded market research", () => {
  it("sorts and deduplicates identical closed candles before computing indicators", () => {
    const data = candles();
    const result = analyzeCandles([...data.reverse(), data[0]], "1h", now);
    expect(result).toMatchObject({ candleCount: 21, lastClose: 121, rsi14: 100, closedCandlesOnly: true });
    expect(result.sma20).toBe(111.5);
  });
  it("excludes the incomplete latest candle while keeping enough closed history", () => {
    const data = candles();
    expect(analyzeCandles([...data, { ...data[0], time: now / 1000 - 100 }], "1h", now).candleCount).toBe(21);
  });
  it.each([
    { label: "empty", change: () => [] },
    { label: "insufficient", change: () => candles().slice(0, 19) },
    { label: "stale", change: () => candles().map(c => ({ ...c, time: c.time - 7201 })) },
    { label: "future", change: () => [...candles(), { ...candles()[0], time: now / 1000 + 60 }] },
    { label: "gap", change: () => candles().filter((_, i) => i !== 3) },
    { label: "zero price", change: () => candles().map((c, i) => i === 0 ? { ...c, close: 0 } : c) },
    { label: "incoherent high", change: () => candles().map((c, i) => i === 0 ? { ...c, high: 1 } : c) },
    { label: "negative volume", change: () => candles().map((c, i) => i === 0 ? { ...c, volume: -1 } : c) },
    { label: "NaN", change: () => candles().map((c, i) => i === 0 ? { ...c, open: NaN } : c) },
    { label: "duplicate conflict", change: () => [...candles(), { ...candles()[0], close: 100 }] },
  ])("rejects $label observations instead of manufacturing successful indicators", ({ change }) => {
    expect(() => analyzeCandles(change(), "1h", now)).toThrow();
  });
  it.each(["http://example.com", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/", "https://example.com/?api_key=hidden", "https://example.com/#secret", "https://user:pass@example.com", "https://example.internal", "javascript:alert(1)"])("rejects unsafe public source URLs: %s", url => {
    expect(publicSourceUrl(url)).toBeUndefined();
  });
  it("does not call any service when search is unconfigured", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", ""); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(searchResearch({ query: "Ethereum news", topic: "news", freshness: "pw" })).rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("only sends bounded public queries to the official search endpoint and does not follow result URLs", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fixture-search-key");
    const fetcher = vi.fn(async () => Response.json({ results: [{ title: "Ethereum upgrade", url: "https://ethereum.org/roadmap/", description: "A public roadmap excerpt", page_age: "2025-01-01T00:00:00Z" }, { title: "unsafe", url: "http://127.0.0.1/secret", description: "not read" }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await searchResearch({ query: "Ethereum roadmap", topic: "news", freshness: "pw" });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].publishedAt).toBe("2025-01-01T00:00:00Z");
    expect(fetcher).toHaveBeenCalledOnce();
    const args = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(args[0].origin).toBe("https://api.search.brave.com");
    expect(args[1].redirect).toBe("error");
  });
  it("rejects credentials and wallet identities before search", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const query of ["wallet 0x" + "1".repeat(40), "api_key: sk-exampleexampleexample"]) await expect(searchResearch({ query, topic: "web", freshness: "pw" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds upstream response bodies even without content-length", async () => {
    await expect(boundedResearchJson(new Response("x".repeat(100)), 50)).rejects.toThrow("limit");
  });
  it("does not claim success when search yields no usable results", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fixture-search-key"); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ web: { results: [] } })));
    await expect(searchResearch({ query: "Ethereum news", topic: "web", freshness: "pd" })).rejects.toThrow("No usable sources");
  });
  it("preserves structured provenance when an observation is compacted", () => {
    const source = researchSource("Ethereum roadmap", "https://ethereum.org/roadmap/", now);
    expect(compactToolObservation({ big: Array(20).fill("x".repeat(500)), sources: [source] })).toMatchObject({ truncated: true, sources: [source] });
  });
  it("refuses fabricated research finals and fabricated citations", () => {
    const answer = { message: "ETH is currently 9000", basis: "observed" as const, requiresClarification: false };
    expect(groundFinalAnswer(answer, [], false)).toMatchObject({ requiresClarification: true, clearProposal: true });
    expect(groundFinalAnswer({ ...answer, message: "See https://fake-source.example.com/report" }, [], false).answer).toContain("could not verify");
  });
  it("keeps greetings and educational answers separate from live evidence", () => {
    expect(groundFinalAnswer({ message: "Hello. How can I help?", basis: "general", requiresClarification: false }, [], false)).toMatchObject({ requiresClarification: false, clearProposal: false });
  });
  it("retains a typed draft without repeating unsupported market rationale", () => {
    const result = groundFinalAnswer({ message: "Buy ETH because it is currently 9000.", basis: "general", requiresClarification: false }, [], true, "Buy ETH");
    expect(result).toMatchObject({ requiresClarification: false, clearProposal: false });
    expect(result.answer).not.toContain("9000");
    expect(result.answer).toContain("draft for your review");
  });
  it("does not let a model relabel requested current facts as a general explanation", () => {
    const answer = { message: "ETH is 9000.", basis: "general" as const, requiresClarification: false };
    expect(groundFinalAnswer(answer, [], false, "What is the current ETH price?").requiresClarification).toBe(true);
    expect(groundFinalAnswer(answer, [{ name: "read_markets", ok: false, observedAt: now, arguments: {}, result: { error: "unavailable" } }], false, "Research ETH").requiresClarification).toBe(true);
    expect(groundFinalAnswer(answer, [{ name: "search_memory", ok: true, observedAt: now, arguments: {}, result: [] }], false, "What is my balance now?").requiresClarification).toBe(true);
  });
  it("adds only evidence-backed source links and ignores failed-tool sources", () => {
    const source = researchSource("Ethereum roadmap", "https://ethereum.org/roadmap/", now);
    const trace = { name: "search_research", ok: true, observedAt: now, arguments: {}, result: { sources: [source] } };
    const answer = { message: "The retrieved roadmap discusses upgrades.", basis: "observed" as const, requiresClarification: false, sourceIds: [source.id] };
    expect(groundFinalAnswer(answer, [trace], false).answer).toContain("https://ethereum.org/roadmap/");
    expect(groundFinalAnswer(answer, [{ ...trace, ok: false }], false).requiresClarification).toBe(true);
  });
});

describe("funding and order-book research", () => {
  const book = () => ({ coin: "ETH", time: Date.now(), levels: [[{ px: "2000", sz: "2", n: 2 }], [{ px: "2001", sz: "3", n: 1 }]] });
  it("rejects stale or crossed books", () => {
    expect(() => parseResearchBook({ ...book(), time: Date.now() - 21_000 }, "ETH")).toThrow("stale");
    expect(() => parseResearchBook({ ...book(), levels: [[{ px: "2002", sz: "2", n: 1 }], [{ px: "2001", sz: "1", n: 1 }]] }, "ETH")).toThrow("crossed");
  });
  it("reads actual response fields with explicit hourly funding and testnet provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => JSON.parse(String(init?.body)).type === "l2Book" ? Response.json(book()) : Response.json([{ universe: [{ name: "ETH" }] }, [{ markPx: "2000", oraclePx: "2000", funding: "0.0001", openInterest: "12" }]])));
    const result = await readResearchMarketContext("ETH");
    expect(result.asset).toMatchObject({ fundingRateHourly: "0.0001", openInterestBase: "12" });
    expect(result.book?.bids[0]).toMatchObject({ price: "2000", size: "2" });
    expect(result.sources[0].network).toBe("testnet");
  });
  it("labels partial order-book failures without inventing depth", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => JSON.parse(String(init?.body)).type === "l2Book" ? Response.json(book(), { status: 503 }) : Response.json([{ universe: [{ name: "ETH" }] }, [{ markPx: "2000", funding: "0" }]])));
    const result = await readResearchMarketContext("ETH");
    expect(result.book).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("unavailable");
  });
});
