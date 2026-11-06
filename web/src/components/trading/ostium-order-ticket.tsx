"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Workspace } from "@/lib/use-workspace";
import { ostiumEntryRequest, type OstiumEntryDraft } from "@/lib/ostium-ux";
import { assetAmount, usd } from "@/lib/format";
import { AssetIcon } from "../workspace/asset-icon";
import { Field, InlineError, Spinner } from "./primitives";

const initialDraft: OstiumEntryDraft = { type: "market", side: "buy", amount: "", leverage: "1", price: "", takeProfit: "", stopLoss: "", slippage: "0.5", isDayTrade: false };

export function OstiumOrderTicket({ workspace: w, onSetup }: { workspace: Workspace; onSetup: () => void }) {
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const market = w.activeMarket;
  const [base, quote = "USD"] = w.symbol.split("/");
  const balance = w.portfolio.balances.find(item => item.accountId === w.account?.id && item.symbol === "USDC");
  const unresolved = w.actions.some(action => action.accountId === w.account?.id && (["submitting", "submitted-unknown"].includes(action.status) || action.approvals?.some(step => ["submitting", "pending", "submitted-unknown"].includes(step.status))));
  const available = market?.tradable === true && Boolean(market.midPrice);
  const notional = Number(draft.amount) > 0 && Number(draft.leverage) > 0 ? Number(draft.amount) * Number(draft.leverage) : undefined;
  const set = <Key extends keyof OstiumEntryDraft>(key: Key, value: OstiumEntryDraft[Key]) => { setDraft(current => ({ ...current, [key]: value })); setError(null); };

  useEffect(() => { setDraft({ ...initialDraft, leverage: String(market?.minLeverage ?? 1) }); setError(null); }, [w.symbol, w.account?.id]);

  function review() {
    if (!w.account) { onSetup(); return; }
    try { const request = ostiumEntryRequest(w.account, market, draft); void w.prepare(request); }
    catch (cause) { setError(cause && typeof cause === "object" && "issues" in cause ? "Check the collateral, leverage, price and protection levels." : cause instanceof Error ? cause.message : "Check this order before review."); }
  }

  return <section className="order-ticket ostium-order-ticket" aria-label="Ostium order ticket">
    <div className="section-title"><h2>Place an order</h2><span className="ticket-network-label">Arbitrum Sepolia</span></div>
    <div className="segmented side-toggle"><button type="button" className={draft.side === "buy" ? "selected buy" : ""} onClick={() => set("side", "buy")}>Long / Buy</button><button type="button" className={draft.side === "sell" ? "selected sell" : ""} onClick={() => set("side", "sell")}>Short / Sell</button></div>
    <div className="order-type-tabs">{(["market", "limit", "stop"] as const).map(type => <button key={type} type="button" aria-pressed={draft.type === type} className={draft.type === type ? "selected" : ""} onClick={() => set("type", type)}>{type === "stop" ? "Stop entry" : type === "market" ? "Market" : "Limit"}</button>)}</div>
    {!available && <p className="warning-note" role="status">{market?.unavailableReason ?? "A current, open testnet market is required for a new entry."}</p>}
    <Field label="Collateral (USDC)" hint="This is collateral, not base-asset size or notional exposure."><div className="amount-input"><input aria-label="Ostium collateral amount" inputMode="decimal" value={draft.amount} onChange={event => set("amount", event.target.value)} placeholder="0.00"/><span><AssetIcon symbol="USDC" size={21}/>USDC</span></div></Field>
    <div className="form-grid"><Field label="Leverage"><div className="amount-input compact"><input aria-label="Ostium leverage" inputMode="decimal" value={draft.leverage} onChange={event => set("leverage", event.target.value)}/><span>x</span></div></Field><Field label="Estimated notional"><output className="ticket-notional-output">{usd(notional)}</output></Field></div>
    <p className="fine-print">{market?.minLeverage !== undefined && market.maxLeverage !== undefined ? `Current pair range: ${market.minLeverage}x to ${market.maxLeverage}x.` : "Pair leverage limits unavailable."}{market?.overnightMaxLeverage !== undefined && market.overnightMaxLeverage > 0 ? ` Overnight maximum: ${market.overnightMaxLeverage}x.` : ""}</p>
    <label className="checkbox"><input type="checkbox" checked={draft.isDayTrade} onChange={event => set("isDayTrade", event.target.checked)}/>Day-trade position</label>
    {draft.isDayTrade && <p className="warning-note">Day trades have venue-defined closing restrictions. Review the actual market schedule and final preview.</p>}
    {draft.type !== "market" && <Field label={`${draft.type === "limit" ? "Limit" : "Stop-entry"} price (${quote} per ${base})`}><input aria-label="Ostium entry price" inputMode="decimal" value={draft.price} onChange={event => set("price", event.target.value)} placeholder="Entry price"/></Field>}
    <details className="technical-limits ticket-protection"><summary>Take-profit &amp; stop-loss</summary><Field label={`Take-profit (${quote} per ${base})`}><input inputMode="decimal" value={draft.takeProfit} onChange={event => set("takeProfit", event.target.value)} placeholder="Optional"/></Field><Field label={`Stop-loss (${quote} per ${base})`}><input inputMode="decimal" value={draft.stopLoss} onChange={event => set("stopLoss", event.target.value)} placeholder="Optional"/></Field><p className="fine-print">Leave blank to omit. Protection levels do not guarantee an execution price.</p></details>
    <Field label="Slippage tolerance"><div className="slippage"><input aria-label="Ostium slippage percentage" inputMode="decimal" value={draft.slippage} onChange={event => set("slippage", event.target.value)}/><span>%</span><span className="muted">Max 5%</span></div></Field>
    <div className="ticket-summary"><div><span>Available collateral</span><span>{balance ? assetAmount(balance.amount, "USDC") : "Unavailable"}</span></div><div><span>Network gas</span><span>Owner-paid Arbitrum Sepolia ETH</span></div><div><span>Allowance</span><span>Exact USDC approval if required</span></div></div>
    <p className="ticket-safety-copy">Leveraged price exposure, not ownership of {base}. Approval and trade are separate transactions. Fees and oracle status are checked at review.</p>
    {unresolved && <p className="warning-note">An earlier wallet submission is unresolved. <Link className="text-link" href="/activity?status=pending">Recover the saved action</Link> before opening another wallet request.</p>}
    <InlineError message={error}/>
    {!w.session.user ? <button className="button primary full" type="button" disabled={w.connecting} onClick={() => void w.connect()}>Connect wallet to trade</button> : !w.account ? <button className="button primary full" type="button" onClick={onSetup}>Add Ostium account</button> : <button className="button primary full" type="button" disabled={w.preparing || w.executing || unresolved || !available || !draft.amount || !draft.leverage} onClick={review}>{w.preparing ? <Spinner/> : null}{w.preparing ? "Preparing review..." : "Review order"}</button>}
  </section>;
}
