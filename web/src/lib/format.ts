export function number(value: string | number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || value === "") return "--";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "--";
}

export function usd(value: string | number | undefined | null): string {
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
