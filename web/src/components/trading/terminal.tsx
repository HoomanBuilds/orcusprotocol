"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { number, usd } from "@/lib/format";
import { portfolioSummary } from "@/lib/workspace-model";
import { AssetIcon, ProtocolIcon } from "../workspace/asset-icon";
import { AccountTables } from "./account-tables";
import { MarketChart } from "./market-chart";
import { OrderTicket } from "./order-ticket";
import { InlineError } from "./primitives";
import { WalletRoles } from "./wallet-roles";

export function Terminal() {
  const w = useWorkspace();
  const router = useRouter();
  const [marketSearch, setMarketSearch] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
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

  return <div className="trade-workspace-page">
    <div className="workspace-page-header"><div><span className="workspace-eyebrow">YOUR ACCOUNTS. YOUR EXECUTION.</span><h1>Trade</h1><p>Direct control, or the same accounts with an authorized agent.</p></div><Link className="button secondary" href="/agent">Discuss a trade<ArrowUpRight size={16}/></Link></div>
    <div className="trade-venue-tabs" aria-label="Trading venue">{(["hyperliquid", "uniswap"] as const).map(venue => <button key={venue} type="button" className={w.venue === venue ? "selected" : ""} aria-pressed={w.venue === venue} onClick={() => { w.setVenue(venue); setMarketOpen(false); }}><ProtocolIcon name={venue}/><span><strong>{venue === "hyperliquid" ? "Hyperliquid" : "Uniswap"}</strong><small>{venue === "hyperliquid" ? "Testnet perpetuals" : "Ethereum Sepolia spot"}</small></span><i className={`dot ${w.venue === venue ? "good" : ""}`}/></button>)}</div>
    <section className="workspace-panel trade-market-heading" aria-label="Selected market">
      <div className="market-select-wrap" ref={picker} onKeyDown={event => { if (event.key === "Escape") { setMarketOpen(false); picker.current?.querySelector("button")?.focus(); } }}><button className="market-select" type="button" aria-label={`Select market, ${w.symbol}`} aria-expanded={marketOpen} aria-controls="market-options" onClick={() => setMarketOpen(value => !value)}><AssetIcon symbol={w.symbol} size={38}/><div><strong>{w.symbol}</strong><span>{w.venue === "hyperliquid" ? "Perpetual contract" : "Sepolia token pair"}</span></div><ChevronDown size={17}/></button>{marketOpen && <div className="market-popover" id="market-options"><label className="market-search-field"><Search size={16}/><input autoFocus aria-label="Search markets" placeholder="Search available markets" value={marketSearch} onChange={event => setMarketSearch(event.target.value)}/></label><div className="market-options-list">{markets.map(item => <button type="button" key={item.symbol} onClick={() => { w.setSymbol(item.symbol); setMarketOpen(false); setMarketSearch(""); }}><AssetIcon symbol={item.symbol} size={26}/><strong>{item.symbol}</strong><span>{usd(item.midPrice)}</span></button>)}{!markets.length && <p className="panel-empty-copy">{w.markets.length ? "No market matches this search." : "No market catalog loaded. Check the feed status before trading."}</p>}</div><p className="market-catalog-note">Only the selected venue's configured testnet markets.</p></div>}</div>
      <div className="market-price"><strong>{market ? usd(market.midPrice) : "Unavailable"}</strong><span className={market?.change24h === undefined ? "muted" : market.change24h >= 0 ? "positive" : "negative"}>{market?.change24h === undefined ? "24h change unavailable" : `${market.change24h >= 0 ? "+" : ""}${number(market.change24h)}% / 24h`}</span></div>
      <div className="market-stat"><span>24h venue volume</span><strong>{market?.volume24h === undefined ? "Unavailable" : usd(market.volume24h)}</strong></div><div className="market-stat feed-state"><span>Market feed</span><strong className={stale ? "warning-text" : ""}><i className={`dot ${stale ? "warn" : market ? "good" : ""}`}/>{stale ? "Stale snapshot" : market ? "Venue snapshot" : "Unavailable"}</strong></div>
    </section>
    {w.marketError && <InlineError message={w.marketError}/>}
    {w.venue === "uniswap" && <div className="trade-network-note"><ShieldCheck size={16}/><span>WETH/USDC on Ethereum Sepolia. Native ETH input is an explicit wrap step. A reviewed quote is not a confirmed swap.</span></div>}
    <div className="trade-execution-grid"><div className="trade-chart-column"><MarketChart venue={w.venue} symbol={w.symbol}/></div><OrderTicket key={w.session.user?.id ?? "disconnected"} workspace={w} onSetup={() => router.push("/settings?section=accounts")}/></div>
    <section className="portfolio-strip trade-portfolio-strip" aria-label="Trading account summary"><div><span>Observed testnet equity</span><strong>{summary.equity === undefined ? "Unavailable" : usd(summary.equity)}</strong></div><div><span>Unrealized P&amp;L</span><strong className={summary.pnl === undefined ? "" : summary.pnl >= 0 ? "positive" : "negative"}>{summary.pnl === undefined ? "Unavailable" : usd(summary.pnl)}</strong></div><div><span>Open positions</span><strong>{summary.observed ? w.portfolio.positions.length : "--"}</strong></div><div><span>Account control</span><strong className="control-caption"><ShieldCheck size={14}/>Owner + scoped agent</strong></div><button className="button secondary small" type="button" disabled={!w.session.user || w.controlling} onClick={() => void w.control("take-over")}>{w.controlling ? "Updating control..." : "Take over"}<ArrowUpRight size={14}/></button></section>
    {w.resourceErrors.portfolio && <InlineError message={`Account data is unavailable: ${w.resourceErrors.portfolio}`}/>}{w.portfolio.errors?.map(error => <InlineError message={error.message} key={`${error.accountId}:${error.message}`}/>)}
    <WalletRoles owner={w.session.user?.address} account={w.account} operatingAddress={w.agentData?.agent.operatingAddress ?? w.session.agent?.operatingAddress}/>
    <AccountTables key={w.session.user?.id ?? "disconnected"} workspace={w}/>
  </div>;
}
