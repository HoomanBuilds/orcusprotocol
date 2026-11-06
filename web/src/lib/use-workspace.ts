"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ActionRecord,
  AgentPermission,
  AgentProfile,
  Automation,
  ChatMessage,
  HealthStatus,
  Market,
  OperatingBudget,
  OstiumAllowanceIntent,
  Portfolio,
  PreparedAction,
  TradeRequest,
  TradingAccount,
  User,
  Venue,
} from "@orcus/core";
import { api, ApiError, displayError, post } from "./api";
import { tradingGasStatus, type WalletExecutionConfig } from "./trade-ux";
import { readDepositRecovery } from "./deposit-recovery";
import { actionReviewIssue, venueSymbol, type AgentRequestSummary, type FundingSnapshot, type PaymentSnapshot, type TradingDeposit } from "./workspace-model";
import { createLogoutQueue } from "./session-state";
import { DEMO_MODE_KEY, isDemoMode, setDemoMode } from "./demo-mode";
import {
  connectWallet,
  currentWalletAddress,
  executePreparedAction,
  signLoginMessage,
} from "./wallets";

export interface Session {
  user: User | null;
  agent: AgentProfile | null;
  accounts: TradingAccount[];
}
export interface AgentData {
  agent: AgentProfile;
  messages: ChatMessage[];
  permissions: AgentPermission[];
}
export interface ActionPreview {
  action: ActionRecord;
  execution: PreparedAction;
  preview?: Record<string, unknown>;
}

const emptySession: Session = { user: null, agent: null, accounts: [] };
async function selectedOwnerIs(address: string) {
  try { return (await currentWalletAddress()).toLowerCase() === address.toLowerCase(); }
  catch { return false; }
}
const emptyPortfolio: Portfolio = {
  accounts: [],
  balances: [],
  positions: [],
  orders: [],
  observedAt: 0,
};

function useWorkspaceState() {
  const [demoMode, setDemoModeState] = useState(false);
  const [session, setSession] = useState<Session>(emptySession);
  const [ostiumAllowances, setOstiumAllowances] = useState<OstiumAllowanceIntent[]>([]);
  const selectedSymbols = useRef<Partial<Record<Venue, string>>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio>(emptyPortfolio);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [agentData, setAgentData] = useState<AgentData | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [budget, setBudget] = useState<OperatingBudget | null>(null);
  const [requests, setRequests] = useState<AgentRequestSummary[]>([]);
  const [payments, setPayments] = useState<PaymentSnapshot | null>(null);
  const [funding, setFunding] = useState<FundingSnapshot | null>(null);
  const [tradingDeposits, setTradingDeposits] = useState<TradingDeposit[]>([]);
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  const [walletConfig, setWalletConfig] = useState<WalletExecutionConfig | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [venue, setVenue] = useState<Venue>("hyperliquid");
  const [symbol, setSymbol] = useState("BTC");
  const selectSymbol = useCallback((value: string) => { selectedSymbols.current[venue] = value; setSymbol(value); }, [venue]);
  const selectMarket = useCallback((nextVenue: Venue, nextSymbol: string) => { selectedSymbols.current[nextVenue] = nextSymbol; setVenue(nextVenue); setSymbol(nextSymbol); }, []);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [controlling, setControlling] = useState(false);
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const sessionRevision = useRef(0);
  const connectingRef = useRef(false);
  const preparingRef = useRef(false);
  const executingRef = useRef(false);
  const controllingRef = useRef(false);
  const ownerRef = useRef<string | null>(null);
  const logoutQueue = useRef(createLogoutQueue(() => post("/api/auth/logout", {})));

  const clearPrivate = useCallback(() => {
    sessionRevision.current += 1;
    setSession(emptySession);
    setPortfolio(emptyPortfolio);
    setActions([]);
    setAgentData(null);
    setAutomations([]);
    setBudget(null);
    setRequests([]);
    setPayments(null);
    setFunding(null);
    setTradingDeposits([]);
    setOstiumAllowances([]);
    setResourceErrors({});
    ownerRef.current = null;
    setWalletConfig(null);
    setPreview(null);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) { refreshQueuedRef.current = true; return; }
    refreshingRef.current = true;
    const revision = sessionRevision.current;
    setRefreshing(true);
    try {
      const demo = isDemoMode();
      setDemoModeState(demo);
      const current = await api<Session>("/api/session");
      if (revision !== sessionRevision.current) return;
      if (current.user) {
        if (!demo && !await selectedOwnerIs(current.user.address)) throw new ApiError("OWNER_CHANGED", "The selected wallet does not match this session.", 401);
        if (revision !== sessionRevision.current) return;
        if (ownerRef.current && ownerRef.current !== current.user.id) { clearPrivate(); refreshQueuedRef.current = true; return; }
        ownerRef.current = current.user.id;
        setSession(current);
        const results = await Promise.allSettled([
          api<Portfolio>("/api/portfolio"),
          api<{ actions: ActionRecord[] }>("/api/activity"),
          api<AgentData>("/api/agent"),
          api<{ automations: Automation[] }>("/api/automations"),
          api<OperatingBudget>("/api/budget"),
          api<WalletExecutionConfig>("/api/wallet-config"),
          api<{ requests: AgentRequestSummary[] }>("/api/agent/requests"),
          api<PaymentSnapshot>("/api/budget/payments"),
          api<FundingSnapshot>("/api/budget/funding"),
          api<{ intents: OstiumAllowanceIntent[] }>("/api/ostium/allowances"),
        ]);
        if (revision !== sessionRevision.current) return;
        if (!demo && !await selectedOwnerIs(current.user.address)) throw new ApiError("OWNER_CHANGED", "The selected wallet changed while loading this session.", 401);
        if (revision !== sessionRevision.current) return;
        if (results[0].status === "fulfilled")
          setPortfolio(results[0].value as Portfolio);
        if (results[1].status === "fulfilled")
          setActions(
            (results[1].value as { actions: ActionRecord[] }).actions ?? [],
          );
        if (results[2].status === "fulfilled")
          setAgentData(results[2].value as AgentData);
        if (results[3].status === "fulfilled")
          setAutomations(
            (results[3].value as { automations: Automation[] }).automations ??
              [],
          );
        if (results[4].status === "fulfilled")
          setBudget(results[4].value as OperatingBudget);
        setWalletConfig(results[5].status === "fulfilled" ? results[5].value as WalletExecutionConfig : null);
        if (results[6].status === "fulfilled") setRequests((results[6].value as { requests: AgentRequestSummary[] }).requests ?? []);
        if (results[7].status === "fulfilled") setPayments(results[7].value as PaymentSnapshot);
        if (results[8].status === "fulfilled") setFunding(results[8].value as FundingSnapshot);
        if (results[9].status === "fulfilled") setOstiumAllowances((results[9].value as { intents: OstiumAllowanceIntent[] }).intents ?? []);
        const keys = ["portfolio", "activity", "agent", "automations", "budget", "wallet", "requests", "payments", "funding", "nativeAllowances"];
        setResourceErrors(Object.fromEntries(results.flatMap((result, index) => result.status === "rejected" ? [[keys[index], displayError(result.reason)]] : [])));
        const deposits: TradingDeposit[] = [];
        for (const account of demo ? [] : current.accounts) {
          try {
            const recovery = readDepositRecovery(localStorage, sessionStorage, account.ownerAddress, account.id);
            if (recovery) deposits.push({ accountId: account.id, status: recovery.status, transactionHash: recovery.transactionHash });
          } catch {}
        }
        setTradingDeposits(deposits);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected")
          setError(displayError(failed.reason));
      } else clearPrivate();
    } catch (cause) {
      if (revision !== sessionRevision.current) return;
      if (cause instanceof ApiError && cause.status === 401) { clearPrivate(); void logoutQueue.current.logout().catch(() => undefined); setNotice("Sign in with the selected owner wallet to load its accounts."); }
      else setError(displayError(cause));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setLoading(false);
      if (refreshQueuedRef.current) { refreshQueuedRef.current = false; void refresh(); }
    }
  }, [clearPrivate]);

  useEffect(() => {
    const modeChanged = (event: StorageEvent) => {
      if (event.key === DEMO_MODE_KEY || event.key === null) { clearPrivate(); window.location.reload(); }
    };
    window.addEventListener("storage", modeChanged);
    return () => window.removeEventListener("storage", modeChanged);
  }, [clearPrivate]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 12000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let busy = false;
    setMarkets([]);
    setMarketError(null);
    async function load() {
      if (busy) return;
      busy = true;
      const results = await Promise.allSettled([
        api<HealthStatus>("/api/health", { signal: AbortSignal.timeout(10_000) }),
        api<{ markets: Market[] }>(`/api/markets?venue=${venue}`, { signal: AbortSignal.timeout(10_000) }),
      ]);
      busy = false;
      if (!active) return;
      if (results[0].status === "fulfilled") setHealth(results[0].value);
      if (results[1].status === "fulfilled") {
        const next = results[1].value.markets ?? [];
        setMarkets(next);
        setMarketError(null);
        setSymbol(current => {
          const choice = venueSymbol(venue, next, current, selectedSymbols.current[venue]);
          if (next.length) selectedSymbols.current[venue] = choice;
          return choice;
        });
      } else {
        setMarkets([]);
        setMarketError(displayError(results[1].reason));
      }
    }
    void load();
    const timer = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [venue]);

  useEffect(() => {
    const ethereum = (
      window as unknown as {
        ethereum?: {
          on?: (event: string, handler: () => void) => void;
          removeListener?: (event: string, handler: () => void) => void;
        };
      }
    ).ethereum;
    const changed = () => {
      if (isDemoMode()) return;
      clearPrivate();
      void logoutQueue.current.logout().catch(() => undefined);
      setNotice("Wallet changed. Sign in again to load its trading accounts.");
    };
    ethereum?.on?.("accountsChanged", changed);
    return () => ethereum?.removeListener?.("accountsChanged", changed);
  }, [clearPrivate, session.user?.address]);

  async function connect() {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError(null);
    try {
      await logoutQueue.current.wait();
      const address = await connectWallet();
      await logoutQueue.current.wait();
      clearPrivate();
      const revision = sessionRevision.current;
      const challenge = await post<{ id: string; message: string }>(
        "/api/auth/challenge",
        { address },
      );
      const signature = await signLoginMessage(challenge.message);
      await logoutQueue.current.wait();
      if (revision !== sessionRevision.current || (await currentWalletAddress()).toLowerCase() !== address.toLowerCase()) throw new ApiError("OWNER_CHANGED", "The selected wallet changed during sign-in.", 401);
      const current = await post<Session>("/api/auth/verify", {
        challengeId: challenge.id,
        signature,
      });
      if (revision !== sessionRevision.current || (await currentWalletAddress()).toLowerCase() !== address.toLowerCase()) { await logoutQueue.current.logout(); clearPrivate(); throw new ApiError("OWNER_CHANGED", "The selected wallet changed during sign-in.", 401); }
      setSession(current);
      setNotice("Signed in. Trading authorization is a separate approval.");
      await refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (isDemoMode()) { changeDemoMode(false); return; }
    clearPrivate();
    try {
      await logoutQueue.current.logout();
    } catch (cause) {
      setError(displayError(cause));
    }
  }

  async function prepare(request: TradeRequest, initiator: "manual" | "agent" = "manual", messageId?: string) {
    if (preparingRef.current || executingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    setError(null);
    setPreview(null);
    const revision = sessionRevision.current;
    try {
      const prepared = await api<ActionPreview>(
        "/api/actions/prepare",
        { method: "POST", headers: { "X-Orcus-Initiator": initiator, "Idempotency-Key": crypto.randomUUID(), ...(messageId ? { "X-Orcus-Message-Id": messageId } : {}) }, body: JSON.stringify(request) },
      );
      if (revision === sessionRevision.current) setPreview(prepared);
    } catch (cause) {
      if (revision === sessionRevision.current) setError(displayError(cause));
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  async function confirm() {
    if (!preview || executingRef.current) return;
    executingRef.current = true;
    setExecuting(true);
    setError(null);
    setNotice(null);
    let ownerResult: Awaited<ReturnType<typeof executePreparedAction>> | undefined;
    const revision = sessionRevision.current;
    try {
      if (preview.execution.request.venue === "uniswap") {
        const liveConfig = await api<WalletExecutionConfig>("/api/wallet-config");
        setWalletConfig(liveConfig);
        if (!tradingGasStatus(liveConfig, "uniswap").ready) throw new ApiError("BUNDLER_UNCONFIGURED", "Smart-account execution unavailable.", 503);
      }
      if (preview.execution.expiresAt <= Date.now())
        throw new Error(
          "This quote has expired. Prepare a new quote before signing.",
        );
      const owner = await currentWalletAddress();
      if (owner.toLowerCase() !== preview.execution.account.ownerAddress.toLowerCase()) throw new Error("Your wallet changed. Reconnect the account owner before approving this action.");
      ownerResult = preview.execution.request.mode === "manual" ? await executePreparedAction(preview.execution) : undefined;
      if (revision !== sessionRevision.current) return;
      const saved = await post<{ action: ActionRecord }>("/api/actions/submit", {
        actionId: preview.action.id,
        ...(ownerResult ? { txHash: ownerResult.transactionHash, userOperationHash: ownerResult.userOperationHash, orderId: ownerResult.orderId, result: ownerResult.response } : {}),
      });
      setPreview(null);
      await refresh();
      if (saved.action.status === "rejected") throw new ApiError("VENUE_REJECTED", "The venue rejected this action.", 409);
      setNotice(saved.action.status === "confirmed" ? "Action confirmed by the venue." : saved.action.status === "cancelled" ? "Action cancelled. Check activity for any partial fills." : saved.action.status === "submitted-unknown" ? "Submission outcome is unknown. Check activity before retrying." : "Action submitted. Reconciliation will confirm its final status.");
    } catch (cause) {
      if (revision !== sessionRevision.current) return;
      const phase = cause && typeof cause === "object" && "phase" in cause ? cause.phase : undefined;
      if (preview.execution.request.venue === "ostium" || ownerResult || phase === "submitted-unknown" || phase === "reverted") { setPreview(null); await refresh(); }
      setError(displayError(cause));
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  }

  async function control(command: "pause" | "resume" | "take-over") {
    if (controllingRef.current) return;
    controllingRef.current = true;
    setControlling(true);
    setError(null);
    const revision = sessionRevision.current;
    try {
      await post("/api/agent/control", { command });
      if (revision !== sessionRevision.current) return;
      if (command !== "resume") setPreview(null);
      setNotice(
        command === "resume"
          ? "Agent resumed within its existing permissions."
          : "New agent actions paused. Submitted actions will be reconciled.",
      );
      await refresh();
    } catch (cause) {
      if (revision === sessionRevision.current) setError(displayError(cause));
    } finally {
      controllingRef.current = false;
      setControlling(false);
    }
  }

  function reviewAction(action: ActionRecord) {
    const issue = actionReviewIssue(action, session.user?.id, session.accounts);
    if (issue) { setError(issue); return; }
    if (preparingRef.current || executingRef.current) return;
    setError(null);
    setPreview({ action, execution: action.prepared! });
  }

  function changeDemoMode(enabled: boolean) {
    try {
      setDemoMode(enabled);
      clearPrivate();
      window.location.reload();
    } catch (cause) { setError(displayError(cause)); }
  }

  const activeMarket = markets.find((market) => market.symbol === symbol);
  const account = session.accounts.find((item) => item.venue === venue);
  return {
    demoMode,
    changeDemoMode,
    session,
    health,
    portfolio,
    actions,
    agentData,
    automations,
    budget,
    requests,
    payments,
    funding,
    tradingDeposits,
    ostiumAllowances,
    resourceErrors,
    walletConfig,
    markets,
    venue,
    setVenue,
    symbol,
    setSymbol: selectSymbol,
    selectMarket,
    activeMarket,
    account,
    loading,
    connecting,
    refreshing,
    marketError,
    error,
    setError,
    notice,
    setNotice,
    preview,
    setPreview,
    preparing,
    executing,
    controlling,
    refresh,
    connect,
    disconnect,
    prepare,
    confirm,
    control,
    reviewAction,
  };
}

export type Workspace = ReturnType<typeof useWorkspaceState>;
const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceState();
  return createElement(WorkspaceContext.Provider, { value: workspace }, children);
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Workspace pages must be inside WorkspaceProvider.");
  return workspace;
}
