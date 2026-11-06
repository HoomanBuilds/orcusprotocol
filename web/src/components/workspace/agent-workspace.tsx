"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/use-workspace";
import { usd } from "@/lib/format";
import { AgentPanel } from "../agent/agent-panel";
import { MemoryControls } from "../agent/memory-controls";
import { Status } from "../trading/primitives";

export function AgentWorkspace() {
  const w = useWorkspace();
  const router = useRouter();
  const [contextOpen, setContextOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const shell = page.current?.closest<HTMLElement>(".agent-route");
    const viewport = window.visualViewport;
    const update = () => {
      if (!shell) return;
      shell.style.setProperty("--agent-viewport-height", `${viewport && viewport.scale === 1 ? viewport.height : window.innerHeight}px`);
    };
    update(); viewport?.addEventListener("resize", update); window.addEventListener("resize", update);
    return () => { viewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); shell?.style.removeProperty("--agent-viewport-height"); };
  }, []);
  useEffect(() => {
    if (mobile && contextOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [contextOpen, mobile]);
  function closeContext() { setContextOpen(false); toggle.current?.focus(); }
  useEffect(() => {
    if (!contextOpen || mobile) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setContextOpen(false); toggle.current?.focus(); } };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [contextOpen, mobile]);
  const agent = w.agentData?.agent ?? w.session.agent;
  const permissions = (w.agentData?.permissions ?? []).filter(permission => permission.status === "active" && permission.expiresAt > Date.now());
  const context = <>
      <div className="agent-context-heading"><h2 id="agent-context-title">Agent context</h2><button type="button" className="icon-button" aria-label="Close agent context" onClick={closeContext}><X size={18}/></button></div>
      <div className="workspace-panel-heading"><h2>Recent instructions</h2><Link className="text-link" href="/activity?kind=agent">View all<ChevronRight size={14}/></Link></div>
      {w.resourceErrors.requests ? <p className="workspace-unavailable">Progress unavailable. Refresh before resending an instruction.</p> : w.requests.length ? <div className="agent-saved-requests">{w.requests.slice(0, 5).map(request => <Link key={request.id} href={`/activity?item=${encodeURIComponent(`request:${request.id}`)}`}><strong>{request.message}</strong><span><Status value={request.status}/><ChevronRight size={14}/></span></Link>)}</div> : <p className="compact-empty">{w.session.user ? "No saved instructions yet." : "Connect to load your saved work."}</p>}
      <div className="agent-context-section"><h2>Account access</h2><dl className="activity-facts"><div><dt>Execution mode</dt><dd>{!agent ? "Not loaded" : agent.paused ? "Paused" : agent.mode === "autonomous" ? "Within granted limits" : "Approval required"}</dd></div><div><dt>Active permissions</dt><dd>{w.resourceErrors.agent ? "Unavailable" : w.session.user ? permissions.length : "--"}</dd></div><div><dt>Shared accounts</dt><dd>{w.session.user ? w.session.accounts.length : "--"}</dd></div></dl><Link className="text-link" href="/settings?section=accounts">Review permissions<ChevronRight size={14}/></Link><button className="button secondary full" type="button" disabled={!w.session.user || w.controlling} onClick={() => void w.control("take-over")}>{w.controlling ? "Updating control..." : "Take over accounts"}</button></div>
      <div className="agent-context-section"><div className="workspace-panel-heading"><h2>Operating allowance</h2><Link className="text-link" href="/settings?section=budget">Manage<ChevronRight size={14}/></Link></div><strong className="sidebar-budget-value">{w.budget ? usd(w.budget.availableUsd) : "Unavailable"}</strong><p className="compact-empty">Expense cap, separate from trading capital.</p></div>
      {w.session.user && <div className="agent-context-section"><h2>Saved memory</h2><MemoryControls key={w.session.user.id} userId={w.session.user.id}/><Link className="text-link" href="/settings?section=agent">Encrypted backup controls<ChevronRight size={14}/></Link></div>}
    </>;
  return <div ref={page} className="agent-workspace-page">
    <AgentPanel key={w.session.user?.id ?? "disconnected"} workspace={w} onSettings={() => router.push("/settings?section=accounts")} contextControl={<button ref={toggle} className="button secondary small" type="button" aria-expanded={contextOpen} aria-controls="agent-context" onClick={() => setContextOpen(value => !value)}>Context</button>}/>
    {!mobile && contextOpen && <aside id="agent-context" className="agent-context-panel" aria-labelledby="agent-context-title">{context}</aside>}
    {mobile && <dialog ref={dialog} id="agent-context" className="agent-context-dialog" aria-labelledby="agent-context-title" onCancel={event => { event.preventDefault(); closeContext(); }} onClick={event => { if (event.target === event.currentTarget) closeContext(); }}><div className="agent-context-panel">{context}</div></dialog>}
  </div>;
}
