"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, isAddress, parseUnits } from "viem";
import { api, displayError, post } from "../../lib/api";
import { usd } from "../../lib/format";
import { Address, Badge, Field, InlineError, Spinner, Status } from "../trading/primitives";

type ProviderBalance = { status: string; source?: string; chainId?: number; currency?: "0g" | "usd"; accountAddress?: string; observedAt?: number; balance?: string; balanceBaseUnits?: string; balanceNeurons?: string; message?: string };
type FundingPolicy = { enabled: boolean; computeAccountAddress: string; ownerAddress: string; payerAddress: string; topUp0G: string; maximumTotal0G: string; lowBalance0G: string; maxGas0G: string; expiresAt: number; revision: number };
type FundingIntent = { id: string; status: "prepared" | "submitting" | "submitted-unknown" | "confirmed" | "failed" | "cancelled"; payerAddress: string; computeAccountAddress: string; amountWei: string; maxGasWei: string; to: string; expiresAt: number; policyRevision: number; createdAt: number; transactionHash?: string; creditObservedAt?: number; reason?: string; evidence?: { gasPaidWei?: string; blockNumber?: string; creditStatus?: string; message?: string } };
type FundingState = { policy: FundingPolicy | null; status: string; spent0G: string; reserved0G: string; available0G: string; intents: FundingIntent[]; warning: string };
type BudgetState = { operatingAddress: string; availableUsd?: string; providerBalance?: ProviderBalance };
type Snapshot = { funding: FundingState; budget: BudgetState; paused: boolean };
type Form = { topUp0G: string; maximumTotal0G: string; lowBalance0G: string; maxGas0G: string; hours: string };
type Action = "refresh" | "enable" | "disable" | "prepare" | "submit" | "cancel" | "reconcile";
const explorer = "https://chainscan-galileo.0g.ai";
const emptyForm: Form = { topUp0G: "", maximumTotal0G: "", lowBalance0G: "", maxGas0G: "", hours: "24" };

export function computeFundingAmount(value: string | undefined, baseUnits = false): string {
  try {
    if (!value || !(baseUnits ? /^\d{1,80}$/ : /^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/).test(value)) return "Unavailable";
    return `${formatUnits(baseUnits ? BigInt(value) : parseUnits(value, 18), 18)} 0G`;
  } catch { return "Unavailable"; }
}

export function computeFundingBlockReason(provider: ProviderBalance | undefined, now = Date.now()): string | undefined {
  if (!provider || provider.status !== "verified" || provider.source !== "0g-router") return "A verified Router management balance is required. An inference key alone cannot authorize deposits.";
  if (provider.currency === "usd") return "This Router account is billed in USD. Native 0G deposits cannot replenish USD credits.";
  if (provider.currency !== "0g") return "The Router account's billing currency is not verified as native 0G.";
  if (provider.chainId !== 16602) return "This deposit path supports Galileo testnet only. A mainnet or unidentified Router account cannot receive a testnet deposit.";
  if (!provider.accountAddress || !isAddress(provider.accountAddress)) return "The exact Router beneficiary address is not verified.";
  if (!provider.observedAt || Math.abs(now - provider.observedAt) > 60_000) return "The Router account balance is stale. Refresh before authorizing funding.";
  if (!/^\d{1,80}$/.test(provider.balanceBaseUnits ?? provider.balanceNeurons ?? "")) return "The Router has not reported its native account balance.";
  return undefined;
}

export function ComputeFundingPanel({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmedIntent, setConfirmedIntent] = useState<string | null>(null);
  const [pending, setPending] = useState<Partial<Record<Action, string | boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const prepareId = useRef<string | null>(null);
  const funding = snapshot?.funding;
  const provider = snapshot?.budget.providerBalance;
  const policy = funding?.policy;
  const busy = Object.values(pending).some(Boolean);
  const blockReason = computeFundingBlockReason(provider, now);
  const activePolicy = !!policy?.enabled && policy.expiresAt > now;
  const accountMatches = !!policy && policy.computeAccountAddress.toLowerCase() === provider?.accountAddress?.toLowerCase() && policy.payerAddress.toLowerCase() === snapshot?.budget.operatingAddress.toLowerCase();
  const pendingDeposit = funding?.intents.some(intent => ["prepared", "submitting", "submitted-unknown"].includes(intent.status));
  const awaitingCredits = funding?.intents.some(intent => intent.status === "confirmed" && !intent.creditObservedAt);

  const load = useCallback(async () => {
    const [nextFunding, budget, agent] = await Promise.all([api<FundingState>("/api/budget/funding"), api<BudgetState>("/api/budget"), api<{ agent: { paused: boolean } }>("/api/agent")]);
    if (mounted.current) { setSnapshot({ funding: nextFunding, budget, paused: agent.agent.paused }); setNow(Date.now()); }
    return nextFunding;
  }, []);

  useEffect(() => {
    mounted.current = true;
    setPending({ refresh: true });
    load().catch(cause => { if (mounted.current) setError(displayError(cause)); }).finally(() => { if (mounted.current) setPending({}); });
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    return () => { mounted.current = false; clearInterval(clock); };
  }, [load]);

  useEffect(() => {
    if (!policy) return;
    setForm({ topUp0G: policy.topUp0G, maximumTotal0G: policy.maximumTotal0G, lowBalance0G: policy.lowBalance0G, maxGas0G: policy.maxGas0G, hours: "24" });
    setAcknowledged(false);
  }, [policy?.revision]);

  useEffect(() => {
    if (!pendingDeposit && !awaitingCredits) return;
    const timer = setInterval(() => {
      if (!actionLock.current) load().catch(cause => { if (mounted.current) setError(displayError(cause)); });
    }, 5_000);
    return () => clearInterval(timer);
  }, [pendingDeposit, awaitingCredits, load]);

  const storageKey = `orcus:compute-funding:${snapshot?.budget.operatingAddress ?? "unknown"}:${provider?.accountAddress ?? "unknown"}`;
  function clearPrepareId() {
    prepareId.current = null;
    try { sessionStorage.removeItem(storageKey); } catch { /* Idempotency still holds for this mounted panel. */ }
  }
  function requestId() {
    if (prepareId.current) return prepareId.current;
    try { prepareId.current = sessionStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
    if (!prepareId.current || !/^owner:[a-f\d-]{36}$/.test(prepareId.current)) prepareId.current = `owner:${crypto.randomUUID()}`;
    try { sessionStorage.setItem(storageKey, prepareId.current); } catch { /* Keep the same reference in memory if browser storage is unavailable. */ }
    return prepareId.current;
  }

  let formReason: string | undefined;
  try {
    const values = [form.topUp0G, form.maximumTotal0G, form.lowBalance0G, form.maxGas0G];
    if (values.some(value => !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/.test(value))) formReason = "Enter exact native 0G amounts with at most 18 decimals.";
    else if ([form.topUp0G, form.maximumTotal0G, form.maxGas0G].some(value => parseUnits(value, 18) <= 0n)) formReason = "The deposit, lifetime cap, and gas cap must be positive.";
    else if (parseUnits(form.maximumTotal0G, 18) < parseUnits(form.topUp0G, 18) + parseUnits(form.maxGas0G, 18)) formReason = "The total cap must cover one deposit plus its maximum network fee.";
    else if (!/^\d{1,3}$/.test(form.hours) || Number(form.hours) < 1 || Number(form.hours) > 720) formReason = "Authorization must expire in 1 to 720 hours.";
  } catch { formReason = "Enter valid native 0G amounts."; }

  async function perform(action: Action, intent?: FundingIntent) {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending(current => ({ ...current, [action]: intent?.id ?? true }));
    setError(null); setNotice(null);
    try {
      if (action === "enable") {
        if (blockReason || formReason || !acknowledged || !provider?.accountAddress) throw new Error(blockReason ?? formReason ?? "Confirm the exact funding policy before enabling it.");
        await post("/api/budget/funding/policy", { enabled: true, chainId: 16602, currency: "0g", computeAccountAddress: provider.accountAddress, topUp0G: form.topUp0G, maximumTotal0G: form.maximumTotal0G, lowBalance0G: form.lowBalance0G, maxGas0G: form.maxGas0G, expiresAt: Date.now() + Number(form.hours) * 3_600_000 });
        setAcknowledged(false);
        setNotice("Capped automatic replenishment authorized. The worker can deposit from the separate operating wallet while the agent is running.");
      } else if (action === "disable") {
        await post("/api/budget/funding/policy", { enabled: false });
        setAcknowledged(false);
        setNotice("New compute deposits disabled. Already signed transactions still need reconciliation.");
      } else if (action === "prepare") {
        const result = await post<{ status: "prepared"; intent: FundingIntent } | { status: "no-action"; reason: string }>("/api/budget/funding/prepare", { requestId: requestId() });
        if (result.status === "no-action") { clearPrepareId(); setNotice(result.reason); }
        else setNotice("Deposit reserved under your policy. Review its exact beneficiary and fee cap. An enabled worker may also submit it.");
      } else if (intent) {
        if (action === "submit" && confirmedIntent !== intent.id) throw new Error("Confirm this exact deposit before submitting it.");
        const result = await post<FundingIntent>(`/api/budget/funding/${action}`, { intentId: intent.id });
        if (["confirmed", "failed", "cancelled"].includes(result.status)) clearPrepareId();
        setConfirmedIntent(null);
        setNotice(result.status === "confirmed" ? "Vault deposit confirmed. Router credit synchronization is a separate step, not a second deposit." : result.status === "submitted-unknown" ? "Submission is uncertain. Reconcile this same transaction; do not send a replacement." : `Deposit ${result.status.replaceAll("-", " ")}.`);
      }
      await load();
      await onRefresh();
    } catch (cause) {
      setError(displayError(cause));
      if (action !== "refresh") await load().catch(() => undefined);
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(current => ({ ...current, [action]: false }));
    }
  }

  const setAmount = (key: keyof Form, value: string) => { setForm(current => ({ ...current, [key]: value })); setAcknowledged(false); };
  const prepareReason = !activePolicy ? "Enable an owner-approved policy first." : blockReason ?? (!accountMatches ? "The configured payer or beneficiary changed. Authorize a matching policy first." : snapshot?.paused ? "The agent is paused. Resume it in agent controls before funding." : pendingDeposit ? "Resolve the existing prepared or submitted deposit first." : undefined);

  return <section className="technical-limits" aria-label="Compute account replenishment">
    <div className="card-heading"><div><h3>Compute account replenishment</h3><p>Native operating funds, never trading principal</p></div><Status value={funding?.status ?? "unconfigured"} /></div>
    <p className="fine-print">Deposits use the agent&apos;s separate operating wallet on 0G Galileo testnet. This is not an earned-revenue claim. Enabling a policy allows automatic deposits without another wallet popup.</p>
    {!snapshot && <p className="fine-print">{pending.refresh ? <><Spinner />Checking funding configuration...</> : "Funding information is unavailable. Refresh to retry."}</p>}
    <dl className="account-addresses">
      <div><dt>Router beneficiary</dt><dd><Address value={provider?.accountAddress} explorer={provider?.chainId === 16602 ? explorer : undefined} /><Badge tone={!blockReason ? "good" : "warn"}>{!blockReason ? "Verified Galileo 0G account" : "Not eligible for native funding"}</Badge></dd></div>
      <div><dt>Operating payer</dt><dd><Address value={snapshot?.budget.operatingAddress} explorer={explorer} /></dd></div>
      <div><dt>Router compute balance</dt><dd>{provider?.status !== "verified" ? "Not verified" : provider.currency === "0g" ? computeFundingAmount(provider.balanceBaseUnits ?? provider.balanceNeurons, true) : provider.currency === "usd" ? `${usd(provider.balance)} USD` : "Units not verified"}</dd></div>
      <div><dt>Separate expense allowance</dt><dd>{usd(snapshot?.budget.availableUsd)} USD</dd></div>
    </dl>
    {provider?.accountAddress && <p className="fine-print">Exact beneficiary: <code style={{ overflowWrap: "anywhere" }}>{provider.accountAddress}</code></p>}
    <p className="fine-print">Testnet 0G has no asserted USD value. USD expense caps and native 0G deposit caps are separate. The configured Router account may be shared by the operator; it is not a separate per-user credit pool.</p>
    {blockReason && <p className="warning-note">{blockReason}</p>}
    {provider?.message && <p className="fine-print">{provider.message}</p>}
    {policy && <details className="technical-limits"><summary>Current exact owner authorization</summary><dl className="account-addresses">
      <div><dt>Approved beneficiary</dt><dd><Address value={policy.computeAccountAddress} explorer={explorer} /></dd></div>
      <div><dt>Approved payer</dt><dd><Address value={policy.payerAddress} explorer={explorer} /></dd></div>
      <div><dt>Deposit / low threshold</dt><dd>{computeFundingAmount(policy.topUp0G)} / {computeFundingAmount(policy.lowBalance0G)}</dd></div>
      <div><dt>Total cap including gas</dt><dd>{computeFundingAmount(policy.maximumTotal0G)}</dd></div>
      <div><dt>Maximum fee per deposit</dt><dd>{computeFundingAmount(policy.maxGas0G)}</dd></div>
      <div><dt>Expires</dt><dd>{new Date(policy.expiresAt).toLocaleString("en-US")}{policy.expiresAt <= now ? " (expired)" : ""}</dd></div>
      <div><dt>Spent / reserved / remaining</dt><dd>{computeFundingAmount(funding?.spent0G)} / {computeFundingAmount(funding?.reserved0G)} / {computeFundingAmount(funding?.available0G)}</dd></div>
    </dl></details>}
    <div className="form-grid">
      <Field label="Deposit per replenishment (0G)"><input inputMode="decimal" value={form.topUp0G} maxLength={27} disabled={busy} onChange={event => setAmount("topUp0G", event.target.value)} /></Field>
      <Field label="Total lifetime cap including gas (0G)"><input inputMode="decimal" value={form.maximumTotal0G} maxLength={27} disabled={busy} onChange={event => setAmount("maximumTotal0G", event.target.value)} /></Field>
      <Field label="Fund at or below this balance (0G)" hint="Router balance plus unspent PaymentVault funds."><input inputMode="decimal" value={form.lowBalance0G} maxLength={27} disabled={busy} onChange={event => setAmount("lowBalance0G", event.target.value)} /></Field>
      <Field label="Maximum fee per deposit (0G)"><input inputMode="decimal" value={form.maxGas0G} maxLength={27} disabled={busy} onChange={event => setAmount("maxGas0G", event.target.value)} /></Field>
      <Field label="Authorization expiry (hours)"><input inputMode="numeric" value={form.hours} maxLength={3} disabled={busy} onChange={event => setAmount("hours", event.target.value)} /></Field>
    </div>
    <label className="checkbox"><input type="checkbox" checked={acknowledged} disabled={busy || !!blockReason || !!formReason} onChange={event => setAcknowledged(event.target.checked)} />I authorize automatic deposits to the exact Router account above from the operating payer, within these native 0G caps. The account may be shared.</label>
    {formReason && <p className="fine-print">{formReason}</p>}
    <div className="form-actions">
      <button className="button secondary small" type="button" disabled={busy || !!blockReason || !!formReason || !acknowledged} onClick={() => void perform("enable")}>{pending.enable ? <Spinner /> : null}{activePolicy ? "Replace funding authorization" : "Enable capped replenishment"}</button>
      <button className="button secondary small" type="button" disabled={busy || !policy?.enabled} onClick={() => void perform("disable")}>{pending.disable ? <Spinner /> : null}Disable new deposits</button>
      <button className="button secondary small" type="button" disabled={busy} onClick={() => void perform("refresh")}>{pending.refresh ? <Spinner /> : null}Refresh balances</button>
    </div>
    {awaitingCredits && <p className="warning-note">A deposit is confirmed but Router credits are awaiting synchronization. A funding check must observe the later balance increase before another deposit can be prepared.</p>}
    <button className="button secondary small" type="button" disabled={busy || !!prepareReason} onClick={() => void perform("prepare")}>{pending.prepare ? <Spinner /> : null}{awaitingCredits ? "Check credit sync and funding threshold" : "Check threshold and prepare deposit"}</button>
    {prepareReason && <p className="fine-print">{prepareReason}</p>}
    <div aria-live="polite">{notice && <p className="warning-note">{notice}</p>}</div>
    <InlineError message={error} />
    {!!funding?.intents.length && <details className="technical-limits" open={pendingDeposit || awaitingCredits}><summary>Deposit reservations and receipts ({funding.intents.length})</summary>{funding.intents.map(intent => {
      const canCancel = intent.status === "prepared" && !intent.transactionHash;
      const canSubmit = canCancel && activePolicy && accountMatches && !blockReason && !snapshot?.paused && intent.expiresAt > now && intent.policyRevision === policy?.revision;
      const canReconcile = !!intent.transactionHash && ["submitting", "submitted-unknown"].includes(intent.status);
      return <div className="evaluation" key={intent.id}>
        <Status value={intent.status} /><p><strong>{computeFundingAmount(intent.amountWei, true)}</strong> deposit, up to {computeFundingAmount(intent.maxGasWei, true)} network fee.</p>
        <dl className="account-addresses"><div><dt>Beneficiary</dt><dd><Address value={intent.computeAccountAddress} explorer={explorer} /></dd></div><div><dt>PaymentVault destination</dt><dd><Address value={intent.to} explorer={explorer} /></dd></div></dl>
        <p className="fine-print">Exact deposit beneficiary: <code style={{ overflowWrap: "anywhere" }}>{intent.computeAccountAddress}</code></p>
        <small>Prepared {new Date(intent.createdAt).toLocaleString("en-US")} / expires {new Date(intent.expiresAt).toLocaleString("en-US")}</small>
        {intent.transactionHash && <p><a className="text-link" href={`${explorer}/tx/${intent.transactionHash}`} target="_blank" rel="noreferrer">Inspect deposit transaction</a></p>}
        {intent.evidence?.gasPaidWei && <p className="fine-print">Recorded network fee: {computeFundingAmount(intent.evidence.gasPaidWei, true)}{intent.evidence.blockNumber ? ` / block ${intent.evidence.blockNumber}` : ""}.</p>}
        {intent.status === "confirmed" && <p className="warning-note">{intent.creditObservedAt ? "Router balance increase observed after this deposit. This is not a separate per-user balance." : "Vault confirmed. Awaiting Router credit sync; do not treat the deposit as immediately available inference credits."}</p>}
        {(intent.reason || intent.evidence?.message) && <p className="fine-print">{intent.reason ?? intent.evidence?.message}</p>}
        {canSubmit && <label className="checkbox"><input type="checkbox" disabled={busy} checked={confirmedIntent === intent.id} onChange={event => setConfirmedIntent(event.target.checked ? intent.id : null)} />Confirm this exact beneficiary, deposit and maximum fee on Galileo.</label>}
        <div className="form-actions">
          {canSubmit && <button className="button secondary small" type="button" disabled={busy || confirmedIntent !== intent.id} onClick={() => void perform("submit", intent)}>{pending.submit === intent.id ? <Spinner /> : null}Submit authorized deposit</button>}
          {canCancel && <button className="button secondary small" type="button" disabled={busy} onClick={() => void perform("cancel", intent)}>{pending.cancel === intent.id ? <Spinner /> : null}Cancel before submission</button>}
          {canReconcile && <button className="button secondary small" type="button" disabled={busy} onClick={() => void perform("reconcile", intent)}>{pending.reconcile === intent.id ? <Spinner /> : null}Reconcile this transaction</button>}
        </div>
        {intent.status === "prepared" && !canSubmit && <p className="fine-print">Submission is unavailable while the policy, account, agent state, expiry, or verified balance does not match. Cancel this unsigned reservation or refresh.</p>}
      </div>;
    })}</details>}
    {funding?.warning && <p className="fine-print">{funding.warning}</p>}
  </section>;
}
