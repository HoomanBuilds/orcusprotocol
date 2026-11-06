"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, ArrowUpRight, Bot, Check, ChevronRight, Clock3, ExternalLink, FileText, Search, Wallet, X } from "lucide-react";
import { useWorkspace, type Workspace } from "@/lib/use-workspace";
import { activityEntries, activityInitiator, activityTime, filterActivity } from "@/lib/workspace-model";
import { ActivityDetail, ActivityEntryIcon } from "./activity-detail";
import { actionRecovery } from "@/lib/trade-ux";
import { assetAmount, statusLabel, tokenUnits, usd } from "@/lib/format";
import { Badge, Empty, InlineError, Spinner, Status } from "../trading/primitives";


export function ActivityWorkspace() {
  const w = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const entries = w.session.user ? activityEntries({ actions: w.actions, requests: w.requests, budget: w.budget, payments: w.payments, funding: w.funding, deposits: w.tradingDeposits, allowances: w.ostiumAllowances }) : [];
  const filter = { kind: params.get("kind") ?? "all", status: params.get("status") ?? "all", initiator: params.get("initiator") ?? "all", query: params.get("q") ?? "" };
  const filtered = filterActivity(entries, filter);
  const selected = entries.find(entry => entry.id === params.get("item"));
  const pending = entries.filter(entry => entry.pending).length;
  const statuses = [...new Set(entries.map(entry => entry.status))].sort();
  const update = (key: string, value: string, replace = false) => { const next = new URLSearchParams(params); if (!value || value === "all") next.delete(key); else next.set(key, value); const href = `/activity${next.size ? `?${next}` : ""}`; if (replace) router.replace(href, { scroll: false }); else router.push(href, { scroll: false }); };
  const unavailable = ["activity", "requests", "budget", "payments", "funding", "nativeAllowances"].filter(key => w.resourceErrors[key]);
  return <div className="activity-page">
    <div className="workspace-page-header"><div><span className="workspace-eyebrow">EVERY ACTION, ONE RECORD</span><h1>Activity</h1><p>Follow instructions, approvals and actual execution outcomes.</p></div><button className="button secondary" type="button" disabled={w.refreshing} onClick={() => void w.refresh()}>{w.refreshing ? <Spinner/> : <Clock3 size={16}/>}Check progress</button></div>
    <div className="activity-summary-strip"><span><Activity size={17}/><strong>{w.session.user ? entries.length : "--"}</strong> {entries.length === 1 ? "item" : "items"}</span><button type="button" onClick={() => update("status", "pending")}><Clock3 size={17}/><strong>{w.session.user ? pending : "--"}</strong> pending<ChevronRight size={14}/></button><span><Check size={16}/>Nothing resubmits on return</span></div>
    {unavailable.length > 0 && <div className="workspace-unavailable" role="status">Some activity sources are unavailable ({unavailable.join(", ")}). The records below may be incomplete. Refresh to check again.</div>}
    <div className="activity-filters"><label className="activity-search"><Search size={17}/><input aria-label="Search activity" placeholder="Search instructions, assets or IDs" value={filter.query} onChange={event => update("q", event.target.value, true)}/></label><label><span>Type</span><select aria-label="Activity type" value={filter.kind} onChange={event => update("kind", event.target.value)}><option value="all">All activity</option><option value="trade">Trades</option><option value="agent">Agent instructions</option><option value="funding">Funding</option><option value="expense">Operating costs</option></select></label><label><span>Status</span><select aria-label="Activity status" value={filter.status} onChange={event => update("status", event.target.value)}><option value="all">All statuses</option><option value="pending">Pending work</option>{statuses.filter(status => status !== "pending").map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><label><span>Initiator</span><select aria-label="Activity initiator" value={filter.initiator} onChange={event => update("initiator", event.target.value)}><option value="all">Everyone</option><option value="manual">Manual</option><option value="agent">Agent</option><option value="automation">Automation</option><option value="owner">Owner setup</option></select></label></div>
    <div className={`activity-workspace-grid ${selected ? "with-detail" : ""}`}><section className="workspace-panel activity-list" aria-label="Recorded activity">{w.loading ? <div className="activity-loading" role="status"><Spinner/>Loading saved activity</div> : !w.session.user ? <Empty title="Sign in to see your activity" action={<button className="button primary" type="button" disabled={w.connecting} onClick={() => void w.connect()}><Wallet size={16}/>Connect wallet</button>}>Your instructions, trades and funding records appear here after sign-in.</Empty> : !filtered.length ? <Empty title={entries.length ? "No matching activity" : "Your activity starts here"}>{entries.length ? "Try another filter or search term. Your saved records have not been changed." : "Your first manual trade review or agent instruction will appear here with its recorded outcome."}</Empty> : <>{filtered.map(entry => <button className={`activity-entry ${selected?.id === entry.id ? "selected" : ""}`} key={entry.id} type="button" aria-pressed={selected?.id === entry.id} onClick={() => update("item", entry.id)}><ActivityEntryIcon entry={entry}/><span className="activity-entry-copy"><strong>{entry.title}</strong><small>{entry.description}</small><span>{activityTime(entry.createdAt)}<i/>By {activityInitiator(entry.initiator)}</span></span><Status value={entry.status}/><ChevronRight size={16}/></button>)}</>}</section>{selected && <ActivityDetail key={selected.id} entry={selected} workspace={w} onClose={() => update("item", "")}/>}</div>
    {params.get("item") && !selected && !w.loading && w.session.user && <div className="workspace-unavailable">This record is not available for the signed-in owner. No action was replayed.</div>}
  </div>;
}
