"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { number, quotePrice, usd } from "@/lib/format";
import { venuePresentation } from "@/lib/venue-presentation";
import { portfolioSummary } from "@/lib/workspace-model";
import { AssetIcon, hasAssetIcon, ProtocolIcon } from "../workspace/asset-icon";
import { AccountTables } from "./account-tables";
import { MarketChart } from "./market-chart";
import { MarketContextPanel } from "./market-context-panel";
import { OstiumMarketContext } from "./ostium-market-context";
import { OstiumOrderTicket } from "./ostium-order-ticket";
import { OrderTicket } from "./order-ticket";
import { InlineError } from "./primitives";
import { WalletRoles } from "./wallet-roles";

export function Terminal() {
  const w = useWorkspace();
  const router = useRouter();
  const [marketSearch, setMarketSearch] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState("market");
  const picker = useRef<HTMLDivElement>(null);
  const market = w.activeMarket;
  const stale = market ? Date.now() - market.observedAt > 60_000 : false;
  const summary = portfolioSummary(w.portfolio, Boolean(w.session.user), Boolean(w.resourceErrors.portfolio));
  const markets = w.markets.filter(item => item.symbol.toLowerCase().includes(marketSearch.trim().toLowerCase())).slice(0, 50);

  useEffect(() => {
    if (!marketOpen) return;
    const dismiss = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setMarketOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [marketOpen]);

  return <div className="trade-workspace-page" data-mobile-view={mobileTab}>
    <h1 className="workspace-visually-hidden">Trade</h1>

    <section className="workspace-panel trade-market-heading" aria-label="Selected market">
      <label className="trade-venue-select"><ProtocolIcon name={w.venue} size={23}/><select aria-label="Trading venue" value={w.venue} onChange={event => { w.setVenue(event.target.value as typeof w.venue); setMarketOpen(false); }}><option value="hyperliquid">Hyperliquid testnet</option><option value="uniswap">Uniswap Sepolia</option><option value="ostium">Ostium Arbitrum Sepolia</option></select></label>
      <div className="market-select-wrap" ref={picker} onKeyDown={event => { if (event.key === "Escape") { setMarketOpen(false); picker.current?.querySelector("button")?.focus(); } }}><button className="market-select" type="button" aria-label={`Select market, ${w.symbol}`} aria-expanded={marketOpen} aria-controls="market-options" onClick={() => setMarketOpen(value => !value)}>{hasAssetIcon(w.symbol) && <AssetIcon symbol={w.symbol} size={38}/>}<div><strong>{w.symbol}</strong><span>{venuePresentation[w.venue].marketType}</span></div><ChevronDown size={17}/></button>{marketOpen && <div className="market-popover" id="market-options"><label className="market-search-field"><Search size={16}/><input autoFocus aria-label="Search markets" placeholder="Search available markets" value={marketSearch} onChange={event => setMarketSearch(event.target.value)}/></label><div className="market-options-list">{markets.map(item => <button type="button" key={item.symbol} onClick={() => { w.setSymbol(item.symbol); setMarketOpen(false); setMarketSearch(""); }}>{hasAssetIcon(item.symbol) && <AssetIcon symbol={item.symbol} size={26}/>}<span className="market-option-identity"><strong>{item.symbol}</strong>{item.venue === "ostium" && <small>{item.tradable === false ? item.unavailableReason ?? "Read-only market" : item.category}</small>}</span><span>{quotePrice(item.midPrice, item.quoteAsset)}</span></button>)}{!markets.length && <p className="panel-empty-copy">{w.markets.length ? "No market matches this search." : "No market catalog loaded. Check the feed status before trading."}</p>}</div><p className="market-catalog-note">Only the selected venue's configured testnet markets.</p></div>}</div>
      <div className="market-price"><strong>{quotePrice(market?.midPrice, market?.quoteAsset ?? (w.venue === "ostium" ? w.symbol.split("/")[1] : "USDC"))}</strong><span className={market?.change24h === undefined ? "muted" : market.change24h >= 0 ? "positive" : "negative"}>{market?.change24h === undefined ? "24h change unavailable" : `${market.change24h >= 0 ? "+" : ""}${number(market.change24h)}% / 24h`}</span></div>
      <div className="market-stat"><span>24h venue volume</span><strong>{market?.volume24h === undefined ? "Unavailable" : usd(market.volume24h)}</strong></div><div className="market-stat feed-state"><span>Market feed</span><strong className={stale ? "warning-text" : ""}><i className={`dot ${stale ? "warn" : market ? "good" : ""}`}/>{stale ? "Stale snapshot" : market ? "Venue snapshot" : "Unavailable"}</strong></div>
    </section>
    {w.marketError && <InlineError message={w.marketError}/>}
    {w.venue === "uniswap" && <div className="trade-network-note"><ShieldCheck size={16}/><span>WETH/USDC on Ethereum Sepolia. Native ETH input is an explicit wrap step. A reviewed quote is not a confirmed swap.</span></div>}
    <nav className="trade-mobile-tabs" aria-label="Terminal sections">{[{ id: "market", label: "Chart" }, { id: "book", label: "Depth" }, { id: "order", label: "Ticket" }, { id: "positions", label: "Accounts" }].map(tab => <button key={tab.id} type="button" aria-pressed={mobileTab === tab.id} className={mobileTab === tab.id ? "selected" : ""} onClick={() => setMobileTab(tab.id)}>{tab.label}</button>)}</nav>
    <div className="trade-execution-grid"><div className="trade-chart-column"><MarketChart venue={w.venue} symbol={w.symbol}/></div><div className="trade-depth-column">{w.venue === "ostium" ? <OstiumMarketContext market={market} symbol={w.symbol}/> : <MarketContextPanel venue={w.venue} symbol={w.symbol} prepared={w.preview?.execution}/>}</div><div className="trade-ticket-column">{w.venue === "ostium" ? <OstiumOrderTicket key={w.session.user?.id ?? "disconnected"} workspace={w} onSetup={() => router.push("/settings?section=accounts")}/> : <OrderTicket key={w.session.user?.id ?? "disconnected"} workspace={w} onSetup={() => router.push("/settings?section=accounts")}/>}</div><div className="trade-tables-row"><AccountTables key={w.session.user?.id ?? "disconnected"} workspace={w}/></div></div>
    <section className="portfolio-strip trade-portfolio-strip" aria-label="Trading account summary"><div><span>Observed testnet equity</span><strong>{summary.equity === undefined ? "Unavailable" : usd(summary.equity)}</strong></div><div><span>Unrealized P&amp;L</span><strong className={summary.pnl === undefined ? "" : summary.pnl >= 0 ? "positive" : "negative"}>{summary.pnl === undefined ? "Unavailable" : usd(summary.pnl)}</strong></div><div><span>Open positions</span><strong>{summary.observed ? w.portfolio.positions.length : "--"}</strong></div><div><span>Account control</span><strong className="control-caption"><ShieldCheck size={14}/>{w.account?.status === "authorized" && w.agentData?.permissions.some(permission => permission.accountId === w.account?.id && permission.status === "active" && permission.expiresAt > Date.now()) ? "Owner + authorized agent" : "Owner-controlled"}</strong></div><button className="button secondary small" type="button" disabled={!w.session.user || w.controlling} onClick={() => void w.control("take-over")}>{w.controlling ? "Updating control..." : "Take over"}<ArrowUpRight size={14}/></button></section>
    {w.resourceErrors.portfolio && <InlineError message={`Account data is unavailable: ${w.resourceErrors.portfolio}`}/>}{w.portfolio.errors?.map(error => <InlineError message={error.message} key={`${error.accountId}:${error.message}`}/>)}
    <WalletRoles owner={w.session.user?.address} account={w.account} operatingAddress={w.agentData?.agent.operatingAddress ?? w.session.agent?.operatingAddress}/>

  </div>;
}
