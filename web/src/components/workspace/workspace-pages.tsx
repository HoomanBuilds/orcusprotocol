"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Activity, Bot, ChevronRight, Database, GitBranch, ShieldCheck, Wallet } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { AutomationsView } from "../agent/automations-view";
import { SettingsView, type SettingsSection } from "../agent/settings-view";

const settingsSections = [
  { id: "accounts", label: "Accounts & permissions", icon: ShieldCheck },
  { id: "budget", label: "Costs & funding", icon: Wallet },
  { id: "agent", label: "Agent & memory", icon: Bot },
  { id: "services", label: "Service status", icon: Database },
] as const;

export function SettingsPage() {
  const w = useWorkspace();
  const params = useSearchParams();
  const value = params.get("section");
  const section: SettingsSection = settingsSections.find(item => item.id === value)?.id ?? "accounts";
  return <div className="settings-workspace-page"><div className="workspace-page-header"><div><span className="workspace-eyebrow">YOUR WORKSPACE, YOUR LIMITS</span><h1>Settings</h1><p>Manage ownership, access and operating costs in one place.</p></div></div><nav className="settings-section-navigation" aria-label="Settings sections">{settingsSections.map(item => <Link key={item.id} href={`/settings?section=${item.id}`} aria-current={section === item.id ? "page" : undefined} className={section === item.id ? "selected" : ""}><item.icon size={17}/>{item.label}</Link>)}</nav><SettingsView key={w.session.user?.id ?? "disconnected"} workspace={w} section={section}/></div>;
}

export function AutomationsPage() {
  const w = useWorkspace();
  const active = w.automations.filter(item => item.status === "active").length;
  const waiting = w.actions.filter(item => item.initiator === "automation" && ["prepared", "awaiting-approval"].includes(item.status)).length;
  return <div className="automations-workspace-page">{w.session.user && w.automations.length > 0 && <div className="automation-summary"><section className="workspace-panel"><GitBranch size={19}/><div><strong>{w.resourceErrors.automations ? "Unavailable" : active}</strong><span>Active schedules</span></div></section><section className="workspace-panel"><ShieldCheck size={19}/><div><strong>{w.resourceErrors.automations ? "Unavailable" : waiting}</strong><span>Awaiting approval</span></div></section><section className="workspace-panel"><Activity size={19}/><div><strong>{w.health?.cre.ready ? "Runner configured" : "Runner unavailable"}</strong><span>CRE local evaluation, not hosted DON execution</span></div></section></div>}{w.resourceErrors.automations && <div className="workspace-unavailable" role="status">Automation state could not be loaded. Refresh before relying on schedules or creating replacements.</div>}<AutomationsView key={w.session.user?.id ?? "disconnected"} workspace={w}/></div>;
}
