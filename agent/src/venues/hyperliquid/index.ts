import { randomUUID } from "node:crypto";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { getAddress, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tradeRequestSchema, type Market, type MarketCandle, type PreparedAction, type TradingAccount, type TradeRequest } from "@orcus/core";
import { EngineError, requestJson } from "../../errors";
import type { AccountPortfolio, SubmissionResult } from "../../types";
import { decimalToAtoms, formatPrice, formatSize } from "./wire-format";

const API = "https://api.hyperliquid-testnet.xyz";
interface Asset { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }
interface AssetContext { markPx: string; midPx: string | null; prevDayPx: string; dayNtlVlm: string }
type Meta = [{ universe: Asset[] }, AssetContext[]];
interface Clearinghouse {
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
  withdrawable: string;
  assetPositions: Array<{ position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string; liquidationPx: string | null; marginUsed: string; leverage: { value: number } } }>;
}
interface VenueOrder { coin: string; oid: number; side: "A" | "B"; sz: string; limitPx: string; timestamp: number; reduceOnly?: boolean; orderType?: string }

let metaCache: { expires: number; value: Meta } | undefined;
export async function hyperliquidInfo<T>(body: Record<string, unknown>): Promise<T> {
  return requestJson<T>(`${API}/info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function metadata(): Promise<Meta> {
  if (metaCache && metaCache.expires > Date.now()) return metaCache.value;
  const value = await hyperliquidInfo<Meta>({ type: "metaAndAssetCtxs" });
  if (!Array.isArray(value) || !Array.isArray(value[0]?.universe) || !Array.isArray(value[1])) throw new EngineError("INVALID_UPSTREAM", "The venue returned an invalid market response.", 502);
  metaCache = { expires: Date.now() + 5_000, value };
  return value;
}

function coinName(symbol: string): string { return symbol.replace(/(?:[-/]?(?:USD|USDC))$/i, ""); }

function assertAccount(account: TradingAccount) {
  if (account.venue !== "hyperliquid" || account.chainId !== 421614) throw new EngineError("WRONG_NETWORK", "Hyperliquid actions are limited to the testnet trading environment.");
  getAddress(account.address);
}

export async function getHyperliquidMarkets(): Promise<Market[]> {
  const [meta, contexts] = await metadata();
  return meta.universe.flatMap((asset, index) => {
    const ctx = contexts[index];
    if (asset.isDelisted || !ctx?.markPx) return [];
    const price = ctx.midPx ?? ctx.markPx;
    const previous = Number(ctx.prevDayPx);
    return [{ venue: "hyperliquid" as const, symbol: asset.name, baseAsset: asset.name, quoteAsset: "USDC", midPrice: price, change24h: previous ? ((Number(price) / previous) - 1) * 100 : undefined, volume24h: ctx.dayNtlVlm, sizeDecimals: asset.szDecimals, maxLeverage: asset.maxLeverage, observedAt: Date.now() }];
  });
}

export async function getHyperliquidCandles(input: { symbol: string; interval?: string; limit?: number }): Promise<MarketCandle[]> {
  const allowed: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
  const interval = input.interval ?? "15m";
  if (!allowed[interval]) throw new EngineError("INVALID_INTERVAL", "Unsupported chart interval.");
  const endTime = Date.now();
  const candles = await hyperliquidInfo<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>>({ type: "candleSnapshot", req: { coin: coinName(input.symbol), interval, startTime: endTime - allowed[interval] * Math.min(input.limit ?? 160, 500), endTime } });
  if (!Array.isArray(candles)) throw new EngineError("INVALID_UPSTREAM", "The venue returned invalid candle data.", 502);
  return candles.map(c => ({ time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) })).filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));
}

export async function getHyperliquidBook(symbol: string) {
  return hyperliquidInfo<{ levels: Array<Array<{ px: string; sz: string; n: number }>>; time: number }>({ type: "l2Book", coin: coinName(symbol) });
}

export async function getHyperliquidPortfolio(account: TradingAccount): Promise<AccountPortfolio> {
  assertAccount(account);
  const [state, orders, markets] = await Promise.all([
    hyperliquidInfo<Clearinghouse>({ type: "clearinghouseState", user: account.address }),
    hyperliquidInfo<VenueOrder[]>({ type: "frontendOpenOrders", user: account.address }),
    getHyperliquidMarkets(),
  ]);
  if (!state.marginSummary || !Array.isArray(state.assetPositions) || !Array.isArray(orders)) throw new EngineError("INVALID_UPSTREAM", "The venue returned invalid account state.", 502);
  return {
    accountId: account.id,
    balances: [{ accountId: account.id, symbol: "USDC", amount: state.marginSummary.accountValue, usdValue: state.marginSummary.accountValue, decimals: 6 }],
    positions: state.assetPositions.filter(p => p.position.szi !== "0").map(({ position: p }) => ({ id: `${account.id}:${p.coin}`, accountId: account.id, venue: "hyperliquid" as const, symbol: p.coin, side: p.szi.startsWith("-") ? "short" as const : "long" as const, size: p.szi.replace(/^-/, ""), entryPrice: p.entryPx ?? "0", markPrice: markets.find(m => m.symbol === p.coin)?.midPrice, unrealizedPnl: p.unrealizedPnl, liquidationPrice: p.liquidationPx ?? undefined, leverage: p.leverage?.value, observedAt: Date.now() })),
    orders: orders.map(o => ({ id: String(o.oid), accountId: account.id, venue: "hyperliquid" as const, symbol: o.coin, side: o.side === "B" ? "buy" as const : "sell" as const, type: o.orderType ?? "limit", size: o.sz, price: o.limitPx, reduceOnly: o.reduceOnly ?? false, createdAt: o.timestamp })),
    equityUsd: state.marginSummary.accountValue,
    freeCollateralUsd: state.withdrawable,
    observedAt: Date.now(),
  };
}

export async function prepareHyperliquidAction(input: TradeRequest, account: TradingAccount): Promise<PreparedAction> {
  const action = tradeRequestSchema.parse(input);
  assertAccount(account);
  if (action.accountId !== account.id) throw new EngineError("ACCOUNT_MISMATCH", "The action does not belong to this trading account.");
  const [meta, contexts] = await metadata();
  const symbol = coinName(action.symbol);
  const assetIndex = meta.universe.findIndex(a => a.name === symbol && !a.isDelisted);
  if (assetIndex < 0) throw new EngineError("UNKNOWN_MARKET", "This market is not available on Hyperliquid testnet.");
  const asset = meta.universe[assetIndex];
  const ctx = contexts[assetIndex];
  const base = { id: randomUUID(), request: { ...action, symbol }, account, kind: "hyperliquid" as const, expiresAt: Date.now() + 60_000, controlRevision: account.controlRevision, warnings: ["Agent limits are enforced by this application, not by native Hyperliquid agent authorization."] };
  if (action.type === "cancel") {
    if (!action.orderId || !/^\d+$/.test(action.orderId) || !Number.isSafeInteger(Number(action.orderId))) throw new EngineError("INVALID_ORDER", "A valid order ID is required.");
    const portfolio = await getHyperliquidPortfolio(account);
    if (!portfolio.orders.some(order => order.id === action.orderId && order.symbol === symbol)) throw new EngineError("ORDER_NOT_OPEN", "The order is not open in this trading account.");
    return { ...base, hyperliquid: { method: "cancel", params: { cancels: [{ a: assetIndex, o: Number(action.orderId) }] } } };
  }
  if (action.type === "swap") throw new EngineError("UNSUPPORTED_ACTION", "Use Uniswap for spot swaps in this build.");
  let amount = action.amount;
  let side = action.side;
  let reduceOnly = action.reduceOnly;
  if (["close", "reduce", "stop-loss", "take-profit"].includes(action.type)) {
    const portfolio = await getHyperliquidPortfolio(account);
    const position = portfolio.positions.find(p => p.symbol === symbol);
    if (!position) throw new EngineError("POSITION_NOT_FOUND", "No open position exists for this market in the selected account.");
    side = position.side === "long" ? "sell" : "buy";
    amount = action.type === "close" ? position.size : action.amount;
    if (decimalToAtoms(amount, asset.szDecimals) > decimalToAtoms(position.size, asset.szDecimals)) throw new EngineError("EXCESS_REDUCTION", "Reduction size exceeds the current position.");
    reduceOnly = true;
  }
  if (action.leverage && action.leverage > asset.maxLeverage) throw new EngineError("INVALID_LEVERAGE", `This market supports leverage up to ${asset.maxLeverage}x.`);
  const size = formatSize(amount, asset.szDecimals);
  const isTrigger = action.type === "stop-loss" || action.type === "take-profit";
  if (isTrigger && !action.triggerPrice) throw new EngineError("TRIGGER_REQUIRED", "A trigger price is required for a protective order.");
  if (action.type === "limit" && !action.price) throw new EngineError("PRICE_REQUIRED", "A limit price is required.");
  const rawPrice = isTrigger ? action.triggerPrice! : action.type === "limit" ? action.price! : ctx.midPx ?? ctx.markPx;
  const price = formatPrice(rawPrice, 6 - asset.szDecimals, side, action.type === "limit" ? 0 : action.slippageBps);
  const trigger = isTrigger ? { trigger: { isMarket: true, triggerPx: formatPrice(action.triggerPrice!, 6 - asset.szDecimals, side), tpsl: action.type === "stop-loss" ? "sl" : "tp" } } : { limit: { tif: action.type === "limit" ? "Gtc" : "Ioc" } };
  const cloid = `0x${base.id.replace(/-/g, "")}`;
  if (action.leverage) base.warnings.push("This order uses the account's current leverage setting. Change leverage in the venue before trading if needed.");
  return { ...base, request: { ...base.request, amount, side, reduceOnly }, hyperliquid: { method: "order", params: { orders: [{ a: assetIndex, b: side === "buy", p: price, s: size, r: reduceOnly, t: trigger, c: cloid }], grouping: "na" } } };
}

export async function submitHyperliquidAgentAction(prepared: PreparedAction, account: TradingAccount, key: string): Promise<SubmissionResult> {
  assertAccount(account);
  if (prepared.expiresAt < Date.now() || prepared.controlRevision !== account.controlRevision || prepared.account.id !== account.id || !isAddressEqual(getAddress(prepared.account.address), getAddress(account.address))) throw new EngineError("STALE_ACTION", "The account or permission revision changed; prepare the action again.");
  const wallet = privateKeyToAccount(key as `0x${string}`);
  if (!account.agentAddress || !isAddressEqual(wallet.address, getAddress(account.agentAddress))) throw new EngineError("SIGNER_MISMATCH", "This agent credential is not approved for this trading account.");
  if (!prepared.hyperliquid) throw new EngineError("INVALID_ACTION", "Missing venue operation.");
  const client = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet, isTestnet: true });
  try {
    const result = prepared.hyperliquid.method === "order"
      ? await client.order(prepared.hyperliquid.params as Parameters<typeof client.order>[0])
      : prepared.hyperliquid.method === "cancel"
        ? await client.cancel(prepared.hyperliquid.params as Parameters<typeof client.cancel>[0])
        : undefined;
    if (!result) throw new EngineError("UNSUPPORTED_ACTION", "The agent cannot submit this operation.");
    const body = result as unknown as { response?: { data?: { statuses?: Array<{ error?: string; resting?: { oid: number }; filled?: { oid: number } } | string> } } };
    const status = body.response?.data?.statuses?.[0];
    if (typeof status === "object" && status?.error) return { status: "rejected", evidence: { error: status.error } };
    if (prepared.hyperliquid.method === "cancel") return { status: status === "success" ? "cancelled" : "submitted-unknown", evidence: { response: body.response ?? {} } };
    const oid = typeof status === "object" ? status?.resting?.oid ?? status?.filled?.oid : undefined;
    return { status: "pending", orderId: oid ? String(oid) : undefined, evidence: { clientOrderId: (prepared.hyperliquid.params.orders as Array<{ c: string }>)[0]?.c, response: body.response ?? {} } };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return { status: "submitted-unknown", evidence: { message: "Submission result is unknown. Reconcile order state before any retry." } };
  }
}

export async function reconcileHyperliquidAction(action: { orderId?: string; id?: string; prepared?: PreparedAction }, account: TradingAccount): Promise<SubmissionResult> {
  assertAccount(account);
  const operation = action.prepared?.hyperliquid;
  const order = (operation?.params.orders as Array<{ c?: unknown }> | undefined)?.[0];
  const cloid = typeof order?.c === "string" && /^0x[\da-fA-F]{32}$/.test(order.c) ? order.c : undefined;
  const cancellation = (operation?.params.cancels as Array<{ o?: unknown }> | undefined)?.[0];
  const cancelOrderId = operation?.method === "cancel" && typeof cancellation?.o === "number" && Number.isSafeInteger(cancellation.o) && cancellation.o >= 0 ? cancellation.o : undefined;
  const reportedOrderId = action.orderId && /^\d+$/.test(action.orderId) && Number.isSafeInteger(Number(action.orderId)) ? Number(action.orderId) : undefined;
  const oid = reportedOrderId ?? cancelOrderId ?? cloid;
  if (!oid) return { status: "submitted-unknown", evidence: { message: "No venue or client order ID is available." } };
  const result = await hyperliquidInfo<{ status: string; order?: { status: string; order: { oid: number; sz: string; origSz: string } } }>({ type: "orderStatus", user: account.address, oid });
  if (result.status === "unknownOid" || !result.order) return { status: "submitted-unknown" };
  const status = result.order.status;
  const orderId = String(result.order.order.oid);
  if (status === "filled") return { status: operation?.method === "cancel" ? "rejected" : "confirmed", orderId, evidence: { venueStatus: status, ...(operation?.method === "cancel" ? { message: "The order filled before cancellation was confirmed." } : {}) } };
  if (status.toLowerCase().includes("cancel")) return { status: "cancelled", orderId, evidence: { venueStatus: status } };
  if (status.toLowerCase().includes("reject")) return { status: "rejected", orderId, evidence: { venueStatus: status } };
  const partial = result.order.order.sz !== result.order.order.origSz;
  return { status: partial ? "partially-filled" : "pending", orderId, evidence: { venueStatus: status } };
}
