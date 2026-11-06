"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, ChevronRight, Database, ShieldCheck, Wallet } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { usd } from "@/lib/format";
import { AgentPanel } from "../agent/agent-panel";
import { MemoryControls } from "../agent/memory-controls";
import { Badge, Empty, Status } from "../trading/primitives";
import { ProtocolIcon } from "./asset-icon";

export function AgentWorkspace() {
  const w = useWorkspace();
  const router = useRouter();
  const agent = w.agentData?.agent ?? w.session.agent;
  const permissions = (w.agentData?.permissions ?? []).filter(permission => permission.status === "active" && permission.expiresAt > Date.now());
  const activeRequests = w.requests.filter(request => request.status === "queued" || request.status === "running");
  return <div className="agent-workspace-page">
    <div className="workspace-page-header"><div><span className="workspace-eyebrow">A PARTNER, NOT A SEPARATE PORTFOLIO</span><h1>Your agent</h1><p>Plan together. Use the same trading accounts. Keep control.</p></div><Link className="button secondary" href="/settings?section=agent"><ShieldCheck size={16}/>Preferences & memory</Link></div>
    <div className="agent-workspace-grid"><div className="agent-conversation-container"><AgentPanel key={w.session.user?.id ?? "disconnected"} workspace={w} onSettings={() => router.push("/settings?section=accounts")}/></div><aside className="agent-workspace-sidebar">
      <section className="workspace-panel"><div className="workspace-panel-heading"><div><h2>Agent controls</h2><p>Authority is explicit and revocable.</p></div><ShieldCheck size={19}/></div><div className="agent-control-state"><span className="dashboard-agent-icon"><Bot size={21}/></span><div><strong>{agent?.name ?? "Personal trading agent"}</strong><small>{!agent ? "Connect to load your agent" : agent.paused ? "New agent actions paused" : "Owner-directed workspace"}</small></div><Badge tone={agent?.paused ? "warn" : "neutral"}>{agent?.paused ? "Paused" : "Scoped"}</Badge></div><dl className="activity-facts"><div><dt>Execution preference</dt><dd>{agent?.mode === "autonomous" ? "Within granted limits" : "Approval required"}</dd></div><div><dt>Active permissions</dt><dd>{w.resourceErrors.agent ? "Unavailable" : w.session.user ? permissions.length : "--"}</dd></div><div><dt>Trading accounts</dt><dd>{w.session.user ? w.session.accounts.length : "--"} shared with you</dd></div></dl><p className="panel-empty-copy">A conversation or saved memory cannot grant signing authority. Pausing the agent does not disable manual owner controls.</p><Link className="text-link" href="/settings?section=accounts">Review account permissions<ChevronRight size={15}/></Link><button className="button secondary full" type="button" disabled={!w.session.user || w.controlling} onClick={() => void w.control("take-over")}>Take over accounts<ShieldCheck size={15}/></button></section>
      <section className="workspace-panel"><div className="workspace-panel-heading"><div><h2>Saved instructions</h2><p>{activeRequests.length ? `${activeRequests.length} queued or in progress` : "Progress survives page navigation."}</p></div><Bot size={19}/></div>{w.resourceErrors.requests ? <p className="workspace-unavailable">Saved request progress is unavailable. Refresh; do not resend an uncertain instruction.</p> : w.requests.length ? <div className="agent-saved-requests">{w.requests.slice(0, 4).map(request => <Link key={request.id} href={`/activity?item=${encodeURIComponent(`request:${request.id}`)}`}><strong>{request.message}</strong><span><Status value={request.status}/><ChevronRight size={14}/></span></Link>)}</div> : <p className="panel-empty-copy">An accepted instruction appears here before the worker starts. Returning only loads its saved state, never sends it again.</p>}<Link className="text-link" href="/activity?kind=agent">View instruction history<ChevronRight size={15}/></Link></section>
      <section className="workspace-panel"><div className="workspace-panel-heading"><div><h2>Operating allowance</h2><p>Separate from your trading capital.</p></div><Wallet size={18}/></div><strong className="sidebar-budget-value">{w.budget ? usd(w.budget.availableUsd) : "Unavailable"}</strong><p className="panel-empty-copy">USD-equivalent application allowance. Native 0G and verified provider credits are separate.</p><Link className="text-link" href="/settings?section=budget">Review costs & funding<ChevronRight size={15}/></Link></section>
      <section className="workspace-panel agent-memory-card"><div className="workspace-panel-heading"><div><h2>Memory & inference</h2><p>Useful context, explicit boundaries.</p></div><Database size={18}/></div><p><ProtocolIcon name="0g" size={23}/>0G planning. Encrypted memory backups.</p><p className="panel-empty-copy">Private inference is opt-in and provider-gated. Public venue trades stay public. Never store credentials in memory.</p>{w.session.user ? <MemoryControls key={w.session.user.id} userId={w.session.user.id}/> : <Empty title="Memory belongs to your owner session">Connect your wallet to inspect your saved preferences and notes.</Empty>}</section>
    </aside></div>
  </div>;
}
