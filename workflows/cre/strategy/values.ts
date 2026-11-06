const uint256Max = (1n << 256n) - 1n;

export function decimalAtoms(value: string, decimals: number, allowZero = false): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Unsupported decimal precision.");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error("Use an exact base-10 decimal within the supported precision.");
  const atoms = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  if (atoms > uint256Max || (!allowZero && atoms === 0n)) throw new Error("The decimal amount is outside its supported range.");
  return atoms;
}

export function decimalString(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals), fraction = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / unit}${fraction ? `.${fraction}` : ""}`;
}

export function parsePositiveDecimalE8(value: string): bigint {
  return decimalAtoms(value, 8);
}

export function sameRequest(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const normalized = (value: Record<string, unknown>) => Object.fromEntries(Object.entries({ ...value, nativeInput: value.nativeInput ?? false }).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
