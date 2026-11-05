import type { TradeRequest } from "@orcus/core";
import type { PlannerContext } from "../types";
import type { AutomationProposal } from "./automation";

export interface ModelUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface ModelEvidence { callId: string; requestId?: string; usage?: ModelUsage; receivedAt: number }
export interface AgentMemoryNote { id: string; kind: string; content: string; importance: number; source: string; createdAt: number; updatedAt: number; lastAccessedAt?: number }
export interface MemoryStore {
  search(query: string, limit?: number): Promise<AgentMemoryNote[]>;
  remember(input: { content: string; kind?: "note" | "preference"; importance?: number }): Promise<AgentMemoryNote>;
  forget(id: string): Promise<boolean>;
}
export interface ToolTrace { name: string; arguments: unknown; result: unknown; ok: boolean; observedAt: number; requestId?: string }
export interface AgentMessage { role: "user" | "assistant"; content: string }
export interface AgentCheckpoint {
  version: 1;
  threadId: string;
  runId: string;
  messageDigest: string;
  status: "running" | "completed" | "failed";
  modelCalls: number;
  toolCalls: number;
  tokenCount: number;
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
  threadId?: string;
  runId?: string;
  evaluationId?: string;
  checkpoints?: { load(threadId: string): Promise<unknown | null>; save(threadId: string, state: unknown): Promise<void> };
  memoryStore?: MemoryStore;
  modelBudget?: {
    beforeCall(input: { callId: string; maxTokens: number }): Promise<void>;
    afterCall(input: { callId: string; outcome: "completed" | "rejected" | "unknown"; requestId?: string; usage?: ModelUsage }): Promise<void>;
  };
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  timeoutMs?: number;
  onProgress?(event: { stage: "recall" | "thinking" | "tool" | "completed" | "failed" | "budget-stop"; tool?: string; message?: string; modelCalls?: number; toolCalls?: number }): Promise<void>;
}
export interface PlannerReply {
  message: string;
  proposal?: TradeRequest;
  automationProposal?: AutomationProposal;
  requestId?: string;
  requestIds: string[];
  usage?: ModelUsage;
  requiresClarification?: boolean;
  privacy: "unverified";
  provider: "0G";
  evidenceStatus: "recorded" | "missing-request-id";
  framework: "langgraph";
  toolTrace: ToolTrace[];
  modelCalls: number;
  memory: { recalled: number; checkpointed: boolean; threadId?: string };
}
