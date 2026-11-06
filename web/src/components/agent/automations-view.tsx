"use client";

import { useEffect, useState } from "react";
import { tradeRequestSchema } from "@orcus/core";
import { Clock3, GitBranch, Plus, Power, ShieldCheck } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError } from "@/lib/api";
import { time } from "@/lib/format";
import {
  Badge,
  Empty,
  Field,
  InlineError,
  Spinner,
  Status,
} from "../trading/primitives";

export function AutomationsView({ workspace: w }: { workspace: Workspace }) {
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
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; createdAt: number; readAt?: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedAccount = w.session.accounts.find(account => account.id === (accountId || w.session.accounts[0]?.id));

  useEffect(() => {
    let active = true;
    if (!w.session.user) { setNotifications([]); return; }
    const load = () => api<{ notifications: typeof notifications }>("/api/notifications").then(result => { if (active) setNotifications(result.notifications); }).catch(cause => { if (active) setError(displayError(cause)); });
    void load();
    const timer = setInterval(() => void load(), 12000);
    return () => { active = false; clearInterval(timer); };
  }, [w.session.user?.id]);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      if (!selectedAccount) throw new Error("Choose a connected account first.");
      const key = requestKey ?? crypto.randomUUID();
      setRequestKey(key);
      const request = kind === "dca" ? tradeRequestSchema.parse({ accountId: selectedAccount.id, venue: selectedAccount.venue, type: selectedAccount.venue === "uniswap" ? "swap" : "market", symbol: selectedAccount.venue === "uniswap" ? "WETH/USDC" : symbol.trim().toUpperCase(), side, amount, slippageBps: 50, reduceOnly: false, mode: "agent" }) : undefined;
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
      setBusy(null);
    }
  }

  async function readNotification(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/notifications/${id}`, { method: "PATCH", body: JSON.stringify({ read: true }) });
      setNotifications(current => current.map(item => item.id === id ? { ...item, readAt: Date.now() } : item));
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(null); }
  }

  async function toggle(id: string, status: string) {
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
      setBusy(null);
    }
  }

  return (
    <section className="workspace-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONDITIONS, NOT GUESSWORK</span>
          <h1>Strategy automations</h1>
          <p>
            Owner-approved strategies evaluated by Chainlink CRE, executed
            within your permissions.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!w.session.user || !w.session.accounts.length}
          onClick={() => { setRequestKey(null); setCreating((value) => !value); }}
        >
          <Plus size={15} />
          New automation
        </button>
      </div>
      <div className="info-banner">
        <GitBranch size={17} />
        <span>
          <strong>CRE local simulation</strong> / the durable worker schedules
          evaluations. This is not hosted DON execution. Stopping the runner
          pauses conditional strategies, not owner controls.
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
                value={accountId || w.session.accounts[0]?.id || ""}
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
              <input value={kind === "dca" && selectedAccount?.venue === "uniswap" ? "WETH/USDC" : symbol} readOnly={kind === "dca" && selectedAccount?.venue === "uniswap"} onChange={event => { setSymbol(event.target.value); setRequestKey(null); }} maxLength={50} />
            </Field>
            {kind === "dca" ? <>
              <Field label="Direction"><select value={side} onChange={event => { setSide(event.target.value as typeof side); setRequestKey(null); }}><option value="buy">Buy</option><option value="sell">Sell</option></select></Field>
              <Field label={selectedAccount?.venue === "uniswap" ? `Amount paid per execution (${side === "buy" ? "USDC" : "WETH"})` : "Base asset amount per execution"}><input value={amount} inputMode="decimal" onChange={event => { setAmount(event.target.value); setRequestKey(null); }} /></Field>
            </> : <>
              <Field label="Notify when price is"><select value={operator} onChange={event => { setOperator(event.target.value as typeof operator); setRequestKey(null); }}><option value="above">Above</option><option value="below">Below</option></select></Field>
              <Field label="USD threshold"><input value={threshold} inputMode="decimal" onChange={event => { setThreshold(event.target.value); setRequestKey(null); }} /></Field>
            </>}
          </div>}
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
                busy === "create" || !name.trim() || !selectedAccount || (kind === "strategy" ? !instruction.trim() : kind === "dca" ? !amount.trim() || Number(amount) <= 0 : !symbol.trim() || !threshold.trim() || Number(threshold) <= 0)
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
          {!item.readAt && <button className="button secondary small" type="button" disabled={busy === item.id} onClick={() => void readNotification(item.id)}>Mark read</button>}
        </article>)}
      </div>}
      {!w.automations.length ? (
        <Empty
          title="Let your strategy do the waiting"
          action={
            w.session.user ? undefined : (
              <button
                className="button secondary small"
                type="button"
                onClick={() => void w.connect()}
              >
                Connect wallet
              </button>
            )
          }
        >
          Create a bounded strategy after adding your trading account and
          granting permissions. The worker keeps the schedule when your browser
          closes.
        </Empty>
      ) : (
        <div className="automation-list">
          {w.automations.map((job) => (
            <article className="automation-card" key={job.id}>
              <div className="automation-top">
                <span className="automation-icon">
                  <GitBranch size={18} />
                </span>
                <div>
                  <h2>{job.name}</h2>
                  <span>
                    <Clock3 size={12} />
                    Every {Math.round(job.intervalSeconds / 60)} min / next{" "}
                    {time(job.nextRunAt)}
                  </span>
                </div>
                <Status value={job.status} />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={
                    job.status === "active"
                      ? "Pause automation"
                      : "Resume automation"
                  }
                  disabled={busy === job.id}
                  onClick={() => void toggle(job.id, job.status)}
                >
                  {busy === job.id ? <Spinner /> : <Power size={15} />}
                </button>
              </div>
              <p>{job.instruction}</p>
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
