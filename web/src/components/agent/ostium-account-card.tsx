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
  const locked = useRef(false), key = nativeJournalKey(account), loaded = loadedScope === scopeKey;
  const journal = loaded ? journalState : null;
  const permissions = w.agentData?.permissions.filter(item => item.accountId === account.id) ?? [];
  const permission = permissions.find(item => item.status === "active" && item.expiresAt > now);
  const signedInOwner = w.session.user?.address.toLowerCase() === owner;
  const balances = w.portfolio.balances.filter(item => item.accountId === account.id);
  const selected = w.venue === "ostium" ? w.symbol : "";

  useEffect(() => {
    scope.current.activate(); locked.current = false;
    setLoadedScope(null); setJournalState(null); setAcknowledged(false); setPending(null); setError(null); setNotice(null); setDraft({ ...defaultDraft, actions: [...nativeActions], symbols: selected });
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
        if (current()) { save(null); setNotice("Native delegate and application grant verified. The owner keeps the same trading account."); }
      } else if (["disable", "rotate", "review-revoke"].includes(action)) {
        if (journal?.status === "started" && action !== "disable") return;
        const result = await post<DisableResult>("/api/permissions", { accountId: account.id, action: action === "rotate" ? "rotate" : "revoke" });
        if (!current()) return;
        if (!loaded || journal?.status === "started") {
          setNotice("Application access is disabled. The existing native wallet result remains unresolved; no permission signature was repeated.");
          await w.refresh(); return;
        }
        if (result.requiresOwnerRevocation && result.ostium) save({ version: 1, purpose: "revoke", status: "review", account: result.account, plan: result.ostium }); else save(null);
        setNotice(result.requiresOwnerRevocation ? "Application access is disabled. Native trading authority remains until the owner confirms its separate revocation." : result.nativeAuthority ? "Application access is disabled. Fresh native state shows no Orcus delegate; unrelated delegates were left unchanged." : "Application access is disabled. Native revocation could not be verified; check the venue owner controls.");
      } else if (action === "revoke" && journal?.purpose === "revoke" && journal.status === "review") {
        attempted = { ...journal, status: "started" }; save(attempted);
        const result = await revokeOstiumPermission({ account: journal.account, plan: journal.plan });
        if (!current()) return;
        const transactionHash = "transactionHash" in result ? result.transactionHash : undefined;
        attempted = { ...attempted, transactionHash }; save(attempted);
        const checked = await post<DisableResult>("/api/permissions", { accountId: account.id, action: "revoke" });
        if (!current()) return;
        if (!checked.nativeAuthority || checked.nativeAuthority.delegate.toLowerCase() !== zeroAddress) throw new NativeAccessError("Native revocation is not yet proven. Keep checking this existing permission change.");
        save(null); setNotice("Fresh native state confirms the delegate was removed. Manual owner controls remain available.");
      } else if (action === "recover" && journal) {
        if (journal.purpose === "grant" && journal.permission && journal.account.controlRevision === account.controlRevision && journal.permission.expiresAt > Date.now() && journal.permission.agentAddress.toLowerCase() === account.agentAddress?.toLowerCase()) {
          const previous = journal.permission;
          const result = await post<GrantReview>("/api/permissions", { accountId: account.id, action: "prepare", expiresAt: previous.expiresAt, maxTradeUsd: previous.maxTradeUsd, maxCollateralUsd: previous.maxCollateralUsd, maxLeverage: previous.maxLeverage, allowedSymbols: previous.allowedSymbols, allowedActions: previous.allowedActions });
          if (!current()) return;
          if (!result.ostium?.alreadyActive || result.ostium.delegate.toLowerCase() !== previous.agentAddress.toLowerCase()) throw new NativeAccessError("This native grant is not active yet. Its original wallet result stays unresolved; do not sign a replacement.");
          const acknowledgement = ostiumAcknowledgement(account, previous.agentAddress);
          await post("/api/permissions", { accountId: account.id, action: "activate", permissionId: result.permission.id, authorization: { ostiumAcknowledgement: acknowledgement, ...(journal.transactionHash ? { transactionHash: journal.transactionHash } : {}) } });
          if (current()) { save(null); setNotice("The existing native grant is verified and its original application limits restored. No new signature was requested."); }
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
  return <article className="settings-card account-card ostium-account-card">
    <div className="card-heading"><div className="account-card-identity"><ProtocolIcon name="ostium" size={36}/><div><h2>Ostium</h2><p>Arbitrum Sepolia / same owner account</p></div></div><Badge tone={permission ? "good" : "neutral"}>{permission ? "Agent authorized here" : "Manual owner access"}</Badge></div>
    <dl className="account-addresses"><div><dt>Trading account</dt><dd><Address value={account.address} explorer="https://sepolia.arbiscan.io"/></dd></div><div><dt>Owner wallet</dt><dd><Address value={account.ownerAddress} explorer="https://sepolia.arbiscan.io"/></dd></div><div><dt>Agent signer</dt><dd><Address value={account.agentAddress} explorer="https://sepolia.arbiscan.io"/></dd></div><div><dt>Available test USDC</dt><dd>{assetAmount(balances.find(item => item.symbol === "USDC")?.amount, "USDC")}</dd></div><div><dt>Owner network gas</dt><dd>{assetAmount(balances.find(item => item.symbol === "ETH")?.amount, "ETH")}</dd></div></dl>
    <p className="fine-print">Trade manually without agent access. Owner transactions use the owner's Arbitrum Sepolia ETH; agent trades use the agent signer's ETH. Fund the signer performing the action on Arbitrum Sepolia; no automatic top-ups. Local expiry or pause does not revoke native delegation.</p>
    {permission && <div className="evaluation"><strong>Application limits</strong><dl className="account-addresses"><div><dt>Per-action notional</dt><dd>{usd(permission.maxTradeUsd)}</dd></div><div><dt>Collateral cap</dt><dd>{assetAmount(permission.maxCollateralUsd, "USDC")}</dd></div><div><dt>Maximum leverage</dt><dd>{permission.maxLeverage ?? "Unavailable"}x</dd></div><div><dt>Expires here</dt><dd>{new Date(permission.expiresAt).toLocaleString("en-US")}</dd></div></dl><p className="fine-print">{permission.allowedSymbols.join(", ") || "All supported instruments"}</p></div>}
    {journal?.status === "started" ? <div className="evaluation"><Badge tone="warn">Permission result unresolved</Badge><p className="warning-note">A native wallet flow already started. Returning will not sign it again. Check its existing result before any new grant or revocation.</p><button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("recover")}>{pending === "recover" && <Spinner/>}Check native authority</button></div> : journal ? <div className="evaluation"><h3>{journal.purpose === "grant" ? "Review agent access" : "Revoke native trading authority"}</h3>{journal.purpose === "grant" && journal.permission ? <><p className="fine-print">{usd(journal.permission.maxTradeUsd)} notional / {assetAmount(journal.permission.maxCollateralUsd, "USDC")} collateral / {journal.permission.maxLeverage}x maximum.</p><p className="fine-print">{journal.permission.allowedSymbols.join(", ")} / app expiry {new Date(journal.permission.expiresAt).toLocaleString("en-US")}</p><label className="check-label"><input type="checkbox" checked={acknowledged} disabled={!!pending} onChange={event => setAcknowledged(event.target.checked)}/>I understand the native delegate has no onchain expiry or Orcus caps. Its raw key can remove collateral or charge builder fees; Orcus limits are application-only.</label><button className="button primary small" type="button" disabled={!!pending || !acknowledged || journal.plan.expiresAt <= now || journal.permission.expiresAt <= now} onClick={() => void perform("grant")}>{pending === "grant" && <Spinner/>}{pending === "grant" ? "Confirming native access..." : journal.plan.alreadyActive ? "Verify existing grant" : "Authorize in owner wallet"}</button></> : <><p className="fine-print">Application access is already disabled. Only the owner can remove this exact remaining native delegate.</p><Address value={journal.plan.currentDelegate} explorer="https://sepolia.arbiscan.io"/><button className="button primary small" type="button" disabled={!!pending || journal.plan.expiresAt <= now} onClick={() => void perform("revoke")}>{pending === "revoke" && <Spinner/>}Revoke in owner wallet</button><button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("recover")}>Refresh native review</button></>}<button className="button secondary small" type="button" disabled={!!pending} onClick={() => void perform("dismiss")}>Dismiss unsigned review</button></div> : <details className="technical-limits"><summary>{permission ? "Review a replacement application grant" : "Optional: authorize your agent"}</summary><div className="form-grid"><Field label="Maximum notional (USD)"><input inputMode="decimal" value={loaded ? draft.maxTradeUsd : defaultDraft.maxTradeUsd} onChange={event => set("maxTradeUsd", event.target.value.trim())}/></Field><Field label="Collateral cap (USDC)"><input inputMode="decimal" value={loaded ? draft.maxCollateralUsd : defaultDraft.maxCollateralUsd} onChange={event => set("maxCollateralUsd", event.target.value.trim())}/></Field><Field label="Maximum leverage"><input inputMode="decimal" value={loaded ? draft.maxLeverage : defaultDraft.maxLeverage} onChange={event => set("maxLeverage", event.target.value.trim())}/></Field><Field label="Application lifetime"><select value={loaded ? draft.hours : defaultDraft.hours} onChange={event => set("hours", event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></Field></div><Field label="Allowed venue symbols" hint="Exact comma-separated symbols. An empty list is not accepted here."><input value={loaded ? draft.symbols : ""} onChange={event => set("symbols", event.target.value)} placeholder="XAU/USD, WTI/USD"/></Field><details className="technical-limits"><summary>Allowed actions</summary><div className="form-grid">{nativeActions.map(action => <label className="check-label" key={action}><input type="checkbox" checked={loaded && draft.actions.includes(action)} onChange={event => set("actions", event.target.checked ? [...draft.actions, action] : draft.actions.filter(item => item !== action))}/>{action.replaceAll("-", " ")}</label>)}</div></details><p className="warning-note">These caps and expiry are enforced by Orcus, not the native delegate contract. Owner-only collateral removal is never authorized here.</p><button className="button secondary small" type="button" disabled={!!pending || !loaded || !signedInOwner} onClick={() => void perform("prepare")}>{pending === "prepare" && <Spinner/>}Review native access</button></details>}
    {journal?.transactionHash && <a className="text-link" href={`https://sepolia.arbiscan.io/tx/${journal.transactionHash}`} target="_blank" rel="noreferrer">View permission transaction</a>}
    <div className="settings-actions"><button className="button secondary small" type="button" disabled={!!pending || !signedInOwner} onClick={() => void perform("disable")}>Disable agent here</button><button className="button secondary small" type="button" disabled={!!pending || !loaded || journal?.status === "started"} onClick={() => void perform("review-revoke")}>Review native revocation</button></div>
    <details className="technical-limits"><summary>Signer recovery and rotation</summary><p className="fine-print">Rotation creates a new Orcus signer and disables application access. It does not revoke the old native key; old signer addresses remain available in permission history.</p><button className="button secondary small" type="button" disabled={!!pending || !loaded || journal?.status === "started"} onClick={() => void perform("rotate")}>Rotate application signer</button>{permissions.filter(item => item.status !== "active").map(item => <div className="evaluation" key={item.id}><Badge>{item.status}</Badge><Address value={item.agentAddress} explorer="https://sepolia.arbiscan.io"/></div>)}</details>
    <details className="technical-limits"><summary>USDC spending allowance</summary><OstiumAllowanceControls account={account} workspace={w}/></details>
    {loaded && notice && <p className="fine-print" role="status">{notice}</p>}<InlineError message={error}/>
  </article>;
}
