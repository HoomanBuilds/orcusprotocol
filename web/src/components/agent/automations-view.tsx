"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { tradeRequestSchema } from "@orcus/core";
import { Clock3, GitBranch, Plus, Power, ShieldCheck } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError } from "@/lib/api";
import { time } from "@/lib/format";
import { automationControl, automationFailure } from "@/lib/automation-ux";
import { ostiumEntryRequest } from "@/lib/ostium-ux";
import {
  Badge,
  Empty,
  Field,
  InlineError,
  Spinner,
  Status,
} from "../trading/primitives";

export function AutomationsView({ workspace: w }: { workspace: Workspace }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [accountId, setAccountId] = useState("");
  const [interval, setIntervalValue] = useState("300");
  const [kind, setKind] = useState<"strategy" | "dca" | "alert">("strategy");
  const [symbol, setSymbol] = useState("ETH");
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [operator, setOperator] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState("");
  const [leverage, setLeverage] = useState("1");
  const [dayTrade, setDayTrade] = useState(false);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; createdAt: number; readAt?: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const selectedAccount = w.session.accounts.find(account => account.id === (accountId || w.account?.id || w.session.accounts[0]?.id));
  const native = selectedAccount?.venue === "ostium";
  const nativeMarkets = w.markets.filter(market => market.venue === "ostium");
  const selectedMarket = w.markets.find(market => market.symbol === symbol && market.venue === selectedAccount?.venue);
  const conditionQuote = selectedMarket?.quoteAsset ?? (native ? symbol.split("/")[1] : "USD") ?? "USD";

  useEffect(() => { if (selectedAccount && w.venue !== selectedAccount.venue) w.setVenue(selectedAccount.venue); }, [selectedAccount?.id, selectedAccount?.venue, w.venue, w.setVenue]);
  useEffect(() => {
    if (!native || !nativeMarkets.length || symbol.includes("/") || nativeMarkets.some(market => market.symbol === symbol)) return;
    const first = nativeMarkets.find(market => market.symbol === w.symbol) ?? nativeMarkets.find(market => market.tradable) ?? nativeMarkets[0];
    setSymbol(first.symbol); setLeverage(String(first.minLeverage ?? 1)); setRequestKey(null);
  }, [native, w.markets, w.symbol, symbol]);

  useEffect(() => {
    let active = true;
    if (!w.session.user) { setNotifications([]); return; }
    const load = () => api<{ notifications: typeof notifications }>("/api/notifications").then(result => { if (active) setNotifications(result.notifications); }).catch(cause => { if (active) setError(displayError(cause)); });
    void load();
    const timer = setInterval(() => void load(), 12000);
    return () => { active = false; clearInterval(timer); };
  }, [w.session.user?.id]);

  async function create() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("create");
    setError(null);
    try {
      if (!selectedAccount) throw new Error("Choose a connected account first.");
      const key = requestKey ?? crypto.randomUUID();
      setRequestKey(key);
      const request = kind === "dca" ? native ? { ...ostiumEntryRequest(selectedAccount, selectedMarket, { type: "market", side, amount, leverage, isDayTrade: dayTrade, price: "", takeProfit: "", stopLoss: "", slippage: "0.5" }), mode: "agent" } : tradeRequestSchema.parse({ accountId: selectedAccount.id, venue: selectedAccount.venue, type: selectedAccount.venue === "uniswap" ? "swap" : "market", symbol: selectedAccount.venue === "uniswap" ? "WETH/USDC" : symbol.trim().toUpperCase(), side, amount, slippageBps: 50, reduceOnly: false, mode: "agent" }) : undefined;
      await api("/api/automations", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({
        kind: kind === "alert" ? "alert" : "trade",
        name,
        instruction: kind === "strategy" ? instruction : undefined,
        accountId: selectedAccount.id,
        intervalSeconds: Number(interval),
        ...(request ? { request } : {}),
        ...(kind === "alert" ? { condition: { symbol: symbol.trim().toUpperCase(), operator, price: threshold } } : {}),
      }) });
      setCreating(false);
      setName("");
      setInstruction("");
      setRequestKey(null);
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function readNotification(id: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    setError(null);
    try {
      await api(`/api/notifications/${id}`, { method: "PATCH", body: JSON.stringify({ read: true }) });
      setNotifications(current => current.map(item => item.id === id ? { ...item, readAt: Date.now() } : item));
    } catch (cause) { setError(displayError(cause)); }
    finally { busyRef.current = false; setBusy(null); }
  }

  async function toggle(id: string, status: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    setError(null);
    try {
      await api(`/api/automations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: status === "active" ? "paused" : "active",
        }),
      });
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <section className="workspace-page">
      <div className="page-heading">
        <div>
          <h1>Automations</h1>
          <p>
            Conditions you choose. Authority you control.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!w.session.user || !w.session.accounts.length || !!busy}
          onClick={() => { setRequestKey(null); setCreating((value) => !value); }}
        >
          <Plus size={15} />
          New automation
        </button>
      </div>
      <div className="automation-runner-notice">
        <span>
          <strong>CRE local runner</strong> / {w.health?.cre.ready ? "Configured for local evaluations." : "Unavailable. Conditional strategies cannot evaluate until the runner is configured."} Not hosted DON execution.
        </span>
      </div>
      <InlineError message={error} />
      {creating && (
        <div className="automation-form">
          <h2>New approved strategy</h2>
          <div className="form-grid">
            <Field label="Automation type">
              <select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setRequestKey(null); }}>
                <option value="strategy">Agent-planned strategy</option>
                <option value="dca">Recurring bounded purchase / sale</option>
                <option value="alert">Price alert, no trading authority</option>
              </select>
            </Field>
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => { setName(event.target.value); setRequestKey(null); }}
                placeholder="My ETH accumulation"
              />
            </Field>
            <Field label="Trading account">
              <select
                value={selectedAccount?.id ?? ""}
                onChange={(event) => { setAccountId(event.target.value); setRequestKey(null); }}
              >
                {w.session.accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.venue} / {account.address.slice(0, 8)}...
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Evaluation interval">
              <select
                value={interval}
                onChange={(event) => { setIntervalValue(event.target.value); setRequestKey(null); }}
              >
                <option value="300">Every 5 minutes</option>
                <option value="900">Every 15 minutes</option>
                <option value="3600">Hourly</option>
                <option value="86400">Daily</option>
              </select>
            </Field>
          </div>
          {kind !== "strategy" && <div className="form-grid">
            <Field label={kind === "dca" && selectedAccount?.venue === "uniswap" ? "Spot pair" : "Instrument"}>
              {native ? <select aria-label="Ostium automation market" value={symbol} onChange={event => { setSymbol(event.target.value); setRequestKey(null); }}>{!nativeMarkets.some(market => market.symbol === symbol) && <option value={symbol}>{symbol} (unavailable)</option>}{nativeMarkets.map(market => <option key={market.symbol} value={market.symbol}>{market.symbol}{market.tradable === false ? " (currently read-only)" : ""}</option>)}</select> : <input value={kind === "dca" && selectedAccount?.venue === "uniswap" ? "WETH/USDC" : symbol} readOnly={kind === "dca" && selectedAccount?.venue === "uniswap"} onChange={event => { setSymbol(event.target.value); setRequestKey(null); }} maxLength={50} />}
            </Field>
            {kind === "dca" ? <>
              <Field label="Direction"><select value={side} onChange={event => { setSide(event.target.value as typeof side); setRequestKey(null); }}><option value="buy">Buy</option><option value="sell">Sell</option></select></Field>
              <Field label={selectedAccount?.venue === "uniswap" ? `Amount paid per execution (${side === "buy" ? "USDC" : "WETH"})` : native ? "USDC collateral per execution" : "Base asset amount per execution"}><input value={amount} inputMode="decimal" onChange={event => { setAmount(event.target.value); setRequestKey(null); }} /></Field>
            </> : <>
              <Field label="Notify when price is"><select value={operator} onChange={event => { setOperator(event.target.value as typeof operator); setRequestKey(null); }}><option value="above">Above</option><option value="below">Below</option></select></Field>
              <Field label={`Price threshold (${conditionQuote} per ${selectedMarket?.baseAsset ?? symbol.split("/")[0]})`}><input value={threshold} inputMode="decimal" onChange={event => { setThreshold(event.target.value); setRequestKey(null); }} /></Field>
            </>}
          </div>}
          {native && kind === "dca" && <div className="form-grid"><Field label="Native leverage"><input inputMode="decimal" value={leverage} onChange={event => { setLeverage(event.target.value); setRequestKey(null); }}/></Field><label className="checkbox"><input type="checkbox" checked={dayTrade} onChange={event => { setDayTrade(event.target.checked); setRequestKey(null); }}/>Day-trade position</label><p className="fine-print">Exact USDC collateral and leverage repeat at each permitted interval. Account limits, native delegation, USDC allowance, fees and market hours are checked each time.</p></div>}
          {kind === "strategy" && <Field
            label="Instruction and conditions"
            hint="Be specific about the asset, amount, trigger and limits. Owner permissions remain the final boundary."
          >
            <textarea
              rows={3}
              value={instruction}
              onChange={(event) => { setInstruction(event.target.value); setRequestKey(null); }}
              placeholder="Check ETH market conditions every hour and propose a bounded trade..."
            />
          </Field>}
          <p className="fine-print">{kind === "alert" ? "The worker evaluates a real CRE price condition and creates an in-app notification. No trade is submitted and no agent trading grant is needed." : kind === "dca" ? "Every allowed interval repeats this exact bounded request until paused or the grant expires. It uses your agent authorization and current execution checks." : "0G proposes an action; CRE evaluates it and the worker independently checks current account permissions before execution."}</p>
          <div className="form-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              disabled={
                !!busy || !name.trim() || !selectedAccount || (kind === "strategy" ? !instruction.trim() : kind === "dca" ? !amount.trim() || Number(amount) <= 0 || native && (!selectedMarket?.tradable || Number(leverage) <= 0) : !symbol.trim() || !threshold.trim() || Number(threshold) <= 0)
              }
              onClick={() => void create()}
            >
              {busy === "create" ? <Spinner /> : <ShieldCheck size={15} />}
              Create approved strategy
            </button>
          </div>
        </div>
      )}
      {!!notifications.length && <div className="automation-list">
        <h2>Price alert notifications</h2>
        {notifications.slice(0, 20).map(item => <article className="automation-card" key={item.id}>
          <p>{item.message}</p><small>{time(item.createdAt)}</small>
          {!item.readAt && <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void readNotification(item.id)}>Mark read</button>}
        </article>)}
      </div>}
      {!w.automations.length ? (
        <div className="automation-starters">{([{ id: "alert", label: "Price alert", when: "Price crosses your threshold", then: "Notify you. No trade.", description: "Watch a price without granting execution authority." }, { id: "dca", label: "Recurring trade", when: "Your chosen interval", then: "Prepare a bounded purchase or sale", description: "Repeat one exact trade within your active permissions." }, { id: "strategy", label: "Agent strategy", when: "Your conditions are met", then: "Evaluate an agent proposal", description: "0G plans. CRE evaluates. Account permissions apply." }] as const).map((item, index) => <button className={`automation-starter ${item.id}`} type="button" key={item.id} disabled={w.connecting || !!busy} onClick={() => { if (!w.session.user) { void w.connect(); return; } if (!w.session.accounts.length) { router.push("/settings?section=accounts"); return; } setKind(item.id); setRequestKey(null); setCreating(true); }}><div className="automation-starter-top"><span>0{index + 1}</span><strong>{item.label}</strong></div><div className="automation-rule-preview"><span>WHEN</span><p>{item.when}</p><i/><span>THEN</span><p>{item.then}</p></div><p>{item.description}</p><span className="automation-starter-action">{!w.session.user ? "Connect to configure" : !w.session.accounts.length ? "Set up account" : "Configure automation"}<Plus size={16}/></span></button>)}</div>
      ) : (
        <div className="automation-list">
          {w.automations.map((job) => (
            <article className="automation-card" key={job.id} id={job.id}>
              <div className="automation-top">
                <span className="automation-icon">
                  <GitBranch size={18} />
                </span>
                <div>
                  <h2>{job.name}</h2>
                  <span>
                    <Clock3 size={12} />
                    Every {Math.round(job.intervalSeconds / 60)} min / {automationControl(job, !!w.agentData?.agent.paused).status === "active" ? `next ${time(job.nextRunAt)}` : "not scheduled"}
                  </span>
                </div>
                <Status value={automationControl(job, !!w.agentData?.agent.paused).status} />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={automationControl(job, !!w.agentData?.agent.paused).label}
                  title={automationControl(job, !!w.agentData?.agent.paused).detail}
                  disabled={!!busy || automationControl(job, !!w.agentData?.agent.paused).disabled}
                  onClick={() => void toggle(job.id, job.status)}
                >
                  {busy === job.id ? <Spinner /> : <Power size={15} />}
                </button>
              </div>
              <p>{job.instruction}</p>
              {job.expiresAt && <small>Expires {time(job.expiresAt)}</small>}
              <p className="fine-print">{automationControl(job, !!w.agentData?.agent.paused).detail}</p>
              <InlineError message={automationFailure(job)} />
              {job.lastEvaluation ? (
                <div className="evaluation">
                  <span className="eyebrow">LATEST CRE EVALUATION</span>
                  <div>
                    <Status value={job.lastEvaluation.decision} />
                    <Badge>{job.lastEvaluation.source}</Badge>
                    <time>{time(job.lastEvaluation.observedAt)}</time>
                  </div>
                  <p>{job.lastEvaluation.reason}</p>
                  <code title={job.lastEvaluation.id}>
                    {job.lastEvaluation.id}
                  </code>
                  {job.lastEvaluation.requestId && (
                    <small>0G request: {job.lastEvaluation.requestId}</small>
                  )}
                </div>
              ) : (
                <div className="evaluation muted">
                  No evaluation received. Waiting for the configured runner.
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
