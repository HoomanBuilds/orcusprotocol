export interface HyperliquidSizeCheck {
  valid: boolean;
  code?: "INVALID_AMOUNT" | "INVALID_PRECISION" | "MARKET_DATA_UNAVAILABLE" | "MINIMUM_NOTIONAL";
  message?: string;
  minimumSize?: string;
}

function decimal(value: string): { atoms: bigint; scale: bigint } | undefined {
  if (value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return;
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  return { atoms: BigInt(whole) * scale + BigInt(fraction || "0"), scale };
}

export function checkHyperliquidOrderSize(input: {
  amount: string;
  price?: string;
  sizeDecimals?: number;
  reduceOnly?: boolean;
  observedAt?: number;
  now?: number;
}): HyperliquidSizeCheck {
  const amount = decimal(input.amount);
  if (!amount || amount.atoms <= 0n) return { valid: false, code: "INVALID_AMOUNT", message: "Enter an amount greater than zero." };
  const decimals = input.sizeDecimals;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 6) return { valid: false, code: "MARKET_DATA_UNAVAILABLE", message: "Waiting for current market limits." };
  if ((input.amount.split(".")[1]?.length ?? 0) > decimals) return { valid: false, code: "INVALID_PRECISION", message: `Use at most ${decimals} decimal places for this asset.` };
  // Do not prevent dust-position exits with an entry-order minimum.
  if (input.reduceOnly) return { valid: true };
  const price = input.price === undefined ? undefined : decimal(input.price);
  const age = input.observedAt === undefined ? 0 : (input.now ?? Date.now()) - input.observedAt;
  if (!price || price.atoms <= 0n || !Number.isFinite(age) || age < 0 || age > 30_000) return { valid: false, code: "MARKET_DATA_UNAVAILABLE", message: "Waiting for a fresh price to check the minimum order." };
  const sizeScale = 10n ** BigInt(decimals);
  const numerator = 10n * price.scale * sizeScale;
  const minimumAtoms = (numerator + price.atoms - 1n) / price.atoms;
  const digits = minimumAtoms.toString().padStart(decimals + 1, "0");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  const minimumSize = decimals ? `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}` : digits;
  if (amount.atoms * price.atoms < 10n * amount.scale * price.scale) return { valid: false, code: "MINIMUM_NOTIONAL", message: "Hyperliquid requires an order value of at least 10 USDC.", minimumSize };
  return { valid: true, minimumSize };
}
