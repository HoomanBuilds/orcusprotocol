import { createHash } from "node:crypto";
import type { AgentRequest, ChatMessage } from "@orcus/core";
import { tradeRequestSchema, agentModelIdSchema } from "@orcus/core";
import { z } from "zod";
import { readAgentRunStatus } from "./agent-runtime";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredAgentRequest, StoredMessage } from "./types";
import { safeAgentToolSteps } from "./agent-evidence";

export const agentRequestSchema = z.object({ modelId: agentModelIdSchema.optional(), requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/), message: z.string().trim().min(1).max(10_000), accountId: z.string().min(1).max(100).optional(), autonomous: z.boolean().default(false) }).strict();
export type AgentRequestInput = z.infer<typeof agentRequestSchema>;
export const chatRequestReference = (userId: string, requestId: string) => createHash("sha256").update(`${userId}|chat|${requestId}`).digest("hex");
export const chatRequestFingerprint = (input: { message: string; accountId?: string; autonomous?: boolean; modelId?: string }) => createHash("sha256").update(JSON.stringify({ ...(input.modelId ? { modelId: input.modelId } : {}), message: input.message, accountId: input.accountId ?? null, autonomous: input.autonomous ?? false })).digest("hex");
export const agentRequestRecordId = (userId: string, requestId: string) => `agent-request:${userId}:${createHash("sha256").update(requestId).digest("hex")}`;
export const agentRequestLease = (recordId: string) => `agent-request-work:${recordId}`;

export function storedAgentRequest(store: Store, userId: string, requestId: string) {
  return store.get<StoredAgentRequest>(userId, "agent-request", agentRequestRecordId(userId, requestId));
}

export function agentRequestView(store: Store, request: StoredAgentRequest): AgentRequest {
  const run = readAgentRunStatus(store, request.userId, request.runId);
  const message = store.get<StoredMessage>(request.userId, "message", `${request.runId}:assistant`);
  const cached = message ? undefined : store.get<{ result?: Record<string, unknown>; updatedAt: number }>(request.userId, "proposal", `proposal:${request.userId}:${request.runId}`);
  const proposed = tradeRequestSchema.safeParse(cached?.result?.proposal);
  const automation = cached?.result?.automationProposal as { kind?: unknown; accountId?: unknown } | undefined;
  const response: ChatMessage | undefined = message ? {
    id: message.id, role: message.role, content: message.content, createdAt: message.createdAt,
    modelId: message.modelId, requestId: message.requestId, proposedAction: message.proposedAction, automationProposal: message.automationProposal,
    automationId: message.automationId, actionId: message.actionId, privacy: message.privacy, privacyEvidence: message.privacyEvidence, toolSteps: message.toolSteps,
  } : typeof cached?.result?.message === "string" && cached.result.message.length <= 20_000 ? {
    modelId: typeof cached.result.modelId === "string" && cached.result.modelId === request.modelId ? cached.result.modelId : undefined, id: `${request.runId}:assistant`, role: "assistant", content: cached.result.message, createdAt: cached.updatedAt,
    requestId: typeof cached.result.requestId === "string" && cached.result.requestId.length <= 200 ? cached.result.requestId : undefined,
    proposedAction: proposed.success && request.accountBindings.some(account => account.id === proposed.data.accountId) ? proposed.data : undefined,
    automationProposal: automation && ["trade", "alert"].includes(String(automation.kind)) && request.accountBindings.some(account => account.id === automation.accountId) && JSON.stringify(automation).length <= 20_000 ? automation : undefined,
    toolSteps: safeAgentToolSteps(cached.result.toolTrace),
  } : undefined;
  const stage = request.status === "queued" ? "waiting-for-worker" : request.status === "running" ? run?.stage ?? "starting" : request.status;
  return {
    id: request.requestId, requestId: request.requestId, runId: request.runId, userMessageId: request.userMessageId,
    modelId: request.modelId, message: request.message, accountId: request.accountId, autonomous: request.autonomous, status: request.status,
    stage, tool: request.status === "running" ? run?.tool : undefined,
    modelCalls: run?.modelCalls ?? 0, toolCalls: run?.toolCalls ?? 0,
    createdAt: request.createdAt, updatedAt: Math.max(request.updatedAt, run?.updatedAt ?? 0), expiresAt: request.expiresAt,
    startedAt: request.startedAt, heartbeatAt: request.heartbeatAt, completedAt: request.completedAt,
    response, actionId: response?.actionId, errorCode: request.errorCode, error: request.error,
  };
}

export function listAgentRequests(store: Store, userId: string) {
  const rows = store.db.prepare("SELECT body FROM records WHERE user_id=? AND kind='agent-request' ORDER BY json_extract(body,'$.status') IN ('queued','running') DESC,created_at DESC LIMIT 50").all(userId) as { body: string }[];
  return rows.map(row => agentRequestView(store, JSON.parse(row.body) as StoredAgentRequest));
}

export function readAgentRequest(store: Store, userId: string, requestId: string) {
  const request = storedAgentRequest(store, userId, requestId);
  if (!request) throw new ApiError("AGENT_REQUEST_NOT_FOUND", "This agent request is not available for the signed-in wallet.", 404);
  return agentRequestView(store, request);
}

export function recoverInterruptedAgentRequests(store: Store) {
  const rows = store.db.prepare("SELECT r.body FROM records r LEFT JOIN leases l ON l.scope='agent-request-work:'||r.id WHERE r.kind='agent-request' AND json_extract(r.body,'$.status')='running' AND (l.scope IS NULL OR l.expires_at<=? OR l.holder<>json_extract(r.body,'$.claimedBy')) ORDER BY r.updated_at,r.id LIMIT 25").all(Date.now()) as { body: string }[];
  for (const row of rows) {
    const request = JSON.parse(row.body) as StoredAgentRequest;
    const response = agentRequestView(store, request).response;
    if (response && !store.get(request.userId, "message", response.id)) store.put("message", { ...response, userId: request.userId, updatedAt: Date.now() } satisfies StoredMessage);
    store.update<StoredAgentRequest>(request.userId, "agent-request", request.id, { status: "interrupted", completedAt: Date.now(), errorCode: "AGENT_REQUEST_INTERRUPTED", error: "The worker stopped before this request was finalized. Review its saved answer, activity and billing before starting new work. No inference or trade was retried." });
  }
  return rows.length;
}

export function queuedAgentRequests(store: Store) {
  return (store.db.prepare("SELECT body FROM records WHERE kind='agent-request' AND json_extract(body,'$.status')='queued' ORDER BY created_at,rowid LIMIT 25").all() as { body: string }[]).map(row => JSON.parse(row.body) as StoredAgentRequest);
}

export function safeAgentRequestError(error: unknown) {
  const code = error instanceof ApiError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "AGENT_REQUEST_FAILED";
  const messages: Record<string, string> = {
    AGENT_REQUEST_CHANGED: "Owner controls, account permissions or privacy settings changed after this request was accepted. No further action was authorized.",
    AGENT_REQUEST_EXPIRED: "This queued instruction expired before the worker started it. No inference or trade was submitted.",
    INSUFFICIENT_BUDGET: "The agent expense allowance is too low. Review the operating budget; this request will not retry itself.",
    INSUFFICIENT_SERVICE_CREDITS: "Verified test service credits are too low. Review the separate service-credit balance.",
    OPERATOR_COMPUTE_USER_CAP: "The operator's user compute ceiling is exhausted or held by unresolved calls.",
    OPERATOR_COMPUTE_PROJECT_CAP: "The shared operator compute ceiling is exhausted or held by unresolved calls.",
    INFERENCE_OUTCOME_UNKNOWN: "The model call disconnected and may be billable. Review billing; it will not be repeated automatically.",
    INFERENCE_REJECTED: "The provider could not complete the model request. Unverified billing remains reserved; no inference was retried.",
    EVALUATION_PENDING: "This request has unresolved inference evidence. Review its saved result and billing; no paid call was repeated.",
    PRIVATE_INFERENCE_UNVERIFIED: "The required private inference assurance is unavailable. No weaker inference path was substituted.",
    AGENT_NOT_AUTHORIZED: "The account has no current matching agent authorization. Review its permissions before new work.",
  };
  return { errorCode: code, error: messages[code] ?? "This request stopped before completion. Review its saved answer, activity and billing; no automatic retry was scheduled." };
}
