"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { tradeRequestSchema } from "@orcus/core";
import { Clock3, GitBranch, Plus, Power, ShieldCheck } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError } from "@/lib/api";
import { time, usd } from "@/lib/format";
import { automationControl, automationFailure } from "@/lib/automation-ux";
import { executionLabel, reviewAutomation, type ExecutionMode, type ReviewedAutomation } from "@/lib/automation-review";
import { ostiumEntryRequest } from "@/lib/ostium-ux";
import { actionReviewLabel } from "@/lib/trade-ux";
import { AutomationPolicySummary } from "./automation-review-card";
import { Badge, Field, InlineError, Spinner, Status } from "../trading/primitives";

type Kind = "strategy" | "dca" | "alert";
const starters = [
  { id: "alert", label: "Price alert", when: "A price meets your threshold", then: "Notify you. No trade.", description: "Monitor a market without granting execution authority." },
  { id: "dca", label: "Scheduled trade", when: "Your chosen interval", then: "Submit your exact trade", description: "Repeat a bounded trade a finite number of times." },
  { id: "strategy", label: "Conditional trade", when: "Your price condition is met", then: "Submit your approved action", description: "Choose the trigger, action and stopping rule yourself." },
] as const;

export function AutomationsView({ workspace: w }: { workspace: Workspace }) {
  return <AutomationWorkspace key={w.session.user?.id ?? "guest"} workspace={w}/>;
}

function AutomationWorkspace({ workspace: w }: { workspace: Workspace }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false), [name, setName] = useState(""), [accountId, setAccountId] = useState("");
  const [interval, setIntervalValue] = useState("300"), [kind, setKind] = useState<Kind>("strategy");
  const [symbol, setSymbol] = useState("ETH"), [amount, setAmount] = useState(""), [side, setSide] = useState<"buy" | "sell">("buy");
  const [operator, setOperator] = useState<"above" | "below">("above"), [threshold, setThreshold] = useState("");
  const [leverage, setLeverage] = useState("1"), [dayTrade, setDayTrade] = useState(false);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("once"), [maxExecutions, setMaxExecutions] = useState("1"), [hours, setHours] = useState("24");
  const [draft, setDraft] = useState<ReviewedAutomation | null>(null), [requestKey, setRequestKey] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; createdAt: number; readAt?: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const owner = w.session.user?.id ?? "", ownerRef = useRef(owner); ownerRef.current = owner;
  useEffect(() => { ownerRef.current = owner; return () => { ownerRef.current = ""; }; }, [owner]);
  const selectedAccount = w.session.accounts.find(account => account.id === (accountId || w.account?.id || w.session.accounts[0]?.id));
  const native = selectedAccount?.venue === "ostium", spot = selectedAccount?.venue === "uniswap";
  const nativeMarkets = w.markets.filter(market => market.venue === "ostium");
  const selectedMarket = w.markets.find(market => market.symbol === symbol && market.venue === selectedAccount?.venue);
  const conditionQuote = selectedMarket?.quoteAsset ?? (native ? symbol.split("/")[1] : "USD") ?? "USD";
  const grant = w.agentData?.permissions.find(item => item.accountId === selectedAccount?.id && item.status === "active" && item.expiresAt > Date.now());

  useEffect(() => { setCreating(false); setDraft(null); setName(""); setAccountId(""); setAmount(""); setThreshold(""); setNotifications([]); setError(null); setBusy(null); setRequestKey(null); busyRef.current = false; }, [owner]);
  useEffect(() => { if (selectedAccount && w.venue !== selectedAccount.venue) w.setVenue(selectedAccount.venue); }, [selectedAccount?.id, selectedAccount?.venue, w.venue, w.setVenue]);
  useEffect(() => {
    if (!native || !nativeMarkets.length || nativeMarkets.some(market => market.symbol === symbol)) return;
    const first = nativeMarkets.find(market => market.symbol === w.symbol) ?? nativeMarkets.find(market => market.tradable) ?? nativeMarkets[0];
    setSymbol(first.symbol); setLeverage(String(first.minLeverage ?? 1)); setDraft(null);
  }, [native, w.markets, w.symbol, symbol]);
  useEffect(() => {
    let active = true;
    if (!owner) return;
    const load = () => api<{ notifications: typeof notifications }>("/api/notifications").then(result => { if (active) setNotifications(result.notifications); }).catch(cause => { if (active) setError(displayError(cause)); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 12000);
    return () => { active = false; clearInterval(timer); };
  }, [owner]);

  function begin(next: Kind) {
    setKind(next); setDraft(null); setRequestKey(null); setError(null);
    setExecutionMode(next === "dca" ? "recurring" : "once"); setMaxExecutions(next === "dca" ? "10" : "1"); setCreating(true);
  }
  function review() {
    setError(null);
    try {
      if (!selectedAccount) throw new Error("Choose a connected account first.");
      const lifetime = Number(hours);
      if (!Number.isFinite(lifetime) || lifetime < 1 || lifetime > 720) throw new Error("Choose an expiry between 1 and 720 hours.");
      const request = kind === "alert" ? undefined : native
        ? { ...ostiumEntryRequest(selectedAccount, selectedMarket, { type: "market", side, amount, leverage, isDayTrade: dayTrade, price: "", takeProfit: "", stopLoss: "", slippage: "0.5" }), mode: "agent" }
        : tradeRequestSchema.parse({ accountId: selectedAccount.id, venue: selectedAccount.venue, type: spot ? "swap" : "market", symbol: spot ? "WETH/USDC" : symbol.trim().toUpperCase(), side, amount, slippageBps: 50, reduceOnly: false, mode: "agent" });
      const expiresAt = Math.min(Date.now() + lifetime * 3_600_000, kind === "alert" ? Infinity : grant?.expiresAt ?? Infinity);
      const proposal = reviewAutomation({ kind: kind === "alert" ? "alert" : "trade", name, accountId: selectedAccount.id, intervalSeconds: Number(interval), executionMode, maxExecutions: executionMode === "once" ? 1 : Number(maxExecutions), expiresAt, ...(request ? { request } : {}), ...(kind !== "dca" ? { condition: { symbol: spot ? "ETH" : symbol.trim().toUpperCase(), operator, price: threshold } } : {}) }, w.session.accounts);
      setDraft(proposal); setRequestKey(crypto.randomUUID());
    } catch (cause) { setError(displayError(cause)); }
  }
  async function create() {
    if (!draft || !requestKey || busyRef.current || !owner) return;
    busyRef.current = true; setBusy("create"); setError(null);
    try {
      const current = reviewAutomation(draft, w.session.accounts);
      await api("/api/automations", { method: "POST", headers: { "Idempotency-Key": requestKey }, body: JSON.stringify(current) });
      if (ownerRef.current !== owner) return;
      setCreating(false); setDraft(null); setName(""); setRequestKey(null); await w.refresh();
    } catch (cause) { if (ownerRef.current === owner) setError(displayError(cause)); }
    finally { if (ownerRef.current === owner) { busyRef.current = false; setBusy(null); } }
  }
  async function mutate(id: string, path: string, body: object) {
    if (busyRef.current || !owner) return;
    busyRef.current = true; setBusy(id); setError(null);
    try {
      await api(path, { method: "PATCH", body: JSON.stringify(body) });
      if (ownerRef.current !== owner) return;
      if (path.includes("notifications")) setNotifications(current => current.map(item => item.id === id ? { ...item, readAt: Date.now() } : item));
      else await w.refresh();
    } catch (cause) { if (ownerRef.current === owner) setError(displayError(cause)); }
    finally { if (ownerRef.current === owner) { busyRef.current = false; setBusy(null); } }
  }

  return <section className="workspace-page">
    <div className="page-heading"><div><h1>Automations</h1><p>Clear rules. Bounded actions. Always under your control.</p></div><button className="button primary" type="button" disabled={!owner || !w.session.accounts.length || !!busy} onClick={() => creating ? setCreating(false) : begin("strategy")}><Plus size={15}/>New automation</button></div>
    <div className="automation-runner-notice"><strong>CRE local runner</strong> / {w.health?.cre.ready ? "Configured for local evaluations." : "Unavailable. Configure the runner before activating an automation."} Not hosted DON execution.</div>
    <InlineError message={error}/>
    {creating && <div className="automation-form">
      <div className="automation-form-heading"><div><span className="eyebrow">{draft ? "02 / REVIEW" : "01 / CONFIGURE"}</span><h2>{draft ? "Your exact execution policy" : "Build an explicit rule"}</h2></div><Badge>{draft ? "Not active yet" : "Testnet"}</Badge></div>
      {draft ? <><AutomationPolicySummary draft={draft} accountLabel={`${selectedAccount?.venue} / ${selectedAccount?.address.slice(0, 8)}...`}/><p className="fine-print">{draft.executionMode === "on-crossing" ? "The first observation arms this rule without firing. Only a later false-to-true crossing can trigger it." : draft.executionMode === "once" ? draft.kind === "alert" ? "Stops after one notification." : "Stops after one submission. An uncertain result will not be automatically retried." : draft.kind === "alert" ? "Notifies on the first match, then waits for a false observation before it can notify again." : "While eligible, this exact action repeats until its run limit or expiry. Each submission counts even if settlement is uncertain."}</p><p className="fine-print">{draft.kind === "alert" ? "No trading authority is granted." : `Current grant cap: ${usd(grant?.maxTradeUsd)} per trade. Available operating allowance: ${usd(w.budget?.availableUsd)}. Fees, balance and authority are checked again before submission.`}</p></> : <>
        <div className="form-grid">
          <Field label="Automation type"><select value={kind} onChange={event => begin(event.target.value as Kind)}><option value="strategy">Conditional trade</option><option value="dca">Scheduled trade</option><option value="alert">Read-only price alert</option></select></Field>
          <Field label="Name"><input value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="My ETH rule"/></Field>
          <Field label="Trading account"><select value={selectedAccount?.id ?? ""} onChange={event => setAccountId(event.target.value)}>{w.session.accounts.map(account => <option value={account.id} key={account.id}>{account.venue} / {account.address.slice(0, 8)}...</option>)}</select></Field>
          <Field label={spot ? "Market" : "Instrument"}>{native ? <select aria-label="Ostium automation market" value={symbol} onChange={event => setSymbol(event.target.value)}>{!nativeMarkets.some(market => market.symbol === symbol) && <option value={symbol}>{symbol} (unavailable)</option>}{nativeMarkets.map(market => <option key={market.symbol} value={market.symbol}>{market.symbol}{market.tradable === false ? " (currently read-only)" : ""}</option>)}</select> : <input value={spot ? "WETH/USDC" : symbol} readOnly={spot} onChange={event => setSymbol(event.target.value)} maxLength={50}/>}</Field>
          {kind !== "alert" && <><Field label="Direction"><select value={side} onChange={event => setSide(event.target.value as typeof side)}><option value="buy">Buy</option><option value="sell">Sell</option></select></Field><Field label={spot ? `Amount paid (${side === "buy" ? "USDC" : "WETH"})` : native ? "USDC collateral per submission" : "Base asset amount per submission"}><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)}/></Field></>}
          {kind !== "dca" && <><Field label={kind === "alert" ? "Notify when price is" : "Execute when price is"}><select value={operator} onChange={event => setOperator(event.target.value as typeof operator)}><option value="above">Above</option><option value="below">Below</option></select></Field><Field label={`Threshold (${conditionQuote} per ${spot ? "ETH" : selectedMarket?.baseAsset ?? symbol.split("/")[0]})`}><input value={threshold} inputMode="decimal" onChange={event => setThreshold(event.target.value)}/></Field></>}
          {native && kind !== "alert" && <><Field label="Leverage"><input inputMode="decimal" value={leverage} onChange={event => setLeverage(event.target.value)}/></Field><label className="checkbox"><input type="checkbox" checked={dayTrade} onChange={event => setDayTrade(event.target.checked)}/>Day-trade position</label></>}
        </div>
        <div className="automation-policy-fields"><h3>When it runs and stops</h3><div className="form-grid">
          <Field label="Execution mode"><select value={executionMode} onChange={event => { const mode = event.target.value as ExecutionMode; setExecutionMode(mode); setMaxExecutions(mode === "once" ? "1" : "10"); }}><option value="once">Run once</option><option value="recurring">{kind === "alert" ? "Notify on match, then after rearming" : "Repeat while eligible"}</option>{kind !== "dca" && <option value="on-crossing">On a new threshold crossing</option>}</select></Field>
          <Field label="Maximum executions"><input type="number" min="1" max="1000" step="1" value={executionMode === "once" ? "1" : maxExecutions} disabled={executionMode === "once"} onChange={event => setMaxExecutions(event.target.value)}/></Field>
          <Field label="Evaluation interval"><select value={interval} onChange={event => setIntervalValue(event.target.value)}><option value="60">Every minute</option><option value="300">Every 5 minutes</option><option value="900">Every 15 minutes</option><option value="3600">Hourly</option><option value="86400">Daily</option></select></Field>
          <Field label="Expires after (hours)" hint="A trade rule cannot outlive its permission."><input type="number" min="1" max="720" value={hours} onChange={event => setHours(event.target.value)}/></Field>
        </div></div>
        <p className="fine-print">Only the structured rule above controls execution. Use Agent for RSI, news and broader research; prose alone cannot activate an unattended strategy.</p>
      </>}
      {kind !== "alert" && !grant && <p className="warning-note">Authorize this account in Settings before activating a trading rule.</p>}
      <div className="form-actions"><button className="button secondary" type="button" disabled={!!busy} onClick={() => draft ? setDraft(null) : setCreating(false)}>{draft ? "Edit rule" : "Cancel"}</button><button className="button primary" type="button" disabled={!!busy || !owner || !selectedAccount || !name.trim() || (draft !== null && (!w.health?.cre.ready || kind !== "alert" && !grant))} onClick={() => draft ? void create() : review()}>{busy === "create" ? <Spinner/> : <ShieldCheck size={15}/>} {draft ? "Approve and activate" : "Review rule"}</button></div>
    </div>}
    {!!notifications.length && <div className="automation-list"><h2>Price notifications</h2>{notifications.slice(0, 20).map(item => <article className="automation-card" key={item.id}><p>{item.message}</p><small>{time(item.createdAt)}</small>{!item.readAt && <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void mutate(item.id, `/api/notifications/${item.id}`, { read: true })}>Mark read</button>}</article>)}</div>}
    {!w.automations.length ? <div className="automation-starters">{starters.map((item, index) => <button className={`automation-starter ${item.id}`} type="button" key={item.id} disabled={w.connecting || !!busy} onClick={() => { if (!owner) { void w.connect(); return; } if (!w.session.accounts.length) { router.push("/settings?section=accounts"); return; } begin(item.id); }}><div className="automation-starter-top"><span>0{index + 1}</span><strong>{item.label}</strong></div><div className="automation-rule-preview"><span>WHEN</span><p>{item.when}</p><i/><span>THEN</span><p>{item.then}</p></div><p>{item.description}</p><span className="automation-starter-action">{!owner ? "Connect to configure" : !w.session.accounts.length ? "Set up account" : "Configure automation"}<Plus size={16}/></span></button>)}</div> : <div className="automation-list">{w.automations.map(job => {
      const control = automationControl(job, !!w.agentData?.agent.paused);
      return <article className="automation-card" key={job.id} id={job.id}>
        <div className="automation-top"><span className="automation-icon"><GitBranch size={18}/></span><div><h2>{job.name}</h2><span><Clock3 size={12}/>Every {Math.round(job.intervalSeconds / 60)} min / {control.status === "active" ? `next ${time(job.nextRunAt)}` : "not scheduled"}</span></div><Status value={control.status}/><button className="icon-button" type="button" aria-label={control.label} title={control.detail} disabled={!!busy || control.disabled} onClick={() => void mutate(job.id, `/api/automations/${job.id}`, { status: job.status === "active" ? "paused" : "active" })}>{busy === job.id ? <Spinner/> : <Power size={15}/>}</button></div>
        <div className="automation-policy-chips"><Badge>{executionLabel(job.executionMode, job.kind)}</Badge><span>{job.executionCount ?? 0} / {job.maxExecutions ?? "?"} {job.kind === "alert" ? "notifications" : "submissions"}</span>{job.condition && <span>{job.condition.symbol} {job.condition.operator} {job.condition.price}</span>}</div>
        {job.request && <p>{actionReviewLabel(job.request)} / {job.request.type} / {job.request.symbol} / {job.request.venue}</p>}
        {job.expiresAt && <small>Expires {time(job.expiresAt)}</small>}<p className="fine-print">{control.detail}</p><InlineError message={automationFailure(job)}/>
        {job.lastOutcome && <div className="evaluation"><span className="eyebrow">ACTUAL OUTCOME</span><div><Status value={job.lastOutcome.status}/><time>{time(job.lastOutcome.observedAt)}</time></div><p>{job.lastOutcome.reason}</p>{job.lastOutcome.actionId && <a href={`/activity?item=${encodeURIComponent(`action:${job.lastOutcome.actionId}`)}`}>View submitted action</a>}</div>}
        {job.lastEvaluation ? <details className="evaluation technical-limits"><summary>Latest CRE evaluation, not settlement proof</summary><div><Status value={job.lastEvaluation.decision}/><Badge>{job.lastEvaluation.source}</Badge><time>{time(job.lastEvaluation.observedAt)}</time></div><p>{job.lastEvaluation.reason}</p><code>{job.lastEvaluation.id}</code>{job.lastEvaluation.requestId && <small>0G request: {job.lastEvaluation.requestId}</small>}</details> : <div className="evaluation muted">No evaluation received yet.</div>}
      </article>;
    })}</div>}
  </section>;
}
