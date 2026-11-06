import { z } from "zod";
import { boundedResearchJson, researchSource } from "./research";

const endpoint = "https://api.hyperliquid-testnet.xyz/info";
const decimal = z.string().regex(/^\d{1,30}(?:\.\d{1,30})?$/).refine(value => Number.isFinite(Number(value)));
const positive = decimal.refine(value => Number(value) > 0);
const funding = z.string().regex(/^-?\d{1,30}(?:\.\d{1,30})?$/).refine(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 0.005);
const level = z.object({ px: positive, sz: positive, n: z.number().int().min(1).max(1_000_000_000) });
const symbolSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/);

async function info(body: Record<string, unknown>) {
  try { return await boundedResearchJson(await fetch(endpoint, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(5_000) })); }
  catch { throw new Error("Hyperliquid market context is unavailable. No funding or depth values were inferred."); }
}

export function parseResearchBook(raw: unknown, symbol: string, now = Date.now()) {
  const book = z.object({ coin: z.literal(symbol), time: z.number().int().positive(), levels: z.tuple([z.array(level).max(20), z.array(level).max(20)]) }).parse(raw);
  if (book.time > now + 5_000 || now - book.time > 20_000) throw new Error("Order-book data is stale or future-dated.");
  const [bids, asks] = book.levels;
  if (!bids.length || !asks.length) throw new Error("Both sides of the order book are required for depth research.");
  for (const [index, levels] of book.levels.entries()) {
    if (levels.some((current, i) => i > 0 && (index === 0 ? Number(current.px) >= Number(levels[i - 1].px) : Number(current.px) <= Number(levels[i - 1].px)))) throw new Error("The order book is not ordered correctly.");
  }
  if (Number(bids[0].px) >= Number(asks[0].px)) throw new Error("The order book is crossed.");
  return { observedAt: book.time, bids: bids.slice(0, 5).map(value => ({ price: value.px, size: value.sz, orders: value.n })), asks: asks.slice(0, 5).map(value => ({ price: value.px, size: value.sz, orders: value.n })) };
}

export async function readResearchMarketContext(inputSymbol: string) {
  const symbol = symbolSchema.parse(inputSymbol);
  const [metaResult, bookResult] = await Promise.allSettled([info({ type: "metaAndAssetCtxs" }), info({ type: "l2Book", coin: symbol })]);
  if (metaResult.status !== "fulfilled") throw new Error("Market metadata is unavailable; the research market could not be verified.");
  const [meta, values] = z.tuple([z.object({ universe: z.array(z.object({ name: z.string(), isDelisted: z.boolean().optional() })).max(2000) }), z.array(z.unknown()).max(2000)]).parse(metaResult.value);
  const index = meta.universe.findIndex(asset => asset.name === symbol && !asset.isDelisted);
  if (index < 0) throw new Error("This market is not available on Hyperliquid testnet.");
  const value = z.object({ markPx: positive, oraclePx: positive.optional(), funding: funding.optional(), openInterest: decimal.optional() }).parse(values[index]);
  const retrievedAt = Date.now(), warnings = ["Hyperliquid testnet observations are not mainnet prices or liquidity. Funding is an hourly rate, not an annual yield."];
  let book: ReturnType<typeof parseResearchBook> | undefined;
  if (bookResult.status === "fulfilled") {
    try { book = parseResearchBook(bookResult.value, symbol, retrievedAt); }
    catch { warnings.push("Order-book data is unavailable, invalid or stale. Do not infer depth or execution quality."); }
  } else warnings.push("Order-book data is unavailable. Do not infer depth or execution quality.");
  if (value.funding === undefined) warnings.push("The hourly funding rate is unavailable.");
  if (value.openInterest === undefined) warnings.push("Open interest is unavailable.");
  return { venue: "hyperliquid", network: "testnet", symbol, retrievedAt, asset: { markPrice: value.markPx, oraclePrice: value.oraclePx, fundingRateHourly: value.funding, openInterestBase: value.openInterest, observedAt: retrievedAt, timestampKind: "retrieved" }, book, sources: [researchSource(`Hyperliquid testnet ${symbol} funding and depth`, endpoint, retrievedAt, "testnet")], warnings };
}
