import { formatUnits, getAddress } from "viem";
import { engineConfig } from "../config";
import type { PlannerContext } from "../types";
import { runPersonalAgent } from "./agent";
import type { AgentContext, PlannerReply } from "./types";
export type { AgentContext, AgentCheckpoint, AgentMemoryNote, MemoryStore, PlannerReply, ModelEvidence, ModelUsage, ToolTrace } from "./types";

export function planWith0G(message: string, context: PlannerContext = {}): Promise<PlannerReply> {
  return runPersonalAgent(message, context as AgentContext);
}

export async function getComputeBalance(): Promise<{ status: "verified" | "unavailable" | "unconfigured"; balance?: string; balanceNeurons?: string; depositBalanceNeurons?: string; accountAddress?: string; unit?: "0G" | "unknown"; source?: "0g-router" | "custom-legacy"; message: string }> {
  const cfg = engineConfig().compute;
  const managementKey = process.env.ZEROG_COMPUTE_MANAGEMENT_KEY;
  if (managementKey) {
    try {
      const response = await fetch("https://router-api.0g.ai/v1/account/balance", { headers: { Authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return { status: "unavailable", source: "0g-router", unit: "0G", message: `0G Router account balance returned HTTP ${response.status}; use a management key scoped to account:read.` };
      const raw = await response.json() as { data?: unknown; address?: unknown; deposit_balance?: unknown; total_balance?: unknown };
      const body = (raw.data ?? raw) as { address?: unknown; deposit_balance?: unknown; total_balance?: unknown };
      const total = String(body.total_balance), deposit = String(body.deposit_balance);
      if (typeof body.address !== "string" || !/^0x[\da-fA-F]{40}$/.test(body.address) || !/^\d{1,80}$/.test(total) || !/^\d{1,80}$/.test(deposit) || typeof body.total_balance === "number" && !Number.isSafeInteger(body.total_balance) || typeof body.deposit_balance === "number" && !Number.isSafeInteger(body.deposit_balance)) return { status: "unavailable", source: "0g-router", unit: "0G", message: "The Router returned an unsupported neuron balance response." };
      return { status: "verified", balance: formatUnits(BigInt(total), 18), balanceNeurons: total, depositBalanceNeurons: deposit, accountAddress: getAddress(body.address), unit: "0G", source: "0g-router", message: "Router balance in 0G units (10^18 neurons per 0G), not USD and not an agent-wallet balance." };
    } catch { return { status: "unavailable", source: "0g-router", unit: "0G", message: "The 0G Router management balance could not be read." }; }
  }
  if (!cfg.balanceUrl || !cfg.apiKey) return { status: "unconfigured", message: "Configure ZEROG_COMPUTE_MANAGEMENT_KEY with account:read for the Router balance. An inference key or operating-wallet balance is not a provider credit balance." };
  try {
    const response = await fetch(cfg.balanceUrl, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { status: "unavailable", message: `The compute balance service returned HTTP ${response.status}.` };
    const body = await response.json() as { balance?: unknown; credits?: unknown };
    const balance = body.balance ?? body.credits;
    if (typeof balance !== "string" && typeof balance !== "number" || !/^\d+(\.\d+)?$/.test(String(balance))) return { status: "unavailable", message: "The compute service returned an unsupported balance response." };
    return { status: "verified", balance: String(balance), unit: "unknown", source: "custom-legacy", message: "Balance from the operator's legacy custom interface; units are not verified as Router neurons, 0G or USD." };
  } catch { return { status: "unavailable", message: "The compute credit balance could not be read." }; }
}
