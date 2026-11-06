"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { usd } from "@/lib/format";
import { AgentPanel } from "../agent/agent-panel";
import { MemoryControls } from "../agent/memory-controls";
import { Status } from "../trading/primitives";

export function AgentWorkspace() {
  const w = useWorkspace();
  const router = useRouter();
  const agent = w.agentData?.agent ?? w.session.agent;
  const permissions = (w.agentData?.permissions ?? []).filter(permission => permission.status === "active" && permission.expiresAt > Date.now());
  return <div className="agent-workspace-page">
    <div className="workspace-page-header"><h1>Agent</h1><Link className="button secondary" href="/settings?section=agent">Preferences & memory<ArrowUpRight size={15}/></Link></div>
    <div className="agent-workspace-grid"><div className="agent-conversation-container"><AgentPanel key={w.session.user?.id ?? "disconnected"} workspace={w} onSettings={() => router.push("/settings?section=accounts")} onBudget={() => router.push("/settings?section=budget")} showBudget={false}/></div><aside className="workspace-panel agent-context-panel">
      <div className="workspace-panel-heading"><h2>Recent instructions</h2><Link className="text-link" href="/activity?kind=agent">View all<ChevronRight size={14}/></Link></div>
      {w.resourceErrors.requests ? <p className="workspace-unavailable">Progress unavailable. Refresh before resending an instruction.</p> : w.requests.length ? <div className="agent-saved-requests">{w.requests.slice(0, 5).map(request => <Link key={request.id} href={`/activity?item=${encodeURIComponent(`request:${request.id}`)}`}><strong>{request.message}</strong><span><Status value={request.status}/><ChevronRight size={14}/></span></Link>)}</div> : <p className="compact-empty">{w.session.user ? "No saved instructions yet." : "Connect to load your saved work."}</p>}
      <div className="agent-context-section"><h2>Account access</h2><dl className="activity-facts"><div><dt>Execution mode</dt><dd>{!agent ? "Not loaded" : agent.paused ? "Paused" : agent.mode === "autonomous" ? "Within granted limits" : "Approval required"}</dd></div><div><dt>Active permissions</dt><dd>{w.resourceErrors.agent ? "Unavailable" : w.session.user ? permissions.length : "--"}</dd></div><div><dt>Shared accounts</dt><dd>{w.session.user ? w.session.accounts.length : "--"}</dd></div></dl><Link className="text-link" href="/settings?section=accounts">Review permissions<ChevronRight size={14}/></Link><button className="button secondary full" type="button" disabled={!w.session.user || w.controlling} onClick={() => void w.control("take-over")}>{w.controlling ? "Updating control..." : "Take over accounts"}</button></div>
      <div className="agent-context-section"><div className="workspace-panel-heading"><h2>Operating allowance</h2><Link className="text-link" href="/settings?section=budget">Manage<ChevronRight size={14}/></Link></div><strong className="sidebar-budget-value">{w.budget ? usd(w.budget.availableUsd) : "Unavailable"}</strong><p className="compact-empty">Expense cap, separate from trading capital.</p></div>
      {w.session.user && <div className="agent-context-section"><h2>Saved memory</h2><MemoryControls key={w.session.user.id} userId={w.session.user.id}/><Link className="text-link" href="/settings?section=agent">Encrypted backup controls<ChevronRight size={14}/></Link></div>}
    </aside></div>
  </div>;
}
