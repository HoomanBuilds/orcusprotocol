"use client";

import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  KeyRound,
  Plus,
  Wallet,
} from "lucide-react";
import type { AgentPermission, TradingAccount, Venue } from "@orcus/core";
import { venueName } from "@/lib/venue-presentation";
import type { KernelGrantPolicy } from "@orcus/wallets/kernel";
import { formatUnits } from "viem";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError, post } from "@/lib/api";
import {
  approveHyperliquidAgent,
  createTradingSmartAccount,
  grantKernelPermission,
  revokeKernelPermission,
  invalidateKernelPendingApprovals,
  fundTradingAccount,
  fundOperatingWallet,
} from "@/lib/wallets";
import { assetAmount, tokenUnits, usd } from "@/lib/format";
import { tradingGasStatus, withFundingRecoveryIntent } from "@/lib/trade-ux";
import { clearDepositRecovery, depositRecoveryKey, readDepositRecovery } from "@/lib/deposit-recovery";
import { ProtocolIcon } from "../workspace/asset-icon";
import { MemoryControls } from "./memory-controls";
import { ComputeFundingPanel } from "./compute-funding-panel";
import { ServicePaymentPanel } from "./service-payment-panel";
import { ExpenseBillingCheck } from "./expense-billing-check";
import { OstiumAccountCard } from "./ostium-account-card";
import { VenueSymbolPicker } from "./venue-symbol-picker";
import styles from "./accounts-settings.module.css";
import panels from "./settings-panels.module.css";
import {
  Address,
  Badge,
  Empty,
  Field,
  InlineError,
  Spinner,
  Status,
} from "../trading/primitives";

type Permission = AgentPermission & { policy?: KernelGrantPolicy };
type PreparedPermission = {
  permission: Permission;
  agentAddress: string;
  agentName?: string;
  policy?: KernelGrantPolicy;
};

export function AccountCard({
  account,
  workspace: w,
}: {
  account: TradingAccount;
  workspace: Workspace;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [maxTrade, setMaxTrade] = useState("100");
  const [symbols, setSymbols] = useState(
    account.venue === "uniswap" ? "WETH/USDC" : "BTC, ETH",
  );
  const [hours, setHours] = useState("24");
  const [allowNativeInput, setAllowNativeInput] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPermission | null>(null);
  const [fundingAsset, setFundingAsset] = useState<"ETH" | "USDC" | "WETH">("ETH");
  const [fundingAmount, setFundingAmount] = useState("");
  const [storedFundingHash, setFundingHash] = useState<string | null>(null);
  const [storedFundingState, setFundingState] = useState<"confirmed" | "unknown" | "reverted" | null>(null);
  const [fundingChecked, setFundingChecked] = useState(false);
  const [loadedFundingKey, setLoadedFundingKey] = useState<string | null>(null);
  const [pendingPolicy, setPendingPolicy] = useState<KernelGrantPolicy | null>(null);
  const [confirmInvalidation, setConfirmInvalidation] = useState(false);
  const permission = w.agentData?.permissions.find(
    (item) => item.accountId === account.id && item.status === "active",
  ) as Permission | undefined;
  const permissionCurrent = !!permission && permission.expiresAt > now;
  const agentPaused = !!w.agentData?.agent.paused;
  const accessLabel = permissionCurrent ? agentPaused ? "Agent paused" : "Agent enabled" : permission ? "Agent access expired" : "Agent not enabled";
  const spot = account.venue === "uniswap";
  const balances = w.portfolio.balances.filter(balance => balance.accountId === account.id);
  const disabledPermissions = (w.agentData?.permissions ?? []).filter(item => item.accountId === account.id && item.status === "revoked" && item.expiresAt > Date.now()) as Permission[];
  const gas = tradingGasStatus(w.walletConfig, account.venue);
  const fundingRecoveryKey = depositRecoveryKey(account.ownerAddress, account.id);
  const currentFundingKey = useRef(fundingRecoveryKey);
  currentFundingKey.current = fundingRecoveryKey;
  const fundingLoaded = loadedFundingKey === fundingRecoveryKey;
  const fundingHash = fundingLoaded ? storedFundingHash : null;
  const fundingState = fundingLoaded ? storedFundingState : null;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setLoadedFundingKey(null); setFundingHash(null); setFundingState(null); setFundingChecked(false);
    try {
      const saved = readDepositRecovery(localStorage, sessionStorage, account.ownerAddress, account.id);
      if (saved) { setFundingHash(saved.transactionHash ?? null); setFundingState(saved.status); }
    } catch {}
    setLoadedFundingKey(fundingRecoveryKey);
  }, [fundingRecoveryKey]);
  function saveFundingRecovery(status: "confirmed" | "unknown" | "reverted", transactionHash?: string) {
    try { localStorage.setItem(fundingRecoveryKey, JSON.stringify({ status, ...(transactionHash ? { transactionHash } : {}) })); } catch {}
  }

  async function prepare() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("prepare");
    setError(null);
    try {
      const result = await post<PreparedPermission>("/api/permissions", {
        accountId: account.id,
        action: "prepare",
        expiresAt: Date.now() + Number(hours) * 3_600_000,
        maxTradeUsd: maxTrade,
        ...(spot ? { allowNativeInput } : {}),
        allowedSymbols: symbols
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      if (spot && !result.policy)
        throw new Error(
          "The server did not return a bounded session policy. No permission was signed.",
        );
      setPrepared(result);
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function fund() {
    if (busyRef.current || !fundingLoaded || fundingHash || fundingState === "unknown") return;
    busyRef.current = true;
    setBusy("fund");
    setError(null);
    setFundingHash(null);
    setFundingState(null); setFundingChecked(false);
    try {
      setFundingState("unknown");
      const recoveryStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
      const result = await withFundingRecoveryIntent(recoveryStorage, fundingRecoveryKey, () => fundTradingAccount({ account, asset: fundingAsset, amount: fundingAmount }));
      saveFundingRecovery("confirmed", result.transactionHash);
      if (currentFundingKey.current !== fundingRecoveryKey) return;
      setFundingHash(result.transactionHash);
      setFundingState("confirmed");
      setFundingAmount("");
      w.setNotice(`Testnet ${result.asset} funding confirmed. This funds your trading account, not the agent operating budget.`);
      await w.refresh();
    } catch (cause) {
      const phase = cause && typeof cause === "object" && "phase" in cause ? cause.phase : undefined;
      const transactionHash = cause && typeof cause === "object" && "evidence" in cause && cause.evidence && typeof cause.evidence === "object" && "transactionHash" in cause.evidence && typeof cause.evidence.transactionHash === "string" ? cause.evidence.transactionHash : undefined;
      if (phase === "not-submitted") {
        clearDepositRecovery(localStorage, sessionStorage, account.ownerAddress, account.id);
      } else saveFundingRecovery(phase === "reverted" && transactionHash ? "reverted" : "unknown", transactionHash);
      if (currentFundingKey.current !== fundingRecoveryKey) return;
      if (cause && typeof cause === "object" && "evidence" in cause) {
        const evidence = cause.evidence as { transactionHash?: string } | undefined;
        if (evidence?.transactionHash) setFundingHash(evidence.transactionHash);
      }
      setFundingState(phase === "not-submitted" ? null : phase === "reverted" && transactionHash ? "reverted" : "unknown");
      setError(displayError(cause));
    } finally { busyRef.current = false; setBusy(null); }
  }

  async function invalidatePending() {
    if (!pendingPolicy || !confirmInvalidation || busyRef.current) return;
    busyRef.current = true;
    setBusy("invalidate");
    setError(null);
    try {
      await invalidateKernelPendingApprovals(pendingPolicy, { invalidateAllOlderSessions: true });
      await post("/api/permissions", { accountId: account.id, action: "revoke" });
      setPendingPolicy(null);
      setPrepared(null);
      setConfirmInvalidation(false);
      w.setNotice("Older session approvals invalidated onchain. Review any other sessions before granting fresh access.");
      await w.refresh();
    } catch (cause) { setError(displayError(cause)); }
    finally { busyRef.current = false; setBusy(null); }
  }

  async function authorize() {
    if (!prepared || busyRef.current) return;
    busyRef.current = true;
    setBusy("approve");
    setError(null);
    try {
      let authorization: unknown;
      if (spot) {
        if (!prepared.policy)
          throw new Error("A bounded smart-account policy is required.");
        authorization = await grantKernelPermission(prepared.policy);
      } else {
        await approveHyperliquidAgent(
          prepared.agentAddress,
          prepared.agentName ?? "Orcus Agent",
        );
      }
      await post("/api/permissions", {
        accountId: account.id,
        action: "activate",
        permissionId: prepared.permission.id,
        authorization,
      });
      setPrepared(null);
      w.setNotice(
        "Agent access verified. The owner still controls the account.",
      );
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function revoke(rotate = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(rotate ? "rotate" : "revoke");
    setError(null);
    try {
      if (spot && permission) {
        let policy = permission.policy;
        if (!policy) {
          const data = await api<{ permissions: Permission[] }>(
            "/api/permissions",
          );
          policy = data.permissions.find(
            (item) => item.id === permission.id,
          )?.policy;
        }
        if (!policy)
          throw new Error(
            "Native revocation needs the original policy. Pause the agent now and use the smart-account owner controls to revoke access.",
          );
        try { await revokeKernelPermission(policy); }
        catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "PENDING_APPROVAL_INVALIDATION_REQUIRED") setPendingPolicy(policy);
          throw cause;
        }
      }
      await post("/api/permissions", {
        accountId: account.id,
        action: rotate ? "rotate" : "revoke",
      });
      setPrepared(null);
      w.setNotice(
        spot
          ? "Session access revoked. Owner controls remain available."
          : "Automation disabled here. Remove Orcus Agent in Hyperliquid API wallet settings to revoke its native trading authority.",
      );
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function recoverDisabledGrant(previous: Permission) {
    if (!previous.policy || busyRef.current) return;
    busyRef.current = true;
    setBusy(`recover:${previous.id}`); setError(null);
    try {
      await revokeKernelPermission(previous.policy);
      w.setNotice("Native removal of the previous signer was confirmed. Application status alone was not used as proof.");
      await w.refresh();
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "PENDING_APPROVAL_INVALIDATION_REQUIRED") setPendingPolicy(previous.policy);
      setError(displayError(cause));
    } finally { busyRef.current = false; setBusy(null); }
  }

  return (
    <article className={`settings-card account-card ${styles.card}`}>
      <div className="card-heading">
        <ProtocolIcon name={account.venue} size={36}/>
        <div>
          <h2>{spot ? "Uniswap" : "Hyperliquid"}</h2>
          <p>
            {spot
              ? "Ethereum Sepolia"
              : "Hyperliquid Testnet"}
          </p>
        </div>
        <Badge tone={permissionCurrent && !agentPaused ? "good" : "neutral"}>{accessLabel}</Badge>
      </div>
      <dl className={styles.balances}>
        <div><dt>{spot ? "Trading USDC" : "Account USDC"}</dt><dd>{assetAmount(balances.find(balance => balance.symbol === "USDC")?.amount, "USDC")}</dd></div>
        {spot && <div><dt>Trading account gas</dt><dd>{assetAmount(balances.find(balance => balance.symbol === "ETH")?.amount, "ETH")}</dd></div>}
        {!spot && <div><dt>Open positions</dt><dd>{w.portfolio.positions?.filter(position => position.accountId === account.id).length ?? "Unavailable"}</dd></div>}
      </dl>
      <p className={styles.caption}>{spot ? "Manual and agent swaps use this trading account." : "Trade yourself or let your agent manage the same positions."}</p>
      {spot && !gas.ready && <p className="warning-note">Trading service unavailable. You can still manage your account.</p>}
      {!agentOpen && !prepared && !pendingPolicy && <button className="button primary" type="button" onClick={() => setAgentOpen(true)} aria-expanded={false} aria-controls={`agent-settings-${account.id}`}>{permission ? "Manage agent" : "Set up agent"}</button>}
      <details className={styles.details}>
      <summary>Account details</summary>
      <dl className="account-addresses">
        <div>
          <dt>Trading account</dt>
          <dd>
            <Address
              value={account.address}
              explorer={spot ? "https://sepolia.etherscan.io" : undefined}
            />
          </dd>
        </div>
        <div>
          <dt>Owner wallet</dt>
          <dd>
            <Address value={account.ownerAddress} />
          </dd>
        </div>
        <div>
          <dt>Agent signer</dt>
          <dd>
            <Address value={account.agentAddress} />
          </dd>
        </div>
      </dl>
      <p className="fine-print">
        {spot
          ? "You own this smart account. Its Sepolia ETH pays network fees for manual and agent swaps. Connecting does not transfer funds."
          : "Your owner wallet keeps control. Agent permissions do not create a separate trading account."}
      </p>
      {spot && !gas.ready && <p className="warning-note">{gas.label}. {gas.detail}</p>}
      </details>
      {spot && (
        <details className={styles.details} open={fundingState === "unknown" || fundingState === "reverted" || undefined}>
          <summary>{fundingState === "unknown" ? "Deposit needs checking" : fundingState === "reverted" ? "Deposit failed" : "Add trading funds"}</summary>
          <div className="form-grid">
            <Field label="Asset">
              <select value={fundingAsset} onChange={event => setFundingAsset(event.target.value as typeof fundingAsset)}>
                <option value="ETH">Sepolia ETH</option>
                <option value="USDC">Testnet USDC</option>
                <option value="WETH">Testnet WETH</option>
              </select>
            </Field>
            <Field label="Amount">
              <input inputMode="decimal" value={fundingAmount} onChange={event => setFundingAmount(event.target.value)} placeholder="0.00" />
            </Field>
          </div>
          <p className="fine-print">Transfer from your owner wallet on Sepolia. Keep ETH in both wallets for network fees. This does not fund AI compute.</p>
          <p className="fine-print">Funding address on Ethereum Sepolia: <Address value={account.smartAccountAddress ?? account.address} explorer="https://sepolia.etherscan.io" /></p>
          <button className="button secondary small" type="button" disabled={!!busy || !fundingLoaded || !!fundingHash || fundingState === "unknown" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fundingAmount) || Number(fundingAmount) <= 0} onClick={() => void fund()}>
            {busy === "fund" ? <><Spinner />Confirming transfer...</> : "Review transfer in wallet"}
          </button>
          {(fundingHash || fundingState === "unknown") && <div className="warning-note"><p>{fundingState === "confirmed" ? "Deposit confirmed in the trading account." : fundingState === "reverted" ? "The transfer reverted. Check its receipt before another attempt." : "The transfer result is uncertain. Check this same transaction or your wallet history before sending more funds."}</p>{fundingHash && <a className="text-link" href={`https://sepolia.etherscan.io/tx/${fundingHash}`} target="_blank" rel="noreferrer">Inspect funding transaction<ExternalLink size={12} /></a>}{fundingState === "unknown" && <label className="checkbox"><input type="checkbox" checked={fundingChecked} onChange={event => setFundingChecked(event.target.checked)} />I checked the final receipt or wallet history and understand a second transfer is a separate deposit.</label>}<button className="button secondary small" type="button" disabled={!!busy || fundingState === "unknown" && !fundingChecked} onClick={() => { setFundingHash(null); setFundingState(null); setFundingChecked(false); clearDepositRecovery(localStorage, sessionStorage, account.ownerAddress, account.id); void w.refresh(); }}>Enter a separate new deposit</button></div>}
        </details>
      )}
      {pendingPolicy && (
        <div className="permission-review">
          <p className="warning-note">This signed approval is not installed, so uninstalling a signer cannot revoke it. Invalidation affects all older session approvals for this smart account, including other apps.</p>
          <label className="checkbox"><input type="checkbox" checked={confirmInvalidation} onChange={event => setConfirmInvalidation(event.target.checked)} />I authorize invalidating all older session approvals</label>
          <button className="button danger small" type="button" disabled={!!busy || !confirmInvalidation || !gas.ready} onClick={() => void invalidatePending()}>{busy === "invalidate" ? <Spinner /> : <KeyRound size={13} />}Invalidate older approvals in owner wallet</button>
        </div>
      )}
      {(agentOpen || prepared) && <div id={`agent-settings-${account.id}`} className={styles.agentPanel}>
      <div className={styles.panelHeading}><h3>{permission ? "Agent access" : prepared ? "Confirm agent access" : "Set your agent limits"}</h3><button className="text-button" type="button" disabled={!!busy || !!prepared} onClick={() => setAgentOpen(false)}>Close</button></div>
      {permission ? (
        <>
          <div className="permission-active">
            <div>
              <strong>{accessLabel}</strong>
              <span>
                {permission.allowedSymbols.join(", ") ||
                  "All supported symbols"}{" "}
                / up to {usd(permission.maxTradeUsd)} per action / expires{" "}
                {new Date(permission.expiresAt).toLocaleString()}
              </span>
            </div>
          </div>
          {spot && <p className="fine-print">{permission.policy?.nativeWrap ? `Native ETH wrapping is permitted up to ${formatUnits(BigInt(permission.policy.nativeWrap.maxAmountWei), 18)} ETH per call, within the approved routes and expiry.` : "Native ETH wrapping is not included in this grant. Manual ETH input remains an owner-signed action."}</p>}
          {!spot && <p className="fine-print">Disabling here stops Orcus. Remove the agent in Hyperliquid to revoke its exchange access.</p>}
          <div className="form-actions">
            <button
              className="button danger small"
              type="button"
              disabled={!!busy || spot && !gas.ready}
              onClick={() => void revoke()}
            >
              {busy === "revoke" ? <Spinner /> : null}{spot ? "Revoke agent access" : "Disable agent in Orcus"}
            </button>
          </div>
          {spot && !gas.ready && <p className="warning-note">Native session revocation needs the execution service and enough Sepolia ETH in your trading smart account. <button className="text-button" type="button" onClick={() => void w.control("pause")} disabled={w.agentData?.agent.paused || w.controlling}>Pause new agent actions now</button>; existing onchain authority remains until it is revoked.</p>}
        </>
      ) : prepared ? (
        <div className="permission-review">
          <Address value={prepared.agentAddress} />
          <dl>
            <div>
              <dt>Action cap</dt>
              <dd>{usd(prepared.permission.maxTradeUsd)}</dd>
            </div>
            <div>
              <dt>Symbols</dt>
              <dd>
                {prepared.permission.allowedSymbols.join(", ") ||
                  "All supported symbols"}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                {new Date(prepared.permission.expiresAt).toLocaleString()}
              </dd>
            </div>
          </dl>
          {prepared.policy?.nativeWrap && <p className="warning-note">This grant also permits bounded native ETH wrapping up to {formatUnits(BigInt(prepared.policy.nativeWrap.maxAmountWei), 18)} ETH per call. The approved swap pair, output bounds, recipient, and expiry still apply.</p>}
          {spot ? <p className="fine-print">Gas comes from this trading account's Sepolia ETH. {w.walletConfig?.gasPayment?.maxOperationGasWei ? `Fee cap: ${tokenUnits(w.walletConfig.gasPayment.maxOperationGasWei, 18, "ETH")} per operation, not an estimate.` : "A configured execution fee cap is required before trading."}</p> : <p className="warning-note">These limits and expiry are enforced by Orcus. Hyperliquid grants broader trading access; disable its API wallet separately to remove that access.</p>}
          {prepared.policy && (
            <details className="technical-limits">
              <summary>Advanced onchain call constraints</summary>
              {prepared.policy.swaps.map((swap, index) => (
                <p key={`${swap.tokenIn}:${index}`}>
                  Route {index + 1}: input cap {swap.maxAmountIn} token atoms;
                  minimum output {swap.minAmountOut} token atoms. Pair, router,
                  recipient and expiry are constrained on the account.
                </p>
              ))}
            </details>
          )}
          <div className="form-actions">
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
              onClick={() => setPrepared(null)}
            >
              Cancel
            </button>
            <button
              className="button primary small"
              type="button"
              disabled={!!busy || prepared.permission.expiresAt <= now}
              onClick={() => void authorize()}
            >
              {busy === "approve" ? <Spinner /> : null}
              {busy === "approve" ? "Confirming access..." : "Authorize in wallet"}
            </button>
          </div>
        </div>
      ) : (
        <div className="permission-form">
          <div className="form-grid">
            <Field label="Maximum per trade (USD)">
              <input
                inputMode="decimal"
                value={maxTrade}
                onChange={(event) => setMaxTrade(event.target.value)}
              />
            </Field>
            <Field label="Expires after">
              <select
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              >
                <option value="1">1 hour</option>
                <option value="6">6 hours</option>
                <option value="24">24 hours</option>
              </select>
            </Field>
          </div>
          <VenueSymbolPicker venue={account.venue} value={symbols} onChange={setSymbols} disabled={!!busy}/>
          {spot && <label className="checkbox"><input type="checkbox" checked={allowNativeInput} disabled={!!busy} onChange={event => setAllowNativeInput(event.target.checked)} />Also allow bounded native ETH wrapping for WETH/USDC sells. Off by default; no general transfer authority.</label>}
          <button
            className="button secondary full"
            type="button"
            disabled={
              !!busy ||
              !Number.isFinite(Number(maxTrade)) ||
              Number(maxTrade) <= 0 ||
              !symbols.trim()
            }
            onClick={() => void prepare()}
          >
            {busy === "prepare" ? <Spinner /> : null}{busy === "prepare" ? "Preparing review..." : "Review agent access"}
          </button>
        </div>
      )}
      <p className="fine-print">{spot ? "Swap routes and expiry are account-enforced. USD limits also run in Orcus." : "Orcus limits do not restrict the agent key outside Orcus."}</p>
      </div>}
      {(permission || disabledPermissions.length > 0 || !spot) && <details className={styles.details}>
        <summary>Advanced access controls</summary>
        {permission && <><p className="fine-print">Replace the agent signer and disable its Orcus access. {spot ? "The existing session must first be revoked." : "The old API wallet must also be removed in Hyperliquid."}</p><button className="button secondary small" type="button" disabled={!!busy || spot && !gas.ready} onClick={() => void revoke(true)}>{busy === "rotate" ? <Spinner /> : null}Replace agent signer</button></>}
      {!!disabledPermissions.length && <details className={styles.details}>
        <summary>Previous permissions ({disabledPermissions.length})</summary>
        <p className="warning-note">Application disablement or key rotation does not prove native trading authority was removed. Check each previous signer in the venue or smart account, even after refreshing this page.</p>
        {disabledPermissions.map(previous => <div className="evaluation" key={previous.id}>
          <Address value={previous.agentAddress} />
          <small>Application disabled / original expiry {new Date(previous.expiresAt).toLocaleString()}</small>
          {spot && previous.policy && <button className="button secondary small" type="button" disabled={!!busy || !gas.ready} onClick={() => void recoverDisabledGrant(previous)}>{busy === `recover:${previous.id}` ? <Spinner /> : null}Review native removal in owner wallet</button>}
          {!spot && <a className="text-link" href="https://app.hyperliquid-testnet.xyz/API" target="_blank" rel="noreferrer">Check this signer in native API wallet settings</a>}
        </div>)}
      </details>}
      {!spot && (
        <a
          className="text-link"
          href="https://app.hyperliquid-testnet.xyz/API"
          target="_blank"
          rel="noreferrer"
        >
          Manage native API wallets
          <ExternalLink size={12} />
        </a>
      )}
      </details>}
      <InlineError message={error} />
    </article>
  );
}

export type SettingsSection = "accounts" | "budget" | "agent" | "services";

export function SettingsView({ workspace: w, section = "accounts" }: { workspace: Workspace; section?: SettingsSection }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState("");
  const [operatingAmount, setOperatingAmount] = useState("");
  const [operatingHash, setOperatingHash] = useState<string | null>(null);
  const [preferences, setPreferences] = useState("");
  const [privateOnly, setPrivateOnly] = useState(false);
  const [privateVerification, setPrivateVerification] = useState<"independent-gateway" | "gateway-reported">("independent-gateway");
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [storageGasCap, setStorageGasCap] = useState("0.003");
  const [storageFeeCap, setStorageFeeCap] = useState("0.01");
  const [mode, setMode] = useState<"approval-required" | "autonomous">(
    "approval-required",
  );
  const agent = w.agentData?.agent ?? w.session.agent;
  useEffect(() => {
    const limits = w.budget?.storagePayer?.limits;
    if (limits) { setStorageGasCap(limits.maxGas0G); setStorageFeeCap(limits.maxStorageFee0G); }
  }, [w.budget?.storagePayer?.limits?.maxGas0G, w.budget?.storagePayer?.limits?.maxStorageFee0G]);

  useEffect(() => {
    if (w.budget) setCap(w.budget.limitUsd);
  }, [w.budget?.limitUsd]);
  useEffect(() => {
    if (agent) {
      setPreferences(agent.preferences);
      setMode(agent.mode);
      setPrivateVerification(agent.privateVerification ?? "independent-gateway");
      setPrivateOnly(
        Boolean(
          (agent as typeof agent & { privateInferenceRequired?: boolean })
            .privateInferenceRequired,
        ),
      );
    }
  }, [agent?.id, agent?.preferences, agent?.mode, agent?.privateInferenceRequired, agent?.privateVerification]);

  async function addAccount(venue: Venue) {
    setBusy(venue);
    setError(null);
    try {
      if (venue === "uniswap") {
        const account = await createTradingSmartAccount();
        await post("/api/accounts", {
          venue,
          smartAccountAddress: account.address,
          chainId: account.chainId,
        });
        w.setNotice(
          "Smart account added. Fund its displayed address explicitly before swapping; no owner funds were moved.",
        );
      } else {
        await post("/api/accounts", { venue });
        w.setNotice(
          `${venueName(venue)} account added. Agent authorization remains a separate owner approval.`,
        );
      }
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveBudget() {
    setBusy("budget");
    setError(null);
    try {
      await post("/api/budget", { limitUsd: cap });
      w.setNotice(
        "Expense allowance saved. It does not deposit funds or create compute credits.",
      );
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function fundOperating() {
    if (!w.session.user || !agent) return;
    setBusy("fund-operating");
    setError(null);
    try {
      const result = await fundOperatingWallet({ ownerAddress: w.session.user.address, operatingAddress: agent.operatingAddress, amount: operatingAmount });
      setOperatingHash(result.transactionHash);
      setOperatingAmount("");
      w.setNotice("Testnet 0G funding confirmed for the operating wallet. It can pay for memory storage; it is not a compute-account top-up.");
      await w.refresh();
    } catch (cause) {
      if (cause && typeof cause === "object" && "evidence" in cause) {
        const evidence = cause.evidence as { transactionHash?: string } | undefined;
        if (evidence?.transactionHash) setOperatingHash(evidence.transactionHash);
      }
      setError(displayError(cause));
    } finally { setBusy(null); }
  }

  async function saveAgent() {
    setBusy("agent");
    setError(null);
    try {
      await post("/api/agent/control", {
        command: "update",
        preferences,
        mode,
        privateInferenceRequired: privateOnly,
        privateVerification,
      });
      w.setNotice(
        "Agent preferences saved. Existing venue permissions still define its authority.",
      );
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function memory(action: "backup" | "restore") {
    setBusy(action);
    setError(null);
    setMemoryStatus(null);
    try {
      const result = await post<{ rootHash?: string; restoredCount?: number }>(
        "/api/memory",
        { action, ...(action === "backup" ? { maxGas0G: storageGasCap, maxStorageFee0G: storageFeeCap } : {}) },
      );
      setMemoryStatus(
        action === "backup"
          ? `Encrypted backup confirmed${result.rootHash ? `: ${result.rootHash}` : "."}`
          : `Memory restored${result.restoredCount === undefined ? "." : ` (${result.restoredCount} records).`}`,
      );
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function reconcileStorage(expenseId: string) {
    setBusy(expenseId);
    setError(null);
    try {
      await post("/api/memory/reconcile", { expenseId });
      await w.refresh();
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(null); }
  }

  return (
    <section className={`workspace-page settings-page ${panels.page}`}>
      <div className="page-heading settings-content-heading">
        <div>
          <h2>{{ accounts: "Trading accounts", budget: "Spending & credits", agent: "Your agent", services: "Connected services" }[section]}</h2>
          <p>
            {{ accounts: "Your accounts. Trade manually, or enable your agent when you need it.", budget: "Set an expense limit and manage credits. Your trading capital stays separate.", agent: "Choose how it works, what it remembers, and when it asks you.", services: "The tools behind your workspace, with their current configuration." }[section]}
          </p>
        </div>
      </div>
      <InlineError message={error} onDismiss={() => setError(null)} />
      {!w.session.user && section !== "services" ? (
        <Empty
          title="Sign in to manage your workspace"
          action={
            <button
              className="button primary"
              type="button"
              disabled={w.connecting}
              onClick={() => void w.connect()}
            >
              <Wallet size={14} />
              Connect wallet
            </button>
          }
        >
          Connect your owner wallet to manage accounts, agent access and operating costs.
        </Empty>
      ) : w.session.user ? (
        <>
          {section === "accounts" && <>
          <div className="settings-section-heading settings-account-actions">
            <div className="account-add-buttons">
              {!w.session.accounts.some(account => account.venue === "ostium") && <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void addAccount("ostium")}>{busy === "ostium" ? <Spinner/> : <Plus size={13}/>}Ostium</button>}
              {!w.session.accounts.some(
                (account) => account.venue === "hyperliquid",
              ) && (
                <button
                  className="button secondary small"
                  type="button"
                  disabled={!!busy}
                  onClick={() => void addAccount("hyperliquid")}
                >
                  {busy === "hyperliquid" ? <Spinner /> : <Plus size={13} />}
                  Hyperliquid
                </button>
              )}
              {!w.session.accounts.some(
                (account) => account.venue === "uniswap",
              ) && (
                <button
                  className="button secondary small"
                  type="button"
                  disabled={!!busy}
                  onClick={() => void addAccount("uniswap")}
                >
                  {busy === "uniswap" ? <Spinner /> : <Plus size={13} />}Uniswap
                </button>
              )}
            </div>
          </div>
          <div className={`settings-grid ${styles.grid}`}>
            {w.session.accounts.map((account) => (
              account.venue === "ostium" ? <OstiumAccountCard key={account.id} account={account} workspace={w} /> : <AccountCard key={account.id} account={account} workspace={w} />
            ))}
            {!w.session.accounts.length && (
              <div className="settings-card account-intro">
                <Wallet size={25} />
                <h2>Add your first trading account</h2>
                <p>
                  Hyperliquid and Ostium use your owner-controlled venue account.
                  Uniswap uses a smart account you own. Adding an account does not
                  authorize the agent.
                </p>
              </div>
            )}
          </div>
          </>}
          {section === "budget" && <dl className={panels.stats}>
            <div className={panels.stat}><dt>Remaining expense allowance</dt><dd>{usd(w.budget?.availableUsd)}</dd><small>Spending limit, not a funded balance</small></div>
            <div className={panels.stat}><dt>Recorded expenses</dt><dd>{usd(w.budget?.spentUsd)}</dd><small>Usage recorded by Orcus</small></div>
            <div className={panels.stat}><dt>Reserved for pending work</dt><dd>{usd(w.budget?.reservedUsd)}</dd><small>Held until billing is resolved</small></div>
          </dl>}
          {(section === "budget" || section === "agent") && <div className={panels.layout}>
            {section === "budget" && <>
            <article className={`settings-card ${panels.card}`}>
              <div className={panels.heading}>
                <div>
                  <h2>Spending limit</h2>
                  <p>Control what your agent can spend on running.</p>
                </div>
              </div>
              <Field label="Total expense limit (USD)">
                <input
                  inputMode="decimal"
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <p className="fine-print">
                Saving this limit does not deposit funds or add compute credits.
              </p>
              <button
                className="button primary"
                type="button"
                disabled={
                  busy === "budget" ||
                  cap === "" ||
                  !Number.isFinite(Number(cap)) ||
                  Number(cap) < 0
                }
                onClick={() => void saveBudget()}
              >
                {busy === "budget" && <Spinner />}Save spending limit
              </button>
              <details className={panels.disclosure}><summary>Compute account & operating wallet</summary>
              <dl className="account-addresses">
                <div>
                  <dt>Operating wallet</dt>
                  <dd>
                    <Address value={agent?.operatingAddress} />
                  </dd>
                </div>
                <div>
                  <dt>Compute balance</dt>
                  <dd>
                    {w.budget?.computeBalanceStatus === "verified"
                      ? `${w.budget.providerBalance?.balance ?? "Verified"} ${w.budget.providerBalance?.unit ?? "provider units"}`
                      : "Not verified"}
                  </dd>
                </div>
                <div>
                  <dt>Replenishment</dt>
                  <dd>
                    <Status
                      value={w.budget?.replenishmentStatus ?? "unconfigured"}
                    />
                  </dd>
                </div>
              </dl>
              {w.budget?.providerBalance?.accountAddress && <p className="fine-print">Provider account: <Address value={w.budget.providerBalance.accountAddress} />. Shared provider credits, not a per-user pool.</p>}
              {w.budget?.warning && <p className="fine-print">{w.budget.warning}</p>}
              </details>
              {w.budget?.storagePayer?.costBearer !== "operator" && <details className={panels.disclosure} open={!!operatingHash}>
                <summary>Fund the operating wallet for testnet storage gas</summary>
                <p className="fine-print">Transfer testnet 0G on Galileo to the separate operating address above. Your owner wallet signs the amount and pays gas. This neither funds trading nor deposits into the compute provider.</p>
                <Field label="Testnet 0G amount"><input inputMode="decimal" value={operatingAmount} onChange={event => setOperatingAmount(event.target.value)} placeholder="0.01" /></Field>
                <button className="button secondary small" type="button" disabled={!!busy || !!operatingHash || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(operatingAmount) || Number(operatingAmount) <= 0} onClick={() => void fundOperating()}>{busy === "fund-operating" ? <Spinner /> : <Wallet size={13} />}Fund in owner wallet</button>
                {operatingHash && <><a className="text-link" href={`https://chainscan-galileo.0g.ai/tx/${operatingHash}`} target="_blank" rel="noreferrer">Inspect operating transfer<ExternalLink size={12} /></a><button className="button secondary small" type="button" onClick={() => setOperatingHash(null)}>I checked this transfer; enter another</button></>}
              </details>}
              {!!w.budget?.expenses?.length && <details className={panels.disclosure} open={w.budget.expenses.some(expense => expense.status === "unknown")}><summary>Expense history ({w.budget.expenses.length})</summary>{w.budget.expenses.slice(0, 20).map(expense => <div className="evaluation" key={expense.id}><small>{expense.status} / {usd(expense.amountUsd)}</small><code>{expense.reference}</code>{w.session.user && <ExpenseBillingCheck key={`${w.session.user.address.toLowerCase()}:${expense.id}`} owner={w.session.user.address} expenseId={expense.id} status={expense.status} onRefresh={w.refresh} />}</div>)}</details>}
            </article>
            {w.session.user && <ServicePaymentPanel key={`service:${w.session.user.address.toLowerCase()}`} owner={w.session.user.address} onRefresh={w.refresh} />}
            {w.session.user && <details className={`${panels.disclosure} ${panels.full}`} open={w.funding?.intents.some(intent => ["submitting", "submitted-unknown"].includes(intent.status))}><summary>Advanced compute funding</summary><p className="fine-print">Optional native 0G deposits. Not required to use agent inference and separate from service credits.</p><ComputeFundingPanel key={w.session.user.id} onRefresh={w.refresh} /></details>}
            </>}
            {section === "agent" && <article className={`settings-card ${panels.card}`}>
              <div className={panels.heading}>
                <div>
                  <h2>How your agent works</h2>
                  <p>Preferences stay within your account permissions.</p>
                </div>
                <Badge tone={!agent || agent.paused ? "neutral" : "good"}>{!agent ? "Unavailable" : agent.paused ? "Paused" : "Running"}</Badge>
              </div>
              <fieldset className={panels.modeGrid}><legend>Execution mode</legend>
                <label className={panels.mode}><input type="radio" name="agent-mode" value="approval-required" checked={mode === "approval-required"} disabled={!!busy} onChange={() => setMode("approval-required")}/><span><strong>Ask me first</strong><small>Review each proposed action.</small></span></label>
                <label className={panels.mode}><input type="radio" name="agent-mode" value="autonomous" checked={mode === "autonomous"} disabled={!!busy} onChange={() => setMode("autonomous")}/><span><strong>Within my limits</strong><small>Act using granted permissions.</small></span></label>
              </fieldset>
              <Field label="Your instructions">
                <textarea
                  rows={4}
                  value={preferences}
                  onChange={(event) => setPreferences(event.target.value)}
                  placeholder="My preferred assets, risk tolerance and trading constraints..."
                />
              </Field>
              <label className={panels.toggleRow}>
                <span><strong>Require private inference</strong><p className={panels.hint}>Stops if the selected privacy assurance is unavailable.</p></span>
                <input
                  type="checkbox"
                  checked={privateOnly}
                  onChange={(event) => setPrivateOnly(event.target.checked)}
                />
              </label>
              {privateOnly && <Field label="Private inference assurance"><select value={privateVerification} onChange={event => setPrivateVerification(event.target.value as typeof privateVerification)}><option value="independent-gateway">Independent hardware and code verification</option><option value="gateway-reported">Trust 0G gateway's sealed-execution report</option></select></Field>}
              {privateOnly && <p className={panels.hint}>{privateVerification === "independent-gateway" ? "Verifies gateway evidence and pins its TLS certificate. Missing evidence stops inference." : "Trusts the 0G gateway report, without independent hardware attestation."} Public venue trades remain public.</p>}
              <button
                className="button primary"
                type="button"
                disabled={busy === "agent"}
                onClick={() => void saveAgent()}
              >
                {busy === "agent" && <Spinner />}Save preferences
              </button>
              <div className={panels.footer}>
                <p>Pause new actions.<br/>Submitted trades still reconcile.</p>
                <div className={panels.actions}>
                <button
                  className="button secondary small"
                  type="button"
                  disabled={w.controlling}
                  onClick={() => void w.control(agent?.paused ? "resume" : "pause")}
                >
                  {w.controlling && <Spinner/>}{agent?.paused ? "Resume agent" : "Pause agent"}
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  disabled={w.controlling}
                  onClick={() => void w.control("take-over")}
                >
                  Take over accounts
                </button>
                </div>
              </div>
            </article>}
            {section === "agent" && <MemoryControls key={w.session.user.id} userId={w.session.user.id} />}
          </div>}
        </>
      ) : null}
      {w.session.user && section === "agent" && (
        <section className={`settings-card ${panels.card}`}>
          <div className={panels.heading}>
            <div>
              <h2>Memory backups</h2>
              <p>Encrypted preferences and conversation context on 0G Storage.</p>
            </div>
            <Badge tone={w.budget?.storagePayer?.enabled ? "good" : "neutral"}>{w.budget?.storagePayer?.enabled ? "Available" : "Not enabled"}</Badge>
          </div>
          {w.budget?.storagePayer?.enabled === false ? <p className={panels.quietNotice}>Cloud backups are disabled. Saved notes and preferences remain available in your workspace.</p> : <p className={panels.hint}>Each backup can spend up to {storageGasCap} 0G in gas and {storageFeeCap} 0G in storage fees, separate from your inference allowance. Wallet signing credentials are not included.</p>}
          <details className={panels.disclosure}><summary>Storage payer & fee limits</summary>
          {w.budget?.storagePayer && <p>{w.budget.storagePayer.message}{w.budget.storagePayer.dailyCap0G ? ` Shared daily limit: ${w.budget.storagePayer.dailyCap0G} 0G.` : ""}</p>}
          {w.budget?.storagePayer?.payerAddress && <p>Fee payer: <Address value={w.budget.storagePayer.payerAddress} explorer="https://chainscan-galileo.0g.ai" /></p>}
          <div className="form-grid">
            <Field label="Maximum transaction gas per backup (0G)"><input inputMode="decimal" value={storageGasCap} maxLength={27} disabled={!!busy} onChange={event => setStorageGasCap(event.target.value)} /></Field>
            <Field label="Maximum storage fee per backup (0G)"><input inputMode="decimal" value={storageFeeCap} maxLength={27} disabled={!!busy} onChange={event => setStorageFeeCap(event.target.value)} /></Field>
          </div></details>
          <div className="memory-actions">
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy || w.budget?.storagePayer?.enabled === false}
              onClick={() => void memory("backup")}
            >
              {busy === "backup" && <Spinner />}Back up memory
            </button>
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy || w.budget?.storagePayer?.enabled === false}
              onClick={() => void memory("restore")}
            >
              {busy === "restore" && <Spinner />}Restore latest backup
            </button>
          </div>
          {memoryStatus && (
            <p className={panels.quietNotice} role="status">
              {memoryStatus}
            </p>
          )}
          {!!w.budget?.nativeExpenses?.length && <details className={panels.disclosure} open={w.budget.nativeExpenses.some(expense => expense.status === "submitted-unknown")}><summary>Storage receipts</summary>{w.budget.nativeExpenses.map(expense => <div className="evaluation" key={expense.id} style={{ fontVariantNumeric: "tabular-nums" }}><Status value={expense.status} /><small>Total: {tokenUnits(expense.totalSpentWei, 18, "0G")}; gas: {tokenUnits(expense.gasPaidWei, 18, "0G")}; storage: {tokenUnits(expense.storageFeeWei, 18, "0G")}</small><a className="text-link" href={`https://chainscan-galileo.0g.ai/tx/${expense.transactionHash}`} target="_blank" rel="noreferrer">View receipt<ExternalLink size={12} /></a>{expense.status === "submitted-unknown" && <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void reconcileStorage(expense.id)}>Check receipt without uploading again</button>}</div>)}</details>}
        </section>
      )}
      {section === "services" && <>
        <div className={panels.services}>
          {(
            ["compute", "storage", "uniswap", "hyperliquid", "ostium", "cre"] as const
          ).map((key) => {
            const service = w.health?.[key];
            return (
              <article className={`settings-card ${panels.card}`} key={key}>
                <div className={panels.serviceTitle}>
                  <ProtocolIcon name={key === "compute" || key === "storage" ? "0g" : key === "cre" ? "chainlink" : key} size={32}/>
                  <div><h3>{{ compute: "0G inference", storage: "0G Storage", uniswap: "Uniswap", hyperliquid: "Hyperliquid", ostium: "Ostium", cre: "Chainlink CRE" }[key]}</h3>
                  <p>{{ compute: "Agent reasoning", storage: "Encrypted backups", uniswap: "Sepolia spot swaps", hyperliquid: "Testnet perpetuals", ostium: "Arbitrum Sepolia", cre: "Local workflow simulation" }[key]}</p></div>
                </div>
                <div className={panels.serviceState}><span>Configuration</span><Badge tone={service?.configured ? "good" : "neutral"}>{!service ? "Checking" : service.configured ? "Configured" : "Not configured"}</Badge></div>
                <details className={panels.disclosure}><summary>View details</summary><p>{service?.message ?? "Waiting for service status."}</p></details>
              </article>
            );
          })}
        </div>
        <p className={panels.hint}>Configured does not guarantee a successful live request. CRE uses local simulation, not hosted DON execution. Public venue trades remain public.</p>
      </>}
    </section>
  );
}
