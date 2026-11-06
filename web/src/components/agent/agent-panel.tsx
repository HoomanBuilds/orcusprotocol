"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { displayError, post } from "@/lib/api";
import { useChatScroll } from "@/lib/use-chat-scroll";
import { shouldSubmitMessage } from "@/lib/chat-scroll";
import { actionReviewLabel } from "@/lib/trade-ux";
import { useAgentRequests } from "@/lib/use-agent-requests";
import { AgentRequestProgress } from "./agent-request-progress";
import { AgentResponse, AgentToolActivity } from "./agent-response";
import { AutomationSuggestion } from "./automation-review-card";
import { AgentModelSelector } from "./agent-model-selector";
import { Badge, InlineError, Spinner } from "../trading/primitives";

export function AgentPanel({
  workspace: w,
  onSettings,
  contextControl,
}: {
  workspace: Workspace;
  onSettings: () => void;
  contextControl: ReactNode;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autonomous, setAutonomous] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [modelId, setModelId] = useState<string | undefined>();
  const [changingModel, setChangingModel] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const agent = w.agentData?.agent ?? w.session.agent;
  const messages = w.agentData?.messages ?? [];
  const requests = useAgentRequests(w.session.user?.address, w.refresh);
  const sending = requests.submitting;
  const owner = w.session.user?.address.toLowerCase() ?? "";
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const revision = [...messages.map(message => `${message.id}:${message.content.length}`), ...requests.requests.map(request => `${request.id}:${request.status}:${request.updatedAt}`)].join("|");
  const scroll = useChatScroll(owner, revision, !!(messages.length || requests.requests.length));
  const pending = requests.requests.filter(request => request.status === "queued" || request.status === "running").length;
  useEffect(() => { setInput(""); setError(null); setChangingMode(false); setChangingModel(false); setModelId(undefined); }, [owner]);
  useEffect(() => {
    setAutonomous(agent?.mode === "autonomous");
  }, [agent?.mode]);
  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "0px";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 132)}px`;
  }, [input]);

  async function send() {
    if (!input.trim() || sending || changingModel) return;
    if (!w.session.user) return;
    const message = input.trim();
    setError(null);
    scroll.jumpToLatest();
    if (await requests.submit({ message, accountId: w.account?.id, autonomous, ...(modelId ? { modelId } : {}) }) && currentOwner.current === owner) setInput(current => current.trim() === message ? "" : current);
  }

  return (
    <section className="agent-chat" aria-label="Personal agent workspace">
      <header className="agent-chat-toolbar">
        <div className="agent-chat-identity"><h1>{agent?.name ?? "Agent"}</h1><span>{agent?.paused ? "Paused" : autonomous ? "Within granted limits" : "Approval required"}</span></div>
        <div className="agent-chat-toolbar-actions">
        {!!pending && <Link className="text-link" href="/activity?kind=agent&status=pending">{pending} in progress</Link>}
        <button
          className="button secondary small"
          title={agent?.paused ? "Resume agent" : "Pause agent"}
          aria-label={agent?.paused ? "Resume agent" : "Pause agent"}
          disabled={!agent || w.controlling}
          onClick={() => void w.control(agent?.paused ? "resume" : "pause")}
        >
          {agent?.paused ? "Resume" : "Pause"}
        </button>
        {contextControl}
        </div>
      </header>
      <div className="conversation-stage">
      <div ref={scroll.scrollRef} className="chat-scroll agent-conversation-scroll" role="region" aria-label="Conversation" tabIndex={0} onScroll={scroll.onScroll}>
      <div ref={scroll.contentRef} className="conversation-content">
        {!messages.length && (
          <div className="agent-welcome">
            <h3>
              What are we working on?
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
                  onClick={() => { setInput(prompt); textarea.current?.focus(); }}
                >
                  {prompt}
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
            {(message.requestId || message.modelId) && <details className="technical-limits message-evidence"><summary>{message.role === "assistant" ? "Response details" : "Request details"}</summary>{message.requestId && <p className="request-evidence">{message.role === "assistant" ? "0G request" : "Request ID"} {message.requestId}</p>}{message.modelId && <small className="message-model">Model: {message.modelId}</small>}</details>}
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
        {requests.loading && !requests.requests.length && <span className="agent-thinking" role="status"><Spinner />Loading saved requests...</span>}
      </div>
      </div>
      {scroll.away && <button className="jump-to-latest" type="button" onClick={scroll.jumpToLatest}><ArrowDown size={14}/>Jump to latest</button>}
      </div>
      <div className="agent-composer-dock"><div className="agent-composer-inner">
      <InlineError message={error} onDismiss={() => setError(null)} />
      <InlineError message={requests.error} />
      <div className="chat-compose agent-message-composer">
      <div className="agent-input-row">
        <textarea
          ref={textarea}
          aria-label="Message your agent"
          placeholder={
            w.session.user
              ? "Ask, plan, or make a move..."
              : "Connect your wallet to meet your agent"
          }
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={!w.session.user || sending}
          rows={1}
          onKeyDown={(event) => {
            if (shouldSubmitMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
              event.preventDefault();
              void send();
            }
          }}
        />
          <button
            className="agent-send-button"
            type="button"
            aria-label="Send message"
            disabled={!w.session.user || sending || changingModel || !input.trim()}
            onClick={() => void send()}
          >
            {sending ? <Spinner /> : <ArrowUp size={17} />}
          </button>
        </div>
      <div className="agent-composer-controls">
      <AgentModelSelector key={owner} owner={owner} compact disabled={sending || changingMode} onChange={setModelId} onBusy={setChangingModel} refresh={w.refresh}/>
        <label className="checkbox agent-autonomy-control" title="Execute only within your granted account permissions and budget">
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
          Auto-execute
        </label>
      </div>
      </div>
      <div className="agent-composer-caption"><span>{sending ? "Saving instruction..." : "Shift + Enter for a new line"}</span>
        <button className="text-button" type="button" onClick={onSettings}>
          Review permissions
        </button>
      </div>
      </div></div>
    </section>
  );
}
