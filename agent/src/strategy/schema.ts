export type Op = "lt" | "gt" | "lte" | "gte" | "below" | "above" | "crossesAbove" | "crossesBelow";
export type Indicator = "rsi" | "ma" | "price" | "volatility" | "trend" | "change24h";

export interface Condition {
  indicator: Indicator;
  period?: number;     // rsi period (default 14)
  op: Op;
  value?: number;      // numeric threshold
  ref?: "ma";          // compare against another indicator instead of `value`
  maPeriod?: number;   // ma period when ref === "ma" (e.g. 60 = "1h" on 1m candles)
}

export interface Strategy {
  version: 1;
  conditions: Condition[];
  logic: "AND" | "OR";
  notes?: string;
  trade: { inputAsset: "native" | string; amountIn: string; outputToken: string; slippageBps: number };
  expiryTs?: number;
}

const INDICATORS: Indicator[] = ["rsi", "ma", "price", "volatility", "trend", "change24h"];
const OPS: Op[] = ["lt", "gt", "lte", "gte", "below", "above", "crossesAbove", "crossesBelow"];

export function isStrategy(x: unknown): x is Strategy {
  return !!x && typeof x === "object" && Array.isArray((x as Strategy).conditions) && "logic" in (x as object);
}

export function validateStrategy(x: unknown): string | null {
  if (!isStrategy(x)) return "not a strategy object";
  const s = x as Strategy;
  if (s.conditions.length === 0) return "no conditions";
  if (s.logic !== "AND" && s.logic !== "OR") return "logic must be AND or OR";
  for (const c of s.conditions) {
    if (!INDICATORS.includes(c.indicator)) return `unknown indicator: ${c.indicator}`;
    if (!OPS.includes(c.op)) return `unknown op: ${c.op}`;
    if (c.ref !== "ma" && (c.value === undefined || c.value === null || isNaN(Number(c.value)))) {
      return `condition needs a numeric value or ref: ${c.indicator}`;
    }
  }
  return null;
}
