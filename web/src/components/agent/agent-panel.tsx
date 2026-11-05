"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  CirclePause,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ChatMessage, TradeRequest } from "@orcus/core";
import type { Workspace } from "@/lib/use-workspace";
import { api, ApiError, displayError, post } from "@/lib/api";
import { number, usd } from "@/lib/format";
import { Address, Badge, InlineError, Spinner } from "../trading/primitives";

export function AgentPanel({
  workspace: w,
  onSettings,
}: {
  workspace: Workspace;
  onSettings: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingInput, setPendingInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autonomous, setAutonomous] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [progress, setProgress] = useState("Preparing your agent...");
  const retry = useRef<{ owner: string; accountId?: string; message: string; requestId: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const agent = w.agentData?.agent ?? w.session.agent;
  const messages = w.agentData?.messages ?? [];
  useEffect(() => {
    setAutonomous(agent?.mode === "autonomous");
  }, [agent?.mode]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, sending]);

  async function send() {
    if (!input.trim() || sending) return;
    const message = input.trim();
    const owner = w.session.user?.address;
    if (!owner) return;
    const previous = retry.current;
    const requestId = previous?.owner === owner && previous.accountId === w.account?.id && previous.message === message ? previous.requestId : crypto.randomUUID();
    retry.current = { owner, accountId: w.account?.id, message, requestId };
    setSending(true);
    setProgress("Retrieving relevant memory...");
    setError(null);
    setInput("");
    setPendingInput(message);
    let active = true;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const run = await api<{ message?: string; stage?: string; tool?: string }>(`/api/agent/runs/${encodeURIComponent(requestId)}`);
        if (active) setProgress(run.message ?? (run.tool ? `Using ${run.tool}...` : run.stage ? `${run.stage}...` : "Working with 0G..."));
      } catch {} finally { polling = false; }
    }, 1200);
    try {
      await post<{
        message: ChatMessage;
        proposal?: TradeRequest;
        requestId?: string;
      }>("/api/agent/chat", { message, accountId: w.account?.id, autonomous, requestId });
      retry.current = null;
      await w.refresh();
    } catch (cause) {
      if (cause instanceof ApiError && ["NOT_CONFIGURED", "AUTH_REQUIRED", "INSUFFICIENT_BUDGET", "PRIVATE_INFERENCE_UNVERIFIED"].includes(cause.code)) retry.current = null;
      setError(displayError(cause));
      setInput(message);
    } finally {
      active = false;
      clearInterval(timer);
      setSending(false);
      setPendingInput("");
    }
  }

  return (
    <aside className="agent-panel">
      <div className="agent-heading">
        <span className="agent-avatar">
          <BrainCircuit size={19} />
        </span>
        <div>
          <h2>{agent?.name ?? "Your personal agent"}</h2>
          <span>
            <i className={`dot ${agent && !agent.paused ? "good" : ""}`} />
            {agent
              ? agent.paused
                ? "Paused / owner controls available"
                : "Ready for your instructions"
              : "0G-powered trading copilot"}
          </span>
        </div>
        <button
          className="icon-button"
          title={agent?.paused ? "Resume agent" : "Pause agent"}
          aria-label={agent?.paused ? "Resume agent" : "Pause agent"}
          disabled={!agent}
          onClick={() => void w.control(agent?.paused ? "resume" : "pause")}
        >
          {agent?.paused ? <Play size={15} /> : <CirclePause size={16} />}
        </button>
      </div>
      <div className="agent-mode">
        <ShieldCheck size={13} />
        <span>
          {autonomous
            ? "Autonomous within granted limits"
            : "Approval required before execution"}
        </span>
        <Badge>0G</Badge>
      </div>
      <div className="chat-scroll" aria-live="polite">
        {!messages.length && (
          <div className="agent-welcome">
            <span className="welcome-icon">
              <Sparkles size={23} />
            </span>
            <span className="eyebrow">A SECOND PAIR OF EYES</span>
            <h3>
              Your strategy.
              <br />A little more leverage.
            </h3>
            <p>
              Research a market, make a trade, or ask me to manage a position.
              We use the same accounts. You keep the final say.
            </p>
            <div className="suggestions">
              {[
                "Analyze my portfolio risk",
                "Help me plan a BTC trade",
                "Explain my open positions",
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                >
                  {prompt}
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <span className="message-role">
              {message.role === "assistant" ? (
                <>
                  <Bot size={12} />
                  ORCUS
                </>
              ) : (
                "YOU"
              )}
            </span>
            <p>{message.content}</p>
            {message.requestId && (
              <div className="request-evidence" title={message.requestId}>
                <Check size={10} />
                0G request {message.requestId.slice(0, 14)}...
              </div>
            )}
            {message.proposedAction && (
              <div className="proposal">
                <div>
                  <Badge>{message.proposedAction.venue}</Badge>
                  <span>{message.proposedAction.type}</span>
                </div>
                <strong>
                  {message.proposedAction.side.toUpperCase()}{" "}
                  {number(message.proposedAction.amount, 6)}{" "}
                  {message.proposedAction.symbol}
                </strong>
                <button
                  className="button secondary small full"
                  type="button"
                  disabled={w.preparing || w.executing || !!message.actionId}
                  onClick={() =>
                    void w.prepare({
                      ...message.proposedAction!,
                      mode: "manual",
                    }, "agent")
                  }
                >
                  {message.actionId
                    ? "Action already submitted"
                    : "Review proposed action"}
                </button>
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="chat-message user">
            <span className="message-role">YOU</span>
            <p>{pendingInput}</p>
          </div>
        )}
        {sending && (
          <div className="agent-thinking">
            <Spinner />
            <span>{progress}</span>
          </div>
        )}
        <div ref={end} />
      </div>
      <InlineError message={error} onDismiss={() => setError(null)} />
      <div className="chat-compose">
        <textarea
          aria-label="Message your agent"
          placeholder={
            w.session.user
              ? "Ask, plan, or make a move..."
              : "Connect your wallet to meet your agent"
          }
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={!w.session.user || sending}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div>
          <span>
            <BrainCircuit size={12} />
            0G inference
          </span>
          <button
            type="button"
            aria-label="Send message"
            disabled={!w.session.user || sending || !input.trim()}
            onClick={() => void send()}
          >
            {sending ? <Spinner /> : <ArrowUp size={17} />}
          </button>
        </div>
      </div>
      <div className="autonomous-toggle">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autonomous}
            disabled={!w.session.user || changingMode || sending}
            onChange={async (event) => {
              const next = event.target.checked;
              setChangingMode(true);
              try {
                await post("/api/agent/control", { command: "update", mode: next ? "autonomous" : "approval-required" });
                setAutonomous(next);
                await w.refresh();
              } catch (cause) { setError(displayError(cause)); }
              finally { setChangingMode(false); }
            }}
          />
          Autonomous execution
        </label>
        <button className="text-button" type="button" onClick={onSettings}>
          Review permissions
        </button>
      </div>
      <div className="agent-budget">
        <div>
          <span className="eyebrow">OPERATING BUDGET</span>
          <button className="text-button" type="button" onClick={onSettings}>
            Manage
          </button>
        </div>
        <div className="budget-summary">
          <strong>{usd(w.budget?.availableUsd)}</strong>
          <span>available expense allowance</span>
        </div>
        <div className="budget-track">
          <span
            style={{
              width:
                w.budget && Number(w.budget.limitUsd) > 0
                  ? `${Math.max(0, Math.min(100, (Number(w.budget.availableUsd) / Number(w.budget.limitUsd)) * 100))}%`
                  : "0%",
            }}
          />
        </div>
        <div className="budget-labels">
          <span>Used {usd(w.budget?.spentUsd)}</span>
          <span>Limit {usd(w.budget?.limitUsd)}</span>
        </div>
        {w.budget?.warning && (
          <p className="warning-note">{w.budget.warning}</p>
        )}
        <p className="operating-wallet">
          Separate from trading capital{" "}
          <Address value={agent?.operatingAddress} />
        </p>
      </div>
    </aside>
  );
}
