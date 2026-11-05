import type { ActionRecord, AgentPermission, AgentProfile, Automation, ChatMessage, PreparedAction, TradingAccount } from "@orcus/core";
import type { KernelGrantPolicy } from "@orcus/wallets/kernel";
export type Document = Record<string, unknown>;
export type StoredAgent = AgentProfile & { controlRevision: number; privateInferenceRequired: boolean; createdAt: number; updatedAt: number };
export type StoredAccount = TradingAccount & { label: string; createdAt: number; updatedAt: number };
export type StoredPermission = AgentPermission & { userId: string; controlRevision: number; authorization?: unknown; policy?: KernelGrantPolicy; createdAt: number; updatedAt: number };
export type StoredAction = ActionRecord & { controlRevision: number; agentRevision: number; prepared: PreparedAction; expiresAt: number; evidence?: unknown; userOperationHash?: string; automationId?:string;automationPolicyVersion?:number;evaluationExpiresAt?:number };
export type StoredAutomation = Automation & { kind?:"trade"|"alert";conditionActive?:boolean;controlRevision: number; expiresAt: number; condition?: { symbol: string; operator: "above" | "below"; price: string }; updatedAt: number; error?: string };
export type StoredMessage = ChatMessage & { userId: string; updatedAt: number };
export interface StoredRecord { id: string; userId: string; createdAt: number; updatedAt: number; accountId?: string }
