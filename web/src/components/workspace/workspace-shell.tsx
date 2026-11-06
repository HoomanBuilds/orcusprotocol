"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, Bot, CandlestickChart, ChevronDown, CircleHelp, GitBranch, LayoutDashboard, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, Wallet, X } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { activityEntries } from "@/lib/workspace-model";
import { shortAddress } from "@/lib/format";
import { ActionPreview } from "../trading/action-preview";
import { InlineError, Spinner } from "../trading/primitives";

export const workspacePages = [
  { href: "/", title: "Overview", icon: LayoutDashboard },
  { href: "/trade", title: "Trade", icon: CandlestickChart },
  { href: "/agent", title: "Agent", icon: Bot },
  { href: "/automations", title: "Automations", icon: GitBranch },
  { href: "/activity", title: "Activity", icon: Activity },
  { href: "/settings", title: "Settings", icon: Settings2 },
] as const;

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const w = useWorkspace();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const page = workspacePages.find(item => item.href === pathname) ?? workspacePages[0];
  const pending = w.session.user ? activityEntries({ actions: w.actions, requests: w.requests, budget: w.budget, payments: w.payments, funding: w.funding, deposits: w.tradingDeposits, allowances: w.ostiumAllowances }).filter(item => item.pending).length : 0;
  const readyServices = w.health ? [w.health.compute, w.health.storage, w.health.uniswap, w.health.hyperliquid, ...(w.health.ostium ? [w.health.ostium] : []), w.health.cre].filter(service => service.configured).length : undefined;

  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);

  const navigation = <>{workspacePages.map(item => <Link key={item.href} href={item.href} prefetch={false} className={pathname === item.href ? "selected" : ""} aria-current={pathname === item.href ? "page" : undefined} onClick={() => setMenuOpen(false)}><item.icon size={19}/><span>{item.title}</span>{item.href === "/activity" && pending > 0 && <span className="nav-count">{pending}</span>}</Link>)}</>;

  return <div className={`product-workspace ${pathname === "/trade" ? "trade-route" : ""}`}>
    <a className="workspace-skip" href="#workspace-content">Skip to content</a>
    <aside className="workspace-sidebar">
      <Link className="workspace-brand" href="/" prefetch={false} aria-label="Orcus overview"><img src="/workspace/orcus.svg" width="31" height="31" alt=""/><span>orcus<span>.</span></span></Link>
      <span className="sidebar-label">YOUR WORKSPACE</span>
      <nav className="primary-nav" aria-label="Main navigation">{navigation}</nav>
      <div className="sidebar-bottom"><div className="sidebar-environment"><ShieldCheck size={18}/><div><strong>Testnet workspace</strong><small>No mainnet trading</small></div></div><Link href="/landing" prefetch={false}><CircleHelp size={16}/>About Orcus<ArrowUpRight size={13}/></Link></div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-topbar"><div className="workspace-breadcrumb"><button className="icon-button workspace-menu-toggle" type="button" aria-label={menuOpen ? "Close workspace navigation" : "Open workspace navigation"} aria-expanded={menuOpen} aria-controls="mobile-workspace-navigation" onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <X size={21}/> : <Menu size={21}/>}</button><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>{page.title}</strong></div><div className="workspace-header-actions"><span className="workspace-service-badge"><i className={`dot ${readyServices === (w.health?.ostium ? 6 : 5) ? "good" : "warn"}`}/>{readyServices === undefined ? "Checking services" : readyServices === (w.health?.ostium ? 6 : 5) ? "Integrations configured" : "Setup required"}</span><button className="icon-button refresh-control" type="button" disabled={w.refreshing} aria-label="Refresh accounts" title="Refresh accounts" onClick={() => void w.refresh()}><RefreshCw size={17} className={w.refreshing ? "spin" : ""}/></button>{w.session.user ? <><Link href="/settings" className="wallet-button"><span className="wallet-indicator"/><span>{shortAddress(w.session.user.address)}</span><ChevronDown size={13}/></Link><button className="icon-button logout" type="button" aria-label="Sign out" title="Sign out" onClick={() => void w.disconnect()}><LogOut size={17}/></button></> : <button className="button primary connect-button" type="button" disabled={w.connecting} onClick={() => void w.connect()}>{w.connecting ? <Spinner/> : <Wallet size={16}/>}<span>{w.connecting ? "Sign in with wallet" : "Connect wallet"}</span></button>}</div></header>
      <nav id="mobile-workspace-navigation" className="mobile-workspace-navigation" aria-label="Mobile navigation" hidden={!menuOpen}>{navigation}</nav>
      <div className="workspace-content-wrap">
        {(w.error || w.notice) && <div className="workspace-notices"><InlineError message={w.error} onDismiss={() => w.setError(null)}/>{w.notice && <div className="notice" role="status"><ShieldCheck size={17}/><span>{w.notice}</span><button className="icon-button" type="button" aria-label="Dismiss notification" onClick={() => w.setNotice(null)}><X size={16}/></button></div>}</div>}
        {pending > 0 && pathname !== "/activity" && <Link className="workspace-pending-banner" href="/activity?status=pending"><Activity size={16}/><span>{pending} {pending === 1 ? "item needs" : "items need"} your attention</span><span>View pending work <ArrowUpRight size={14}/></span></Link>}
        <main id="workspace-content" className="workspace-content" key={w.session.user?.id ?? "disconnected"}>{children}</main>
        <footer className="workspace-footer"><span><i className="dot warn"/>Testnet assets have no monetary value.</span><Link href="/settings?section=services">Service status<ArrowUpRight size={12}/></Link></footer>
      </div>
    </div>
    <ActionPreview workspace={w}/>
  </div>;
}
