import { EngineError } from "../../errors";

export function decimalToAtoms(value: string, decimals: number): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 80) throw new EngineError("INVALID_AMOUNT", "Use an unsigned decimal amount.");
  const [integer, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new EngineError("INVALID_PRECISION", `This market supports at most ${decimals} decimal places.`);
  return BigInt(integer) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function atomsToDecimal(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

export function formatSize(value: string, decimals: number): string {
  const atoms = decimalToAtoms(value, decimals);
  if (atoms <= 0n) throw new EngineError("INVALID_AMOUNT", "Order size must be greater than zero.");
  return atomsToDecimal(atoms, decimals);
}

export function formatPrice(value: string, maxDecimals: number, side: "buy" | "sell", slippageBps = 0): string {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+(\.\d+)?$/.test(value) || fraction.length > 36 || value.length > 80) throw new EngineError("INVALID_PRICE", "Price is not a valid decimal.");
  const numerator = (BigInt(whole) * 10n ** BigInt(fraction.length) + BigInt(fraction || "0")) * BigInt(10_000 + (side === "buy" ? slippageBps : -slippageBps));
  const denominator = 10n ** BigInt(fraction.length) * 10_000n;
  for (let decimals = Math.max(0, maxDecimals); decimals >= 0; decimals--) {
    const scaledNumerator = numerator * 10n ** BigInt(decimals);
    const scaled = scaledNumerator / denominator + (side === "buy" && scaledNumerator % denominator !== 0n ? 1n : 0n);
    if (scaled <= 0n) continue;
    const formatted = atomsToDecimal(scaled, decimals);
    if (!formatted.includes(".") || formatted.replace(".", "").replace(/^0+/, "").length <= 5) return formatted;
  }
  throw new EngineError("INVALID_PRICE", "Price cannot be represented by the venue's tick rules.");
}
