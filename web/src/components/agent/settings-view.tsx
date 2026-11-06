"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Database,
  ExternalLink,
  KeyRound,
  Plus,
  RotateCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { AgentPermission, TradingAccount } from "@orcus/core";
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
import { tokenUnits, usd } from "@/lib/format";
import { tradingGasStatus, withFundingRecoveryIntent } from "@/lib/trade-ux";
import { clearDepositRecovery, depositRecoveryKey, readDepositRecovery } from "@/lib/deposit-recovery";
import { ProtocolIcon } from "../workspace/asset-icon";
import { MemoryControls } from "./memory-controls";
import { ComputeFundingPanel } from "./compute-funding-panel";
import { ServicePaymentPanel } from "./service-payment-panel";
import { ExpenseBillingCheck } from "./expense-billing-check";
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

function AccountCard({
  account,
  workspace: w,
}: {
  account: TradingAccount;
  workspace: Workspace;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
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
  const spot = account.venue === "uniswap";
  const disabledPermissions = (w.agentData?.permissions ?? []).filter(item => item.accountId === account.id && item.status === "revoked" && item.expiresAt > Date.now()) as Permission[];
  const gas = tradingGasStatus(w.walletConfig, account.venue);
  const fundingRecoveryKey = depositRecoveryKey(account.ownerAddress, account.id);
  const currentFundingKey = useRef(fundingRecoveryKey);
  currentFundingKey.current = fundingRecoveryKey;
  const fundingLoaded = loadedFundingKey === fundingRecoveryKey;
  const fundingHash = fundingLoaded ? storedFundingHash : null;
  const fundingState = fundingLoaded ? storedFundingState : null;
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
    <article className="settings-card account-card">
      <div className="card-heading">
        <ProtocolIcon name={account.venue} size={36}/>
        <div>
          <h2>{spot ? "Uniswap" : "Hyperliquid"}</h2>
          <p>
            {spot
              ? "Sepolia / user-owned smart account"
              : "Testnet / existing owner account"}
          </p>
        </div>
        <Status value={account.status} />
      </div>
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
          ? "Your owner wallet controls this Sepolia trading account. Deposit only the assets you want to trade; connecting does not move funds. Manual trades and your approved agent use this same account."
          : "Existing supported positions stay in your account. The same positions can be managed manually or by your approved agent."}
      </p>
      {spot && <p className={gas.ready ? "fine-print" : "warning-note"}><strong>{gas.label}.</strong> {gas.detail} No 0G is required for normal trading.</p>}
      {spot && (
        <details className="technical-limits">
          <summary>Deposit Sepolia assets from your owner wallet</summary>
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
          <p className="fine-print">Your owner wallet signs this initial transfer and pays its Sepolia network fee. Smart-account trading gas is a separate platform-sponsored flow. This does not bridge mainnet funds or fund 0G compute.</p>
          <p className="fine-print">Deposit destination: <code style={{ overflowWrap: "anywhere" }}>{account.address}</code></p>
          <button className="button secondary small" type="button" disabled={!!busy || !fundingLoaded || !!fundingHash || fundingState === "unknown" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fundingAmount) || Number(fundingAmount) <= 0} onClick={() => void fund()}>
            {busy === "fund" ? <><Spinner />Confirm transfer and await receipt</> : <><Wallet size={13} />Review transfer in owner wallet</>}
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
      {permission ? (
        <>
          <div className="permission-active">
            <ShieldCheck size={15} />
            <div>
              <strong>Agent permission active</strong>
              <span>
                {permission.allowedSymbols.join(", ") ||
                  "All supported symbols"}{" "}
                / up to {usd(permission.maxTradeUsd)} per action / expires{" "}
                {new Date(permission.expiresAt).toLocaleString()}
              </span>
            </div>
          </div>
          {spot && <p className="fine-print">{permission.policy?.nativeWrap ? `Native ETH wrapping is permitted up to ${formatUnits(BigInt(permission.policy.nativeWrap.maxAmountWei), 18)} ETH per call, within the approved routes and expiry.` : "Native ETH wrapping is not included in this grant. Manual ETH input remains an owner-signed action."}</p>}
          <div className="form-actions">
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy || spot && !gas.ready}
              onClick={() => void revoke(true)}
            >
              {busy === "rotate" ? <Spinner /> : <RotateCw size={13} />}Rotate
              signer
            </button>
            <button
              className="button danger small"
              type="button"
              disabled={!!busy || spot && !gas.ready}
              onClick={() => void revoke()}
            >
              {busy === "revoke" ? <Spinner /> : <KeyRound size={13} />}Revoke
              agent access
            </button>
          </div>
          {spot && !gas.ready && <p className="warning-note">Native session revocation needs an executable sponsored operation. <button className="text-button" type="button" onClick={() => void w.control("pause")} disabled={w.agentData?.agent.paused || w.controlling}>Pause new agent actions now</button>; existing onchain authority remains until it is revoked.</p>}
        </>
      ) : prepared ? (
        <div className="permission-review">
          <span className="eyebrow">REVIEW THE AUTHORITY YOU ARE GRANTING</span>
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
              disabled={!!busy}
              onClick={() => void authorize()}
            >
              {busy === "approve" ? <Spinner /> : <ShieldCheck size={14} />}
              Approve in owner wallet
            </button>
          </div>
        </div>
      ) : (
        <div className="permission-form">
          <div className="form-grid">
            <Field label="Maximum action value (USD)">
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
          <Field
            label="Allowed symbols"
            hint="Comma-separated. Permissions are checked separately from model reasoning."
          >
            <input
              value={symbols}
              onChange={(event) => setSymbols(event.target.value)}
              placeholder="BTC, ETH"
            />
          </Field>
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
            {busy === "prepare" ? <Spinner /> : <KeyRound size={14} />}Prepare
            agent permission
          </button>
        </div>
      )}
      {!!disabledPermissions.length && <details className="technical-limits">
        <summary>Review previously disabled or rotated signers</summary>
        <p className="warning-note">Application disablement or key rotation does not prove native trading authority was removed. Check each previous signer in the venue or smart account, even after refreshing this page.</p>
        {disabledPermissions.map(previous => <div className="evaluation" key={previous.id}>
          <Address value={previous.agentAddress} />
          <small>Application disabled / original expiry {new Date(previous.expiresAt).toLocaleString()}</small>
          {spot && previous.policy && <button className="button secondary small" type="button" disabled={!!busy || !gas.ready} onClick={() => void recoverDisabledGrant(previous)}>{busy === `recover:${previous.id}` ? <Spinner /> : null}Review native removal in owner wallet</button>}
          {!spot && <a className="text-link" href="https://app.hyperliquid-testnet.xyz/API" target="_blank" rel="noreferrer">Check this signer in native API wallet settings</a>}
        </div>)}
      </details>}
      <p className="permission-boundary">
        <ShieldCheck size={12} />
        {spot
          ? "Token pair, input/output bounds, recipient and expiry are account-enforced. USD/risk limits also run in the application."
          : "Custom risk and USD limits are app-enforced. Hyperliquid grants broader native trading authority to the approved signer."}
      </p>
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

  async function addAccount(venue: "uniswap" | "hyperliquid") {
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
          "Hyperliquid account added. Agent authorization remains a separate owner approval.",
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
    <section className="workspace-page settings-page">
      <div className="page-heading settings-content-heading">
        <div>
          <span className="eyebrow">OWNERSHIP BEFORE AUTOMATION</span>
          <h2>{{ accounts: "Trading accounts", budget: "Operating budget", agent: "Agent preferences & memory", services: "Service status" }[section]}</h2>
          <p>
            {{ accounts: "Trade yourself or grant limited access to the same accounts. Your owner private key is never shared.", budget: "Trading capital, application expense limits, service credits and native 0G are separate balances.", agent: "Control how your agent works and what it remembers. Preferences never grant trading authority.", services: "Inspect configuration and availability before relying on an integration." }[section]}
          </p>
        </div>
        <ShieldCheck size={22} />
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
          <div className="settings-section-heading">
            <div>
              <h2>Trading accounts</h2>
              <p>
                Trade manually first. Delegate only the authority you choose.
              </p>
            </div>
            <div className="account-add-buttons">
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
          <div className="settings-grid">
            {w.session.accounts.map((account) => (
              <AccountCard key={account.id} account={account} workspace={w} />
            ))}
            {!w.session.accounts.length && (
              <div className="settings-card account-intro">
                <Wallet size={25} />
                <h2>Add your first trading account</h2>
                <p>
                  Hyperliquid uses your existing venue account. Uniswap uses a
                  separate smart account you own. Adding either does not
                  authorize the agent.
                </p>
              </div>
            )}
          </div>
          </>}
          {(section === "budget" || section === "agent") && <div className="settings-grid secondary-settings">
            {section === "budget" && <>
            <article className="settings-card">
              <div className="card-heading">
                <Wallet size={20} />
                <div>
                  <h2>Agent operating budget</h2>
                  <p>Expenses, not trading capital</p>
                </div>
              </div>
              <div className="budget-values">
                <div>
                  <span>Available allowance</span>
                  <strong>{usd(w.budget?.availableUsd)}</strong>
                </div>
                <div>
                  <span>Recorded expenses</span>
                  <strong>{usd(w.budget?.spentUsd)}</strong>
                </div>
              </div>
              <Field label="Authorized expense cap (USD)">
                <input
                  inputMode="decimal"
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <p className="fine-print">
                This changes an application spending cap, not a wallet deposit.
                Actual 0G credits and onchain operating funds are separate
                balances.
              </p>
              <button
                className="button secondary full"
                type="button"
                disabled={
                  busy === "budget" ||
                  cap === "" ||
                  !Number.isFinite(Number(cap)) ||
                  Number(cap) < 0
                }
                onClick={() => void saveBudget()}
              >
                {busy === "budget" ? <Spinner /> : <Check size={14} />}Save
                expense cap
              </button>
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
              {w.budget?.storagePayer?.costBearer !== "operator" && <details className="technical-limits">
                <summary>Fund the operating wallet for testnet storage gas</summary>
                <p className="fine-print">Transfer testnet 0G on Galileo to the separate operating address above. Your owner wallet signs the amount and pays gas. This neither funds trading nor deposits into the compute provider.</p>
                <Field label="Testnet 0G amount"><input inputMode="decimal" value={operatingAmount} onChange={event => setOperatingAmount(event.target.value)} placeholder="0.01" /></Field>
                <button className="button secondary small" type="button" disabled={!!busy || !!operatingHash || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(operatingAmount) || Number(operatingAmount) <= 0} onClick={() => void fundOperating()}>{busy === "fund-operating" ? <Spinner /> : <Wallet size={13} />}Fund in owner wallet</button>
                {operatingHash && <><a className="text-link" href={`https://chainscan-galileo.0g.ai/tx/${operatingHash}`} target="_blank" rel="noreferrer">Inspect operating transfer<ExternalLink size={12} /></a><button className="button secondary small" type="button" onClick={() => setOperatingHash(null)}>I checked this transfer; enter another</button></>}
              </details>}
              {w.budget?.providerBalance?.accountAddress && <p className="fine-print">Configured provider account: <Address value={w.budget.providerBalance.accountAddress} />. This is not a separate per-user credit pool.</p>}
              <p className="fine-print">Pending expense reservations: {usd(w.budget?.reservedUsd)}. Requests with unknown billing retain their reservation instead of reporting an invented cost.</p>
              {!!w.budget?.expenses?.length && <details className="technical-limits"><summary>Operating expense evidence</summary>{w.budget.expenses.slice(0, 20).map(expense => <div className="evaluation" key={expense.id}><small>{expense.status} / {usd(expense.amountUsd)}</small><code>{expense.reference}</code>{w.session.user && <ExpenseBillingCheck key={`${w.session.user.address.toLowerCase()}:${expense.id}`} owner={w.session.user.address} expenseId={expense.id} status={expense.status} onRefresh={w.refresh} />}</div>)}</details>}
              <p className="warning-note">
                {w.budget?.warning ??
                  "Live credit balance and replenishment require a verified provider funding path. Owner deposits are not earned revenue."}
              </p>
            </article>
            {w.session.user && <ServicePaymentPanel key={`service:${w.session.user.address.toLowerCase()}`} owner={w.session.user.address} onRefresh={w.refresh} />}
            {w.session.user && <details className="technical-limits"><summary>Advanced: native compute-account funding</summary><p className="fine-print">Optional operator integration controls, not a requirement for using agent inference. A service-payment checkout is separate from these native deposits.</p><ComputeFundingPanel key={w.session.user.id} onRefresh={w.refresh} /></details>}
            </>}
            {section === "agent" && <article className="settings-card">
              <div className="card-heading">
                <ShieldCheck size={20} />
                <div>
                  <h2>Agent preferences</h2>
                  <p>Your instructions never override account permissions</p>
                </div>
              </div>
              <Field label="Execution mode">
                <select
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as typeof mode)
                  }
                >
                  <option value="approval-required">Ask for my approval</option>
                  <option value="autonomous">
                    Autonomous within granted limits
                  </option>
                </select>
              </Field>
              <Field label="Preferences">
                <textarea
                  rows={4}
                  value={preferences}
                  onChange={(event) => setPreferences(event.target.value)}
                  placeholder="My preferred assets, risk tolerance and trading constraints..."
                />
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={privateOnly}
                  onChange={(event) => setPrivateOnly(event.target.checked)}
                />
                Require private inference
              </label>
              {privateOnly && <Field label="Private inference assurance"><select value={privateVerification} onChange={event => setPrivateVerification(event.target.value as typeof privateVerification)}><option value="independent-gateway">Independent hardware and code verification</option><option value="gateway-reported">Trust 0G gateway's sealed-execution report</option></select></Field>}
              <p className="fine-print">Independent mode verifies the gateway and pins its TLS certificate; it stops if required evidence is unavailable. Gateway-reported mode explicitly trusts 0G&apos;s sealed-execution report and is not independently attested. Neither mode makes public venue trades private.</p>
              <button
                className="button secondary full"
                type="button"
                disabled={busy === "agent"}
                onClick={() => void saveAgent()}
              >
                {busy === "agent" ? <Spinner /> : <Check size={14} />}Save agent
                preferences
              </button>
              <div className="settings-emergency">
                <button
                  className="button danger small"
                  type="button"
                  onClick={() => void w.control("pause")}
                >
                  Pause agent
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => void w.control("take-over")}
                >
                  Take over accounts
                </button>
              </div>
            </article>}
          </div>}
        </>
      ) : null}
      {w.session.user && section === "agent" && (
        <section className="settings-card service-status">
          <div className="card-heading">
            <Database size={19} />
            <div>
              <h2>Encrypted agent memory</h2>
              <p>0G Storage / separate from wallet signing credentials</p>
            </div>
          </div>
          <p className="fine-print">
            Back up encrypted preferences and conversation context with the
            {w.budget?.storagePayer?.costBearer === "operator" ? "platform's capped Galileo payer. You do not need 0G in your wallet for these sponsored backups." : "authorized Galileo operating wallet."} Each backup can spend up to the gas and storage-fee caps below. These native 0G costs are separate from the USD inference allowance. A
            failed upload is never shown as a persisted backup.
          </p>
          {w.budget?.storagePayer && <p className="fine-print">{w.budget.storagePayer.message}{w.budget.storagePayer.dailyCap0G ? ` Shared platform daily limit: ${w.budget.storagePayer.dailyCap0G} 0G.` : ""}</p>}
          {w.budget?.storagePayer?.payerAddress && <p className="fine-print">Storage fee payer: <Address value={w.budget.storagePayer.payerAddress} explorer="https://chainscan-galileo.0g.ai" /></p>}
          {w.budget?.storagePayer?.enabled === false && <p className="warning-note">The storage integration is currently disabled by the operator.</p>}
          <details className="technical-limits"><summary>Advanced native fee ceilings</summary><div className="form-grid">
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
              {busy === "backup" ? <Spinner /> : <Database size={13} />}Back up
              encrypted memory
            </button>
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy || w.budget?.storagePayer?.enabled === false}
              onClick={() => void memory("restore")}
            >
              {busy === "restore" ? <Spinner /> : <RotateCw size={13} />}Restore
              latest backup
            </button>
          </div>
          {memoryStatus && (
            <p className="memory-status" role="status">
              {memoryStatus}
            </p>
          )}
          {!!w.budget?.nativeExpenses?.length && <details className="technical-limits"><summary>Native storage expense receipts</summary>{w.budget.nativeExpenses.map(expense => <div className="evaluation" key={expense.id} style={{ fontVariantNumeric: "tabular-nums" }}><Status value={expense.status} /><small>Total: {tokenUnits(expense.totalSpentWei, 18, "0G")}; gas: {tokenUnits(expense.gasPaidWei, 18, "0G")}; storage: {tokenUnits(expense.storageFeeWei, 18, "0G")}</small><a className="text-link" href={`https://chainscan-galileo.0g.ai/tx/${expense.transactionHash}`} target="_blank" rel="noreferrer">Inspect expense<ExternalLink size={12} /></a>{expense.status === "submitted-unknown" && <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void reconcileStorage(expense.id)}>Check receipt without uploading again</button>}</div>)}</details>}
          <MemoryControls key={w.session.user.id} userId={w.session.user.id} />
        </section>
      )}
      {section === "services" && <section className="service-status settings-card">
        <div className="card-heading">
          <Database size={19} />
          <div>
            <h2>Integration status</h2>
            <p>Configuration is not proof of a successful live request.</p>
          </div>
        </div>
        <div className="service-grid">
          {(
            ["compute", "storage", "uniswap", "hyperliquid", "cre"] as const
          ).map((key) => {
            const service = w.health?.[key];
            return (
              <div className="service-item" key={key}>
                <div>
                  <strong>
                    {
                      {
                        compute: "0G inference",
                        storage: "0G encrypted memory",
                        uniswap: "Uniswap V3",
                        hyperliquid: "Hyperliquid testnet",
                        cre: "Chainlink CRE",
                      }[key]
                    }
                  </strong>
                  <Badge tone={service?.configured ? "good" : "warn"}>
                    {service?.configured ? "Configured" : "Needs setup"}
                  </Badge>
                </div>
                <p>{service?.message ?? "Waiting for service status."}</p>
              </div>
            );
          })}
        </div>
        <p className="fine-print">
          CRE runs as local simulation with a managed worker in this build, not
          hosted DON execution. Public swaps and positions remain public. Manual
          owner exits do not depend on inference or the CRE runner.
        </p>
      </section>}
    </section>
  );
}
