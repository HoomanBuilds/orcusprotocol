import type { Condition, Strategy } from "./schema.js";

export interface Indicators {
  price: number;
  rsi: (period: number) => number | null;
  ma: (period: number) => number | null;
  volatility: number | null;
  change24h: number | null;
  trend: string;
  prev?: { price: number; ma: (period: number) => number | null };
}

export interface Evaluated {
  desc: string;
  computedValue: number | null;
  pass: boolean;
}

export interface EvalResult {
  action: "EXECUTE" | "WAIT";
  evaluated: Evaluated[];
}

function leftValue(c: Condition, ind: Indicators): number | null {
  switch (c.indicator) {
    case "rsi": return ind.rsi(c.period ?? 14);
    case "ma": return ind.ma(c.period ?? 14);
    case "price": return ind.price;
    case "volatility": return ind.volatility;
    case "change24h": return ind.change24h;
    case "trend": return null; // qualitative - not code-evaluable; left to notes/AI
  }
}

function rightValue(c: Condition, ind: Indicators): number | null {
  if (c.ref === "ma") return ind.ma(c.maPeriod ?? 14);
  return c.value ?? null;
}

function prevLeft(c: Condition, ind: Indicators): number | null {
  if (!ind.prev) return null;
  if (c.indicator === "price") return ind.prev.price;
  if (c.indicator === "ma") return ind.prev.ma(c.period ?? 14);
  return null; // crosses only meaningful for price/ma in v1
}

function prevRight(c: Condition, ind: Indicators): number | null {
  if (c.ref === "ma") return ind.prev ? ind.prev.ma(c.maPeriod ?? 14) : null;
  return c.value ?? null;
}

function compare(op: Condition["op"], l: number, r: number, pl: number | null, pr: number | null): boolean {
  switch (op) {
    case "lt": case "below": return l < r;
    case "lte": return l <= r;
    case "gt": case "above": return l > r;
    case "gte": return l >= r;
    case "crossesAbove": return pl !== null && pr !== null && pl <= pr && l > r;
    case "crossesBelow": return pl !== null && pr !== null && pl >= pr && l < r;
  }
}

function describe(c: Condition): string {
  const left = c.indicator === "rsi" || c.indicator === "ma" ? `${c.indicator}(${c.period ?? (c.indicator === "rsi" ? 14 : 14)})` : c.indicator;
  const right = c.ref === "ma" ? `ma(${c.maPeriod ?? 14})` : String(c.value);
  return `${left} ${c.op} ${right}`;
}

export function evaluateStrategy(s: Strategy, ind: Indicators): EvalResult {
  const evaluated: Evaluated[] = s.conditions.map((c) => {
    const l = leftValue(c, ind);
    const r = rightValue(c, ind);
    const pass = l !== null && r !== null && compare(c.op, l, r, prevLeft(c, ind), prevRight(c, ind));
    return { desc: describe(c), computedValue: l, pass };
  });
  let action: "EXECUTE" | "WAIT" = "WAIT";
  if (evaluated.length > 0) {
    action = s.logic === "AND" ? (evaluated.every((e) => e.pass) ? "EXECUTE" : "WAIT")
                               : (evaluated.some((e) => e.pass) ? "EXECUTE" : "WAIT");
  }
  return { action, evaluated };
}
