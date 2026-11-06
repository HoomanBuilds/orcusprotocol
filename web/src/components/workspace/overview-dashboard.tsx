"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { activityEntries, portfolioSummary } from "@/lib/workspace-model";
import { assetAmount, number, usd } from "@/lib/format";
import { balanceRole, venueName, venueNetwork, venuePresentation } from "@/lib/venue-presentation";
import { Address, Status } from "../trading/primitives";
import { AssetIcon, hasAssetIcon, ProtocolIcon } from "./asset-icon";
import styles from "./overview-dashboard.module.css";

export function OverviewDashboard() {
  const w = useWorkspace();
  const router = useRouter();
  const connected = Boolean(w.session.user);
  const accounts = connected ? w.session.accounts : [];
  const summary = portfolioSummary(w.portfolio, connected, Boolean(w.resourceErrors.portfolio));
  const pending = connected ? activityEntries({ actions: w.actions, requests: w.requests, budget: w.budget, payments: w.payments, funding: w.funding, deposits: w.tradingDeposits, allowances: w.ostiumAllowances }).filter(entry => entry.pending) : [];
  const agent = connected ? w.agentData?.agent ?? w.session.agent : undefined;
  const mode = w.resourceErrors.agent ? "Status unavailable" : !agent ? "Not connected" : agent.paused ? "Paused" : agent.mode === "autonomous" ? "Autonomous within limits" : "Approval required";
  const automations = connected ? w.automations : [];
  const positions = connected ? w.portfolio.positions : [];
  const orders = connected ? w.portfolio.orders : [];
  const budget = connected && !w.resourceErrors.budget ? w.budget : undefined;

  return <div className={`overview-page overview-editorial ${styles.page}`}>
    <header className={`workspace-page-header ${styles.header}`}>
      <div><h1>Overview</h1><p>Your accounts, markets and work in progress.</p></div>
      {connected ? <Link className="button secondary" href="/trade">Open terminal<ArrowUpRight size={15}/></Link> : <button className="button primary" type="button" disabled={w.connecting} onClick={() => void w.connect()}>{w.connecting ? "Confirm in wallet" : "Connect wallet"}</button>}
    </header>
    <section className={styles.metrics} aria-label="Trading account totals">
      <div><span>Trading equity</span><strong>{!connected ? "--" : summary.equity === undefined ? "Unavailable" : usd(summary.equity)}</strong><small>Reported testnet valuation</small></div>
      <div><span>Gross exposure</span><strong>{!connected ? "--" : summary.exposure === undefined ? "Unavailable" : usd(summary.exposure)}</strong><small>Open perpetual notional</small></div>
      <div><span>Unrealized P&amp;L</span><strong className={summary.pnl === undefined || summary.pnl === 0 ? "" : summary.pnl < 0 ? "negative" : "positive"}>{!connected ? "--" : summary.pnl === undefined ? "Unavailable" : usd(summary.pnl)}</strong><small>{!connected || summary.complete ? "Observed positions" : "Incomplete account snapshot"}</small></div>
      <div><span>Open orders</span><strong>{!connected ? "--" : summary.complete ? orders.length : "Unavailable"}</strong><small>{connected ? `${accounts.length} registered ${accounts.length === 1 ? "account" : "accounts"}` : "Across your accounts"}</small></div>
    </section>
    {!connected && <section className={styles.connectCard} aria-label="Connect your accounts"><div><span className={styles.eyebrow}>YOUR WORKSPACE</span><h2>All your accounts.<br/>One clear view.</h2><p>Balances, positions and your agent, together.</p></div><div className={styles.venueCollection}>{(["hyperliquid", "uniswap", "ostium"] as const).map(venue => <div key={venue}><ProtocolIcon name={venue} size={34}/><span>{venueName(venue)}</span><small>{venuePresentation[venue].marketType}</small></div>)}</div></section>}
    <div className={styles.columns}><div className={styles.main}>
      <section className="workspace-panel overview-market-watch"><div className="workspace-panel-heading"><div><h2>Market watch</h2><p>{venueNetwork(w.venue)} / public snapshots</p></div><Link className="text-link" href="/trade">Trade<ArrowUpRight size={14}/></Link></div>{w.markets.length ? <div className="overview-market-cards">{w.markets.filter(market => hasAssetIcon(market.symbol)).slice(0, 6).map(market => <button key={market.symbol} type="button" onClick={() => { w.setSymbol(market.symbol); router.push("/trade"); }}><div><AssetIcon symbol={market.symbol} size={30}/><strong>{market.symbol}</strong><ArrowUpRight size={14}/></div><span>{market.midPrice ? usd(market.midPrice) : "Unavailable"}</span><small className={market.change24h === undefined ? "muted" : market.change24h < 0 ? "negative" : "positive"}>{market.change24h === undefined ? "24h change unavailable" : `${market.change24h >= 0 ? "+" : ""}${number(market.change24h)}% / 24h`}</small></button>)}</div> : <p className="compact-empty">{w.marketError ? "Market feed unavailable. Open Trade to refresh." : "Loading venue snapshots..."}</p>}</section>
      {connected && <><section className={`${styles.section} ${styles.accountsSection}`} aria-labelledby="overview-accounts">
        <div className={styles.sectionHeading}><h2 id="overview-accounts">Trading accounts</h2><Link className="text-link" href="/settings?section=accounts">{accounts.length ? "Manage accounts" : "Account setup"}</Link></div>
        {!accounts.length ? <p className={styles.empty}>No trading accounts added yet.</p> : <div className={styles.accountGrid}>{accounts.map(account => {
          const balances = w.portfolio.balances.filter(item => item.accountId === account.id);
          const accountPositions = positions.filter(item => item.accountId === account.id);
          const accountOrders = orders.filter(item => item.accountId === account.id);
          const unavailable = !summary.observed || !w.portfolio.accounts.some(item => item.id === account.id) || Boolean(w.resourceErrors.portfolio) || Boolean(w.portfolio.errors?.some(item => item.accountId === account.id));
          const accountSummary = portfolioSummary({ ...w.portfolio, positions: accountPositions, errors: [] }, connected, unavailable);
          return <div className={styles.account} key={account.id}>
            <div className={styles.accountHeading}><ProtocolIcon name={account.venue} size={28}/><div><h3>{venueName(account.venue)}</h3><small>{venueNetwork(account.venue)}</small></div><Status value={account.status}/></div>
            <div className={styles.accountDetails}><Address value={account.address} explorer={venuePresentation[account.venue].explorer}/><span>{unavailable ? "Snapshot unavailable" : `${accountPositions.length} positions / ${accountOrders.length} orders`}</span>{account.venue !== "uniswap" && <span>Exposure <b>{accountSummary.exposure === undefined ? "Unavailable" : usd(accountSummary.exposure)}</b></span>}</div>
            {balances.length ? <div className={styles.balances}>{balances.map(balance => <div className={styles.balance} key={`${balance.symbol}:${balance.tokenAddress ?? "native"}`}><AssetIcon symbol={balance.symbol} size={22}/><div><strong>{balance.symbol}</strong><small>{balanceRole(account.venue, balance.symbol)}</small></div><div><strong>{assetAmount(balance.amount, balance.symbol)}</strong><small>{balance.usdValue === undefined ? "Value unavailable" : usd(balance.usdValue)}</small></div></div>)}</div> : <p className={styles.empty}>{unavailable ? "Balances unavailable. Refresh to check again." : "No balances reported."}</p>}
          </div>;
        })}</div>}
      </section>
      <section className={styles.section} aria-labelledby="overview-positions">
        <div className={styles.sectionHeading}><h2 id="overview-positions">Positions &amp; orders</h2><Link className="text-link" href="/trade">Manage in terminal</Link></div>
        {positions.length + orders.length === 0 ? <p className={styles.empty}>{!connected ? "Connect to view positions and orders." : !accounts.length ? "Add a trading account to get started." : !summary.complete ? "Waiting for a complete account snapshot." : "No open positions or orders."}</p> : <>
          {!summary.complete && <p className={styles.snapshot}>Partial snapshot. Other positions or orders may be unavailable.</p>}
          {positions.slice(0, 5).map(position => <button className={styles.tradingRow} type="button" key={`position:${position.id}`} onClick={() => { w.selectMarket(position.venue, position.symbol); router.push("/trade"); }}>
            <AssetIcon symbol={position.symbol} size={26}/><div><strong>{position.symbol} <span className={position.side === "long" ? "positive" : "negative"}>{position.side}</span></strong><small>{venueName(position.venue)} / {assetAmount(position.size, position.symbol)}</small></div><div><strong className={Number(position.unrealizedPnl) < 0 ? "negative" : Number(position.unrealizedPnl) > 0 ? "positive" : ""}>{usd(position.unrealizedPnl)}</strong><small>Unrealized P&amp;L</small></div>
          </button>)}
          {orders.slice(0, 5).map(order => <button className={styles.tradingRow} type="button" key={`order:${order.id}`} onClick={() => { w.selectMarket(order.venue, order.symbol); router.push("/trade"); }}>
            <AssetIcon symbol={order.symbol} size={26}/><div><strong>{order.symbol} <span>{order.side} / {order.type}</span></strong><small>{venueName(order.venue)}{order.reduceOnly ? " / Reduce only" : ""}</small></div><div><strong>{order.amountUnit === "collateral-usdc" ? `${assetAmount(order.collateralUsd ?? order.size, "USDC")} collateral` : assetAmount(order.size, order.symbol)}</strong><small>{order.price === undefined ? "Price unavailable" : `Price ${usd(order.price)}`}</small></div>
          </button>)}
          {(positions.length > 5 || orders.length > 5) && <Link className="text-link" href="/trade">View all positions and orders</Link>}
        </>}
      </section></>}
    </div>{connected && <aside className={styles.aside}>
      <section className={styles.section} aria-labelledby="overview-pending"><div className={styles.sectionHeading}><h2 id="overview-pending">In progress</h2><Link className="text-link" href="/activity?status=pending">Activity</Link></div>
        {pending.length ? <div className={styles.list}>{pending.slice(0, 4).map(entry => <Link key={entry.id} href={`/activity?item=${encodeURIComponent(entry.id)}&status=pending`}><div><strong>{entry.title}</strong><small>{entry.description}</small></div><Status value={entry.status}/></Link>)}</div> : <p className={styles.empty}>{!connected ? "Connect to view saved activity." : Object.keys(w.resourceErrors).length ? "Some activity sources are unavailable." : "No pending work."}</p>}
      </section>
      <section className={`${styles.section} ${styles.agentCard}`} aria-labelledby="overview-agent"><div className={styles.sectionHeading}><h2 id="overview-agent">Agent</h2><Link className="text-link" href="/agent">Open chat</Link></div><div className={styles.agentState}><span className={styles.stateDot} data-paused={!agent || agent.paused || Boolean(w.resourceErrors.agent)}/><strong>{mode}</strong></div><p className={styles.agentNote}>{agent?.paused ? "No new agent actions while paused." : agent?.mode === "autonomous" ? "Execution stays within your active permissions." : "Review proposed actions before execution."}</p>
        <div className={styles.sectionHeading}><h3>Automations</h3><span>{!connected ? "Not connected" : w.resourceErrors.automations ? "Unavailable" : `${automations.filter(item => item.status === "active").length} active`}</span></div>
        {automations.length ? <div className={styles.list}>{automations.slice(0, 3).map(automation => <Link key={automation.id} href={`/automations#${encodeURIComponent(automation.id)}`}><div><strong>{automation.name}</strong><small>{automation.kind === "alert" ? "Price alert" : "Trading strategy"}</small></div><Status value={automation.status}/></Link>)}</div> : <p className={styles.empty}>{!connected ? "Connect to view your strategies." : w.resourceErrors.automations ? "Schedules could not be loaded." : "No schedules created."}</p>}
        <Link className="text-link" href="/automations">Manage automations</Link>
      </section>
      <section className={`${styles.section} ${styles.budgetCard}`} aria-labelledby="overview-budget"><div className={styles.sectionHeading}><h2 id="overview-budget">Operating allowance</h2><Link className="text-link" href="/settings?section=agent">Manage</Link></div><strong className={styles.allowance}>{budget ? usd(budget.availableUsd) : "Unavailable"}</strong><p className={styles.agentNote}>Agent expense cap, separate from trading capital.</p><dl className={styles.budget}><div><dt>Spent</dt><dd>{budget ? usd(budget.spentUsd) : "Unavailable"}</dd></div><div><dt>Reserved</dt><dd>{budget ? usd(budget.reservedUsd) : "Unavailable"}</dd></div></dl></section>
    </aside>}</div>
  </div>;
}
