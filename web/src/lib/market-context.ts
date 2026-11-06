export interface BookLevel {
  price: string;
  size: string;
  orders: number;
}

export interface HyperliquidMarketContext {
  venue: "hyperliquid";
  network: "testnet";
  symbol: string;
  retrievedAt: number;
  asset?: {
    observedAt: number;
    markPrice?: string;
    oraclePrice?: string;
    fundingRateHourly?: string;
    openInterestBase?: string;
  };
  book?: {
    observedAt: number;
    bids: BookLevel[];
    asks: BookLevel[];
  };
  warnings: string[];
}

export const MARKET_CONTEXT_STALE_MS = 20_000;

export function marketContextIsStale(observedAt: number | undefined, now: number): boolean {
  return observedAt === undefined || !Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + 5_000 || now - observedAt > MARKET_CONTEXT_STALE_MS;
}

export function cumulativeLevels(levels: BookLevel[]) {
  let cumulative = 0;
  return levels.map(level => {
    cumulative += Number(level.size);
    return { ...level, cumulative };
  });
}

export function marketQuantity(value: string | number | undefined): string {
  if (value === undefined || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
  const amount = Number(value);
  if (amount !== 0 && Math.abs(amount) < 0.000001) return `${amount < 0 ? "-" : ""}<0.000001`;
  return amount.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function hourlyFundingLabel(value: string | undefined): string {
  if (value === undefined || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
  const percentage = Number(value) * 100;
  if (percentage !== 0 && Math.abs(percentage) < 0.000001) return `${percentage < 0 ? "-" : ""}<0.000001%`;
  return `${percentage > 0 ? "+" : ""}${percentage.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}%`;
}
