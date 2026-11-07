"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServicePaymentQuote } from "@orcus/wallets/service-payment";
import { payServiceCredits } from "../../lib/wallets";
import { api, displayError, post } from "../../lib/api";
import { tokenUnits, usd } from "../../lib/format";
import { Address, Badge, Field, InlineError, Spinner, Status } from "../trading/primitives";
import { ServicePaymentScope } from "./service-payment-scope";
import styles from "./settings-panels.module.css";

type Intent = ServicePaymentQuote & { transactionHash?: string; amountUsd: string; createdAt: number };
type Snapshot = { mode: string; configured: boolean; testOnly: true; token?: string; treasury?: string; message: string; credits: { paidUsd: string; spentUsd: string; reservedUsd: string; releasedUsd: string; remainingUsd: string; refundedUsd: string }; intents: Intent[] };
type Action = "prepare" | "pay" | "reconcile" | "cancel";

export function servicePaymentError(cause: unknown) {
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  const messages: Record<string, string> = {
    SERVICE_PAYMENT_UNCONFIGURED: "Testnet service payments are disabled or not configured. No payment was requested.",
    SERVICE_PAYMENT_PENDING: "Payment verification is pending. Check the same intent and wallet history before paying again.",
    SERVICE_PAYMENT_EXPIRED: "This quote expired or already entered your wallet. Reconcile it before preparing another.",
    SERVICE_PAYMENT_EVIDENCE_INVALID: "The transaction does not match this exact payment. Check its owner, token, amount and treasury.",
    SERVICE_PAYMENT_WINDOW_INVALID: "The payment falls outside this quote or its receipt changed. Keep its hash for operator review.",
    SERVICE_PAYMENT_REPLAY: "This payment already granted credits and cannot be claimed again.",
    SERVICE_PAYMENT_CONFLICT: "This intent already has a different amount or transaction. Reconcile the original payment.",
    SERVICE_PAYMENT_WRONG_NETWORK: "Use the quoted Ethereum Sepolia network. No mainnet payment is supported.",
    INSUFFICIENT_SERVICE_CREDITS: "Your verified testnet credits are too low. Add credits or reconcile a pending payment.",
  };
  return messages[code] ?? displayError(cause);
}

export function servicePaymentCanPay(intent: Intent | undefined, configured: boolean, acknowledged: boolean, now = Date.now()) {
  return Boolean(configured && acknowledged && intent?.status === "prepared" && !intent.transactionHash && intent.expiresAt > now);
}

export function ServicePaymentPanel({ owner, onRefresh }: { owner: string; onRefresh: () => Promise<unknown> }) {
  const ownerKey = owner.toLowerCase();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [amount, setAmount] = useState("1"), [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [acknowledged, setAcknowledged] = useState(false), [recoveryHash, setRecoveryHash] = useState("");
  const [now, setNow] = useState(Date.now()), locked = useRef(false), mounted = useRef(true), requestId = useRef<string | null>(null);
  const ownerScope = useRef(new ServicePaymentScope(owner));
  ownerScope.current.changeOwner(owner);
  const intent = snapshot?.intents.find(item => ["prepared", "awaiting-wallet", "submitted"].includes(item.status)) ?? snapshot?.intents[0];
  const unresolved = Boolean(intent && ["prepared", "awaiting-wallet", "submitted"].includes(intent.status));
  const load = useCallback(async () => { const ticket = ownerScope.current.capture(), next = await api<Snapshot>("/api/budget/payments"); if (mounted.current && ownerScope.current.isCurrent(ticket)) setSnapshot(next); return next; }, [ownerKey]);
  useEffect(() => {
    mounted.current = true; ownerScope.current.activate();
    setSnapshot(null); setError(null); setNotice(null); setAcknowledged(false); setRecoveryHash(""); setAmount("1"); setPending(null); requestId.current = null; locked.current = false;
    const ticket = ownerScope.current.capture();
    load().catch(cause => { if (mounted.current && ownerScope.current.isCurrent(ticket)) setError(servicePaymentError(cause)); });
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => { mounted.current = false; ownerScope.current.stop(); clearInterval(timer); };
  }, [load]);
  useEffect(() => { setAcknowledged(false); }, [intent?.id, intent?.status]);
  useEffect(() => {
    setRecoveryHash("");
    if (!intent?.id) return;
    try { const saved = sessionStorage.getItem(`orcus:service-payment:${owner.toLowerCase()}:${intent.id}`); if (saved && /^0x[\da-fA-F]{64}$/.test(saved)) setRecoveryHash(saved); } catch {}
  }, [intent?.id, owner]);

  async function perform(action: Action) {
    if (locked.current) return;
    const ticket = ownerScope.current.capture(), current = () => mounted.current && ownerScope.current.isCurrent(ticket);
    if (!current()) return;
    locked.current = true; setPending(action); setError(null); setNotice(null);
    try {
      if (action === "prepare") {
        requestId.current ??= `owner:${crypto.randomUUID()}`;
        await post("/api/budget/payments/intent", { amountUsd: amount, requestId: requestId.current });
        if (current()) requestId.current = null;
      } else if (action === "pay" && intent) {
        if (!servicePaymentCanPay(intent, Boolean(snapshot?.configured), acknowledged) || intent.payer.toLowerCase() !== owner.toLowerCase()) return;
        const result = await payServiceCredits(intent, {
          beforeSubmit: async () => { if (!current()) throw new Error("Owner changed before payment."); await post("/api/budget/payments/submit", { intentId: intent.id }); },
          onSubmitted: async transactionHash => {
            try { sessionStorage.setItem(`orcus:service-payment:${owner.toLowerCase()}:${intent.id}`, transactionHash); } catch {}
            if (!current()) throw new Error("Owner changed while payment was submitted.");
            setRecoveryHash(transactionHash);
            await post("/api/budget/payments/submit", { intentId: intent.id, transactionHash });
          },
        });
        if (!current()) return;
        setRecoveryHash(result.transactionHash);
        setNotice("Payment submitted. Credits are added only after the server verifies two Sepolia confirmations. Use Check payment; do not pay again.");
      } else if (action === "reconcile" && intent) {
        const result = await post<Intent>("/api/budget/payments/reconcile", { intentId: intent.id, transactionHash: intent.transactionHash ?? recoveryHash });
        if (current()) setNotice(result.status === "credited" ? "Verified testnet transfer credited once. These are test-only credits, not real revenue." : "The transfer reverted. No service credits were added.");
      } else if (action === "cancel" && intent) {
        await post("/api/budget/payments/cancel", { intentId: intent.id }); if (current()) setNotice("Unpaid quote dismissed. This does not refund a transfer or add credits.");
      }
      if (!current()) return;
      await load(); if (current()) await onRefresh();
    } catch (cause) {
      if (!current()) return;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "OWNER_REJECTED" && intent) await post("/api/budget/payments/cancel", { intentId: intent.id }).catch(() => undefined);
      if (!current()) return;
      const evidence = cause && typeof cause === "object" && "evidence" in cause ? cause.evidence as { transactionHash?: string } : undefined;
      if (evidence?.transactionHash) setRecoveryHash(evidence.transactionHash);
      if (current()) setError(servicePaymentError(cause));
      await load().catch(() => undefined);
    } finally { if (current()) { locked.current = false; setPending(null); } }
  }

  return <section className={`settings-card ${styles.card}`} aria-label="Testnet service credits">
    <div className={styles.heading}><div><h2>Service credits</h2><p>For agent usage, not trading.</p></div><Badge tone="neutral">Test credits</Badge></div>
    {!snapshot && <p className={styles.hint} role="status">Loading payment configuration...</p>}
    {snapshot && <><dl className={styles.compactMetrics}>
      <div><dt>Remaining test credits</dt><dd>{usd(snapshot.credits.remainingUsd)}</dd></div>
      <div><dt>Used test credits</dt><dd>{usd(snapshot.credits.spentUsd)}</dd></div>
    </dl>
    {!snapshot.configured && <p className={styles.quietNotice}>Credit checkout is not enabled. Existing test credits are shown above.</p>}
    </>}
    {snapshot?.configured && !unresolved && <div className={styles.stack}>
      <Field label="Add test credits (USDC)"><input inputMode="decimal" value={amount} disabled={!!pending || unresolved} onChange={event => { setAmount(event.target.value); requestId.current = null; }} /></Field>
      <p className={styles.hint}>1 Sepolia test USDC = 1 test credit. These tokens have no monetary value.</p>
      <button className="button secondary" type="button" disabled={!!pending || !snapshot?.configured || unresolved || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(amount) || Number(amount) < 0.01 || Number(amount) > 100} onClick={() => void perform("prepare")}>{pending === "prepare" && <Spinner />}Review payment</button>
    </div>}
    {intent && <div className={styles.review}><div className={styles.heading}><h3>{unresolved ? "Payment in progress" : "Latest payment"}</h3><Status value={intent.status} /></div><p>{tokenUnits(intent.amountBaseUnits, 6, "test USDC")} / {usd(intent.amountUsd)} test credits</p>
      {intent.status === "prepared" && <>
        <dl className="account-addresses"><div><dt>Pay to</dt><dd><Address value={intent.treasury} explorer="https://sepolia.etherscan.io"/></dd></div></dl>
        <p className="fine-print">Your wallet sends this exact amount and pays Sepolia ETH gas, capped at 0.003 ETH. No token allowance or trading permission is granted. Test credits have no monetary value.</p>
        <p className="fine-print">Review expires {new Date(intent.expiresAt).toLocaleString("en-US")}.</p>
        <label className="check-label"><input type="checkbox" checked={acknowledged} disabled={!!pending} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the recipient and test-only payment.</label><button className="button primary" type="button" disabled={!!pending || !servicePaymentCanPay(intent, Boolean(snapshot?.configured), acknowledged, now)} onClick={() => void perform("pay")}>{pending === "pay" && <Spinner />}Pay in owner wallet</button></>}
      {intent.transactionHash && <a className="text-link" href={`https://sepolia.etherscan.io/tx/${intent.transactionHash}`} target="_blank" rel="noreferrer">Inspect payment transaction</a>}
      {intent.status === "awaiting-wallet" && !intent.transactionHash && <Field label="Recover transaction hash from wallet history"><input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value.trim())} placeholder="0x..." /></Field>}
      {intent.status !== "credited" && <button className="button secondary small" type="button" disabled={!!pending || !/^0x[\da-fA-F]{64}$/.test(intent.transactionHash ?? recoveryHash)} onClick={() => void perform("reconcile")}>{pending === "reconcile" && <Spinner />}Check payment</button>}
      {["prepared", "awaiting-wallet"].includes(intent.status) && !intent.transactionHash && <button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("cancel")}>{pending === "cancel" && <Spinner />}{intent.status === "prepared" ? "Cancel unpaid quote" : "Dismiss only after checking wallet history"}</button>}
    </div>}
    {notice && <p className="fine-print" role="status">{notice}</p>}<InlineError message={error} />
    <details className={styles.disclosure}><summary>Credit details & payment rules</summary>
      {snapshot && <dl className="account-addresses"><div><dt>Paid test credits</dt><dd>{usd(snapshot.credits.paidUsd)}</dd></div><div><dt>Reserved</dt><dd>{usd(snapshot.credits.reservedUsd)}</dd></div><div><dt>Released reservations</dt><dd>{usd(snapshot.credits.releasedUsd)} - not refunds</dd></div><div><dt>Payment treasury</dt><dd><Address value={snapshot.treasury} explorer="https://sepolia.etherscan.io" /></dd></div></dl>}
      <p>Live payments are disabled. Exact successful transfers remain recoverable after quote expiry or dismissal. Credits are added only after verification and are separate from your spending limit and trading capital.</p>
      {snapshot?.message && <p>{snapshot.message}</p>}
    </details>
    <button className="text-link" type="button" disabled={!!pending} onClick={() => { const ticket = ownerScope.current.capture(); setError(null); load().catch(cause => { if (mounted.current && ownerScope.current.isCurrent(ticket)) setError(servicePaymentError(cause)); }); }}>Refresh credits</button>
  </section>;
}
