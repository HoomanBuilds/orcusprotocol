"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PreparedAction, Venue } from "@orcus/core";
import { api } from "../../lib/api";
import { number, time } from "../../lib/format";
import { cumulativeLevels, hourlyFundingLabel, marketContextIsStale, marketQuantity, type BookLevel, type HyperliquidMarketContext } from "../../lib/market-context";
import styles from "./market-context-panel.module.css";

export function MarketContextPanel({ venue, symbol, prepared }: { venue: Venue; symbol: string; prepared?: PreparedAction | null }) {
  const [snapshot, setSnapshot] = useState<HyperliquidMarketContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSnapshot(current => venue === "hyperliquid" && current?.symbol === symbol ? current : null);
    setError(null);
    if (venue !== "hyperliquid") { setLoading(false); return; }
    let active = true, busy = false;
    const controller = new AbortController();
    async function load() {
      if (busy || !active || document.hidden) return;
      busy = true;
      setLoading(true);
      try {
        const result = await api<HyperliquidMarketContext>(`/api/market-context?venue=hyperliquid&symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (active && result.venue === "hyperliquid" && result.network === "testnet" && result.symbol === symbol) { setSnapshot(result); setError(null); }
        else if (active) setError("Market data could not be verified. Refresh in a moment.");
      } catch { if (active) setError("Market data is unavailable. Refresh in a moment."); }
      finally { busy = false; if (active) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 5_000);
    const visible = () => { if (!document.hidden) { setNow(Date.now()); void load(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [venue, symbol, refresh]);

  if (venue === "uniswap") return <SwapContext symbol={symbol} prepared={prepared} now={now} />;
  const current = snapshot?.symbol === symbol ? snapshot : null;
  return <MarketDepthView symbol={symbol} snapshot={current} loading={loading} error={error} now={now} onRefresh={() => setRefresh(value => value + 1)} />;
}

export function MarketDepthView({ symbol, snapshot: current, loading, error, now, onRefresh }: { symbol: string; snapshot: HyperliquidMarketContext | null; loading: boolean; error: string | null; now: number; onRefresh: () => void }) {
  const bookStale = marketContextIsStale(current?.book?.observedAt, now);
  const assetStale = marketContextIsStale(current?.asset?.observedAt, now);
  const funding = current?.asset?.fundingRateHourly;
  const positive = funding !== undefined && Number(funding) > 0;
  const negative = funding !== undefined && Number(funding) < 0;
  const asks = cumulativeLevels(current?.book?.asks.slice(0, 8) ?? []).reverse();
  const bids = cumulativeLevels(current?.book?.bids.slice(0, 8) ?? []);
  const bestAsk = current?.book?.asks[0]?.price, bestBid = current?.book?.bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? Number(bestAsk) - Number(bestBid) : undefined;
  const maxDepth = Math.max(1, ...asks.map(level => level.cumulative), ...bids.map(level => level.cumulative));
  return (
    <section className={styles.panel} aria-label="Market depth and funding">
      <header className={styles.heading}>
        <div><img src="/landing/brands/hyperliquid.svg" alt="Hyperliquid" width="22" height="22" /><h3>Order book</h3><span className={styles.network}>Testnet</span></div>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh market context"><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
      </header>
      {error && <p className={styles.warning} role="status">{error} {current ? "Showing the last received snapshot." : ""}</p>}
      {current?.warnings.map(warning => <p className={styles.warning} key={warning}>{warning}</p>)}
      {current?.book ? <>
        <div className={styles.bookStatus}><strong>{symbol} / USDC</strong><span className={bookStale || error ? styles.warningText : styles.muted}>{bookStale || error ? "Stale snapshot" : "Observed snapshot"} {time(current.book.observedAt)}</span></div>
        <div className={styles.ladderScroll}><table className={styles.ladder} aria-label={`${symbol} testnet order book`}>
          <thead><tr><th scope="col">Price (USDC)</th><th scope="col">Size ({symbol})</th><th scope="col">Total ({symbol})</th></tr></thead>
          <tbody aria-label="Asks">{asks.map(level => <DepthRow key={`ask:${level.price}`} level={level} side="ask" maxDepth={maxDepth}/>)}</tbody>
          <tbody><tr className={styles.spread}><td colSpan={3}><span>Spread</span><strong>{marketQuantity(spread)}{spread === undefined ? "" : " USDC"}</strong></td></tr></tbody>
          <tbody aria-label="Bids">{bids.map(level => <DepthRow key={`bid:${level.price}`} level={level} side="bid" maxDepth={maxDepth}/>)}</tbody>
        </table></div>
        {!current.book.bids.length && !current.book.asks.length && <p className={styles.empty}>No resting orders in this snapshot.</p>}
      </> : <p className={styles.empty} role="status">{loading && !current ? "Loading testnet order book..." : "Order book unavailable. Refresh market data to try again."}</p>}
      <details className={styles.contextDisclosure}><summary>Funding &amp; market context<span>{hourlyFundingLabel(funding)} / h</span></summary>
        <dl className={styles.metrics} aria-label="Current perpetual context">
          <div><dt>Funding / hour</dt><dd className={assetStale ? styles.muted : undefined}>{hourlyFundingLabel(funding)}</dd></div>
          <div><dt>Open interest ({symbol})</dt><dd className={assetStale ? styles.muted : undefined}>{marketQuantity(current?.asset?.openInterestBase)}</dd></div>
          <div><dt>Mark (USDC)</dt><dd className={assetStale ? styles.muted : undefined}>{marketQuantity(current?.asset?.markPrice)}</dd></div>
        </dl>
        <p className={styles.note}>{positive ? "Positive funding: longs pay shorts." : negative ? "Negative funding: shorts pay longs." : funding !== undefined ? "Current funding is zero." : "Funding is paid between positions, not to Orcus."} The current rate can change before hourly settlement.</p>
        {current?.asset && <p className={styles.timestamp}>{assetStale || error ? "Context may be stale" : "Context observed"} {time(current.asset.observedAt)}</p>}
        <p className={styles.note}>Top eight levels per side. Sizes and cumulative depth are in {symbol}. Displayed liquidity can change and is not a fill guarantee.</p>
      </details>
    </section>
  );
}

function depthQuantity(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return "Unavailable";
  const [whole, fraction] = value.split(".");
  const decimal = fraction?.replace(/0+$/, "");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimal ? `.${decimal}` : ""}`;
}

function DepthRow({ level, side, maxDepth }: { level: BookLevel & { cumulative: number }; side: "bid" | "ask"; maxDepth: number }) {
  return <tr className={side === "bid" ? styles.bid : styles.ask} style={{ backgroundSize: `${Math.min(100, level.cumulative / maxDepth * 100)}% 100%` }}><td>{depthQuantity(level.price)}</td><td>{depthQuantity(level.size)}</td><td>{marketQuantity(level.cumulative)}</td></tr>;
}

function SwapContext({ symbol, prepared, now }: { symbol: string; prepared?: PreparedAction | null; now: number }) {
  const action = symbol === "WETH/USDC" && prepared?.request.venue === "uniswap" && prepared.request.type === "swap" && prepared.request.symbol === symbol && prepared.account.chainId === 11155111 ? prepared : null;
  const quote = action?.quote;
  const [base, counter = "USDC"] = symbol.split("/");
  const output = action?.request.side === "buy" ? base : counter;
  const input = action?.request.nativeInput ? "ETH" : action?.request.side === "buy" ? counter : base;
  const expired = action ? now >= action.expiresAt : false;
  return <section className={styles.panel} aria-label="Swap execution details">
    <header className={styles.heading}><div><img src="/landing/brands/uniswap.svg" alt="Uniswap" width="22" height="22" /><h3>Swap details</h3><span className={styles.network}>Sepolia</span></div></header>
    <dl className={styles.swapRoute}><div><dt>Route</dt><dd>WETH / USDC</dd></div><div><dt>Execution</dt><dd>Uniswap V3 pool</dd></div><div><dt>Quote</dt><dd>{action && quote ? expired ? "Expired" : "Ready for review" : "Awaiting review"}</dd></div></dl>
    {action && quote ? <>
      <dl className={styles.swapDetails}>
        <div><dt>Exact input</dt><dd>{marketQuantity(quote.amountIn)} {input}</dd></div>
        <div><dt>Quoted output</dt><dd>{marketQuantity(quote.amountOut)} {output}</dd></div>
        <div><dt>Minimum output</dt><dd>{marketQuantity(quote.minimumOut)} {quote.minimumOut === undefined ? "" : output}</dd></div>
        <div><dt>Pool fee tier</dt><dd>{quote.fee ?? "Unavailable"}</dd></div>
        <div><dt>Slippage cap</dt><dd>{number(action.request.slippageBps / 100)}%</dd></div>
        <div><dt>Quote validity</dt><dd className={expired ? styles.warningText : undefined}>{expired ? "Expired. Review a fresh quote." : `${Math.max(0, Math.ceil((action.expiresAt - now) / 1_000))} seconds`}</dd></div>
      </dl>
    </> : <p className={styles.note}>Review a swap to see quoted output, minimum received and expiry.</p>}
    <details className={styles.contextDisclosure}><summary>How this swap works</summary><p className={styles.note}>Uniswap V3 swaps against pool liquidity, not a resting order book. This build supports the WETH / USDC single-pool route.</p><p className={styles.note}>Pool fees are separate from network gas. Minimum output is a transaction bound, not a guaranteed fill. {action?.request.nativeInput ? "Exact native ETH input wraps to WETH in the reviewed atomic smart-account operation." : action?.request.side === "sell" ? "WETH is swapped into USDC." : "Output is WETH, not native ETH."}</p><p className={styles.note}>Trades are public. This route does not provide MEV protection.</p></details>
    <p className={styles.warning}>Sepolia test assets. Quotes are not live-market valuations.</p>
  </section>;
}
