"use client";

import type { AgentRequest } from "@orcus/core";
import { Spinner } from "../trading/primitives";
import { AgentResponse, AgentToolActivity } from "./agent-response";

const recoveryLinks: Record<string, { label: string; href: string }> = {
  INSUFFICIENT_BUDGET: { label: "Review spending limit", href: "/settings?section=budget" },
  INSUFFICIENT_SERVICE_CREDITS: { label: "Review service credits", href: "/settings?section=budget" },
  OPERATOR_COMPUTE_USER_CAP: { label: "Review compute usage", href: "/settings?section=budget" },
  OPERATOR_COMPUTE_PROJECT_CAP: { label: "Review compute usage", href: "/settings?section=budget" },
  INFERENCE_OUTCOME_UNKNOWN: { label: "Check existing billing", href: "/settings?section=budget" },
  EVALUATION_PENDING: { label: "Check existing billing", href: "/settings?section=budget" },
  COMPUTE_CAP_CONFIG_INVALID: { label: "View service status", href: "/settings?section=services" },
  AGENT_NOT_AUTHORIZED: { label: "Review account access", href: "/settings?section=accounts" },
};

export function AgentRequestProgress({ requests, conversationIds }: { requests: AgentRequest[]; conversationIds: string[] }) {
  const visible = requests.filter(request => request.status !== "completed" || !request.response || !conversationIds.includes(request.response.id));
  if (!visible.length) return null;
  return <section aria-label="Saved agent requests" className="agent-request-progress">
    <h3>Request activity</h3>
    {visible.slice(0, 8).map(request => <div className={`agent-run-row ${request.status}`} key={request.id}>
      <div className="agent-run-heading"><i aria-hidden="true"/><strong>{request.status === "queued" ? "Waiting for worker" : request.status === "running" ? request.tool ? `Using ${request.tool.replaceAll("_", " ")}` : request.stage : request.status}</strong><time>{new Date(request.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
      {!conversationIds.includes(request.userMessageId) && <p>{request.message}</p>}
      {request.status === "queued" && <p className="fine-print">Saved, not yet running. The background worker must be online. This instruction expires at {new Date(request.expiresAt).toLocaleTimeString()}.</p>}
      {request.status === "running" && <span className="agent-thinking"><Spinner />{request.modelCalls} model calls / {request.toolCalls} tool calls</span>}
      {request.modelId && <small className="message-model">Model: {request.modelId}</small>}
      {request.status === "running" && (request.heartbeatAt ?? request.updatedAt) < Date.now() - 180_000 && <p className="warning-note">The worker heartbeat is stale. Wait for recovery and review billing or activity; do not resubmit this request.</p>}
      {request.error && <p className="warning-note">{request.error}</p>}
      {request.status !== "queued" && request.status !== "running" && request.errorCode && recoveryLinks[request.errorCode] && <a className="text-link" href={recoveryLinks[request.errorCode].href}>{recoveryLinks[request.errorCode].label}</a>}
      {request.actionId && <p className="fine-print">An action is recorded. Check Activity for its actual settlement or reconciliation status.</p>}
      {request.response && !conversationIds.includes(request.response.id) && <><AgentToolActivity steps={request.response.toolSteps}/><AgentResponse content={request.response.content}/></>}
      <details className="technical-limits"><summary>Request evidence</summary><code>{request.id}</code><p className="fine-print">Updated {new Date(request.updatedAt).toLocaleString()}. Owner signatures are never replayed automatically.</p></details>
    </div>)}
  </section>;
}
