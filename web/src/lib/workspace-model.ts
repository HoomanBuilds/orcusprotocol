import type { ActionRecord, ChatMessage, OperatingBudget, Portfolio, TradingAccount } from "@orcus/core";
import type { ServicePaymentQuote } from "@orcus/wallets/service-payment";

export interface AgentRequestSummary {
  id: string;
  requestId: string;
  runId: string;
  message: string;
  accountId?: string;
  autonomous: boolean;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  stage?: string;
  tool?: string;
  modelCalls?: number;
  toolCalls?: number;
  createdAt: number;
  updatedAt?: number;
  response?: ChatMessage;
  actionId?: string;
  errorCode?: string;
  error?: string;
}

export interface PaymentSnapshot {
  configured: boolean;
  message: string;
  credits: { paidUsd: string; spentUsd: string; reservedUsd: string; releasedUsd: string; remainingUsd: string; refundedUsd: string };
  intents: Array<ServicePaymentQuote & { transactionHash?: string; amountUsd: string; createdAt: number }>;
}

export interface FundingSnapshot {
  status: string;
  intents: Array<{ id: string; status: string; amountWei: string; createdAt: number; transactionHash?: string; creditObservedAt?: number; reason?: string }>;
}

export interface TradingDeposit {
  accountId: string;
  status: "unknown" | "confirmed" | "reverted";
  transactionHash?: string;
}

export const pendingActionStatuses = new Set(["prepared", "awaiting-approval", "submitting", "submitted-unknown", "pending", "partially-filled"]);

export function actionReviewIssue(action: ActionRecord, userId: string | undefined, accounts: TradingAccount[], now = Date.now()): string | null {
  if (!userId || action.userId !== userId) return "Sign in as this action's owner before reviewing it.";
  if (!["prepared", "awaiting-approval"].includes(action.status)) return "This action was already submitted or closed. Check its existing record instead of submitting it again.";
  if (!action.prepared || action.prepared.expiresAt <= now) return "The saved quote expired or is unavailable. Prepare a fresh quote on Trade; nothing has been resubmitted.";
  const account = accounts.find(item => item.id === action.accountId);
  if (!account || account.userId !== userId || account.controlRevision !== action.prepared.controlRevision || account.ownerAddress.toLowerCase() !== action.prepared.account.ownerAddress.toLowerCase() || action.prepared.account.id !== action.accountId || action.prepared.request.accountId !== action.accountId || action.prepared.request.venue !== account.venue || action.request.venue !== account.venue) return "The account or its authorization changed. Refresh and prepare a new review on Trade.";
  return null;
}

export function portfolioSummary(portfolio: Portfolio, connected: boolean, unavailable = false) {
  const observed = connected && portfolio.observedAt > 0;
  const complete = observed && !unavailable && !portfolio.errors?.length;
  const parsed = (value?: string) => value !== undefined && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const finiteSum = (values: number[]) => { const sum = values.reduce((total, value) => total + value, 0); return complete && values.every(Number.isFinite) && Number.isFinite(sum) ? sum : undefined; };
  const pnl = finiteSum(portfolio.positions.map(position => parsed(position.unrealizedPnl)));
  const exposure = finiteSum(portfolio.positions.map(position => Math.abs(parsed(position.size) * parsed(position.markPrice))));
  const equity = complete && Number.isFinite(parsed(portfolio.totalEquityUsd)) ? portfolio.totalEquityUsd : undefined;
  return { observed, complete, pnl, exposure, equity };
}

export function activityTime(value: number) {
  if (!Number.isFinite(value) || value <= 0 || Number.isNaN(new Date(value).getTime())) return "Time unavailable";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export interface ActivityEntry {
  id: string;
  kind: "trade" | "agent" | "funding" | "expense";
  title: string;
  description: string;
  status: string;
  initiator: string;
  createdAt: number;
  pending: boolean;
  action?: ActionRecord;
  request?: AgentRequestSummary;
  payment?: PaymentSnapshot["intents"][number];
  funding?: FundingSnapshot["intents"][number];
  expense?: NonNullable<OperatingBudget["expenses"]>[number];
  nativeExpense?: NonNullable<OperatingBudget["nativeExpenses"]>[number];
  deposit?: TradingDeposit;
}

export function activityEntries(input: { actions: ActionRecord[]; requests: AgentRequestSummary[]; budget: OperatingBudget | null; payments: PaymentSnapshot | null; funding: FundingSnapshot | null; deposits?: TradingDeposit[] }): ActivityEntry[] {
  const actions = input.actions.map(action => ({ id: `action:${action.id}`, kind: "trade" as const, title: `${action.request.side === "buy" ? "Buy" : "Sell"} ${action.request.symbol}`, description: `${action.request.type} / ${action.request.venue === "uniswap" ? "Uniswap Sepolia" : "Hyperliquid testnet"}`, status: action.status, initiator: action.initiator, createdAt: action.createdAt, pending: pendingActionStatuses.has(action.status), action }));
  const requests = input.requests.map(request => ({ id: `request:${request.id}`, kind: "agent" as const, title: "Agent instruction", description: request.message, status: request.status, initiator: "owner", createdAt: request.createdAt, pending: request.status === "queued" || request.status === "running", request }));
  const payments = (input.payments?.intents ?? []).map(payment => ({ id: `payment:${payment.id}`, kind: "funding" as const, title: "Testnet service payment", description: "Sepolia USDC / test-only service credits", status: payment.status, initiator: "owner", createdAt: payment.createdAt, pending: ["prepared", "awaiting-wallet", "submitted"].includes(payment.status), payment }));
  const funding = (input.funding?.intents ?? []).map(item => ({ id: `funding:${item.id}`, kind: "funding" as const, title: "Native compute deposit", description: "Galileo 0G / separate from trading capital", status: item.status === "confirmed" && !item.creditObservedAt ? "awaiting-provider-sync" : item.status, initiator: "agent", createdAt: item.createdAt, pending: ["prepared", "submitting", "submitted-unknown"].includes(item.status) || (item.status === "confirmed" && !item.creditObservedAt), funding: item }));
  const expenses = (input.budget?.expenses ?? []).map(expense => ({ id: `expense:${expense.id}`, kind: "expense" as const, title: "Compute operating expense", description: expense.reference, status: expense.status, initiator: "agent", createdAt: expense.created_at, pending: !["settled", "released"].includes(expense.status), expense }));
  const nativeExpenses = (input.budget?.nativeExpenses ?? []).map(expense => ({ id: `storage:${expense.id}`, kind: "expense" as const, title: "Encrypted memory backup cost", description: "Native Galileo gas and storage fees", status: expense.status, initiator: "agent", createdAt: 0, pending: expense.status === "submitted-unknown", nativeExpense: expense }));
  const deposits = (input.deposits ?? []).map(deposit => ({ id: `deposit:${deposit.accountId}`, kind: "funding" as const, title: "Trading-account deposit", description: "Saved in this browser / check the existing transfer", status: deposit.status, initiator: "owner", createdAt: 0, pending: deposit.status === "unknown", deposit }));
  return [...actions, ...requests, ...payments, ...funding, ...expenses, ...nativeExpenses, ...deposits].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function filterActivity(entries: ActivityEntry[], filter: { kind?: string; status?: string; initiator?: string; query?: string }) {
  const query = (filter.query ?? "").trim().toLowerCase();
  return entries.filter(entry => (!filter.kind || filter.kind === "all" || entry.kind === filter.kind) && (!filter.status || filter.status === "all" || (filter.status === "pending" ? entry.pending : entry.status === filter.status)) && (!filter.initiator || filter.initiator === "all" || entry.initiator === filter.initiator) && (!query || [entry.id, entry.title, entry.description, entry.status, entry.action?.transactionHash, entry.action?.orderId, entry.request?.runId].some(value => value?.toLowerCase().includes(query))));
}
