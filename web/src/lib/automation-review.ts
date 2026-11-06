import { automationInputSchema, type AutomationInput, type TradingAccount } from "@orcus/core";

export type ExecutionMode = "once" | "recurring" | "on-crossing";
export type ReviewedAutomation = AutomationInput;

export function reviewAutomation(value: unknown, accounts: TradingAccount[], now = Date.now()): ReviewedAutomation {
  if (!value || typeof value !== "object") throw new Error("This draft is incomplete. Ask the agent for an explicit action, trigger and run limit.");
  const input = value as Partial<ReviewedAutomation>;
  if (!input.executionMode || input.maxExecutions === undefined) throw new Error("This draft needs an explicit execution mode and finite run limit before approval.");
  const draft = automationInputSchema.parse(value);
  const account = accounts.find(item => item.id === draft.accountId);
  if (!account) throw new Error("This proposal does not belong to a connected account.");
  if (!draft.name.trim()) throw new Error("Give this automation a name.");
  if (draft.expiresAt !== undefined && (!Number.isSafeInteger(draft.expiresAt) || draft.expiresAt <= now)) throw new Error("This proposal expired. Ask for a fresh draft.");
  const request = draft.request;
  if (request && (request.accountId !== account.id || request.venue !== account.venue)) throw new Error("The action and selected account do not match.");
  return draft;
}

export function executionLabel(mode?: string) {
  return mode === "once" ? "Run once" : mode === "recurring" ? "Repeat at each interval" : mode === "on-crossing" ? "On each new crossing" : "Policy review required";
}

export function triggerLabel(draft: Pick<ReviewedAutomation, "condition" | "executionMode">) {
  if (!draft.condition) return "Scheduled execution, no price condition";
  return `${draft.condition.symbol} ${draft.condition.operator} ${draft.condition.price}${draft.executionMode === "on-crossing" ? " after a new crossing" : " at evaluation"}`;
}
