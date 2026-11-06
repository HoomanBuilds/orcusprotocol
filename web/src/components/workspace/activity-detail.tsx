"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, ArrowUpRight, Bot, Check, ChevronRight, Clock3, Copy, ExternalLink, FileText, Wallet, X } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { actionReviewIssue, activityInitiator, activityTime, type ActivityEntry } from "@/lib/workspace-model";
import { api, displayError, post } from "@/lib/api";
import { assetAmount, quotePrice, statusLabel, tokenUnits, usd } from "@/lib/format";
import { venueNetwork, venuePresentation } from "@/lib/venue-presentation";
import { actionRecovery } from "@/lib/trade-ux";
import { Field, InlineError, Spinner, Status } from "../trading/primitives";

export function ActivityEntryIcon({ entry }: { entry: ActivityEntry }) {
  const Icon = entry.kind === "agent" ? Bot : entry.kind === "funding" ? Wallet : entry.kind === "expense" ? FileText : Activity;
  return <span className={`activity-entry-icon ${entry.kind}`}><Icon size={18}/></span>;
}

function Reference({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return <div><dt>{label}</dt><dd><code>{value}</code><button className="reference-copy" type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); } }}>{copied ? <Check size={13}/> : <Copy size={13}/>}<span>{copied ? "Copied" : "Copy"}</span></button></dd></div>;
}

export function ActivityDetail({ entry, workspace: w, onClose }: { entry: ActivityEntry; workspace: Workspace; onClose: () => void }) {
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = entry.action, request = entry.request;
  const linkedRequest = action ? w.requests.find(item => item.actionId === action.id || item.response?.actionId === action.id) : undefined;
  const linkedAction = request?.actionId ? w.actions.find(item => item.id === request.actionId) : undefined;
  const account = w.session.accounts.find(item => item.id === (action?.accountId ?? request?.accountId ?? entry.allowance?.accountId ?? entry.deposit?.accountId));
  const issue = action ? actionReviewIssue(action, w.session.user?.id, w.session.accounts) : null;
  const recordId = entry.id.split(":").slice(1).join(":");
  const transactionHash = action?.transactionHash ?? entry.allowance?.transactionHash ?? entry.payment?.transactionHash ?? entry.funding?.transactionHash ?? entry.nativeExpense?.transactionHash ?? entry.deposit?.transactionHash;
  const explorer = action?.request.venue === "ostium" || entry.allowance ? "https://sepolia.arbiscan.io" : entry.funding || entry.nativeExpense ? "https://chainscan-galileo.0g.ai" : "https://sepolia.etherscan.io";
  const outcome = request?.status === "queued" ? "Waiting for worker" : request?.status === "running" ? "Instruction in progress" : request?.status === "interrupted" ? "Instruction needs review" : request?.status === "completed" ? "Instruction completed" : request?.status === "failed" ? "Instruction failed" : entry.title;
  const base = action?.request.symbol.split("/")[0] ?? "";
  const quote = action?.request.symbol.split("/")[1] ?? "USDC";

  async function recover(approvalIndex?: number) {
    if (!action || busy || !/^0x[\da-f]{64}$/i.test(hash)) return;
    setBusy(true); setError(null);
    try { await post("/api/actions/submit", { actionId: action.id, transactionHash: hash, ...(approvalIndex !== undefined ? { approvalIndex } : {}) }); await w.refresh(); setHash(""); }
    catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  }

  return <aside className="workspace-panel activity-detail" aria-label="Activity details">
    <div className="activity-detail-top"><span className="panel-kicker">{request ? "AGENT INSTRUCTION" : "ACTIVITY DETAILS"}</span><button className="icon-button" type="button" onClick={onClose} aria-label="Close activity details"><X size={18}/></button></div>
    <h2>{outcome}</h2>{!request && <Status value={entry.status}/>}
    <p className="activity-detail-description">{entry.description}</p>
    <dl className="activity-facts"><div><dt>Recorded</dt><dd>{activityTime(entry.createdAt)}</dd></div><div><dt>Initiated by</dt><dd>{activityInitiator(entry.initiator)}</dd></div>{account && <div><dt>Venue</dt><dd>{venuePresentation[account.venue].name} / {venueNetwork(account.venue)}</dd></div>}</dl>
    {action && <>
      <div className="activity-detail-section"><dl className="activity-facts"><div><dt>Action</dt><dd>{statusLabel(action.request.type)} / {action.request.side}</dd></div><div><dt>{action.request.amountUnit === "collateral-usdc" ? "USDC collateral" : "Base amount"}</dt><dd>{assetAmount(action.request.amount, action.request.amountUnit === "collateral-usdc" ? "USDC" : base)}</dd></div>{action.request.price && <div><dt>Reviewed price</dt><dd>{quotePrice(action.request.price, quote)}</dd></div>}{action.request.triggerPrice !== undefined && <div><dt>Protection level</dt><dd>{quotePrice(action.request.triggerPrice, quote)}</dd></div>}</dl>{action.error && <InlineError message={action.error}/>}</div>
      {linkedRequest && <Link className="activity-related-link" href={`/activity?item=${encodeURIComponent(`request:${linkedRequest.id}`)}`}><Bot size={16}/><span>View original agent instruction</span><ChevronRight size={14}/></Link>}
      {!!action.approvals?.length && <div className="activity-detail-section"><h3>USDC approval steps</h3><p>Token approvals are separate from the native trade. A confirmed approval is not a fill.</p>{action.approvals.map(step => <div className="native-approval-step" key={step.index}><div><strong>{assetAmount(step.amountUsd, "USDC")}</strong><Status value={step.status}/></div>{step.transactionHash ? <a className="text-link" href={`https://sepolia.arbiscan.io/tx/${step.transactionHash}`} target="_blank" rel="noreferrer">View existing approval<ExternalLink size={13}/></a> : ["submitting", "submitted-unknown"].includes(step.status) && <><Field label="Existing approval transaction hash"><input aria-label={`Approval ${step.index + 1} transaction hash`} value={hash} onChange={event => setHash(event.target.value)} placeholder="0x..."/></Field><button className="button secondary small" type="button" disabled={busy || !/^0x[\da-f]{64}$/i.test(hash)} onClick={() => void recover(step.index)}>{busy ? <Spinner/> : null}Record hash &amp; check receipt</button></>}</div>)}<button className="button secondary small" type="button" disabled={w.refreshing} onClick={() => void w.refresh()}>Check recorded approval receipts</button></div>}
      {action.request.venue === "ostium" && action.status === "submitted-unknown" && !action.transactionHash && <div className="activity-recovery"><h3>Recover the existing trade</h3><p>Enter the transaction already shown in your owner wallet. This records evidence; it does not send a trade.</p><Field label="Existing native trade hash"><input value={hash} onChange={event => setHash(event.target.value)} placeholder="0x..."/></Field><button className="button secondary full" type="button" disabled={busy || !/^0x[\da-f]{64}$/i.test(hash)} onClick={() => void recover()}>{busy ? <Spinner/> : null}Record existing transaction</button></div>}
      {["prepared", "awaiting-approval"].includes(action.status) ? <div className="activity-recovery"><h3>{issue ? "New review required" : "Continue this review"}</h3><p>{issue ?? "The saved quote is still valid. Confirmation requires an explicit owner action."}</p>{!issue && <button className="button primary full" type="button" disabled={w.executing} onClick={() => w.reviewAction(action)}>Review saved action<ArrowUpRight size={15}/></button>}<Link className="text-link" href="/trade" onClick={() => w.selectMarket(action.request.venue, action.request.symbol)}>Open this market on Trade<ArrowUpRight size={14}/></Link></div> : entry.pending && <div className="activity-recovery"><p>{actionRecovery(action.status) ?? "The saved action is still resolving. Check this record before preparing another trade."}</p><button className="button secondary full" type="button" disabled={w.refreshing} onClick={() => void w.refresh()}>{w.refreshing ? <Spinner/> : <Clock3 size={16}/>}Check existing action status</button></div>}
    </>}
    {request && <>
      {request.response && <div className="activity-detail-section"><h3>Result</h3><p className="activity-instruction">{request.response.content}</p></div>}
      {request.error && <InlineError message={request.error}/>}
      {linkedAction && <Link className="activity-related-link" href={`/activity?item=${encodeURIComponent(`action:${linkedAction.id}`)}`}><Activity size={16}/><span>View linked trade outcome</span><Status value={linkedAction.status}/></Link>}
      <div className="activity-recovery"><p>{request.status === "queued" ? "Saved, not yet running. The background worker must be online." : request.status === "running" ? "The worker is processing this saved instruction." : request.status === "interrupted" ? "The previous run stopped. Review saved evidence before issuing another instruction." : "This is the saved outcome."}</p><Link className="button secondary full" href="/agent">Open conversation<ArrowUpRight size={15}/></Link></div>
    </>}
    {entry.allowance && <div className="activity-detail-section"><h3>Exact token allowance</h3><p>{assetAmount(entry.allowance.amountUsd, "USDC")} allowance request for Ostium collateral use. Status: {statusLabel(entry.allowance.status)}. This is not a transfer or a trade.</p><Link className="button secondary full" href="/settings?section=accounts">Review saved allowance controls<ArrowUpRight size={14}/></Link></div>}
    {(entry.payment || entry.funding || entry.deposit) && <div className="activity-detail-section"><h3>Funding record</h3>{entry.payment && <p>{usd(entry.payment.amountUsd)} testnet service credits, separate from trading collateral.</p>}{entry.funding && <p>{tokenUnits(entry.funding.amountWei, 18, "0G")} compute deposit. Onchain confirmation alone does not prove provider credit.</p>}{entry.deposit && <p>Saved browser transfer status. A missing hash is not confirmation.</p>}<Link className="button secondary full" href={`/settings?section=${entry.deposit ? "accounts" : "budget"}`}>Review existing funding controls<ArrowUpRight size={14}/></Link></div>}
    {(entry.expense || entry.nativeExpense) && <div className="activity-detail-section"><h3>Operating cost</h3>{entry.expense && <p>{usd(entry.expense.amountUsd)} recorded allowance cost. Reservations are not final charges.</p>}{entry.nativeExpense && <p>Gas {tokenUnits(entry.nativeExpense.gasPaidWei, 18, "0G")} / storage {tokenUnits(entry.nativeExpense.storageFeeWei, 18, "0G")}</p>}<Link className="text-link" href={`/settings?section=${entry.nativeExpense ? "agent" : "budget"}`}>Receipt controls<ArrowUpRight size={14}/></Link></div>}
    {transactionHash && /^0x[\da-f]{64}$/i.test(transactionHash) && <a className="text-link activity-receipt-link" href={`${explorer}/tx/${transactionHash}`} target="_blank" rel="noreferrer">View transaction<ExternalLink size={14}/></a>}
    <InlineError message={error}/>
    <details className="activity-technical-details"><summary>Technical details</summary><dl className="activity-facts"><Reference label={request ? "Request ID" : "Record reference"} value={recordId}/><Reference label="Run ID" value={request?.runId ?? linkedRequest?.runId}/><Reference label="Account ID" value={account?.id}/><Reference label="Transaction hash" value={transactionHash}/><Reference label="Venue order ID" value={action?.orderId}/><Reference label="Signed operation" value={action?.userOperationHash}/><Reference label="Provider request" value={action?.providerRequestId}/><Reference label="Expense reference" value={entry.expense?.reference}/><Reference label="USDC spender" value={entry.allowance?.spender}/>{request && <><div><dt>Execution preference</dt><dd>{request.autonomous ? "Within granted limits" : "Approval required"}</dd></div><div><dt>Recorded calls</dt><dd>{request.modelCalls} model / {request.toolCalls} tool</dd></div>{request.stage && <div><dt>Stage</dt><dd>{statusLabel(request.stage)}</dd></div>}</>}</dl></details>
  </aside>;
}
