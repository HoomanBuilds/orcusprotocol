import { getAddress, isAddressEqual } from "viem";
import type { Market, MarketCandle, OstiumMarket, TradingAccount } from "@orcus/core";
import { OSTIUM_TESTNET } from "@orcus/wallets/ostium";
import { EngineError } from "../../errors";
import type { AccountPortfolio } from "../../types";
import { boundedOstiumRead, getOstiumPrices, ostiumSdk, pairSymbol, priceForPair, verifiedOstiumRpc, type OstiumPair } from "./client";

export function assertOstiumAccount(account: TradingAccount) {
  if (String(account.venue) !== "ostium" || account.chainId !== OSTIUM_TESTNET.chainId || !isAddressEqual(getAddress(account.address), getAddress(account.ownerAddress)) || account.smartAccountAddress) throw new EngineError("ACCOUNT_MISMATCH", "Ostium requires the owner's Arbitrum Sepolia EOA trading account.");
}

export const positionKey = (pairId: string, pid: string) => `ostium-position:${pairId}:${pid}`;
export const orderKey = (pairId: string, index: number) => `ostium-order:${pairId}:${index}`;
export async function getOstiumPair(symbol: string): Promise<OstiumPair> {
  if (symbol.length > 50 || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(symbol)) throw new EngineError("UNSUPPORTED_MARKET", "Choose an available Ostium testnet market.");
  const client = await ostiumSdk();
  const { pairs } = await boundedOstiumRead(() => client.getPairs({ builderFeeBps: 0 }));
  const matches = pairs.filter(pair => pairSymbol(pair) === symbol);
  if (matches.length !== 1 || !/^\d+$/.test(matches[0].pairId) || Number(matches[0].pairId) > 65535) throw new EngineError("UNSUPPORTED_MARKET", "The Ostium symbol does not uniquely identify a current testnet pair.");
  return matches[0];
}

export async function getOstiumMarkets(): Promise<OstiumMarket[]> {
  const client = await ostiumSdk();
  const [{ pairs }, prices] = await Promise.all([boundedOstiumRead(() => client.getPairs({ builderFeeBps: 0 })), getOstiumPrices()]);
  return pairs.map(pair => {
    const price = priceForPair(pair, prices), enabled = pair.maxLeverage > 0;
    return { venue: "ostium" as const, symbol: pairSymbol(pair), baseAsset: pair.pairFrom, quoteAsset: pair.pairTo, midPrice: price?.mid ?? "", maxLeverage: pair.maxLeverage, observedAt: price?.observedAt ?? 0, pairId: Number(pair.pairId), category: pair.category, tradable: enabled && !!price?.isMarketOpen, marketOpen: price?.isMarketOpen ?? false, unavailableReason: !enabled ? "New positions are disabled by the testnet pair." : !price ? "Live price is unavailable or stale." : !price.isMarketOpen ? "This market is closed." : undefined, minLeverage: pair.minLeverage, overnightMaxLeverage: pair.overnightMaxLeverage, rolloverRate: pair.rolloverRate, openInterest: pair.openInterest, openFeeBps: pair.openFee, oracleFeeUsdc: pair.oracleFee, schedule: pair.schedule };
  });
}

export async function getOstiumPortfolio(account: TradingAccount): Promise<AccountPortfolio> {
  assertOstiumAccount(account);
  const client = await ostiumSdk(account.address), user = getAddress(account.address);
  await verifiedOstiumRpc();
  const [balances, positions, orders, pending] = await Promise.allSettled([boundedOstiumRead(() => client.getBalances(user)), boundedOstiumRead(() => client.getOpenPositions({ user, limit: 200 })), boundedOstiumRead(() => client.getOpenOrders({ user })), boundedOstiumRead(() => client.getOrders({ user, isPending: true, limit: 100 }))]);
  const errors: string[] = [];
  const result: AccountPortfolio = { accountId: account.id, balances: [], positions: [], orders: [], observedAt: Date.now() };
  if (balances.status === "fulfilled") result.balances = [{ symbol: "USDC", tokenAddress: OSTIUM_TESTNET.usdc, decimals: 6, accountId: account.id, amount: balances.value.usdc }, { symbol: "ETH", decimals: 18, accountId: account.id, amount: balances.value.eth }]; else errors.push("Ostium account balances are unavailable.");
  if (positions.status === "fulfilled") {
    if (positions.value.pairPositions.length >= 200) errors.push("Only the latest 200 Ostium positions are loaded.");
    result.positions = positions.value.pairPositions.flatMap(({ position }) => {
      if (!isAddressEqual(getAddress(position.trader), user) || position.idx < 0 || !/\d+/.test(position.pid)) return [];
      return [{ id: positionKey(position.pairId, position.pid), accountId: account.id, venue: "ostium" as Market["venue"], symbol: `${position.pairFrom}/${position.pairTo}`, side: position.side === "B" ? "long" as const : "short" as const, size: position.szi, entryPrice: position.entryPx, unrealizedPnl: position.unrealizedPnl, liquidationPrice: position.liquidationPx, leverage: Number(position.leverage), observedAt: positions.value.time, collateralUsd: position.collateralUsed, notionalUsd: position.ntl, takeProfit: position.tpPx, stopLoss: position.slPx, maxRemovableCollateralUsd: position.maxWithdrawable, isDayTrade: position.isDayTrade, pairId: Number(position.pairId), positionIndex: position.idx, rolloverUsd: position.cumRollover }];
    });
  } else errors.push("Ostium positions are unavailable.");
  if (orders.status === "fulfilled") result.orders = orders.value.flatMap(order => !isAddressEqual(getAddress(order.trader), user) ? [] : [{ id: orderKey(order.pairId, order.idx), accountId: account.id, venue: "ostium" as Market["venue"], symbol: `${order.pairFrom}/${order.pairTo}`, side: order.side === "B" ? "buy" as const : "sell" as const, type: order.orderType.toLowerCase(), size: order.szi, price: order.limitPx, reduceOnly: false, createdAt: order.timestamp, collateralUsd: order.collateralUsed, leverage: Number(order.leverage), takeProfit: order.tpPx, stopLoss: order.slPx, pairId: Number(order.pairId), orderIndex: order.idx }]); else errors.push("Ostium orders are unavailable.");
  if (pending.status === "fulfilled") result.orders.push(...pending.value.flatMap(order => !isAddressEqual(getAddress(order.trader), user) || !order.isPending || order.isCancelled ? [] : [{ id: order.action === "Open" ? `pending-open:${order.oid}` : order.action === "Close" ? `pending-close:${order.oid}` : `ostium-pending:${order.oid}`, accountId: account.id, venue: "ostium" as Market["venue"], symbol: `${order.pairFrom}/${order.pairTo}`, side: order.side === "B" ? "buy" as const : "sell" as const, type: `pending-${order.action.toLowerCase()}`, size: order.szi, price: order.px, reduceOnly: order.action === "Close", createdAt: order.initiatedTime, collateralUsd: order.collateralUsed, notionalUsd: order.ntl }])); else errors.push("Ostium pending oracle orders are unavailable.");
  if (errors.length) result.errors = errors;
  return result;
}

export async function getOstiumHistory(account: TradingAccount) {
  assertOstiumAccount(account);
  const client = await ostiumSdk(account.address), user = getAddress(account.address);
  const [fills, orders, limitHistory] = await Promise.all([boundedOstiumRead(() => client.getFills({ user, limit: 50 })), boundedOstiumRead(() => client.getOrders({ user, limit: 50 })), boundedOstiumRead(() => client.getLimitOrderHistory({ user, limit: 50 }))]);
  return { venue: "ostium", chainId: 421614, fills: fills.filter(fill => isAddressEqual(getAddress(fill.trader), user)), orders: orders.filter(order => isAddressEqual(getAddress(order.trader), user)), limitHistory: limitHistory.filter(order => isAddressEqual(getAddress(order.trader), user)), observedAt: Date.now() };
}

export async function getOstiumCandles(input: { symbol: string; interval?: string; limit?: number }): Promise<MarketCandle[]> {
  const resolutions = { "1m": ["1", 60_000], "5m": ["5", 300_000], "15m": ["15", 900_000], "1h": ["60", 3_600_000], "4h": ["240", 14_400_000], "1d": ["1D", 86_400_000] } as const;
  const resolution = resolutions[(input.interval ?? "15m") as keyof typeof resolutions];
  if (!resolution) throw new EngineError("INVALID_INTERVAL", "Unsupported Ostium candle interval.");
  const limit = Math.min(500, Math.max(1, input.limit ?? 160)), pair = await getOstiumPair(input.symbol), client = await ostiumSdk(), to = Date.now();
  const candles = await boundedOstiumRead(() => client.getCandles({ pairId: pair.pairId, from: to - resolution[1] * limit, to, resolution: resolution[0], sets: 1 }));
  return candles.slice(-limit).map(candle => ({ time: Math.floor(candle.time / 1000), open: candle.open, high: candle.high, low: candle.low, close: candle.close }));
}
