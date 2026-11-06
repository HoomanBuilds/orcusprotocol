import { formatUnits } from "viem";

export function number(value: string | number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || value === "") return "--";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "--";
}

export function usd(value: string | number | undefined | null): string {
  if (value !== undefined && value !== null && value !== "" && Number(value) > 0 && Number(value) < 0.01) return "<$0.01";
  return value === undefined || value === null || value === "" ? "--" : `$${number(value)}`;
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
