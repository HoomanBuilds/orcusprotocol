"use client";

import { useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  ChevronDown,
  CircleHelp,
  GitBranch,
  LayoutDashboard,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { number, shortAddress, usd } from "@/lib/format";
import { AccountTables, ActivityTable } from "./account-tables";
import { ActionPreview } from "./action-preview";
import { MarketChart } from "./market-chart";
import { OrderTicket } from "./order-ticket";
import { AgentPanel } from "../agent/agent-panel";
import { AutomationsView } from "../agent/automations-view";
import { SettingsView } from "../agent/settings-view";
import { Badge, InlineError, Spinner } from "./primitives";
import { WalletRoles } from "./wallet-roles";

type View = "trade" | "automations" | "activity" | "settings";
const views = [
  { id: "trade", label: "Trade", icon: LayoutDashboard },
  { id: "automations", label: "Automations", icon: GitBranch },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

export function Terminal() {
  const w = useWorkspace();
  const [view, setView] = useState<View>("trade");
  const [showAgent, setShowAgent] = useState(true);
  const [marketSearch, setMarketSearch] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const market = w.activeMarket;
  const stale = market ? Date.now() - market.observedAt > 60_000 : false;
  const pnl =
    w.session.user && w.portfolio.observedAt && !w.portfolio.errors?.length
      ? w.portfolio.positions.reduce(
          (sum, position) => sum + Number(position.unrealizedPnl),
          0,
        )
      : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => setView("trade")}
          aria-label="Orcus trading home"
        >
          <span className="brand-mark">O</span>
          <span>
            orcus<span className="brand-period">.</span>
          </span>
        </button>
        <nav className="primary-nav" aria-label="Main navigation">
          {views.map((item) => (
            <button
              type="button"
              className={view === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => setView(item.id)}
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className="testnet-label">
            <i className="dot warn" />
            Testnet
          </span>
          <button
            className="icon-button refresh-control"
            type="button"
            disabled={w.refreshing}
            title="Refresh accounts"
            aria-label="Refresh accounts"
            onClick={() => void w.refresh()}
          >
            <RefreshCw className={w.refreshing ? "spin" : ""} size={15} />
          </button>
          {w.session.user ? (
            <>
              <button
                className="wallet-button"
                type="button"
                onClick={() => setView("settings")}
              >
                <span className="wallet-indicator" />
                <span>{shortAddress(w.session.user.address)}</span>
                <ChevronDown size={12} />
              </button>
              <button
                className="icon-button logout"
                type="button"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => void w.disconnect()}
              >
                <LogOut size={15} />
              </button>
            </>
          ) : (
            <button
              className="button primary connect-button"
              type="button"
              disabled={w.connecting}
              onClick={() => void w.connect()}
            >
              {w.connecting ? <Spinner /> : <Wallet size={14} />}
              {w.connecting ? "Sign in with wallet" : "Connect wallet"}
            </button>
          )}
        </div>
      </header>
      <div className="mobile-nav">
        {views.map((item) => (
          <button
            type="button"
            key={item.id}
            className={view === item.id ? "selected" : ""}
            onClick={() => setView(item.id)}
          >
            <item.icon size={15} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="workspace-status">
        <span>
          <i className={`dot ${w.health ? "good" : ""}`} />
          {w.health ? "Testnet workspace" : "Connecting to services"}
          <span className="status-divider">/</span>Your accounts. Your agent.
          One workspace.
        </span>
        <button
          type="button"
          className="text-button"
          onClick={() => setShowAgent((value) => !value)}
        >
          {showAgent ? (
            <PanelRightClose size={14} />
          ) : (
            <PanelRightOpen size={14} />
          )}
          {showAgent ? "Hide agent" : "Open agent"}
        </button>
      </div>
      {(w.error || w.notice) && (
        <div className="global-notices">
          <InlineError message={w.error} onDismiss={() => w.setError(null)} />
          {w.notice && (
            <div className="notice" role="status">
              <ShieldCheck size={14} />
              <span>{w.notice}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => w.setNotice(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className={`workspace-layout ${showAgent ? "with-agent" : ""}`}>
        <main className="main-workspace">
          {view === "trade" ? (
            <>
              <section className="market-heading">
                <div className="market-select-wrap">
                  <button
                    className="market-select"
                    type="button"
                    aria-expanded={marketOpen}
                    onClick={() => setMarketOpen((value) => !value)}
                  >
                    <span
                      className={`asset-icon ${w.symbol.startsWith("BTC") ? "bitcoin" : "ethereum"}`}
                    >
                      {w.symbol.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{w.symbol}</strong>
                      <span>
                        {w.venue === "hyperliquid" ? "Perpetual" : "Spot swap"}
                      </span>
                    </div>
                    <ChevronDown size={16} />
                  </button>
                  {marketOpen && (
                    <div className="market-popover">
                      <input
                        autoFocus
                        aria-label="Search markets"
                        placeholder="Search markets"
                        value={marketSearch}
                        onChange={(event) =>
                          setMarketSearch(event.target.value)
                        }
                      />
                      {w.markets
                        .filter((item) =>
                          item.symbol
                            .toLowerCase()
                            .includes(marketSearch.toLowerCase()),
                        )
                        .slice(0, 30)
                        .map((item) => (
                          <button
                            type="button"
                            key={item.symbol}
                            onClick={() => {
                              w.setSymbol(item.symbol);
                              setMarketOpen(false);
                              setMarketSearch("");
                            }}
                          >
                            <strong>{item.symbol}</strong>
                            <span>{usd(item.midPrice)}</span>
                          </button>
                        ))}
                      {!w.markets.length && (
                        <p className="muted">
                          No markets loaded. Check the feed below.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <div className="market-price">
                  <strong>{usd(market?.midPrice)}</strong>
                  <span
                    className={
                      market?.change24h === undefined
                        ? "muted"
                        : market.change24h >= 0
                          ? "positive"
                          : "negative"
                    }
                  >
                    {market?.change24h === undefined
                      ? "24h change unavailable"
                      : `${market.change24h >= 0 ? "+" : ""}${number(market.change24h)}% today`}
                  </span>
                </div>
                <div className="market-stat">
                  <span>24h volume</span>
                  <strong>{usd(market?.volume24h)}</strong>
                </div>
                <div className="market-stat feed-state">
                  <span>Market feed</span>
                  <strong className={stale ? "warning-text" : ""}>
                    <i
                      className={`dot ${stale ? "warn" : market ? "good" : ""}`}
                    />
                    {stale ? "Stale" : market ? "Venue data" : "Unavailable"}
                  </strong>
                </div>
                <div className="venue-selector segmented">
                  <button
                    type="button"
                    className={w.venue === "hyperliquid" ? "selected" : ""}
                    onClick={() => w.setVenue("hyperliquid")}
                  >
                    Hyperliquid
                  </button>
                  <button
                    type="button"
                    className={w.venue === "uniswap" ? "selected" : ""}
                    onClick={() => w.setVenue("uniswap")}
                  >
                    Uniswap
                  </button>
                </div>
              </section>
              {w.marketError && (
                <div className="feed-error">
                  <InlineError message={w.marketError} />
                </div>
              )}
              <div className="trading-grid">
                <MarketChart venue={w.venue} symbol={w.symbol} />
                <OrderTicket key={w.session.user?.id ?? "disconnected"}
                  workspace={w}
                  onSetup={() => setView("settings")}
                />
              </div>
              <div className="portfolio-strip">
                <div>
                  <span>Account equity</span>
                  <strong>{usd(w.portfolio.totalEquityUsd)}</strong>
                </div>
                <div>
                  <span>Unrealized P&L</span>
                  <strong
                    className={
                      pnl === undefined
                        ? ""
                        : pnl >= 0
                          ? "positive"
                          : "negative"
                    }
                  >
                    {usd(pnl)}
                  </strong>
                </div>
                <div>
                  <span>Open positions</span>
                  <strong>
                    {w.session.user && w.portfolio.observedAt
                      ? w.portfolio.positions.length
                      : "--"}
                  </strong>
                </div>
                <div>
                  <span>Control</span>
                  <strong className="control-caption">
                    <ShieldCheck size={13} />
                    Owner + authorized agent
                  </strong>
                </div>
                <button
                  className="text-button"
                  type="button"
                  disabled={!w.session.user || w.controlling}
                  onClick={() => void w.control("take-over")}
                >
                  {w.controlling ? "Updating control..." : "Take over"}
                  <ArrowUpRight size={12} />
                </button>
              </div>
              {w.portfolio.errors?.map((error) => (
                <div
                  className="feed-error"
                  key={`${error.accountId}:${error.message}`}
                >
                  <InlineError message={error.message} />
                </div>
              ))}
              <WalletRoles owner={w.session.user?.address} account={w.account} operatingAddress={w.agentData?.agent.operatingAddress ?? w.session.agent?.operatingAddress} />
              <AccountTables key={w.session.user?.id ?? "disconnected"} workspace={w} />
            </>
          ) : view === "automations" ? (
            <AutomationsView key={w.session.user?.id ?? "disconnected"} workspace={w} />
          ) : view === "settings" ? (
            <SettingsView key={w.session.user?.id ?? "disconnected"} workspace={w} />
          ) : (
            <section className="workspace-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">EVERY ACTION, ONE RECORD</span>
                  <h1>Execution activity</h1>
                  <p>
                    Owner, agent and automated actions, reconciled against the
                    actual venue.
                  </p>
                </div>
                <Badge>{w.actions.length} actions</Badge>
              </div>
              <ActivityTable actions={w.actions} onRefresh={w.refresh} />
            </section>
          )}
        </main>
        {showAgent && (
          <AgentPanel key={w.session.user?.id ?? "disconnected"} workspace={w} onSettings={() => setView("settings")} />
        )}
      </div>
      <footer className="app-footer">
        <div>
          <span className="brand-mini">O</span>
          <span>Built for decisions that stay yours.</span>
        </div>
        <div>
          <span>0G inference</span>
          <span>Uniswap execution</span>
          <span>Chainlink CRE</span>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={() => setView("settings")}
        >
          <CircleHelp size={12} />
          Service status
        </button>
      </footer>
      {!showAgent && (
        <button
          className="floating-agent"
          type="button"
          onClick={() => setShowAgent(true)}
        >
          <Bot size={19} />
          Open agent
        </button>
      )}
      <ActionPreview workspace={w} />
    </div>
  );
}
