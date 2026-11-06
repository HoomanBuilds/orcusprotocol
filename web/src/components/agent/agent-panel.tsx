"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BrainCircuit,
  ChevronRight,
  CirclePause,
  Play,
  ShieldCheck,
} from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { displayError, post } from "@/lib/api";
import { usd } from "@/lib/format";
import { actionReviewLabel } from "@/lib/trade-ux";
import { useAgentRequests } from "@/lib/use-agent-requests";
import { AgentRequestProgress } from "./agent-request-progress";
import { AgentResponse, AgentToolActivity } from "./agent-response";
import { AutomationSuggestion } from "./automation-review-card";
import { AgentModelSelector } from "./agent-model-selector";
import { Address, Badge, InlineError, Spinner } from "../trading/primitives";

export function AgentPanel({
  workspace: w,
  onSettings,
  onBudget = onSettings,
  showBudget = true,
}: {
  workspace: Workspace;
  onSettings: () => void;
  onBudget?: () => void;
  showBudget?: boolean;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autonomous, setAutonomous] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [modelId, setModelId] = useState<string | undefined>();
  const [changingModel, setChangingModel] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const agent = w.agentData?.agent ?? w.session.agent;
  const messages = w.agentData?.messages ?? [];
  const requests = useAgentRequests(w.session.user?.address, w.refresh);
  const sending = requests.submitting;
  const owner = w.session.user?.address.toLowerCase() ?? "";
  const currentOwner = useRef(owner); currentOwner.current = owner;
  useEffect(() => { setInput(""); setError(null); setChangingMode(false); setChangingModel(false); setModelId(undefined); }, [owner]);
  useEffect(() => {
    setAutonomous(agent?.mode === "autonomous");
  }, [agent?.mode]);
  useEffect(() => {
    if (messages.length || sending) end.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }, [messages.length, sending]);

  async function send() {
    if (!input.trim() || sending || changingModel) return;
    if (!w.session.user) return;
    const message = input.trim();
    setError(null);
    if (await requests.submit({ message, accountId: w.account?.id, autonomous, ...(modelId ? { modelId } : {}) }) && currentOwner.current === owner) setInput(current => current.trim() === message ? "" : current);
  }

  return (
    <aside className={`agent-panel ${messages.length || requests.requests.length || sending ? "has-conversation" : "empty-conversation"}`}>
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
          disabled={!agent || w.controlling}
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
            <span className="eyebrow">A SECOND PAIR OF EYES</span>
            <h3>
              What are we
              <br />working on?
            </h3>
            <p>
              Ask about your accounts, plan a trade, or review a position.
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
              {message.role === "assistant" ? "ORCUS" : "YOU"}
            </span>
            {message.role === "assistant" ? <><AgentToolActivity steps={message.toolSteps}/><AgentResponse content={message.content}/></> : <p>{message.content}</p>}
            {message.requestId && (
              <div className="request-evidence" title={message.requestId}>
                0G request {message.requestId.slice(0, 14)}...
              </div>
            )}
            {message.modelId && <small className="message-model">Model: {message.modelId}</small>}
            {message.privacy && message.privacy !== "unverified" && <details className="technical-limits"><summary>{message.privacy === "independently-attested-private" ? "Private inference, independently attested" : "Private tier, gateway-reported assurance"}</summary><pre>{JSON.stringify(message.privacyEvidence, null, 2)}</pre></details>}
            {message.proposedAction && (
              <div className="proposal">
                <div>
                  <Badge>{message.proposedAction.venue}</Badge>
                  <span>{message.proposedAction.type}</span>
                </div>
                <strong>
                  {actionReviewLabel(message.proposedAction)} / {message.proposedAction.type} / {message.proposedAction.symbol}
                </strong>
                <button
                  className="button secondary small full"
                  type="button"
                  disabled={w.preparing || w.executing || !!message.actionId}
                  onClick={() =>
                    void w.prepare({
                      ...message.proposedAction!,
                      mode: "manual",
                    }, "agent", message.id)
                  }
                >
                  {message.actionId
                    ? "Action recorded. Check activity for its status."
                    : "Review proposed action"}
                </button>
              </div>
            )}
            {message.automationProposal !== undefined && <AutomationSuggestion key={`${owner}:${message.id}`} proposal={message.automationProposal} messageId={message.id} automationId={message.automationId} workspace={w} />}
          </div>
        ))}
        <AgentRequestProgress requests={requests.requests} conversationIds={messages.map(message => message.id)} />
        {requests.loading && !requests.requests.length && <span className="agent-thinking"><Spinner />Loading saved requests...</span>}
        <div ref={end} />
      </div>
      <InlineError message={error} onDismiss={() => setError(null)} />
      <InlineError message={requests.error} />
      <AgentModelSelector key={owner} owner={owner} disabled={sending || changingMode} onChange={setModelId} onBusy={setChangingModel} refresh={w.refresh}/>
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
            disabled={!w.session.user || sending || changingModel || !input.trim()}
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
            disabled={!w.session.user || changingMode || sending || w.controlling}
            onChange={async (event) => {
              const next = event.target.checked;
              setChangingMode(true);
              try {
                await post("/api/agent/control", { command: "update", mode: next ? "autonomous" : "approval-required" });
                if (currentOwner.current !== owner) return;
                setAutonomous(next);
                await w.refresh();
              } catch (cause) { if (currentOwner.current === owner) setError(displayError(cause)); }
              finally { if (currentOwner.current === owner) setChangingMode(false); }
            }}
          />
          Autonomous execution
        </label>
        <button className="text-button" type="button" onClick={onSettings}>
          Review permissions
        </button>
      </div>
      {showBudget && <div className="agent-budget">
        <div>
          <span className="eyebrow">OPERATING BUDGET</span>
          <button className="text-button" type="button" onClick={onBudget}>
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
      </div>}
    </aside>
  );
}
