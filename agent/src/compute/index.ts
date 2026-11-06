import { parseRouterBalance } from "../budget/billing";
import { engineConfig } from "../config";
import type { PlannerContext } from "../types";
import { runPersonalAgent } from "./agent";
import type { AgentContext, PlannerReply } from "./types";
export type { AgentContext, AgentCheckpoint, AgentMemoryNote, MemoryStore, PlannerReply, ModelEvidence, ModelUsage, ToolTrace } from "./types";
export { automationProposalSchema, type AutomationProposal } from "./automation";

export function planWith0G(message: string, context: PlannerContext = {}): Promise<PlannerReply> {
  return runPersonalAgent(message, context as AgentContext);
}

export async function getComputeBalance(): Promise<{ status: "verified" | "unavailable" | "unconfigured"; balance?: string; balanceNeurons?: string; depositBalanceNeurons?: string; balanceBaseUnits?: string; depositBalanceBaseUnits?: string; creditBalanceBaseUnits?: string; accountAddress?: string; currency?: "0g" | "usd"; chainId?: number; observedAt?: number; unit?: "0G" | "USD" | "unknown"; source?: "0g-router" | "custom-legacy"; message: string }> {
  const cfg = engineConfig().compute;
  const managementKey = process.env.ZEROG_COMPUTE_MANAGEMENT_KEY;
  if (managementKey) {
    try {
      const testnet = cfg.url && new URL(cfg.url).origin === "https://router-api-testnet.integratenetwork.work";
      const balanceOrigin = testnet ? "https://router-api-testnet.integratenetwork.work" : "https://router-api.0g.ai";
      const response = await fetch(`${balanceOrigin}/v1/account/balance`, { headers: { Authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) return { status: "unavailable", source: "0g-router", unit: "0G", message: `0G Router account balance returned HTTP ${response.status}; use a management key scoped to account:read.` };
      const balance = parseRouterBalance(await response.json());
      if (!balance) return { status: "unavailable", source: "0g-router", message: "The Router returned unsupported balance units or account identity." };
      return { ...balance, chainId: testnet ? 16602 : 16661, message: balance.currency === "0g" ? "Router balance in 0G units (10^18 neurons per 0G), not USD and not an agent-wallet balance." : "Router balance in USD (10^6 base units per USD). Native 0G deposits cannot replenish a USD-mode account." };
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
