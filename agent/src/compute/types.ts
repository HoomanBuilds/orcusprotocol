import type { TradeRequest } from "@orcus/core";
import type { PlannerContext } from "../types";
import type { AutomationProposal } from "./automation";
import type { AgentToolProfile } from "./tool-profiles";
import type { PrivateInferenceEvidence, PrivateVerification } from "./privacy";

export interface ModelUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface ModelEvidence { callId: string; modelId?: string; requestId?: string; responseId?: string; providerAddress?: string; usage?: ModelUsage; billing?: unknown; privacy?: PrivateInferenceEvidence; receivedAt: number }
export interface AgentMemoryNote { id: string; kind: string; content: string; importance: number; source: string; createdAt: number; updatedAt: number; lastAccessedAt?: number }
export interface MemoryStore {
  search(query: string, limit?: number): Promise<AgentMemoryNote[]>;
  remember(input: { content: string; kind?: "note" | "preference"; importance?: number }): Promise<AgentMemoryNote>;
  forget(id: string): Promise<boolean>;
}
export interface ToolTrace { observationId?: string; name: string; arguments: unknown; result: unknown; ok: boolean; observedAt: number; requestId?: string }
export interface AgentMessage { role: "user" | "assistant"; content: string }
export interface AgentCheckpoint {
  modelId?: string;
  version: 1;
  threadId: string;
  runId: string;
  messageDigest: string;
  toolProfile?: AgentToolProfile;
  privacyPolicy?: "public" | PrivateVerification;
  status: "running" | "completed" | "failed";
  modelCalls: number;
  toolCalls: number;
  tokenCount: number;
  formatErrors?: number;
  messages: AgentMessage[];
  toolTrace: ToolTrace[];
  evidence: ModelEvidence[];
  proposal?: TradeRequest;
  automationProposal?: AutomationProposal;
  summary?: string;
  reply?: PlannerReply;
  inferencePending: boolean;
  updatedAt: number;
}
export interface AgentContext extends PlannerContext {
  modelId?: string;
  privateVerification?: PrivateVerification;
  toolProfile?: AgentToolProfile;
  threadId?: string;
  runId?: string;
  evaluationId?: string;
  checkpoints?: { load(threadId: string): Promise<unknown | null>; save(threadId: string, state: unknown): Promise<void> };
  memoryStore?: MemoryStore;
  modelBudget?: {
    maxCostUsd?: string;
    beforeCall(input: { callId: string; maxTokens: number }): Promise<void>;
    afterCall(input: { callId: string; outcome: "completed" | "rejected" | "unknown"; requestId?: string; usage?: ModelUsage; billing?: unknown; billingOrigin?: string; billingApiKeyId?: string; model?: string }): Promise<void>;
  };
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  timeoutMs?: number;
  onProgress?(event: { stage: "recall" | "thinking" | "tool" | "completed" | "failed" | "budget-stop"; tool?: string; message?: string; modelCalls?: number; toolCalls?: number }): Promise<void>;
}
export interface PlannerReply {
  modelId?: string;
  message: string;
  proposal?: TradeRequest;
  automationProposal?: AutomationProposal;
  requestId?: string;
  requestIds: string[];
  usage?: ModelUsage;
  requiresClarification?: boolean;
  privacy: "unverified" | PrivateInferenceEvidence["status"];
  privacyEvidence?: PrivateInferenceEvidence;
  provider: "0G";
  evidenceStatus: "recorded" | "missing-request-id";
  framework: "langgraph";
  toolTrace: ToolTrace[];
  modelCalls: number;
  memory: { recalled: number; checkpointed: boolean; threadId?: string };
}
