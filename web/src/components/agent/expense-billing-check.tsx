"use client";

import { useEffect, useRef, useState } from "react";
import { InlineError, Spinner } from "../trading/primitives";
import { ExpenseBillingRequest, initialExpenseBillingState, requestExpenseBilling } from "./expense-billing";

export function ExpenseBillingCheck({ owner, expenseId, status, onRefresh }: { owner: string; expenseId: string; status: string; onRefresh: () => Promise<unknown> }) {
  const ownerKey = owner.toLowerCase(), request = useRef(new ExpenseBillingRequest(owner));
  const [state, setState] = useState(initialExpenseBillingState);
  request.current.changeOwner(owner);
  useEffect(() => {
    request.current.activate(); setState(initialExpenseBillingState);
    return () => request.current.stop();
  }, [ownerKey, expenseId]);
  if (status !== "unknown" && !state.notice && !state.error) return null;
  return <div>
    {status === "unknown" && <><p className="fine-print">Read-only billing check. It does not retry inference, transfer funds or top up compute.</p><button className="button secondary small" type="button" disabled={state.pending} onClick={() => void request.current.run(expenseId, () => requestExpenseBilling(expenseId), setState, onRefresh)}>{state.pending && <Spinner />}{state.pending ? "Checking provider billing..." : "Check provider billing"}</button></>}
    {state.notice && <p className="fine-print" role="status">{state.notice}</p>}
    <InlineError message={state.error} />
  </div>;
}
