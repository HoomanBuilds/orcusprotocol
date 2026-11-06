import { bytesToBase64, ok, text, type HTTPSendRequester } from "@chainlink/cre-sdk";
import { ostiumSymbol } from "../../../agent/src/venues/ostium/symbols";
import { decimalAtoms, numericPrice } from "./values";

export const ostiumPricesUrl = "https://builder.prod.bedrock.ostium.io/v1/prices";
const subgraphUrl = "https://builder.prod.bedrock.ostium.io/v1/subgraph/gn?chainId=421614";
type Pair = { id: string; from: string; to: string; maxLeverage: string; overnightMaxLeverage: string; fee: { oracleFee: string }; group: { maxLeverage: string; minLeverage: string } };

export interface OstiumObservation {
  price: bigint;
  observedAt: number;
  pairId: string;
  symbol: string;
  quoteAsset: string;
  feedId: string;
  marketOpen: boolean;
  dayTradingClosed: boolean;
  maxLeverage: bigint;
  minLeverage: bigint;
  overnightMaxLeverage: bigint;
  oracleFee: bigint;
}

export function readOstiumMarket(requester: HTTPSendRequester, pairId: number, symbol: string, now: number, maxAgeSeconds: number): OstiumObservation {
  if (!Number.isSafeInteger(pairId) || pairId < 0 || pairId > 65535) throw new Error("The native market has no valid pair ID.");
  const query = `query { pairs(where: {id: "${pairId}"}) { id from to maxLeverage overnightMaxLeverage fee { oracleFee } group { minLeverage maxLeverage } } }`;
  const pendingPair = requester.sendRequest({ url: subgraphUrl, method: "POST", headers: { "Content-Type": "application/json" }, body: bytesToBase64(new TextEncoder().encode(JSON.stringify({ query }))) });
  const pendingPrices = requester.sendRequest({ url: ostiumPricesUrl, method: "GET" });
  const pairReply = pendingPair.result(), pricesReply = pendingPrices.result();
  if (!ok(pairReply) || !ok(pricesReply) || pairReply.body.length > 32_000 || pricesReply.body.length > 1_048_576) throw new Error("The native market sources are unavailable.");
  const pairResult = JSON.parse(text(pairReply)) as { errors?: unknown; data?: { pairs?: Pair[] } };
  if (pairResult.errors || !Array.isArray(pairResult.data?.pairs) || pairResult.data.pairs.length !== 1) throw new Error("The native pair ID does not uniquely identify a current market.");
  const pair = pairResult.data.pairs[0];
  if (pair.id !== String(pairId) || typeof pair.from !== "string" || typeof pair.to !== "string" || ostiumSymbol(pair.from, pair.to) !== symbol) throw new Error("The native pair ID and canonical symbol do not match.");
  const data = JSON.parse(text(pricesReply)) as { stale?: boolean; prices?: Array<Record<string, unknown>> };
  if (data.stale !== false || !Array.isArray(data.prices) || data.prices.length > 1_000) throw new Error("The native price feed is stale or malformed.");
  const matches = data.prices.filter(tick => tick.from === pair.from && tick.to === pair.to && tick.pair === `${pair.from}-${pair.to}`);
  if (matches.length !== 1) throw new Error("The native market has no unambiguous price observation.");
  const tick = matches[0], observedAt = Number(tick.timestampSeconds) * 1000;
  if (!Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > Math.min(20, maxAgeSeconds) * 1000 || typeof tick.isMarketOpen !== "boolean" || typeof tick.isDayTradingClosed !== "boolean" || typeof tick.feed_id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tick.feed_id)) throw new Error("The native price observation is invalid or stale.");
  const price = numericPrice(tick.mid), bid = numericPrice(tick.bid), ask = numericPrice(tick.ask);
  if (bid > price || price > ask) throw new Error("The native bid, mid and ask prices are inconsistent.");
  const atoms = (value: unknown) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("The native market returned invalid leverage or fees.");
    return decimalAtoms(value, 0, true);
  };
  const pairMax = atoms(pair.maxLeverage), groupMax = atoms(pair.group?.maxLeverage);
  return { price, observedAt, pairId: pair.id, symbol, quoteAsset: pair.to, feedId: tick.feed_id, marketOpen: tick.isMarketOpen, dayTradingClosed: tick.isDayTradingClosed, maxLeverage: pairMax === 0n ? groupMax : pairMax, minLeverage: atoms(pair.group?.minLeverage), overnightMaxLeverage: atoms(pair.overnightMaxLeverage), oracleFee: atoms(pair.fee?.oracleFee) };
}
