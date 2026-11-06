"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OstiumAllowanceIntent, TradingAccount } from "@orcus/core";
import type { Workspace } from "../../lib/use-workspace";
import { api, displayError, post } from "../../lib/api";
import { assetAmount } from "../../lib/format";
import { approveOstiumAllowance } from "../../lib/wallets";
import { Address, Field, InlineError, Spinner, Status } from "../trading/primitives";
import { ServicePaymentScope } from "./service-payment-scope";

const hashPattern = /^0x[\da-fA-F]{64}$/;
const unresolvedStatuses = new Set(["prepared", "submitting", "pending", "submitted-unknown"]);

export function ostiumAllowanceCanSign(intent: OstiumAllowanceIntent | undefined, account: TradingAccount, acknowledged: boolean, now = Date.now()) {
  return Boolean(acknowledged && intent?.status === "prepared" && !intent.transactionHash && intent.expiresAt > now && intent.accountId === account.id && intent.chainId === 421614 && account.venue === "ostium" && account.chainId === 421614 && intent.trader.toLowerCase() === account.ownerAddress.toLowerCase());
}

export function validOstiumAllowanceAmount(value: string) {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  const atoms = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return atoms > 0n && atoms <= 2_000_000_000_000n;
}

export function OstiumAllowanceControls({ account, workspace: w, initialAmount = "" }: { account: TradingAccount; workspace: Workspace; initialAmount?: string }) {
  const owner = account.ownerAddress.toLowerCase(), scopeKey = `${w.session.user?.id ?? "signed-out"}:${owner}:${account.id}`;
  const scope = useRef(new ServicePaymentScope(scopeKey));
  scope.current.changeOwner(scopeKey);
  const [intents, setIntents] = useState<OstiumAllowanceIntent[] | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [amount, setAmount] = useState(initialAmount), [acknowledged, setAcknowledged] = useState(false), [recoveryHash, setRecoveryHash] = useState("");
  const [pending, setPending] = useState<"prepare" | "sign" | "check" | "cancel" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const locked = useRef(false), requestId = useRef<string | null>(null);
  const ownIntents = loadedScope === scopeKey ? intents : null;
  const intent = ownIntents?.find(item => unresolvedStatuses.has(item.status)) ?? ownIntents?.[0];
  const unresolved = Boolean(intent && unresolvedStatuses.has(intent.status));
  const signedInOwner = w.session.user?.address.toLowerCase() === owner;
  const load = useCallback(async () => {
    const ticket = scope.current.capture();
    const result = await api<{ intents: OstiumAllowanceIntent[] }>("/api/ostium/allowances");
    const own = result.intents.filter(item => item.accountId === account.id && item.trader.toLowerCase() === owner).sort((a, b) => b.createdAt - a.createdAt);
    if (scope.current.isCurrent(ticket)) { setIntents(own); setLoadedScope(scopeKey); }
    return own;
  }, [scopeKey]);

  useEffect(() => {
    scope.current.activate(); locked.current = false; requestId.current = null;
    setIntents(null); setLoadedScope(null); setAmount(initialAmount); setAcknowledged(false); setRecoveryHash(""); setPending(null); setError(null); setNotice(null);
    const ticket = scope.current.capture();
    if (signedInOwner) load().catch(cause => { if (scope.current.isCurrent(ticket)) setError(displayError(cause)); });
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { scope.current.stop(); clearInterval(timer); };
  }, [load]);
  useEffect(() => { setAcknowledged(false); }, [intent?.id, intent?.status]);
  useEffect(() => {
    setRecoveryHash("");
    if (!intent) return;
    try { const saved = localStorage.getItem(`orcus:ostium-allowance:${owner}:${intent.id}`); if (saved && hashPattern.test(saved)) setRecoveryHash(saved); } catch {}
  }, [intent?.id, owner]);

  async function perform(action: NonNullable<typeof pending>) {
    if (locked.current || !signedInOwner) return;
    const ticket = scope.current.capture(), current = () => scope.current.isCurrent(ticket);
    if (!current()) return;
    locked.current = true; setPending(action); setError(null); setNotice(null);
    const saveHash = (hash: string) => {
      if (!intent || !hashPattern.test(hash)) return;
      try { localStorage.setItem(`orcus:ostium-allowance:${owner}:${intent.id}`, hash); } catch {}
      if (current()) setRecoveryHash(hash);
    };
    try {
      if (action === "prepare") {
        if (!ownIntents || unresolved || !validOstiumAllowanceAmount(amount)) return;
        requestId.current ??= `allowance:${crypto.randomUUID()}`;
        await post("/api/ostium/allowances/prepare", { accountId: account.id, amountUsd: amount, requestId: requestId.current });
        if (current()) requestId.current = null;
      } else if (action === "sign" && intent) {
        if (!ostiumAllowanceCanSign(intent, account, acknowledged)) return;
        const result = await approveOstiumAllowance({ account, intent });
        saveHash(result.transactionHash);
        if (current()) setNotice("Exact allowance verified. This permits USDC spending; it does not open a trade or grant agent authority.");
      } else if (action === "check" && intent) {
        const hash = intent.transactionHash ?? recoveryHash;
        if (!hashPattern.test(hash)) return;
        const result = await post<{ intent: OstiumAllowanceIntent }>("/api/ostium/allowances/reconcile", { intentId: intent.id, transactionHash: hash });
        if (current()) setNotice(result.intent.status === "confirmed" ? "The existing exact allowance is verified. No new wallet request was made." : result.intent.status === "rejected" ? "The allowance reverted. No new approval was sent." : "The existing approval is still pending. Do not approve it again.");
      } else if (action === "cancel" && intent?.status === "prepared") {
        await post("/api/ostium/allowances/cancel", { intentId: intent.id });
        if (current()) setNotice("Unsigned allowance request dismissed. No token approval was revoked or repeated.");
      }
      if (current()) { await load(); if (current()) await w.refresh(); }
    } catch (cause) {
      const evidence = cause && typeof cause === "object" && "evidence" in cause ? cause.evidence as { transactionHash?: string } : undefined;
      if (evidence?.transactionHash) saveHash(evidence.transactionHash);
      if (!current()) return;
      setError(displayError(cause));
      await load().catch(() => undefined);
    } finally { if (current()) { locked.current = false; setPending(null); } }
  }

  if (account.venue !== "ostium") return null;
  return <section className="ostium-allowance-controls" aria-label="Ostium USDC allowance">
    <div className="card-heading"><div><h3>USDC trading allowance</h3><p>Approve an exact amount, separate from agent access.</p></div></div>
    <p className="fine-print">Owner-paid Arbitrum Sepolia ETH. Fund the owner wallet on Arbitrum Sepolia before approving. This venue's test USDC has no monetary value.</p>
    {!ownIntents && <p className="fine-print">{signedInOwner ? "Loading saved allowance requests..." : "Sign in with this account's owner wallet."}</p>}
    <Field label="Exact allowance (USDC)" hint="Up to 2,000,000 USDC with six decimal places. No unlimited approval."><input inputMode="decimal" value={loadedScope === scopeKey ? amount : initialAmount} disabled={!!pending || unresolved} onChange={event => { setAmount(event.target.value.trim()); requestId.current = null; }}/></Field>
    <button className="button secondary small" type="button" disabled={!signedInOwner || !!pending || !ownIntents || unresolved || !validOstiumAllowanceAmount(amount)} onClick={() => void perform("prepare")}>{pending === "prepare" && <Spinner/>}Review exact allowance</button>
    {intent && <div className="evaluation"><div className="card-heading"><strong>{assetAmount(intent.amountUsd, "USDC")}</strong><Status value={intent.status}/></div>
      {intent.status === "prepared" && <><p className="fine-print">{intent.expiresAt > now ? `New wallet requests stop at ${new Date(intent.expiresAt).toLocaleTimeString("en-US")}.` : "This unsigned quote expired. Dismiss it before reviewing a new amount."}</p><label className="check-label"><input type="checkbox" checked={acknowledged} disabled={!!pending} onChange={event => setAcknowledged(event.target.checked)}/>I reviewed this exact USDC amount and spender.</label><button className="button primary small" type="button" disabled={!!pending || !ostiumAllowanceCanSign(intent, account, acknowledged, now)} onClick={() => void perform("sign")}>{pending === "sign" && <Spinner/>}{pending === "sign" ? "Confirming owner approval..." : `Approve ${assetAmount(intent.amountUsd, "USDC")}`}</button><button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("cancel")}>Dismiss unsigned request</button></>}
      {["submitting", "pending", "submitted-unknown"].includes(intent.status) && <><p className="warning-note">A wallet flow already started. Recover its existing transaction; no approval is repeated on return.</p>{!intent.transactionHash && <Field label="Transaction hash from owner wallet history"><input value={recoveryHash} disabled={!!pending} onChange={event => setRecoveryHash(event.target.value.trim())} placeholder="0x..."/></Field>}<button className="button secondary small" type="button" disabled={!!pending || !hashPattern.test(intent.transactionHash ?? recoveryHash)} onClick={() => void perform("check")}>{pending === "check" && <Spinner/>}Check existing approval</button></>}
      {(intent.transactionHash ?? recoveryHash) && hashPattern.test(intent.transactionHash ?? recoveryHash) && <a className="text-link" href={`https://sepolia.arbiscan.io/tx/${intent.transactionHash ?? recoveryHash}`} target="_blank" rel="noreferrer">View approval transaction</a>}
      <details className="technical-limits"><summary>Allowance details</summary><dl className="account-addresses"><div><dt>USDC contract</dt><dd><Address value={intent.token} explorer="https://sepolia.arbiscan.io"/></dd></div><div><dt>Approved spender</dt><dd><Address value={intent.spender} explorer="https://sepolia.arbiscan.io"/></dd></div></dl></details>
    </div>}
    {loadedScope === scopeKey && notice && <p className="fine-print" role="status">{notice}</p>}<InlineError message={error}/>
    <button className="button secondary small" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("refresh")}>{pending === "refresh" && <Spinner/>}Refresh saved requests</button>
  </section>;
}
