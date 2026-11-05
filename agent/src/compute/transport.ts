import { EngineError } from "../errors";
import type { AgentContext, AgentMessage, ModelEvidence, ModelUsage } from "./types";

function usageValues(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const result: ModelUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) if (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0) result[key] = input[key];
  return Object.keys(result).length ? result : undefined;
}

export async function invoke0G(input: { url: string; apiKey: string; model: string; messages: Array<AgentMessage | { role: "system"; content: string }>; callId: string; maxTokens: number; timeoutMs: number; context: AgentContext }): Promise<{ content: string; evidence: ModelEvidence }> {
  let response: Response;
  try {
    response = await fetch(input.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` }, body: JSON.stringify({ model: input.model, messages: input.messages, temperature: 0.2, max_tokens: input.maxTokens }), signal: AbortSignal.timeout(input.timeoutMs) });
  } catch {
    await input.context.modelBudget?.afterCall({ callId: input.callId, outcome: "unknown" });
    throw new EngineError("INFERENCE_OUTCOME_UNKNOWN", "A 0G model step disconnected. Its usage may be billable; the agent will not repeat it automatically.", 504);
  }
  if (!response.ok) {
    await input.context.modelBudget?.afterCall({ callId: input.callId, outcome: "unknown", requestId: response.headers.get("x-request-id") ?? undefined });
    throw new EngineError("INFERENCE_REJECTED", `0G returned HTTP ${response.status}. The agent did not authorize a trade.`, 502);
  }
  let body: { id?: string; choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  try { body = await response.json(); }
  catch {
    await input.context.modelBudget?.afterCall({ callId: input.callId, outcome: "unknown", requestId: response.headers.get("x-request-id") ?? undefined });
    throw new EngineError("INFERENCE_OUTCOME_UNKNOWN", "The 0G response could not be recovered. Reconcile usage before retrying this step.", 502);
  }
  const requestId = response.headers.get("x-request-id") ?? (typeof body.id === "string" ? body.id : undefined) ?? response.headers.get("zg-request-id") ?? undefined;
  const usage = usageValues(body.usage);
  const evidence = { callId: input.callId, requestId, usage, receivedAt: Date.now() };
  await input.context.modelBudget?.afterCall({ callId: input.callId, outcome: "completed", requestId, usage });
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim() || content.length > 32_000) throw new EngineError("INVALID_MODEL_OUTPUT", "0G returned no bounded, usable agent response. No trade was authorized.", 502);
  return { content, evidence };
}
