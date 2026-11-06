import { formatUnits } from "viem";

export function number(value: string | number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || value === "") return "--";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "--";
}

export function usd(value: string | number | undefined | null): string {
  if (value === undefined || value === null || typeof value === "string" && !value.trim()) return "--";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  if (parsed !== 0 && Math.abs(parsed) < 0.01) return `${parsed < 0 ? "-" : ""}<$0.01`;
  return `${parsed < 0 ? "-" : ""}$${number(Math.abs(parsed))}`;
}

export function shortAddress(value: string): string {
  return value.length > 15 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export function time(value?: number | string): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function statusLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}
export function tokenUnits(value: string | undefined, decimals: number, symbol: string): string {
  if (value === undefined || !/^\d{1,80}$/.test(value) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return "Unavailable";
  const amount = Number(formatUnits(BigInt(value), decimals));
  if (amount === 0) return `0 ${symbol}`;
  if (amount < 0.0001) return `<0.0001 ${symbol}`;
  const digits = amount < 1 ? 6 : amount < 1000 ? 4 : 2;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`;
}

export function assetAmount(value: string | undefined, symbol: string): string {
  if (value === undefined || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return `Unavailable ${symbol}`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `Unavailable ${symbol}`;
  if (parsed === 0) return `0 ${symbol}`;
  if (Math.abs(parsed) < 0.0001) return `${parsed < 0 ? ">-" : "<"}0.0001 ${symbol}`;
  return `${parsed.toLocaleString("en-US", { maximumFractionDigits: Math.abs(parsed) < 1 ? 6 : Math.abs(parsed) < 1000 ? 4 : 2 })} ${symbol}`;
}

export function quotePrice(value: string | number | undefined, quoteAsset = "USDC"): string {
  if (value === undefined || typeof value === "string" && !value.trim() || !Number.isFinite(Number(value))) return "Unavailable";
  const amount = Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  return quoteAsset === "USD" || quoteAsset === "USDC" ? `$${amount}` : `${amount} ${quoteAsset}`;
}
