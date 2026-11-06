import { displayError, post } from "../../lib/api";

export type ExpenseBillingState = { pending: boolean; notice: string | null; error: string | null };
export const initialExpenseBillingState: ExpenseBillingState = { pending: false, notice: null, error: null };
export const requestExpenseBilling = (expenseId: string) => post<unknown>("/api/budget/reconcile", { expenseId });

function billingNotice(value: unknown, expenseId: string) {
  const result = value && typeof value === "object" ? value as { expenseId?: unknown; status?: unknown } : undefined;
  if (result?.expenseId !== expenseId) throw new Error("Unexpected billing identity.");
  if (result.status === "settled") return "Provider billing verified. Recorded spending and its reservation are reconciled; no inference or payment was retried.";
  if (result.status === "released") return "The recorded expense reservation is released. This is not a token refund; no inference or payment was retried.";
  if (result.status === "unknown" || result.status === "reserved") return "Provider billing is still unverified. The reservation remains held; no inference or payment was retried.";
  throw new Error("Unexpected billing status.");
}

function billingError(cause: unknown) {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (code === "COMPUTE_EXPENSE_NOT_FOUND") return "This expense is unavailable for the signed-in owner. Refresh the operating budget.";
  if (code === "COMPUTE_RECONCILIATION_BUSY") return "Another billing check is in progress. Wait for it to finish; the reservation stays held.";
  if (code === "COMPUTE_BILLING_UNAVAILABLE") return "Provider billing is unavailable. The reservation remains held; no inference or payment was retried.";
  if (code === "COMPUTE_BILLING_CONFLICT") return "Provider billing could not be matched safely. The reservation remains held for operator review.";
  if (code === "AUTH_REQUIRED") return displayError(cause);
  return "Billing could not be verified. The reservation remains held; check again later or contact the operator.";
}

export class ExpenseBillingRequest {
  private owner: string;
  private generation = {};
  private active = false;
  private locked = false;
  constructor(owner: string) { this.owner = owner.toLowerCase(); }
  changeOwner(owner: string) { if (this.owner !== owner.toLowerCase()) { this.owner = owner.toLowerCase(); this.generation = {}; this.active = false; this.locked = false; } }
  activate() { this.generation = {}; this.active = true; this.locked = false; }
  stop() { this.active = false; }

  async run(expenseId: string, request: () => Promise<unknown>, onState: (state: ExpenseBillingState) => void, onRefresh: () => Promise<unknown>) {
    if (!this.active || this.locked) return;
    const generation = this.generation, current = () => this.active && this.generation === generation;
    this.locked = true;
    let state: ExpenseBillingState = { pending: true, notice: null, error: null };
    onState(state);
    try {
      const result = await request();
      if (!current()) return;
      state = { ...state, notice: billingNotice(result, expenseId) };
      onState(state);
      try { await onRefresh(); } catch { if (current()) state = { ...state, error: "Balances could not refresh. Refresh the page to see the current recorded expense." }; }
    } catch (cause) {
      if (current()) state = { ...state, error: billingError(cause) };
    } finally {
      if (current()) { this.locked = false; onState({ ...state, pending: false }); }
    }
  }
}
