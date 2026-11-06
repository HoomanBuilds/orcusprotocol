import { formatUnits, getAddress } from "viem";

export interface RouterBilling {
  source: "0g-router-trace";
  currency: "0g" | "usd";
  inputCost: string;
  outputCost: string;
  totalCost: string;
  totalCostUsdMicro: string;
  costUsd: string;
  nativeUnit: "neuron" | "usd-micro";
}

function integer(value: unknown): string | undefined {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  return /^(?:0|[1-9]\d{0,79})$/.test(text) ? text : undefined;
}

export function parseRouterBilling(value: unknown): RouterBilling | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const currency = raw.currency;
  const inputCost = integer(raw.input_cost ?? raw.inputCost);
  const outputCost = integer(raw.output_cost ?? raw.outputCost);
  const totalCost = integer(raw.total_cost ?? raw.totalCost);
  const totalCostUsdMicro = integer(raw.total_cost_usd_micro ?? raw.totalCostUsdMicro);
  if (!["0g", "usd"].includes(String(currency)) || inputCost === undefined || outputCost === undefined || totalCost === undefined || totalCostUsdMicro === undefined || BigInt(inputCost) + BigInt(outputCost) !== BigInt(totalCost)) return undefined;
  if (currency === "usd" && totalCost !== totalCostUsdMicro) return undefined;
  return { source: "0g-router-trace", currency: currency as RouterBilling["currency"], inputCost, outputCost, totalCost, totalCostUsdMicro, costUsd: formatUnits(BigInt(totalCostUsdMicro), 6), nativeUnit: currency === "usd" ? "usd-micro" : "neuron" };
}

export function parseRouterBalance(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const wrapper = value as Record<string, unknown>;
  const raw = wrapper.data && typeof wrapper.data === "object" ? wrapper.data as Record<string, unknown> : wrapper;
  const currency = raw.currency === undefined ? "0g" : raw.currency;
  const total = integer(raw.total_balance ?? raw.balance), deposit = integer(raw.deposit_balance ?? "0"), credit = integer(raw.credit_balance ?? "0");
  if (!["0g", "usd"].includes(String(currency)) || typeof raw.address !== "string" || !/^0x[\da-fA-F]{40}$/.test(raw.address) || total === undefined || deposit === undefined || credit === undefined) return undefined;
  let accountAddress: `0x${string}`;
  try { accountAddress = getAddress(raw.address); } catch { return undefined; }
  const decimals = currency === "usd" ? 6 : 18;
  return { status: "verified" as const, source: "0g-router" as const, currency: currency as "0g" | "usd", unit: currency === "usd" ? "USD" as const : "0G" as const, balance: formatUnits(BigInt(total), decimals), balanceBaseUnits: total, depositBalanceBaseUnits: deposit, creditBalanceBaseUnits: credit, accountAddress, observedAt: Date.now(), ...(currency === "0g" ? { balanceNeurons: total, depositBalanceNeurons: deposit } : { balanceUsdMicro: total }), message: currency === "usd" ? "Provider account balance in USD; this is the configured billing account, not an agent-wallet balance." : "Provider account balance in 0G (10^18 neurons per 0G), not USD and not an agent-wallet balance." };
}

export function estimateUsageUsd(pricing: { prompt: string; completion: string }, usage: { prompt_tokens: number; completion_tokens: number }): string | undefined {
  const scale = 10n ** 24n;
  const rate = (value: string) => {
    if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,24})?$/.test(value)) return undefined;
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * scale + BigInt(fraction.padEnd(24, "0"));
  };
  const prompt = rate(pricing.prompt), completion = rate(pricing.completion);
  if (prompt === undefined || completion === undefined || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens) || usage.prompt_tokens < 0 || usage.completion_tokens < 0) return undefined;
  const numerator = (prompt * BigInt(usage.prompt_tokens) + completion * BigInt(usage.completion_tokens)) * 1_000_000n;
  return formatUnits((numerator + scale - 1n) / scale, 6);
}
