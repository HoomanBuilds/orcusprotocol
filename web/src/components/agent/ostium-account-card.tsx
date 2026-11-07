"use client";

import { useEffect, useRef, useState } from "react";
import { zeroAddress } from "viem";
import { isOwnerRejection } from "@orcus/wallets/preflight";
import type { OstiumDelegationPlan } from "@orcus/wallets/ostium";
import type { AgentPermission, TradingAccount, TradeRequest } from "@orcus/core";
import type { Workspace } from "../../lib/use-workspace";
import { post, displayError } from "../../lib/api";
import { assetAmount, usd } from "../../lib/format";
import { ostiumAcknowledgement } from "../../lib/ostium-ux";
import { grantOstiumPermission, revokeOstiumPermission } from "../../lib/wallets";
import { ProtocolIcon } from "../workspace/asset-icon";
import { Address, Badge, Field, InlineError, Spinner } from "../trading/primitives";
import { OstiumAllowanceControls } from "./ostium-allowance-controls";
import { ServicePaymentScope } from "./service-payment-scope";
import { VenueSymbolPicker } from "./venue-symbol-picker";
import styles from "./ostium-account-card.module.css";

const nativeActions = ["market", "limit", "stop", "cancel", "reduce", "close", "stop-loss", "take-profit", "edit-order", "add-collateral"] as const;
type GrantDraft = { maxTradeUsd: string; maxCollateralUsd: string; maxLeverage: string; hours: string; symbols: string; actions: TradeRequest["type"][] };
type GrantReview = { permission: AgentPermission; agentAddress: string; ostium: OstiumDelegationPlan };
type DisableResult = { account: TradingAccount; requiresOwnerRevocation: boolean; ostium?: OstiumDelegationPlan; nativeAuthority?: { delegate: string }; message?: string };
type AccessJournal = { version: 1; purpose: "grant" | "revoke"; status: "review" | "started"; account: TradingAccount; plan: OstiumDelegationPlan; permission?: AgentPermission; transactionHash?: string };
const defaultDraft: GrantDraft = { maxTradeUsd: "100", maxCollateralUsd: "25", maxLeverage: "3", hours: "24", symbols: "", actions: [...nativeActions] };
const hashPattern = /^0x[\da-fA-F]{64}$/;
class NativeAccessError extends Error {}

export function ostiumPermissionRequest(account: TradingAccount, draft: GrantDraft, now = Date.now()) {
  const positive = (value: string) => /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
  const hours = Number(draft.hours), leverage = Number(draft.maxLeverage), symbols = draft.symbols.split(",").map(value => value.trim()).filter(Boolean);
  if (account.venue !== "ostium" || account.chainId !== 421614 || account.address.toLowerCase() !== account.ownerAddress.toLowerCase()) throw new NativeAccessError("Use your owner-controlled Ostium account on Arbitrum Sepolia.");
  if (!positive(draft.maxTradeUsd) || !positive(draft.maxCollateralUsd)) throw new NativeAccessError("Use positive USD notional and USDC collateral caps, with at most six decimals.");
  if (!/^\d+(?:\.\d{1,2})?$/.test(draft.maxLeverage) || leverage < 1 || leverage > 1000) throw new NativeAccessError("Use leverage from 1x to 1000x, with at most two decimals.");
  if (!/^\d+$/.test(draft.hours) || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new NativeAccessError("Choose an application lifetime from one hour to 30 days.");
  if (!symbols.length || symbols.length > 30 || new Set(symbols).size !== symbols.length || symbols.some(value => !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value) || value.length > 50)) throw new NativeAccessError("List up to 30 distinct, exact venue symbols, such as XAU/USD.");
  if (!draft.actions.length || new Set(draft.actions).size !== draft.actions.length || draft.actions.some(action => !(nativeActions as readonly string[]).includes(action))) throw new NativeAccessError("Choose supported agent actions. Collateral removal remains owner-only.");
  return { accountId: account.id, action: "prepare", maxTradeUsd: draft.maxTradeUsd, maxCollateralUsd: draft.maxCollateralUsd, maxLeverage: leverage, allowedSymbols: symbols, allowedActions: draft.actions, expiresAt: now + hours * 3_600_000 };
}

export function nativeJournalKey(account: TradingAccount) { return `orcus:ostium-access:v1:${account.ownerAddress.toLowerCase()}:${account.id}`; }

export function readNativeAccessJournal(raw: string | null, account: TradingAccount): AccessJournal | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as AccessJournal;
  if (value.version !== 1 || !["grant", "revoke"].includes(value.purpose) || !["review", "started"].includes(value.status) || value.account?.id !== account.id || value.account?.ownerAddress?.toLowerCase() !== account.ownerAddress.toLowerCase() || value.account?.venue !== "ostium" || value.account?.chainId !== 421614 || value.plan?.chainId !== 421614 || !Array.isArray(value.plan?.transactions) || typeof value.plan?.delegate !== "string" || typeof value.plan?.expiresAt !== "number" || value.transactionHash !== undefined && !hashPattern.test(value.transactionHash)) throw new Error("Saved native permission state is invalid. Check native authority in the venue before requesting another signature.");
  if (value.purpose === "grant" && (!value.permission || !Array.isArray(value.permission.allowedSymbols) || !Array.isArray(value.permission.allowedActions) || typeof value.permission.agentAddress !== "string" || typeof value.permission.expiresAt !== "number")) throw new Error("The saved grant is incomplete. No new native signature will be requested.");
  if (value.purpose === "grant" && value.permission) ostiumPermissionRequest(account, { maxTradeUsd: value.permission.maxTradeUsd, maxCollateralUsd: value.permission.maxCollateralUsd ?? "", maxLeverage: String(value.permission.maxLeverage), hours: "1", symbols: value.permission.allowedSymbols.join(","), actions: value.permission.allowedActions });
  return value;
}

export function OstiumAccountCard({ account, workspace: w }: { account: TradingAccount; workspace: Workspace }) {
  const owner = account.ownerAddress.toLowerCase(), scopeKey = `${w.session.user?.id ?? "signed-out"}:${owner}:${account.id}`;
  const scope = useRef(new ServicePaymentScope(scopeKey)); scope.current.changeOwner(scopeKey);
  const [draft, setDraft] = useState(defaultDraft), [journalState, setJournalState] = useState<AccessJournal | null>(null), [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false), [pending, setPending] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const [managing, setManaging] = useState(false);
  const locked = useRef(false), key = nativeJournalKey(account), loaded = loadedScope === scopeKey;
  const journal = loaded ? journalState : null;
  const permissions = w.agentData?.permissions.filter(item => item.accountId === account.id) ?? [];
  const permission = permissions.find(item => item.status === "active" && item.expiresAt > now);
  const signedInOwner = w.session.user?.address.toLowerCase() === owner;
  const balances = w.portfolio.balances.filter(item => item.accountId === account.id);
  const selected = w.venue === "ostium" ? w.symbol : "";

  useEffect(() => {
    scope.current.activate(); locked.current = false;
    setLoadedScope(null); setJournalState(null); setAcknowledged(false); setPending(null); setError(null); setNotice(null); setManaging(false); setDraft({ ...defaultDraft, actions: [...nativeActions], symbols: selected });
    try { setJournalState(readNativeAccessJournal(localStorage.getItem(key), account)); setLoadedScope(scopeKey); }
    catch { setError("Saved permission recovery is unavailable. No new native grant will be signed; manual trading remains separate."); }
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { scope.current.stop(); clearInterval(timer); };
  }, [scopeKey]);
  useEffect(() => { setAcknowledged(false); }, [journal?.permission?.id, journal?.purpose]);

  function save(next: AccessJournal | null) {
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); }
    catch { throw new NativeAccessError("Browser recovery storage is unavailable. Check native authority before requesting another signature."); }
    setJournalState(next);
  }
  const set = <Key extends keyof GrantDraft>(field: Key, value: GrantDraft[Key]) => setDraft(current => ({ ...current, [field]: value }));

  async function perform(action: "prepare" | "grant" | "disable" | "rotate" | "review-revoke" | "revoke" | "recover" | "dismiss") {
    if (locked.current || !signedInOwner || !loaded && action !== "disable") return;
    const ticket = scope.current.capture(), current = () => scope.current.isCurrent(ticket);
    if (!current()) return;
    locked.current = true; setPending(action); setError(null); setNotice(null);
    let attempted: AccessJournal | null = null;
    try {
      if (action === "prepare") {
        if (journal?.status === "started") return;
        const result = await post<GrantReview>("/api/permissions", ostiumPermissionRequest(account, draft));
        if (!current()) return;
        if (!result.ostium || result.agentAddress.toLowerCase() !== account.agentAddress?.toLowerCase()) throw new NativeAccessError("Refresh the exact agent signer before reviewing native access.");
        save({ version: 1, purpose: "grant", status: "review", account, plan: result.ostium, permission: result.permission });
      } else if (action === "grant" && journal?.purpose === "grant" && journal.permission) {
        if (!acknowledged || journal.status !== "review" || journal.permission.expiresAt <= Date.now()) return;
        const acknowledgement = ostiumAcknowledgement(account, journal.permission.agentAddress);
        attempted = { ...journal, status: "started" }; save(attempted);
        const result = await grantOstiumPermission({ account, plan: journal.plan, acknowledgement });
        if (!current()) return;
        const transactionHash = "transactionHash" in result ? result.transactionHash : undefined;
        attempted = { ...attempted, transactionHash }; save(attempted);
        await post("/api/permissions", { accountId: account.id, action: "activate", permissionId: journal.permission.id, authorization: { ostiumAcknowledgement: acknowledgement, ...(transactionHash ? { transactionHash } : {}) } });
        if (current()) { save(null); setManaging(false); setNotice("Agent access enabled."); }
      } else if (["disable", "rotate", "review-revoke"].includes(action)) {
        if (journal?.status === "started" && action !== "disable") return;
        const result = await post<DisableResult>("/api/permissions", { accountId: account.id, action: action === "rotate" ? "rotate" : "revoke" });
        if (!current()) return;
        if (!loaded || journal?.status === "started") {
          setNotice("Agent disabled in Orcus. Resolve the pending wallet request to finish setup or removal.");
          await w.refresh(); return;
        }
        if (result.requiresOwnerRevocation && result.ostium) save({ version: 1, purpose: "revoke", status: "review", account: result.account, plan: result.ostium }); else save(null);
        setNotice(result.requiresOwnerRevocation ? "Agent disabled in Orcus. Confirm removal in your wallet to remove its Ostium access too." : result.nativeAuthority ? "Agent disabled. No Orcus delegate is active on Ostium." : "Agent disabled in Orcus. Ostium access could not be checked.");
      } else if (action === "revoke" && journal?.purpose === "revoke" && journal.status === "review") {
        attempted = { ...journal, status: "started" }; save(attempted);
        const result = await revokeOstiumPermission({ account: journal.account, plan: journal.plan });
        if (!current()) return;
        const transactionHash = "transactionHash" in result ? result.transactionHash : undefined;
        attempted = { ...attempted, transactionHash }; save(attempted);
        const checked = await post<DisableResult>("/api/permissions", { accountId: account.id, action: "revoke" });
        if (!current()) return;
        if (!checked.nativeAuthority || checked.nativeAuthority.delegate.toLowerCase() !== zeroAddress) throw new NativeAccessError("Native revocation is not yet proven. Keep checking this existing permission change.");
        save(null); setNotice("Agent access removed from Ostium. You can still trade manually.");
      } else if (action === "recover" && journal) {
        if (journal.purpose === "grant" && journal.permission && journal.account.controlRevision === account.controlRevision && journal.permission.expiresAt > Date.now() && journal.permission.agentAddress.toLowerCase() === account.agentAddress?.toLowerCase()) {
          const previous = journal.permission;
          const result = await post<GrantReview>("/api/permissions", { accountId: account.id, action: "prepare", expiresAt: previous.expiresAt, maxTradeUsd: previous.maxTradeUsd, maxCollateralUsd: previous.maxCollateralUsd, maxLeverage: previous.maxLeverage, allowedSymbols: previous.allowedSymbols, allowedActions: previous.allowedActions });
          if (!current()) return;
          if (!result.ostium?.alreadyActive || result.ostium.delegate.toLowerCase() !== previous.agentAddress.toLowerCase()) throw new NativeAccessError("Ostium has not confirmed this agent yet. Check the original request in your wallet, then check again here.");
          const acknowledgement = ostiumAcknowledgement(account, previous.agentAddress);
          await post("/api/permissions", { accountId: account.id, action: "activate", permissionId: result.permission.id, authorization: { ostiumAcknowledgement: acknowledgement, ...(journal.transactionHash ? { transactionHash: journal.transactionHash } : {}) } });
          if (current()) { save(null); setManaging(false); setNotice("Agent access verified. No new signature was requested."); }
        } else {
          const checked = await post<DisableResult>("/api/permissions", { accountId: account.id, action: "revoke" });
          if (!current()) return;
          if (!checked.nativeAuthority) throw new NativeAccessError("Native authority is unavailable. Keep the existing recovery record and check again later.");
          if (checked.requiresOwnerRevocation) {
            if (journal.status === "started" && journal.purpose === "revoke") throw new NativeAccessError("The existing native revocation is not proven. Check the original wallet transaction; do not submit a replacement.");
            if (checked.ostium) save({ version: 1, purpose: "revoke", status: "review", account: checked.account, plan: checked.ostium });
            setNotice("Application access is disabled. Review the remaining native delegate before owner revocation.");
          } else {
            if (journal.purpose === "grant" && journal.status === "started") throw new NativeAccessError("The original grant may still be pending in the owner wallet. Application access is disabled; keep this record until its transaction is resolved.");
            save(null); setNotice("Fresh native state shows no Orcus trading authority. No new signature was requested.");
          }
        }
      } else if (action === "dismiss" && journal?.status === "review") { save(null); setNotice("Unsigned local review dismissed. This does not revoke any native delegate."); }
      if (current()) await w.refresh();
    } catch (cause) {
      const evidence = cause && typeof cause === "object" && "evidence" in cause ? cause.evidence as { transactionHash?: string } : undefined;
      if (attempted && current()) {
        try {
          const phase = cause && typeof cause === "object" && "phase" in cause ? cause.phase : undefined;
          if (isOwnerRejection(cause) || phase === "not-submitted" || phase === "reverted") save({ ...attempted, status: "review", transactionHash: evidence?.transactionHash });
          else if (evidence?.transactionHash) save({ ...attempted, transactionHash: evidence.transactionHash });
        } catch {}
      }
      if (current()) setError(cause instanceof NativeAccessError ? cause.message : displayError(cause));
    } finally { if (current()) { locked.current = false; setPending(null); } }
  }

  if (account.venue !== "ostium") return null;
  return <article className={`settings-card account-card ostium-account-card ${styles.card}`}>
    <div className="card-heading">
      <div className="account-card-identity"><ProtocolIcon name="ostium" size={36}/><div><h2>Ostium</h2><p>Arbitrum Sepolia</p></div></div>
      <Badge tone={journal ? "warn" : permission && !w.agentData?.agent.paused ? "good" : "neutral"}>{journal?.status === "started" ? "Check wallet request" : journal ? "Review required" : permission ? w.agentData?.agent.paused ? "Agent paused" : "Agent enabled" : "Agent off"}</Badge>
    </div>
    <dl className={styles.balances}>
      <div><dt>Trading balance</dt><dd>{assetAmount(balances.find(item => item.symbol === "USDC")?.amount, "USDC")}</dd></div>
      <div><dt>Your gas balance</dt><dd>{assetAmount(balances.find(item => item.symbol === "ETH")?.amount, "ETH")}</dd></div>
    </dl>
    <p className="fine-print">Trade manually from your wallet. Agent access is optional.</p>
    {journal?.status === "started" ? <div className={styles.flow}>
      <h3>{journal.purpose === "grant" ? "Finish agent setup" : "Finish removing access"}</h3>
      <p className="fine-print">Check the original request in your wallet. Resolving verifies it and restores the original limits if access is confirmed. No new signature.</p>
      <button className="button primary" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("recover")}>{pending === "recover" && <Spinner/>}{pending === "recover" ? "Checking..." : "Resolve agent access"}</button>
    </div> : journal ? <div className={styles.flow}>
      <h3>{journal.purpose === "grant" ? "Review agent access" : "Remove access from Ostium"}</h3>
      {journal.purpose === "grant" && journal.permission ? <>
        <dl className={styles.limits}><div><dt>Trade size</dt><dd>{usd(journal.permission.maxTradeUsd)}</dd></div><div><dt>Collateral</dt><dd>{assetAmount(journal.permission.maxCollateralUsd, "USDC")}</dd></div><div><dt>Leverage</dt><dd>{journal.permission.maxLeverage}x</dd></div></dl>
        <p className="fine-print">{journal.permission.allowedSymbols.join(", ")}. Expires in Orcus: {new Date(journal.permission.expiresAt).toLocaleString("en-US")}.</p>
        <label className="check-label"><input type="checkbox" checked={acknowledged} disabled={!!pending} onChange={event => setAcknowledged(event.target.checked)}/>I understand Ostium grants broader trading access, with no onchain expiry or Orcus caps. The key can remove collateral or charge builder fees. These limits are enforced by Orcus only.</label>
        <p className="fine-print">The agent needs its own Arbitrum Sepolia ETH for gas. Your wallet balance above does not fund it.</p>
        <button className="button primary" type="button" disabled={!!pending || !signedInOwner || !acknowledged || journal.plan.expiresAt <= now || journal.permission.expiresAt <= now} onClick={() => void perform("grant")}>{pending === "grant" && <Spinner/>}{pending === "grant" ? "Confirming access..." : journal.plan.alreadyActive ? "Verify existing access" : "Enable in wallet"}</button>
      </> : <>
        <p className="fine-print">Your agent is disabled in Orcus. Confirm in your wallet to remove its Ostium permission too.</p>
        <Address value={journal.plan.currentDelegate} explorer="https://sepolia.arbiscan.io"/>
        <button className="button primary" type="button" disabled={!!pending || !signedInOwner || journal.plan.expiresAt <= now} onClick={() => void perform("revoke")}>{pending === "revoke" && <Spinner/>}{pending === "revoke" ? "Removing access..." : "Remove in wallet"}</button>
        {journal.plan.expiresAt <= now && <button className="text-link" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("recover")}>Refresh expired review</button>}
      </>}
      <button className="text-link" type="button" disabled={!!pending} onClick={() => void perform("dismiss")}>Cancel review</button>
    </div> : <>
      {!managing ? <button className="button primary" type="button" disabled={!loaded || !signedInOwner} onClick={() => setManaging(true)}>{permission ? "Manage agent" : "Set up agent"}</button> : <div className={styles.flow}>
        <div className={styles.flowHeading}><h3>{permission ? "Manage agent" : "Set agent limits"}</h3><button className="text-link" type="button" disabled={!!pending} onClick={() => setManaging(false)}>Close</button></div>
        {permission && <div><p className="fine-print">Current limit: {usd(permission.maxTradeUsd)} per action, {permission.maxLeverage}x leverage. Expires {new Date(permission.expiresAt).toLocaleString("en-US")}.</p><button className="button secondary small" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("disable")}>{pending === "disable" && <Spinner/>}Disable in Orcus</button></div>}
        <div className="form-grid">
          <Field label="Maximum trade size (USD)"><input inputMode="decimal" disabled={!!pending} value={loaded ? draft.maxTradeUsd : defaultDraft.maxTradeUsd} onChange={event => set("maxTradeUsd", event.target.value.trim())}/></Field>
          <Field label="Collateral per trade (USDC)"><input inputMode="decimal" disabled={!!pending} value={loaded ? draft.maxCollateralUsd : defaultDraft.maxCollateralUsd} onChange={event => set("maxCollateralUsd", event.target.value.trim())}/></Field>
          <Field label="Maximum leverage"><input inputMode="decimal" disabled={!!pending} value={loaded ? draft.maxLeverage : defaultDraft.maxLeverage} onChange={event => set("maxLeverage", event.target.value.trim())}/></Field>
          <Field label="Expires after"><select disabled={!!pending} value={loaded ? draft.hours : defaultDraft.hours} onChange={event => set("hours", event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></Field>
        </div>
        <VenueSymbolPicker venue="ostium" value={loaded ? draft.symbols : ""} onChange={value => set("symbols", value)} disabled={!!pending || !loaded}/>
        <details className="technical-limits"><summary>Allowed actions</summary><div className="form-grid">{nativeActions.map(action => <label className="check-label" key={action}><input type="checkbox" disabled={!!pending} checked={loaded && draft.actions.includes(action)} onChange={event => set("actions", event.target.checked ? [...draft.actions, action] : draft.actions.filter(item => item !== action))}/>{action.replaceAll("-", " ")}</label>)}</div></details>
        <p className="fine-print">Limits and expiry apply in Orcus, not on Ostium. Review the full access before signing.</p>
        <button className="button primary" type="button" disabled={!!pending || !loaded || !signedInOwner || !draft.symbols.trim()} onClick={() => void perform("prepare")}>{pending === "prepare" && <Spinner/>}{pending === "prepare" ? "Preparing review..." : "Review access"}</button>
      </div>}
    </>}
    {journal?.transactionHash && <a className="text-link" href={`https://sepolia.arbiscan.io/tx/${journal.transactionHash}`} target="_blank" rel="noreferrer">View wallet transaction</a>}
    {loaded && notice && <p className="fine-print" role="status">{notice}</p>}<InlineError message={error}/>
    <OstiumAllowanceControls account={account} workspace={w} compact/>
    <details className={styles.details}>
      <summary>Account details</summary>
      <dl className="account-addresses"><div><dt>Trading account / owner wallet</dt><dd><Address value={account.ownerAddress} explorer="https://sepolia.arbiscan.io"/></dd></div><div><dt>Agent signer</dt><dd><Address value={account.agentAddress} explorer="https://sepolia.arbiscan.io"/></dd></div></dl>
      <p className="fine-print">Manual trades use your wallet's ETH. Agent trades use the agent signer's ETH on Arbitrum Sepolia. No automatic top-ups. Test tokens have no monetary value.</p>
      <p className="fine-print">Pausing or expiry in Orcus does not remove Ostium's native permission. Collateral removal is never authorized by Orcus.</p>
      <details className="technical-limits"><summary>Access recovery and history</summary>
        <div className={styles.actions}>
          <button className="button secondary small" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("disable")}>Disable in Orcus</button>
          <button className="button secondary small" type="button" disabled={!!pending || !loaded || !signedInOwner || journal?.status === "started"} onClick={() => void perform("review-revoke")}>Review removal from Ostium</button>
        </div>
        <p className="fine-print">Replacing the agent key pauses access here, but does not revoke the previous key on Ostium.</p>
        <button className="button secondary small" type="button" disabled={!!pending || !loaded || !signedInOwner || journal?.status === "started"} onClick={() => void perform("rotate")}>{pending === "rotate" && <Spinner/>}Replace agent key</button>
        {permissions.filter(item => item.status !== "active").map(item => <div className={styles.history} key={item.id}><span>{item.status === "revoked" ? "Disabled in Orcus" : item.status}</span><Address value={item.agentAddress} explorer="https://sepolia.arbiscan.io"/><small>Original expiry {new Date(item.expiresAt).toLocaleString("en-US")}</small></div>)}
      </details>
    </details>
  </article>;
}
