import { EngineError } from "../errors";
import type { AgentContext, AgentMessage, ModelEvidence, ModelUsage } from "./types";
import { computePriceCeilings } from "./pricing";
import type { createPrivateInferenceSession } from "./privacy";

function usageValues(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const result: ModelUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) if (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0) result[key] = input[key];
  return Object.keys(result).length ? result : undefined;
}

function boundedRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value) ? value : undefined;
}

async function errorEvidence(response: Response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 65_536) { await reader.cancel(); return {}; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    return { requestId: boundedRequestId(body?.x_0g_trace?.request_id) ?? boundedRequestId(body?.request_id), billing: body?.x_0g_trace?.billing };
  } catch { return {}; }
  finally { reader.releaseLock(); }
}

export async function invoke0G(input: { url: string; apiKey: string; model: string; messages: Array<AgentMessage | { role: "system"; content: string }>; callId: string; maxTokens: number; timeoutMs: number; context: AgentContext; privateSession?: Awaited<ReturnType<typeof createPrivateInferenceSession>> }): Promise<{ content: string; evidence: ModelEvidence }> {
  const origin = new URL(input.url).origin;
  const keyId = process.env.ZEROG_COMPUTE_API_KEY_ID?.trim();
  const billingApiKeyId = keyId && /^[A-Za-z0-9_-]{1,200}$/.test(keyId) && !/^(?:sk|mk|pk)[-_]/i.test(keyId) && keyId !== input.apiKey ? keyId : undefined;
  const billingContext = { model: input.model, billingApiKeyId, billingOrigin: ["https://router-api.0g.ai", "https://router-api-testnet.integratenetwork.work"].includes(origin) ? origin : undefined };
  let ceilings: Record<string, string>;
  try { ceilings = computePriceCeilings(input.context.modelBudget?.maxCostUsd, input.messages, input.maxTokens); }
  catch (error) { await input.context.modelBudget?.afterCall({ ...billingContext, callId: input.callId, outcome: "rejected" }); throw error; }
  let response: Response;
  try {
    const body = { model: input.model, messages: input.messages, temperature: 0.2, max_tokens: input.maxTokens, ...(/^0gm-/.test(input.model) ? { chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } } : {}) };
    response = input.privateSession ? await input.privateSession.request({ apiKey: input.apiKey, body, timeoutMs: input.timeoutMs, priceCeilings: ceilings["X-0G-Provider-Max-Price-Usd-Prompt"] === undefined ? undefined : { prompt: ceilings["X-0G-Provider-Max-Price-Usd-Prompt"], completion: ceilings["X-0G-Provider-Max-Price-Usd-Completion"] } }) : await fetch(input.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}`, ...ceilings }, body: JSON.stringify(body), signal: AbortSignal.timeout(input.timeoutMs), redirect: "error" });
  } catch {
    await input.context.modelBudget?.afterCall({ ...billingContext, callId: input.callId, outcome: "unknown" });
    throw new EngineError("INFERENCE_OUTCOME_UNKNOWN", "A 0G model step disconnected. Its usage may be billable; the agent will not repeat it automatically.", 504);
  }
  if (!response.ok) {
    const error = await errorEvidence(response);
    await input.context.modelBudget?.afterCall({ ...billingContext, ...error, callId: input.callId, outcome: [400, 401, 402, 403, 404, 429].includes(response.status) ? "rejected" : "unknown", requestId: error.requestId ?? boundedRequestId(response.headers.get("x-request-id")) });
    throw new EngineError("INFERENCE_REJECTED", `0G returned HTTP ${response.status}. The agent did not authorize a trade.`, 502);
  }
  let body: { id?: string; choices?: Array<{ message?: { content?: string } }>; usage?: unknown; x_0g_trace?: { request_id?: unknown; provider?: unknown; billing?: unknown } };
  try { body = await response.json(); }
  catch {
    await input.context.modelBudget?.afterCall({ ...billingContext, callId: input.callId, outcome: "unknown", requestId: boundedRequestId(response.headers.get("x-request-id")) });
    throw new EngineError("INFERENCE_OUTCOME_UNKNOWN", "The 0G response could not be recovered. Reconcile usage before retrying this step.", 502);
  }
  const trace = body.x_0g_trace;
  const requestId = (typeof trace?.request_id === "string" && trace.request_id.trim() ? trace.request_id : undefined) ?? response.headers.get("x-request-id") ?? (typeof body.id === "string" ? body.id : undefined) ?? response.headers.get("zg-request-id") ?? undefined;
  const usage = usageValues(body.usage);
  const evidence = { callId: input.callId, requestId, responseId: body.id, providerAddress: typeof trace?.provider === "string" ? trace.provider : undefined, usage, billing: trace?.billing, receivedAt: Date.now() };
  await input.context.modelBudget?.afterCall({ ...billingContext, callId: input.callId, outcome: "completed", requestId, usage, billing: trace?.billing });
  const privacy = input.privateSession?.evidence(response.headers, body);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim() || content.length > 32_000) throw new EngineError("INVALID_MODEL_OUTPUT", "0G returned no bounded, usable agent response. No trade was authorized.", 502);
  return { content, evidence: { ...evidence, privacy } };
}
