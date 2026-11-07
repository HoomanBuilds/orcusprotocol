import { randomUUID } from "node:crypto";
import { ExchangeClient, HttpTransport, type IRequestTransport } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import { getAddress, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkHyperliquidOrderSize, tradeRequestSchema, type Market, type MarketCandle, type PreparedAction, type TradingAccount, type TradeRequest } from "@orcus/core";
import { EngineError, requestJson } from "../../errors";
import type { AccountPortfolio, SubmissionResult } from "../../types";
import { decimalToAtoms, formatPrice, formatSize } from "./wire-format";
import { classifyOrderStatus, sizeProgress, summarizeOrderFills } from "./lifecycle";

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
  if (!Array.isArray(candles) || candles.length > 501) throw new EngineError("INVALID_UPSTREAM", "The venue returned invalid candle data.", 502);
  return candles.map(c => {
    if (!c || typeof c !== "object" || !Number.isSafeInteger(c.t) || c.t <= 0 || ![c.o, c.h, c.l, c.c, c.v].every(value => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)))) throw new EngineError("INVALID_UPSTREAM", "The venue returned malformed candle data.", 502);
    const candle = { time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) };
    if ([candle.open, candle.high, candle.low, candle.close].some(value => value <= 0) || candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) throw new EngineError("INVALID_UPSTREAM", "The venue returned incoherent candle prices.", 502);
    return candle;
  });
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
  if (action.venue !== "hyperliquid") throw new EngineError("VENUE_MISMATCH", "This adapter only prepares Hyperliquid actions.");
  if (!["market", "limit", "cancel", "close", "reduce", "stop-loss", "take-profit"].includes(action.type)) throw new EngineError("UNSUPPORTED_ACTION", "This action is not supported by the Hyperliquid adapter.");
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
  const sizeCheck = checkHyperliquidOrderSize({ amount: size, price, sizeDecimals: asset.szDecimals, reduceOnly });
  if (!sizeCheck.valid) throw new EngineError(sizeCheck.code!, `${sizeCheck.message}${sizeCheck.minimumSize ? ` Minimum size: ${sizeCheck.minimumSize} ${symbol}.` : ""}`);
  const trigger = isTrigger ? { trigger: { isMarket: true, triggerPx: formatPrice(action.triggerPrice!, 6 - asset.szDecimals, side), tpsl: action.type === "stop-loss" ? "sl" : "tp" } } : { limit: { tif: action.type === "limit" ? "Gtc" : "Ioc" } };
  const cloid = `0x${base.id.replace(/-/g, "")}`;
  if (action.leverage) base.warnings.push("This order uses the account's current leverage setting. Change leverage in the venue before trading if needed.");
  return { ...base, request: { ...base.request, amount, side, reduceOnly }, hyperliquid: { method: "order", params: { orders: [{ a: assetIndex, b: side === "buy", p: price, s: size, r: reduceOnly, t: trigger, c: cloid }], grouping: "na" } } };
}

export async function submitHyperliquidAgentAction(prepared: PreparedAction, account: TradingAccount, key: string, options: { assertAuthority?: () => void | Promise<void> } = {}): Promise<SubmissionResult> {
  let sendAttempted = false, authorityFailure: (Error & { phase: "not-submitted" }) | undefined;
  try {
  assertAccount(account);
  if (prepared.expiresAt < Date.now() || prepared.controlRevision !== account.controlRevision || prepared.account.id !== account.id || !isAddressEqual(getAddress(prepared.account.address), getAddress(account.address))) throw new EngineError("STALE_ACTION", "The account or permission revision changed; prepare the action again.");
  const wallet = privateKeyToAccount(key as `0x${string}`);
  if (!account.agentAddress || !isAddressEqual(wallet.address, getAddress(account.agentAddress))) throw new EngineError("SIGNER_MISMATCH", "This agent credential is not approved for this trading account.");
  if (!prepared.hyperliquid) throw new EngineError("INVALID_ACTION", "Missing venue operation.");
  const assertReady = async () => {
    try {
      await options.assertAuthority?.();
      if (prepared.expiresAt <= Date.now()) throw new EngineError("STALE_ACTION", "The prepared action expired before signing or submission.", 409);
    } catch (error) {
      authorityFailure = Object.assign(error instanceof Error ? error : new EngineError("CONTROL_CHANGED", "Account authority changed before submission.", 409), { phase: "not-submitted" as const });
      throw authorityFailure;
    }
  };
  const guardedWallet: typeof wallet = { ...wallet, signTypedData: async parameters => { await assertReady(); return wallet.signTypedData(parameters); } };
  const transport = new HttpTransport({ isTestnet: true });
  const guardedTransport: IRequestTransport = {
    isTestnet: true,
    async request<T>(endpoint: "info" | "exchange", payload: unknown, signal?: AbortSignal): Promise<T> {
      await assertReady();
      if (endpoint === "exchange") sendAttempted = true;
      return transport.request<T>(endpoint, payload, signal);
    },
  };
  const client = new ExchangeClient({ transport: guardedTransport, wallet: guardedWallet, defaultExpiresAfter: prepared.expiresAt });
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
    if (authorityFailure) throw authorityFailure;
    if (!sendAttempted) throw Object.assign(error instanceof EngineError ? error : new EngineError("VENUE_PREFLIGHT_FAILED", "The venue request could not be signed or validated. Nothing was submitted.", 409), { phase: "not-submitted" as const });
    if (error instanceof ApiRequestError) {
      const response = error.response as { status?: string; response?: unknown };
      const statuses = (response?.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses;
      const orders = prepared.hyperliquid?.params.orders;
      const singleOrderRejected = prepared.hyperliquid?.method === "order" && Array.isArray(orders) && orders.length === 1 && statuses?.length === 1 && typeof statuses[0] === "object" && statuses[0] !== null && "error" in statuses[0] && typeof statuses[0].error === "string";
      if (response?.status === "err" && typeof response.response === "string" || singleOrderRejected) return { status: "rejected", evidence: { error: error.message, response: error.response } };
    }
    return { status: "submitted-unknown", evidence: { message: "Submission result is unknown. Reconcile order state before any retry." } };
  }
}

type ReconciliationAction = { orderId?: string; id?: string; status?: string; createdAt?: number; prepared?: PreparedAction };

async function recoverExpiredIoc(action: ReconciliationAction, account: TradingAccount): Promise<SubmissionResult> {
  const unknown: SubmissionResult = { status: "submitted-unknown" };
  const prepared = action.prepared, operation = prepared?.hyperliquid, now = Date.now(), createdAt = action.createdAt;
  if (!prepared || !["submitting", "submitted-unknown"].includes(action.status ?? "") || action.orderId !== undefined || operation?.method !== "order" || prepared.kind !== "hyperliquid") return unknown;
  const params = operation.params, orders = params.orders as Array<{ c?: unknown; t?: { limit?: { tif?: unknown }; trigger?: unknown } }> | undefined;
  if (!Array.isArray(orders) || orders.length !== 1 || params.grouping !== "na" || params.vaultAddress !== undefined || params.expiresAfter !== undefined || orders[0]?.t?.limit?.tif !== "Ioc" || orders[0]?.t?.trigger !== undefined || typeof orders[0]?.c !== "string" || !/^0x[\da-f]{32}$/i.test(orders[0].c)) return unknown;
  if (prepared.account.id !== account.id || prepared.request.accountId !== account.id || prepared.request.venue !== "hyperliquid" || prepared.account.address.toLowerCase() !== account.address.toLowerCase()) return unknown;
  if (!Number.isSafeInteger(createdAt) || createdAt! <= 0 || now - createdAt! > 86_400_000 || !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= createdAt! || prepared.expiresAt - createdAt! > 300_000 || now - prepared.expiresAt < 300_000) return unknown;
  const startTime = Math.max(0, createdAt! - 60_000);
  try {
    const [fills, orders, state] = await Promise.all([
      hyperliquidInfo<unknown>({ type: "userFillsByTime", user: account.address, startTime, endTime: now, aggregateByTime: false }),
      hyperliquidInfo<unknown>({ type: "openOrders", user: account.address }),
      hyperliquidInfo<Clearinghouse & { time?: number }>({ type: "clearinghouseState", user: account.address }),
    ]);
    const nonnegative = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
    const zero = (value: unknown) => nonnegative(value) && /^0(?:\.0+)?$/.test(value);
    if (!Array.isArray(fills) || fills.length !== 0 || !Array.isArray(orders) || orders.length !== 0 || !state || !Array.isArray(state.assetPositions) || state.assetPositions.length !== 0 || !nonnegative(state.marginSummary?.accountValue) || !nonnegative(state.withdrawable) || !zero(state.marginSummary?.totalMarginUsed) || !zero(state.marginSummary?.totalNtlPos) || !Number.isSafeInteger(state.time) || Date.now() - state.time! > 30_000 || state.time! - Date.now() > 5_000) return unknown;
    return { status: "expired", evidence: { recovery: "expired-ioc-no-execution-observed", previousStatus: action.status, message: "Request expired. No execution, open orders or positions observed. The original request will not be retried.", signedExpiresAfter: prepared.expiresAt, checkedAt: Date.now(), historyStartTime: startTime, historyEndTime: now, clientOrderId: (params.orders as Array<{ c: string }>)[0].c, venueStatus: "unknownOid", observedFillCount: 0, observedOpenOrderCount: 0, observedPositionCount: 0, accountStateTime: state.time } };
  } catch { return unknown; }
}

export async function reconcileHyperliquidAction(action: ReconciliationAction, account: TradingAccount): Promise<SubmissionResult> {
  assertAccount(account);
  const operation = action.prepared?.hyperliquid;
  const order = (operation?.params.orders as Array<{ c?: unknown }> | undefined)?.[0];
  const cloid = typeof order?.c === "string" && /^0x[\da-fA-F]{32}$/.test(order.c) ? order.c : undefined;
  const cancellation = (operation?.params.cancels as Array<{ o?: unknown }> | undefined)?.[0];
  const cancelOrderId = operation?.method === "cancel" && typeof cancellation?.o === "number" && Number.isSafeInteger(cancellation.o) && cancellation.o >= 0 ? cancellation.o : undefined;
  const reportedOrderId = action.orderId && /^\d+$/.test(action.orderId) && Number.isSafeInteger(Number(action.orderId)) ? Number(action.orderId) : undefined;
  const oid = cancelOrderId ?? cloid ?? reportedOrderId;
  if (oid === undefined) return { status: "submitted-unknown", evidence: { message: "No venue or client order ID is available." } };
  const result = await hyperliquidInfo<{ status: string; order?: { status: string; order: { oid: number; sz: string; origSz: string; timestamp?: number; coin?: string } } }>({ type: "orderStatus", user: account.address, oid });
  if (result?.status === "unknownOid") return recoverExpiredIoc(action, account);
  if (!result || result.status !== "order" || !result.order?.order) return { status: "submitted-unknown" };
  const status = result.order.status, venueOrder = result.order.order;
  if (!Number.isSafeInteger(venueOrder.oid) || venueOrder.oid < 0 || typeof oid === "number" && venueOrder.oid !== oid || reportedOrderId !== undefined && venueOrder.oid !== reportedOrderId || typeof status !== "string") return { status: "submitted-unknown", evidence: { message: "The venue returned inconsistent order identity." } };
  const orderId = String(venueOrder.oid), classified = classifyOrderStatus(status), progress = sizeProgress(venueOrder.sz, venueOrder.origSz);
  if (classified === "submitted-unknown") return { status: classified, orderId, evidence: { venueStatus: status, message: "Unsupported venue status. Reconciliation is required before retrying." } };
  const evidence: Record<string, unknown> = { venueStatus: status, ...(classified === "pending" && progress ? progress : {}) };
  if (classified !== "pending" || progress?.partial) {
    try {
      const now = Date.now(), timestamp = Number.isSafeInteger(venueOrder.timestamp) && venueOrder.timestamp! >= 0 ? venueOrder.timestamp! : (action.prepared?.expiresAt ?? now) - 120_000;
      const fills = await hyperliquidInfo<unknown>({ type: "userFillsByTime", user: account.address, startTime: Math.max(0, Math.min(timestamp, now)), endTime: now, aggregateByTime: false });
      Object.assign(evidence, summarizeOrderFills(fills, venueOrder.oid, venueOrder.coin ?? (action.prepared?.request.symbol ? coinName(action.prepared.request.symbol) : undefined), venueOrder.origSz));
      if (evidence.observedExecutedSize !== "0" && (classified === "cancelled" || classified === "rejected")) evidence.executionOutcome = evidence.fillsComplete ? `filled-before-${classified}` : `partially-filled-${classified}`;
    } catch { evidence.fillEvidenceStatus = "unavailable"; evidence.fillsComplete = false; }
  }
  if (classified === "confirmed" && operation?.method === "cancel") return { status: "rejected", orderId, evidence: { ...evidence, message: "The order filled before cancellation was confirmed." } };
  return { status: classified === "pending" && progress?.partial ? "partially-filled" : classified, orderId, evidence };
}
