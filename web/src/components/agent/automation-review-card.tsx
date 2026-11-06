"use client";

import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError } from "@/lib/api";
import { executionLabel, reviewAutomation, triggerLabel, type ReviewedAutomation } from "@/lib/automation-review";
import { usd } from "@/lib/format";
import { actionReviewLabel } from "@/lib/trade-ux";
import { Address, Badge, InlineError, Spinner } from "../trading/primitives";

export function AutomationPolicySummary({ draft, accountLabel }: { draft: ReviewedAutomation; accountLabel?: string }) {
  const request = draft.request;
  const [base, quote = "USDC"] = request?.symbol.split("/") ?? [];
  const amountUnit = request?.amountUnit === "collateral-usdc" ? "USDC collateral" : request?.nativeInput ? "ETH" : request?.venue === "uniswap" && request.side === "buy" ? quote : base;
  return <dl className="automation-policy-summary">
    <div><dt>When</dt><dd>{triggerLabel(draft)}</dd></div>
    <div><dt>Then</dt><dd>{request ? `${actionReviewLabel(request)} / ${request.type} / ${request.symbol}` : "Notify you in Orcus, no trade"}</dd></div>
    {request && request.type !== "cancel" && <div><dt>Exact amount</dt><dd>{request.amount} {amountUnit}</dd></div>}
    {request?.price !== undefined && <div><dt>Order price</dt><dd>{request.price} {quote}</dd></div>}
    {request?.triggerPrice !== undefined && <div><dt>Trigger price</dt><dd>{request.triggerPrice} {quote}</dd></div>}
    {request?.takeProfit !== undefined && <div><dt>Take-profit</dt><dd>{request.takeProfit === "0" ? "Clear protection" : `${request.takeProfit} ${quote}`}</dd></div>}
    {request?.stopLoss !== undefined && <div><dt>Stop-loss</dt><dd>{request.stopLoss === "0" ? "Clear protection" : `${request.stopLoss} ${quote}`}</dd></div>}
    {request?.positionId && <div><dt>Position</dt><dd>{request.positionId}</dd></div>}
    {request?.orderId && <div><dt>Order</dt><dd>{request.orderId}</dd></div>}
    {request?.reduceOnly && <div><dt>Restriction</dt><dd>Reduce only</dd></div>}
    {request?.isDayTrade !== undefined && <div><dt>Position mode</dt><dd>{request.isDayTrade ? "Day trade" : "Swing trade"}</dd></div>}
    <div><dt>Frequency</dt><dd>{executionLabel(draft.executionMode, draft.kind)} / up to {draft.maxExecutions} {draft.kind === "alert" ? "notifications" : "submissions"}</dd></div>
    <div><dt>Evaluation</dt><dd>Every {draft.intervalSeconds / 60} minutes</dd></div>
    {accountLabel && <div><dt>Account</dt><dd>{accountLabel}</dd></div>}
    {draft.request && <div><dt>Slippage cap</dt><dd>{draft.request.slippageBps / 100}% per submission{draft.request.leverage ? ` / ${draft.request.leverage}x leverage` : ""}</dd></div>}
    {draft.expiresAt && <div><dt>Expires</dt><dd>{new Date(draft.expiresAt).toLocaleString()}</dd></div>}
  </dl>;
}

export function AutomationSuggestion({ proposal, messageId, automationId, workspace: w }: { proposal: unknown; messageId: string; automationId?: string; workspace: Workspace }) {
  const [busy, setBusy] = useState(false), [created, setCreated] = useState(false), [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  const owner = w.session.user?.id, ownerRef = useRef(owner); ownerRef.current = owner;
  useEffect(() => { mounted.current = true; ownerRef.current = owner; return () => { mounted.current = false; ownerRef.current = undefined; }; }, [owner]);
  const accepted = created || !!automationId;
  let draft: ReviewedAutomation | undefined, issue: string | undefined;
  try { draft = reviewAutomation(proposal, w.session.accounts, accepted ? 0 : Date.now()); } catch (cause) { issue = displayError(cause); }
  const account = w.session.accounts.find(item => item.id === draft?.accountId);
  const saved = w.automations.find(item => item.id === automationId);
  const grant = w.agentData?.permissions.find(item => item.accountId === account?.id && item.status === "active" && item.expiresAt > Date.now());
  async function accept() {
    if (!draft || !reviewed || inFlight.current || accepted || !w.session.user) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      reviewAutomation(proposal, w.session.accounts);
      await api("/api/automations", { method: "POST", headers: { "Idempotency-Key": `chat-automation:${messageId}` }, body: JSON.stringify(proposal) });
      if (!mounted.current || ownerRef.current !== owner) return;
      setCreated(true); await w.refresh();
    } catch (cause) { if (mounted.current && ownerRef.current === owner) setError(displayError(cause)); }
    finally { inFlight.current = false; if (mounted.current && ownerRef.current === owner) setBusy(false); }
  }
  return <section className="automation-approval-card" aria-label="Review automation proposal">
    <div className="approval-card-heading"><Badge>{draft?.kind === "alert" ? "Read-only alert" : accepted ? "Reviewed policy" : "Requires approval"}</Badge><span>{accepted ? saved?.status ?? "Created" : "Not active yet"}</span></div>
    <h3>{draft?.name ?? "Incomplete automation draft"}</h3>
    {draft && <><AutomationPolicySummary draft={draft} accountLabel={account?.venue}/><Address value={account?.address}/>
      {draft.executionMode === "on-crossing" && <p className="fine-print">The first observation only arms the trigger. It runs after a later false-to-true crossing.</p>}
      {draft.kind === "alert" && draft.executionMode === "recurring" && <p className="fine-print">Notifies on the first match, then waits for a false observation before it can notify again.</p>}
      {draft.kind === "trade" && <p className="fine-print">{grant ? `Current grant cap: ${usd(grant.maxTradeUsd)} per trade.` : "An active trading grant is required."} Operating allowance: {usd(w.budget?.availableUsd)}. Actual fees and permissions are checked before each submission.</p>}
      {!accepted && <label className="checkbox approval-acknowledgement"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}/>I approve this exact action, condition and run limit.</label>}
    </>}
    <InlineError message={accepted ? null : issue ?? error}/>
    {!accepted && !w.health?.cre.ready && <p className="fine-print">The workflow runner must be available before activation.</p>}
    {automationId ? <a className="button secondary small full" href={`/automations#${encodeURIComponent(automationId)}`}>View saved automation</a> : <button className="button primary small full" type="button" disabled={!draft || !reviewed || busy || accepted || !owner || !w.health?.cre.ready || draft.kind === "trade" && !grant} onClick={() => void accept()}>{busy && <Spinner/>}{accepted ? "Automation created" : busy ? "Activating..." : "Approve and activate"}</button>}
  </section>;
}
