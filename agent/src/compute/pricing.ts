import { formatUnits } from "viem";
import { EngineError } from "../errors";

export function computePriceCeilings(maxCostUsd: string | undefined, messages: Array<{ content: string }>, maxTokens: number): Record<string, string> {
  if (maxCostUsd === undefined) return {};
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(maxCostUsd) || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new EngineError("INVALID_COMPUTE_BUDGET", "The model request has no valid bounded expense reservation.");
  const [whole, fraction = ""] = maxCostUsd.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const promptBound = Buffer.byteLength(JSON.stringify(messages), "utf8") + messages.length * 32 + 256;
  const tokenBound = BigInt(promptBound + maxTokens);
  const ceiling = formatUnits((micros > 0n ? micros - 1n : 0n) * 1_000_000n / tokenBound, 6);
  return { "X-0G-Provider-Max-Price-Usd-Prompt": ceiling, "X-0G-Provider-Max-Price-Usd-Completion": ceiling };
}
