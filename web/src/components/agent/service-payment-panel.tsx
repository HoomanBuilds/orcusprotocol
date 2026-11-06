"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { payServiceCredits, type ServicePaymentQuote } from "@orcus/wallets/service-payment";
import { api, displayError, post } from "../../lib/api";
import { tokenUnits, usd } from "../../lib/format";
import { Address, Badge, Field, InlineError, Spinner, Status } from "../trading/primitives";

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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [amount, setAmount] = useState("1"), [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [acknowledged, setAcknowledged] = useState(false), [recoveryHash, setRecoveryHash] = useState("");
  const [now, setNow] = useState(Date.now()), locked = useRef(false), mounted = useRef(true), requestId = useRef<string | null>(null);
  const intent = snapshot?.intents.find(item => ["prepared", "awaiting-wallet", "submitted"].includes(item.status)) ?? snapshot?.intents[0];
  const unresolved = Boolean(intent && ["prepared", "awaiting-wallet", "submitted"].includes(intent.status));
  const load = useCallback(async () => { const next = await api<Snapshot>("/api/budget/payments"); if (mounted.current) setSnapshot(next); return next; }, []);
  useEffect(() => {
    mounted.current = true; load().catch(cause => { if (mounted.current) setError(servicePaymentError(cause)); });
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [load]);
  useEffect(() => { setAcknowledged(false); }, [intent?.id, intent?.status]);
  useEffect(() => {
    setRecoveryHash("");
    if (!intent?.id) return;
    try { const saved = sessionStorage.getItem(`orcus:service-payment:${owner.toLowerCase()}:${intent.id}`); if (saved && /^0x[\da-fA-F]{64}$/.test(saved)) setRecoveryHash(saved); } catch {}
  }, [intent?.id, owner]);

  async function perform(action: Action) {
    if (locked.current) return;
    locked.current = true; setPending(action); setError(null); setNotice(null);
    try {
      if (action === "prepare") {
        requestId.current ??= `owner:${crypto.randomUUID()}`;
        await post("/api/budget/payments/intent", { amountUsd: amount, requestId: requestId.current });
        requestId.current = null;
      } else if (action === "pay" && intent) {
        if (!servicePaymentCanPay(intent, Boolean(snapshot?.configured), acknowledged) || intent.payer.toLowerCase() !== owner.toLowerCase()) return;
        const result = await payServiceCredits(intent, {
          beforeSubmit: async () => { await post("/api/budget/payments/submit", { intentId: intent.id }); },
          onSubmitted: async transactionHash => {
            setRecoveryHash(transactionHash);
            try { sessionStorage.setItem(`orcus:service-payment:${owner.toLowerCase()}:${intent.id}`, transactionHash); } catch {}
            await post("/api/budget/payments/submit", { intentId: intent.id, transactionHash });
          },
        });
        setRecoveryHash(result.transactionHash);
        setNotice("Payment submitted. Credits are added only after the server verifies two Sepolia confirmations. Use Check payment; do not pay again.");
      } else if (action === "reconcile" && intent) {
        const result = await post<Intent>("/api/budget/payments/reconcile", { intentId: intent.id, transactionHash: intent.transactionHash ?? recoveryHash });
        setNotice(result.status === "credited" ? "Verified testnet transfer credited once. These are test-only credits, not real revenue." : "The transfer reverted. No service credits were added.");
      } else if (action === "cancel" && intent) {
        await post("/api/budget/payments/cancel", { intentId: intent.id }); setNotice("Unpaid quote dismissed. This does not refund a transfer or add credits.");
      }
      await load(); await onRefresh();
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "OWNER_REJECTED" && intent) await post("/api/budget/payments/cancel", { intentId: intent.id }).catch(() => undefined);
      const evidence = cause && typeof cause === "object" && "evidence" in cause ? cause.evidence as { transactionHash?: string } : undefined;
      if (evidence?.transactionHash) setRecoveryHash(evidence.transactionHash);
      if (mounted.current) setError(servicePaymentError(cause));
      await load().catch(() => undefined);
    } finally { locked.current = false; if (mounted.current) setPending(null); }
  }

  return <section className="technical-limits" aria-label="Testnet service credits">
    <div className="card-heading"><div><h3>Agent service credits</h3><p>Separate from trading capital and the expense cap</p></div><Badge tone="warn">Testnet only</Badge></div>
    <p className="fine-print">Sepolia USDC has no monetary value. One test USDC grants one USD-equivalent test credit. Live payments are disabled. Your owner wallet approves this exact transfer and pays its Sepolia ETH fee; no token allowance or agent permission is granted.</p>
    {!snapshot && <p className="fine-print">Loading payment configuration...</p>}
    {snapshot && <><Status value={snapshot.configured ? "configured" : "unconfigured"} /><dl className="account-addresses">
      <div><dt>Paid test credits</dt><dd className="tabular-nums">{usd(snapshot.credits.paidUsd)}</dd></div>
      <div><dt>Spent / reserved</dt><dd className="tabular-nums">{usd(snapshot.credits.spentUsd)} / {usd(snapshot.credits.reservedUsd)}</dd></div>
      <div><dt>Remaining test credits</dt><dd className="tabular-nums">{usd(snapshot.credits.remainingUsd)}</dd></div>
      <div><dt>Released reservations</dt><dd className="tabular-nums">{usd(snapshot.credits.releasedUsd)} - not token refunds</dd></div>
      <div><dt>Payment treasury</dt><dd><Address value={snapshot.treasury} explorer="https://sepolia.etherscan.io" /></dd></div>
    </dl></>}
    <Field label="Test USDC amount"><input inputMode="decimal" value={amount} disabled={!!pending || unresolved} onChange={event => { setAmount(event.target.value); requestId.current = null; }} /></Field>
    <button className="button secondary small" type="button" disabled={!!pending || !snapshot?.configured || unresolved || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(amount) || Number(amount) < 0.01 || Number(amount) > 100} onClick={() => void perform("prepare")}>{pending === "prepare" && <Spinner />}Review test payment</button>
    {intent && <div className="evaluation"><Status value={intent.status} /><p>{tokenUnits(intent.amountBaseUnits, 6, "test USDC")} / {usd(intent.amountUsd)} test credits</p>
      <p className="fine-print">New wallet flows stop after {new Date(intent.expiresAt).toLocaleString("en-US")}. Exact successful transfers remain recoverable after expiry or dismissal at the same fixed test-credit rate.</p>
      {intent.status === "prepared" && <><label className="check-label"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the exact treasury and test-only payment.</label><button className="button secondary small" type="button" disabled={!!pending || !servicePaymentCanPay(intent, Boolean(snapshot?.configured), acknowledged, now)} onClick={() => void perform("pay")}>{pending === "pay" && <Spinner />}Pay in owner wallet</button></>}
      {intent.transactionHash && <a className="text-link" href={`https://sepolia.etherscan.io/tx/${intent.transactionHash}`} target="_blank" rel="noreferrer">Inspect payment transaction</a>}
      {intent.status === "awaiting-wallet" && !intent.transactionHash && <Field label="Recover transaction hash from wallet history"><input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value.trim())} placeholder="0x..." /></Field>}
      {intent.status !== "credited" && <button className="button secondary small" type="button" disabled={!!pending || !/^0x[\da-fA-F]{64}$/.test(intent.transactionHash ?? recoveryHash)} onClick={() => void perform("reconcile")}>{pending === "reconcile" && <Spinner />}Check payment</button>}
      {["prepared", "awaiting-wallet"].includes(intent.status) && !intent.transactionHash && <button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("cancel")}>{pending === "cancel" && <Spinner />}{intent.status === "prepared" ? "Cancel unpaid quote" : "Dismiss only after checking wallet history"}</button>}
    </div>}
    {notice && <p className="fine-print" role="status">{notice}</p>}<InlineError message={error} />
    <button className="button secondary small" type="button" disabled={!!pending} onClick={() => { setError(null); load().catch(cause => setError(servicePaymentError(cause))); }}>Refresh credits</button>
  </section>;
}
