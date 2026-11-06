import type { BookLevel, HyperliquidMarketContext } from "../market-context";

const INFO_URL = "https://api.hyperliquid-testnet.xyz/info";
const BODY_LIMIT = 1_048_576;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const DECIMAL = /^-?\d{1,30}(?:\.\d{1,30})?$/;
type ObjectValue = Record<string, unknown>;

export class MarketContextError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function decimal(value: unknown, allowNegative = false): string | undefined {
  if (typeof value !== "string" || !DECIMAL.test(value)) return;
  const number = Number(value);
  if (!Number.isFinite(number) || (!allowNegative && number < 0)) return;
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > BODY_LIMIT) throw new Error("Invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) throw new Error("Response limit exceeded");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function parseLevels(input: unknown, side: "bid" | "ask"): BookLevel[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error("Invalid levels");
  let previous: number | undefined;
  return input.map(raw => {
    const value = object(raw), price = decimal(value.px), size = decimal(value.sz);
    const orders = value.n;
    if (!price || !size || Number(price) <= 0 || Number(size) <= 0 || !Number.isSafeInteger(orders) || Number(orders) < 1 || Number(orders) > 1_000_000_000) throw new Error("Invalid level");
    const numericPrice = Number(price);
    if (previous !== undefined && (side === "bid" ? numericPrice >= previous : numericPrice <= previous)) throw new Error("Unsorted levels");
    previous = numericPrice;
    return { price, size, orders: Number(orders) };
  });
}

export function parseHyperliquidBook(raw: unknown, symbol: string, now: number): NonNullable<HyperliquidMarketContext["book"]> {
  const value = object(raw);
  if (value.coin !== symbol || !Number.isSafeInteger(value.time) || Number(value.time) <= 0 || Number(value.time) > now + 5_000 || !Array.isArray(value.levels) || value.levels.length !== 2) throw new Error("Invalid book");
  const bids = parseLevels(value.levels[0], "bid"), asks = parseLevels(value.levels[1], "ask");
  if (bids[0] && asks[0] && Number(bids[0].price) >= Number(asks[0].price)) throw new Error("Crossed book");
  return { observedAt: Number(value.time), bids, asks };
}

export function createMarketContextReader(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; value: HyperliquidMarketContext }>();
  const pending = new Map<string, Promise<HyperliquidMarketContext>>();
  let metadata: { expiresAt: number; value: unknown } | undefined;
  let pendingMetadata: Promise<unknown> | undefined;
  let rateWindow = 0, rateCount = 0;

  async function info(body: Record<string, unknown>): Promise<unknown> {
    return boundedJson(await fetcher(INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000) }));
  }

  async function getMetadata(): Promise<{ value: unknown; observedAt: number }> {
    if (metadata && metadata.expiresAt > now()) return { value: metadata.value, observedAt: metadata.expiresAt - 10_000 };
    if (!pendingMetadata) pendingMetadata = info({ type: "metaAndAssetCtxs" }).then(value => {
      if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(object(value[0]).universe) || !Array.isArray(value[1]) || (object(value[0]).universe as unknown[]).length > 2_000) throw new Error("Invalid metadata");
      metadata = { value, expiresAt: now() + 10_000 };
      return value;
    }).finally(() => { pendingMetadata = undefined; });
    const value = await pendingMetadata;
    return { value, observedAt: metadata!.expiresAt - 10_000 };
  }

  async function load(symbol: string): Promise<HyperliquidMarketContext> {
    let snapshot: Awaited<ReturnType<typeof getMetadata>>;
    try { snapshot = await getMetadata(); }
    catch { throw new MarketContextError("MARKET_DATA_UNAVAILABLE", "Market data is unavailable. Refresh in a moment.", 503); }
    const [meta, contexts] = snapshot.value as [ObjectValue, unknown[]];
    const assets = meta.universe as unknown[];
    const index = assets.findIndex(raw => object(raw).name === symbol);
    if (index < 0 || object(assets[index]).isDelisted === true) throw new MarketContextError("UNSUPPORTED_MARKET", "Choose an available Hyperliquid testnet perpetual market.", 404);
    const delisted = object(assets[index]).isDelisted;
    if (delisted !== undefined && typeof delisted !== "boolean") throw new MarketContextError("MARKET_DATA_UNAVAILABLE", "Market data could not be verified. Refresh in a moment.", 503);
    const raw = object(contexts[index]);
    const mark = decimal(raw.markPx), oracle = decimal(raw.oraclePx), funding = decimal(raw.funding, true);
    const markPrice = mark && Number(mark) > 0 ? mark : undefined;
    const oraclePrice = oracle && Number(oracle) > 0 ? oracle : undefined;
    const fundingRateHourly = funding && Math.abs(Number(funding)) <= 0.005 ? funding : undefined;
    const openInterestBase = decimal(raw.openInterest);
    const value: HyperliquidMarketContext = { venue: "hyperliquid", network: "testnet", symbol, retrievedAt: now(), warnings: [] };
    if (markPrice || oraclePrice || fundingRateHourly || openInterestBase) value.asset = { observedAt: snapshot.observedAt, markPrice, oraclePrice, fundingRateHourly, openInterestBase };
    else value.warnings.push("Funding and open interest are unavailable.");
    try { value.book = parseHyperliquidBook(await info({ type: "l2Book", coin: symbol }), symbol, now()); }
    catch { value.warnings.push("Order book unavailable. Refresh in a moment."); }
    value.retrievedAt = now();
    return value;
  }

  return async function readMarketContext(symbol: string): Promise<HyperliquidMarketContext> {
    if (!SYMBOL.test(symbol)) throw new MarketContextError("INVALID_MARKET", "Choose a supported market symbol.", 400);
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > now()) return cached.value;
    const inFlight = pending.get(symbol);
    if (inFlight) return inFlight;
    if (now() - rateWindow >= 10_000) { rateWindow = now(); rateCount = 0; }
    if (pending.size >= 8 || rateCount >= 24) throw new MarketContextError("MARKET_DATA_BUSY", "Market data is busy. Wait a moment before refreshing.", 429);
    rateCount++;
    const request = load(symbol).then(value => {
      if (cache.size >= 16 && !cache.has(symbol)) cache.delete(cache.keys().next().value!);
      cache.set(symbol, { value, expiresAt: now() + 3_000 });
      return value;
    }).finally(() => { pending.delete(symbol); });
    pending.set(symbol, request);
    return request;
  };
}
