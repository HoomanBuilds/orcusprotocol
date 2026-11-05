"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionRecord,
  AgentPermission,
  AgentProfile,
  Automation,
  ChatMessage,
  HealthStatus,
  Market,
  OperatingBudget,
  Portfolio,
  PreparedAction,
  TradeRequest,
  TradingAccount,
  User,
  Venue,
} from "@orcus/core";
import { api, ApiError, displayError, post } from "./api";
import {
  connectWallet,
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
const emptyPortfolio: Portfolio = {
  accounts: [],
  balances: [],
  positions: [],
  orders: [],
  observedAt: 0,
};

export function useWorkspace() {
  const [session, setSession] = useState<Session>(emptySession);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio>(emptyPortfolio);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [agentData, setAgentData] = useState<AgentData | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [budget, setBudget] = useState<OperatingBudget | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [venue, setVenue] = useState<Venue>("hyperliquid");
  const [symbol, setSymbol] = useState("BTC");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const refreshingRef = useRef(false);
  const sessionRevision = useRef(0);

  const clearPrivate = useCallback(() => {
    sessionRevision.current += 1;
    setSession(emptySession);
    setPortfolio(emptyPortfolio);
    setActions([]);
    setAgentData(null);
    setAutomations([]);
    setBudget(null);
    setPreview(null);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    const revision = sessionRevision.current;
    setRefreshing(true);
    try {
      const current = await api<Session>("/api/session");
      if (revision !== sessionRevision.current) return;
      setSession(current);
      if (current.user) {
        const results = await Promise.allSettled([
          api<Portfolio>("/api/portfolio"),
          api<{ actions: ActionRecord[] }>("/api/activity"),
          api<AgentData>("/api/agent"),
          api<{ automations: Automation[] }>("/api/automations"),
          api<OperatingBudget>("/api/budget"),
        ]);
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
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected")
          setError(displayError(failed.reason));
      } else clearPrivate();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) clearPrivate();
      else setError(displayError(cause));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
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
    async function load() {
      const results = await Promise.allSettled([
        api<HealthStatus>("/api/health"),
        api<{ markets: Market[] }>(`/api/markets?venue=${venue}`),
      ]);
      if (!active) return;
      if (results[0].status === "fulfilled") setHealth(results[0].value);
      if (results[1].status === "fulfilled") {
        const next = results[1].value.markets ?? [];
        setMarkets(next);
        setMarketError(null);
        setSymbol((current) =>
          next.some((market) => market.symbol === current)
            ? current
            : (next[0]?.symbol ??
              (venue === "hyperliquid" ? "BTC" : "WETH/USDC")),
        );
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
      if (!session.user) return;
      clearPrivate();
      void post("/api/auth/logout", {}).catch(() => undefined);
      setNotice("Wallet changed. Sign in again to load its trading accounts.");
    };
    ethereum?.on?.("accountsChanged", changed);
    return () => ethereum?.removeListener?.("accountsChanged", changed);
  }, [clearPrivate, session.user?.address]);

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const address = await connectWallet();
      const challenge = await post<{ id: string; message: string }>(
        "/api/auth/challenge",
        { address },
      );
      const signature = await signLoginMessage(challenge.message);
      const current = await post<Session>("/api/auth/verify", {
        challengeId: challenge.id,
        signature,
      });
      setSession(current);
      setNotice("Signed in. Trading authorization is a separate approval.");
      await refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    try {
      await post("/api/auth/logout", {});
      clearPrivate();
    } catch (cause) {
      setError(displayError(cause));
    }
  }

  async function prepare(request: TradeRequest) {
    if (preparing || executing) return;
    setPreparing(true);
    setError(null);
    setPreview(null);
    const revision = sessionRevision.current;
    try {
      const prepared = await post<ActionPreview>(
        "/api/actions/prepare",
        request,
      );
      if (revision === sessionRevision.current) setPreview(prepared);
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setPreparing(false);
    }
  }

  async function confirm() {
    if (!preview || executing) return;
    setExecuting(true);
    setError(null);
    try {
      if (preview.execution.expiresAt <= Date.now())
        throw new Error(
          "This quote has expired. Prepare a new quote before signing.",
        );
      const result = await executePreparedAction(preview.execution);
      const saved = await post<{ action: ActionRecord }>(
        "/api/actions/submit",
        {
          actionId: preview.action.id,
          txHash: result.transactionHash,
          orderId: result.orderId,
          result: result.response,
        },
      );
      setNotice(
        saved.action.status === "confirmed"
          ? "Action confirmed by the venue."
          : "Action submitted. Reconciliation will confirm its final status.",
      );
      setPreview(null);
      await refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setExecuting(false);
    }
  }

  async function control(command: "pause" | "resume" | "take-over") {
    try {
      await post("/api/agent/control", { command });
      setNotice(
        command === "resume"
          ? "Agent resumed within its existing permissions."
          : "New agent actions paused. Submitted actions will be reconciled.",
      );
      await refresh();
    } catch (cause) {
      setError(displayError(cause));
    }
  }

  const activeMarket = markets.find((market) => market.symbol === symbol);
  const account = session.accounts.find((item) => item.venue === venue);
  return {
    session,
    health,
    portfolio,
    actions,
    agentData,
    automations,
    budget,
    markets,
    venue,
    setVenue,
    symbol,
    setSymbol,
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
    refresh,
    connect,
    disconnect,
    prepare,
    confirm,
    control,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
