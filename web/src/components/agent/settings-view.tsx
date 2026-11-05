"use client";

import { useEffect, useState } from "react";
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
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError, post } from "@/lib/api";
import {
  approveHyperliquidAgent,
  createTradingSmartAccount,
  grantKernelPermission,
  revokeKernelPermission,
} from "@/lib/wallets";
import { usd } from "@/lib/format";
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
  const [error, setError] = useState<string | null>(null);
  const [maxTrade, setMaxTrade] = useState("100");
  const [symbols, setSymbols] = useState(
    account.venue === "uniswap" ? "WETH/USDC" : "BTC, ETH",
  );
  const [hours, setHours] = useState("24");
  const [prepared, setPrepared] = useState<PreparedPermission | null>(null);
  const permission = w.agentData?.permissions.find(
    (item) => item.accountId === account.id && item.status === "active",
  ) as Permission | undefined;
  const spot = account.venue === "uniswap";

  async function prepare() {
    setBusy("prepare");
    setError(null);
    try {
      const result = await post<PreparedPermission>("/api/permissions", {
        accountId: account.id,
        action: "prepare",
        expiresAt: Date.now() + Number(hours) * 3_600_000,
        maxTradeUsd: maxTrade,
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
      setBusy(null);
    }
  }

  async function authorize() {
    if (!prepared) return;
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
      setBusy(null);
    }
  }

  async function revoke(rotate = false) {
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
        await revokeKernelPermission(policy);
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
      setBusy(null);
    }
  }

  return (
    <article className="settings-card account-card">
      <div className="card-heading">
        <span className={`venue-icon ${spot ? "uni" : "hyper"}`}>
          {spot ? "U" : "H"}
        </span>
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
          ? "Fund this smart account explicitly with Sepolia assets and gas. Connecting your owner wallet does not move its funds."
          : "Existing supported positions stay in your account. The same positions can be managed manually or by your approved agent."}
      </p>
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
          <div className="form-actions">
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
              onClick={() => void revoke(true)}
            >
              {busy === "rotate" ? <Spinner /> : <RotateCw size={13} />}Rotate
              signer
            </button>
            <button
              className="button danger small"
              type="button"
              disabled={!!busy}
              onClick={() => void revoke()}
            >
              {busy === "revoke" ? <Spinner /> : <KeyRound size={13} />}Revoke
              agent access
            </button>
          </div>
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

export function SettingsView({ workspace: w }: { workspace: Workspace }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState("");
  const [preferences, setPreferences] = useState("");
  const [privateOnly, setPrivateOnly] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<"approval-required" | "autonomous">(
    "approval-required",
  );
  const agent = w.agentData?.agent ?? w.session.agent;
  useEffect(() => {
    if (w.budget) setCap(w.budget.limitUsd);
  }, [w.budget?.limitUsd]);
  useEffect(() => {
    if (agent) {
      setPreferences(agent.preferences);
      setMode(agent.mode);
      setPrivateOnly(
        Boolean(
          (agent as typeof agent & { privateInferenceRequired?: boolean })
            .privateInferenceRequired,
        ),
      );
    }
  }, [agent?.id, agent?.preferences, agent?.mode]);

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

  async function saveAgent() {
    setBusy("agent");
    setError(null);
    try {
      await post("/api/agent/control", {
        command: "update",
        preferences,
        mode,
        privateInferenceRequired: privateOnly,
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
        { action },
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

  return (
    <section className="workspace-page settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">OWNERSHIP BEFORE AUTOMATION</span>
          <h1>Accounts & agent controls</h1>
          <p>
            Separate trading capital, agent expenses and the permissions you
            grant.
          </p>
        </div>
        <ShieldCheck size={22} />
      </div>
      <InlineError message={error} onDismiss={() => setError(null)} />
      {!w.session.user ? (
        <Empty
          title="Your wallet is the owner"
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
          Sign in to add your trading accounts, fund a separate agent budget and
          review delegated access. We never ask for your private key.
        </Empty>
      ) : (
        <>
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
          <div className="settings-grid secondary-settings">
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
                      ? (w.budget.computeCredits ?? "Verified")
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
              <p className="warning-note">
                {w.budget?.warning ??
                  "Live credit balance and replenishment require a verified provider funding path. Owner deposits are not earned revenue."}
              </p>
            </article>
            <article className="settings-card">
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
                Require verified private inference
              </label>
              <p className="fine-print">
                When attestation is unverified, private-only requests fail
                closed. Encryption and public venue trading do not make every
                action private.
              </p>
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
            </article>
          </div>
        </>
      )}
      {w.session.user && (
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
            authorized Galileo operating wallet. Storage needs testnet gas. A
            failed upload is never shown as a persisted backup.
          </p>
          <div className="memory-actions">
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
              onClick={() => void memory("backup")}
            >
              {busy === "backup" ? <Spinner /> : <Database size={13} />}Back up
              encrypted memory
            </button>
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
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
        </section>
      )}
      <section className="service-status settings-card">
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
      </section>
    </section>
  );
}
